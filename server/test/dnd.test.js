// ============================================================================
// 勿扰模式：按用户独立静音推送
//
// 核心约定（这些是需求本身，不是实现细节）：
//   1. 静音 = 消息照常送达 + disable_notification，**不是**停止推送；
//   2. 每个用户各自判定，A 静音不影响 B；
//   3. 只静音推送，命令回复照常响 —— 否则用户会以为命令没生效；
//   4. 静音状态必须落到富文本、降级经典、溢出汇总三条发送路径上，
//      否则「恰好降级的那一条」会在勿扰期间突然响起来。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeRss, makeUpdate, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const poller = await import("../src/poller.js");
const router = await import("../src/router.js");
const dnd = await import("../src/dnd.js");

test.after(async () => {
  await teardown();
});

// ─── 纯逻辑：解析 ────────────────────────────────────────────────────────────

test("时长解析：2h / 90m / 1d / 中英文单位", () => {
  assert.equal(dnd.parseDuration("2h"), 2 * 3600_000);
  assert.equal(dnd.parseDuration("90m"), 90 * 60_000);
  assert.equal(dnd.parseDuration("1d"), 86_400_000);
  assert.equal(dnd.parseDuration("1.5h"), 5400_000);
  assert.equal(dnd.parseDuration("8小时"), 8 * 3600_000);
  assert.equal(dnd.parseDuration("45分钟"), 45 * 60_000);
  // 不带单位按分钟
  assert.equal(dnd.parseDuration("30"), 30 * 60_000);
});

test("时长解析：拒绝 0、负数、超上限", () => {
  assert.equal(dnd.parseDuration("0"), null);
  assert.equal(dnd.parseDuration("-5"), null);
  assert.equal(dnd.parseDuration("0.1m"), null, "小于 1 分钟应拒收");
  assert.equal(dnd.parseDuration("31d"), null, "超过 30 天上限应拒收");
  assert.equal(dnd.parseDuration("abc"), null);
  assert.equal(dnd.parseDuration(""), null);
});

test("时段解析：多种分隔符，且起止相同要拒收", () => {
  assert.deepEqual(dnd.parseWindow("23:00-08:00"), { start: "23:00", end: "08:00" });
  assert.deepEqual(dnd.parseWindow("23:00~8:00"), { start: "23:00", end: "08:00" });
  assert.deepEqual(dnd.parseWindow("1:00 至 6:00"), { start: "01:00", end: "06:00" });
  assert.deepEqual(dnd.parseWindow("22:00-7:30"), { start: "22:00", end: "07:30" });
  // 补零：8:00 要存成 08:00，否则后面按字符串展示会不一致
  assert.deepEqual(dnd.parseWindow("9:05-18:00"), { start: "09:05", end: "18:00" });
  assert.equal(dnd.parseWindow("23:00-23:00"), null, "起止相同语义歧义，拒收");
  assert.equal(dnd.parseWindow("25:00-08:00"), null);
  assert.equal(dnd.parseWindow("abc"), null);
});

test("时区校验：认 IANA 名称，拒收乱填", () => {
  assert.equal(dnd.isValidTimezone("Asia/Shanghai"), true);
  assert.equal(dnd.isValidTimezone("UTC"), true);
  assert.equal(dnd.isValidTimezone("Europe/London"), true);
  assert.equal(dnd.isValidTimezone("Mars/Olympus"), false);
  assert.equal(dnd.isValidTimezone(""), false);
  assert.equal(dnd.isValidTimezone("Asia/Shanghai; rm -rf /"), false);
});

// ─── 纯逻辑：判定 ────────────────────────────────────────────────────────────

test("until：到期前静音，到期后自动恢复", () => {
  const now = Date.now();
  const u = { dnd_mode: "until", dnd_until: new Date(now + 60_000).toISOString() };
  assert.equal(dnd.isDndActive(u, now), true);
  // 到期那一刻起就不再静音 —— 需求是「结束时关闭静音」
  assert.equal(dnd.isDndActive(u, now + 60_000), false);
  assert.equal(dnd.isDndActive(u, now + 120_000), false);
});

