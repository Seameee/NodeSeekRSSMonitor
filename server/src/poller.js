// ============================================================================
// 轮询器：整个服务性能的核心
//
// 多用户下的关键设计 —— **抓取与匹配解耦**：
//
//   每一轮只做一次 RSS 抓取与解析（与用户数无关），
//   然后把同一份帖子列表分发给所有用户做内存匹配。
//   100 个用户和 1 个用户的网络开销完全相同。
//
// 并发控制：
//   · CPU（解析/匹配）走 worker 线程池，主线程不被正则拖住
//   · AI 请求用信号量限制同时在飞数量（AI_CONCURRENCY）
//   · Telegram 发送由 telegram.js 的令牌桶 + 每 chat 锁控速
//   · 用户之间用 mapLimit 分批处理，避免一次性把 N 个用户的活儿全展开
//
// 配额：AI 调用与推送都计入 usage_daily，超额的用户本轮直接跳过，
// 并在当天首次超额时提示一次。
// ============================================================================
import { config } from "./config.js";
import { CATEGORIES } from "./config.js";
import {
  effectiveQuota,
  getSettings,
  getUser,
  listEnabledAiConfigs,
  listKeywords,
  listUsers,
  logNotification,
  markSeen,
  filterUnseen,
  getUsage,
  incrUsage,
  isAdminUser,
  isMultiUserEnabled,
} from "./db.js";
import { resolveAiConfig, aiSummary, plainText } from "./ai.js";
import { matchPostsAsync } from "./worker-pool.js";
import { fetchEntries } from "./rss.js";
import { buildRichNotifMsg, buildNotifMsg, buildOverflowMsg } from "./notify.js";
import { sendMany, sendMessage, sendRichMessage } from "./telegram.js";
import { shouldNotifyQuota } from "./quota.js";
import { log } from "./logger.js";

// 每用户的生效关键词缓存：{ revision, keywords }
// 用 settings 里的 kwrev 做失效，避免每次轮询都读库
const kwCache = new Map();

function loadKeywordsFor(userId) {
  const rev = getSettings([`kwrev:${userId}`])[`kwrev:${userId}`] || "0";
  const hit = kwCache.get(userId);
  if (hit && hit.revision === rev) return hit.keywords;
  const keywords = listKeywords(userId, { onlyEnabled: true });
  kwCache.set(userId, { revision: rev, keywords });
  return keywords;
}

export function invalidateKeywordCache(userId) {
  kwCache.delete(userId);
}

/** 每个用户每轮的处理结果，供日志与统计 */
const stats = {
  lastRunAt: null,
  lastDurationMs: 0,
  lastPostCount: 0,
  lastUserCount: 0,
  lastPushed: 0,
  lastAiCalls: 0,
  rounds: 0,
  failures: 0,
};

export function pollerStats() {
  return { ...stats };
}

/**
 * 跑一轮。返回本轮统计。
 */
