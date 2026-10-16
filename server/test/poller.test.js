// ============================================================================
// 轮询器端到端：多用户分发、AI 按需、配额与降级
//
// 覆盖用户明确提出的四条产品约定：
//   · 不设关键词 → 不推送
//   · 设了关键词 → 只推命中该用户的帖子
//   · 不配 AI     → 不生成摘要
//   · 配了 AI     → 生成摘要且标注模型
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeRss, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const crypto = await import("../src/crypto.js");
const poller = await import("../src/poller.js");
const ai = await import("../src/ai.js");

test.after(async () => {
  await teardown();
});

// 三个用户：
//   U_KW   只有关键词，无 AI
//   U_AI   有关键词 + AI
//   U_NONE 无关键词（不应收到任何东西）
const U_KW = 5001;
const U_AI = 5002;
const U_NONE = 5003;

const POSTS = [
  { id: 900001, title: "【出】绿云 GreenCloud 年付 20 美元", category: "trade", content: "绿云洛杉矶 1C1G 年付 20 美元，三网优化" },
  { id: 900002, title: "【收】搬瓦工 CN2 GIA", category: "trade", content: "收搬瓦工 CN2 GIA 年付" },
  { id: 900003, title: "今天天气不错", category: "daily", content: "闲聊帖" },
];

function setupUsers() {
  // 摘要缓存是进程级状态，同一个测试文件里多轮用例会互相命中 ——
  // 不清掉的话，后一个用例的「上游调用次数」断言会被前一个用例的缓存吃掉。
  ai.clearSummaryCache();
  for (const id of [U_KW, U_AI, U_NONE]) {
    db.deleteUser(id);
    db.createUser({ telegramId: id, username: `u${id}` });
    poller.invalidateKeywordCache(id);
  }
  // U_KW：只关心绿云
  db.addKeyword(U_KW, "绿云", null, "substring");
  // U_AI：关心绿云 + 搬瓦工，且配置了 AI
  db.addKeyword(U_AI, "绿云", null, "substring");
  db.addKeyword(U_AI, "搬瓦工", null, "substring");
  db.upsertAiConfig(U_AI, {
    baseUrl: "https://ai.example.com/v1",
    apiKeyEnc: crypto.encryptSecret("sk-fake-key-1234567890"),
    apiKeyHint: "sk-fak…7890 (abcd1234)",
    model: "test-model",
    fallback: "backup-model",
    minLen: 0,
    maxPerRound: 5,
    maxTokens: 4000,
    timeoutMs: 5000,
    prompt: null,
    enabled: true,
  });
  // U_NONE 故意不加任何关键词
}

test("产品约定：无关键词的用户完全不参与，也不产生推送", async () => {
  setupUsers();
  const { sent } = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "摘要内容" });

  const r = await poller.runRound();
  assert.equal(r.ok, true);
  assert.ok(!sent.some((m) => m.chatId === U_NONE), "无关键词用户不应收到任何消息");
});

test("产品约定：只推命中自己关键词的帖子", async () => {
  setupUsers();
  const { sent } = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "摘要内容" });
  await poller.runRound();

  const kwMsgs = sent.filter((m) => m.chatId === U_KW);
  assert.equal(kwMsgs.length, 1, `U_KW 只应收到 1 条（实际 ${kwMsgs.length}）`);
  assert.match(kwMsgs[0].html, /绿云/, "收到的应是绿云那条");
  assert.doesNotMatch(kwMsgs[0].html, /搬瓦工/, "不应收到没命中的帖子");
  assert.doesNotMatch(kwMsgs[0].html, /天气/, "不应收到无关帖子");
});

test("产品约定：无 AI 配置的用户通知里没有摘要", async () => {
  setupUsers();
  const { sent, aiCalls } = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "摘要内容" });
  await poller.runRound();

  const kwMsgs = sent.filter((m) => m.chatId === U_KW);
  assert.doesNotMatch(kwMsgs[0].html, /AI 摘要/, "未配置 AI 不应出现摘要");
  assert.doesNotMatch(kwMsgs[0].html, /<cite>/, "不应出现 cite");
});