test("window：普通时段与**跨零点**时段都正确", () => {
  // 用一个固定时刻配合指定时区来断言，避免依赖运行机器的本地时区
  const tz = "Asia/Shanghai";
  const base = { dnd_mode: "window", dnd_start: "09:00", dnd_end: "18:00", dnd_tz: tz };
  // 2026-10-22 10:00 +08:00
  const at10 = Date.parse("2026-10-22T10:00:00+08:00");
  const at20 = Date.parse("2026-10-22T20:00:00+08:00");
  assert.equal(dnd.isDndActive(base, at10), true);
  assert.equal(dnd.isDndActive(base, at20), false);
  // 边界：起点含、终点不含
  assert.equal(dnd.isDndActive(base, Date.parse("2026-10-22T09:00:00+08:00")), true);
  assert.equal(dnd.isDndActive(base, Date.parse("2026-10-22T18:00:00+08:00")), false);

  // 跨零点：23:00-08:00 —— 凌晨 2 点必须算静音，这是最容易写错的一类
  const night = { dnd_mode: "window", dnd_start: "23:00", dnd_end: "08:00", dnd_tz: tz };
  assert.equal(dnd.isDndActive(night, Date.parse("2026-10-22T23:30:00+08:00")), true);
  assert.equal(dnd.isDndActive(night, Date.parse("2026-10-23T02:00:00+08:00")), true);
  assert.equal(dnd.isDndActive(night, Date.parse("2026-10-23T07:59:00+08:00")), true);
  assert.equal(dnd.isDndActive(night, Date.parse("2026-10-23T08:00:00+08:00")), false);
  assert.equal(dnd.isDndActive(night, Date.parse("2026-10-23T12:00:00+08:00")), false);
});

test("window：同一时刻在不同时区判定不同（时区必须真的生效）", () => {
  // 同一瞬间：上海 10-23 07:00 = 东京 10-23 08:00
  const instant = Date.parse("2026-10-22T23:00:00Z");
  const night = (tz) => ({ dnd_mode: "window", dnd_start: "23:00", dnd_end: "08:00", dnd_tz: tz });
  assert.equal(dnd.isDndActive(night("Asia/Shanghai"), instant), true, "上海 07:00 仍静音");
  assert.equal(dnd.isDndActive(night("Asia/Tokyo"), instant), false, "东京 08:00 已结束");
});

test("off / on 的判定是恒定的", () => {
  assert.equal(dnd.isDndActive({ dnd_mode: "off" }), false);
  assert.equal(dnd.isDndActive({ dnd_mode: "on" }), true);
  assert.equal(dnd.isDndActive({}), false, "缺字段当关闭处理");
  assert.equal(dnd.isDndActive(null), false);
});

test("window 的 nextChangeMs 指向下一次翻转点", () => {
  const night = { dnd_mode: "window", dnd_start: "23:00", dnd_end: "08:00", dnd_tz: "Asia/Shanghai" };
  // 静音中（02:00）→ 下一次翻转是当天 08:00
  const at2 = Date.parse("2026-10-23T02:00:00+08:00");
  assert.equal(dnd.nextChangeMs(night, at2), Date.parse("2026-10-23T08:00:00+08:00"));
  // 未静音（12:00）→ 下一次是晚上 23:00
  const at12 = Date.parse("2026-10-23T12:00:00+08:00");
  assert.equal(dnd.nextChangeMs(night, at12), Date.parse("2026-10-23T23:00:00+08:00"));
});

// ─── 端到端：推送是否真的被静音 ──────────────────────────────────────────────

const A = 9200;
const B = 9201;

