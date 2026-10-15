// ============================================================================
// 版块过滤：category 是逗号分隔的多值，必须按集合判断
//
// 实际故障：match.js 用 `kw.category === post.category` 全等比较，
// 而多版块时存的是 "daily,tech,info,expose,trade"，永远不等于单值
// "tech"。结果用户设了 5 个版块后一条都匹配不到，帖子却照样被标记已见，
// 表现为"加了关键词但永远不推送"。单版块恰好能撞对，所以一直没暴露。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
// 只为副作用：helpers 会在其它模块被求值前灌好必需的环境变量
import { teardown } from "./helpers.js";
import { matchPost } from "../src/match.js";

test.after(async () => {
  await teardown();
});

const post = (category, source = 0) => ({ post_id: 1, title: "绿云 年付", category, source });
const kw = (category) => [{ keyword: "绿云", category, match_mode: "substring" }];

test("版块：多版块列表能命中其中之一", () => {
  for (const c of ["daily", "tech", "info", "expose", "trade"]) {
    assert.deepEqual(
      matchPost(post(c), kw("daily,tech,info,expose,trade")),
      ["绿云"],
      `${c} 应命中`
    );
  }
});

test("版块：多版块列表不命中列表外的版块", () => {
  for (const c of ["review", "carpool", "dev", "sandbox"]) {
    assert.deepEqual(matchPost(post(c), kw("daily,tech,info,expose,trade")), [], `${c} 不应命中`);
  }
});

test("版块：单版块仍然正常（回归）", () => {
  assert.deepEqual(matchPost(post("trade"), kw("trade")), ["绿云"]);
  assert.deepEqual(matchPost(post("review"), kw("trade")), []);
});

test("版块：不带版块限制时全部命中", () => {
  for (const c of ["daily", "review", "sandbox"]) {
    assert.deepEqual(matchPost(post(c), kw(null)), ["绿云"]);
  }
});

test("版块：备用源忽略版块限制", () => {
  assert.deepEqual(matchPost(post("review", 1), kw("daily")), ["绿云"]);
});
