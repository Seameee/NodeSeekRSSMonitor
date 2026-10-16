// ============================================================================
// 用户命令
//
// 权限边界：用户只能操作**自己的**关键词与 AI 配置。
// 所有读写都带 telegram_id 条件，不存在跨用户访问的入口。
// ============================================================================
import { CATEGORIES, config } from "./config.js";
import {
  addKeyword,
  bumpKeywordRevision,
  countKeywords,
  deleteAiConfig,
  effectiveQuota,
  formatQuota,
  isAdminUser,
  isMultiUserEnabled,
  getAiConfig,
  getHistory,
  getUsage,
  getUser,
  listKeywords,
  removeKeywordById,
  setKeywordEnabled,
  upsertAiConfig,
} from "./db.js";
import { encryptSecret, keyFingerprint, maskSecret } from "./crypto.js";
import { validateKeyword, validateRegex } from "./match.js";
import { resolveAiConfig, testAiConfig, validateAiNumbers, validateBaseUrl } from "./ai.js";
import { countAiCall, checkAiQuota } from "./quota.js";
import { sendMessage } from "./telegram.js";
import { buildHelp } from "./notify.js";
import { log } from "./logger.js";

const reply = (chatId, text) => sendMessage(chatId, text);

/** 命令里的时间戳，用于 /add 等的回复 */
const ok = "✅";
const no = "⚠️";

// ─── 关键词 ──────────────────────────────────────────────────────────────────

/** /add 的完整用法。缺少参数时展示 —— 只写「/add 关键词」会让用户
 *  不知道还能指定版块和 --regex，这里把版块代码直接从 CATEGORIES 生成，
 *  避免与可用版块列表脱节。 */
function addUsage() {
  const cats = Object.keys(CATEGORIES).join(" / ");
  return (
    "用法：<code>/add &lt;关键词&gt; [版块] [--regex]</code>\n\n" +
    "· <code>/add 绿云</code> — 监控全部版块\n" +
    "· <code>/add 搬瓦工 trade</code> — 只看交易版\n" +
    "· <code>/add 搬瓦工 trade,info</code> — 多个版块，会拆成两条记录（各占一条配额）\n" +
    "· <code>/add 补货.*CN2 --regex</code> — 关键词按正则解释\n\n" +
    `版块代码：${cats}\n` +
    "不带版块 = 全部版块；用 /categories 看每个版块的说明。"
  );
}

function parseAddArgs(rest) {
  const tokens = rest.split(/\s+/).filter(Boolean);
  let matchMode = "substring";
  const kept = [];
  for (const t of tokens) {
    if (t === "--regex" || t === "-r") matchMode = "regex";
    else kept.push(t);
  }
  if (!kept.length) return { error: "缺少关键词", usage: true };
  const keyword = kept[0];
  // 第二段是版块，支持逗号分隔的多个；带版块的规则只在主源生效。
  // 返回**数组**而不是拼接字符串：调用方会为每个版块各存一条记录，
  // 与 Worker 版行为一致（每条只认一个版块，所以 === 比较也能成立）。
  const categories = kept[1]
    ? kept[1].split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (categories && categories.length) {
    const unknown = categories.filter((c) => !CATEGORIES[c]);
    if (unknown.length) {
      return { error: `未知版块：${unknown.join(", ")}（用 /categories 查看）` };
    }
  }
  return { keyword, categories, matchMode };
}

