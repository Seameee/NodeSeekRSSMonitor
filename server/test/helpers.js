// ============================================================================
// 测试环境准备：必须在导入任何业务模块之前设置环境变量
// （config.js 在模块加载时就读取并校验）
// ============================================================================
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_DIR = mkdtempSync(join(tmpdir(), "nsm-test-"));
export const TEST_DB = join(TEST_DIR, "test.db");

process.env.NODE_ENV = "test";
process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
process.env.ADMIN_TELEGRAM_IDS = "1000";
process.env.DB_PATH = TEST_DB;
process.env.APP_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "error"; // 测试时静音
process.env.WORKER_POOL_SIZE = "2";
process.env.COMMAND_RATE_PER_MIN = "600"; // 取允许的最大值，测试里尽量不被限流干扰
process.env.BIND_COOLDOWN_SEC = "0";
process.env.HEALTH_PORT = "0";

/** 动态导入业务模块（确保 env 已就绪） */
export const load = (name) => import(`../src/${name}.js`);

/** 构造一条 Telegram update */
export function makeUpdate(text, { id = 2000, username = "tester", chatType = "private" } = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id, username, first_name: "Test", last_name: "User", is_bot: false },
      chat: { id, type: chatType },
      text,
    },
  };
}

/** 收集所有发出的消息（替换 Telegram 网络层） */
export function installFetchMock({ rssXml = null, aiReply = "AI 生成的摘要", failRich = false } = {}) {
  const sent = [];
  const aiCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};

    // Telegram
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      if (method === "sendRichMessage") {
        if (failRich) {
          return jsonResponse({ ok: false, description: "rich not supported", error_code: 400 });
        }
        sent.push({ chatId: body.chat_id, html: body.rich_message.html, kind: "rich" });
        return jsonResponse({ ok: true, result: { message_id: sent.length } });
      }
      if (method === "sendMessage") {
        sent.push({ chatId: body.chat_id, html: body.text, kind: "plain" });
        return jsonResponse({ ok: true, result: { message_id: sent.length } });
      }
      if (method === "getUpdates") return jsonResponse({ ok: true, result: [] });
      return jsonResponse({ ok: true, result: true });
    }

    // AI
    if (u.includes("/chat/completions")) {
      aiCalls.push({ url: u, model: body.model, auth: init.headers?.Authorization });
      if (aiReply === null) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({ choices: [{ message: { content: aiReply } }] });
    }

    // RSS
    if (rssXml !== null && (u.includes("nodeseek") || u.includes("rsshub") || u.includes("seaya"))) {
      return textResponse(rssXml);
    }

    throw new Error(`未预期的请求: ${u}`);
  };

  return { sent, aiCalls };
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([
      ["etag", '"test-etag"'],
      ["last-modified", "Wed, 01 Jan 2026 00:00:00 GMT"],
    ]),
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** 生成一份 RSS 夹具 */
export function makeRss(items) {
  const body = items
    .map(
      (it) => `<item>
      <title><![CDATA[${it.title}]]></title>
      <link>https://www.nodeseek.com/post-${it.id}-1</link>
      <guid>${it.id}</guid>
      <category><![CDATA[${it.category || "daily"}]]></category>
      <author><![CDATA[${it.author || "alice"}]]></author>
      <description><![CDATA[${it.content ?? "正文内容"}]]></description>
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>NodeSeek</title>${body}</channel></rss>`;
}

/**
 * 测试收尾：关闭 worker 线程池与 SQLite。
 * 不调用的话 node:test 会一直等事件循环清空（worker 线程让它永不退出）。
 */
export async function teardown() {
  try {
    const { pool } = await import("../src/worker-pool.js");
    await pool.close();
  } catch {
    /* 忽略：未使用线程池的测试 */
  }
  try {
    const { closeDb } = await import("../src/db.js");
    closeDb();
  } catch {
    /* 忽略 */
  }
}
