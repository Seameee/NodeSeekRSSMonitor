// ============================================================================
// 批量操作：/remove、/pause、/resume 的多目标选择器
//
// 背景：单用户关键词上限 20 条，而实际一条往往是几百字符的品牌名正则。
// 逐条删/暂停要发 20 次命令 —— 纯操作成本。这里钉住批量写法与几个易错点。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeUpdate, teardown } from "./helpers.js";

test.after(async () => {
  await teardown();
});

const db = await import("../src/db.js");
const router = await import("../src/router.js");

const U = 6001;

function freshUser() {
  db.deleteUser(U);
  return db.createUser({ telegramId: U, username: "bulk", displayName: "Bulk" });
}

/** 铺 n 条关键词，返回创建后的行（按 id 顺序，即 /list 的顺序） */
function seed(n, { prefix = "kw" } = {}) {
  freshUser();
  for (let i = 0; i < n; i++) db.addKeyword(U, `${prefix}${i + 1}`, null, "substring");
  db.bumpKeywordRevision(U);
  return db.listKeywords(U);
}

const send = async (text) => {
  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate(text, { id: U }));
  return sent.at(-1)?.html ?? "";
};

const names = () => db.listKeywords(U).map((k) => k.keyword);

// ─── /remove ────────────────────────────────────────────────────────────────

test("/remove：多个序号（空格分隔）一次删掉", async () => {
  seed(5);
  const html = await send("/remove 1 3 5");
  assert.deepEqual(names(), ["kw2", "kw4"], `应只剩 kw2 kw4，实际 ${names().join(",")}`);
  assert.match(html, /已删除/);
  assert.match(html, /剩 2 条/);
});

test("/remove：逗号分隔与中文逗号都认", async () => {
  seed(5);
  await send("/remove 1,3");
  assert.deepEqual(names(), ["kw2", "kw4", "kw5"]);
  seed(5);
  await send("/remove 1，3");
  assert.deepEqual(names(), ["kw2", "kw4", "kw5"], "中文逗号也应能分隔");
});

test("/remove：范围写法 1-3", async () => {
  seed(5);
  await send("/remove 1-3");
  assert.deepEqual(names(), ["kw4", "kw5"]);
});

test("/remove：范围反向（5-3）等价于 3-5，不报错也不漏删", async () => {
  seed(5);
  const html = await send("/remove 5-3");
  assert.deepEqual(names(), ["kw1", "kw2"], "5-3 应按 3~5 处理");
  assert.doesNotMatch(html, /未处理/);
});

test("/remove：序号必须按删除前的快照解析，不能边删边取下标", async () => {
  // 这是最容易写错的地方：先删 1 之后，原第 2 条变成第 1 条，
  // 若边删边取就会把 kw3 当成「第 2 条」删掉。
  seed(4);
  await send("/remove 1 2");
  assert.deepEqual(names(), ["kw3", "kw4"], "应按原始序号删掉 kw1 kw2");
});

test("/remove：重复序号只删一次", async () => {
  seed(3);
  const html = await send("/remove 1 1 1");
  assert.deepEqual(names(), ["kw2", "kw3"]);
  assert.match(html, /已删除 <b>1<\/b> 条/);
});

test("/remove：仍支持按关键词名精确删除", async () => {
  seed(3);
  await send("/remove kw2");
  assert.deepEqual(names(), ["kw1", "kw3"]);
});

test("/remove：序号+关键词混用", async () => {
  seed(4);
  await send("/remove 1 kw4");
  assert.deepEqual(names(), ["kw2", "kw3"]);
});

test("/remove：越界序号只报问题，不影响其它目标", async () => {
  seed(3);
  const html = await send("/remove 1 99");
  assert.deepEqual(names(), ["kw2", "kw3"], "有效的那条仍应删掉");
  assert.match(html, /未处理/, "应提示有未处理项");
  assert.match(html, /99/);
});

test("/remove all：第一次只要求确认，不执行删除", async () => {
  seed(4);
  const html = await send("/remove all");
  assert.equal(db.listKeywords(U).length, 4, "未确认时不得删除任何一条");
  assert.match(html, /全部 4 条/);
  assert.match(html, /\/remove all confirm/, "必须告诉用户怎么确认");
});

