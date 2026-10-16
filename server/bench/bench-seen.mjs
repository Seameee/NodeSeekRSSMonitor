// ============================================================================
// seen_posts 规模退化基准
//
// 目的：验证「2000 用户 × 7 天保留期」时 seen_posts 会到多少行，以及该规模下
//   · markSeen（每轮每人一次）
//   · filterUnseen（每轮每人一次）
//   · cleanup() 的 DELETE FROM seen_posts WHERE seen_at < ?（每小时一次）
// 分别退化到什么程度，并打印 EXPLAIN QUERY PLAN 确认索引是否被用上。
//
// 另外实测一个候选优化：给 seen_at 单独加索引后 cleanup 快多少。
//
// 用法：node bench/bench-seen.mjs
// ============================================================================
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(HERE, "..", ".bench");
const DB_PATH = join(BENCH_DIR, `seen-${process.env.BENCH_TAG || Date.now()}.db`);
mkdirSync(BENCH_DIR, { recursive: true });

process.env.NODE_ENV = "development";
process.env.TELEGRAM_BOT_TOKEN = "123456:BENCHTOKEN";
process.env.APP_MASTER_KEY = "0123456789abcdef".repeat(4);
process.env.DB_PATH = DB_PATH;
process.env.LOG_LEVEL = "error";
process.env.HEALTH_PORT = "0";
process.env.WORKER_POOL_SIZE = "2";

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const ns = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const fmt = (n) => n.toLocaleString("en-US");

const USERS = 2000;
const PER_ROUND = 3; // 实测 NodeSeek 约 2.8 帖/分钟
const POST_IDS = [900000, 900001, 900002];
const DAYS = config.seenRetentionDays;
const TARGETS = String(process.env.BENCH_TARGETS || "100000,1000000,5000000").split(",").map(Number);

const rows = () => db.db.prepare("SELECT COUNT(*) n FROM seen_posts").get().n;
const sizeMiB = () => {
  const p = db.db.prepare("PRAGMA page_count").get();
  const s = db.db.prepare("PRAGMA page_size").get();
  return ((p?.page_count ?? 0) * (s?.page_size ?? 0)) / 2 ** 20;
};

console.log(`\n保留期 SEEN_RETENTION_DAYS=${DAYS} / 每轮新帖 ${PER_ROUND} / 用户 ${USERS}`);

// ─── 灌数据 ──────────────────────────────────────────────────────────────────
// 轮询分配写到真实的 2000 个用户下；其中 1/10 行的 seen_at 落在保留期之前，
// 好让 cleanup() 真的删到东西（否则只测到「扫全表但一行都不删」的一半）。

let seq = 0;
const OLD_TS = new Date(Date.now() - 30 * 86400_000).toISOString();
function seed(targetTotal) {
  const stmt = db.db.prepare("INSERT OR IGNORE INTO seen_posts (telegram_id,post_id,seen_at) VALUES (?,?,?)");
  const nowTs = new Date().toISOString();
  const t = ns();
  db.db.exec("BEGIN");
  while (seq < targetTotal) {
    stmt.run(500000 + (seq % USERS), 10_000_000 + seq, seq % 10 === 0 ? OLD_TS : nowTs);
    seq++;
  }
  db.db.exec("COMMIT");
  return ms(t);
}

function seedAdd(count) {
  const stmt = db.db.prepare("INSERT OR IGNORE INTO seen_posts (telegram_id,post_id,seen_at) VALUES (?,?,?)");
  const nowTs = new Date().toISOString();
  const before = rows();
  db.db.exec("BEGIN");
  for (let k = 0; k < count; k++, seq++) {
    stmt.run(500000 + (seq % USERS), 10_000_000 + seq, seq % 10 === 0 ? OLD_TS : nowTs);
  }
  db.db.exec("COMMIT");
  return { added: rows() - before, old: Math.ceil(count / 10) };
}

function measure(label) {
  const n = rows();
  console.log(`\n── ${label}：seen_posts = ${fmt(n)} 行 / ${sizeMiB().toFixed(0)} MiB ────`);
  const t1 = ns();
  for (let u = 0; u < USERS; u++) db.filterUnseen(500000 + u, POST_IDS);
  const a = ms(t1);
  const t2 = ns();
  for (let u = 0; u < USERS; u++) db.markSeen(500000 + u, POST_IDS);
  const b = ms(t2);
  const t3 = ns();
  const removed = db.cleanup();
  const c = ms(t3);
  console.log(`  filterUnseen × ${USERS}                ${a.toFixed(1).padStart(10)} ms`);
  console.log(`  markSeen × ${USERS}（新增 6000 行）    ${b.toFixed(1).padStart(10)} ms`);
  console.log(`  cleanup() DELETE                    ${c.toFixed(1).padStart(10)} ms   删除 ${fmt(removed)} 行`);
  return { a, b, c };
}

