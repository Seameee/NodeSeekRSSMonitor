// ============================================================================
// NodeSeek Keywords Monitor — Cloudflare Workers
// ============================================================================
const RSS_BASE_URL = "https://rss.nodeseek.com/";

// 备用 RSS 源配置
const RSS_BACKUP_SOURCES = [
  "https://rss.nodeseek.com/",                                    // 主源
  "https://feed.seaya.link/telegram/channel/nodeseekc",          // 备用1: Telegram 转发
  "https://rsshub.app/telegram/channel/nodeseekc",               // 备用2: RSSHub Telegram
];

const CATEGORIES = {
  daily: "日常", tech: "技术", info: "情报", review: "测评",
  trade: "交易", carpool: "拼车", dev: "Dev", "photo-share": "贴图",
  expose: "曝光", sandbox: "沙盒",
};

const RSS_SOURCE_NAMES = ["主源", "备用1(TG)", "备用2(TG)"];

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.nodeseek.com/",
  "Cache-Control": "no-cache",
};

// ─── HTML 转义 ───────────────────────────────────────────────────────────────

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Telegram API ────────────────────────────────────────────────────────────

async function tg(token, method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function sendMsg(token, chatId, text) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await tg(token, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      if (r.ok) return true;
      console.error(`TG send err (attempt ${i + 1}):`, r.description);
    } catch (e) {
      console.error(`TG send exception (attempt ${i + 1}):`, e);
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return false;
}

// ─── AI 摘要（OpenAI 兼容接口，可选）─────────────────────────────────────────
// 只要不配置 AI_API_KEY + AI_MODEL，本段完全不会执行，行为与以前一致。
// 兼容任何 OpenAI 协议端点：DeepSeek 官方 / 中转站 / OpenAI / Groq / 硅基流动 …

const AI_DEFAULT_PROMPT =
  "你是 NodeSeek 论坛的帖子摘要助手。用中文输出 1~2 句话、不超过 80 字，" +
  "概括这个帖子在讲什么、有哪些关键信息，让读者不点开也能知道内容要点。" +
  "不要复述标题，不要客套话，不要 Markdown 标记，不要输出“总结：”之类的前缀。";

// 读取 AI 配置；未配置返回 null
function aiConfig(env) {
  const key = env.AI_API_KEY;
  const model = env.AI_MODEL;
  if (!key || !model) return null;
  return {
    base: String(env.AI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    key: key,
    model: model,
    // 备用模型可写多个，用逗号分隔，按顺序依次尝试
    fallbackModels: String(env.AI_MODEL_FALLBACK || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    minLen: parseInt(env.AI_MIN_LEN || "0", 10),
    maxPerRound: parseInt(env.AI_MAX_PER_ROUND || "5", 10),
    maxTokens: parseInt(env.AI_MAX_TOKENS || "4000", 10),
    timeout: parseInt(env.AI_TIMEOUT_MS || "15000", 10),
    prompt: env.AI_PROMPT || AI_DEFAULT_PROMPT,
  };
}

// 去掉 HTML 标签、压缩空白，并限制送入模型的正文长度
function plainText(html, limit = 2000) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

// 单次调用某个模型；任何失败都返回空串（绝不影响通知发送）
async function aiCall(cfg, model, title, body, category) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);
  try {
    const resp = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: cfg.prompt },
          { role: "user", content: `标题：${title}\n版块：${category}\n正文：\n${body}` },
        ],
        temperature: 0.3,
        max_tokens: cfg.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error(`[AI] ${model} HTTP ${resp.status}: ${t.slice(0, 200)}`);
      return "";
    }

    const data = await resp.json();
    const out = data?.choices?.[0]?.message?.content;
    if (typeof out !== "string" || !out.trim()) {
      // 推理型模型可能把预算耗在思考上导致 content 为空，此时宁可不显示摘要
      console.error(`[AI] ${model} 返回内容为空`);
      return "";
    }
    return out.replace(/\s+/g, " ").trim().slice(0, 400);
  } catch (e) {
    console.error(`[AI] ${model} 调用失败:`, e.message);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// 依次尝试主模型、备用模型…第一个成功的结果即返回。
// 失败包括：网络异常 / 超时 / HTTP 非 2xx / 返回空内容。
async function aiSummary(cfg, title, body, category) {
  const chain = [...new Set([cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean))];
  for (let i = 0; i < chain.length; i++) {
    const out = await aiCall(cfg, chain[i], title, body, category);
    if (out) return out;
    if (i < chain.length - 1) {
      console.warn(`[AI] 模型 ${chain[i]} 失败，回退到 ${chain[i + 1]}`);
    }
  }
  return "";
}

// ─── RSS 解析 ────────────────────────────────────────────────────────────────

// 解析 RSS，支持不同格式的数据源
function parseRSS(xml, sourceIndex = 0) {
  const entries = [];
  const re = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
  let m;

  while ((m = re.exec(xml)) !== null) {
    const b = m[1] || m[2];
    const tag = (t) => {
      // 使用字符串拼接避免转义问题
      // 匹配 <tag><![CDATA[...]]></tag> 或 <tag>...</tag>
      const cdataPattern = '<' + t + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + t + '>';
      const normalPattern = '<' + t + '[^>]*>([\\s\\S]*?)<\\/' + t + '>';
      const r = b.match(new RegExp(cdataPattern + '|' + normalPattern));
      return r ? (r[1] || r[2] || "").trim() : "";
    };

    const link = tag("link") || (b.match(/<link[^>]+href="([^"]*)"/) || [])[1] || "";
    const id = tag("id") || tag("guid");
    // 正文：主源是帖子正文纯文本，备用源是 TG 频道的转发文案
    const description = tag("description");

    // 不同数据源提取 post_id 的逻辑不同
    let postId = null;
    let category = "";
    let author = "";

    if (sourceIndex === 0) {
      // 主源: nodeseek.com RSS
      const pidM = id.match(/(\d+)/);
      if (!pidM) continue;
      postId = parseInt(pidM[1], 10);

      // 使用 tag 函数获取 category，它会正确处理 CDATA
      category = tag("category");
      author = tag("author") || tag("dc:creator");

    } else {
      // 备用源: Telegram 频道 RSS（通过 RSSHub 等）
      // 从 description 中提取 NodeSeek 链接（只取第一个）
      const nsLinkRegex = /https:\/\/www\.nodeseek\.com\/post-\d+-\d+/;
      const nsLinkM = nsLinkRegex.exec(description);
      const nsLink = nsLinkM ? nsLinkM[0] : null;

      // 从 NodeSeek 链接或原始 link 中提取 post_id
      let pidM = null;
      if (nsLink) {
        pidM = nsLink.match(/post-(\d+)-/);
      }

      // 备用方案：从 link 中提取 (t.me/channel/123 格式)
      if (!pidM && link) {
        pidM = link.match(/t\.me\/[^\/]+\/(\d+)/);
      }

      if (!pidM) continue;
      postId = parseInt(pidM[1], 10);

      // 更新 link 为 NodeSeek 链接
      if (nsLink) {
        link = nsLink;
      }

      // Telegram 源通常没有 category，设置为固定值或通过内容分析
      category = "telegram"; // Telegram 频道内容标记
      author = tag("author") || "NodeSeek频道";
    }

    if (!postId) continue;

    entries.push({
      post_id: postId,
      title: tag("title"),
      link: link || `https://t.me/nodeseekc/${postId}`, // 备用链接
      category: category,
      author: author,
      source: sourceIndex, // 记录数据来源
      content: description, // 帖子正文（供 AI 摘要使用）
    });
  }

  return entries;
}

// 多源 RSS 获取：主源失败5次后切换到备用源
async function fetchEntries(category = null, env = {}) {
  const maxRetriesPerSource = 5;
  const timeout = 15000; // 15秒超时

  for (let sourceIndex = 0; sourceIndex < RSS_BACKUP_SOURCES.length; sourceIndex++) {
    const sourceUrl = RSS_BACKUP_SOURCES[sourceIndex];
    const sourceName = RSS_SOURCE_NAMES[sourceIndex];

    // 构建 URL（只有主源支持 category 参数）
    let url;
    if (sourceIndex === 0 && category) {
      url = `${sourceUrl}?category=${category}`;
    } else {
      url = sourceUrl;
    }

    console.log(`[RSS] 尝试使用 ${sourceName}: ${url}`);

    // 对每个源重试5次
    for (let attempt = 0; attempt < maxRetriesPerSource; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const resp = await fetch(url, {
          headers: FETCH_HEADERS,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const text = await resp.text();
        const entries = parseRSS(text, sourceIndex);

        if (entries.length > 0) {
          console.log(`[RSS] ${sourceName} 成功获取 ${entries.length} 条数据`);
          return entries;
        } else {
          console.warn(`[RSS] ${sourceName} 返回空数据`);
        }

      } catch (e) {
        console.error(`[RSS] ${sourceName} 尝试 ${attempt + 1}/${maxRetriesPerSource} 失败:`, e.message);

        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetriesPerSource - 1) {
          const delay = 1000 * Math.pow(2, attempt); // 指数退避: 1s, 2s, 4s, 8s
          console.log(`[RSS] 等待 ${delay}ms 后重试...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    console.log(`[RSS] ${sourceName} 所有尝试失败，切换到下一个源`);
  }

  // 所有源都失败了
  throw new Error(`所有 RSS 源均不可用（每个源尝试 ${maxRetriesPerSource} 次）`);
}

// ─── 关键词匹配 ──────────────────────────────────────────────────────────────

function matches(title, keyword, mode = "substring") {
  if (mode === "regex") {
    try { return new RegExp(keyword, "i").test(title); } catch { return false; }
  }
  return title.toLowerCase().includes(keyword.toLowerCase());
}

// ─── D1 存储层 ───────────────────────────────────────────────────────────────

async function initDB(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL, category TEXT,
      match_mode TEXT NOT NULL DEFAULT 'substring',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, UNIQUE(keyword, category)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS seen_posts (
      post_id INTEGER PRIMARY KEY, seen_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL, keyword TEXT NOT NULL,
      title TEXT NOT NULL, link TEXT NOT NULL,
      category TEXT NOT NULL, author TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent', sent_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`),
  ]);
}

const now = () => new Date().toISOString();

async function getSetting(db, k) {
  const r = await db.prepare("SELECT value FROM settings WHERE key=?1").bind(k).first();
  return r?.value ?? null;
}
async function setSetting(db, k, v) {
  await db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?1,?2)").bind(k, v).run();
}

// ─── Dev 模式状态 ────────────────────────────────────────────────────────────
// settings.dev_left：不存在/空串 = 关闭；-1 = 无限；N>0 = 还剩 N 条可推送
const DEV_KEY = "dev_left";

async function getDevState(db) {
  const v = await getSetting(db, DEV_KEY);
  if (v === null || v === "") return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n === 0) return null;
  return { left: n < 0 ? -1 : n };
}

async function setDevState(db, left) {
  await setSetting(db, DEV_KEY, left === null ? "" : String(left));
}

async function listKeywords(db) {
  return (await db.prepare("SELECT keyword,category,match_mode,enabled FROM keywords ORDER BY created_at").all()).results;
}

// 按序号删除关键词（精确匹配 keyword+category）
async function removeKeywordByIndex(db, idx) {
  const kws = await listKeywords(db);
  if (idx < 1 || idx > kws.length) return null;
  const kw = kws[idx - 1];
  await db.prepare("DELETE FROM keywords WHERE keyword=?1 COLLATE NOCASE AND (category IS ?2 OR category=?2)")
    .bind(kw.keyword, kw.category).run();
  return kw;
}

// 按序号暂停/恢复关键词
async function setEnabledByIndex(db, idx, en) {
  const kws = await listKeywords(db);
  if (idx < 1 || idx > kws.length) return null;
  const kw = kws[idx - 1];
  await db.prepare("UPDATE keywords SET enabled=?1 WHERE keyword=?2 COLLATE NOCASE AND (category IS ?3 OR category=?3)")
    .bind(en ? 1 : 0, kw.keyword, kw.category).run();
  return kw;
}

async function addKeyword(db, kw, cat, mode) {
  const dup = await db.prepare("SELECT 1 FROM keywords WHERE keyword=?1 COLLATE NOCASE AND (category IS ?2 OR category=?2)").bind(kw, cat).first();
  if (dup) return false;
  try {
    await db.prepare("INSERT INTO keywords (keyword,category,match_mode,created_at) VALUES (?1,?2,?3,?4)").bind(kw, cat, mode, now()).run();
    return true;
  } catch { return false; }
}

async function removeKeyword(db, kw) {
  const r = await db.prepare("DELETE FROM keywords WHERE keyword=?1 COLLATE NOCASE").bind(kw).run();
  return r.meta?.changes ?? 0;
}

async function setEnabled(db, kw, en) {
  const r = await db.prepare("UPDATE keywords SET enabled=?1 WHERE keyword=?2 COLLATE NOCASE").bind(en ? 1 : 0, kw).run();
  return r.meta?.changes ?? 0;
}

async function isSeen(db, pid) {
  return !!(await db.prepare("SELECT 1 FROM seen_posts WHERE post_id=?1").bind(pid).first());
}

async function markSeen(db, ids) {
  if (!ids.length) return;
  const n = now();
  const stmts = ids.map((id) => db.prepare("INSERT OR IGNORE INTO seen_posts (post_id,seen_at) VALUES (?1,?2)").bind(id, n));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

async function logNotif(db, post, kw, status) {
  await db.prepare(
    "INSERT INTO notifications (post_id,keyword,title,link,category,author,status,sent_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
  ).bind(post.post_id, kw, post.title, post.link, post.category, post.author, status, now()).run();
}

async function getHistory(db, limit) {
  return (await db.prepare(
    `SELECT post_id, GROUP_CONCAT(DISTINCT keyword) AS keywords,
            title, link, category, author,
            MIN(status) AS status, MAX(sent_at) AS sent_at
     FROM notifications GROUP BY post_id ORDER BY sent_at DESC LIMIT ?1`
  ).bind(limit).all()).results;
}

async function cleanup(db) {
  const d7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM seen_posts WHERE seen_at < ?1").bind(d7),
    db.prepare("DELETE FROM notifications WHERE sent_at < ?1").bind(d30),
  ]);
}