test("/remove all confirm：确认后清空", async () => {
  seed(4);
  const html = await send("/remove all confirm");
  assert.equal(db.listKeywords(U).length, 0);
  assert.match(html, /已删除 <b>4<\/b> 条/);
});

test("/remove：all 与其它选择器混用应被拒绝", async () => {
  seed(3);
  const html = await send("/remove all 2");
  assert.equal(db.listKeywords(U).length, 3, "混用时不得删任何一条");
  assert.match(html, /不能和其它/);
});

test("/remove：关键词名里含中文时也能按名删除", async () => {
  freshUser();
  db.addKeyword(U, "绿云", "trade", "substring");
  db.addKeyword(U, "搬瓦工", null, "substring");
  db.bumpKeywordRevision(U);
  await send("/remove 绿云");
  assert.deepEqual(names(), ["搬瓦工"]);
});

// ─── /pause /resume ─────────────────────────────────────────────────────────

const enabledOf = () => db.listKeywords(U).map((k) => (k.enabled ? 1 : 0));

test("/pause：多个序号一起暂停", async () => {
  seed(4);
  const html = await send("/pause 1 3");
  assert.deepEqual(enabledOf(), [0, 1, 0, 1]);
  assert.match(html, /已暂停 <b>2<\/b> 条/);
});

test("/pause all：暂停全部", async () => {
  seed(3);
  await send("/pause all");
  assert.deepEqual(enabledOf(), [0, 0, 0]);
});

test("/resume all：恢复全部", async () => {
  seed(3);
  await send("/pause all");
  assert.deepEqual(enabledOf(), [0, 0, 0]);
  await send("/resume all");
  assert.deepEqual(enabledOf(), [1, 1, 1]);
});

test("/pause：已经暂停的会跳过并说明，不重复写库", async () => {
  seed(3);
  await send("/pause 1");
  const html = await send("/pause 1 2");
  assert.deepEqual(enabledOf(), [0, 0, 1]);
  assert.match(html, /已暂停 <b>1<\/b> 条/);
  assert.match(html, /跳过/, "应说明有跳过");
});

test("/pause：全部已是该状态时明确告知，而不是假装成功", async () => {
  seed(2);
  await send("/pause all");
  const html = await send("/pause all");
  assert.match(html, /本来就/, "应指出本来就是暂停状态");
  assert.match(html, /未做改动/);
});

test("/pause：范围写法", async () => {
  seed(4);
  await send("/pause 2-4");
  assert.deepEqual(enabledOf(), [1, 0, 0, 0]);
});

// ─── 边界与安全 ─────────────────────────────────────────────────────────────

test("批量：无关键词时给出明确回复，不报错", async () => {
  freshUser();
  const html = await send("/remove 1");
  assert.match(html, /暂无关键词/);
});

test("批量：缺参数时给出完整用法（含 all 与范围）", async () => {
  seed(2);
  for (const cmd of ["/remove", "/pause", "/resume"]) {
    const html = await send(cmd);
    assert.match(html, /用法/, `${cmd} 应给用法`);
    assert.match(html, /all/, `${cmd} 的用法里应有 all`);
    assert.match(html, /1-5/, `${cmd} 的用法里应有范围示例`);
  }
});

test("批量：不能操作别人的关键词（按序号只在本人的列表里取）", async () => {
  const other = 6002;
  db.deleteUser(other);
  db.createUser({ telegramId: other, username: "o", displayName: "O" });
  db.addKeyword(other, "victim", null, "substring");
  db.bumpKeywordRevision(other);

  seed(2); // U 只有 2 条
  await send("/remove 3"); // 越界，不能跳到别人那里
  assert.deepEqual(names(), ["kw1", "kw2"], "不得删到别的用户");
  assert.equal(db.listKeywords(other).length, 1, "另一个用户的关键词必须完好");

  db.deleteUser(other);
});

test("批量：删除后修订号递增，匹配缓存会失效", async () => {
  seed(3);
  const { getSetting, keywordRevisionKey } = await import("../src/db.js");
  const revOf = () => Number.parseInt(getSetting(keywordRevisionKey(U), "0"), 10);
  const before = revOf();
  await send("/remove 1");
  const after = revOf();
  assert.ok(after > before, `删除后必须 bump 修订号（${before} → ${after}），否则旧缓存仍按 3 条匹配`);
});

