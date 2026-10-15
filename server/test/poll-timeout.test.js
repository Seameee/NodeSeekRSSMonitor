// ============================================================================
// 长轮询超时分工
//
// 实际故障：tg() 给所有请求硬编码 20 秒 abort，而 getUpdates 用的是 25 秒
// 长轮询 —— 客户端永远比 Telegram 先超时。于是每次空闲轮询都被 abort，
// 内部还带 retries:1，等于 2×20s 全失败；返回 ok:false 后主循环再退避
// （最高 30s）。合起来最长约 70 秒收不到任何更新，用户命令全部积压，
// 表现为"发个命令要等半分钟"。
//
// 这里把三条约束钉死，避免以后改回去。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
// 只为副作用：helpers 会在其它模块被求值前灌好必需的环境变量
import { teardown } from "./helpers.js";

test.after(async () => {
  await teardown();
});

const { getUpdates, getUpdatesTimeoutMs, POLL_TIMEOUT_SEC } = await import("../src/telegram.js");

test("长轮询：客户端超时必须严格大于 Telegram 侧 timeout", () => {
  for (const sec of [1, 5, 10, 25, 50]) {
    const clientMs = getUpdatesTimeoutMs(sec);
    assert.ok(
      clientMs > sec * 1000,
      `timeout=${sec}s 时客户端只给了 ${clientMs}ms，会在服务端返回前抢先 abort`
    );
  }
  // 默认值也要满足
  assert.ok(getUpdatesTimeoutMs() > POLL_TIMEOUT_SEC * 1000);
});

/** 临时替换 fetch，记录每次调用的 URL 与 body */
function withFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || "{}") });
    return handler(calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("长轮询：失败时只请求一次，重试交给上层循环", async () => {
  const m = withFetch(() => json({ ok: false, description: "boom" }, 500));
  try {
    const r = await getUpdates(0, 1);
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 1, `内部不该重试，实际请求了 ${m.calls.length} 次`);
  } finally {
    m.restore();
  }
});

test("长轮询：正常拿到更新时请求一次即返回", async () => {
  const m = withFetch(() => json({ ok: true, result: [{ update_id: 7, message: { text: "/status" } }] }));
  try {
    const r = await getUpdates(0, 1);
    assert.equal(r.ok, true);
    assert.equal(r.result.length, 1);
    assert.equal(m.calls.length, 1);
    // 确实是以长轮询方式请求的
    assert.equal(m.calls[0].body.timeout, 1);
    assert.deepEqual(m.calls[0].body.allowed_updates, ["message", "callback_query"]);
  } finally {
    m.restore();
  }
});

test("长轮询：实际下发的 abort 定时器确实大于 Telegram 侧 timeout", async () => {
  // 只测导出函数不够——调用点可能没用它（这正是上一次修复漏掉的地方）。
  // 这里拦截 setTimeout，直接看 tg() 到底申请了多长的 abort。
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  const m = withFetch(() => json({ ok: true, result: [] }));
  try {
    await getUpdates(0, POLL_TIMEOUT_SEC);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    m.restore();
  }
  const abortDelay = delays.find((d) => d >= POLL_TIMEOUT_SEC * 1000);
  assert.ok(
    abortDelay,
    `getUpdates 应申请 ≥${POLL_TIMEOUT_SEC}s 的 abort 定时器，实际记录到 ${JSON.stringify(delays)}`
  );
});

test("长轮询：慢响应（超过旧的 20s 预算之外仍有余量）不会提前 abort", async () => {
  // 用 300ms 的慢响应模拟"服务端还在挂着"，只要没到客户端超时就该成功，
  // 不该出现 AbortError。
  const m = withFetch(
    () =>
      new Promise((resolve) => setTimeout(() => resolve(json({ ok: true, result: [] })), 300))
  );
  try {
    const r = await getUpdates(0, 1);
    assert.equal(r.ok, true, "慢响应在超时预算内应视为成功");
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});