// ─── Telegram 命令处理 ───────────────────────────────────────────────────────

async function handleCommand(env, message) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const uid = parseInt(env.ALLOWED_USER_ID, 10);
  const chatId = message.chat.id;

  if (message.from?.id !== uid) return;

  const raw = (message.text || "").trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase().replace(/@\S+$/, "");
  const args = parts.slice(1);

  if (cmd === "/start" || cmd === "/help") {
    return sendMsg(token, chatId,
      "👋 <b>NodeSeek 关键词监控 Bot</b> (Workers)\n\n" +
      "<b>命令列表：</b>\n" +
      "/add <code>&lt;关键词&gt;</code> <i>[--regex] [分类]</i>  — 添加\n" +
      "/remove <code>&lt;序号或关键词&gt;</code>  — 删除\n" +
      "/pause <code>&lt;序号或关键词&gt;</code>  — 暂停\n" +
      "/resume <code>&lt;序号或关键词&gt;</code>  — 恢复\n" +
      "/list  — 列表\n" +
      "/history <i>[数量]</i>  — 推送记录（默认 10）\n" +
      "/dev <i>[条数|exit]</i>  — Dev 模式：暂停关键词，任何新帖都推送\n" +
      "/status  — 运行状态\n\n" +
      "🏷 <b>可用版块：</b>\n" +
      "<code>daily</code> 日常 · <code>tech</code> 技术 · <code>info</code> 情报 · <code>review</code> 测评 · <code>trade</code> 交易\n" +
      "<code>carpool</code> 拼车 · <code>dev</code> Dev · <code>photo-share</code> 贴图 · <code>expose</code> 曝光 · <code>sandbox</code> 沙盒\n\n" +
      "💡 <i>不填分类则监控全部版块，多版块逗号分隔</i>\n" +
      "📝 <i>示例：</i>\n" +
      "  /add DMIT trade,info\n" +
      "  /add 补货 --regex info,trade,review\n" +
      "  /add DMIT.*(CN2|GIA) --regex"
    );
  }

  if (cmd === "/add") {
    if (!args.length) return sendMsg(token, chatId,
      "用法：/add <code>&lt;关键词&gt;</code> <i>[--regex] [版块]</i>\n\n" +
      "多版块用逗号分隔：/add DMIT trade,info\n" +
      "不填版块则监控全部。"
    );
    const a = [...args];
    let mode = "substring";
    const ri = a.indexOf("--regex");
    if (ri !== -1) { mode = "regex"; a.splice(ri, 1); }
    // 检查最后一个参数是否包含板块（支持逗号分隔多板块）
    let cats = [];
    if (a.length) {
      const last = a[a.length - 1].toLowerCase();
      const parts = last.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length && parts.every((p) => p in CATEGORIES)) {
        cats = parts;
        a.pop();
      }
    }
    const kw = a.join(" ");
    if (!kw) return sendMsg(token, chatId, "❌ 关键词不能为空。");
    if (mode === "regex") {
      try { new RegExp(kw); } catch (e) {
        return sendMsg(token, chatId, `❌ 正则无效：<code>${esc(e.message)}</code>`);
      }
    }
    const ms = mode === "regex" ? " 🔍<i>正则</i>" : "";
    // 无板块 → 全部版块（单条）
    if (!cats.length) {
      const ok = await addKeyword(db, kw, null, mode);
      return sendMsg(token, chatId, ok
        ? `✅ 已添加 <code>${esc(kw)}</code>，全部版块${ms}`
        : `⚠️ <code>${esc(kw)}</code> 已存在`
      );
    }
    // 多板块 → 逐个添加
    const added = [], skipped = [];
    for (const c of cats) {
      const ok = await addKeyword(db, kw, c, mode);
      (ok ? added : skipped).push(CATEGORIES[c]);
    }
    const lines = [];
    if (added.length) lines.push(`✅ 已添加 <code>${esc(kw)}</code>：<b>${added.join("、")}</b>${ms}`);
    if (skipped.length) lines.push(`⚠️ 已存在：${skipped.join("、")}`);
    return sendMsg(token, chatId, lines.join("\n"));
  }

  if (cmd === "/remove") {
    if (!args.length) return sendMsg(token, chatId, "用法：/remove <code>&lt;序号或关键词&gt;</code>");
    const input = args.join(" ");
    const idx = parseInt(input, 10);
    if (!isNaN(idx) && String(idx) === input.trim()) {
      const kw = await removeKeywordByIndex(db, idx);
      if (kw) {
        const scope = kw.category ? ` (${esc(CATEGORIES[kw.category] || kw.category)})` : "";
        return sendMsg(token, chatId, `✅ 已删除 #${idx} <code>${esc(kw.keyword)}</code>${scope}`);
      }
      return sendMsg(token, chatId, `❌ 序号 ${idx} 不存在，请用 /list 查看。`);
    }
    const c = await removeKeyword(db, input);
    return sendMsg(token, chatId, c
      ? `✅ 已删除 <code>${esc(input)}</code>（${c} 条）`
      : `❌ 未找到 <code>${esc(input)}</code>`
    );
  }

  if (cmd === "/pause") {
    if (!args.length) return sendMsg(token, chatId, "用法：/pause <code>&lt;序号或关键词&gt;</code>");
    const input = args.join(" ");
    const idx = parseInt(input, 10);
    if (!isNaN(idx) && String(idx) === input.trim()) {
      const kw = await setEnabledByIndex(db, idx, false);
      if (kw) return sendMsg(token, chatId, `⏸ 已暂停 #${idx} <code>${esc(kw.keyword)}</code>`);
      return sendMsg(token, chatId, `❌ 序号 ${idx} 不存在，请用 /list 查看。`);
    }
    const c = await setEnabled(db, input, false);
    return sendMsg(token, chatId, c ? `⏸ 已暂停 <code>${esc(input)}</code>（${c} 条）` : `❌ 未找到 <code>${esc(input)}</code>`);
  }

  if (cmd === "/resume") {
    if (!args.length) return sendMsg(token, chatId, "用法：/resume <code>&lt;序号或关键词&gt;</code>");
    const input = args.join(" ");
    const idx = parseInt(input, 10);
    if (!isNaN(idx) && String(idx) === input.trim()) {
      const kw = await setEnabledByIndex(db, idx, true);
      if (kw) return sendMsg(token, chatId, `▶️ 已恢复 #${idx} <code>${esc(kw.keyword)}</code>`);
      return sendMsg(token, chatId, `❌ 序号 ${idx} 不存在，请用 /list 查看。`);
    }
    const c = await setEnabled(db, input, true);
    return sendMsg(token, chatId, c ? `▶️ 已恢复 <code>${esc(input)}</code>（${c} 条）` : `❌ 未找到 <code>${esc(input)}</code>`);
  }

  if (cmd === "/list") {
    const kws = await listKeywords(db);
    if (!kws.length) return sendMsg(token, chatId, "📋 暂无关键词。用 /add 添加。");
    const lines = [`📋 <b>监控关键词（${kws.length} 条）：</b>\n`];
    kws.forEach((k, i) => {
      const scope = k.category ? `<i>${esc(CATEGORIES[k.category] || k.category)}</i>` : "<i>全部</i>";
      const mt = k.match_mode === "regex" ? " 🔍" : "";
      const st = k.enabled ? "" : " ⏸";
      lines.push(`${i + 1}. <code>${esc(k.keyword)}</code>${mt}${st} — ${scope}`);
    });
    return sendMsg(token, chatId, lines.join("\n"));
  }

  if (cmd === "/history") {
    let lim = 10;
    if (args[0]) { const n = parseInt(args[0]); if (!isNaN(n)) lim = Math.max(1, Math.min(20, n)); }
    const recs = await getHistory(db, lim);
    if (!recs.length) return sendMsg(token, chatId, "📭 暂无推送记录。");
    const ps = [`📜 <b>最近 ${recs.length} 条推送：</b>`];
    for (const r of recs) {
      const cn = CATEGORIES[r.category] || r.category;
      const t = r.sent_at.slice(0, 16).replace("T", " ");
      const kt = r.keywords.split(",").map((k) => `<code>${esc(k.trim())}</code>`).join(" ");
      const si = r.status === "failed" ? "❌ " : "";
      ps.push(`${si}${kt} · <i>${esc(cn)}</i> · ${t}\n  <a href="${r.link}">${esc(r.title)}</a>`);
    }
    return sendMsg(token, chatId, ps.join("\n\n"));
  }

  if (cmd === "/categories") {
    const ls = ["🏷 <b>可用版块：</b>\n"];
    for (const [s, n] of Object.entries(CATEGORIES)) ls.push(`• <code>${s}</code> — ${n}`);
    ls.push("\n示例：/add DMIT trade");
    return sendMsg(token, chatId, ls.join("\n"));
  }

  if (cmd === "/dev") {
    const a = (args[0] || "").toLowerCase();
    const usage =
      "🧪 <b>Dev 模式</b>：暂停关键词过滤，任何新帖都推送。\n\n" +
      "/dev  — 进入（无限，直到 /dev exit）\n" +
      "/dev <code>&lt;条数&gt;</code>  — 推送指定条数后自动退出\n" +
      "/dev exit  — 立即退出";

    if (!a) {
      await setDevState(db, -1);
      return sendMsg(token, chatId,
        "🧪 <b>已进入 Dev 模式（无限）</b>\n\n" +
        "关键词监控已暂停，<b>任何新帖都会推送</b>。\n" +
        "退出：/dev exit\n\n" +
        "⚠️ <i>忘记退出会一直推送。只想试几条的话用 <code>/dev 5</code> 这种带数量的写法。</i>"
      );
    }

    if (a === "exit" || a === "off" || a === "stop" || a === "0") {
      await setDevState(db, null);
      return sendMsg(token, chatId, "✅ <b>已退出 Dev 模式</b>，恢复关键词监控。");
    }

    const n = parseInt(a, 10);
    if (!Number.isFinite(n) || n < 1) {
      return sendMsg(token, chatId, usage);
    }

    await setDevState(db, n);
    return sendMsg(token, chatId,
      `🧪 <b>已进入 Dev 模式</b>（推送 ${n} 条后自动退出）\n\n` +
      "关键词监控已暂停，任何新帖都会推送。\n" +
      "提前退出：/dev exit"
    );
  }

  if (cmd === "/status") {
    const kws = await listKeywords(db);
    const act = kws.filter((k) => k.enabled).length;
    const pau = kws.length - act;
    const ini = (await getSetting(db, "initialized")) === "true";
    const failCount = parseInt((await getSetting(db, "rss_fail_count")) || "0", 10);
    const dev = await getDevState(db);
    const ai = aiConfig(env);
    const al = ai
      ? `🤖 AI 摘要：<b>开启</b>（模型 <code>${esc(ai.model)}</code>` +
        ai.fallbackModels.map((m) => ` → <code>${esc(m)}</code>`).join("") +
        `${ai.minLen > 0 ? `，正文 ≥ ${ai.minLen} 字` : ""}）\n`
      : `🤖 AI 摘要：关闭（未配置 AI_API_KEY / AI_MODEL）\n`;
    const pl = pau ? `  ⏸ 已暂停：${pau} 个\n` : "";
    const dl = dev
      ? `🧪 Dev 模式：<b>开启</b>（${dev.left < 0 ? "无限" : `剩余 ${dev.left} 条`}，关键词过滤已暂停）\n`
      : `🧪 Dev 模式：关闭\n`;
    const sources = RSS_BACKUP_SOURCES.map((url, i) => `  ${i + 1}. ${i === 0 ? '✓' : '○'} ${url}`).join('\n');
    return sendMsg(token, chatId,
      `✅ <b>Bot 运行正常</b> (Workers)\n\n` +
      `📊 监控关键词：${act} 个\n${pl}` +
      dl +
      al +
      `⏱ 轮询间隔：Cron 每分钟\n` +
      `🚦 防洪上限：10 条/轮\n` +
      `🔄 已初始化：${ini ? "是" : "否（首轮后完成）"}\n` +
      `📈 连续失败：${failCount} 次\n\n` +
      `🌐 RSS 数据源（✓主源）：\n${sources}`
    );
  }
}