async function cmdAdd(ctx, rest) {
  const { user, chatId } = ctx;
  const parsed = parseAddArgs(rest);
  if (parsed.error) {
    const hint = parsed.usage ? `\n\n${addUsage()}` : "";
    return reply(chatId, `${no} ${parsed.error}${hint}`);
  }

  const v = parsed.matchMode === "regex" ? validateRegex(parsed.keyword) : validateKeyword(parsed.keyword);
  if (!v.ok) return reply(chatId, `${no} ${v.reason}`);

  // 多版块拆成多条单版块记录（与 Worker 版一致）：每条只认一个版块，
  // 因此每个版块各占一个关键词配额。
  const cats = parsed.categories && parsed.categories.length ? parsed.categories : [null];

  const q = effectiveQuota(user);
  const n = countKeywords(user.telegram_id);
  if (n + cats.length > q.maxKeywords) {
    return reply(
      chatId,
      `${no} 关键词数量不足：已有 ${n}/${formatQuota(q.maxKeywords)} 条，` +
        `本次要新建 ${cats.length} 条（每个版块一条），请先 <code>/remove</code> 一些`
    );
  }

  const created = [];
  for (const cat of cats) {
    const r = addKeyword(user.telegram_id, parsed.keyword.trim(), cat, parsed.matchMode);
    if (!r.duplicate) created.push({ id: r.id, category: cat });
  }
  if (!created.length) return reply(chatId, `${no} 该关键词（同版块）已存在`);
  bumpKeywordRevision(user.telegram_id);

  const mode = parsed.matchMode === "regex" ? "正则" : "子串";
  const scope = created[0].category
    ? `版块 ${created.map((c) => c.category).join(", ")}`
    : "全部版块";
  const skipped = cats.length - created.length;
  const dupNote = skipped > 0 ? `\n（${skipped} 个版块已存在，跳过）` : "";
  return reply(
    chatId,
    `${ok} 已添加 ${created.map((c) => `#${c.id}`).join(" ")}\n` +
      `<code>${escapeHtml(parsed.keyword)}</code>\n` +
      `匹配方式：${mode} · ${scope}${dupNote}\n\n` +
      `当前 ${n + created.length}/${formatQuota(q.maxKeywords)} 条`
  );
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function cmdRemove(ctx, rest) {
  const { user, chatId } = ctx;
  const arg = rest.trim();
  if (!arg) return reply(chatId, `${no} 用法：<code>/remove &lt;序号|关键词&gt;</code>`);

  const kws = listKeywords(user.telegram_id);
  let target = null;
  if (/^\d+$/.test(arg)) {
    const idx = Number.parseInt(arg, 10);
    target = kws[idx - 1] || null;
    if (!target) return reply(chatId, `${no} 序号 ${idx} 不存在（共 ${kws.length} 条）`);
  } else {
    target = kws.find((k) => k.keyword.toLowerCase() === arg.toLowerCase()) || null;
    if (!target) return reply(chatId, `${no} 未找到关键词 <code>${escapeHtml(arg)}</code>`);
  }

  removeKeywordById(user.telegram_id, target.id);
  bumpKeywordRevision(user.telegram_id);
  return reply(chatId, `${ok} 已删除 <code>${escapeHtml(target.keyword)}</code>`);
}

async function cmdToggle(ctx, rest, enabled) {
  const { user, chatId } = ctx;
  const arg = rest.trim();
  if (!arg) return reply(chatId, `${no} 用法：<code>/${enabled ? "resume" : "pause"} &lt;序号|关键词&gt;</code>`);

  const kws = listKeywords(user.telegram_id);
  let target = null;
  if (/^\d+$/.test(arg)) {
    target = kws[Number.parseInt(arg, 10) - 1] || null;
  } else {
    target = kws.find((k) => k.keyword.toLowerCase() === arg.toLowerCase()) || null;
  }
  if (!target) return reply(chatId, `${no} 未找到 <code>${escapeHtml(arg)}</code>`);

  setKeywordEnabled(user.telegram_id, target.id, enabled);
  bumpKeywordRevision(user.telegram_id);
  return reply(
    chatId,
    `${ok} <code>${escapeHtml(target.keyword)}</code> 已${enabled ? "恢复" : "暂停"}`
  );
}

async function cmdList(ctx) {
  const { user, chatId } = ctx;
  const kws = listKeywords(user.telegram_id);
  const q = effectiveQuota(user);
  if (!kws.length) {
    return reply(
      chatId,
      `暂无关键词，所以不会有任何推送。\n\n${addUsage()}`
    );
  }
  const lines = kws.map((k, i) => {
    const flag = k.enabled ? "" : " <i>(已暂停)</i>";
    const mode = k.match_mode === "regex" ? " ·正则" : "";
    const cat = k.category ? ` ·${k.category}` : "";
    return `${i + 1}. <code>${escapeHtml(k.keyword)}</code>${mode}${cat}${flag}`;
  });
  return reply(
    chatId,
    `<b>我的关键词</b>（${kws.length}/${formatQuota(q.maxKeywords)}）\n\n${lines.join("\n")}\n\n` +
      `<i>用 /pause、/resume、/remove 加序号或关键词操作</i>`
  );
}

async function cmdCategories(ctx) {
  const rows = Object.entries(CATEGORIES).map(([k, v]) => `· <code>${k}</code> — ${v}`);
  return reply(
    ctx.chatId,
    `<b>可用版块</b>\n\n${rows.join("\n")}\n\n<i>添加关键词时附加版块可收窄范围，例如 /add 搬瓦工 trade</i>`
  );
}

// ─── AI 配置 ─────────────────────────────────────────────────────────────────

function aiUsageText() {
  return (
    "<b>AI 摘要配置</b>\n\n" +
    "· <code>/ai set &lt;api_key&gt; [base_url]</code> — 只配密钥与地址\n" +
    "  例：<code>/ai set sk-xxxxxxxx https://api.deepseek.com/v1</code>\n" +
    "  地址可省略，默认 <code>https://api.deepseek.com/v1</code>\n" +
    "· <code>/ai fallback &lt;模型1,模型2,模型3&gt;</code> — 配置模型链，<b>第 1 个是主模型</b>，失败时依次回退\n" +
    "  例：<code>/ai fallback deepseek-chat,deepseek-reasoner</code>\n" +
    "· <code>/ai num &lt;minLen&gt; &lt;maxPerRound&gt; &lt;maxTokens&gt; &lt;timeoutMs&gt;</code>\n" +
    "· <code>/ai prompt &lt;自定义提示词&gt;</code>\n" +
    "· <code>/ai test</code> — 连通性测试（消耗 1 次配额）\n" +
    "· <code>/ai status</code> / <code>/ai on</code> / <code>/ai off</code> / <code>/ai clear</code>\n\n" +
    "<i>API Key 以 AES-256-GCM 加密后存储，明文不会落库、不会写入日志。</i>"
  );
}

async function cmdAi(ctx, rest) {
  const { user, chatId } = ctx;
  const id = user.telegram_id;
  const [sub, ...args] = rest.split(/\s+/).filter(Boolean);
  const existing = getAiConfig(id);
  const runtime = existing ? resolveAiConfig(existing) : null;

  switch ((sub || "status").toLowerCase()) {
    case "set": {
      const [apiKey, baseUrl] = args;
      if (!apiKey) {
        return reply(
          chatId,
          `${no} 用法：<code>/ai set &lt;api_key&gt; [base_url]</code>\n` +
            `例：<code>/ai set sk-xxxxxxxx https://api.deepseek.com/v1</code>\n` +
            `地址可省略，默认 <code>https://api.deepseek.com/v1</code>`
        );
      }
      if (apiKey.length < 8 || apiKey.length > 300) {
        return reply(chatId, `${no} API Key 长度不合法`);
      }
      const base = validateBaseUrl(baseUrl || existing?.base_url || "https://api.deepseek.com/v1");
      if (!base.ok) return reply(chatId, `${no} ${base.reason}`);
      // 模型链统一由 /ai fallback 配置，这里只更新密钥与地址，保留已有模型
      const mdl = (existing?.model || "deepseek-chat").slice(0, 120);

      upsertAiConfig(id, {
        baseUrl: base.value,
        apiKeyEnc: encryptSecret(apiKey),
        apiKeyHint: `${maskSecret(apiKey)} (${keyFingerprint(apiKey)})`,
        model: mdl,
        fallback: existing?.fallback || null,
        minLen: existing?.min_len ?? 0,
        maxPerRound: existing?.max_per_round ?? 5,
        maxTokens: existing?.max_tokens ?? 4000,
        timeoutMs: existing?.timeout_ms ?? 15000,
        prompt: existing?.prompt || null,
        enabled: true,
      });
      // 立刻回一条，且不包含 Key 本身
      await reply(
        chatId,
        `${ok} AI 配置已保存\n\n` +
          `<b>地址</b>：<code>${escapeHtml(base.value)}</code>\n` +
          `<b>Key</b>：<code>${escapeHtml(maskSecret(apiKey))}</code>\n` +
          `<b>模型</b>：<code>${escapeHtml(mdl)}</code>\n\n` +
          `换模型用 <code>/ai fallback</code>（含主模型），<code>/ai test</code> 验证连通性。`
      );
      // Key 可能贴错，建议顺手提示删除原消息
      return;
    }

    case "fallback": {
      if (!existing) return reply(chatId, `${no} 请先 /ai set 配置 API Key 与地址`);
      // 模型链的唯一入口：第 1 个是主模型，其余按顺序作为回退。
      const models = args
        .join(" ")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!models.length) {
        return reply(
          chatId,
          `${no} 用法：<code>/ai fallback &lt;模型1,模型2,模型3&gt;</code>\n` +
            `例：<code>/ai fallback deepseek-chat,deepseek-reasoner</code>\n` +
            `第 1 个是主模型，失败时依次回退。`
        );
      }
      const [primary, ...rest] = models;
      upsertAiConfig(id, {
        baseUrl: existing.base_url,
        apiKeyEnc: existing.api_key_enc,
        apiKeyHint: existing.api_key_hint,
        model: primary.slice(0, 120),
        fallback: rest.join(",").slice(0, 500) || null,
        minLen: existing.min_len,
        maxPerRound: existing.max_per_round,
        maxTokens: existing.max_tokens,
        timeoutMs: existing.timeout_ms,
        prompt: existing.prompt,
        enabled: existing.enabled,
      });
      return reply(
        chatId,
        `${ok} 模型链：<code>${escapeHtml([primary, ...rest].join(" → "))}</code>`
      );
    }

    case "num": {
      if (!existing) return reply(chatId, `${no} 请先 /ai set 配置主模型`);
      const nums = args.map((s) => Number.parseInt(s, 10));
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
        return reply(chatId, `${no} 用法：<code>/ai num &lt;minLen&gt; &lt;maxPerRound&gt; &lt;maxTokens&gt; &lt;timeoutMs&gt;</code>\n例：<code>/ai num 0 5 4000 15000</code>`);
      }
      const [minLen, maxPerRound, maxTokens, timeoutMs] = nums;
      const v = validateAiNumbers({ minLen, maxPerRound, maxTokens, timeoutMs });
      if (!v.ok) return reply(chatId, `${no} ${v.reason}`);
      upsertAiConfig(id, {
        baseUrl: existing.base_url,
        apiKeyEnc: existing.api_key_enc,
        apiKeyHint: existing.api_key_hint,
        model: existing.model,
        fallback: existing.fallback,
        minLen,
        maxPerRound,
        maxTokens,
        timeoutMs,
        prompt: existing.prompt,
        enabled: existing.enabled,
      });
      return reply(
        chatId,
        `${ok} 参数已更新\n\n正文下限 ${minLen} · 每轮上限 ${maxPerRound} · max_tokens ${maxTokens} · 超时 ${timeoutMs}ms`
      );
    }

    case "prompt": {
      if (!existing) return reply(chatId, `${no} 请先 /ai set 配置主模型`);
      const p = args.join(" ").trim();
      if (p.length > config.maxPromptLen) {
        return reply(chatId, `${no} 提示词过长（上限 ${config.maxPromptLen} 字符）`);
      }
      upsertAiConfig(id, {
        baseUrl: existing.base_url,
        apiKeyEnc: existing.api_key_enc,
        apiKeyHint: existing.api_key_hint,
        model: existing.model,
        fallback: existing.fallback,
        minLen: existing.min_len,
        maxPerRound: existing.max_per_round,
        maxTokens: existing.max_tokens,
        timeoutMs: existing.timeout_ms,
        prompt: p || null,
        enabled: existing.enabled,
      });
      return reply(chatId, p ? `${ok} 提示词已更新` : `${ok} 已恢复默认提示词`);
    }

    case "test": {
      if (!runtime) return reply(chatId, `${no} 尚未配置 AI，或配置已失效`);
      const q = checkAiQuota(user);
      if (!q.ok) return reply(chatId, `${no} ${q.reason}`);
      await reply(chatId, "⏳ 正在测试连通性…");
      countAiCall(id, 1);
      const r = await testAiConfig(runtime);
      return reply(
        chatId,
        r.ok
          ? `${ok} 连通正常\n\n<b>模型</b>：<code>${escapeHtml(runtime.model)}</code>\n<b>返回</b>：${escapeHtml(r.sample)}`
          : `${no} ${r.reason}`
      );
    }

    case "on":
    case "off": {
      if (!existing) return reply(chatId, `${no} 尚未配置 AI`);
      const enabled = sub.toLowerCase() === "on";
      upsertAiConfig(id, {
        baseUrl: existing.base_url,
        apiKeyEnc: existing.api_key_enc,
        apiKeyHint: existing.api_key_hint,
        model: existing.model,
        fallback: existing.fallback,
        minLen: existing.min_len,
        maxPerRound: existing.max_per_round,
        maxTokens: existing.max_tokens,
        timeoutMs: existing.timeout_ms,
        prompt: existing.prompt,
        enabled,
      });
      return reply(chatId, `${ok} AI 摘要已${enabled ? "启用" : "关闭"}`);
    }

    case "clear": {
      if (!existing) return reply(chatId, `${no} 尚未配置 AI`);
      deleteAiConfig(id);
      return reply(chatId, `${ok} 已删除 AI 配置与加密存储的 API Key`);
    }

    case "status": {
      if (!existing) return reply(chatId, aiUsageText());
      const q = effectiveQuota(user);
      const used = getUsage(id).ai_calls;
      const chain = [existing.model, ...String(existing.fallback || "").split(",").filter(Boolean)].join(" → ");
      return reply(
        chatId,
        `<b>我的 AI 配置</b>\n\n` +
          `<b>状态</b>：${existing.enabled ? "启用" : "已关闭"}\n` +
          `<b>链路</b>：<code>${escapeHtml(chain)}</code>\n` +
          `<b>地址</b>：<code>${escapeHtml(existing.base_url)}</code>\n` +
          `<b>Key</b>：<code>${escapeHtml(existing.api_key_hint)}</code>\n` +
          `<b>参数</b>：正文≥${existing.min_len} · 每轮≤${existing.max_per_round} · max_tokens ${existing.max_tokens} · 超时 ${existing.timeout_ms}ms\n` +
          `<b>今日用量</b>：${used}/${formatQuota(q.dailyAi)}\n` +
          `<b>提示词</b>：${existing.prompt ? "自定义" : "默认"}\n\n` +
          `<i>密钥加密存储、不提供查看明文的入口；忘记请直接 /ai set 覆盖。</i>`
      );
    }

    default:
      return reply(chatId, aiUsageText());
  }
}

