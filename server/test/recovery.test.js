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

test("F1：单用户模式下白名单管理员仍能 /bind 找回管理权", async () => {
  for (const id of [STRANGER, OWNER, 2001, 2002]) db.deleteUser(id);
  config.adminIds.add(OWNER);
  db.setMultiUserEnabled(false); // 明确单用户（默认模式）
  const { sent } = installFetchMock();

  // 陌生人抢先认领
  await router.handleUpdate(makeUpdate("/bind", { id: STRANGER, username: "stranger" }));
  assert.equal(db.getUser(STRANGER).role, "admin", "首个用户应认领为管理员");

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
