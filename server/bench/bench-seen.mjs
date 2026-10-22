// ============================================================================
// 已见记录基准：水位线（现方案）vs 旧方案留下的历史表
//
// 旧方案 seen_posts 是「每用户 × 每帖一行」：实测 NodeSeek 约 2.8 帖/分钟，
// 2000 用户 7 天约 6000 万行 / 6 GiB，且每小时一次全表扫描的 DELETE 会把主线程
// 卡住约 12 秒。现方案 seen_state 每个 (用户, 源) 只留一行。
//
// 本脚本量三件事：
//   1. 2000 用户下 filterUnseen / markSeen 的真实开销
//   2. 水位线的存储规模（应恒定为 用户数 × 源数）
//   3. 遗留 seen_posts 的分批清空速度（决定 6000 万行要排多久）
//
// 用法：node bench/bench-seen.mjs
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
process.env.DB_PATH = join(BENCH_DIR, `seen-${Date.now()}.db`);
process.env.LOG_LEVEL = "error";
process.env.HEALTH_PORT = "0";
process.env.WORKER_POOL_SIZE = "2";

const db = await import(`${SRC}/db.js`);
const { config } = await import(`${SRC}/config.js`);

const USERS = Number(process.env.BENCH_USERS || 2000);
const PER_ROUND = 3; // 实测 NodeSeek 约 2.8 帖/分钟
const LEGACY_ROWS = Number(process.env.BENCH_LEGACY_ROWS || 1_000_000);

const ns = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const fmt = (n) => n.toLocaleString("en-US");
const uid = (i) => 500000 + i;

console.log(`\n用户 ${USERS} / 每轮新帖 ${PER_ROUND} / 每源每用户一行水位线`);

// ─── 建用户 ──────────────────────────────────────────────────────────────────

db.db.exec("BEGIN");
for (let i = 0; i < USERS; i++) db.createUser({ telegramId: uid(i), username: `u${i}` });
db.db.exec("COMMIT");

// 先把水位线推进到一个「已跑了很多轮」的状态
const POSTS = Array.from({ length: PER_ROUND }, (_, i) => ({ post_id: 1_000_000 + i, source: 0 }));
for (let i = 0; i < USERS; i++) db.markSeen(uid(i), POSTS);

const sizeMiB = () => {
  const p = db.db.prepare("PRAGMA page_count").get();
  const s = db.db.prepare("PRAGMA page_size").get();
  return ((p?.page_count ?? 0) * (s?.page_size ?? 0)) / 2 ** 20;
};

// ─── 1/2. 每轮开销与规模 ─────────────────────────────────────────────────────

console.log("\n── 每轮开销（与旧方案同口径：各跑 USERS 次）──────");
let t = ns();
for (let i = 0; i < USERS; i++) db.filterUnseen(uid(i), POSTS);
const fMs = ms(t);

// 每一轮来 3 条新帖（id 递增），水位线前移
let nextId = 1_000_000 + PER_ROUND;
const rounds = 60;
t = ns();
for (let r = 0; r < rounds; r++) {
  const batch = Array.from({ length: PER_ROUND }, (_, i) => ({ post_id: nextId + i, source: 0 }));
  nextId += PER_ROUND;
  for (let i = 0; i < USERS; i++) db.markSeen(uid(i), batch);
}
const mMs = ms(t) / rounds;

console.log(`  filterUnseen × ${USERS}                 ${fMs.toFixed(1).padStart(9)} ms`);
console.log(`  markSeen × ${USERS}（每人 3 帖）          ${mMs.toFixed(1).padStart(9)} ms`);

const rows = db.db.prepare("SELECT COUNT(*) AS n FROM seen_state").get().n;
const watermarkMiB = sizeMiB(); // 必须在灌遗留表之前量
console.log(`\n  水位线行数：${fmt(rows)}（${USERS} 用户 × 1 源）`);
console.log(`  跑了 ${rounds} 轮后行数是否变化：${rows === USERS ? "否 ✓ 恒定" : "是 ✗"}`);
console.log(`  纯水位线的库文件：${watermarkMiB.toFixed(1)} MiB`);

// ─── 3. 遗留表清空速度 ───────────────────────────────────────────────────────

console.log(`\n── 遗留 seen_posts 分批清空（灌 ${fmt(LEGACY_ROWS)} 行）────`);
const ins = db.db.prepare("INSERT OR IGNORE INTO seen_posts (telegram_id,post_id,seen_at) VALUES (?,?,?)");
const ts = new Date().toISOString();
t = ns();
db.db.exec("BEGIN");
for (let i = 0; i < LEGACY_ROWS; i++) ins.run(1 + (i % 50), 20_000_000 + i, ts);
db.db.exec("COMMIT");
console.log(`  灌入耗时 ${ms(t).toFixed(0)} ms`);

t = ns();
const removed = db.purgeLegacySeenPosts(Number.MAX_SAFE_INTEGER); // 不限时，量吞吐
const purgeMs = ms(t);
console.log(`  不限时清空 ${fmt(removed)} 行：${purgeMs.toFixed(0)} ms（${Math.round(removed / (purgeMs / 1000) / 1000)}k 行/秒）`);
console.log(
  `  按每次维护 ${config.legacySeenPurgeMs}ms 预算折算：约 ${Math.round(
    config.legacySeenPurgeMs * (removed / purgeMs)
  ).toLocaleString("en-US")} 行/次`
);

const perDay = PER_ROUND * 1440 * USERS;
console.log("\n── 与旧方案对比 ───────────────────────────────────");
console.log(`  旧方案：${fmt(perDay)} 行/天 → 7 天 ${fmt(perDay * 7)} 行 / 约 ${(perDay * 7 * 105 / 2 ** 30).toFixed(1)} GiB`);
console.log(`  现方案：${fmt(USERS)} 行恒定 / ${watermarkMiB.toFixed(1)} MiB，且不再有任何按时间清理`);
console.log(`  6000 万遗留行按每次维护预算清空：约 ${Math.ceil(60_000_000 / Math.max(1, config.legacySeenPurgeMs * (removed / purgeMs)))} 次维护（每次 ${config.legacySeenPurgeMs}ms）`);

db.closeDb();
