// ============================================================================
// 配置：全部来自环境变量，启动时一次性校验
// ============================================================================
import { randomBytes } from "node:crypto";
import os from "node:os";

/** 解析整数并限制范围 */
function intEnv(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前为 "${raw}"`);
  }
  if (n < min || n > max) {
    throw new Error(`环境变量 ${name} 必须在 ${min}~${max} 之间，当前为 ${n}`);
  }
  return n;
}

/** 解析布尔值：1/true/yes/on 为真 */
function boolEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

/** 解析逗号分隔的列表 */
function listEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const isProd = process.env.NODE_ENV === "production";

// 容器里 os.cpus() 报的是**宿主机**的核数，不是本容器能用的核数：
// docker-compose 把本服务限制成 cpus=1.0，而池子按宿主 4 核开了 4 个线程，
// 结果是 4 个 worker 抢 1 个 CPU 配额（实测同一负载 12 核机 452ms、1 核容器 3180ms）。
// availableParallelism() 会考虑 cgroup 限额与 CPU 亲和性，才是在容器里该用的数。
const cpuCount =
  typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;

// ─── 必填项 ──────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("缺少必填环境变量 TELEGRAM_BOT_TOKEN");
}

// 预指定的管理员（可选）。
// 留空时由「第一个 /bind 的用户」自动成为管理员（见 db.claimOwnership）。
// 填了就始终有效，可用于找回管理权，且不会被 /admin 命令降级。
const ADMIN_IDS = new Set(
  listEnv("ADMIN_TELEGRAM_IDS")
    .map((s) => Number.parseInt(s, 10))
    .filter(Number.isFinite)
);

// ─── 主密钥：用于加密用户 API Key ────────────────────────────────────────────
// 必须是 32 字节。支持两种写法：64 位十六进制，或任意字符串（用 SHA-256 派生）。
let MASTER_KEY_SOURCE = String(process.env.APP_MASTER_KEY || "").trim();
if (!MASTER_KEY_SOURCE) {
  if (isProd) {
    throw new Error(
      "缺少必填环境变量 APP_MASTER_KEY。生成方式：openssl rand -hex 32"
    );
  }
  // 开发模式允许自动生成，但重启后已加密的数据将无法解密
  MASTER_KEY_SOURCE = randomBytes(32).toString("hex");
  console.warn(
    "[config] 未设置 APP_MASTER_KEY，已生成临时密钥。" +
      "该密钥仅存活于本次进程，重启后用户 API Key 将无法解密。生产环境必须显式设置。"
  );
}

export const config = {
  isProd,

  // Telegram
  telegramToken: TELEGRAM_BOT_TOKEN,
  adminIds: ADMIN_IDS,
  // 允许个人私聊使用；群聊默认关闭，避免把服务暴露成公共机器人
  allowGroupChats: boolEnv("ALLOW_GROUP_CHATS", false),

  // 存储
  dbPath: String(process.env.DB_PATH || "/data/nodeseek.db"),
  masterKeySource: MASTER_KEY_SOURCE,

  // 轮询
  pollIntervalMs: intEnv("POLL_INTERVAL_MS", 60_000, { min: 10_000, max: 3_600_000 }),
  rssTimeoutMs: intEnv("RSS_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
  rssRetries: intEnv("RSS_RETRIES", 3, { min: 1, max: 10 }),

  // 并发控制：这是多用户下最关键的性能旋钮
  // CPU 密集任务（XML 解析 + 关键词正则匹配）放进 worker 线程池
  cpuCount,
  workerPoolSize: intEnv("WORKER_POOL_SIZE", Math.max(2, Math.min(4, cpuCount)), {
    min: 0, // 0 = 禁用 worker，退化为进程内计算
    max: 16,
  }),
  workerTaskTimeoutMs: intEnv("WORKER_TASK_TIMEOUT_MS", 5_000, { min: 500, max: 60_000 }),
  // 单轮内同时进行的 AI 请求数（每个用户每个帖子一次）
  aiConcurrency: intEnv("AI_CONCURRENCY", 8, { min: 1, max: 64 }),
  // Telegram 发送并发 + 全局速率（Bot API 约 30 msg/s，留出余量）
  sendConcurrency: intEnv("SEND_CONCURRENCY", 4, { min: 1, max: 32 }),
  sendRatePerSec: intEnv("SEND_RATE_PER_SEC", 20, { min: 1, max: 30 }),
  // 单轮最多处理多少条新帖（防止首次接入时刷屏与雪崩）
  maxPostsPerRound: intEnv("MAX_POSTS_PER_ROUND", 30, { min: 1, max: 500 }),
  // 单用户单轮最多推几条，超出合并为摘要消息
  maxPerUserPerRound: intEnv("MAX_PER_USER_PER_ROUND", 10, { min: 1, max: 100 }),

  // ─── 多用户与防滥用 ────────────────────────────────────────────────────────
  // 多用户模式总开关。默认关闭 = 单用户模式：只有管理员能用，/bind 只对
  // 第一个用户开放（该用户即成为管理员）。管理员可在运行时用
  // /admin multiuser on|off 覆盖，覆盖值持久化到数据库。
  multiUserEnabled: boolEnv("MULTI_USER_ENABLED", false),
  // 多用户模式开启时，是否允许新用户自助 /bind（关闭后仅管理员能开通）
  registrationOpen: boolEnv("REGISTRATION_OPEN", true),
  maxUsers: intEnv("MAX_USERS", 200, { min: 1, max: 100_000 }),
  // 新用户默认配额（管理员可对单个用户覆盖）
  defaultMaxKeywords: intEnv("DEFAULT_MAX_KEYWORDS", 20, { min: 1, max: 1_000 }),
  // AI 配额 0 = 不限：默认不限制 AI 用量（见 db.js effectiveQuota 的 0→Infinity 映射），
  // 管理员可用 /admin quota 给单个用户设成正数来收紧。
  defaultDailyAiQuota: intEnv("DEFAULT_DAILY_AI_QUOTA", 0, { min: 0, max: 1_000_000 }),
  defaultDailyPushQuota: intEnv("DEFAULT_DAILY_PUSH_QUOTA", 500, { min: 0, max: 1_000_000 }),
  // 命令限流：每用户每分钟最多多少条命令
  commandRatePerMin: intEnv("COMMAND_RATE_PER_MIN", 20, { min: 1, max: 600 }),
  // 新用户绑定后的冷却期（秒），期内不能改关键词，防止脚本刷
  bindCooldownSec: intEnv("BIND_COOLDOWN_SEC", 30, { min: 0, max: 3600 }),

  // 输入限制
  maxKeywordLen: intEnv("MAX_KEYWORD_LEN", 100, { min: 1, max: 500 }),
  maxRegexLen: intEnv("MAX_REGEX_LEN", 500, { min: 1, max: 2_000 }),
  maxPromptLen: intEnv("MAX_PROMPT_LEN", 1_000, { min: 10, max: 4_000 }),
  maxHistoryRows: intEnv("MAX_HISTORY_ROWS", 20, { min: 1, max: 100 }),

  // 数据保留
  // seenRetentionDays 自 2026-10-16 起已废弃：已见记录改用水位线（一行一个源），
  // 不再按时间清理。保留这个键只是为了避免删掉环境变量时让人以为配错了。
  seenRetentionDays: intEnv("SEEN_RETENTION_DAYS", 7, { min: 1, max: 365 }),
  // 每次维护最多花多少毫秒清空遗留的 seen_posts（旧方案留下的历史数据）
  legacySeenPurgeMs: intEnv("LEGACY_SEEN_PURGE_MS", 1_500, { min: 0, max: 30_000 }),
  notifRetentionDays: intEnv("NOTIF_RETENTION_DAYS", 30, { min: 1, max: 3650 }),
  usageRetentionDays: intEnv("USAGE_RETENTION_DAYS", 90, { min: 1, max: 3650 }),
  cleanupIntervalMs: intEnv("CLEANUP_INTERVAL_MS", 3_600_000, { min: 60_000, max: 86_400_000 }),

  // 日志
  logLevel: String(process.env.LOG_LEVEL || "info").toLowerCase(),

  // HTTP 健康检查服务（给 Docker healthcheck 用）
  healthPort: intEnv("HEALTH_PORT", 8787, { min: 0, max: 65_535 }),

  // 勿扰模式的默认时区（用户可用 /dnd tz 覆盖自己的）。
  // 容器里 datetime 通常是 UTC，而「23:00 到 08:00」指的是用户本地钟点 ——
  // 用 UTC 比较会让窗口整体平移 8 小时，用户完全无法预期。
  dndTimezone: String(process.env.DND_TIMEZONE || "Asia/Shanghai").trim() || "Asia/Shanghai",
};

export const RSS_SOURCES = [
  { url: "https://rss.nodeseek.com/", name: "主源", supportsCategory: true },
  { url: "https://feed.seaya.link/telegram/channel/nodeseekc", name: "备用1(TG)", supportsCategory: false },
  { url: "https://rsshub.app/telegram/channel/nodeseekc", name: "备用2(TG)", supportsCategory: false },
];

export const CATEGORIES = {
  daily: "日常",
  tech: "技术",
  info: "情报",
  review: "测评",
  trade: "交易",
  carpool: "拼车",
  dev: "Dev",
  "photo-share": "贴图",
  expose: "曝光",
  sandbox: "沙盒",
};

export const DEFAULT_AI_PROMPT =
  "你是 NodeSeek 论坛的帖子摘要助手。用中文输出 1~2 句话、不超过 80 字，" +
  "概括这个帖子在讲什么、有哪些关键信息，让读者不点开也能知道内容要点。" +
  "不要复述标题，不要客套话，不要 Markdown 标记，不要输出“总结：”之类的前缀。";
