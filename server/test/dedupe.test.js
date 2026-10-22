// ============================================================================
// 同一条帖子命中多条规则时，只能推送一次
//
// 用户明确关心：一条帖子若同时被两条规则命中（例如两个正则都能匹配标题），
// 不能推两遍。当前实现天然满足——matchPostsBatch 是「每帖一个结果」，
// 命中的关键词收进 matched 数组；poller 再由这些结果派生 hitIds，
// 所以一个 post_id 只会出现一次。
//
// 这里把它钉住：如果以后有人改成「每个命中的关键词推一条」，这两条会立刻红。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeRss, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const poller = await import("../src/poller.js");

test.after(async () => {
  await teardown();
});

const U = 6100;

// 标题同时能被「绿云」和正则「GreenCloud|搬瓦工」命中
const POSTS = [
  {
    id: 910001,
    title: "【出】绿云 GreenCloud 与搬瓦工 对比",
    category: "trade",
    content: "绿云 GreenCloud 与搬瓦工对比帖",
  },
];

/** 两次关键词（一条子串、一条正则）都能命中同一条帖子 */
function setup() {
  db.deleteUser(U);
  db.createUser({ telegramId: U, username: "multi" });
  db.addKeyword(U, "绿云", null, "substring");
  db.addKeyword(U, "GreenCloud|搬瓦工", null, "regex");
  db.bumpKeywordRevision(U);
  poller.invalidateKeywordCache(U);
}

const greenMsgs = (sent) => sent.filter((m) => m.chatId === U && String(m.html).includes("绿云"));

test("去重：一条帖子命中两条规则时只推送一次", async () => {
  setup();
  const { sent } = installFetchMock({ rssXml: makeRss(POSTS) });
  await poller.runRound();

  assert.equal(greenMsgs(sent).length, 1, `同一条帖子只应推 1 次（实际 ${greenMsgs(sent).length}）`);
});

test("去重：那次推送里两个命中的关键词都要列出来", async () => {
  setup();
  const { sent } = installFetchMock({ rssXml: makeRss(POSTS) });
  await poller.runRound();

  const html = greenMsgs(sent)[0]?.html || "";
  assert.match(html, /绿云/, "应列出第一个命中的关键词");
  assert.ok(
    html.includes("GreenCloud") && html.includes("搬瓦工"),
    "也应把第二个命中的关键词列出来（同一条消息内）"
  );
});

test("去重：命中规则再多，推送条数也不变", async () => {
  setup();
  db.addKeyword(U, "对比", null, "substring");
  db.addKeyword(U, "【出】", null, "substring");
  db.bumpKeywordRevision(U);
  poller.invalidateKeywordCache(U);

  const { sent } = installFetchMock({ rssXml: makeRss(POSTS) });
  await poller.runRound();

  assert.equal(greenMsgs(sent).length, 1, `4 条规则同时命中仍只应推 1 次（实际 ${greenMsgs(sent).length}）`);
});
