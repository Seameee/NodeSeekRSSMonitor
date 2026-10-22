// ============================================================================
// 已见记录：水位线（seen_state）取代逐帖记录（seen_posts）
//
// 旧方案每用户 × 每帖一行：实测 NodeSeek 约 2.8 帖/分钟，2000 用户 7 天就是
// 约 6000 万行 / 6 GiB，而 RSS 只暴露最新约 20 条 —— 绝大多数行永远不会被查到。
// 新方案每个 (用户, 源) 只记一行「见过的最大 post_id」。
//
// 这里钉住水位线必须满足的几条不变量，以及遗留表的清空行为。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock, makeRss, teardown } from "./helpers.js";

const db = await import("../src/db.js");
const poller = await import("../src/poller.js");

test.after(async () => {
  await teardown();
});

const U = 8100;
function freshUser(id = U) {
  db.deleteUser(id);
  db.createUser({ telegramId: id, username: `u${id}` });
  poller.invalidateKeywordCache(id);
  return id;
}

const stateRows = (uid) =>
  db.db.prepare("SELECT COUNT(*) AS n FROM seen_state WHERE telegram_id=?").get(uid).n;

test("水位线：id 不大于水位线的帖子一律算已见，不会重复推送", () => {
  const uid = freshUser();
  db.markSeen(uid, [
    { post_id: 100, source: 0 },
    { post_id: 102, source: 0 },
  ]);
  // 100/101/102 都在水位线 102 以内 —— 注意 101 从未被单独记录过，旧方案会把它
  // 当成「没见过」，水位线方案按定义算已见。这不影响推送：markSeen 记录的是
  // 本轮**全部**被投喂过的帖子，所以 101 只会是「从未出现在 feed 里」的号。
  assert.equal(db.filterUnseen(uid, [
    { post_id: 100, source: 0 },
    { post_id: 101, source: 0 },
    { post_id: 102, source: 0 },
  ]).size, 3, "水位线以内的帖子都应算已见（含从未单独记录过的 101）");
  // 103 高于水位线 → 新的
  assert.equal(db.filterUnseen(uid, [{ post_id: 103, source: 0 }]).size, 0);
});

test("水位线：永不回退 —— 本轮最大 id 变小也不得把更旧的帖子重新推一遍", () => {
  const uid = freshUser();
  db.markSeen(uid, [{ post_id: 1000, source: 0 }]);
  // 最新那条被删了，本轮能看到的最高 id 变成 990
  db.markSeen(uid, [{ post_id: 990, source: 0 }]);
  assert.equal(
    db.filterUnseen(uid, [{ post_id: 995, source: 0 }]).size,
    1,
    "水位线被调低的话，995 会重新变成「未见过」而被推第二遍"
  );
});

test("水位线：按源独立 —— 主源的水位线不能吞掉镜像源的帖子", () => {
  const uid = freshUser();
  db.markSeen(uid, [{ post_id: 5_000_000, source: 0 }]); // 主源帖子号很大
  assert.equal(
    db.filterUnseen(uid, [{ post_id: 10, source: 1 }]).size,
    0,
    "镜像源用的是消息号（数值小得多），必须按源各算各的"
  );
  assert.equal(stateRows(uid), 1, "还没见过镜像源的帖子，就不该为它建行");
  db.markSeen(uid, [{ post_id: 10, source: 1 }]);
  assert.equal(stateRows(uid), 2, "两个源应各占一行");
  assert.equal(db.filterUnseen(uid, [{ post_id: 10, source: 1 }]).size, 1);
});

test("水位线：存储与帖子数无关 —— 连记 1000 轮仍只有一行", () => {
  const uid = freshUser();
  for (let i = 0; i < 1000; i++) db.markSeen(uid, [{ post_id: 100_000 + i, source: 0 }]);
  assert.equal(stateRows(uid), 1, `水位线每个源只应占一行（实际 ${stateRows(uid)} 行）`);
});

test("水位线：deleteUser 必须一并清掉，重绑不得继承", () => {
  const uid = freshUser();
  db.markSeen(uid, [{ post_id: 777, source: 0 }]);
  db.deleteUser(uid);
  assert.equal(
    db.filterUnseen(uid, [{ post_id: 777, source: 0 }]).size,
    0,
    "删号后重绑不应继承删除前的水位线"
  );
});

