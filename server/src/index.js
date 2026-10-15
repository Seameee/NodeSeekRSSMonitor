// ============================================================================
// 入口：装配所有部件并启动
//
// 进程结构：
//   · 主线程 —— 调度、SQLite、Telegram 长轮询、命令处理
//   · worker 线程池 —— RSS 解析与关键词匹配（CPU 密集 + ReDoS 隔离）
//   · 健康检查 HTTP —— 供 Docker healthcheck 使用
// ============================================================================
import http from "node:http";
import { config } from "./config.js";
import { BOT_MENU } from "./help.js";
import { log } from "./logger.js";
import { masterKeyFingerprint } from "./crypto.js";
import { cleanup, closeDb, countUsers, getSetting, setSetting } from "./db.js";
import { deleteWebhook, getUpdates, setMyCommands } from "./telegram.js";
import { handleUpdate } from "./router.js";
import { aiSemaphore, pollerStats, runRound } from "./poller.js";
import { pool } from "./worker-pool.js";
import { pruneBuckets, rateLimitStats } from "./quota.js";

let shuttingDown = false;

// ─── 启动横幅 ────────────────────────────────────────────────────────────────

function printBanner() {
  log.info("boot", "─".repeat(62));
  log.info("boot", "NodeSeek 关键词监控 Bot — 多用户服务端");
  log.info("boot", `运行模式   : ${config.isProd ? "production" : "development"}`);
  log.info("boot", `数据库     : ${config.dbPath}`);
  log.info("boot", `主密钥指纹 : ${masterKeyFingerprint}`);
  log.info("boot", `管理员     : ${[...config.adminIds].join(", ")}`);
  log.info("boot", `轮询间隔   : ${config.pollIntervalMs}ms`);
  log.info(
    "boot",
    `worker 池  : ${config.workerPoolSize > 0 ? `${config.workerPoolSize} 线程` : "已禁用"}`
  );
  log.info("boot", `AI 并发    : ${config.aiConcurrency}`);
  log.info("boot", `发送并发   : ${config.sendConcurrency}（${config.sendRatePerSec} 条/秒）`);
  log.info("boot", `注册开关   : ${config.registrationOpen ? "开放" : "关闭"}（上限 ${config.maxUsers} 人）`);
  log.info("boot", `现有用户   : ${countUsers()} 人`);
  log.info("boot", "─".repeat(62));
}

// ─── 健康检查 ────────────────────────────────────────────────────────────────

function startHealthServer() {
  if (!config.healthPort) return null;
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      const s = pollerStats();
      const body = JSON.stringify({
        status: shuttingDown ? "shutting_down" : "ok",
        uptimeSec: Math.round(process.uptime()),
        users: countUsers(),
        lastRunAt: s.lastRunAt,
        lastDurationMs: s.lastDurationMs,
        lastPushed: s.lastPushed,
        rounds: s.rounds,
        failures: s.failures,
        workerPool: pool.stats(),
        aiSemaphore: aiSemaphore.stats(),
        rateLimit: rateLimitStats(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(config.healthPort, "0.0.0.0", () => {
    log.info("health", `健康检查监听 :${config.healthPort}/healthz`);
  });
  return server;
}

// ─── 轮询循环 ────────────────────────────────────────────────────────────────

let roundRunning = false;

async function tick() {
  if (shuttingDown || roundRunning) return;
  roundRunning = true;
  try {
    await runRound();
  } catch (e) {
    log.error("poller", `轮次异常: ${e.stack || e.message}`);
  } finally {
    roundRunning = false;
  }
}

// ─── 定时维护 ────────────────────────────────────────────────────────────────

async function maintenance() {
  try {
    const removed = cleanup();
    pruneBuckets();
    if (removed > 0) log.info("cleanup", `清理 ${removed} 行过期数据`);
  } catch (e) {
    log.error("cleanup", `清理失败: ${e.message}`);
  }
}

// ─── Telegram 长轮询 ─────────────────────────────────────────────────────────

async function startBot() {
  // 长轮询与 webhook 互斥，必须先删 webhook
  const del = await deleteWebhook();
  if (!del.ok) log.warn("bot", `deleteWebhook 失败: ${del.description}`);

  await setMyCommands(BOT_MENU.map(([command, description]) => ({ command, description })));

  let offset = 0;
  let backoff = 1000;

  while (!shuttingDown) {
    try {
      const r = await getUpdates(offset, 25);
      if (!r.ok) {
        // 409 通常是别处也在用同一个 token 长轮询
        log.warn("bot", `getUpdates 失败: ${r.description || "未知"}`);
        await new Promise((s) => setTimeout(s, backoff));
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1000;
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        try {
          await handleUpdate(u);
        } catch (e) {
          log.error("bot", `处理更新失败: ${e.stack || e.message}`);
        }
      }
    } catch (e) {
      log.error("bot", `长轮询异常: ${e.message}`);
      await new Promise((s) => setTimeout(s, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  printBanner();
  const health = startHealthServer();

  // 启动时先跑一轮，避免等待一个完整间隔
  tick();

  const pollTimer = setInterval(tick, config.pollIntervalMs);
  const cleanupTimer = setInterval(maintenance, config.cleanupIntervalMs);
  // 每小时把 WAL 检查点一次，防止 wal 文件无限增长
  const checkpointTimer = setInterval(() => {
    try {
      // node:sqlite 没有暴露 checkpoint API，用一次写入触发即可
      setSetting("last_checkpoint", new Date().toISOString());
    } catch {
      /* 忽略 */
    }
  }, 3_600_000);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", `收到 ${signal}，开始优雅退出…`);
    clearInterval(pollTimer);
    clearInterval(cleanupTimer);
    clearInterval(checkpointTimer);
    health?.close();
    await pool.close().catch(() => {});
    closeDb();
    log.info("shutdown", "已退出");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("process", `未处理的 Promise 拒绝: ${e?.stack || e}`));
  process.on("uncaughtException", (e) => {
    log.error("process", `未捕获异常: ${e?.stack || e}`);
    // SQLite 损坏之类的致命错误无法继续，交给编排层重启
    if (String(e?.message || "").includes("SQLITE")) shutdown("uncaughtException");
  });

  await startBot();
}

main().catch((e) => {
  log.error("boot", `启动失败: ${e.stack || e.message}`);
  process.exit(1);
});
