// ============================================================================
// 勿扰模式（Do Not Disturb）
//
// 需求：每个用户能独立地把推送「静音」一段时间，而不是干脆收不到。
//
// 为什么用静音而不是暂停推送：
//   Bot API 的 disable_notification 是**按消息**生效的参数，而每个用户收到的是
//   各自独立的消息 —— 所以「按用户静音」天然成立，不需要退回「暂停推送」。
//   两者差别很实际：暂停推送 = 完全看不到，事后要自己回 /history 翻；
//   静音 = 消息照常送达，只是不响铃、不振动。
//   实测官方文档确认 sendMessage 与 sendRichMessage 都支持该参数。
//
// 三种开启方式：
//   until  —— 静音到某个时间点（/dnd 2h），到点自动恢复
//   window —— 每天固定时段（/dnd 23:00-08:00），按用户时区解释
//   on     —— 一直静音，直到 /dnd off
//
// 时区必须单独存：每日窗口指的是「用户本地时钟的 23:00」，而容器里一般是
// UTC。直接拿 UTC 比较会让窗口整体偏移 8 小时，用户完全无法预期。
// ============================================================================
import { config } from "./config.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** 单次静音上限：30 天。允许更大的值基本只可能是手滑（例如把小时当分钟）。 */
export const MAX_DND_MS = 30 * DAY_MS;

/** 最小静音时长：1 分钟。小于这个值没有意义，多半是解析错了。 */
const MIN_DND_MS = MINUTE_MS;

// ─── 时区 ────────────────────────────────────────────────────────────────────

const fmtCache = new Map();

/** 缓存 Intl 实例：轮询时每个用户每轮都要算一次当前时刻，不要重复构造。 */
function minuteFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** 时区字符串是否被运行环境认识（IANA 名称，如 Asia/Shanghai） */
export function isValidTimezone(tz) {
  const s = String(tz || "").trim();
  if (!s || s.length > 64) return false;
  // 只允许字母数字与常见分隔符，避免把奇怪的东西塞进 Intl
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(s)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

/** 某个时刻在指定时区是「当天的第几分钟」（0 ~ 1439） */
export function minutesOfDay(ms, tz) {
  const parts = minuteFormatter(tz).formatToParts(new Date(ms));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value) % 24;
    else if (p.type === "minute") m = Number(p.value);
  }
  return h * 60 + m;
}

/** 把时刻按用户时区格式化成「10-23 08:00」，用于回复文案 */
export function formatInTz(ms, tz) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(ms))
      .replace(/\//g, "-");
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
  }
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");

/** "8:00" / "08:00" → 480；非法返回 null */
export function parseHm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 时长：90m / 2h / 1.5h / 8小时 / 45分钟 / 1d。
 * 不带单位按分钟理解（`/dnd 90` = 90 分钟）—— 这是最不容易误读的默认。
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|分|分钟|h|hr|hrs|hour|hours|小时|时|d|day|days|天)?$/i.exec(
    String(text || "").trim()
  );
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "m").toLowerCase();
  let ms;
  if (["m", "min", "mins", "minute", "minutes", "分", "分钟"].includes(unit)) ms = n * MINUTE_MS;
  else if (["h", "hr", "hrs", "hour", "hours", "小时", "时"].includes(unit)) ms = n * 60 * MINUTE_MS;
  else ms = n * DAY_MS;
  if (ms < MIN_DND_MS || ms > MAX_DND_MS) return null;
  return ms;
}

/** "23:00-08:00" / "23:00~8:00" / "23:00 至 08:00" → { start, end } */
export function parseWindow(text) {
  const m = /^(\d{1,2}:\d{2})\s*(?:-|~|～|—|–|至|到)\s*(\d{1,2}:\d{2})$/.exec(
    String(text || "").trim()
  );
  if (!m) return null;
  const start = parseHm(m[1]);
  const end = parseHm(m[2]);
  if (start === null || end === null) return null;
  // 起止相同代表「整整 24 小时」还是「没设」，两种解释都合理 —— 干脆拒收，
  // 让用户用 /dnd on 表达「一直静音」，语义没有歧义。
  if (start === end) return null;
  return { start: `${pad2(Math.floor(start / 60))}:${pad2(start % 60)}`, end: `${pad2(Math.floor(end / 60))}:${pad2(end % 60)}` };
}

// ─── 判定 ────────────────────────────────────────────────────────────────────

export const DND_MODES = new Set(["off", "on", "until", "window"]);

/** 该用户的生效时区（没设过就用实例默认） */
export function tzOf(user) {
  return user?.dnd_tz || config.dndTimezone;
}

/**
 * 当前是否处于勿扰时段。
 *
 * 这是纯函数（只读 user 行 + 当前时间），所以可以在轮询里对每个用户直接调用，
 * 也可以被命令层用来渲染状态 —— 两处判定必然一致。
 */
export function isDndActive(user, nowMs = Date.now()) {
  const mode = user?.dnd_mode || "off";
  if (mode === "off") return false;
  if (mode === "on") return true;

  if (mode === "until") {
    const until = Date.parse(user?.dnd_until || "");
    return Number.isFinite(until) && nowMs < until;
  }

  if (mode === "window") {
    const s = parseHm(user?.dnd_start);
    const e = parseHm(user?.dnd_end);
    if (s === null || e === null || s === e) return false;
    let cur;
    try {
      cur = minutesOfDay(nowMs, tzOf(user));
    } catch {
      return false;
    }
    // 跨零点（23:00-08:00）时必须用「或」，否则凌晨那几个小时会被判成不静音
    return s < e ? cur >= s && cur < e : cur >= s || cur < e;
  }

  return false;
}

/**
 * 下一次「状态翻转」的时刻（毫秒时间戳）。
 * off / on 不会自动翻转 → null；until 到期即翻转；window 是时段边界。
 */
export function nextChangeMs(user, nowMs = Date.now()) {
  const mode = user?.dnd_mode || "off";
  if (mode === "until") {
    const until = Date.parse(user?.dnd_until || "");
    return Number.isFinite(until) && until > nowMs ? until : null;
  }
  if (mode === "window") {
    const s = parseHm(user?.dnd_start);
    const e = parseHm(user?.dnd_end);
    if (s === null || e === null || s === e) return null;
    let cur;
    try {
      cur = minutesOfDay(nowMs, tzOf(user));
    } catch {
      return null;
    }
    const active = isDndActive(user, nowMs);
    let delta = active ? (e - cur + 1440) % 1440 : (s - cur + 1440) % 1440;
    if (delta === 0) delta = 1440;
    return nowMs + delta * MINUTE_MS;
  }
  return null;
}