// ─── 状态与历史 ──────────────────────────────────────────────────────────────

async function cmdStatus(ctx) {
  const { user, chatId } = ctx;
  const q = effectiveQuota(user);
  const usage = getUsage(user.telegram_id);
  const kwCount = countKeywords(user.telegram_id);
  const ai = getAiConfig(user.telegram_id);
  const role = user.role === "admin" ? "管理员" : "普通用户";
  const statusText = { active: "正常", banned: "已封禁", pending: "待审核" }[user.status] || user.status;

  return reply(
    chatId,
    `<b>我的状态</b>\n\n` +
      `<b>账号</b>：<code>${user.telegram_id}</code>（${role} · ${statusText}）\n` +
      `<b>角色</b>：${isAdminUser(user) ? "管理员（不受配额限制）" : "普通用户"}\n` +
      `<b>运行模式</b>：${isMultiUserEnabled() ? "多用户" : "单用户"}\n` +
      `<b>关键词</b>：${kwCount}/${formatQuota(q.maxKeywords)} 条\n` +
      `<b>AI 摘要</b>：${ai ? (ai.enabled ? `已启用 · <code>${escapeHtml(ai.model)}</code>` : "已关闭") : "未配置"}\n` +
      `<b>今日用量</b>：推送 ${usage.pushes}/${formatQuota(q.dailyPush)} · AI ${usage.ai_calls}/${formatQuota(q.dailyAi)}\n` +
      `<b>注册时间</b>：${user.created_at.slice(0, 19).replace("T", " ")} UTC`
  );
}

