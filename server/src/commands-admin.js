// ============================================================================
// 管理员命令
//
// 管理员身份有两个合法来源：库内 users.role='admin'（首个 /bind 用户自动获得），
// 或环境变量 ADMIN_TELEGRAM_IDS 白名单（部署时预指定，也可用于找回管理权）。
// 每次调用都会写审计日志。用户命令里没有任何管理员能力，反之亦然。
// ============================================================================
import { config } from "./config.js";
import {
  audit,
  countKeywords,
  isAdminUser,
  isMultiUserEnabled,
  isMultiUserOverridden,
  resetMultiUserEnabled,
  setMultiUserEnabled,
  countUsers,
  deleteUser,
  effectiveQuota,
  getAiConfig,
  getUser,
  getUsage,
  listAudit,
  listUsers,
  setUserNote,
  setUserQuota,
  setUserStatus,
  totalUsage,
} from "./db.js";
import { rateLimitStats } from "./quota.js";
import { pool } from "./worker-pool.js";
import { escapeHtml, reply } from "./commands-user.js";

const PAGE_SIZE = 20;

function fmtUser(u, idx) {
  const role = u.role === "admin" ? "👑" : "";
  const st = { active: "", banned: " 🚫", pending: " ⏳" }[u.status] ?? ` ${u.status}`;
  const name = u.username ? `@${u.username}` : u.display_name || "-";
  return `${idx}. <code>${u.telegram_id}</code> ${role}${st} <i>${escapeHtml(String(name).slice(0, 24))}</i>`;
}

async function adminHelp(chatId) {
  return reply(
    chatId,
    "<b>管理员面板</b>\n\n" +
      "· <code>/admin users [页码]</code> — 用户列表\n" +
      "· <code>/admin find &lt;关键词&gt;</code> — 按 ID/用户名搜索\n" +
      "· <code>/admin info &lt;id&gt;</code> — 用户详情\n" +
      "· <code>/admin ban &lt;id&gt;</code> / <code>/admin unban &lt;id&gt;</code>\n" +
      "· <code>/admin quota &lt;id&gt; kw|ai|push &lt;数值|-1&gt;</code> — 设置配额（-1 恢复默认）\n" +
      "· <code>/admin note &lt;id&gt; &lt;备注&gt;</code>\n" +
      "· <code>/admin del &lt;id&gt;</code> — 删除用户及其<b>全部数据</b>\n" +
      "· <code>/admin stats</code> — 全局统计\n" +
      "· <code>/admin multiuser on|off|default</code> — 多用户模式开关\n" +
      "· <code>/admin open on|off</code> — 开关注册（仅多用户模式生效）\n" +
      "· <code>/admin audit</code> — 最近管理操作\n\n" +
      "<i>所有管理操作都会记录到审计表。</i>"
  );
}

