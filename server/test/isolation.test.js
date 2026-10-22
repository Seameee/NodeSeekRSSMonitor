// ============================================================================
// 多用户隔离与权限边界
//
// 这是整个改动里风险最高的部分：一旦隔离有漏洞，用户 A 就能看到/改到
// 用户 B 的数据。下面每个断言都对应一条具体的越权路径。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeUpdate, teardown } from "./helpers.js";

test.after(async () => { await teardown(); });

const db = await import("../src/db.js");
const crypto = await import("../src/crypto.js");
const router = await import("../src/router.js");

const A = 2001;
const B = 2002;
const ADMIN = 1000; // 预置的管理员（由 ensureAdmin 创建）

async function ensureAdmin() {
  db.deleteUser(ADMIN);
  db.createUser({ telegramId: ADMIN, username: "admin", role: "admin" });
}

function freshUser(id, username) {
  db.deleteUser(id);
  return db.createUser({ telegramId: id, username, displayName: `U${id}` });
}

// ─── 数据隔离 ────────────────────────────────────────────────────────────────

test("隔离：关键词严格按 telegram_id 归属", () => {
  freshUser(A, "alice");
  freshUser(B, "bob");

  db.addKeyword(A, "绿云", null, "substring");
  db.addKeyword(A, "搬瓦工", "trade", "substring");
  db.addKeyword(B, "只属于B的关键词", null, "substring");

  const kwA = db.listKeywords(A);
  const kwB = db.listKeywords(B);

  assert.equal(kwA.length, 2);
  assert.equal(kwB.length, 1);
  assert.ok(!kwA.some((k) => k.keyword === "只属于B的关键词"), "A 不应看到 B 的关键词");
  assert.ok(!kwB.some((k) => k.keyword === "绿云"), "B 不应看到 A 的关键词");
});

test("隔离：按 id 删除时不能删到别人的关键词", () => {
  const kwB = db.listKeywords(B)[0];
  const changed = db.removeKeywordById(A, kwB.id); // A 拿着 B 的 id 来删
  assert.equal(changed, 0, "跨用户删除必须影响 0 行");
  assert.equal(db.listKeywords(B).length, 1, "B 的关键词必须完好");
});

test("隔离：启停关键词也不能跨用户", () => {
  const kwB = db.listKeywords(B)[0];
  const changed = db.setKeywordEnabled(A, kwB.id, false);
  assert.equal(changed, 0);
  assert.equal(db.listKeywords(B)[0].enabled, 1, "B 的关键词不应被 A 停用");
});

test("隔离：已见帖子按用户分别记录", () => {
  db.markSeen(A, [100, 101, 102]);
  assert.equal(db.filterUnseen(A, [100, 101, 999]).size, 2);
  assert.equal(db.filterUnseen(B, [100, 101]).size, 0, "B 不应继承 A 的已见记录");
});

test("隔离：推送历史按用户分别查询", () => {
  const post = { post_id: 500, title: "T", link: "L", category: "daily", author: "x" };
  db.logNotification(A, post, "绿云", "sent");
  assert.equal(db.getHistory(A, 10).length, 1);
  assert.equal(db.getHistory(B, 10).length, 0, "B 不应看到 A 的推送记录");
});

test("隔离：删除用户只清除该用户的数据", () => {
  db.markSeen(A, [1000]);
  db.deleteUser(B);
  assert.equal(db.getUser(B), null, "B 应被删除");
  assert.ok(db.listKeywords(A).length === 2, "A 的关键词应保留");
  assert.equal(db.filterUnseen(A, [1000]).size, 1, "A 的已见记录应保留");
});

// ─── AI 配置加密 ─────────────────────────────────────────────────────────────

test("AI 配置：Key 以密文入库，明文不出现在任何列", () => {
  const id = 3001;
  db.deleteUser(id);
  db.createUser({ telegramId: id, username: "aiuser" });
  const plainKey = "sk-supersecret-abcdefghijklmnop";
  db.upsertAiConfig(id, {
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnc: crypto.encryptSecret(plainKey),
    apiKeyHint: `${crypto.maskSecret(plainKey)} (${crypto.keyFingerprint(plainKey)})`,
    model: "deepseek-chat",
    fallback: "m2,m3",
    minLen: 0,
    maxPerRound: 5,
    maxTokens: 4000,
    timeoutMs: 15000,
    prompt: null,
    enabled: true,
  });

  const row = db.getAiConfig(id);
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes(plainKey), "整行数据里不允许出现明文 Key");
  assert.equal(crypto.decryptSecret(row.api_key_enc), plainKey, "应能解密还原");
  assert.ok(row.api_key_hint.includes("…"), "应存打码后的提示");
});

test("AI 配置：解密失败时视为未配置，不抛错", async () => {
  const ai = await import("../src/ai.js");
  const row = {
    telegram_id: 1,
    enabled: 1,
    base_url: "https://x.com/v1",
    api_key_enc: "v1:broken:broken:broken",
    model: "m",
  };
  assert.equal(ai.resolveAiConfig(row), null, "坏密文应返回 null");
  assert.equal(ai.resolveAiConfig({ enabled: 0 }), null, "未启用应返回 null");
});

// ─── 权限边界 ────────────────────────────────────────────────────────────────

