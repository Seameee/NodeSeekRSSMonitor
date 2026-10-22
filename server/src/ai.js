// ============================================================================
// AI 摘要
//
// 每个用户一份独立配置，API Key 从库里解密后仅存活于本次调用。
// 未配置 AI 的用户完全不进入这条路径 —— 零额外开销、零泄漏面。
// ============================================================================
import { createHash } from "node:crypto";
import { DEFAULT_AI_PROMPT, config } from "./config.js";
import { tryDecryptSecret } from "./crypto.js";
import { getAiConfig } from "./db.js";
import { log } from "./logger.js";

// ─── 摘要缓存与上游调用计数 ──────────────────────────────────────────────────
//
// 摘要是「模型链 + 提示词 + 标题 + 正文 + 版块」的纯函数，而多用户下同一条
// 帖子会被 N 个用户各请求一次 —— 实测 200 个用户命中同一条帖时，200 次请求
// 里内容只有 1 种（重复率 99.5%）。这里按内容做有界缓存，把重复的上游调用
// 直接吃掉。
//
// 只缓存**成功**结果：失败不缓存，否则一次上游抖动会把后续请求全挡在缓存外。
// 命中缓存的用户照常计入自己的 AI 配额（口径与不缓存时完全一致）。
const summaryCache = new Map(); // key -> { text, model }
const SUMMARY_CACHE_MAX = 2000;
// 同一内容的在飞请求：拍平之后 N 个用户会在同一瞬间请求同一条帖子，
// 各自独立去请求就变成 N 次一模一样的调用（惊群）。后来者直接等第一个人的结果。
const inflight = new Map(); // key -> Promise<{ text, model } | null>
const aiStats = { upstreamCalls: 0, cacheHits: 0, coalesced: 0 };

export const aiRuntimeStats = () => ({ ...aiStats, cacheSize: summaryCache.size });

export function clearSummaryCache() {
  summaryCache.clear();
}

/** 命中后挪到队尾，否则热条目会被后来的新条目按插入顺序挤出去 */
function touchCache(key, hit) {
  summaryCache.delete(key);
  summaryCache.set(key, hit);
  return { text: hit.text, model: hit.model, cached: true };
}

function rememberSummary(key, hit) {
  if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    // Map 保持插入顺序，第一个键就是最久未使用的
    summaryCache.delete(summaryCache.keys().next().value);
  }
  summaryCache.set(key, hit);
}

/** 缓存键：只要会影响输出内容的输入变了一个字节，就必须是另一个键。
 *  base 也必须进键 —— 不同上游对同名模型给出的答案未必相同，用户既然自己
 *  配了地址，就不该拿到别的上游产出的摘要（同上游的用户之间照常共享）。 */
function summaryCacheKey(cfg, title, body, category) {
  return createHash("sha256")
    .update(String(cfg.base ?? ""))
    .update("\u0000")
    .update(String(cfg.prompt ?? ""))
    .update("\u0000")
    .update(String(cfg.model ?? ""))
    .update("\u0000")
    .update((cfg.fallbackModels || []).join(","))
    .update("\u0000")
    .update(String(category ?? ""))
    .update("\u0000")
    .update(String(title ?? ""))
    .update("\u0000")
    .update(String(body ?? ""))
    .digest("hex");
}