export async function handleAdminCommand(ctx, rest) {
  const { chatId, user } = ctx;
  const [sub, ...args] = rest.split(/\s+/).filter(Boolean);
  const action = (sub || "").toLowerCase();

  const done = async (text, detail) => {
    audit(user.telegram_id, action || "help", null, detail || null);
    return reply(chatId, text);
  };

  switch (action) {
    case "":
    case "help":
      return adminHelp(chatId);

    case "stats": {
      const total = countUsers();
      const active = listUsers({ limit: 1, status: "active" }).length ? null : null;
      const today = totalUsage();
      const rl = rateLimitStats();
      const ps = pool.stats();
      // 统计各状态数量
      const rows = listUsers({ limit: 100_000 });
      const byStatus = rows.reduce((acc, u) => ((acc[u.status] = (acc[u.status] || 0) + 1), acc), {});
      const byRole = rows.reduce((acc, u) => ((acc[u.role] = (acc[u.role] || 0) + 1), acc), {});
      return done(
        `<b>全局统计</b>\n\n` +
          `<b>用户</b>：${total} 个\n` +
          `· 状态：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}\n` +
          `· 角色：${Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}\n` +
          `<b>今日</b>：推送 ${today.pushes} 条 · AI ${today.aiCalls} 次\n` +
          `<b>运行模式</b>：${isMultiUserEnabled() ? "多用户" : "单用户"}${isMultiUserOverridden() ? "（管理员覆盖）" : "（环境变量）"}\n` +
          `<b>注册开关</b>：${config.registrationOpen ? "开放" : "关闭"}${isMultiUserEnabled() ? "" : "（单用户模式下不生效）"}\n` +
          `<b>限流表</b>：活跃用户桶 ${rl.users} 个\n` +
          `<b>worker 池</b>：${ps.disabled ? "已禁用" : `${ps.alive}/${ps.size} 存活 · 空闲 ${ps.idle} · 排队 ${ps.queued}`}`,
        `stats total=${total}`
      );
    }

    case "users": {
      const page = Math.max(Number.parseInt(args[0], 10) || 1, 1);
      const rows = listUsers({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      if (!rows.length) return reply(chatId, "没有更多用户。");
      const total = countUsers();
      const lines = rows.map((u, i) => fmtUser(u, (page - 1) * PAGE_SIZE + i + 1));
      return reply(
        chatId,
        `<b>用户列表</b>（第 ${page} 页，共 ${total} 个）\n\n${lines.join("\n")}\n\n` +
          `<i>/admin users ${page + 1} 看下一页</i>`
      );
    }

    case "find": {
      const q = args.join(" ").trim();
      if (!q) return reply(chatId, "用法：<code>/admin find &lt;ID 或用户名&gt;</code>");
      const all = listUsers({ limit: 100_000 });
      const hits = all.filter(
        (u) => String(u.telegram_id).includes(q) || String(u.username || "").toLowerCase().includes(q.toLowerCase())
      );
      if (!hits.length) return reply(chatId, "未找到匹配用户。");
      return reply(chatId, `<b>匹配 ${hits.length} 个</b>\n\n${hits.slice(0, 30).map(fmtUser).join("\n")}`);
    }

    case "info": {
      const id = Number.parseInt(args[0], 10);
      const u = getUser(id);
      if (!u) return reply(chatId, `未找到用户 <code>${escapeHtml(args[0] || "")}</code>`);
      const q = effectiveQuota(u);
      const usage = getUsage(id);
      const kwCount = countKeywords(id);
      const ai = getAiConfig(id);
      return reply(
        chatId,
        `<b>用户详情</b>\n\n` +
          `<b>ID</b>：<code>${u.telegram_id}</code>\n` +
          `<b>用户名</b>：${u.username ? "@" + escapeHtml(u.username) : "-"}\n` +
          `<b>昵称</b>：${escapeHtml(u.display_name || "-")}\n` +
          `<b>角色/状态</b>：${u.role} / ${u.status}\n` +
          `<b>注册</b>：${u.created_at.slice(0, 19).replace("T", " ")} UTC\n` +
          `<b>最近活跃</b>：${(u.last_seen_at || "-").slice(0, 19).replace("T", " ")}\n\n` +
          `<b>关键词</b>：${kwCount}/${q.maxKeywords}\n` +
          `<b>配额</b>：AI ${q.dailyAi}/天 · 推送 ${q.dailyPush}/天\n` +
          `<b>今日用量</b>：AI ${usage.ai_calls} · 推送 ${usage.pushes} · 命令 ${usage.commands}\n` +
          `<b>AI 配置</b>：${ai ? `${ai.enabled ? "启用" : "关闭"} · <code>${escapeHtml(ai.model)}</code> · Key <code>${escapeHtml(ai.api_key_hint)}</code>` : "未配置"}\n` +
          `<b>备注</b>：${escapeHtml(u.note || "-")}`
      );
    }

    case "ban":
    case "unban": {
      const id = Number.parseInt(args[0], 10);
      const u = getUser(id);
      if (!u) return reply(chatId, "未找到该用户。");
      if (isAdminUser(u)) return reply(chatId, "⚠️ 不能封禁管理员账号。");
      const status = action === "ban" ? "banned" : "active";
      setUserStatus(id, status);
      return done(
        `${action === "ban" ? "🚫 已封禁" : "✅ 已解封"} <code>${id}</code>`,
        `${action} ${id}`
      );
    }

    case "quota": {
      const id = Number.parseInt(args[0], 10);
      const field = String(args[1] || "").toLowerCase();
      const raw = Number.parseInt(args[2], 10);
      const map = { kw: "max_keywords", ai: "daily_ai_quota", push: "daily_push_quota" };
      const col = map[field];
      if (!col || !Number.isFinite(raw)) {
        return reply(
          chatId,
          "用法：<code>/admin quota &lt;id&gt; kw|ai|push &lt;数值&gt;</code>\n数值填 -1 表示恢复全局默认。"
        );
      }
      const u = getUser(id);
      if (!u) return reply(chatId, "未找到该用户。");
      if (raw !== -1 && (raw < 0 || raw > 1_000_000)) return reply(chatId, "数值范围不合法。");
      setUserQuota(id, col, raw === -1 ? null : raw);
      return done(
        `✅ 已把 <code>${id}</code> 的 <b>${field}</b> 配额设为 ${raw === -1 ? "默认" : raw}`,
        `quota ${id} ${field}=${raw}`
      );
    }

    case "note": {
      const id = Number.parseInt(args[0], 10);
      const note = args.slice(1).join(" ").trim();
      const u = getUser(id);
      if (!u) return reply(chatId, "未找到该用户。");
      setUserNote(id, note.slice(0, 200) || null);
      return done(`✅ 备注已更新`, `note ${id}`);
    }

    case "del": {
      const id = Number.parseInt(args[0], 10);
      const u = getUser(id);
      if (!u) return reply(chatId, "未找到该用户。");
      if (isAdminUser(u)) return reply(chatId, "⚠️ 不能删除管理员账号。");
      deleteUser(id);
      return done(`🗑 已删除用户 <code>${id}</code> 及其全部数据`, `del ${id}`);
    }

    case "multiuser": {
      const v = String(args[0] || "").toLowerCase();
      const modeDesc = () =>
        isMultiUserEnabled()
          ? `多用户（${isMultiUserOverridden() ? "管理员已覆盖" : "继承环境变量"}）`
          : `单用户（${isMultiUserOverridden() ? "管理员已覆盖" : "继承环境变量"}）`;

      if (v === "on") {
        setMultiUserEnabled(true);
        return done(
          `✅ 已切换为 <b>多用户模式</b>\n\n其他人现在可以 /bind 自助开通。\n` +
            `新用户默认配额：关键词 ${config.defaultMaxKeywords} 条 · 每日 AI ${config.defaultDailyAiQuota} 次 · 每日推送 ${config.defaultDailyPushQuota} 条\n` +
            `用 <code>/admin quota &lt;id&gt; …</code> 可对单个用户放宽。`,
          "multiuser on"
        );
      }
      if (v === "off") {
        setMultiUserEnabled(false);
        return done(
          `🔒 已切换为 <b>单用户模式</b>\n\n` +
            `· 只有管理员能使用本 Bot\n` +
            `· 其他用户的命令会被拒绝，但<b>数据保留</b>\n` +
            `· 本轮起不再向他们推送\n` +
            `· /bind 对新用户关闭\n\n` +
            `<i>重新开启后他们会立即恢复。</i>`,
          "multiuser off"
        );
      }
      if (v === "default" || v === "reset") {
        resetMultiUserEnabled();
        return done(
          `↩️ 已清除管理员覆盖，回到环境变量 <code>MULTI_USER_ENABLED</code> 决定的值：<b>${modeDesc()}</b>`,
          "multiuser reset"
        );
      }
      return reply(
        chatId,
        `<b>多用户模式</b>\n\n当前：<b>${modeDesc()}</b>\n\n` +
          `· <code>/admin multiuser on</code> — 开放给其他人使用\n` +
          `· <code>/admin multiuser off</code> — 收回，仅管理员可用\n` +
          `· <code>/admin multiuser default</code> — 清除覆盖，回到部署时的环境变量设置\n\n` +
          `<i>关闭不会删除任何数据。环境变量只在从未被覆盖时生效。</i>`
      );
    }

    case "open": {
      const v = String(args[0] || "").toLowerCase();
      if (!["on", "off"].includes(v)) return reply(chatId, "用法：<code>/admin open on|off</code>");
      // 运行期开关存内存；如需持久可写入 settings 表
      config.registrationOpen = v === "on";
      return done(
        `✅ 注册已${v === "on" ? "开放" : "关闭"}` +
          (isMultiUserEnabled() ? "" : "\n\n<i>注意：当前是单用户模式，注册开关暂时不生效。</i>"),
        `open ${v}`
      );
    }

    case "audit": {
      const rows = listAudit(15);
      if (!rows.length) return reply(chatId, "暂无管理操作记录。");
      const lines = rows.map(
        (r) =>
          `· <code>${r.actor_id}</code> ${escapeHtml(r.action)}${r.target_id ? ` → <code>${r.target_id}</code>` : ""} <i>${r.created_at.slice(5, 16).replace("T", " ")}</i>${r.detail ? `\n  ${escapeHtml(r.detail)}` : ""}`
      );
      return reply(chatId, `<b>最近管理操作</b>\n\n${lines.join("\n")}`);
    }

    default:
      return adminHelp(chatId);
  }
}
