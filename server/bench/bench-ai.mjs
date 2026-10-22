// ============================================================================
// AI 摘要阶段的并发形状基准
//
// poller.js 第 4 步原本是 `for (const job of jobs) { await aiSemaphore.runAll(...) }`
// —— 每个用户的摘要批次串行等待，于是 N 个用户各要 1 条摘要时，
// 总耗时 ≈ N × 单次延迟，而不是 (N / AI_CONCURRENCY) × 单次延迟。
//
// 本脚本用固定的上游延迟把三种形状实测出来做对照：
//   A. 旧形状（2026-10-16 已修复）：逐个用户 await
//   B. 现形状（生产在跑）：所有任务一次性丢进同一个全局信号量
//   C. 现形状 + 同一条帖子：再叠加「按内容缓存 + 在飞请求合并」
//
// 用法：node bench/bench-ai.mjs
//       BENCH_USERS=200 BENCH_LATENCY_MS=100 node bench/bench-ai.mjs
// ============================================================================
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.BENCH_SRC || "../src";
const BENCH_DIR = process.env.BENCH_DIR || join(HERE, "..", ".bench");
mkdirSync(BENCH_DIR, { recursive: true });

process.env.NODE_ENV = "development";
process.env.TELEGRAM_BOT_TOKEN = "123456:BENCHTOKEN";
process.env.APP_MASTER_KEY = "0123456789abcdef".repeat(4);
process.env.DB_PATH = join(BENCH_DIR, `ai-${Date.now()}.db`);
process.env.LOG_LEVEL = "error";
process.env.HEALTH_PORT = "0";
process.env.WORKER_POOL_SIZE = "2";
process.env.AI_CONCURRENCY = String(process.env.AI_CONCURRENCY || 8);

const USERS = Number(process.env.BENCH_USERS || 200);
const LATENCY = Number(process.env.BENCH_LATENCY_MS || 100);

const { aiSummary, clearSummaryCache } = await import(`${SRC}/ai.js`);
const { aiSemaphore } = await import(`${SRC}/poller.js`);
const { DEFAULT_AI_PROMPT, config } = await import(`${SRC}/config.js`);
const { pool } = await import(`${SRC}/worker-pool.js`);

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

const mkCfg = (model = "bench-model") => ({
  base: "https://api.example.com/v1",
  key: "sk-bench",
  model,
  fallbackModels: [],
  prompt: DEFAULT_AI_PROMPT,
  maxTokens: 4000,
  timeout: 15_000,
  minLen: 0,
  maxPerRound: 5,
});

// 每个用户命中「同一条」帖子：内容完全相同 —— 这正是多用户场景的常态
const TITLE = "【出】绿云 GreenCloud 洛杉矶 1C1G 年付 20 美元";
const BODY = "绿云洛杉矶 1C1G 年付 20 美元，三网优化。".repeat(20);

const ns = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const cfg = mkCfg();

console.log(
  `\n用户 ${USERS} 户各 1 条摘要 / 上游延迟 ${LATENCY} ms / AI_CONCURRENCY ${config.aiConcurrency}`
);

// ─── A. 旧形状：逐用户 await（且当时没有缓存，所以每轮都清一次）──────────────

clearSummaryCache();
calls = 0;
const tA = ns();
for (let u = 0; u < USERS; u++) {
  // 修复前既没有缓存也没有在飞合并，每次都要真打上游；
  // 不清缓存的话这里测到的是「新缓存」，而不是旧形状。
  clearSummaryCache();
  await aiSemaphore.runAll([async () => aiSummary(cfg, TITLE, BODY, "交易")]);
}
const a = ms(tA);
console.log(`\nA 旧形状（逐用户 await，无缓存）   ${a.toFixed(0).padStart(8)} ms   上游调用 ${calls} 次`);

// ─── B. 现形状：一次丢进全局信号量（内容各异，排除缓存影响）──────────────────

clearSummaryCache();
calls = 0;
const tB = ns();
await aiSemaphore.runAll(
  Array.from({ length: USERS }, (_, i) => async () =>
    aiSummary(mkCfg(`bench-model-${i}`), `${TITLE} #${i}`, `${BODY} #${i}`, "交易")
  )
);
const b = ms(tB);
console.log(`B 现形状（全局并发，内容各异）     ${b.toFixed(0).padStart(8)} ms   上游调用 ${calls} 次`);

// ─── C. 现形状 + 同一条帖子：缓存 + 在飞合并 ─────────────────────────────────

clearSummaryCache();
calls = 0;
const tC = ns();
await aiSemaphore.runAll(
  Array.from({ length: USERS }, () => async () => aiSummary(cfg, TITLE, BODY, "交易"))
);
const c = ms(tC);
console.log(`C 现形状 + 同一条帖子（生产实况）   ${c.toFixed(0).padStart(8)} ms   上游调用 ${calls} 次`);

console.log(
  `\n  B 比 A 快 ${(a / Math.max(b, 1)).toFixed(1)}×（理论上限 = AI_CONCURRENCY = ${config.aiConcurrency}）`
);
console.log(`  C 比 A 快 ${(a / Math.max(c, 1)).toFixed(1)}×，上游调用从 ${USERS} 次降到 ${calls} 次`);
console.log(
  `\n  照旧形状 A，每轮 60 秒最多只能服务 ${Math.round(60_000 / LATENCY)} 条摘要（本脚本延迟 ${LATENCY}ms）；` +
    `按真实单次 3 秒算只有 ${Math.round(60_000 / 3000)} 条`
);

await pool.close();
(await import(`${SRC}/db.js`)).closeDb();
