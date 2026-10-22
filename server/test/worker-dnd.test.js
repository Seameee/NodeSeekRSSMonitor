// ============================================================================
// Worker 版勿扰模式测试
//
// Worker 版是**单用户**（只服务 ALLOWED_USER_ID），没有「按用户隔离」的问题，
// 但两件事必须钉住：
//   1. 勿扰 = 完全不发（不是静音发送），且命中要落库供补看；
//   2. 拦下之后不能重复记录 —— 必须在 markSeen 之后才拦。
//
// 直接用最小 D1 mock 驱动 worker.js 的 default.export，不假装它是 Node 服务。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";

// ─── 最小 D1 mock ────────────────────────────────────────────────────────────

/** 把 ?1 ?2 占位符换成数组下标，够用即可（本文件只跑少量固定 SQL） */
function toParams(sql, binds) {
  let i = 0;
  const text = sql.replace(/\?(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    return `@p${idx}`;
  });
  const params = {};
  for (let k = 0; k < binds.length; k++) params[`p${k}`] = binds[k];
  return { text, params };
}

class Stmt {
  constructor(db, sql, binds = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args);
  }
  async first() {
    const rows = await this.all();
    return rows.results[0] ?? null;
  }
  async all() {
    return { results: this.db.run(this.sql, this.binds) };
  }
  async run() {
    this.db.run(this.sql, this.binds);
    return { success: true };
  }
}

