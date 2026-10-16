// ============================================================================
// 通知消息构建
//
// 富文本优先（Bot API 10.3 的 sendRichMessage），失败降级为经典 HTML。
// 两者都由这里产出，保证视觉层级一致。
// ============================================================================
import { CATEGORIES } from "./config.js";

export function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 富文本通知
 * 层级：标题(h3，整块可点) → 空行 → 版块·作者 → 摘要(引用块) → 折叠关键词
 */
export function buildRichNotifMsg(post, matched = [], summary = null) {
  const cn = CATEGORIES[post.category] || post.category || "未知";
  const kwText = matched.join("\n");
  const parts = [];

  parts.push(`<h3><a href="${esc(post.link)}">${esc(post.title)}</a></h3>`);
  parts.push(`<p>&nbsp;</p>`);
  parts.push(`<p>${esc(cn)} · ${esc(post.author || "未知")}</p>`);

  if (summary?.text) {
    parts.push(
      `<blockquote>${esc(summary.text)}<cite>AI 摘要 · ${esc(summary.model)}</cite></blockquote>`
    );
  }

  if (kwText) {
    const open = kwText.length <= 60 ? " open" : "";
    parts.push(`<details${open}><summary>命中关键词</summary><pre>${esc(kwText)}</pre></details>`);
  }

  return parts.join("");
}

/** 经典 HTML 通知（富文本不可用时的降级） */
export function buildNotifMsg(post, matched = [], summary = null) {
  const cn = CATEGORIES[post.category] || post.category || "未知";
  const kwText = matched.join("\n");
  let head = "🔔 <b>关键词提醒</b>\n";
  if (kwText) {
    head += `<blockquote expandable><code>${esc(kwText)}</code></blockquote>\n\n`;
  }
  return (
    head +
    `📌 <b>${esc(post.title)}</b>\n` +
    (summary?.text
      ? `📝 <i>${esc(summary.model)}</i>\n<blockquote>${esc(summary.text)}</blockquote>\n`
      : "") +
    `🏷 ${esc(cn)}\n👤 ${esc(post.author || "未知")}\n🔗 ${post.link}`
  );
}

/** 单用户单轮命中过多时的汇总消息 */
export function buildOverflowMsg(items, total) {
  const lines = items
    .slice(0, 20)
    .map((p) => `· <a href="${esc(p.link)}">${esc(p.title.slice(0, 60))}</a>`)
    .join("\n");
  const more = total > 20 ? `\n<i>…另有 ${total - 20} 条未列出</i>` : "";
  return (
    `📦 <b>本轮命中较多，仅推送前 ${items.length} 条</b>\n\n` +
    lines +
    more +
    `\n\n<i>可在 /list 中收窄关键词或版块以减少命中量</i>`
  );
}

// ─── 一轮多条命中的合并消息 ──────────────────────────────────────────────────
//
// 为什么要合并：Telegram 全局约 30 msg/s、**单聊约 1 msg/s**，而发送是整轮里
// 唯一躲不掉的串行瓶颈（实测 20 条/秒，200 条要 9.9 秒）。按帖发一条的话，
// 一个用户命中 10 条就占掉 10 条配额，还可能因为单聊 1 msg/s 被 429、再退避重试
// 把整轮拖长。合并后同一个用户无论命中几条都只占 1~3 条。
//
// 单条命中时**仍然走原来的单帖消息**（格式与合并前逐字节一致），
// 所以绝大多数用户看到的东西没有任何变化。

/** 单条消息的长度上限：Telegram 是 4096，留出标签与包装的余量 */
const MAX_MSG_LEN = 3500;
const DIGEST_SEP = "\n\n────────────\n\n";

/** 合并模式下把单条压到可控长度，保证一条消息里能塞下几条、且不会超长 */
function trimItem(it) {
  return {
    post: { ...it.post, title: String(it.post?.title || "").slice(0, 160) },
    matched: (it.matched || []).map((k) => String(k).slice(0, 60)).slice(0, 8),
    summary: it.summary
      ? { ...it.summary, text: String(it.summary.text || "").slice(0, 300) }
      : null,
  };
}

/**
 * 按整条帖子分块，绝不从中间切开某个帖子的 HTML
 * （标签被切开会让 Telegram 直接 400 拒收整条消息）。
 */
function chunkItems(items, header, limit, render) {
  const out = [];
  let cur = "";
  for (const it of items) {
    const block = render(it);
    if (!cur) {
      cur = `${header}\n\n${block}`;
    } else if (cur.length + DIGEST_SEP.length + block.length <= limit) {
      cur += DIGEST_SEP + block;
    } else {
      out.push(cur);
      cur = `${header}\n\n${block}`;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 富文本合并消息：一批命中合成尽量少的几条 */
export function buildRichDigests(items, total = items.length) {
  const header = `🔔 <b>本轮命中 ${total} 条</b>`;
  return chunkItems(items, header, MAX_MSG_LEN, (raw) => {
    const it = trimItem(raw);
    return buildRichNotifMsg(it.post, it.matched, it.summary);
  });
}

/** 合并消息里单条帖子的经典 HTML 正文（不含整条消息的表头） */
function plainItem(post, matched = [], summary = null) {
  const cn = CATEGORIES[post.category] || post.category || "未知";
  const kwText = matched.join("\n");
  let s = `📌 <b>${esc(post.title)}</b>\n`;
  if (kwText) s += `<blockquote expandable><code>${esc(kwText)}</code></blockquote>\n`;
  if (summary?.text) s += `📝 <i>${esc(summary.model)}</i>\n<blockquote>${esc(summary.text)}</blockquote>\n`;
  s += `🏷 ${esc(cn)}\n👤 ${esc(post.author || "未知")}\n🔗 ${post.link}`;
  return s;
}

/** 经典 HTML 合并消息（富文本不可用时的降级） */
export function buildPlainDigests(items, total = items.length) {
  const header = `🔔 <b>关键词提醒：本轮命中 ${total} 条</b>`;
  return chunkItems(items, header, MAX_MSG_LEN, (raw) => {
    const it = trimItem(raw);
    return plainItem(it.post, it.matched, it.summary);
  });
}

/** 统一的帮助文本（管理员会多出一段） */
import { USER_HELP_SECTIONS, ADMIN_HELP_ITEMS, renderItems } from "./help.js";

/**
 * /help 文本。内容全部来自 help.js 的命令清单——此前这里手写了一份，
 * 与实际实现逐渐脱节（例如 /ai set 的 [model] 参数早已去掉、管理员那节
 * 漏了 find 与 multiuser）。现在只渲染，不再自带一份列表。
 */
export function buildHelp(isAdmin) {
  let s = "<b>NodeSeek 关键词监控</b>";
  for (const sec of USER_HELP_SECTIONS) {
    s += `

<b>${sec.title}</b>
${renderItems(sec.items)}`;
  }
  if (isAdmin) {
    s += `

<b>管理员</b>
${renderItems(ADMIN_HELP_ITEMS)}`;
  }
  return s;
}