test("端到端：新帖会推，旧帖重现不会重推", async () => {
  const uid = freshUser();
  db.addKeyword(uid, "绿云", null, "substring");

  let mock = installFetchMock({
    rssXml: makeRss([{ id: 950001, title: "【出】绿云 年付", category: "trade", content: "正文" }]),
  });
  await poller.runRound();
  assert.equal(mock.sent.filter((m) => m.chatId === uid).length, 1, "第一轮应推 1 条");

  // 第二轮：旧帖还在，同时来了一条新帖
  mock = installFetchMock({
    rssXml: makeRss([
      { id: 950002, title: "【出】绿云 新到的货", category: "trade", content: "正文" },
      { id: 950001, title: "【出】绿云 年付", category: "trade", content: "正文" },
    ]),
  });
  await poller.runRound();
  const msgs = mock.sent.filter((m) => m.chatId === uid);
  assert.equal(msgs.length, 1, `第二轮只应推新帖（实际 ${msgs.length} 条）`);
  assert.match(msgs[0].html, /新到的货/, "推的应是新帖而不是旧帖");
});

test("升级垫片：老库没有水位线时，用旧 seen_posts 的最大 id 初始化，避免升级后集体重推", () => {
  const uid = freshUser(8101);
  const ins = db.db.prepare(
    "INSERT OR IGNORE INTO seen_posts (telegram_id,post_id,seen_at) VALUES (?,?,?)"
  );
  const ts = new Date().toISOString();
  for (const id of [800_001, 800_050, 800_030]) ins.run(uid, id, ts);
  assert.equal(stateRows(uid), 0, "准备阶段该用户还没有水位线");

  // 第一次查已见时就地迁移：feed 里那些 ≤800050 的帖子必须算已见
  assert.equal(
    db.filterUnseen(uid, [
      { post_id: 800_010, source: 0 },
      { post_id: 800_050, source: 0 },
    ]).size,
    2,
    "旧表里的最大 id 应成为初始水位线"
  );
  assert.equal(stateRows(uid), 1, "迁移后应正好留下 1 行水位线");
  assert.equal(db.filterUnseen(uid, [{ post_id: 800_051, source: 0 }]).size, 0, "比水位线新的仍算新帖");
});

test("升级垫片：已有水位线时不再回头看旧表", () => {
  const uid = freshUser(8102);
  db.markSeen(uid, [{ post_id: 10, source: 0 }]);
  const ins = db.db.prepare(
    "INSERT OR IGNORE INTO seen_posts (telegram_id,post_id,seen_at) VALUES (?,?,?)"
  );
  ins.run(uid, 999_999, new Date().toISOString());

  assert.equal(
    db.filterUnseen(uid, [{ post_id: 10, source: 0 }]).size,
    1,
    "应继续用已有水位线（10），不能被旧表里更大的 id 顶掉"
  );
  assert.equal(
    db.filterUnseen(uid, [{ post_id: 500, source: 0 }]).size,
    0,
    "水位线仍是 10，500 应为新帖"
  );
});

test("遗留表：purge 分批清空 seen_posts，且受时间预算约束", () => {
  const rowsBefore = db.db.prepare("SELECT COUNT(*) AS n FROM seen_posts").get().n;
  const ins = db.db.prepare(
    "INSERT OR IGNORE INTO seen_posts (telegram_id,post_id,seen_at) VALUES (?,?,?)"
  );
  const ts = new Date().toISOString();
  db.db.exec("BEGIN");
  for (let i = 0; i < 25_000; i++) ins.run(9001, i, ts);
  db.db.exec("COMMIT");
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM seen_posts").get().n,
    rowsBefore + 25_000,
    "准备数据应写入成功"
  );

  let removed = 0;
  for (let i = 0; i < 50; i++) {
    const n = db.purgeLegacySeenPosts(50); // 每次最多 50ms
    removed += n;
    if (!n) break;
  }
  assert.ok(removed >= 25_000, `应把遗留行清掉（本次删了 ${removed} 行）`);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM seen_posts").get().n, 0, "最终应为空");
  assert.equal(db.purgeLegacySeenPosts(50), 0, "空表再跑应立刻返回 0，不做无谓扫描");
});
