// ============================================================================
// Telegram Bot API 客户端
//
// 多用户下必须自己控速：Bot API 对单聊约 1 msg/s、全局约 30 msg/s，
// 超了会 429 甚至被限制。这里用两层队列：
//   · 全局令牌桶（SEND_RATE_PER_SEC）
//   · 按 chat 串行，保证同一个用户的消息顺序且不超单聊频率
// ============================================================================
import { config } from "./config.js";
import { log } from "./logger.js";

const API = (method) => `https://api.telegram.org/bot${config.telegramToken}/${method}`;

// ─── 全局令牌桶 ──────────────────────────────────────────────────────────────

const tokens = { available: config.sendRatePerSec, last: Date.now() };

async function takeToken() {
  while (true) {
    const nowMs = Date.now();
    const elapsed = (nowMs - tokens.last) / 1000;
    if (elapsed > 0) {
      tokens.available = Math.min(config.sendRatePerSec, tokens.available + elapsed * config.sendRatePerSec);
      tokens.last = nowMs;
    }
    if (tokens.available >= 1) {
      tokens.available -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ─── 按 chat 串行 ────────────────────────────────────────────────────────────

const chatLocks = new Map(); // chatId -> Promise 链尾

function withChatLock(chatId, fn) {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 链尾只用于排队，不保留结果；定期清理避免 Map 无限增长
  chatLocks.set(
    chatId,
    next.catch(() => {})
  );
  next.finally(() => {
    if (chatLocks.get(chatId) === next || chatLocks.size > 5000) chatLocks.delete(chatId);
  });
  return next;
}

// ─── 调用 ────────────────────────────────────────────────────────────────────

/**
 * 调用 Bot API。带指数退避重试；遇 429 会读取 retry_after 并遵守。
 *
 * timeoutMs 是客户端的 abort 时限。**长轮询必须传一个显著大于 Telegram 侧
 * timeout 的值** —— 否则会在服务端返回前抢先 abort，把每次正常空闲轮询都
 * 变成失败重试，期间用户命令全部积压（曾因此出现 30 秒以上的命令延迟）。
 */
export async function tg(method, body, { retries = 3, timeoutMs = 20_000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await takeToken();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(API(method), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const data = await resp.json().catch(() => ({}));

      if (data.ok) return data;

      const retryAfter = data?.parameters?.retry_after;
      if (resp.status === 429 || retryAfter) {
        const wait = Math.min((retryAfter || 1) * 1000 + 200, 30_000);
        log.warn("tg", `${method} 被限流，等待 ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error(`429: ${data.description}`);
        continue;
      }

      // 4xx 属于请求本身有问题，重试无意义。
      // 但必须记下来：这类失败此前是完全静默的，症状是"发命令没反应"却查不到
      // 任何线索（例如正文里有个非法标签会被 400 拒收，或命令描述字数不达标）。
      if (resp.status >= 400 && resp.status < 500) {
        log.warn("tg", `${method} 被拒绝（HTTP ${resp.status}）: ${data.description || "无描述"}`);
        return data;
      }
      lastErr = new Error(`${resp.status}: ${data.description || "未知错误"}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  log.error("tg", `${method} 最终失败: ${lastErr?.message}`);
  return { ok: false, description: lastErr?.message || "未知错误" };
}

/** 发纯文本消息（带 HTML），失败重试由 tg 内部处理 */
export async function sendMessage(chatId, text, opts = {}) {
  return withChatLock(chatId, () =>
    tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: opts.preview !== true },
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      ...(opts.disableNotification ? { disable_notification: true } : {}),
    })
  );
}

/**
 * 发富文本消息。返回 true 表示成功；失败交由调用方降级为 sendMessage。
 *
 * 刻意不重试：这条路径本身就有经典 HTML 兜底，重试只会白等退避时间
 * 并占用全局限流额度。失败一次立刻让上层降级，用户更快拿到通知。
 */
export async function sendRichMessage(chatId, html) {
  return withChatLock(chatId, async () => {
    const r = await tg("sendRichMessage", { chat_id: chatId, rich_message: { html } }, { retries: 0 });
    return r.ok === true;
  });
}

/**
 * 并发发送多条（不同 chat 之间并行，同一 chat 由锁串行）。
 * limit 控制同时在飞的请求数。
 */
export async function sendMany(items, limit = config.sendConcurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await items[i].run();
      } catch (e) {
        results[i] = { ok: false, description: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Telegram 侧长轮询秒数 */
export const POLL_TIMEOUT_SEC = 25;

/**
 * 长轮询客户端超时 = Telegram 侧 timeout + 15 秒余量。
 * 这个余量是必须的：相等或更短会让空闲轮询永远以 abort 收场（历史 bug）。
 */
export const getUpdatesTimeoutMs = (timeoutSec = POLL_TIMEOUT_SEC) => (timeoutSec + 15) * 1000;

/**
 * 长轮询。
 *
 * 刻意不重试：长轮询"超时后返回空结果"是**成功路径**，不该被当成错误反复
 * 重试；真出错（网络/409）时立即返回，由 index.js 的循环统一退避——那一层
 * 才会更新 offset、也才知道什么时候该退避多久。
 */
export const getUpdates = (offset, timeoutSec = POLL_TIMEOUT_SEC) =>
  tg(
    "getUpdates",
    { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
    { retries: 0, timeoutMs: getUpdatesTimeoutMs(timeoutSec) }
  );

export const setMyCommands = (commands) => tg("setMyCommands", { commands });

export const deleteWebhook = () => tg("deleteWebhook", { drop_pending_updates: false }, { retries: 1 });