function seedUser(id, keyword = "绿云") {
  db.deleteUser(id);
  db.createUser({ telegramId: id, username: `u${id}` });
  db.addKeyword(id, keyword, null, "substring");
  poller.invalidateKeywordCache(id);
  return id;
}

const posts = (n, idBase = 970000) =>
  Array.from({ length: n }, (_, i) => ({
    id: idBase + i,
    title: `【出】绿云 第 ${i + 1} 号`,
    category: "trade",
    content: "正文内容",
  }));

/**
 * 跑一轮并把「发给该用户的消息」连同静音标记一起取出来。
 * helpers 的 mock 目前只记录 html，这里补一层包装来观测 disable_notification。
 */
async function roundWithSilentObserver() {
  const captured = [];
  const inner = installFetchMock({ rssXml: makeRss(posts(2)) });
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      const body = init.body ? JSON.parse(init.body) : {};
      if (method === "sendMessage" || method === "sendRichMessage") {
        captured.push({
          chatId: body.chat_id,
          method,
          silent: body.disable_notification === true,
        });
      }
    }
    return wrapped(url, init);
  };
  try {
    await poller.runRound();
  } finally {
    globalThis.fetch = wrapped;
  }
  return { captured, sent: inner.sent };
}

test("推送：该用户开启勿扰 → 消息带 disable_notification 且内容照常送达", async () => {
  seedUser(A);
  db.setDndAlways(A);

  const { captured, sent } = await roundWithSilentObserver();
  const mine = captured.filter((c) => c.chatId === A);
  assert.ok(mine.length >= 1, "应当仍然发送了消息（静音 ≠ 不推送）");
  assert.ok(mine.every((c) => c.silent === true), "每条都应带 disable_notification");

  // 内容必须真的送到了 —— 这是「静音而非暂停」的关键证据
  const delivered = sent.filter((m) => m.chatId === A);
  assert.equal(delivered.length, 2, "2 条命中应照常送达 2 条消息");
  assert.ok(delivered.some((m) => m.html.includes("第 1 号")));
});

test("推送：未开启勿扰的用户不受影响，且与静音用户互不干扰", async () => {
  seedUser(A);
  seedUser(B);
  db.setDndAlways(A); // 只静音 A

  const { captured } = await roundWithSilentObserver();
  const toA = captured.filter((c) => c.chatId === A);
  const toB = captured.filter((c) => c.chatId === B);

  assert.ok(toA.length > 0 && toB.length > 0);
  assert.ok(toA.every((c) => c.silent === true), "A 全静音");
  assert.ok(toB.every((c) => c.silent === false), "B 不应被静音（按用户独立）");
});

test("推送：勿扰关闭后恢复响铃", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundWithSilentObserver();

  db.clearDnd(A);
  // 换一批新帖，确保真的有新推送
  const inner = installFetchMock({ rssXml: makeRss(posts(2, 980000)) });
  globalThis.fetch = (() => {
    const base = globalThis.fetch;
    return async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (String(url).includes("sendRichMessage")) {
        inner.__last = body;
      }
      return base(url, init);
    };
  })();
  await poller.runRound();
  assert.equal(inner.__last?.disable_notification, undefined, "恢复正常后不应带静音参数");
});

test("推送：富文本失败降级时，静音标记必须跟着走到经典格式", async () => {
  // 这是真实的风险点：勿扰期间恰好降级的那一条会突然响，用户会觉得勿扰没生效
  seedUser(A);
  db.setDndAlways(A);

  const captured = [];
  const inner = installFetchMock({ rssXml: makeRss(posts(2)), failRich: true });
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.includes("sendMessage")) {
      captured.push({ chatId: body.chat_id, silent: body.disable_notification === true });
    }
    return wrapped(url, init);
  };
  try {
    await poller.runRound();
  } finally {
    globalThis.fetch = wrapped;
  }

  const mine = captured.filter((c) => c.chatId === A);
  assert.ok(mine.length >= 1, "降级后应当有 sendMessage 发出");
  assert.ok(mine.every((c) => c.silent === true), "降级路径也必须带静音");
});

