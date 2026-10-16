// ============================================================================
// AI 摘要：拍平并发 + 按内容去重
//
// 两条都是实测出来的性能问题，且都会在「用户数一多」时把整轮拖垮：
//   · poller 第 4 步原本是逐个用户 await 摘要批次，跨用户等于零并发 ——
//     实测 200 个用户各 1 条摘要：串行 20098ms vs 拍平 2510ms（差 8 倍，
//     正好等于 AI_CONCURRENCY）。
//   · 摘要是按「用户 × 帖子」生成的，同一条帖子会被 N 个用户各调一次 ——
//     实测 200 个用户命中同一条帖：200 次调用，内容只有 1 种（重复率 99.5%）。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { makeRss, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const crypto = await import("../src/crypto.js");
const poller = await import("../src/poller.js");
const ai = await import("../src/ai.js");
const { config } = await import("../src/config.js");

test.after(async () => {
  await teardown();
});

// ─── 可控的 AI mock：带延迟，并记录同时在飞的请求数 ──────────────────────────

function json(o, status = 200) {
  return {
    ok: status < 300,
    status,
    headers: new Map(),
    json: async () => o,
    text: async () => JSON.stringify(o),
  };
}

function installMock({ rssXml, latencyMs = 40, reply = "这是摘要" }) {
  const sent = [];
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      const body = init.body ? JSON.parse(init.body) : {};
      if (method === "getUpdates") return json({ ok: true, result: [] });
      sent.push({
        chatId: body.chat_id,
        method,
        html: body.text ?? body.rich_message?.html ?? "",
      });
      return json({ ok: true, result: { message_id: sent.length } });
    }
    if (u.includes("/chat/completions")) {
      const body = JSON.parse(init.body);
      calls.push({ url: u, model: body.model, key: init.headers?.Authorization });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, latencyMs));
      inFlight--;
      return json({ choices: [{ message: { content: reply } }] });
    }
    if (u.includes("nodeseek") || u.includes("seaya") || u.includes("rsshub")) {
      return {
        ok: true,
        status: 200,
        headers: new Map([["etag", '"ai-etag"']]),
        json: async () => ({}),
        text: async () => rssXml,
      };
    }
    throw new Error(`未预期的请求: ${u}`);
  };

  return { sent, calls, maxInFlight: () => maxInFlight };
}

function setupUser(uid, keywords, aiCfg = null) {
  db.deleteUser(uid);
  db.createUser({ telegramId: uid, username: `u${uid}` });
  for (const [kw, mode] of keywords) db.addKeyword(uid, kw, null, mode);
  if (aiCfg) {
    db.upsertAiConfig(uid, {
      baseUrl: aiCfg.baseUrl ?? "https://ai.example.com/v1",
      apiKeyEnc: crypto.encryptSecret("sk-test-0123456789abcdef"),
      apiKeyHint: "sk-tes…cdef (00000000)",
      model: aiCfg.model ?? "test-model",
      fallback: null,
      minLen: 0,
      maxPerRound: 5,
      maxTokens: 4000,
      timeoutMs: 5000,
      prompt: aiCfg.prompt ?? null,
      enabled: true,
    });
  }
  poller.invalidateKeywordCache(uid);
}

// ─── 拍平：跨用户必须并发 ────────────────────────────────────────────────────

