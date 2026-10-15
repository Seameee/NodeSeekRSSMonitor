// ============================================================================
// 日志：轻量结构化输出，带级别过滤与敏感字段脱敏
// ============================================================================
import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** 避免把密钥写进日志：截断并按模式打码 */
export function redact(value) {
  let s = String(value ?? "");
  // 常见密钥形态
  s = s.replace(/\b(sk|ghp|cfut|xoxb|Bearer)[-_A-Za-z0-9]{8,}/g, "$1-***");
  s = s.replace(/([?&](?:token|key|api_key|apikey|password)=)[^&\s]+/gi, "$1***");
  if (s.length > 500) s = s.slice(0, 500) + "…";
  return s;
}

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${tag ? `[${tag}] ` : ""}${redact(msg)}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (extra !== undefined) {
    stream.write(`${line} ${redact(typeof extra === "string" ? extra : JSON.stringify(extra))}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  debug: (tag, msg, extra) => emit("debug", tag, msg, extra),
  info: (tag, msg, extra) => emit("info", tag, msg, extra),
  warn: (tag, msg, extra) => emit("warn", tag, msg, extra),
  error: (tag, msg, extra) => emit("error", tag, msg, extra),
};