// ─── 命令层 ──────────────────────────────────────────────────────────────────

const say = async (text, id = A) => {
  seedUser(id);
  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate(text, { id }));
  return sent.at(-1)?.html ?? "";
};

test("/dnd 2h：写入 until 且回复里说明会自动恢复", async () => {
  const html = await say("/dnd 2h");
  assert.match(html, /定时静音/);
  const u = db.getUser(A);
  assert.equal(u.dnd_mode, "until");
  assert.ok(Date.parse(u.dnd_until) > Date.now(), "到期时间应在将来");
  assert.equal(dnd.isDndActive(u), true);
});

test("/dnd 23:00-08:00：写入 window 并保存时段", async () => {
  const html = await say("/dnd 23:00-08:00");
  assert.match(html, /每日静音时段/);
  const u = db.getUser(A);
  assert.equal(u.dnd_mode, "window");
  assert.equal(u.dnd_start, "23:00");
  assert.equal(u.dnd_end, "08:00");
});

test("/dnd on 与 /dnd off 互转，且改模式时不残留旧字段", async () => {
  await say("/dnd 2h");
  assert.equal(db.getUser(A).dnd_mode, "until");

  await say("/dnd on");
  const on = db.getUser(A);
  assert.equal(on.dnd_mode, "on");
  assert.equal(on.dnd_until, null, "切到 on 后不该残留 until 的到期时间");

  await say("/dnd off");
  const off = db.getUser(A);
  assert.equal(off.dnd_mode, "off");
  assert.equal(off.dnd_start, null);
  assert.equal(off.dnd_end, null);
  assert.equal(dnd.isDndActive(off), false);
});

test("/dnd tz：合法时区被保存，非法时区被拒收", async () => {
  // 注意：这两次调用必须**保持同一个用户**，否则测不到「非法值不覆盖原值」
  seedUser(A);
  const again = async (text) => {
    const { sent } = installFetchMock();
    await router.handleUpdate(makeUpdate(text, { id: A }));
    return sent.at(-1)?.html ?? "";
  };

  let html = await again("/dnd tz Asia/Tokyo");
  assert.match(html, /时区已设为/);
  assert.equal(db.getUser(A).dnd_tz, "Asia/Tokyo");

  html = await again("/dnd tz Mars/Olympus");
  assert.match(html, /无法识别的时区/);
  assert.equal(db.getUser(A).dnd_tz, "Asia/Tokyo", "非法值不应覆盖原值");
});

test("/dnd：无参数时展示状态；无法识别的参数给出用法", async () => {
  let html = await say("/dnd");
  assert.match(html, /未静音/);

  html = await say("/dnd 完全不是时长");
  assert.match(html, /无法识别/);
  assert.match(html, /\/dnd 2h/, "应提示正确用法");
});

test("/status 会显示勿扰状态", async () => {
  seedUser(A);
  db.setDndAlways(A);
  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/status", { id: A }));
  const html = sent.at(-1)?.html ?? "";
  assert.match(html, /勿扰模式/);
  assert.match(html, /静音中/);
});

test("命令回复不被静音：勿扰期间发 /dnd 仍正常响铃", async () => {
  // 需求是「通知静音」，但用户主动操作的回执必须能看见/听见，
  // 否则会误以为命令没生效而反复发送。
  seedUser(A);
  db.setDndAlways(A);

  const captured = [];
  const inner = installFetchMock();
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (String(url).includes("sendMessage")) {
      captured.push({ chatId: body.chat_id, silent: body.disable_notification === true });
    }
    return wrapped(url, init);
  };
  try {
    await router.handleUpdate(makeUpdate("/dnd", { id: A }));
  } finally {
    globalThis.fetch = wrapped;
  }
  const mine = captured.filter((c) => c.chatId === A);
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((c) => c.silent === false), "命令回复不应被静音");
});