test("权限：未注册用户发 /add 会被要求先 /bind", async () => {
  const { sent } = installFetchMock();
  const stranger = 4001;
  db.deleteUser(stranger);

  await router.handleUpdate(makeUpdate("/add 绿云", { id: stranger }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /bind/, "应提示先绑定");
  assert.equal(db.listKeywords(stranger).length, 0, "不得写入任何关键词");
});

test("权限：/bind 可自助开通，并拿到独立账号", async () => {
  const { sent } = installFetchMock();
  const newcomer = 4002;
  db.deleteUser(newcomer);

  await router.handleUpdate(makeUpdate("/bind", { id: newcomer, username: "newbie" }));
  const user = db.getUser(newcomer);
  assert.ok(user, "应创建用户");
  assert.equal(user.role, "user", "自助注册只能是普通用户");
  assert.equal(user.status, "active");
  assert.match(sent.at(-1).html, /注册成功/);
});

test("权限：普通用户执行 /admin 不得进入管理面板", async () => {
  const { sent } = installFetchMock();
  const plain = 4003;
  db.deleteUser(plain);
  db.createUser({ telegramId: plain, username: "plain" });

  await router.handleUpdate(makeUpdate("/admin stats", { id: plain }));
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].html, /全局统计|管理员面板/, "普通用户不应看到管理面板内容");
  assert.match(sent[0].html, /未知命令|help/i);
});

test("权限：普通用户无法通过任何命令把自己变成管理员", async () => {
  const { sent } = installFetchMock();
  const climber = 4004;
  db.deleteUser(climber);
  db.createUser({ telegramId: climber, username: "climber", role: "user" });
  db.setMultiUserEnabled(true);

  // 挨个试一遍可能的提权入口
  for (const cmd of ["/admin stats", "/admin multiuser on", "/admin quota 4004 ai 999999", "/bind"]) {
    await router.handleUpdate(makeUpdate(cmd, { id: climber }));
  }
  assert.equal(db.getUser(climber).role, "user", "role 不应被改动");
  assert.equal(db.isAdminUser(db.getUser(climber)), false, "不应变成管理员");
  assert.doesNotMatch(sent.map((m) => m.html).join(""), /全局统计/, "不应看到管理面板");
});

test("权限：库内 role=admin 即可进入管理面板（首个用户认领路径）", async () => {
  const { sent } = installFetchMock();
  await ensureAdmin();
  await router.handleUpdate(makeUpdate("/admin stats", { id: ADMIN }));
  assert.match(sent.at(-1).html, /全局统计/);
});

test("权限：管理员不能封禁或删除其他管理员", async () => {
  const { sent } = installFetchMock();
  await ensureAdmin();
  await router.handleUpdate(makeUpdate(`/admin ban ${ADMIN}`, { id: ADMIN }));
  assert.match(sent.at(-1).html, /不能封禁管理员/);
  assert.equal(db.getUser(ADMIN).status, "active", "管理员状态不应被改");
});

test("权限：被封禁用户无法使用任何命令", async () => {
  const { sent } = installFetchMock();
  const bad = 4005;
  db.deleteUser(bad);
  db.createUser({ telegramId: bad, username: "bad" });
  db.addKeyword(bad, "绿云", null, "substring");
  db.setUserStatus(bad, "banned");

  await router.handleUpdate(makeUpdate("/add 新词", { id: bad }));
  assert.match(sent.at(-1).html, /封禁/);
  assert.equal(db.listKeywords(bad).length, 1, "封禁用户不得新增关键词");
});

test("权限：群聊默认被忽略", async () => {
  const { sent } = installFetchMock();
  const handled = await router.handleUpdate(
    makeUpdate("/status", { id: A, chatType: "group" })
  );
  assert.equal(handled, false, "群聊消息应被忽略");
  assert.equal(sent.length, 0, "不应有任何回复");
});

// ─── 管理员操作 ──────────────────────────────────────────────────────────────

test("管理：配额设置与恢复默认", async () => {
  const { sent } = installFetchMock();
  const target = 4006;
  db.deleteUser(target);
  db.createUser({ telegramId: target, username: "t" });

  await ensureAdmin();
  await router.handleUpdate(makeUpdate(`/admin quota ${target} ai 5`, { id: ADMIN }));
  assert.equal(db.getUser(target).daily_ai_quota, 5);
  assert.equal(db.effectiveQuota(db.getUser(target)).dailyAi, 5);

  await router.handleUpdate(makeUpdate(`/admin quota ${target} ai -1`, { id: ADMIN }));
  assert.equal(db.getUser(target).daily_ai_quota, null, "应恢复为默认（NULL）");
  assert.ok(db.effectiveQuota(db.getUser(target)).dailyAi > 0);
});

test("管理：删库级删除会清空该用户所有数据", async () => {
  const { sent } = installFetchMock();
  const victim = 4007;
  db.deleteUser(victim);
  db.createUser({ telegramId: victim, username: "v" });
  db.addKeyword(victim, "词", null, "substring");
  db.markSeen(victim, [1, 2, 3]);

  await ensureAdmin();
  await router.handleUpdate(makeUpdate(`/admin del ${victim}`, { id: ADMIN }));
  assert.equal(db.getUser(victim), null);
  assert.equal(db.listKeywords(victim).length, 0);
  assert.equal(db.filterUnseen(victim, [1, 2, 3]).size, 0);
});

test("管理：所有管理操作都写入审计", async () => {
  await ensureAdmin();
  await router.handleUpdate(makeUpdate("/admin multiuser on", { id: ADMIN }));
  const rows = db.listAudit(50);
  assert.ok(rows.length > 0, "应有审计记录");
  assert.ok(
    rows.some((r) => r.actor_id === ADMIN),
    "审计里应包含管理员的操作"
  );
});
