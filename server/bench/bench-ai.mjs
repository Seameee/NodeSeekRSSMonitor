// ============================================================================
// AI 摘要阶段的并发形状基准
//
// poller.js 第 4 步是 `for (const job of jobs) { await aiSemaphore.runAll(...) }`
// —— **每个用户的摘要批次是串行等待的**。于是 N 个用户各要 1 条摘要时，
// 总耗时 ≈ N × 单次延迟，而不是 (N / AI_CONCURRENCY) × 单次延迟。
//
// 本脚本用固定的上游延迟把两种形状实测出来做对照：
//   A. 旧形状（2026-10 已修复）：逐个用户 await
//   B. 现形状（生产在跑）：把所有用户的摘要任务一次性丢进同一个全局信号量
//
// 2026-10-16 起 poller.js 第 4 步已改成 B，并额外加了「同内容在飞合并」，
// 所以这里的 B 是生产形状的下界：真实情况下多个用户命中同一条帖时还会更快。
//
// 用法：node bench/bench-ai.mjs
// ============================================================================
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(HERE, "..", ".bench");
mkdirSync(BENCH_DIR, { recursive: true });

process.env.NODE_ENV = "development";
process.env.TELEGRAM_BOT_TOKEN = "123456:BENCHTOKEN";
process.env.APP_MASTER_KEY = "0123456789abcdef".repeat(4);
process.env.DB_PATH = join(BENCH_DIR, `ai-${Date.now()}.db`);
process.env.LOG_LEVEL = "error";
process.env.HEALTH_PORT = "0";
process.env.WORKER_POOL_SIZE = "2";

const USERS = Number(process.env.BENCH_USERS || 200);
const LATENCY = Number(process.env.BENCH_LATENCY_MS || 100);
const AI_CONCURRENCY = Number(process.env.AI_CONCURRENCY || 8);
process.env.AI_CONCURRENCY = String(AI_CONCURRENCY);

const { aiSummary } = await import(`${SRC}/ai.js");
const { aiSemaphore } = await import(`${SRC}/poller.js");
const { DEFAULT_AI_PROMPT, config } = await import(`${SRC}/config.js");
const { pool } = await import(`${SRC}/worker-pool.js");

let calls = 0;
globalThis.fetch = async (url) => {
  if (!String(url).includes("/chat/completions")) throw new Error(`未预期请求 ${url}`);
  calls++;
  await new Promise((r) => setTimeout(r, LATENCY));
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({ choices: [{ message: { content: "摘要" } }] }),
    text: async () => "",
  };
};

const cfg = {
  base: "https://api.example.com/v1",
  key: "sk-bench",
  model: "bench-model",
  fallbackModels: [],
  prompt: DEFAULT_AI_PROMPT,
  maxTokens: 4000,
  timeout: 15_000,
  minLen: 0,
  maxPerRound: 5,
};
// 每个用户命中「同一条」帖子：内容完全相同 —— 这正是多用户场景的常态
const TITLE = "【出】绿云 GreenCloud 洛杉矶 1C1G 年付 20 美元";
const BODY = "绿云洛杉矶 1C1G 年付 20 美元，三网优化。".repeat(20);

const ns = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;

console.log(
  `\n用户 ${USERS} 户各 1 条摘要 / 上游延迟 ${LATENCY} ms / AI_CONCURRENCY ${config.aiConcurrency}`
);

// ─── A. 现状：逐用户 await ───────────────────────────────────────────────────

calls = 0;
const tA = ns();
for (let u = 0; u < USERS; u++) {
  await aiSemaphore.runAll([async () => aiSummary(cfg, TITLE, BODY, "交易")]);
}
const a = ms(tA);
console.log(`\nA 旧形状（逐用户 await，已修复）      ${a.toFixed(0).padStart(8)} ms   上游调用 ${calls} 次`);

// ─── B. 拍平：一次丢进全局信号量 ─────────────────────────────────────────────

calls = 0;
const tB = ns();
await aiSemaphore.runAll(
  Array.from({ length: USERS }, () => async () => aiSummary(cfg, TITLE, BODY, "交易"))
);
const b = ms(tB);
console.log(`B 现形状（全局并发，生产在跑）          ${b.toFixed(0).padStart(8)} ms   上游调用 ${calls} 次`);

console.log(`\n  B 比 A 快 ${(a / b).toFixed(1)}×`);
console.log(`  理论上限 A ≈ 用户数 × 延迟 = ${USERS} × ${LATENCY} ms = ${USERS * LATENCY} ms`);
console.log(`  理论上限 B ≈ 用户数 / 并发 × 延迟 = ${USERS}/${config.aiConcurrency} × ${LATENCY} ms = ${((USERS / config.aiConcurrency) * LATENCY).toFixed(0)} ms`);
console.log(
  `\n  照旧形状 A，一小时内最多能服务 ${Math.round(3_600_000 / (LATENCY * 1))} 个「用户×摘要」；` +
    `按每轮 60 秒算，每轮上限 ${Math.round(60_000 / LATENCY)} 条`
);

await pool.close();
(await import(`${SRC}/db.js")).closeDb();