export async function runRound() {
  const started = Date.now();
  stats.rounds++;

  // ── 1. 只抓一次 ────────────────────────────────────────────────────────
  let fetched;
  try {
    fetched = await fetchEntries();
  } catch (e) {
    stats.failures++;
    log.error("poller", `RSS 全部失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (fetched.notModified) {
    log.debug("poller", "RSS 未变更，本轮跳过");
    stats.lastRunAt = new Date().toISOString();
    stats.lastDurationMs = Date.now() - started;
    return { ok: true, notModified: true };
  }

  const posts = fetched.entries.slice(0, config.maxPostsPerRound);
  const postById = new Map(posts.map((p) => [p.post_id, p]));
  stats.lastPostCount = posts.length;

  // ── 2. 取出本轮要服务的用户 ────────────────────────────────────────────
  // 单用户模式下只服务管理员：其他人的数据保留，但不再收到推送。
  // 这个过滤必须放在轮询里，否则关掉多用户模式后推送照旧。
  const multiUser = isMultiUserEnabled();
  const users = listUsers({ limit: 100_000, status: "active" })
    .filter((u) => u.telegram_id)
    .filter((u) => multiUser || isAdminUser(u));
  stats.lastUserCount = users.length;
  if (!users.length) {
    stats.lastRunAt = new Date().toISOString();
    stats.lastDurationMs = Date.now() - started;
    return { ok: true, posts: posts.length, users: 0 };
  }

  // AI 配置一次性批量取出，避免每个用户一次查询
  const aiRows = listEnabledAiConfigs();
  const aiByUser = new Map(aiRows.map((r) => [r.telegram_id, resolveAiConfig(r)]));

  // ── 3. 逐用户做匹配 ────────────────────────────────────────────────────
  // 匹配在 worker 线程池里执行，CPU 不占主线程
  const perUser = await mapLimitUsers(users, async (user) => {
    const uid = user.telegram_id;
    const keywords = loadKeywordsFor(uid);
    // 没有关键词就不推送 —— 这是明确的产品约定
    if (!keywords.length) return null;

    const seen = filterUnseen(uid, posts.map((p) => p.post_id));
    const fresh = posts.filter((p) => !seen.has(p.post_id));
    if (!fresh.length) return null;

    const matches = await matchPostsAsync(fresh, keywords);
    const hitIds = matches.filter((m) => m.matched.length).map((m) => m.post_id);

    // 未命中的帖子也要标记已见，否则每轮都会重复计算
    const consumed = fresh.map((p) => p.post_id);
    markSeen(uid, consumed);

    if (!hitIds.length) return null;

    const quota = effectiveQuota(user);
    const usage = getUsage(uid);
    const remaining = quota.dailyPush - usage.pushes;
    if (remaining <= 0) {
      if (shouldNotifyQuota(uid, "push")) {
        await sendMessage(
          uid,
          `⚠️ 你今日的推送配额已用尽（${usage.pushes}/${quota.dailyPush}），明天恢复。\n` +
            `如需调整请联系管理员。`
        );
      }
      return { uid, skipped: "push-quota" };
    }

    const selected = hitIds.slice(0, Math.min(config.maxPerUserPerRound, remaining));
    const matchedMap = new Map(matches.map((m) => [m.post_id, m.matched]));
    return {
      uid,
      user,
      posts: selected.map((id) => ({ post: postById.get(id), matched: matchedMap.get(id) || [] })),
      overflow: selected.length < hitIds.length ? hitIds.length : 0,
    };
  });

  // ── 4. 汇总待发送任务 ──────────────────────────────────────────────────
  const jobs = perUser.filter((x) => x && x.posts && x.posts.length);
  const pushJobs = [];

  for (const job of jobs) {
    const { uid, user, posts: hits } = job;
    const quota = effectiveQuota(user);
    const usage = getUsage(uid);
    const budget = Math.max(0, quota.dailyPush - usage.pushes);
    const usable = hits.slice(0, budget);

    // AI 摘要：只对配置了 AI 且还有配额的用户做
    let summaries = new Map();
    const ai = aiByUser.get(uid);
    if (ai && usable.length) {
      const aiQuota = quota.dailyAi;
      const aiUsed = getUsage(uid).ai_calls;
      const aiBudget = Math.max(0, aiQuota - aiUsed);
      if (aiBudget <= 0) {
        if (shouldNotifyQuota(uid, "ai")) {
          await sendMessage(uid, `⚠️ 你今日的 AI 摘要配额已用尽（${aiUsed}/${aiQuota}），明日恢复。`);
        }
      } else {
        const targets = usable
          .map(({ post }) => ({ post, body: plainText(post.content) }))
          .filter(({ body }) => body.length > 0 && body.length >= ai.minLen)
          .slice(0, Math.min(ai.maxPerRound, aiBudget));
        if (targets.length) {
          // 并发预取，但受全局信号量限制
          const results = await aiSemaphore.runAll(
            targets.map(({ post, body }) => async () => {
              const cn = CATEGORIES[post.category] || post.category;
              const s = await aiSummary(ai, post.title, body, cn);
              return { post_id: post.post_id, summary: s };
            })
          );
          for (const r of results) {
            if (r?.summary) summaries.set(r.post_id, r.summary);
          }
          const used = summaries.size;
          if (used > 0) {
            incrUsage(uid, "ai_calls", used);
            stats.lastAiCalls += used;
            const models = [...new Set([...summaries.values()].map((s) => s.model))];
            log.info("ai", `用户 ${uid} 生成 ${used}/${targets.length} 条摘要（${models.join("、")}）`);
          }
        }
      }
    }

    for (const { post, matched } of usable) {
      pushJobs.push({
        uid,
        post,
        matched,
        summary: summaries.get(post.post_id) || null,
      });
    }

    if (job.overflow > 0) {
      pushJobs.push({ uid, overflow: true, items: usable.map((h) => h.post), total: job.overflow });
    }
  }

  // ── 5. 并发发送 ────────────────────────────────────────────────────────
  // 不同 chat 并行，同一 chat 由 telegram.js 的锁串行
  const sendResults = await sendMany(
    pushJobs.map((j) => ({
      run: async () => {
        if (j.overflow) {
          return { ok: true, r: await sendMessage(j.uid, buildOverflowMsg(j.items, j.total)) };
        }
        const rich = buildRichNotifMsg(j.post, j.matched, j.summary);
        const okRich = await sendRichMessage(j.uid, rich);
        if (okRich) return { ok: true, rich: true };
        // 富文本失败 → 降级经典 HTML
        const r = await sendMessage(j.uid, buildNotifMsg(j.post, j.matched, j.summary));
        return { ok: r.ok === true, rich: false, r };
      },
    }))
  );

  // ── 6. 记账写历史 ──────────────────────────────────────────────────────
  let pushed = 0;
  for (let i = 0; i < pushJobs.length; i++) {
    const j = pushJobs[i];
    const sent = sendResults[i]?.ok === true;
    if (j.overflow) continue;
    for (const kw of j.matched.length ? j.matched : ["(none)"]) {
      logNotification(j.uid, j.post, kw, sent ? "sent" : "failed");
    }
    if (sent) pushed++;
  }
  // 按用户汇总推送数并一次性写用量
  const perUserPushed = new Map();
  for (let i = 0; i < pushJobs.length; i++) {
    if (pushJobs[i].overflow) continue;
    if (sendResults[i]?.ok) {
      perUserPushed.set(pushJobs[i].uid, (perUserPushed.get(pushJobs[i].uid) || 0) + 1);
    }
  }
  for (const [uid, n] of perUserPushed) incrUsage(uid, "pushes", n);

  stats.lastPushed = pushed;
  stats.lastRunAt = new Date().toISOString();
  stats.lastDurationMs = Date.now() - started;
  log.info(
    "poller",
    `本轮完成：${posts.length} 帖 / ${users.length} 用户 / 推送 ${pushed} 条 / 摘要 ${stats.lastAiCalls} 条 / 耗时 ${stats.lastDurationMs}ms`
  );

  return {
    ok: true,
    posts: posts.length,
    users: users.length,
    pushed,
    aiCalls: stats.lastAiCalls,
    durationMs: stats.lastDurationMs,
  };
}

// 用户级并发：SQLite 是同步的，过高的并发不会更快，反而拉长事件循环占用
async function mapLimitUsers(users, fn) {
  const out = new Array(users.length);
  const limit = Math.max(2, Math.min(8, config.workerPoolSize * 2 || 4));
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, users.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= users.length) return;
      try {
        out[i] = await fn(users[i], i);
      } catch (e) {
        log.error("poller", `用户 ${users[i].telegram_id} 处理失败: ${e.message}`);
        out[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

// ─── AI 信号量（带 runAll 辅助） ─────────────────────────────────────────────

class AiSemaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  /** 并发跑一批任务，返回与输入同序的结果 */
  async runAll(tasks) {
    const out = new Array(tasks.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(this.limit, tasks.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= tasks.length) return;
        await this.acquire();
        try {
          out[i] = await tasks[i]();
        } catch (e) {
          log.error("ai", `摘要任务失败: ${e.message}`);
          out[i] = null;
        } finally {
          this.release();
        }
      }
    });
    await Promise.all(runners);
    return out;
  }
  stats() {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}

export const aiSemaphore = new AiSemaphore(config.aiConcurrency);
