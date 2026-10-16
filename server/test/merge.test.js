// ============================================================================
// 推送合并：同一用户本轮的多条命中合成尽量少的几条消息
//
// 背景：发送是整轮里唯一躲不掉的串行瓶颈（全局令牌桶 20 条/秒，实测 200 条
// 要 9.9 秒），而 Telegram 对单聊约 1 msg/s —— 一个用户命中 10 条不仅占掉 10 条
// 配额，还会因为单聊限速吃 429、退避重试，把整轮拖长。
//
// 但也要钉住两件不能变的事：
//   · 只命中 1 条时，消息必须与合并前**完全一致**（常见情况不能有观感变化）；
//   · 配额仍然按「交付的帖子条数」计，不能因为合并就悄悄放宽。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeRss, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const poller = await import("../src/poller.js");
const notify = await import("../src/notify.js");

test.after(async () => {
  await teardown();
});

const U = 9100;
function freshUser(id = U, keyword = "绿云") {
  db.deleteUser(id);
  db.createUser({ telegramId: id, username: `u${id}` });
  db.addKeyword(id, keyword, null, "substring");
  poller.invalidateKeywordCache(id);
  return id;
}

const posts = (n, idBase = 960000) =>
  Array.from({ length: n }, (_, i) => ({
    id: idBase + i,
    title: `【出】绿云 第 ${i + 1} 号 年付 20 美元`,
    category: "trade",
    content: "正文内容",
  }));

test("合并：命中 5 条只发 1 条消息，且 5 条都在里面", async () => {
  const uid = freshUser();
  const mock = installFetchMock({ rssXml: makeRss(posts(5)) });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1, `5 条命中应合并成 1 条消息（实际 ${msgs.length}）`);
  for (let i = 1; i <= 5; i++) {
    assert.match(msgs[0].html, new RegExp(`第 ${i} 号`), `第 ${i} 条应在合并消息里`);
  }
});

test("合并：配额仍按帖子条数计，不因合并而放宽", async () => {
  const uid = freshUser();
  const mock = installFetchMock({ rssXml: makeRss(posts(4)) });
  await poller.runRound();

  assert.equal(mock.sent.filter((m) => m.chatId === uid).length, 1, "4 条命中只发 1 条消息");
  assert.equal(db.getUsage(uid).pushes, 4, `用量应按 4 条帖子计（实际 ${db.getUsage(uid).pushes}）`);
});

test("合并：只命中 1 条时，消息与单帖格式逐字节一致", async () => {
  const uid = freshUser();
  const mock = installFetchMock({ rssXml: makeRss(posts(1)) });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1);
  const post = {
    post_id: 960000,
    title: "【出】绿云 第 1 号 年付 20 美元",
    link: "https://www.nodeseek.com/post-960000-1",
    category: "trade",
    author: "alice",
    source: 0,
  };
  assert.equal(
    msgs[0].html,
    notify.buildRichNotifMsg(post, ["绿云"], null),
    "单条命中必须仍走原来的单帖消息，不能变成合并格式"
  );
});

test("合并：内容很长时切成多条，且每条都不超长、标签不残缺", async () => {
  const uid = freshUser();
  // 关键词命中很多条 + 标题很长 → 逼出分块
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: 970000 + i,
    title: `【出】绿云 ${"很长的标题".repeat(12)} ${i}`,
    category: "trade",
    content: "正文",
  }));
  const mock = installFetchMock({ rssXml: makeRss(many) });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.ok(msgs.length >= 1, "至少应有 1 条消息");
  for (const m of msgs) {
    assert.ok(m.html.length <= 4096, `单条消息不得超长（实际 ${m.html.length}）`);
    // 标签必须成对：截断在标签中间会让 Telegram 整条 400 拒收
    for (const tag of ["details", "blockquote", "pre", "code", "h3"]) {
      const open = (m.html.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
      const close = (m.html.match(new RegExp(`</${tag}>`, "g")) || []).length;
      assert.equal(open, close, `<${tag}> 必须成对（${open} 开 / ${close} 闭）`);
    }
  }
  // 10 条命中不该只发一条就丢内容
  const total = msgs.map((m) => m.html).join("");
  for (let i = 0; i < 10; i++) {
    assert.match(total, new RegExp(`很长的标题[^<]*${i}<`), `第 ${i} 条不应丢`);
  }
});

test("合并：同一用户的多条消息按序发出（先第 1 号后第 2 号）", async () => {
  const uid = freshUser();
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: 980000 + i,
    title: `【出】绿云 ${"很长的标题".repeat(12)} ${i}`,
    category: "trade",
    content: "正文",
  }));
  const mock = installFetchMock({ rssXml: makeRss(many) });
  await poller.runRound();

  const html = mock.sent.filter((m) => m.chatId === uid).map((m) => m.html).join("");
  const first = html.indexOf("很长的标题 0") >= 0 ? html.indexOf(" 0<") : html.indexOf(" 0");
  const last = html.lastIndexOf(" 9<") >= 0 ? html.lastIndexOf(" 9<") : html.lastIndexOf(" 9");
  assert.ok(first >= 0 && last > first, "分块后顺序不应被打乱");
});
