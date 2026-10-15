// ============================================================================
// 命令路由与权限判定
//
// 唯一的入口。鉴权顺序：
//   1. 是否私聊（默认拒绝群聊，避免被当成公共机器人滥用）
//   2. 命令限流（防刷）
//   3. 管理员白名单 → 只放行 /admin，管理员也能用普通命令
//   4. 普通用户 → 必须先 /bind，且状态必须是 active
//   5. 未注册用户只放行 /bind /start /help
// ============================================================================
import { config } from "./config.js";
import { bumpKeywordRevision, createUser, getUser, touchUser } from "./db.js";
import { checkBindCooldown, checkUsable, countCommand, markBind, takeCommandToken } from "./quota.js";
import { sendMessage } from "./telegram.js";
import { buildHelp } from "./notify.js";
import { handleUserCommand, reply } from "./commands-user.js";
import { handleAdminCommand } from "./commands-admin.js";
import { log } from "./logger.js";

/** 未注册用户即可使用的命令 */
const PUBLIC_COMMANDS = new Set(["/start", "/help", "/bind"]);

const isAdmin = (telegramId) => config.adminIds.has(telegramId);

async function doBind(chatId, from) {
  const id = from.id;

  const cd = checkBindCooldown(id);
  if (!cd.ok) {
    return reply(chatId, `⏳ 操作过于频繁，请 ${Math.ceil(cd.retryAfterMs / 1000)} 秒后再试。`);
  }

  const existing = getUser(id);
  if (existing) {
    if (existing.status === "banned") {
      return reply(chatId, "🚫 你的账号已被封禁，如有疑问请联系管理员。");
    }
    markBind(id);
    return reply(
      chatId,
      `你已经注册过了。\n\n<b>ID</b>：<code>${id}</code>\n用 /add 添加关键词即可开始接收推送。`
    );
  }

  if (!config.registrationOpen) {
    return reply(chatId, "🚪 当前未开放注册，请联系管理员开通。");
  }

  // 用户数上限：防止被批量注册撑爆
  const { countUsers } = await import("./db.js");
  if (countUsers() >= config.maxUsers) {
    return reply(chatId, `🚪 用户数已达上限（${config.maxUsers}），请联系管理员。`);
  }

  const created = createUser({
    telegramId: id,
    username: from.username,
    displayName: [from.first_name, from.last_name].filter(Boolean).join(" "),
    role: isAdmin(id) ? "admin" : "user",
  });
  if (!created) return reply(chatId, "注册失败，请稍后再试。");
  markBind(id);

  log.info("bind", `新用户 ${id} (${from.username || "-"}) 注册`);
  return reply(
    chatId,
    `✅ <b>注册成功</b>\n\n<b>你的 ID</b>：<code>${id}</code>\n\n` +
      `<b>接下来</b>\n` +
      `1. <code>/add 关键词</code> — 添加监控关键词（不添加就不会收到任何推送）\n` +
      `2. <code>/ai set &lt;key&gt;</code> — 可选，配置后通知会带 AI 摘要\n` +
      `3. <code>/help</code> — 查看全部命令\n\n` +
      `<i>你的关键词与 AI 配置完全独立，其他用户与管理员的配置互不可见。</i>`
  );
}

/**
 * 处理一条更新。返回 true 表示已消费。
 */
export async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return false;
  const from = msg.from;
  if (!from || from.is_bot) return false;

  const chat = msg.chat;
  const isPrivate = chat.type === "private";
  if (!isPrivate && !config.allowGroupChats) {
    // 群聊里静默忽略，避免打扰也避免被扫
    return false;
  }
  const chatId = chat.id;

  // 命令可能带 @botname 后缀（群聊常见）
  const raw = msg.text.trim();
  const m = raw.match(/^(\/[A-Za-z_]+)(?:@\w+)?\s*([\s\S]*)$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || "").trim();

  // ── 限流 ────────────────────────────────────────────────────────────────
  const rl = takeCommandToken(from.id);
  if (!rl.ok) {
    // 静默丢弃绝大多数超限请求，只偶尔提示，避免限流本身变成放大器
    if (Math.random() < 0.1) {
      await reply(chatId, `⏳ 命令过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后再试。`);
    }
    return true;
  }

  // ── 记录活跃度 ──────────────────────────────────────────────────────────
  const registered = getUser(from.id);
  if (registered) {
    touchUser(from.id, from.username, [from.first_name, from.last_name].filter(Boolean).join(" "));
  }

  // ── /bind ───────────────────────────────────────────────────────────────
  if (cmd === "/bind") {
    countCommand(from.id);
    await doBind(chatId, from);
    return true;
  }

  // ── 管理员 ─────────────────────────────────────────────────────────────
  if (cmd === "/admin") {
    if (!isAdmin(from.id) || registered?.role !== "admin") {
      // 不回显「无权限」，避免探测
      await reply(chatId, "未知命令。发送 /help 查看可用命令。");
      return true;
    }
    countCommand(from.id);
    await handleAdminCommand({ chatId, user: registered, from }, rest);
    return true;
  }

  // ── 未注册用户 ──────────────────────────────────────────────────────────
  if (!registered) {
    if (PUBLIC_COMMANDS.has(cmd)) {
      await reply(
        chatId,
        "👋 本机器人提供 <b>NodeSeek 关键词监控</b>。\n\n" +
          "每个用户拥有独立的关键词与 AI 配置，互不干扰。\n\n" +
          "发送 /bind 立即开通（免费，可随时停用）。"
      );
      return true;
    }
    await reply(chatId, "请先发送 /bind 开通账号。");
    return true;
  }

  const usable = checkUsable(registered);
  if (!usable.ok) {
    if (usable.reason === "banned") {
      await reply(chatId, "🚫 你的账号已被封禁。");
    } else {
      await reply(chatId, `账号状态异常（${usable.reason}），请联系管理员。`);
    }
    return true;
  }

  // ── 普通用户命令 ────────────────────────────────────────────────────────
  countCommand(from.id);
  const handled = await handleUserCommand({ chatId, user: registered, from }, cmd, rest);
  if (!handled) {
    await reply(chatId, `未知命令 <code>${cmd.replace(/[<>&]/g, "")}</code>。发送 /help 查看全部命令。`);
  }
  return true;
}

export { buildHelp, bumpKeywordRevision, sendMessage };
