// ============================================================================
// AI 摘要
//
// 每个用户一份独立配置，API Key 从库里解密后仅存活于本次调用。
// 未配置 AI 的用户完全不进入这条路径 —— 零额外开销、零泄漏面。
// ============================================================================
import { DEFAULT_AI_PROMPT, config } from "./config.js";
import { tryDecryptSecret } from "./crypto.js";
import { getAiConfig } from "./db.js";
import { log } from "./logger.js";

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

/** 依次尝试主模型与备用模型，返回 { text, model } 或 null */
export async function aiSummary(cfg, title, body, category) {
  const chain = [...new Set([cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean))];
  for (let i = 0; i < chain.length; i++) {
    const out = await aiCall(cfg, chain[i], title, body, category);
    if (out) return { text: out, model: chain[i] };
    if (i < chain.length - 1) {
      log.warn("ai", `模型 ${chain[i]} 失败，回退到 ${chain[i + 1]}`);
    }
  }
  return null;
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