// ─── 通知消息组装 ────────────────────────────────────────────────────────────

// 富文本版通知（Bot API 10.3 的 sendRichMessage）。
// 视觉层级：标题(h3，整块可点) → 空行 → 版块·作者 → 空行 → 摘要(引用块+署名) → 折叠关键词
function buildRichNotifMsg(post, matched, summary, dev) {
  const cn = CATEGORIES[post.category] || post.category;
  const kwText = (matched || []).join("\n");
  const link = esc(post.link);
  const parts = [];

  // 1) 标题本身是链接 —— 点击区域最大，不再需要单独的「原帖」链接
  parts.push(`<h3><a href="${link}">${esc(post.title)}</a></h3>`);

  // 2) 版块 · 作者：紧跟标题下方（与标题之间留一个空行，与摘要之间不留）
  const meta = [];
  if (dev) {
    meta.push(dev.remaining < 0 ? "🧪 Dev 模式" : dev.remaining > 0 ? `🧪 Dev 模式 · 剩余 ${dev.remaining} 条` : "🧪 Dev 模式 · 最后一条");
  }
  meta.push(esc(cn), esc(post.author));
  parts.push(`<p>&nbsp;</p>`);
  parts.push(`<p>${meta.join(" · ")}</p>`);

  // 3) 摘要：引用块承载，并用 cite 标明是 AI 生成
  if (summary) {
    parts.push(`<blockquote>${esc(summary)}<cite>AI 摘要</cite></blockquote>`);
  }

  // 4) 命中关键词：短的内联展开，长的默认折叠（避免长正则刷屏）
  if (kwText) {
    const open = kwText.length <= 60 ? " open" : "";
    parts.push(`<details${open}><summary>命中关键词</summary><pre>${esc(kwText)}</pre></details>`);
  }
  return parts.join("");
}