/** 把库里的行转成运行时配置；Key 解密失败返回 null（视为未配置） */
export function resolveAiConfig(row) {
  if (!row || !row.enabled) return null;
  const apiKey = tryDecryptSecret(row.api_key_enc);
  if (!apiKey) {
    log.error("ai", `用户 ${row.telegram_id} 的 API Key 无法解密（主密钥变更？），本用户跳过摘要`);
    return null;
  }
  return {
    telegramId: row.telegram_id,
    base: String(row.base_url || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    key: apiKey,
    model: row.model,
    fallbackModels: String(row.fallback || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    minLen: row.min_len ?? 0,
    maxPerRound: row.max_per_round ?? 5,
    maxTokens: row.max_tokens ?? 4000,
    timeout: row.timeout_ms ?? 15000,
    prompt: row.prompt || DEFAULT_AI_PROMPT,
    enabled: true,
  };
}

export function getRuntimeAiConfig(telegramId) {
  return resolveAiConfig(getAiConfig(telegramId));
}

/** 去掉 HTML 标签、压缩空白并限长，避免把整篇正文塞进模型 */
export function plainText(html, limit = 2000) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** 单次调用某个模型；任何失败返回空串，绝不影响通知发送 */
export async function aiCall(cfg, model, title, body, category) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);
  aiStats.upstreamCalls++;
  try {
    const resp = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: cfg.prompt },
          { role: "user", content: `标题：${title}\n版块：${category}\n正文：\n${body}` },
        ],
        temperature: 0.3,
        max_tokens: cfg.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      log.error("ai", `${model} HTTP ${resp.status}: ${t.slice(0, 160)}`);
      return "";
    }
    const data = await resp.json();
    const out = data?.choices?.[0]?.message?.content;
    if (typeof out !== "string" || !out.trim()) {
      log.error("ai", `${model} 返回内容为空`);
      return "";
    }
    return out.replace(/\s+/g, " ").trim().slice(0, 400);
  } catch (e) {
    log.error("ai", `${model} 调用失败: ${e.message}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** 依次尝试主模型与备用模型，返回 { text, model, cached? } 或 null */
export async function aiSummary(cfg, title, body, category) {
  const key = summaryCacheKey(cfg, title, body, category);

  const cached = summaryCache.get(key);
  if (cached) {
    aiStats.cacheHits++;
    return touchCache(key, cached);
  }

  const pending = inflight.get(key);
  if (pending) {
    // 已经有人为同一份内容在请求上游了，跟着他的结果走，不再打一次
    aiStats.coalesced++;
    return pending;
  }

  const p = (async () => {
    const chain = [...new Set([cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean))];
    for (let i = 0; i < chain.length; i++) {
      const out = await aiCall(cfg, chain[i], title, body, category);
      if (out) {
        const hit = { text: out, model: chain[i] };
        rememberSummary(key, hit);
        return hit;
      }
      if (i < chain.length - 1) {
        log.warn("ai", `模型 ${chain[i]} 失败，回退到 ${chain[i + 1]}`);
      }
    }
    return null; // 失败不进缓存，避免一次上游抖动把后续请求全挡在缓存外
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

/**
 * 校验用户的 AI 配置：URL 形态 + 真实连通性。
 * 用于 /ai test，让用户在保存前就知道 Key/模型对不对。
 */
export async function testAiConfig(cfg) {
  const out = await aiCall(cfg, cfg.model, "连通性测试", "这是一条测试正文。", "测试");
  return out
    ? { ok: true, sample: out }
    : { ok: false, reason: "调用失败，请检查 Base URL、API Key 与模型名（详见服务端日志）" };
}

/** 只允许 http(s)，且禁止指向内网地址（SSRF 防护） */
export function validateBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, reason: "Base URL 不是合法 URL" };
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    return { ok: false, reason: "Base URL 只支持 http/https" };
  }
  const host = u.hostname.toLowerCase();
  const blocked = [
    /^localhost$/,
    /^127\./,
    /^0\./,
    /^10\./,
    /^169\.254\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^\[?::1\]?$/,
    /^\[?fc00:/i,
    /^\[?fd[0-9a-f]{2}:/i, // ULA fd00::/8（此前只挡了 fc00:，fd 段可绕过）
    /^\[?fe80:/i,
    /^\[?::ffff:/i, // IPv4-mapped IPv6
    // CGNAT 100.64.0.0/10：含阿里云 ECS 元数据 100.100.100.200
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
    /\.internal$/,
    /\.localhost$/,
  ];
  if (blocked.some((re) => re.test(host))) {
    return { ok: false, reason: "Base URL 不能指向内网或本机地址" };
  }
  return { ok: true, value: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

/** 校验各项数值参数 */
export function validateAiNumbers({ minLen, maxPerRound, maxTokens, timeoutMs }) {
  const checks = [
    ["AI_MIN_LEN", minLen, 0, 10_000],
    ["AI_MAX_PER_ROUND", maxPerRound, 1, 50],
    ["AI_MAX_TOKENS", maxTokens, 64, 32_000],
    ["AI_TIMEOUT_MS", timeoutMs, 1_000, 120_000],
  ];
  for (const [name, v, lo, hi] of checks) {
    if (v === undefined || v === null) continue;
    if (!Number.isFinite(v) || v < lo || v > hi) {
      return { ok: false, reason: `${name} 必须在 ${lo}~${hi} 之间` };
    }
  }
  return { ok: true };
}

export { config as aiDefaults };