test("产品约定：配置了 AI 的用户会拿到摘要，并标注实际使用的模型", async () => {
  setupUsers();
  const { sent, aiCalls } = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "这是摘要" });
  await poller.runRound();

  const aiMsgs = sent.filter((m) => m.chatId === U_AI);
  assert.equal(aiMsgs.length, 2, `U_AI 命中 2 条（实际 ${aiMsgs.length}）`);
  for (const m of aiMsgs) {
    assert.match(m.html, /AI 摘要 · test-model/, "应标注实际使用的模型");
  }
  // 只有 U_AI 会调 AI，且每条命中一次
  assert.equal(aiCalls.length, 2, `应恰好调用 2 次 AI（实际 ${aiCalls.length}）`);
  assert.ok(
    aiCalls.every((c) => c.auth === "Bearer sk-fake-key-1234567890"),
    "应使用该用户自己的（解密后的）API Key"
  );
});

test("性能：一轮只抓一次 RSS，与用户数无关", async () => {
  setupUsers();
  let rssHits = 0;
  const { sent } = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "x" });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("nodeseek")) rssHits++;
    return origFetch(url, init);
  };

  await poller.runRound();
  assert.equal(rssHits, 1, `3 个用户也只应抓取 1 次（实际 ${rssHits}）`);
});

test("去重：同一批帖子第二轮不再推送", async () => {
  setupUsers();
  const { sent } = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "x" });
  await poller.runRound();
  const firstRound = sent.length;

  sent.length = 0;
  await poller.runRound();
  assert.equal(sent.length, 0, "相同帖子不应重复推送");
  assert.ok(firstRound > 0);
});

test("配额：推送配额用尽后不再发送，并提示一次", async () => {
  setupUsers();
  // 给 U_KW 一条命
  db.setUserQuota(U_KW, "daily_push_quota", 1);

  // 注意：installFetchMock 每次调用都返回**全新的** sent 数组，
  // 因此每装一次 mock 都要重新取 sent，不能复用上一轮的引用。
  let mock = installFetchMock({ rssXml: makeRss(POSTS), aiReply: "x" });
  await poller.runRound();
  const first = mock.sent.filter((m) => m.chatId === U_KW).length;
  assert.equal(first, 1, "配额 1 应只推 1 条");

  // 换一批新帖再来一轮
  mock = installFetchMock({
    rssXml: makeRss([{ id: 900101, title: "绿云 新帖", category: "trade", content: "正文" }]),
    aiReply: "x",
  });
  await poller.runRound();

  const after = mock.sent.filter((m) => m.chatId === U_KW);
  assert.equal(after.length, 1, `应只收到一条配额用尽提示（实际 ${after.length}）`);
  assert.match(after[0].html, /配额已用尽/);
  db.setUserQuota(U_KW, "daily_push_quota", null); // 还原
});

test("降级：富文本失败时改用经典 HTML，通知不丢", async () => {
  setupUsers();
  const uid = 5004;
  db.deleteUser(uid);
  db.createUser({ telegramId: uid, username: "fallback" });
  db.addKeyword(uid, "绿云", null, "substring");
  poller.invalidateKeywordCache(uid);

  const { sent } = installFetchMock({ rssXml: makeRss(POSTS), failRich: true });
  await poller.runRound();

  const msgs = sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1, "应仍然收到 1 条");
  assert.equal(msgs[0].kind, "plain", "应是经典 sendMessage");
  assert.match(msgs[0].html, /关键词提醒/);
});

test("稳健性：RSS 全部失败时整轮不崩，也不推送", async () => {
  setupUsers();
  const { sent } = installFetchMock({ rssXml: null });
  globalThis.fetch = async () => {
    throw new Error("网络不可达");
  };
  const r = await poller.runRound();
  assert.equal(r.ok, false, "应返回失败");
  assert.equal(sent.length, 0, "不应有任何推送");
});

test("统计：pollerStats 反映最近一轮", async () => {
  setupUsers();
  installFetchMock({ rssXml: makeRss(POSTS), aiReply: "x" });
  await poller.runRound();
  const s = poller.pollerStats();
  assert.ok(s.rounds > 0);
  assert.ok(s.lastPostCount > 0);
  assert.equal(s.lastUserCount >= 3, true);
});