// 发送富文本消息。任何失败都返回 false，由调用方降级为普通 sendMessage。
async function sendRichMsg(token, chatId, html) {
  try {
    const r = await tg(token, "sendRichMessage", {
      chat_id: chatId,
      rich_message: { html },
    });
    if (r.ok) return true;
    console.error(`[TG] sendRichMessage 失败: ${r.description}`);
  } catch (e) {
    console.error("[TG] sendRichMessage 异常:", e.message);
  }
  return false;
}

// 经典 HTML 版通知：富文本不可用（旧版 Bot API / 老客户端）时的降级方案
function buildNotifMsg(post, matched, summary, dev) {
  // dev 为 null/undefined 时是普通关键词通知；
  // 否则是 Dev 模式通知，dev.remaining：<0 无限、>0 还剩几条、0 本条是最后一条
  const cn = CATEGORIES[post.category] || post.category;

  let head;
  if (dev) {
    const tail = dev.remaining < 0 ? "" : dev.remaining > 0 ? `（剩余 ${dev.remaining} 条）` : "（最后一条）";
    head = `🧪 <b>Dev 模式</b>${tail}\n\n`;
  } else {
    // 命中关键词放进可折叠引用块（<blockquote expandable>）：
    // 正则很长时默认折叠，点箭头才展开，不再把整条消息撑满。
    // blockquote 内可以嵌套 <code>（TDLib 校验里 pre/code 只允许嵌在 blockquote 内），
    // 所以等宽字体保留。
    const kt = matched.map((k) => `<code>${esc(k)}</code>`).join("\n");
    head =
      `🔔 <b>关键词提醒</b>\n` +
      `<blockquote expandable>${kt}</blockquote>\n\n`;
  }

  return (
    head +
    `📌 <b>${esc(post.title)}</b>\n` +
    (summary ? `📝 <blockquote>${esc(summary)}</blockquote>\n` : "") +
    `🏷 ${esc(cn)}\n👤 ${esc(post.author)}\n🔗 ${post.link}`
  );
}

