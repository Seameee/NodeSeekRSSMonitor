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

/** 统一的帮助文本（管理员会多出一段） */
export function buildHelp(isAdmin) {
  let s =
    "<b>NodeSeek 关键词监控</b>\n\n" +
    "<b>开始使用</b>\n" +
    "· /bind — 开通账号（独立关键词与 AI 配置）\n" +
    "· /status — 查看我的状态与配额\n\n" +
    "<b>关键词</b>\n" +
    "· /add &lt;关键词&gt; [版块] [--regex] — 添加\n" +
    "· /remove &lt;序号|关键词&gt; — 删除\n" +
    "· /pause &lt;序号|关键词&gt; / /resume &lt;序号|关键词&gt; — 暂停/恢复\n" +
    "· /list — 查看列表\n" +
    "· /categories — 可用版块\n\n" +
    "<b>AI 摘要（可选）</b>\n" +
    "· /ai set &lt;key&gt; [model] [base_url] — 配置\n" +
    "· /ai fallback &lt;模型1,模型2&gt; — 备用模型\n" +
    "· /ai test — 连通性测试\n" +
    "· /ai status — 当前配置\n" +
    "· /ai off / /ai on — 关闭/启用\n" +
    "· /ai clear — 清除配置（含已加密的 Key）\n\n" +
    "<b>其他</b>\n" +
    "· /history [数量] — 推送记录\n" +
    "· /help — 本帮助";
  if (isAdmin) {
    s +=
      "\n\n<b>管理员</b>\n" +
      "· /admin — 管理面板\n" +
      "· /admin users [页码] — 用户列表\n" +
      "· /admin info &lt;id&gt; — 用户详情\n" +
      "· /admin ban &lt;id&gt; / /admin unban &lt;id&gt;\n" +
      "· /admin quota &lt;id&gt; &lt;kw|ai|push&gt; &lt;数值&gt;\n" +
      "· /admin note &lt;id&gt; &lt;备注&gt;\n" +
      "· /admin del &lt;id&gt; — 删除用户及其全部数据\n" +
      "· /admin stats — 全局统计\n" +
      "· /admin open on|off — 开关注册\n" +
      "· /admin audit — 操作审计";
  }
  return s;
}
