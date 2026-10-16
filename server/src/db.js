// ============================================================================
// SQLite 存储层
//
// 多用户隔离靠数据模型保证：所有用户级表都以 telegram_id 作为主键/前缀，
// 任何查询都必须带 telegram_id 条件，不存在「先查出全部再过滤」的写法。
//
// 性能要点：
//   · WAL 模式 —— 读写不互斥，轮询写库不阻塞命令查询
//   · synchronous=NORMAL —— WAL 下兼顾安全与吞吐
//   · 预编译语句缓存 —— 避免每分钟重复编译同一批 SQL
//   · 索引覆盖热路径：seen_posts(telegram_id,seen_at)、keywords(telegram_id,enabled)
// ============================================================================
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// ─── 初始化 ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id       INTEGER PRIMARY KEY,
  username          TEXT,
  display_name      TEXT,
  role              TEXT    NOT NULL DEFAULT 'user',
  status            TEXT    NOT NULL DEFAULT 'active',
  created_at        TEXT    NOT NULL,
  last_seen_at      TEXT,
  max_keywords      INTEGER,
  daily_ai_quota    INTEGER,
  daily_push_quota  INTEGER,
  note              TEXT
);

CREATE TABLE IF NOT EXISTS keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL,
  keyword      TEXT    NOT NULL,
  category     TEXT,
  match_mode   TEXT    NOT NULL DEFAULT 'substring',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  UNIQUE(telegram_id, keyword, category)
);
CREATE INDEX IF NOT EXISTS idx_keywords_user ON keywords(telegram_id, enabled);

CREATE TABLE IF NOT EXISTS ai_configs (
  telegram_id   INTEGER PRIMARY KEY,
  base_url      TEXT    NOT NULL,
  api_key_enc   TEXT    NOT NULL,
  api_key_hint  TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  fallback      TEXT,
  min_len       INTEGER NOT NULL DEFAULT 0,
  max_per_round INTEGER NOT NULL DEFAULT 5,
  max_tokens    INTEGER NOT NULL DEFAULT 4000,
  timeout_ms    INTEGER NOT NULL DEFAULT 15000,
  prompt        TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT    NOT NULL
);

