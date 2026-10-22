// ============================================================================
// 勿扰模式：按用户暂停推送 + 补看
//
// 核心约定（这些是需求本身，不是实现细节）：
//   1. 勿扰 = **完全不发消息**，而不是「静音发送」。
//      原因：Bot API 的 disable_notification 只做到「通知无声」，
//      消息照样弹进通知栏。用户实测确认后要求改成完全不发。
//      而「只显示灰色圆点、不进未读」是 Telegram 账号级的 chat 静音设置，
//      Bot API 无权限修改接收方聊天状态，任何 bot 都做不到。
//   2. 每个用户各自判定，A 暂停不影响 B；
//   3. 期间命中的帖子必须落库，否则就真丢了（/dnd backlog 要靠它）；
//   4. 命令回复不受影响 —— 动作用户自己发的，要能看到回执。
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

// ─── 端到端：勿扰期间是否真的「不发送」 ─────────────────────────────────────

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

/** 跑一轮，收集实际发出的 Telegram 请求 */
async function roundCapture(rssXml) {
  const captured = [];
  const inner = installFetchMock({ rssXml });
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const m = u.split("/").pop();
      const body = init.body ? JSON.parse(init.body) : {};
      if (m === "sendMessage" || m === "sendRichMessage") {
        captured.push({
          chatId: body.chat_id,
          method: m,
          silent: body.disable_notification === true,
          text: body.text || body.rich_message?.html || "",
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

test("勿扰：该用户**完全不发消息**（不是静音发送）", async () => {
  seedUser(A);
  db.setDndAlways(A);

  const { captured } = await roundCapture(makeRss(posts(2)));
  const mine = captured.filter((c) => c.chatId === A);
  assert.equal(mine.length, 0, `勿扰期间不应发出任何消息（实际 ${mine.length} 条）`);
});

test("勿扰：命中仍要落库，否则真的丢了", async () => {
  seedUser(A);
  db.setDndAlways(A);
  const before = db.countMutedHits(A, new Date(Date.now() - 600_000).toISOString());

  const { captured } = await roundCapture(makeRss(posts(3)));
  assert.equal(captured.filter((c) => c.chatId === A).length, 0, "不发消息");

  const since = new Date(Date.now() - 600_000).toISOString();
  const after = db.countMutedHits(A, since);
  assert.equal(after - before, 3, `应记录 3 条被拦下的命中（实际 ${after - before}）`);

  const hits = db.getMutedHits(A, since, 10);
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.title.includes("绿云")), "记录里应包含标题供补看");
});

test("勿扰：只拦该用户，其他用户照常收到", async () => {
  seedUser(A);
  seedUser(B);
  db.setDndAlways(A); // 只暂停 A

  const { captured } = await roundCapture(makeRss(posts(2)));
  const toA = captured.filter((c) => c.chatId === A);
  const toB = captured.filter((c) => c.chatId === B);

  assert.equal(toA.length, 0, "A 不应收到任何消息");
  assert.equal(toB.length, 2, `B 应照常收到 2 条（实际 ${toB.length}）`);
  assert.ok(toB.every((c) => c.silent === false), "B 的消息不应被静音");
});

test("勿扰关闭后恢复推送，且不会重复推已拦下的旧命中", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundCapture(makeRss(posts(2)));
  assert.equal(db.countMutedHits(A, new Date(Date.now() - 600_000).toISOString()), 2);

  // 关闭勿扰后，同一批帖子已在勿扰期间被标记已见，不应再推
  db.clearDnd(A);
  const { captured } = await roundCapture(makeRss(posts(2)));
  assert.equal(
    captured.filter((c) => c.chatId === A).length,
    0,
    "同一批帖子不该因关闭勿扰而重新推送"
  );

  // 新帖则应正常推送
  const { captured: fresh } = await roundCapture(makeRss(posts(2, 980000)));
  assert.equal(fresh.filter((c) => c.chatId === A).length, 2, "恢复后新帖应正常推送");
});

test("勿扰期间不消耗 AI 摘要（消息都不发，摘要没人看还要花钱）", async () => {
  seedUser(A);
  db.setDndAlways(A);
  const cfg = {
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnc: "x",
    apiKeyHint: "hint",
    model: "deepseek-chat",
  };
  db.upsertAiConfig(A, cfg);

  const { captured } = await roundCapture(makeRss(posts(2)));
  assert.equal(captured.filter((c) => c.chatId === A).length, 0, "不发消息");
  assert.equal(db.getUsage(A).ai_calls, 0, "勿扰期间不该产生 AI 调用");
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
  assert.match(html, /定时暂停/);
  const u = db.getUser(A);
  assert.equal(u.dnd_mode, "until");
  assert.ok(Date.parse(u.dnd_until) > Date.now(), "到期时间应在将来");
  assert.equal(dnd.isDndActive(u), true);
});

test("/dnd 23:00-08:00：写入 window 并保存时段", async () => {
  const html = await say("/dnd 23:00-08:00");
  assert.match(html, /每日暂停时段/);
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
  assert.match(html, /未开启/);

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
  assert.match(html, /暂停推送中/);
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

// ─── /dnd backlog 补看 ───────────────────────────────────────────────────────

test("/dnd backlog：列出勿扰期间拦下的帖子，含标题与链接", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundCapture(makeRss(posts(3)));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd backlog", { id: A }));
  const html = sent.at(-1)?.html ?? "";

  assert.match(html, /错过 3 条/, `应显示错过 3 条，实际：${html.slice(0, 120)}`);
  assert.match(html, /绿云 第 1 号/);
  assert.match(html, /绿云 第 3 号/);
  assert.match(html, /https:\/\/www\.nodeseek\.com\/post-/, "应带原帖链接");
});

test("/dnd backlog：没有错过时明确说明，而不是空消息", async () => {
  seedUser(A);
  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd backlog", { id: A }));
  const html = sent.at(-1)?.html ?? "";
  assert.match(html, /没有错过/);
});

test("/dnd backlog --clear：清空补看记录后不再列出", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundCapture(makeRss(posts(2)));
  assert.equal(db.countMutedHits(A, new Date(Date.now() - 600_000).toISOString()), 2);

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd backlog --clear", { id: A }));
  assert.match(sent.at(-1)?.html ?? "", /已清空/);

  // 清空的是锚点，历史记录还在；下次补看应从新锚点起算，不该再列出旧的
  const { sent: s2 } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd backlog", { id: A }));
  const html = s2.at(-1)?.html ?? "";
  assert.match(html, /没有错过/, `清空后应看不到旧记录，实际：${html.slice(0, 120)}`);
});

test("/dnd 状态里提示错过了多少条", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundCapture(makeRss(posts(2)));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd", { id: A }));
  const html = sent.at(-1)?.html ?? "";
  assert.match(html, /暂停推送中/);
  assert.match(html, /错过<\/b>：2 条|错过\S*2 条/, `应提示错过 2 条，实际：${html.slice(0, 200)}`);
});

test("/dnd off 时提示还有多少条可补看", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundCapture(makeRss(posts(2)));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd off", { id: A }));
  const html = sent.at(-1)?.html ?? "";
  assert.match(html, /恢复/);
  assert.match(html, /2 条/, "应提示错过 2 条可补看");
});

test("/history 不显示勿扰拦下的帖子（它们从未发出，不能算推送过）", async () => {
  seedUser(A);
  db.setDndAlways(A);
  await roundCapture(makeRss(posts(3)));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/history", { id: A }));
  const html = sent.at(-1)?.html ?? "";
  assert.match(html, /暂无推送记录/, `勿扰期间没推送过，/history 应为空，实际：${html.slice(0, 150)}`);

  // 但补看能拿到
  const { sent: s2 } = installFetchMock();
  await router.handleUpdate(makeUpdate("/dnd backlog", { id: A }));
  assert.match(s2.at(-1)?.html ?? "", /错过 3 条/);
});
