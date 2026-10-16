// ============================================================================
// 运行模式：单用户 / 多用户、首个用户认领管理员、管理员运行时切换
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeUpdate, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const config = (await import("../src/config.js")).config;
const router = await import("../src/router.js");

test.after(async () => {
  await teardown();
});

const OWNER = 6001; // 首个 /bind 的人
const OTHER = 6002; // 后来的普通用户

/** 清空整个用户表，模拟「全新部署、还没人认领」 */
function wipeAllUsers() {
  for (const u of db.listUsers({ limit: 100_000 })) db.deleteUser(u.telegram_id);
  db.resetMultiUserEnabled();
  assert.equal(db.countUsers(), 0, "前置条件：库应为空");
}

// ─── 首次认领 ────────────────────────────────────────────────────────────────

test("认领：单用户模式下第一个 /bind 的人成为管理员", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(false); // 模拟 MULTI_USER_ENABLED=false 的部署

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER, username: "owner" }));

  const u = db.getUser(OWNER);
  assert.ok(u, "应创建用户");
  assert.equal(u.role, "admin", "首个用户必须是管理员");
  assert.equal(db.isAdminUser(u), true);
  assert.match(sent.at(-1).html, /管理员/, "应告知其已成为管理员");
  assert.match(sent.at(-1).html, /单用户/);
});

test("认领：多用户模式下第一个 /bind 的人同样成为管理员", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(true);

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER, username: "owner" }));
  assert.equal(db.getUser(OWNER).role, "admin", "多用户模式下首个用户也是管理员");
  assert.match(sent.at(-1).html, /管理员/);
});

test("认领：只有第一个是管理员，第二个是普通用户", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(true);

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER, username: "owner" }));
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER, username: "other" }));

  assert.equal(db.getUser(OWNER).role, "admin");
  assert.equal(db.getUser(OTHER).role, "user", "第二个用户不该是管理员");
});

test("认领：所有权写入审计日志", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(false);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  const rows = db.listAudit(20);
  assert.ok(rows.some((r) => r.action === "claim_ownership"), "应有认领审计记录");
});

// ─── 单用户模式的封闭性 ──────────────────────────────────────────────────────

test("单用户模式：陌生人 /bind 被拒绝，不创建账号", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(false);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER })); // 认领

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));
  assert.equal(db.getUser(OTHER), null, "单用户模式下不应创建新账号");
  assert.match(sent.at(-1).html, /单用户模式/);
});

test("单用户模式：已注册的普通用户被挡住，但数据保留", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(true);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));
  db.addKeyword(OTHER, "绿云", null, "substring");

  // 管理员关掉多用户模式
  db.setMultiUserEnabled(false);

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/list", { id: OTHER }));
  assert.match(sent.at(-1).html, /单用户模式/, "应被拒绝并说明原因");
  assert.doesNotMatch(sent.at(-1).html, /我的关键词/, "不应返回关键词内容");
  assert.equal(db.listKeywords(OTHER).length, 1, "关键词数据必须保留");
});

test("单用户模式：管理员自己不受影响", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(false);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  db.addKeyword(OWNER, "绿云", null, "substring");

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/list", { id: OWNER }));
  assert.match(sent.at(-1).html, /我的关键词/, "管理员应能正常使用");
});

// ─── 管理员运行时切换 ────────────────────────────────────────────────────────

test("切换：/admin multiuser on 立刻开放注册", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(false);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/admin multiuser on", { id: OWNER }));
  assert.match(sent.at(-1).html, /多用户模式/);
  assert.equal(db.isMultiUserEnabled(), true);

  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));
  assert.ok(db.getUser(OTHER), "开启后新用户应能注册");
  assert.equal(db.getUser(OTHER).role, "user");
});

test("切换：/admin multiuser off 立刻收回，他人无法再用", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(true);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/admin multiuser off", { id: OWNER }));
  assert.equal(db.isMultiUserEnabled(), false);

  await router.handleUpdate(makeUpdate("/status", { id: OTHER }));
  assert.match(sent.at(-1).html, /单用户模式/);
});

test("切换：覆盖值持久化且优先于环境变量", async () => {
  wipeAllUsers();
  // 环境变量是 true（见 helpers.js）。这里把覆盖值设成相反的 false，
  // 才能真正验证「管理员覆盖 > 环境变量」，而不是两边恰好相同。
  assert.equal(config.multiUserEnabled, true, "前置条件：环境变量为 true");

  db.setMultiUserEnabled(false);
  assert.equal(db.getSetting("multi_user_enabled"), "0", "覆盖值应写进 settings 表");
  assert.equal(db.isMultiUserOverridden(), true);
  assert.equal(db.isMultiUserEnabled(), false, "覆盖值 false 应压过环境变量 true");
});

test("切换：multiuser default 清除覆盖，回到环境变量", async () => {
  wipeAllUsers();
  assert.equal(config.multiUserEnabled, true, "前置条件：环境变量为 true");

  // 覆盖成与环境变量相反的值，再清除覆盖
  db.setMultiUserEnabled(false);
  assert.equal(db.isMultiUserEnabled(), false);

  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER })); // 认领管理员
  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/admin multiuser default", { id: OWNER }));

  assert.equal(db.isMultiUserOverridden(), false, "覆盖应被清除");
  assert.equal(db.isMultiUserEnabled(), config.multiUserEnabled, "应回到环境变量的值 true");
  assert.equal(db.isMultiUserEnabled(), true);
});

