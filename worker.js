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
      // Telegram 频道的 ID 通常格式不同，尝试多种方式提取

      // 方式1: 从 id 中提取数字
      let pidM = id.match(/(\d+)/);

      // 方式2: 从 link 中提取 (t.me/channel/123 格式)
      if (!pidM && link) {
        pidM = link.match(/t\.me\/[^\/]+\/(\d+)/);
      }

      // 方式3: 从 guid 或 id 中提取其他格式
      if (!pidM) {
        // 尝试使用标题哈希作为 ID（临时方案）
        const title = tag("title");
        if (title) {
          // 简单的哈希：取标题前20字符的 charCode 和
          let hash = 0;
          for (let i = 0; i < Math.min(title.length, 20); i++) {
            hash = ((hash << 5) - hash) + title.charCodeAt(i);
            hash = hash & hash; // 转为32位整数
          }
          postId = Math.abs(hash);
        }
      } else {
        postId = parseInt(pidM[1], 10);
      }

      if (!postId) continue;

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

  if (cmd === "/status") {
    const kws = await listKeywords(db);
    const act = kws.filter((k) => k.enabled).length;
    const pau = kws.length - act;
    const ini = (await getSetting(db, "initialized")) === "true";
    const failCount = parseInt((await getSetting(db, "rss_fail_count")) || "0", 10);
    const pl = pau ? `  ⏸ 已暂停：${pau} 个\n` : "";
    const sources = RSS_BACKUP_SOURCES.map((url, i) => `  ${i + 1}. ${i === 0 ? '✓' : '○'} ${url}`).join('\n');
    return sendMsg(token, chatId,
      `✅ <b>Bot 运行正常</b> (Workers)\n\n` +
      `📊 监控关键词：${act} 个\n${pl}` +
      `⏱ 轮询间隔：Cron 每分钟\n` +
      `🚦 防洪上限：10 条/轮\n` +
      `🔄 已初始化：${ini ? "是" : "否（首轮后完成）"}\n` +
      `📈 连续失败：${failCount} 次\n\n` +
      `🌐 RSS 数据源（✓主源）：\n${sources}`
    );
  }
}

// ─── RSS 轮询（Cron Trigger 调用）────────────────────────────────────────────

async function pollRSS(env) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const uid = parseInt(env.ALLOWED_USER_ID, 10);
  const MAX_NOTIF = 10;
  const FAIL_THRESHOLD = 30;

  await initDB(db);

  const allKw = await listKeywords(db);
  const kws = allKw.filter((k) => k.enabled);
  if (!kws.length) return;

  const needGlobal = kws.some((k) => !k.category);
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
    if (await isSeen(db, pid)) continue;
    await markSeen(db, [pid]);
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

  for (const { post, matched } of toSend) {
    const kt = matched.map((k) => `<code>${esc(k)}</code>`).join(" ");
    const cn = CATEGORIES[post.category] || post.category;
    const msg =
      `🔔 <b>关键词提醒</b>  ${kt}\n\n` +
      `📌 <b>${esc(post.title)}</b>\n` +
      `🏷 ${esc(cn)}\n👤 ${esc(post.author)}\n🔗 ${post.link}`;
    const ok = await sendMsg(token, uid, msg);
    for (const k of matched) await logNotif(db, post, k, ok ? "sent" : "failed");
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