test("批量：结果里长正则被截断，避免消息超长", async () => {
  freshUser();
  const longRe = `^(?!.*收).*(${Array.from({ length: 30 }, (_, i) => `brand${i}`).join("|")})`;
  db.addKeyword(U, longRe, null, "regex");
  db.addKeyword(U, longRe, "trade", "regex");
  db.bumpKeywordRevision(U);
  const html = await send("/pause all");
  assert.ok(longRe.length > 100, "前提：样例确实很长");
  assert.ok(html.includes("…"), "长关键词应被截断显示");
  assert.ok(html.length < 4096, `结果消息不应超过 Telegram 上限，实际 ${html.length}`);
});

test("批量：结果带上 /list 的序号（同一正则按版块拆多条时能分清）", async () => {
  // 真实场景：一条品牌名正则按 daily/tech/info/expose/trade 拆成 5 条，
  // 关键词文本完全相同，只有版块不同。结果里若不带序号，
  // 用户完全无法把这些行和 /list 里的位置对应起来。
  freshUser();
  const re = "^(?!.*收).*(家人|佳人|bitsflow|绿云)";
  for (const cat of ["daily", "tech", "info", "expose", "trade"]) {
    db.addKeyword(U, re, cat, "regex");
  }
  db.bumpKeywordRevision(U);

  const html = await send("/pause 1 3 5");
  for (const n of [1, 3, 5]) {
    assert.match(html, new RegExp(`(^|\\n)${n}\\. `), `应带序号 ${n}.`);
  }
  assert.doesNotMatch(html, /(^|\n)2\. /, "未被选中的序号不应出现");
  assert.doesNotMatch(html, /(^|\n)4\. /);
});

test("批量：关键词本身含空格时，仍能按完整名称操作（旧行为不能丢）", async () => {
  // 回归用例。加入批量之前，/remove 是把**整个参数**当一个关键词名去比对的，
  // 所以 `/remove 绿云 补货` 能删掉名为「绿云 补货」的那一条。
  // 改成按空格切分后，它被拆成两个不存在的词，直接报「没有匹配到关键词」。
  freshUser();
  db.addKeyword(U, "绿云 补货", null, "substring");
  db.addKeyword(U, "搬瓦工", null, "substring");
  db.bumpKeywordRevision(U);

  const html = await send("/pause 绿云 补货");
  assert.match(html, /已暂停 <b>1<\/b> 条/, `含空格的关键词应被整体匹配，实际回复：${html}`);
  assert.equal(db.listKeywords(U)[0].enabled, 0, "「绿云 补货」应被暂停");
  assert.equal(db.listKeywords(U)[1].enabled, 1, "「搬瓦工」不应受影响");
});

test("批量：含空格关键词与普通批量写法可以共存", async () => {
  freshUser();
  db.addKeyword(U, "绿云 补货", null, "substring");
  db.addKeyword(U, "搬瓦工", null, "substring");
  db.addKeyword(U, "hostdzire", null, "substring");
  db.bumpKeywordRevision(U);

  // 多个不含空格的名字 -> 走批量
  await send("/pause 搬瓦工 hostdzire");
  let enabled = db.listKeywords(U).map((k) => k.enabled);
  assert.deepEqual(enabled, [1, 0, 0], "两个名字都应被暂停，含空格那条不动");

  // 含空格的完整名称 -> 走单条
  await send("/pause 绿云 补货");
  enabled = db.listKeywords(U).map((k) => k.enabled);
  assert.deepEqual(enabled, [0, 0, 0]);
});

test("批量：正则里带空格时也能按完整名称暂停", async () => {
  freshUser();
  const re = "补货 .*(CN2|GIA)";
  db.addKeyword(U, re, "trade", "regex");
  db.bumpKeywordRevision(U);
  const html = await send(`/pause ${re}`);
  assert.match(html, /已暂停 <b>1<\/b> 条/, `正则含空格应整体匹配，实际：${html}`);
  assert.equal(db.listKeywords(U)[0].enabled, 0);
});
