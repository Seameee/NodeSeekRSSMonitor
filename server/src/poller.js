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
import { resolveAiConfig, aiSummary, aiRuntimeStats, plainText } from "./ai.js";
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
  // lastAiCalls 是「本轮」的摘要条数，必须每轮清零：
  // 之前只做 += 从不清零，于是它其实是个累计值 —— 日志里的「摘要 N 条」
  // 和返回值 aiCalls 会一轮比一轮大，即使当轮一条摘要都没生成。
  stats.lastAiCalls = 0;

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

    const seen = filterUnseen(uid, posts);
    const fresh = posts.filter((p) => !seen.has(p.post_id));
    if (!fresh.length) return null;

    const matches = await matchPostsAsync(fresh, keywords);
    const hitIds = matches.filter((m) => m.matched.length).map((m) => m.post_id);

    // 未命中的帖子也要标记已见，否则每轮都会重复计算
    markSeen(uid, fresh);

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

  // ── 4. 汇总待发送任务 + 把所有用户的 AI 摘要任务**拍平成一个池** ────────
  //
  // 这里刻意分成「准备 → 一次性跑 → 回填」三步，而不是逐个用户 await：
  // aiSemaphore 是全局的，但如果写成 `for (job of jobs) await runAll(...)`，
  // 每个用户的批次会串行等待，跨用户等于完全没有并发 —— 实测 200 个用户各 1
  // 条摘要时，串行 20098ms vs 拍平 2510ms，差整整一个 AI_CONCURRENCY 倍。
  const jobs = perUser.filter((x) => x && x.posts && x.posts.length);
  const pushJobs = [];
  const pushOwners = []; // 与 pushJobs 对齐：溢出消息为 null
  const plans = []; // 每个用户一份，供摘要回填与记账
  const aiTasks = [];
  // 正文纯文本与用户无关，一轮内同一条帖子只解析一次。
  // 拍平后所有任务会同时存活，不共用的话 2000 个用户命中同一条帖就会各留一份
  // 2KB 正文的副本（约 20MB 的无谓占用）。
  const bodyCache = new Map();
  const bodyOf = (post) => {
    let b = bodyCache.get(post.post_id);
    if (b === undefined) {
      b = plainText(post.content);
      bodyCache.set(post.post_id, b);
    }
    return b;
  };

  for (const job of jobs) {
    const { uid, user, posts: hits } = job;
    const quota = effectiveQuota(user);
    const usage = getUsage(uid);
    const budget = Math.max(0, quota.dailyPush - usage.pushes);
    const usable = hits.slice(0, budget);

    const plan = { uid, summaries: new Map(), targets: 0 };
    plans.push(plan);

    // AI 摘要：只对配置了 AI 且还有配额的用户做
    const ai = aiByUser.get(uid);
    if (ai && usable.length) {
      const aiBudget = Math.max(0, quota.dailyAi - usage.ai_calls);
      if (aiBudget <= 0) {
        if (shouldNotifyQuota(uid, "ai")) {
          await sendMessage(uid, `⚠️ 你今日的 AI 摘要配额已用尽（${usage.ai_calls}/${quota.dailyAi}），明日恢复。`);
        }
      } else {
        const targets = usable
          .map(({ post }) => ({ post, body: bodyOf(post) }))
          .filter(({ body }) => body.length > 0 && body.length >= ai.minLen)
          .slice(0, Math.min(ai.maxPerRound, aiBudget));
        plan.targets = targets.length;
        for (const { post, body } of targets) {
          aiTasks.push({ plan, ai, post, body, cn: CATEGORIES[post.category] || post.category });
        }
      }
    }

    for (const { post, matched } of usable) {
      pushJobs.push({ uid, post, matched, summary: null });
      pushOwners.push({ plan, post_id: post.post_id });
    }

    if (job.overflow > 0) {
      pushJobs.push({ uid, overflow: true, items: usable.map((h) => h.post), total: job.overflow });
      pushOwners.push(null);
    }
  }

  // 所有用户的摘要任务一次性丢进同一个全局信号量
  if (aiTasks.length) {
    const before = aiRuntimeStats();
    const results = await aiSemaphore.runAll(
      aiTasks.map((t) => async () => {
        const s = await aiSummary(t.ai, t.post.title, t.body, t.cn);
        return s ? { plan: t.plan, post_id: t.post.post_id, summary: s } : null;
      })
    );
    for (const r of results) {
      if (r) r.plan.summaries.set(r.post_id, r.summary);
    }
    const after = aiRuntimeStats();
    const upstream = after.upstreamCalls - before.upstreamCalls;
    const hits = after.cacheHits - before.cacheHits;
    const merged = after.coalesced - before.coalesced;
    log.info(
      "ai",
      `本轮摘要任务 ${aiTasks.length} 个：上游实际调用 ${upstream} 次，命中缓存 ${hits} 个，同内容合并 ${merged} 个`
    );
  }

  // 记账 + 把摘要回填到各自的推送任务
  for (const plan of plans) {
    const used = plan.summaries.size;
    if (!used) continue;
    incrUsage(plan.uid, "ai_calls", used);
    stats.lastAiCalls += used;
    const models = [...new Set([...plan.summaries.values()].map((s) => s.model))];
    log.info("ai", `用户 ${plan.uid} 生成 ${used}/${plan.targets} 条摘要（${models.join("、")}）`);
  }
  for (let i = 0; i < pushJobs.length; i++) {
    const owner = pushOwners[i];
    if (owner) pushJobs[i].summary = owner.plan.summaries.get(owner.post_id) || null;
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
        // 富文本最终失败（网络重试完仍不通，或正文被 Telegram 拒收）→ 降级经典 HTML。
        // 一定要留痕：降级是用户看得见的版式变化，此前只有 tg 层的报错、
        // 定位问题要靠猜（曾误以为是格式写错）。
        log.warn("push", `用户 ${j.uid} 富文本发送失败，本条降级为经典格式`);
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