// ─── RSS 轮询（Cron Trigger 调用）────────────────────────────────────────────

async function pollRSS(env) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const uid = parseInt(env.ALLOWED_USER_ID, 10);
  const MAX_NOTIF = 10;
  const FAIL_THRESHOLD = 30;

  await initDB(db);

  // Dev 模式：暂停关键词过滤，任何新帖都推送（受条数与防洪上限约束）
  const dev = await getDevState(db);
  const devBudget = dev ? (dev.left < 0 ? MAX_NOTIF : Math.min(dev.left, MAX_NOTIF)) : 0;

  const allKw = await listKeywords(db);
  const kws = allKw.filter((k) => k.enabled);
  if (!dev && !kws.length) return;

  const needGlobal = dev ? true : kws.some((k) => !k.category);
  const cats = [...new Set(kws.filter((k) => k.category).map((k) => k.category))];

  // 拉取 RSS（多源备份）
  const entries = new Map();
  let activeSourceIndex = -1;
  try {
    if (needGlobal) {
      const results = await fetchEntries(null, env);
      activeSourceIndex = results[0]?.source ?? 0;
      for (const e of results) entries.set(e.post_id, e);
    } else {
      // 按分类拉取时，只使用主源（备用源不支持分类）
      for (const c of cats) {
        const results = await fetchEntries(c, env);
        for (const e of results) entries.set(e.post_id, e);
      }
    }
  } catch (e) {
    console.error("RSS fetch failed:", e);
    const fc = parseInt((await getSetting(db, "rss_fail_count")) || "0", 10) + 1;
    await setSetting(db, "rss_fail_count", String(fc));
    if (fc === FAIL_THRESHOLD) {
      const sourceList = RSS_BACKUP_SOURCES.map((url, i) => `${i + 1}. ${url}`).join('\n');
      await sendMsg(token, uid,
        `⚠️ <b>RSS 连续失败 ${fc} 次</b>\n所有数据源均不可用：\n<pre>${sourceList}</pre>\n请检查网络或数据源。`
      );
    }
    return;
  }
  await setSetting(db, "rss_fail_count", "0");

  if (!entries.size) return;

  // 首次运行：静默初始化
  if ((await getSetting(db, "initialized")) !== "true") {
    console.log(`首次轮询，静默标记 ${entries.size} 篇帖子`);
    await markSeen(db, [...entries.keys()]);
    await setSetting(db, "initialized", "true");
    return;
  }

  // 匹配
  const notifs = [];
  for (const [pid, post] of [...entries.entries()].sort((a, b) => a[0] - b[0])) {
    // Dev 模式配额用满就停止消费：本轮剩余的帖子不标记已见，
    // 退出 Dev 模式后它们仍会被关键词正常评估，不会丢失。
    if (dev && notifs.length >= devBudget) break;
    if (await isSeen(db, pid)) continue;
    await markSeen(db, [pid]);

    if (dev) {
      // Dev 模式：不做关键词匹配，全部推送
      notifs.push({ post, matched: [] });
      continue;
    }

    const matched = kws
      .filter((k) => {
        // 备用源（source > 0）的数据忽略 category 限制，只匹配关键词
        // 主源（source === 0）的数据正常检查 category
        const categoryMatch = post.source > 0 || !k.category || k.category === post.category;
        return categoryMatch && matches(post.title, k.keyword, k.match_mode);
      })
      .map((k) => k.keyword);
    if (matched.length) notifs.push({ post, matched });
  }

  if (!notifs.length) return;
  console.log(`发送 ${notifs.length} 条通知`);

  // 发送（带防洪）
  const toSend = notifs.slice(0, MAX_NOTIF);
  const overflow = notifs.slice(MAX_NOTIF);

  // AI 摘要：并发预取，只处理正文够长的帖子，且每轮有数量上限。
  // 未配置 AI_API_KEY/AI_MODEL 时 ai 为 null，整段跳过。
  const ai = aiConfig(env);
  const summaries = new Map();
  if (ai) {
    const targets = toSend
      .map(({ post }) => ({ post, body: plainText(post.content) }))
      // 正文为空的帖子（多为纯图片帖或已删帖）没有可总结的内容，直接跳过
      .filter(({ body }) => body.length > 0 && body.length >= ai.minLen)
      .slice(0, ai.maxPerRound);
    if (targets.length) {
      const chain = [ai.model, ...ai.fallbackModels].filter(Boolean).join(" → ");
      console.log(`[AI] 本轮生成 ${targets.length} 条摘要（模型 ${chain}）`);
      await Promise.all(
        targets.map(async ({ post, body }) => {
          const cn = CATEGORIES[post.category] || post.category;
          const s = await aiSummary(ai, post.title, body, cn);
          if (s) summaries.set(post.post_id, s);
        })
      );
      console.log(`[AI] 摘要成功 ${summaries.size}/${targets.length} 条`);
    } else {
      const why = ai.minLen > 0 ? `空正文或短于 ${ai.minLen} 字` : "正文为空";
      console.log(`[AI] 本轮 ${toSend.length} 条通知均无可用正文（${why}），跳过摘要`);
    }
  }

  let sentCount = 0;
  for (const { post, matched } of toSend) {
    // Dev 模式：把“这是第几条 / 还剩几条”显示在消息头部
    const devInfo = dev ? { remaining: dev.left < 0 ? -1 : Math.max(0, dev.left - (sentCount + 1)) } : null;
    sentCount++;
    const sm = summaries.get(post.post_id);
    // 优先发富文本，失败则降级为经典 HTML（老客户端/旧 Bot API 也能正常收到）
    const ok =
      (await sendRichMsg(token, uid, buildRichNotifMsg(post, matched, sm, devInfo))) ||
      (await sendMsg(token, uid, buildNotifMsg(post, matched, sm, devInfo)));
    // Dev 模式没有关键词，用 (dev) 占位，保证 /history 里能看到
    for (const k of (matched.length ? matched : ["(dev)"])) {
      await logNotif(db, post, k, ok ? "sent" : "failed");
    }
  }

  if (overflow.length) {
    const lines = [
      `⚠️ <b>本轮 ${notifs.length} 条匹配，已推送 ${toSend.length} 条，以下 ${overflow.length} 条汇总：</b>\n`,
    ];
    for (const { post, matched } of overflow) {
      const ks = matched.map((k) => `<code>${esc(k)}</code>`).join(" ");
      lines.push(`• ${ks} — <a href="${post.link}">${esc(post.title)}</a>`);
      for (const k of matched) await logNotif(db, post, k, "sent");
    }
    await sendMsg(token, uid, lines.join("\n"));
  }

  // Dev 模式：扣减配额，用完自动退出并恢复关键词监控
  if (dev && dev.left > 0) {
    const left = Math.max(0, dev.left - toSend.length);
    if (left > 0) {
      await setSetting(db, DEV_KEY, String(left));
    } else {
      await setSetting(db, DEV_KEY, "");
      await sendMsg(token, uid, "🧪 <b>Dev 模式已结束</b>：设定的推送数量已用完，已恢复关键词监控。");
    }
  }

  await cleanup(db);
}

// ─── Worker 入口 ─────────────────────────────────────────────────────────────

export default {
  // Webhook + 管理端点
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // GET /setup — 一键初始化数据库 + 注册 Webhook
    if (url.pathname === "/setup") {
      try {
        await initDB(env.DB);
        const webhookUrl = `${url.origin}/webhook`;
        const body = { url: webhookUrl, allowed_updates: ["message"] };
        if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;
        const r = await tg(env.TELEGRAM_BOT_TOKEN, "setWebhook", body);
        return new Response(JSON.stringify({ database: "ok", webhook: r }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // POST /webhook — Telegram 推送
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const h = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (h !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      if (update.message) {
        await initDB(env.DB);
        ctx.waitUntil(handleCommand(env, update.message));
      }
      return new Response("OK");
    }

    return new Response("NodeSeek Keywords Monitor (Workers Edition)");
  },

  // Cron Trigger — 每分钟轮询 RSS
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollRSS(env));
  },
};
