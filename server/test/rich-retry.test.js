// ============================================================================
// 富文本发送必须重试，不能因为一次网络抖动就降级成旧版式
//
// 起因（2026-10-17 用户报告「推送内容格式不正确、是我最早的没有用富文本的
// 格式」）：日志里能找到三处
//     [ERROR] [tg] sendRichMessage 最终失败: fetch failed
// 而 sendRichMessage 当时是 retries: 0 —— 一次瞬断就放弃富文本、降级成
// buildNotifMsg 的经典格式。用户看到的就是「旧的没有富文本的样子」。
//
// 这里钉住两件事：
//   · 富文本首次失败（网络错误）后重试成功 → 用户拿到的是**富文本**，不降级；
//   · 富文本被 4xx 拒收（正文真的不合法）→ 仍然降级，且 classic 能发出去，
//     通知不丢。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { makeRss, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const poller = await import("../src/poller.js");

test.after(async () => {
  await teardown();
});

function json(o, status = 200) {
  return {
    ok: status < 300,
    status,
    headers: new Map(),
    json: async () => o,
    text: async () => JSON.stringify(o),
  };
}

/**
 * mock：Telegram 的 sendRichMessage 按 `richFailures` 决定前几次是网络错误
 * （throw，等价于 fetch failed）还是 4xx 拒收；其余方法一律成功。
 */
function installMock({ rssXml, richFailures = 0, richFailureKind = "network" }) {
  const sent = [];
  let richAttempts = 0;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      const body = init.body ? JSON.parse(init.body) : {};
      if (method === "getUpdates") return json({ ok: true, result: [] });

      if (method === "sendRichMessage") {
        richAttempts++;
        if (richAttempts <= richFailures) {
          if (richFailureKind === "network") throw new Error("fetch failed");
          return json({ ok: false, error_code: 400, description: "can't parse entities" }, 400);
        }
        sent.push({ chatId: body.chat_id, html: body.rich_message?.html ?? "", kind: "rich" });
        return json({ ok: true, result: { message_id: sent.length } });
      }

      sent.push({ chatId: body.chat_id, html: body.text ?? "", kind: "plain" });
      return json({ ok: true, result: { message_id: sent.length } });
    }
    if (u.includes("nodeseek") || u.includes("seaya") || u.includes("rsshub")) {
      return {
        ok: true,
        status: 200,
        headers: new Map([["etag", '"retry-etag"']]),
        json: async () => ({}),
        text: async () => rssXml,
      };
    }
    throw new Error(`未预期的请求: ${u}`);
  };

  return { sent, richAttempts: () => richAttempts };
}

const UID = 9200;
function freshUser() {
  db.deleteUser(UID);
  db.createUser({ telegramId: UID, username: "u9200" });
  db.addKeyword(UID, "绿云", null, "substring");
  poller.invalidateKeywordCache(UID);
  return UID;
}

const ONE_POST = [
  { id: 980001, title: "【出】绿云 年付 20 美元", category: "trade", content: "正文" },
];

test("富文本：网络瞬断一次后重试成功，用户拿到的是富文本而不是旧版式", async () => {
  const uid = freshUser();
  // 前 1 次 sendRichMessage 抛网络错误，之后成功
  const mock = installMock({ rssXml: makeRss(ONE_POST), richFailures: 1, richFailureKind: "network" });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1, `应只发出 1 条消息（实际 ${msgs.length}）`);
  assert.equal(msgs[0].kind, "rich", "网络抖动重试成功后必须是富文本，不能降级");
  assert.ok(mock.richAttempts() >= 2, `应至少尝试 2 次（实际 ${mock.richAttempts()}）`);
  assert.match(msgs[0].html, /<h3>/, "富文本应带卡片式标题");
});

test("富文本：两次瞬断后仍能重试成功（retries: 2）", async () => {
  const uid = freshUser();
  const mock = installMock({ rssXml: makeRss(ONE_POST), richFailures: 2, richFailureKind: "network" });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, "rich", "两次瞬断也应撑住，不降级");
});

test("富文本：被 4xx 拒收（正文不合法）时仍然降级，通知不丢", async () => {
  const uid = freshUser();
  // 4xx 不重试（tg 内部直接返回），一定走到降级
  const mock = installMock({ rssXml: makeRss(ONE_POST), richFailures: 99, richFailureKind: "http400" });
  await poller.runRound();

  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1, "降级后仍应有 1 条消息，通知不能丢");
  assert.equal(msgs[0].kind, "plain", "正文被拒时必须降级成经典格式");
  assert.match(msgs[0].html, /关键词提醒/, "降级消息应是 buildNotifMsg 的经典格式");
});
