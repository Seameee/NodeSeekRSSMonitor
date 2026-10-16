// ============================================================================
// worker 线程池：直接验证「任务真的在线程里跑了」
//
// 这组用例存在的理由：其它测试只断言最终行为，而池失败时会**回退到进程内**，
// 所以即使线程池完全失效、每次都报「未知任务类型」再回退，那些测试照样通过。
// 这里直接打 pool.run()，拿不到正确结果就是失败。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { makeRss, teardown } from "./helpers.js";

const { pool } = await import("../src/worker-pool.js");
const { parseRSSAsync, matchPostsAsync } = await import("../src/worker-pool.js");

test.after(async () => {
  await teardown();
});

test("线程池：worker 确实拿到并执行了 parse 任务", async () => {
  if (pool.disabled) {
    console.log("    （WORKER_POOL_SIZE=0，池已禁用，跳过）");
    return;
  }
  const xml = makeRss([{ id: 123456, title: "绿云 年付促销", category: "trade", author: "alice" }]);

  // 直接调用，不经过任何回退逻辑：失败会 reject
  const res = await pool.run("parse", { xml, sourceIndex: 0 });
  assert.ok(Array.isArray(res), "parse 应返回数组");
  assert.equal(res.length, 1);
  assert.equal(res[0].post_id, 123456);
  assert.equal(res[0].title, "绿云 年付促销");
  assert.equal(res[0].category, "trade");
  assert.equal(res[0].author, "alice");
});

test("线程池：worker 确实拿到了并执行了 match 任务", async () => {
  if (pool.disabled) return;
  const matched = await pool.run("match", {
    posts: [
      { post_id: 1, title: "绿云 年付", category: "trade", source: 0 },
      { post_id: 2, title: "无关帖子", category: "daily", source: 0 },
    ],
    keywords: [{ keyword: "绿云", category: null, match_mode: "substring" }],
  });
  assert.equal(matched.length, 2);
  assert.deepEqual(matched[0].matched, ["绿云"], "第一条应命中");
  assert.deepEqual(matched[1].matched, [], "第二条不应命中");
});

test("线程池：包装函数在池可用时也走真实线程（结果与同步实现一致）", async () => {
  if (pool.disabled) return;
  const xml = makeRss([
    { id: 11, title: "搬瓦工 CN2 GIA 补货", category: "info" },
    { id: 12, title: "普通闲聊", category: "daily" },
  ]);
  const parsed = await parseRSSAsync(xml, 0);
  const { parseRSS } = await import("../src/rss-parse.js");
  assert.deepEqual(parsed, parseRSS(xml, 0), "线程内解析结果应与进程内完全一致");

  const m = await matchPostsAsync(
    [
      { post_id: 11, title: "搬瓦工 CN2 GIA 补货", category: "info", source: 0 },
      { post_id: 12, title: "普通闲聊", category: "daily", source: 0 },
    ],
    [{ keyword: "搬瓦工.*(CN2|GIA)", category: null, match_mode: "regex" }]
  );
  assert.deepEqual(m[0].matched, ["搬瓦工.*(CN2|GIA)"]);
  assert.deepEqual(m[1].matched, []);
});

test("线程池：超时保护会终止并重建 worker", async () => {
  if (pool.disabled) return;
  const before = pool.stats().alive;
  // 提交一个不可能完成的重活，靠超时把它判死
  const { config } = await import("../src/config.js");
  const work = pool.run("match", {
    posts: Array.from({ length: 200 }, (_, i) => ({
      post_id: i,
      title: "x".repeat(2000),
      category: "daily",
      source: 0,
    })),
    // 长度足够触发回溯但仍被静态检查放行的组合
    keywords: Array.from({ length: 200 }, () => ({
      keyword: "(a|b|c|d|e|f|g)+",
      category: null,
      match_mode: "regex",
    })),
  });
  // 不管成败，池都必须自我修复且仍能服务后续任务
  await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, config.workerTaskTimeoutMs + 3000))]);
  await new Promise((r) => setTimeout(r, 300));
  // 这里必须断言「恢复到原样」而不是「大于 0」：
  // 只判存活时，池少一个线程照样通过 —— 这正是下面那个退化 bug 藏身之处。
  assert.equal(
    pool.stats().alive,
    before,
    `池应恢复到超时前的线程数（超时前 ${before}，现在 ${pool.stats().alive}）`
  );

  const ok = await pool.run("parse", { xml: makeRss([{ id: 999, title: "恢复检查" }]), sourceIndex: 0 });
  assert.equal(ok[0].post_id, 999, "重建后仍应能正常处理任务");
});

test("线程池：连续多次超时后，线程数与空闲队列都不得退化", async () => {
  const { Pool } = await import("../src/worker-pool.js");
  // 用独立的小池子，把超时压到 200ms，以便确定性复现「回收」路径
  const p = new Pool(4, 200);
  try {
    assert.equal(p.stats().alive, 4, "初始应有 4 个线程");
    for (let i = 1; i <= 3; i++) {
      // (a+)+b 配一长串 a：灾难性回溯，必然超时 —— 正是超时保护要挡的攻击形态
      await assert.rejects(
        p.run("match", {
          posts: [{ post_id: 1, title: "a".repeat(40_000), category: "daily", source: 0 }],
          keywords: [{ keyword: "(a+)+b", category: null, match_mode: "regex" }],
        }),
        /计算超时/
      );
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(p.stats().alive, 4, `第 ${i} 次超时后线程数应仍为 4（实际 ${p.stats().alive}）`);
      assert.equal(p.stats().idle, 4, `第 ${i} 次超时后空闲队列不应膨胀（实际 ${p.stats().idle}）`);
    }
    const ok = await p.run("parse", { xml: makeRss([{ id: 999, title: "恢复检查" }]), sourceIndex: 0 });
    assert.equal(ok[0].post_id, 999, "多次超时后仍应能正常处理任务");
  } finally {
    await p.close();
  }
});
