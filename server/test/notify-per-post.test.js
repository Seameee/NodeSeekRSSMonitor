// ============================================================================
// 推送格式：**每条命中各发一条消息，不合并**
//
// 曾经为了省发送配额做成「一轮多条命中合并成一条消息」，用户看过后否掉了：
// 合并后几个不相关的帖子挤在一条里（中间只有一条分隔线），既不好扫读也不好
// 转发。结论是保持原来的「一帖一消息」，发送配额不够就认了。
//
// 这个文件就是把这个决定钉住 —— 谁要是再动合并的念头，先看这里。
// 同时钉住两件不能变的事：
//   · 只命中 1 条时的消息，必须与 buildRichNotifMsg 的输出逐字节一致；
//   · 配额按「交付的帖子条数」计（一帖一消息时也就是消息条数）。
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

test("不合并：命中 5 条就发 5 条消息，每条只讲一条帖子", async () => {
  const uid = freshUser();
  const mock = installFetchMock({ rssXml: makeRss(posts(5)) });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 5, `5 条命中应发 5 条消息（实际 ${msgs.length}）`);
  for (let i = 1; i <= 5; i++) {
    const hit = msgs.filter((m) => m.html.includes(`第 ${i} 号`));
    assert.equal(hit.length, 1, `第 ${i} 号应恰好出现在 1 条消息里（实际 ${hit.length}）`);
    // 并且那条消息里不应混进别的帖子
    const others = [1, 2, 3, 4, 5].filter((j) => j !== i && hit[0].html.includes(`第 ${j} 号`));
    assert.deepEqual(others, [], `第 ${i} 号那条里不该混入其它帖子（混入了 ${others.join(",")}）`);
  }
});

test("不合并：不该出现「本轮命中 N 条」这种汇总表头与分隔线", async () => {
  const uid = freshUser();
  const mock = installFetchMock({ rssXml: makeRss(posts(3)) });
  await poller.runRound();

  for (const m of mock.sent.filter((x) => x.chatId === uid)) {
    assert.doesNotMatch(m.html, /本轮命中\s*\d+\s*条/, "不该出现合并式的汇总表头");
    assert.doesNotMatch(m.html, /─{6,}/, "不该出现合并用的分隔线");
  }
});

test("不合并：配额按帖子条数计（4 条命中 = 4 条用量）", async () => {
  const uid = freshUser();
  const mock = installFetchMock({ rssXml: makeRss(posts(4)) });
  await poller.runRound();

  assert.equal(mock.sent.filter((m) => m.chatId === uid).length, 4, "4 条命中应发 4 条消息");
  assert.equal(db.getUsage(uid).pushes, 4, `用量应按 4 条帖子计（实际 ${db.getUsage(uid).pushes}）`);
});

test("不合并：只命中 1 条时，消息与单帖格式逐字节一致", async () => {
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
    "单条命中的消息必须就是单帖格式"
  );
});

test("不合并：10 条命中就 10 条消息，各自不超长且标签成对", async () => {
  const uid = freshUser();
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: 970000 + i,
    title: `【出】绿云 ${"很长的标题".repeat(12)} ${i}`,
    category: "trade",
    content: "正文",
  }));
  const mock = installFetchMock({ rssXml: makeRss(many) });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 10, `10 条命中应发 10 条消息（实际 ${msgs.length}）`);
  for (const m of msgs) {
    assert.ok(m.html.length <= 4096, `单条消息不得超长（实际 ${m.html.length}）`);
    for (const tag of ["details", "blockquote", "pre", "code", "h3"]) {
      const open = (m.html.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
      const close = (m.html.match(new RegExp(`</${tag}>`, "g")) || []).length;
      assert.equal(open, close, `<${tag}> 必须成对（${open} 开 / ${close} 闭）`);
    }
  }
});
