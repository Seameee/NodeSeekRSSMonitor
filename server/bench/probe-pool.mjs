// ============================================================================
// 探针：worker 任务超时被回收后，池是否恢复到配置的线程数？
//
// 背景：在真实的 1 CPU 容器里跑基准时，一次 40000 关键词的匹配任务超过
// WORKER_TASK_TIMEOUT_MS 被终止，随后 pool.stats() 报 alive=3（配置为 4）。
// 若成立，就是「超时一次永久少一个线程」，在弱机器上会越跑越慢。
//
// 用法：node bench/probe-pool.mjs
// ============================================================================
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = process.env.BENCH_DIR || join(HERE, "..", ".bench");
mkdirSync(BENCH_DIR, { recursive: true });

process.env.NODE_ENV = "development";
process.env.TELEGRAM_BOT_TOKEN = "123456:PROBE";
process.env.APP_MASTER_KEY = "0123456789abcdef".repeat(4);
process.env.DB_PATH = join(BENCH_DIR, `probe-${Date.now()}.db`);
process.env.LOG_LEVEL = "error"; // 故意静音：只看 stats，不看日志
process.env.HEALTH_PORT = "0";
process.env.WORKER_POOL_SIZE = "4";
process.env.WORKER_TASK_TIMEOUT_MS = "500"; // 下限 // 逼出超时

const { pool } = await import("../src/worker-pool.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const posts = Array.from({ length: 30 }, (_, i) => ({ post_id: i, title: `标题 ${i} 绿云`, category: "trade", source: 1 }));
const keywords = Array.from({ length: 40_000 }, (_, i) => ({
  keyword: `zz_${i}`,
  category: null,
  match_mode: "regex",
}));

console.log(`配置线程数 ${pool.size}，任务超时 ${pool.taskTimeoutMs}ms`);
console.log(`初始 stats: ${JSON.stringify(pool.stats())}`);

for (let round = 1; round <= 3; round++) {
  try {
    await pool.run("match", { posts, keywords });
    console.log(`第 ${round} 次：未超时（意外）`);
  } catch (e) {
    console.log(`第 ${round} 次：任务被终止 -> ${e.message}`);
  }
  await sleep(300);
  console.log(`  之后 stats: ${JSON.stringify(pool.stats())}`);
}

// 再跑一个轻量任务，确认池还能干活
const r = await pool.run("match", { posts: [{ post_id: 1, title: "绿云", category: "trade", source: 1 }], keywords: [{ keyword: "绿云", category: null, match_mode: "substring" }] });
console.log(`轻量任务结果: ${JSON.stringify(r)}`);
console.log(`最终 stats: ${JSON.stringify(pool.stats())}`);

await pool.close();
(await import("../src/db.js")).closeDb();