-- 【遗留，只读不再写】旧的已见方案：每用户 × 每帖一行。
-- 2000 用户 7 天会涨到约 6000 万行 / 6 GiB，而 RSS 只暴露最新约 20 条 ——
-- 绝大多数行永远不会被查到。已由 seen_state 取代，这里只保留表以便分批清空。
CREATE TABLE IF NOT EXISTS seen_posts (
  telegram_id INTEGER NOT NULL,
  post_id     INTEGER NOT NULL,
  seen_at     TEXT    NOT NULL,
  PRIMARY KEY (telegram_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_seen_user_time ON seen_posts(telegram_id, seen_at);

-- 已见帖子水位线：每个 (用户, 源) 只记「见过的最大 post_id」。
-- post_id 与发帖时间同序且只增（NodeSeek 用帖子号，TG 镜像用消息号），
-- 所以「id ≤ 水位线」等价于「已经见过」，一行代替几万行。
CREATE TABLE IF NOT EXISTS seen_state (
  telegram_id INTEGER NOT NULL,
  source      INTEGER NOT NULL,
  max_post_id INTEGER NOT NULL,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (telegram_id, source)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  post_id     INTEGER NOT NULL,
  keyword     TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  link        TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  author      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'sent',
  sent_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user_time ON notifications(telegram_id, sent_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  telegram_id INTEGER NOT NULL,
  day         TEXT    NOT NULL,
  ai_calls    INTEGER NOT NULL DEFAULT 0,
  pushes      INTEGER NOT NULL DEFAULT 0,
  commands    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (telegram_id, day)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  target_id  INTEGER,
  detail     TEXT,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS rss_state (
  url           TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  last_ok_at    TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0
);
`;

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA temp_store = MEMORY");
db.exec(SCHEMA);

// ─── 预编译语句缓存 ──────────────────────────────────────────────────────────

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

// ─── settings ────────────────────────────────────────────────────────────────

export function getSetting(key, def = null) {
  const row = prep("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : def;
}

/** 判断某人是否是管理员：环境变量白名单 或 库内 role=admin */
export function isAdminUser(userOrId) {
  const obj = typeof userOrId === "object" && userOrId !== null ? userOrId : null;
  const user = obj ? obj : getUser(userOrId);
  if (!user) {
    // 未注册也要认白名单。否则单用户模式（默认）下实例被陌生人抢先 /bind 认领后，
    // ADMIN_TELEGRAM_IDS 里的真主人既进不了 /admin、又会被单用户模式挡住 /bind，
    // 彻底找不回管理权 —— README 承诺的那条路径形同虚设。
    const id = obj ? obj.telegram_id : userOrId;
    return config.adminIds.has(Number(id));
  }
  return user.role === "admin" || config.adminIds.has(user.telegram_id);
}

export function setSetting(key, value) {
  prep("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    key,
    String(value)
  );
}

export function getSettings(keys) {
  if (!keys.length) return {};
  const ph = keys.map(() => "?").join(",");
  const rows = prep(`SELECT key,value FROM settings WHERE key IN (${ph})`).all(...keys);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ─── 用户 ────────────────────────────────────────────────────────────────────

export function getUser(telegramId) {
  return prep("SELECT * FROM users WHERE telegram_id=?").get(telegramId) || null;
}

export function countUsers() {
  return prep("SELECT COUNT(*) AS n FROM users").get().n;
}

export function listUsers({ limit = 50, offset = 0, status = null } = {}) {
  if (status) {
    return prep(
      "SELECT * FROM users WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(status, limit, offset);
  }
  return prep("SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
}

/** 创建用户；已存在则返回 null（由调用方决定提示语） */
export function createUser({ telegramId, username, displayName, role = "user" }) {
  const r = prep(
    `INSERT OR IGNORE INTO users (telegram_id,username,display_name,role,status,created_at,last_seen_at)
     VALUES (?,?,?,?, 'active', ?, ?)`
  ).run(telegramId, username || null, displayName || null, role, now(), now());
  return r.changes > 0 ? getUser(telegramId) : null;
}

export function touchUser(telegramId, username, displayName) {
  prep("UPDATE users SET last_seen_at=?, username=COALESCE(?,username), display_name=COALESCE(?,display_name) WHERE telegram_id=?").run(
    now(),
    username || null,
    displayName || null,
    telegramId
  );
}

export function setUserStatus(telegramId, status) {
  return prep("UPDATE users SET status=? WHERE telegram_id=?").run(status, telegramId).changes;
}

export function setUserQuota(telegramId, field, value) {
  if (!["max_keywords", "daily_ai_quota", "daily_push_quota"].includes(field)) {
    throw new Error(`不允许修改的配额字段: ${field}`);
  }
  return prep(`UPDATE users SET ${field}=? WHERE telegram_id=?`).run(value, telegramId).changes;
}

export function setUserNote(telegramId, note) {
  return prep("UPDATE users SET note=? WHERE telegram_id=?").run(note, telegramId).changes;
}

export function deleteUser(telegramId) {
  db.exec("BEGIN");
  try {
    for (const t of ["keywords", "ai_configs", "seen_state", "seen_posts", "notifications", "usage_daily"]) {
      prep(`DELETE FROM ${t} WHERE telegram_id=?`).run(telegramId);
    }
    // 关键词修订号必须一并清掉：否则同一个 Telegram ID 重新 /bind 后，
    // loadKeywordsFor 会读到残留修订号、复用删除前的关键词缓存，
    // 表现为「库里 0 条关键词却照常收到推送」。
    prep("DELETE FROM settings WHERE key=?").run(keywordRevisionKey(telegramId));
    const n = prep("DELETE FROM users WHERE telegram_id=?").run(telegramId).changes;
    db.exec("COMMIT");
    return n;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 解析用户的生效配额：用户级覆盖优先，否则用全局默认。
 *  管理员不受配额限制（返回 Infinity），避免自己给自己设限。 */
export function effectiveQuota(user) {
  if (user && (user.role === "admin" || config.adminIds.has(user.telegram_id))) {
    return { maxKeywords: Infinity, dailyAi: Infinity, dailyPush: Infinity };
  }
  // dailyAi 为 0 表示**不限**（默认值就是 0）。要收紧就设成正数。
  // 映射成 Infinity 后 formatQuota 会显示「不限」，配额检查也自然全部放行。
  const dailyAi = user.daily_ai_quota ?? config.defaultDailyAiQuota;
  return {
    maxKeywords: user.max_keywords ?? config.defaultMaxKeywords,
    dailyAi: dailyAi === 0 ? Infinity : dailyAi,
    dailyPush: user.daily_push_quota ?? config.defaultDailyPushQuota,
  };
}

/** 展示用：Infinity 写成「不限」 */
export function formatQuota(n) {
  return n === Infinity ? "不限" : String(n);
}

// ─── 多用户模式（环境变量给初值，管理员运行时可覆盖，覆盖值持久化）──────────

const MODE_KEY = "multi_user_enabled";

/**
 * 当前是否处于多用户模式。
 * 优先级：数据库中的管理员覆盖值 > 环境变量 MULTI_USER_ENABLED。
 */
export function isMultiUserEnabled() {
  const stored = getSetting(MODE_KEY, null);
  if (stored === null) return config.multiUserEnabled;
  return stored === "1";
}

/** 覆盖值是否由管理员设置过（而非继承环境变量） */
export function isMultiUserOverridden() {
  return getSetting(MODE_KEY, null) !== null;
}

export function setMultiUserEnabled(enabled) {
  setSetting(MODE_KEY, enabled ? "1" : "0");
}

/** 清除管理员覆盖，回到环境变量决定的值 */
export function resetMultiUserEnabled() {
  prep("DELETE FROM settings WHERE key=?").run(MODE_KEY);
}

// ─── 所有权 / 首个管理员 ─────────────────────────────────────────────────────

/**
 * 认领所有权：系统里还没有任何用户时，把第一个 /bind 的人设为管理员。
 * 返回 true 表示本次调用完成了认领。
 * 用事务包住「检查 + 插入」，避免并发 /bind 产生两个管理员。
 */
export function claimOwnership({ telegramId, username, displayName }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = prep("SELECT COUNT(*) AS n FROM users").get().n;
    if (n > 0) {
      db.exec("ROLLBACK");
      return false;
    }
    prep(
      `INSERT INTO users (telegram_id,username,display_name,role,status,created_at,last_seen_at)
       VALUES (?,?,?, 'admin', 'active', ?, ?)`
    ).run(telegramId, username || null, displayName || null, now(), now());
    prep("INSERT INTO audit_log (actor_id,action,target_id,detail,created_at) VALUES (?,?,?,?,?)").run(
      telegramId,
      "claim_ownership",
      telegramId,
      "首个用户自动成为管理员",
      now()
    );
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 是否已经有任何用户（用于判断系统是否已被认领） */
export function hasAnyUser() {
  return countUsers() > 0;
}

// ─── 关键词 ──────────────────────────────────────────────────────────────────

export function listKeywords(telegramId, { onlyEnabled = false } = {}) {
  const sql = onlyEnabled
    ? "SELECT * FROM keywords WHERE telegram_id=? AND enabled=1 ORDER BY id"
    : "SELECT * FROM keywords WHERE telegram_id=? ORDER BY id";
  return prep(sql).all(telegramId);
}

export function countKeywords(telegramId) {
  return prep("SELECT COUNT(*) AS n FROM keywords WHERE telegram_id=?").get(telegramId).n;
}

export function addKeyword(telegramId, keyword, category, matchMode) {
  try {
    const r = prep(
      "INSERT INTO keywords (telegram_id,keyword,category,match_mode,enabled,created_at) VALUES (?,?,?,?,1,?)"
    ).run(telegramId, keyword, category, matchMode, now());
    return { id: r.lastInsertRowid };
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return { duplicate: true };
    throw e;
  }
}

export function removeKeywordById(telegramId, id) {
  return prep("DELETE FROM keywords WHERE telegram_id=? AND id=?").run(telegramId, id).changes;
}

export function setKeywordEnabled(telegramId, id, enabled) {
  return prep("UPDATE keywords SET enabled=? WHERE telegram_id=? AND id=?").run(
    enabled ? 1 : 0,
    telegramId,
    id
  ).changes;
}

/** 改动关键词后需要让匹配缓存失效 */
export const keywordRevisionKey = (telegramId) => `kwrev:${telegramId}`;

export function bumpKeywordRevision(telegramId) {
  const next = Number.parseInt(getSetting(keywordRevisionKey(telegramId), "0"), 10) + 1;
  setSetting(keywordRevisionKey(telegramId), String(next));
  return next;
}

// ─── AI 配置 ─────────────────────────────────────────────────────────────────

export function getAiConfig(telegramId) {
  return prep("SELECT * FROM ai_configs WHERE telegram_id=?").get(telegramId) || null;
}

export function upsertAiConfig(telegramId, cfg) {
  prep(
    `INSERT INTO ai_configs
       (telegram_id,base_url,api_key_enc,api_key_hint,model,fallback,min_len,max_per_round,max_tokens,timeout_ms,prompt,enabled,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       base_url=excluded.base_url, api_key_enc=excluded.api_key_enc, api_key_hint=excluded.api_key_hint,
       model=excluded.model, fallback=excluded.fallback, min_len=excluded.min_len,
       max_per_round=excluded.max_per_round, max_tokens=excluded.max_tokens,
       timeout_ms=excluded.timeout_ms, prompt=excluded.prompt, enabled=excluded.enabled,
       updated_at=excluded.updated_at`
  ).run(
    telegramId,
    cfg.baseUrl,
    cfg.apiKeyEnc,
    cfg.apiKeyHint,
    cfg.model,
    cfg.fallback || null,
    cfg.minLen ?? 0,
    cfg.maxPerRound ?? 5,
    cfg.maxTokens ?? 4000,
    cfg.timeoutMs ?? 15000,
    cfg.prompt || null,
    cfg.enabled === false ? 0 : 1,
    now()
  );
}

export function deleteAiConfig(telegramId) {
  return prep("DELETE FROM ai_configs WHERE telegram_id=?").run(telegramId).changes;
}

/** 一次性取出所有启用了 AI 的配置，供轮询器批量处理，避免 N 次查询 */
export function listEnabledAiConfigs() {
  return prep(
    `SELECT a.* FROM ai_configs a
     JOIN users u ON u.telegram_id = a.telegram_id
     WHERE a.enabled=1 AND u.status='active'`
  ).all();
}

// ─── 已见帖子（水位线） ──────────────────────────────────────────────────────
//
// 语义：某 (用户, 源) 见过 post_id ≤ max_post_id 的全部帖子。
// 每轮 markSeen 会把本轮**所有**帖子（含未命中的）的最高 id 记进去 —— 与旧方案
// 「把本轮所有帖子都标记已见」完全一致，因此不会因为换实现而重复推送或漏推。
//
// 之所以能这么省：NodeSeek 的 post_id 就是帖子号，随发帖时间严格递增
// （实测一屏 20 条 987476→987495，且与 pubDate 同序）；TG 镜像源用消息号，同样
// 递增。新帖不可能拿到比已有帖子更小的号，所以一个水位线就够。

/** 只接受 { post_id, source }；数字视为 source=0（测试与旧调用方便） */
function normalizePost(p) {
  if (typeof p === "number") return { post_id: p, source: 0 };
  return { post_id: p.post_id, source: p.source ?? 0 };
}

let legacyTableExists = null;

/**
 * 升级垫片：老库有 seen_posts 但没有水位线。
 *
 * 不做这一步的话，升级后的**第一轮**会把整个 feed 当成全新帖子 —— 每个老用户
 * 都会被推最多 MAX_PER_USER_PER_ROUND 条。单机自用无所谓，但 2000 用户的部署
 * 会在一轮里涌出上万条推送，把几十分钟的发送配额一次性吃光。
 *
 * 按需做而不是启动时全量做：`MAX(post_id) WHERE telegram_id=?` 走主键索引，
 * 单次 O(log n)，只对「还没有水位线」的用户各查一次。启动时做全表 GROUP BY
 * 在 6000 万行的老库上要扫好几秒，会把启动卡住。
 *
 * 返回迁移出来的水位线（没有旧数据则返回 null）。
 */
function migrateLegacyWatermark(telegramId) {
  if (legacyTableExists === null) {
    legacyTableExists = !!prep(
      "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='seen_posts'"
    ).get();
  }
  if (!legacyTableExists) return null;
  const m = prep("SELECT MAX(post_id) AS m FROM seen_posts WHERE telegram_id=?").get(telegramId)?.m;
  if (m === null || m === undefined) return null;
  // 旧数据没记来源，只能当主源处理（实际也几乎总是主源）
  prep(
    `INSERT INTO seen_state (telegram_id,source,max_post_id,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(telegram_id,source) DO NOTHING`
  ).run(telegramId, 0, m, now());
  log.debug("db", `用户 ${telegramId} 的水位线由旧 seen_posts 迁移：max_post_id=${m}`);
  return m;
}

/** 一次查出某用户已看过的帖子 ID 集合 */
export function filterUnseen(telegramId, posts) {
  const seen = new Set();
  if (!posts.length) return seen;
  const marks = new Map();
  for (const r of prep("SELECT source,max_post_id FROM seen_state WHERE telegram_id=?").all(telegramId)) {
    marks.set(r.source, r.max_post_id);
  }
  if (!marks.size) {
    const seeded = migrateLegacyWatermark(telegramId);
    if (seeded !== null) marks.set(0, seeded);
  }
  if (!marks.size) return seen;
  for (const raw of posts) {
    const { post_id, source } = normalizePost(raw);
    const mark = marks.get(source);
    if (mark !== undefined && post_id <= mark) seen.add(post_id);
  }
  return seen;
}

/**
 * 推进水位线。只取本轮各源的**最高** post_id，并且永不回退
 * （某条最新帖被删掉时本轮最大值会变小，把水位线调低会让它之后的帖子重新推一遍）。
 */
export function markSeen(telegramId, posts) {
  if (!posts.length) return;
  const top = new Map();
  for (const raw of posts) {
    const { post_id, source } = normalizePost(raw);
    if (!top.has(source) || post_id > top.get(source)) top.set(source, post_id);
  }
  const ts = now();
  const stmt = prep(
    `INSERT INTO seen_state (telegram_id,source,max_post_id,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(telegram_id,source) DO UPDATE SET
       max_post_id=MAX(seen_state.max_post_id, excluded.max_post_id),
       updated_at=excluded.updated_at`
  );
  db.exec("BEGIN");
  try {
    for (const [source, id] of top) stmt.run(telegramId, source, id, ts);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ─── 推送历史 ────────────────────────────────────────────────────────────────

export function logNotification(telegramId, post, keyword, status) {
  prep(
    `INSERT INTO notifications (telegram_id,post_id,keyword,title,link,category,author,status,sent_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(telegramId, post.post_id, keyword, post.title, post.link, post.category, post.author, status, now());
}

export function getHistory(telegramId, limit = 10) {
  return prep(
    `SELECT post_id, GROUP_CONCAT(DISTINCT keyword) AS keywords,
            title, link, category, author, MIN(status) AS status, MAX(sent_at) AS sent_at
     FROM notifications WHERE telegram_id=? GROUP BY post_id ORDER BY sent_at DESC LIMIT ?`
  ).all(telegramId, limit);
}

// ─── 用量与配额 ──────────────────────────────────────────────────────────────

export function getUsage(telegramId, day = today()) {
  return (
    prep("SELECT * FROM usage_daily WHERE telegram_id=? AND day=?").get(telegramId, day) || {
      telegram_id: telegramId,
      day,
      ai_calls: 0,
      pushes: 0,
      commands: 0,
    }
  );
}

export function incrUsage(telegramId, field, delta = 1, day = today()) {
  if (!["ai_calls", "pushes", "commands"].includes(field)) {
    throw new Error(`不允许自增的用量字段: ${field}`);
  }
  prep(
    `INSERT INTO usage_daily (telegram_id,day,${field}) VALUES (?,?,?)
     ON CONFLICT(telegram_id,day) DO UPDATE SET ${field} = ${field} + excluded.${field}`
  ).run(telegramId, day, delta);
}

export function totalUsage() {
  const r = prep(
    "SELECT COALESCE(SUM(ai_calls),0) AS ai, COALESCE(SUM(pushes),0) AS pushes FROM usage_daily WHERE day=?"
  ).get(today());
  return { aiCalls: r.ai, pushes: r.pushes };
}

// ─── 审计 ────────────────────────────────────────────────────────────────────

export function audit(actorId, action, targetId = null, detail = null) {
  prep("INSERT INTO audit_log (actor_id,action,target_id,detail,created_at) VALUES (?,?,?,?,?)").run(
    actorId,
    action,
    targetId,
    detail ? String(detail).slice(0, 500) : null,
    now()
  );
}

export function listAudit(limit = 20) {
  return prep("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}

// ─── RSS 源状态 ──────────────────────────────────────────────────────────────

export function getRssState(url) {
  return prep("SELECT * FROM rss_state WHERE url=?").get(url) || null;
}

export function setRssState(url, { etag, lastModified, ok }) {
  const prev = getRssState(url);
  const failCount = ok ? 0 : (prev?.fail_count ?? 0) + 1;
  prep(
    `INSERT INTO rss_state (url,etag,last_modified,last_ok_at,fail_count) VALUES (?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET
       etag=COALESCE(excluded.etag, rss_state.etag),
       last_modified=COALESCE(excluded.last_modified, rss_state.last_modified),
       last_ok_at=COALESCE(excluded.last_ok_at, rss_state.last_ok_at),
       fail_count=excluded.fail_count`
  ).run(url, etag ?? null, lastModified ?? null, ok ? now() : null, failCount);
  return failCount;
}

// ─── 清理 ────────────────────────────────────────────────────────────────────

const legacySeenPurgeStmt = () =>
  prep("DELETE FROM seen_posts WHERE rowid IN (SELECT rowid FROM seen_posts LIMIT 20000)");

/**
 * 分批清空遗留的 seen_posts。
 *
 * 这张表已经被 seen_state 取代，不再读也不再写；留在这里的历史数据（老部署可能
 * 有 6000 万行 / 6 GiB）只是占地方。按 rowid 分批删，并且**受时间预算约束** ——
 * 绝不能变成一次几十秒的全表删除，把主线程（也就是 bot 的响应和长轮询）卡死。
 * 没删完就留给下一次维护继续，反正是后台数据。
 *
 * 注意：SQLite 的文件不会因此缩小（页会被复用）。要立刻拿回磁盘空间，
 * 只能重建数据卷（docker compose down -v）或手工 VACUUM。
 */
export function purgeLegacySeenPosts(budgetMs = config.legacySeenPurgeMs) {
  if (budgetMs <= 0) return 0;
  const exists = prep("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='seen_posts'").get();
  if (!exists) return 0;
  const started = Date.now();
  const stmt = legacySeenPurgeStmt();
  let removed = 0;
  while (Date.now() - started < budgetMs) {
    const n = stmt.run().changes;
    if (!n) break;
    removed += n;
  }
  return removed;
}

export function cleanup() {
  const notifBefore = new Date(Date.now() - config.notifRetentionDays * 86400_000).toISOString();
  const usageBefore = new Date(Date.now() - config.usageRetentionDays * 86400_000)
    .toISOString()
    .slice(0, 10);
  let removed = 0;
  db.exec("BEGIN");
  try {
    removed += purgeLegacySeenPosts();
    removed += prep("DELETE FROM notifications WHERE sent_at < ?").run(notifBefore).changes;
    removed += prep("DELETE FROM usage_daily WHERE day < ?").run(usageBefore).changes;
    removed += prep("DELETE FROM audit_log WHERE created_at < ?").run(notifBefore).changes;
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return removed;
}

export function closeDb() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* 忽略 */
  }
  db.close();
}

log.debug("db", `SQLite 就绪: ${config.dbPath}`);