test("AI 拍平：多个用户的摘要必须跨用户并发，而不是逐个串行", async () => {
  ai.clearSummaryCache();
  const N = 12;
  // 每个用户配一条只属于自己的关键词 → 命中各自不同的帖子 → 摘要内容互不相同，
  // 因此这里的并发度只反映「拍平」的效果，不会被去重缓存干扰。
  const posts = [];
  for (let i = 0; i < N; i++) {
    const tok = `tok_${String(i).padStart(2, "0")}`;
    posts.push({ id: 910000 + i, title: `帖子 ${tok} 出手`, category: "trade", content: `正文 ${tok} 内容` });
    setupUser(71000 + i, [[tok, "substring"]], {});
  }
  const mock = installMock({ rssXml: makeRss(posts) });

  const r = await poller.runRound();

  assert.equal(mock.calls.length, N, `每个用户各应有 1 次摘要调用（实际 ${mock.calls.length}）`);
  assert.equal(r.aiCalls, N, `应有 ${N} 条摘要（实际 ${r.aiCalls}）`);
  // 串行实现下这里恒为 1；拍平后应逼近 AI_CONCURRENCY
  assert.ok(
    mock.maxInFlight() >= 3,
    `摘要必须跨用户并发（实测同时在飞最多 ${mock.maxInFlight()}，串行实现会是 1）`
  );
  assert.ok(
    mock.maxInFlight() <= config.aiConcurrency,
    `并发不得超过 AI_CONCURRENCY（实测 ${mock.maxInFlight()} > ${config.aiConcurrency}）`
  );
});

// ─── 去重：同一条帖子不能被重复调用 ──────────────────────────────────────────

test("AI 去重：同一帖子同一上游只调一次，但每个用户都拿到摘要且各自计配额", async () => {
  ai.clearSummaryCache();
  const USERS = [72001, 72002, 72003];
  const posts = [
    { id: 920001, title: "【出】绿云 GreenCloud 年付 20 美元", category: "trade", content: "绿云洛杉矶 1C1G" },
  ];
  for (const uid of USERS) setupUser(uid, [["绿云", "substring"]], {});
  const mock = installMock({ rssXml: makeRss(posts) });

  const r = await poller.runRound();

  assert.equal(mock.calls.length, 1, `3 个用户命中同一条帖，上游只应调 1 次（实际 ${mock.calls.length}）`);
  for (const uid of USERS) {
    const msgs = mock.sent.filter((m) => m.chatId === uid);
    assert.equal(msgs.length, 1, `用户 ${uid} 应收到 1 条推送`);
    assert.match(msgs[0].html, /AI 摘要/, `用户 ${uid} 的推送里应带摘要`);
    assert.match(msgs[0].html, /这是摘要/);
    // 命中缓存照样算一次 AI 用量 —— 口径与不缓存时完全一致
    assert.equal(db.getUsage(uid).ai_calls, 1, `用户 ${uid} 的 AI 用量应为 1`);
  }
  assert.equal(r.aiCalls, USERS.length, `记账应按「交付给用户的摘要条数」算（实际 ${r.aiCalls}）`);
});

test("AI 去重：换了上游（base_url）就不共享摘要，必须各自调用", async () => {
  ai.clearSummaryCache();
  const posts = [
    { id: 930001, title: "【出】搬瓦工 CN2 GIA 年付", category: "trade", content: "搬瓦工 洛杉矶" },
  ];
  setupUser(73001, [["搬瓦工", "substring"]], { baseUrl: "https://a.example.com/v1" });
  setupUser(73002, [["搬瓦工", "substring"]], { baseUrl: "https://b.example.com/v1" });
  const mock = installMock({ rssXml: makeRss(posts) });

  await poller.runRound();

  assert.equal(
    mock.calls.length,
    2,
    `两个用户走不同上游时不应共享摘要（实际 ${mock.calls.length} 次调用）`
  );
  const urls = new Set(mock.calls.map((c) => c.url));
  assert.equal(urls.size, 2, "两次调用应打向不同的 base_url");
});

test("AI 去重：换了模型或提示词就不共享摘要", async () => {
  ai.clearSummaryCache();
  const posts = [
    { id: 940001, title: "【情报】某 IDC 即将涨价", category: "info", content: "涨价预告" },
  ];
  setupUser(74001, [["涨价", "substring"]], { model: "model-a" });
  setupUser(74002, [["涨价", "substring"]], { model: "model-b" });
  setupUser(74003, [["涨价", "substring"]], { model: "model-a", prompt: "另一种提示词" });
  const mock = installMock({ rssXml: makeRss(posts) });

  await poller.runRound();

  assert.equal(mock.calls.length, 3, `模型或提示词不同就应各自调用（实际 ${mock.calls.length}）`);
});