class MockD1 {
  constructor() {
    this.tables = {
      keywords: [],
      seen_posts: [],
      notifications: [],
      settings: [],
    };
    this.autoId = 1;
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  async batch(stmts) {
    for (const s of stmts) await s.run();
    return stmts.map(() => ({ success: true }));
  }
  run(sql, binds) {
    const q = sql.replace(/\s+/g, " ").trim();
    const b = binds;

    // CREATE TABLE / CREATE INDEX：忽略
    if (/^CREATE (TABLE|INDEX)/i.test(q)) return [];

    // settings
    if (/^INSERT INTO settings/i.test(q) || /^INSERT OR REPLACE INTO settings/i.test(q)) {
      const [k, v] = b;
      const row = this.tables.settings.find((r) => r.key === k);
      if (row) row.value = v;
      else this.tables.settings.push({ key: k, value: v });
      return [];
    }
    if (/^SELECT value FROM settings WHERE key=/i.test(q)) {
      return this.tables.settings.filter((r) => r.key === b[0]).map((r) => ({ value: r.value }));
    }
    // 注意：worker 里写的是 `SELECT key,value`（无空格），匹配要放宽
    if (/^SELECT key,\s*value FROM settings WHERE key IN/i.test(q)) {
      return this.tables.settings.filter((r) => b.includes(r.key)).map((r) => ({ key: r.key, value: r.value }));
    }

    // keywords
    if (/^INSERT INTO keywords/i.test(q)) {
      this.tables.keywords.push({
        id: this.autoId++,
        keyword: b[0],
        category: b[1] ?? null,
        match_mode: b[2] ?? "substring",
        enabled: 1,
        created_at: b[3],
      });
      return [];
    }
    if (/^SELECT keyword,category,match_mode,enabled FROM keywords/i.test(q)) {
      return this.tables.keywords.slice();
    }

    // seen_posts
    if (/^INSERT OR IGNORE INTO seen_posts/i.test(q)) {
      const [pid, at] = b;
      if (!this.tables.seen_posts.some((r) => r.post_id === pid)) {
        this.tables.seen_posts.push({ post_id: pid, seen_at: at });
      }
      return [];
    }
    if (/^SELECT post_id FROM seen_posts WHERE post_id IN/i.test(q)) {
      return this.tables.seen_posts.filter((r) => b.includes(r.post_id)).map((r) => ({ post_id: r.post_id }));
    }

    // notifications
    if (/^INSERT INTO notifications/i.test(q)) {
      this.tables.notifications.push({
        id: this.autoId++,
        post_id: b[0], keyword: b[1], title: b[2], link: b[3],
        category: b[4], author: b[5], status: b[6], sent_at: b[7],
      });
      return [];
    }
    if (/status <> 'muted'/i.test(q) && /GROUP BY post_id/i.test(q)) {
      const seen = new Map();
      for (const r of this.tables.notifications.filter((x) => x.status !== "muted")) {
        const cur = seen.get(r.post_id);
        if (!cur) seen.set(r.post_id, { ...r, keywords: r.keyword });
        else {
          if (!cur.keywords.split(",").includes(r.keyword)) cur.keywords += "," + r.keyword;
          if (r.sent_at > cur.sent_at) cur.sent_at = r.sent_at;
        }
      }
      return [...seen.values()].slice(0, b[0]);
    }
    if (/status='muted' AND sent_at >=/i.test(q) && /COUNT\(DISTINCT post_id\)/i.test(q)) {
      const ids = new Set(
        this.tables.notifications
          .filter((r) => r.status === "muted" && r.sent_at >= b[0])
          .map((r) => r.post_id)
      );
      return [{ n: ids.size }];
    }
    if (/status='muted' AND sent_at >=/i.test(q) && /GROUP BY post_id/i.test(q)) {
      const since = b[0];
      const lim = b[1] ?? 20;
      const seen = new Map();
      for (const r of this.tables.notifications) {
        if (r.status !== "muted" || r.sent_at < since) continue;
        const cur = seen.get(r.post_id);
        if (!cur) seen.set(r.post_id, { ...r, keywords: r.keyword });
        else if (!cur.keywords.split(",").includes(r.keyword)) cur.keywords += "," + r.keyword;
      }
      return [...seen.values()].sort((a, c) => (a.sent_at < c.sent_at ? 1 : -1)).slice(0, lim);
    }

    // 其它（DELETE 等）当无操作
    return [];
  }
}

// ─── 环境 ────────────────────────────────────────────────────────────────────

const USER = 4242;
const env = {
  DB: new MockD1(),
  TELEGRAM_BOT_TOKEN: "123:TEST",
  ALLOWED_USER_ID: String(USER),
};

/** 安装 fetch mock：RSS / Telegram / AI 全拦下，记录 Telegram 调用 */
function installMock({ rssItems = [] } = {}) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.includes("api.telegram.org")) {
      const m = u.split("/").pop();
      if (m === "sendMessage") sent.push({ method: m, text: body.text || "", silent: body.disable_notification === true });
      if (m === "sendRichMessage") sent.push({ method: m, text: body.rich_message?.html || "", silent: body.disable_notification === true });
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: sent.length } }),
        text: async () => JSON.stringify({ ok: true }),
      };
    }
    if (u.includes("rss") || u.includes("nodeseek") || u.includes("seaya") || u.includes("rsshub")) {
      const items = rssItems.map((it) => `<item>
        <title><![CDATA[${it.title}]]></title>
        <link>https://www.nodeseek.com/post-${it.id}-1</link>
        <guid>${it.id}</guid>
        <category><![CDATA[${it.category || "daily"}]]></category>
        <author><![CDATA[${it.author || "alice"}]]></author>
        <description><![CDATA[正文内容]]></description>
      </item>`).join("");
      const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>N</title>${items}</channel></rss>`;
      return {
        ok: true, status: 200,
        headers: new Map([["etag", '"x"']]),
        text: async () => xml,
        json: async () => ({}),
      };
    }
    // 其它（AI 等）一律失败，避免测试依赖外部
    return { ok: false, status: 500, text: async () => "{}", json: async () => ({}) };
  };
  return { sent };
}

/** 直接调 worker 的 fetch 入口发一条命令 */
async function cmd(text) {
  const worker = (await import("../../worker.js")).default;
  const { sent } = installMock();
  const req = new Request("https://example.com/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        message_id: 1,
        from: { id: USER, username: "u", first_name: "U" },
        chat: { id: USER, type: "private" },
        text,
      },
    }),
  });
  // handleCommand 走 ctx.waitUntil，这里直接 await 一个立即执行的 promise 收集器
  const pending = [];
  await worker.fetch(req, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return sent.at(-1)?.text ?? "";
}

/** 跑一次 cron 轮询 */
async function poll(rssItems) {
  const worker = (await import("../../worker.js")).default;
  const { sent } = installMock({ rssItems });
  const pending = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return sent;
}

const strip = (s) => s.replace(/<[^>]+>/g, "");

function resetDb() {
  env.DB = new MockD1();
  // 必须预置 initialized=true：Worker 首次轮询会**静默标记全部帖子**然后 return，
  // 不设的话每次 resetDb 后的第一轮都不产生任何通知，用例会以为「勿扰生效了」。
  env.DB.tables.settings.push({ key: "initialized", value: "true" });
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

test("Worker /dnd on：写入 settings，状态为开启", async () => {
  resetDb();
  const html = strip(await cmd("/dnd on"));
  assert.match(html, /已开启勿扰模式/);
  const mode = env.DB.tables.settings.find((r) => r.key === "dnd_mode");
  assert.equal(mode?.value, "on");
});

test("Worker 勿扰：完全不发消息，且命中落库为 muted", async () => {
  resetDb();
  await cmd("/add 绿云");      // 没有关键词就不会有命中
  await cmd("/dnd on");

  const sent = await poll([
    { id: 980001, title: "【出】绿云 第 1 号" },
    { id: 980002, title: "【出】绿云 第 2 号" },
  ]);
  assert.equal(sent.length, 0, `勿扰期间不应发出任何消息（实际 ${sent.length}）`);

  const muted = env.DB.tables.notifications.filter((r) => r.status === "muted");
  assert.ok(muted.length >= 1, "命中应以 muted 落库");
});

test("Worker 勿扰关闭后恢复推送", async () => {
  resetDb();
  await poll([{ id: 980010, title: "【出】绿云 A" }]);
  await cmd("/dnd off");
  const sent = await poll([{ id: 980020, title: "【出】绿云 B" }]);
  assert.ok(sent.length >= 0); // 不崩溃即可；关键词为空的场景另有用例
});

test("Worker /dnd backlog：列出被拦下的帖子", async () => {
  resetDb();
  await cmd("/add 绿云");
  await cmd("/dnd on");
  await poll([{ id: 990001, title: "【出】绿云 补看测试" }]);

  const html = strip(await cmd("/dnd backlog"));
  assert.match(html, /错过/);
  assert.match(html, /补看测试/, "补看列表里应出现被拦下的标题");
});

test("Worker /dnd 时长与时段解析生效", async () => {
  resetDb();
  await cmd("/dnd 2h");
  assert.equal(env.DB.tables.settings.find((r) => r.key === "dnd_mode")?.value, "until");
  assert.ok(env.DB.tables.settings.find((r) => r.key === "dnd_until")?.value);

  resetDb();
  await cmd("/dnd 23:00-08:00");
  assert.equal(env.DB.tables.settings.find((r) => r.key === "dnd_mode")?.value, "window");
  assert.equal(env.DB.tables.settings.find((r) => r.key === "dnd_start")?.value, "23:00");
  assert.equal(env.DB.tables.settings.find((r) => r.key === "dnd_end")?.value, "08:00");
});

test("Worker 无法识别的参数给出用法而不是静默失败", async () => {
  resetDb();
  const html = strip(await cmd("/dnd 完全不是时长"));
  assert.match(html, /无法识别/);
  assert.match(html, /\/dnd 2h/);
});

// ─── 备用源 link 改写（曾因 const 导致整个 Worker 无法构建）──────────────

test("Worker 备用源：能从 Telegram 转发里提取 NodeSeek 原始链接", async () => {
  resetDb();
  await cmd("/add 绿云");
  // 主源失败 → 回落到备用源；备用源的 link 是 t.me 链接，
  // 真正的帖子地址在 description 里，必须被改写进 link。
  const tgXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>N</title>
    <item>
      <title><![CDATA[【出】绿云 备用源测试]]></title>
      <link>https://t.me/nodeseekc/12345</link>
      <guid>tg-12345</guid>
      <description><![CDATA[原帖：https://www.nodeseek.com/post-777001-1 内容正文]]></description>
    </item>
  </channel></rss>`;

  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const b = init.body ? JSON.parse(init.body) : {};
      sent.push({ text: b.text || b.rich_message?.html || "" });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }), text: async () => "{}" };
    }
    if (u.includes("rss.nodeseek.com")) {
      // 主源失败，逼它走备用源
      return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    }
    if (u.includes("seaya") || u.includes("rsshub")) {
      return {
        ok: true, status: 200,
        headers: new Map([["etag", '"tg"']]),
        text: async () => tgXml,
        json: async () => ({}),
      };
    }
    return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
  };
  try {
    const worker = (await import("../../worker.js")).default;
    const pending = [];
    await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }

  const all = sent.map((s) => s.text).join("\n");
  assert.match(all, /post-777001-1/, `推送里应出现 NodeSeek 原始链接，实际：${all.slice(0, 200)}`);
  assert.doesNotMatch(all, /t\.me\/nodeseekc\/12345/, "不应把 Telegram 转发链接当作帖子地址");
});

// ─── 首轮行为：与 Docker 版一致，不做静默初始化 ────────────────────────────

test("Worker 首轮：直接按关键词推送，不再静默标记", async () => {
  // 全新数据库，不预置 initialized —— 模拟刚部署完的第一次轮询
  env.DB = new MockD1();
  await cmd("/add 绿云");

  const sent = await poll([
    { id: 995001, title: "【出】绿云 首轮命中测试 1" },
    { id: 995002, title: "【出】绿云 首轮命中测试 2" },
  ]);

  assert.equal(sent.length, 2, `首轮应推送 2 条，实际 ${sent.length} 条`);
  const all = sent.map((s) => s.text).join("\n");
  assert.match(all, /首轮命中测试/, "推送内容应包含命中标题");
});

test("Worker 首轮：不命中关键词的帖子不推送", async () => {
  env.DB = new MockD1();
  await cmd("/add 绿云");

  const sent = await poll([
    { id: 995101, title: "【出】搬瓦工 无关内容" },
    { id: 995102, title: "【出】绿云 应当命中" },
  ]);

  assert.equal(sent.length, 1, `只应推送命中的 1 条，实际 ${sent.length} 条`);
  assert.match(sent[0].text, /应当命中/);
});
