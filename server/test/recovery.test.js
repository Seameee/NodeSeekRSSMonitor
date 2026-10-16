// ============================================================================
// 审查报告 F1 / F2 的回归测试
//
// F1：单用户模式（默认）下，ADMIN_TELEGRAM_IDS 找回管理权的路径曾完全失效——
//     陌生人在库里认领后，白名单里的真主人既进不了 /admin（isAdminUser 对
//     未注册 ID 直接 false），又会被单用户模式挡住 /bind，彻底死锁。
// F2：/admin del 删号后同 ID 重绑会复用删除前的关键词缓存（幽灵关键词），
//     因为 deleteUser 没清 kwrev 修订号、也没失效进程内 kwCache。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeRss, makeUpdate, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const router = await import("../src/router.js");
const poller = await import("../src/poller.js");
const { config } = await import("../src/config.js");

test.after(async () => {
  await teardown();
});

const STRANGER = 8101;
const OWNER = 8102;

test("F1：事后补上白名单，真主人能 /bind 找回管理权", async () => {
  for (const u of db.listUsers({ limit: 100_000 })) db.deleteUser(u.telegram_id);
  config.adminIds.clear();
  db.setMultiUserEnabled(false); // 单用户（默认模式）
  const { sent } = installFetchMock();

  // 场景起点：未配白名单，陌生人抢先认领（此时确实无人能管，认领是合理的）
  await router.handleUpdate(makeUpdate("/bind", { id: STRANGER, username: "stranger" }));
  assert.equal(db.getUser(STRANGER)?.role, "admin", "无白名单时首个用户应认领为管理员");

  // 运维发现后补上 ADMIN_TELEGRAM_IDS 并重启（这里以运行时加白名单模拟）
  config.adminIds.add(OWNER);

  // 白名单主人 /bind —— 修复前这里会被「本实例当前为单用户模式」拒绝
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER, username: "owner" }));
  const owner = db.getUser(OWNER);
  assert.ok(owner, "白名单管理员应能建号（修复前为 null）");
  assert.equal(owner.role, "admin", "白名单用户建号即为管理员");

  // 并且能进入管理面板
  await router.handleUpdate(makeUpdate("/admin stats", { id: OWNER }));
  assert.ok(
    /全局统计|管理员面板/.test(sent.at(-1)?.html || ""),
    "白名单管理员应能进入管理面板"
  );

  config.adminIds.delete(OWNER);
  db.resetMultiUserEnabled();
});

test("F1：未注册但在白名单里的 ID，isAdminUser 应认可", () => {
  const uid = 8199;
  db.deleteUser(uid);
  assert.equal(db.isAdminUser(uid), false, "不在白名单时应为 false");
  config.adminIds.add(uid);
  assert.equal(db.isAdminUser(uid), true, "未注册但在白名单时应为 true（修复前恒 false）");
  config.adminIds.delete(uid);
});

test("F2：deleteUser 必须清掉关键词修订号", () => {
  const uid = 8201;
  db.deleteUser(uid);
  db.createUser({ telegramId: uid, username: "s" });
  db.addKeyword(uid, "绿云", null, "substring");
  db.bumpKeywordRevision(uid);
  assert.ok(db.getSetting(db.keywordRevisionKey(uid), null) !== null, "修订号应已写入");

  db.deleteUser(uid);
  assert.equal(
    db.getSetting(db.keywordRevisionKey(uid), null),
    null,
    "删号后修订号必须清除，否则同 ID 重绑会复用旧关键词缓存"
  );
});

test("F2：删号重绑后，旧关键词不得再产生推送", async () => {
  const uid = 8202;
  db.deleteUser(uid);
  db.setMultiUserEnabled(true);
  db.createUser({ telegramId: uid, username: "s" });
  db.addKeyword(uid, "绿云", null, "substring");
  db.bumpKeywordRevision(uid);
  poller.invalidateKeywordCache(uid);

  // 先跑一轮，把关键词缓存填充起来
  installFetchMock({ rssXml: makeRss([{ id: 930001, title: "绿云 特价", category: "trade" }]) });
  await poller.runRound();

  // 模拟 /admin del：删号 + 清缓存（命令层做的事）
  db.deleteUser(uid);
  poller.invalidateKeywordCache(uid);
  assert.equal(db.listKeywords(uid).length, 0, "删号后关键词应为 0 条");

  // 同 ID 重绑，旧规则不得生效
  db.createUser({ telegramId: uid, username: "s2" });
  const { sent } = installFetchMock({
    rssXml: makeRss([{ id: 930002, title: "绿云 特价1002", category: "trade" }]),
  });
  await poller.runRound();
  assert.equal(
    sent.filter((m) => m.chatId === uid).length,
    0,
    "重绑后不得因残留缓存而推送（修复前的幽灵关键词）"
  );

  db.setMultiUserEnabled(true);
});

test("F1b：配了白名单时，陌生人不得抢先认领管理员", async () => {
  // 把用户表清空，制造「全新实例」的状态
  for (const u of db.listUsers({ limit: 100_000 })) db.deleteUser(u.telegram_id);
  assert.equal(db.hasAnyUser(), false, "前置：用户表应为空");

  config.adminIds.add(OWNER);
  db.setMultiUserEnabled(false); // 单用户（默认）

  const { sent } = installFetchMock();

  // 非白名单的陌生人先 /bind —— 修复前这里会直接把他变成管理员
  await router.handleUpdate(makeUpdate("/bind", { id: STRANGER, username: "stranger" }));
  const stranger = db.getUser(STRANGER);
  assert.ok(!stranger, "陌生人不应被创建（单用户模式）");
  assert.match(sent.at(-1)?.html || "", /单用户模式|联系实例管理员/, "应被单用户模式拒绝");

  // 白名单主人再 /bind —— 应当成为管理员
  await router.handleUpdate(makeUpdate("/bind", { id: OWNER, username: "owner" }));
  assert.equal(db.getUser(OWNER)?.role, "admin", "白名单主人应成为管理员");

  config.adminIds.delete(OWNER);
  db.resetMultiUserEnabled();
});

test("F1c：未配白名单时，首个 /bind 仍照常认领（保留原有行为）", async () => {
  for (const u of db.listUsers({ limit: 100_000 })) db.deleteUser(u.telegram_id);
  config.adminIds.clear();
  db.setMultiUserEnabled(false);

  installFetchMock();
  await router.handleUpdate(makeUpdate("/bind", { id: STRANGER, username: "first" }));
  assert.equal(db.getUser(STRANGER)?.role, "admin", "无白名单时首个用户应认领为管理员");

  db.resetMultiUserEnabled();
});

test("提权：被封禁的账号即使还在白名单里，也不得使用 /admin", async () => {
  // 场景：先封禁一个普通用户，之后运维把他加进 ADMIN_TELEGRAM_IDS。
  // 修复前 /admin 的鉴权早于封禁检查，他会带着 banned 状态拿到管理面板。
  const uid = 8301;
  db.deleteUser(uid);
  db.createUser({ telegramId: uid, username: "banned" });
  db.setUserStatus(uid, "banned");
  config.adminIds.add(uid);

  assert.equal(db.isAdminUser(db.getUser(uid)), true, "前置：白名单让他看起来是管理员");

  const { sent } = installFetchMock();
  await router.handleUpdate(makeUpdate("/admin stats", { id: uid }));
  const last = sent.at(-1)?.html || "";
  assert.match(last, /已被封禁/, "封禁应优先于管理员权限");
  assert.doesNotMatch(last, /全局统计/, "不得进入管理面板");

  config.adminIds.delete(uid);
  db.deleteUser(uid);
});