function explain(title, sql) {
  console.log(`\n  EXPLAIN: ${title}`);
  for (const r of db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()) console.log(`    · ${r.detail}`);
}

// ─── 执行 ────────────────────────────────────────────────────────────────────

db.db.exec("BEGIN");
for (let u = 0; u < USERS; u++) db.createUser({ telegramId: 500000 + u, username: `u${u}` });
db.db.exec("COMMIT");

explain(
  "filterUnseen（每人每轮一次）",
  "SELECT post_id FROM seen_posts WHERE telegram_id=1 AND post_id IN (900000,900001,900002)"
);
explain("cleanup() 的 DELETE 用的查询", "SELECT * FROM seen_posts WHERE seen_at < '2020-01-01'");

console.log("\n── 灌数据 ─────────────────────────────────────────");
const results = [];
for (const target of TARGETS) {
  console.log(`\n  → 灌到 ${fmt(target)} 行：${seed(target).toFixed(0)} ms`);
  results.push(measure(`${fmt(target)} 行`));
}

// ─── 候选优化：给 seen_at 单独加索引 ─────────────────────────────────────────
// 做成公平对照：两边都先补灌同样多的数据（其中 1/10 是过期行），
// 让两次 cleanup 删除的行数相当，差别只在有没有索引。

console.log("\n── 候选优化对照：CREATE INDEX ON seen_posts(seen_at) ──");
console.log("（两边都先补灌 10 万行、其中 1 万行已过期，删除行数相当，差别只在索引）");

let s = seedAdd(100_000);
console.log(`  ① 补灌：+${fmt(s.added)} 行（含约 ${fmt(s.old)} 行过期）`);
const t0 = ns();
const del0 = db.cleanup();
const noIdx = ms(t0);
explain("加索引【前】的 DELETE", "SELECT * FROM seen_posts WHERE seen_at < '2020-01-01'");

const t1 = ns();
db.db.exec("CREATE INDEX IF NOT EXISTS bench_idx_seen_at ON seen_posts(seen_at)");
const buildMs = ms(t1);

s = seedAdd(100_000);
console.log(`  ② 补灌：+${fmt(s.added)} 行（含约 ${fmt(s.old)} 行过期）`);
const t2 = ns();
const del1 = db.cleanup();
const withIdx = ms(t2);
explain("加索引【后】的 DELETE", "SELECT * FROM seen_posts WHERE seen_at < '2020-01-01'");

console.log(`\n  cleanup 无索引：${noIdx.toFixed(1)} ms（删 ${fmt(del0)} 行）`);
console.log(`  cleanup 有索引：${withIdx.toFixed(1)} ms（删 ${fmt(del1)} 行）   ← 建索引一次性 ${(buildMs / 1000).toFixed(1)} s`);
console.log(`  加速比 ${(noIdx / Math.max(withIdx, 0.05)).toFixed(0)}×（表规模 ${fmt(rows())} 行）`);

// ─── 推算 ────────────────────────────────────────────────────────────────────

const perDay = PER_ROUND * 1440 * USERS;
console.log("\n── 推算 ───────────────────────────────────────────");
console.log(`  NodeSeek 实测发帖速率 ≈ ${PER_ROUND} 帖/分钟（21 帖 / 7.5 分钟）`);
console.log(`  每天写入 seen_posts = ${PER_ROUND} × 1440 × ${USERS} = ${fmt(perDay)} 行`);
console.log(`  ${DAYS} 天稳态 ≈ ${fmt(perDay * DAYS)} 行（当前 ${fmt(rows())} 行 / ${sizeMiB().toFixed(0)} MiB）`);
console.log(`  每轮结构开销：filterUnseen ${results[0].a.toFixed(0)} → ${results.at(-1).a.toFixed(0)} ms，` +
  `markSeen ${results[0].b.toFixed(0)} → ${results.at(-1).b.toFixed(0)} ms`);
console.log(`  cleanup：${results[0].c.toFixed(0)} → ${results.at(-1).c.toFixed(0)} ms（${fmt(rows())} 行时）`);

db.closeDb();