async function cmdHistory(ctx, rest) {
  const { user, chatId } = ctx;
  const n = Math.min(Math.max(Number.parseInt(rest, 10) || 10, 1), config.maxHistoryRows);
  const rows = getHistory(user.telegram_id, n);
  if (!rows.length) return reply(chatId, "暂无推送记录。");
  const lines = rows.map((r) => {
    const t = r.sent_at.slice(5, 16).replace("T", " ");
    return `· <a href="${r.link}">${escapeHtml(r.title.slice(0, 50))}</a>\n  <i>${t} · ${escapeHtml(r.keywords || "")}</i>`;
  });
  return reply(chatId, `<b>最近 ${rows.length} 条推送</b>\n\n${lines.join("\n")}`);
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

/**
 * 处理一条用户命令。
 * 返回 true 表示已处理（调用方不再走其他分支）。
 */
export async function handleUserCommand(ctx, cmd, rest) {
  const { user, chatId } = ctx;

  switch (cmd) {
    case "/start":
    case "/help":
      await reply(chatId, buildHelp(user.role === "admin"));
      return true;

    case "/add":
      await cmdAdd(ctx, rest);
      return true;
    case "/remove":
    case "/del":
      await cmdRemove(ctx, rest);
      return true;
    case "/pause":
      await cmdToggle(ctx, rest, false);
      return true;
    case "/resume":
      await cmdToggle(ctx, rest, true);
      return true;
    case "/list":
      await cmdList(ctx);
      return true;
    case "/categories":
      await cmdCategories(ctx);
      return true;

    case "/ai":
      await cmdAi(ctx, rest);
      return true;

    case "/status":
      await cmdStatus(ctx);
      return true;
    case "/history":
      await cmdHistory(ctx, rest);
      return true;

    default:
      return false;
  }
}

export { reply, escapeHtml };
export { getUser };
