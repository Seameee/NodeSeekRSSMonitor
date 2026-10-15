// ============================================================================
// 限流与配额
//
// 防滥用的三道闸：
//   1. 命令级：令牌桶，每用户每分钟 N 条，挡住刷屏脚本
//   2. 行为级：绑定冷却、关键词数量上限，挡住「注册即刷」
//   3. 日配额：AI 调用数与推送数，把资源消耗封顶
//
// 全部基于内存令牌桶 + SQLite 日用量，重启后日配额仍准确（用量在库里）。
// ============================================================================
import { config } from "./config.js";
import { effectiveQuota, getUsage, incrUsage, getUser } from "./db.js";
import { log } from "./logger.js";

// ─── 命令令牌桶 ──────────────────────────────────────────────────────────────

const buckets = new Map(); // telegramId -> { tokens, last }

/** 返回 { ok, retryAfterMs } */
export function takeCommandToken(telegramId) {
  const cap = config.commandRatePerMin;
  const nowMs = Date.now();
  let b = buckets.get(telegramId);
  if (!b) {
    b = { tokens: cap, last: nowMs };
    buckets.set(telegramId, b);
  }
  const elapsed = (nowMs - b.last) / 1000;
  b.tokens = Math.min(cap, b.tokens + elapsed * (cap / 60));
  b.last = nowMs;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  const need = (1 - b.tokens) * (60 / cap);
  return { ok: false, retryAfterMs: Math.ceil(need * 1000) };
}

/** 定期清理长时间不活跃的桶，避免内存随用户数无限增长 */
export function pruneBuckets(maxIdleMs = 30 * 60_000) {
  const cutoff = Date.now() - maxIdleMs;
  for (const [id, b] of buckets) {
    if (b.last < cutoff) buckets.delete(id);
  }
}

// ─── 绑定冷却 ────────────────────────────────────────────────────────────────

const lastBindAt = new Map();

export function checkBindCooldown(telegramId) {
  const last = lastBindAt.get(telegramId);
  if (!last) return { ok: true };
  const elapsed = Date.now() - last;
  const need = config.bindCooldownSec * 1000;
  if (elapsed >= need) return { ok: true };
  return { ok: false, retryAfterMs: need - elapsed };
}

export function markBind(telegramId) {
  lastBindAt.set(telegramId, Date.now());
}

// ─── 配额检查 ────────────────────────────────────────────────────────────────

/** 用户是否处于可用状态 */
export function checkUsable(user) {
  if (!user) return { ok: false, reason: "not_bound" };
  if (user.status === "banned") return { ok: false, reason: "banned" };
  if (user.status !== "active") return { ok: false, reason: user.status };
  return { ok: true };
}

/** 还能不能调 AI（按日配额） */
export function checkAiQuota(user) {
  const q = effectiveQuota(user);
  if (q.dailyAi <= 0) return { ok: false, reason: "未授予 AI 配额" };
  const used = getUsage(user.telegram_id).ai_calls;
  if (used >= q.dailyAi) {
    return { ok: false, reason: `今日 AI 配额已用尽（${used}/${q.dailyAi}）` };
  }
  return { ok: true, used, limit: q.dailyAi };
}

/** 还能不能推送（按日配额） */
export function checkPushQuota(user) {
  const q = effectiveQuota(user);
  const used = getUsage(user.telegram_id).pushes;
  if (used >= q.dailyPush) {
    return { ok: false, reason: `今日推送配额已用尽（${used}/${q.dailyPush}）` };
  }
  return { ok: true, used, limit: q.dailyPush, remaining: q.dailyPush - used };
}

export function countAiCall(telegramId, n = 1) {
  incrUsage(telegramId, "ai_calls", n);
}

export function countPush(telegramId, n = 1) {
  incrUsage(telegramId, "pushes", n);
}

export function countCommand(telegramId) {
  incrUsage(telegramId, "commands", 1);
}

/**
 * 配额用尽时给用户的提示（每用户每天只提醒一次，避免刷屏）
 */
const quotaNotified = new Set();
export function shouldNotifyQuota(telegramId, kind) {
  const key = `${telegramId}:${kind}:${new Date().toISOString().slice(0, 10)}`;
  if (quotaNotified.has(key)) return false;
  quotaNotified.add(key);
  if (quotaNotified.size > 10_000) quotaNotified.clear();
  return true;
}

// ─── 全局并发信号量 ──────────────────────────────────────────────────────────

export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiters = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  stats() {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }
}

/** 把数组按并发上限处理，保持返回顺序 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        log.error("mapLimit", `第 ${i} 项失败: ${e.message}`);
        out[i] = undefined;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/** 供管理员统计用 */
export function rateLimitStats() {
  return { users: buckets.size, cooldowns: lastBindAt.size };
}

export { getUser };
