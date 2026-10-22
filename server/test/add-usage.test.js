// ============================================================================
// /add 的用法提示，以及正则长度上限
//
// 起因是两个实际使用中的问题：
//   1. 提示只写「/add 关键词」，用户不知道还能指定版块和 --regex；
//      真去发 /add 不带参数时，也只回一句「缺少关键词」就没了。
//   2. 正则上限 200 装不下常见的品牌名大列表 —— 实测一条 271 字符的被拒。
// 这里把这两件事都钉住，避免以后改回去。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeUpdate, teardown } from "./helpers.js";

test.after(async () => {
  await teardown();
});

const db = await import("../src/db.js");
const router = await import("../src/router.js");
const { validateRegex } = await import("../src/match.js");
const { config } = await import("../src/config.js");

const U = 5001;

function freshUser() {
  db.deleteUser(U);
  return db.createUser({ telegramId: U, username: "u", displayName: "U" });
}

/** 模拟真实场景：一串品牌名做交替，长度远超旧上限 200 */
function bigBrandRegex() {
  const brands = [
    "家人", "佳人", "bitsflow", "jttiluc", "ffelvision", "berol", "白丝",
    "cloudsilkl", "akko", "艾云", "iacloud", "咸鱼云", "saltyfish",
    "moelcloudlite", "moelnobrand", "legend", "华纳", "cdtbest", "breadskyline",
    "lightlayer", "geelinx", "panstar", "hostdzire", "leaseweb", "isvoro",
    "zouter", "shandun", "ciallo", "hosthatch", "绿云", "greencloud", "newb",
  ];
  return `^(?!.*收).*(${brands.join("|")})`;
}

test("正则上限：默认 500，容得下品牌名大列表", () => {
  assert.equal(config.maxRegexLen, 500, "默认上限应为 500");
  const re = bigBrandRegex();
  assert.ok(re.length > 200, `样例应超过旧上限 200，实际 ${re.length}`);
  assert.ok(re.length < config.maxRegexLen, `样例应在放宽后的上限内，实际 ${re.length}`);
  assert.equal(validateRegex(re).ok, true, "曾因超过 200 被拒的正则，现在应通过");
});

test("正则上限：超限时提示带上实际长度与上限", () => {
  const long = "a".repeat(config.maxRegexLen + 1);
  const r = validateRegex(long);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`当前 ${long.length} 字符`), "应说明当前实际长度");
  assert.match(r.reason, new RegExp(`上限 ${config.maxRegexLen}`), "应说明上限");
});

test("正则上限：放宽后仍拒绝灾难性回溯结构", () => {
  for (const bad of ["(a+)+", "(a*)*", "(a|a)+", "(x+){2,}", ".*.*.*", "(a)\\1"]) {
    assert.equal(validateRegex(bad).ok, false, `${bad} 必须被拒`);
  }
});

test("/add 缺参数时给出完整用法（含版块与 --regex）", async () => {
  const { sent } = installFetchMock();
  freshUser();
  await router.handleUpdate(makeUpdate("/add", { id: U }));
  const html = sent.at(-1).html;
  assert.match(html, /缺少关键词/);
  assert.match(html, /版块/, "必须提到版块，否则用户不知道能按分区过滤");
  assert.match(html, /--regex/, "必须提到 --regex");
  assert.match(html, /daily/, "应列出可用版块代码");
});

test("/list 无关键词时也给出同一份用法", async () => {
  const { sent } = installFetchMock();
  freshUser();
  await router.handleUpdate(makeUpdate("/list", { id: U }));
  const html = sent.at(-1).html;
  assert.match(html, /版块/, "空列表提示也要讲清版块");
  assert.match(html, /--regex/);
});

test("/bind 成功后的提示包含版块信息", async () => {
  const { sent } = installFetchMock();
  const newcomer = 5099;
  db.deleteUser(newcomer);
  await router.handleUpdate(makeUpdate("/bind", { id: newcomer, username: "nb" }));
  assert.match(sent.at(-1).html, /add 关键词 \[版块\]/, "应写出完整的 /add 形式");
});

// ─── 多版块拆分（与 Worker 版行为一致）────────────────────────────────────────

const S = 5100;

function freshSplitUser() {
  db.deleteUser(S);
  return db.createUser({ telegramId: S, username: "s", displayName: "S" });
}

test("/add：逗号分隔的多个版块拆成多条单版块记录", async () => {
  const { sent } = installFetchMock();
  freshSplitUser();
  await router.handleUpdate(makeUpdate("/add 绿云 daily,tech,info --regex", { id: S }));

  const rows = db.listKeywords(S);
  assert.equal(rows.length, 3, `应插入 3 条，实际 ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => r.category).sort(),
    ["daily", "info", "tech"],
    "每条只带一个版块"
  );
  for (const r of rows) {
    assert.equal(r.keyword, "绿云");
    assert.equal(r.match_mode, "regex");
    assert.equal(r.enabled, 1);
  }
  assert.match(sent.at(-1).html, /已添加/, "应回执已添加");
  assert.match(sent.at(-1).html, /当前 3\/20/, "配额应按实际条数计");
});

test("/add：单个版块只插入一条", async () => {
  const { sent } = installFetchMock();
  freshSplitUser();
  await router.handleUpdate(makeUpdate("/add 搬瓦工 trade", { id: S }));
  const rows = db.listKeywords(S);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "trade");
  assert.match(sent.at(-1).html, /当前 1\/20/);
});

test("/add：不带版块时插入一条无版块记录", async () => {
  installFetchMock();
  freshSplitUser();
  await router.handleUpdate(makeUpdate("/add 补货", { id: S }));
  const rows = db.listKeywords(S);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, null, "无版块应为 null（全部版块）");
});

test("/add：配额按拆分后的条数校验，不足时整批拒绝", async () => {
  const { sent } = installFetchMock();
  const admin = 1000; // 预置管理员，配额不限，先塞满普通用户
  db.deleteUser(admin);
  db.createUser({ telegramId: admin, username: "admin", role: "admin" });
  freshSplitUser();
  // 先占满普通用户的 20 条
  for (let i = 0; i < 20; i++) {
    db.addKeyword(S, `k${i}`, null, "substring");
  }
  db.bumpKeywordRevision(S);

  await router.handleUpdate(makeUpdate("/add 新词 daily,tech", { id: S }));
  assert.equal(db.listKeywords(S).length, 20, "超配额时不得插入任何一条");
  assert.match(sent.at(-1).html, /关键词数量不足/, "应提示数量不足");
});

test("/add：部分版块已存在时只插入缺的那些", async () => {
  const { sent } = installFetchMock();
  freshSplitUser();
  await router.handleUpdate(makeUpdate("/add 绿云 daily", { id: S }));
  await router.handleUpdate(makeUpdate("/add 绿云 daily,tech", { id: S }));

  const rows = db.listKeywords(S);
  assert.equal(rows.length, 2, "daily 已存在只补 tech，共 2 条");
  assert.deepEqual(rows.map((r) => r.category).sort(), ["daily", "tech"]);
  assert.match(sent.at(-1).html, /已存在/, "应说明有跳过");
});