test("切换：普通用户无权切换模式", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(true);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));
  const before = db.isMultiUserEnabled();

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/admin multiuser off", { id: OTHER }));
  assert.equal(db.isMultiUserEnabled(), before, "模式不应被普通用户改动");
  assert.doesNotMatch(sent.at(-1).html, /已切换/);
});

// ─── 管理员不受配额限制 ──────────────────────────────────────────────────────

test("配额：管理员不受限，普通用户默认 AI 不限、推送受限", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(true);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));

  const adminQuota = db.effectiveQuota(db.getUser(OWNER));
  const userQuota = db.effectiveQuota(db.getUser(OTHER));

  assert.equal(adminQuota.dailyAi, Infinity, "管理员 AI 配额应为不限");
  assert.equal(adminQuota.maxKeywords, Infinity, "管理员关键词数应为不限");
  // AI 默认配额是 0，语义为「不限」，effectiveQuota 会映射成 Infinity
  assert.equal(config.defaultDailyAiQuota, 0, "AI 默认配额应为 0（不限）");
  assert.equal(userQuota.dailyAi, Infinity, "普通用户默认 AI 也不限");
  assert.equal(userQuota.dailyPush, config.defaultDailyPushQuota, "普通用户推送用默认配额");
  assert.equal(db.formatQuota(Infinity), "不限");
  assert.equal(db.formatQuota(20), "20");
});

test("配额：AI 配额设成正数即收紧，设回 0 又不限", () => {
  wipeAllUsers();
  const uid = 7301;
  db.deleteUser(uid);
  db.createUser({ telegramId: uid, username: "q" });

  db.setUserQuota(uid, "daily_ai_quota", 5);
  assert.equal(db.effectiveQuota(db.getUser(uid)).dailyAi, 5, "设为 5 应生效");

  db.setUserQuota(uid, "daily_ai_quota", 0);
  assert.equal(db.effectiveQuota(db.getUser(uid)).dailyAi, Infinity, "设回 0 表示不限");
});

test("配额：管理员 /status 显示不限", async () => {
  wipeAllUsers();
  db.setMultiUserEnabled(false);
  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/status", { id: OWNER }));
  assert.match(sent.at(-1).html, /不限/);
  assert.match(sent.at(-1).html, /管理员/);
});

// ─── 推送侧的模式过滤 ────────────────────────────────────────────────────────
// 这条用例专门防止「关掉多用户模式但照旧推送」——纯命令层测试发现不了。

test("推送：单用户模式下不向非管理员推送，但其数据保留", async () => {
  const poller = await import("../src/poller.js");
  const { installFetchMock: mk, makeRss: rss } = await import("./helpers.js");

  wipeAllUsers();
  db.setMultiUserEnabled(true);
  mk();
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER }));
  await router.handleUpdate(makeUpdate("/bind", { id: OTHER }));

  // 两人都有关键词，都盯同一条帖子
  for (const id of [OWNER, OTHER]) {
    db.addKeyword(id, "绿云", null, "substring");
    poller.invalidateKeywordCache(id);
  }
  const posts = rss([{ id: 700001, title: "绿云 促销", category: "trade", content: "正文" }]);

  // 多用户模式：两人都该收到
  let mock = mk({ rssXml: posts });
  await poller.runRound();
  assert.equal(mock.sent.filter((m) => m.chatId === OWNER).length, 1, "管理员应收 1 条");
  assert.equal(mock.sent.filter((m) => m.chatId === OTHER).length, 1, "多用户模式下普通用户应收 1 条");

  // 关闭多用户模式，换一条新帖
  db.setMultiUserEnabled(false);
  const posts2 = rss([{ id: 700002, title: "绿云 新帖", category: "trade", content: "正文" }]);
  mock = mk({ rssXml: posts2 });
  await poller.runRound();

  assert.equal(mock.sent.filter((m) => m.chatId === OWNER).length, 1, "管理员仍应收到推送");
  assert.equal(
    mock.sent.filter((m) => m.chatId === OTHER).length,
    0,
    "单用户模式下不应再向普通用户推送"
  );
  assert.equal(db.listKeywords(OTHER).length, 1, "普通用户的关键词数据必须保留");

  db.setMultiUserEnabled(true); // 还原，避免影响后续用例
});

test("worker 池默认值：按容器可用 CPU 取值（不能用 os.cpus，它报的是宿主机核数）", async () => {
  const { config } = await import("../src/config.js");
  const os = await import("node:os");
  assert.ok(config.cpuCount >= 1, `cpuCount 应为正整数（实际 ${config.cpuCount}）`);
  if (process.env.WORKER_POOL_SIZE) return; // 显式配置时不校验默认值
  assert.equal(
    config.workerPoolSize,
    Math.max(2, Math.min(4, config.cpuCount)),
    `默认池子大小应 = max(2,min(4,可用CPU))（cpuCount=${config.cpuCount}）`
  );
  assert.ok(config.cpuCount <= os.cpus().length, "可用 CPU 不应超过宿主机核数");
});
