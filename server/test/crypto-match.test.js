// ============================================================================
// 加密与匹配：纯函数，独立于 DB
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers.js"; // 先设置 env

const crypto = await import("../src/crypto.js");
const match = await import("../src/match.js");

test("加密：往返一致，且密文每次不同（随机 IV）", () => {
  const secret = "sk-test-abcdefghijklmnopqrstuvwxyz123456";
  const a = crypto.encryptSecret(secret);
  const b = crypto.encryptSecret(secret);

  assert.notEqual(a, b, "相同明文两次加密应产生不同密文");
  assert.equal(crypto.decryptSecret(a), secret);
  assert.equal(crypto.decryptSecret(b), secret);
  assert.match(a, /^v1:/, "应带版本前缀");
});

test("加密：密文被篡改时解密必须失败（GCM 认证）", () => {
  const enc = crypto.encryptSecret("sensitive-value");
  const parts = enc.split(":");
  // 翻转密文最后一个字符
  const ct = Buffer.from(parts[3], "base64");
  ct[ct.length - 1] ^= 0xff;
  parts[3] = ct.toString("base64");
  const tampered = parts.join(":");

  assert.throws(() => crypto.decryptSecret(tampered), "篡改后的密文必须解密失败");
  assert.equal(crypto.tryDecryptSecret(tampered), null, "tryDecrypt 应返回 null 而不是抛错");
});

test("加密：格式错误与错误密钥都不崩溃", () => {
  assert.equal(crypto.tryDecryptSecret("garbage"), null);
  assert.equal(crypto.tryDecryptSecret(""), null);
  assert.equal(crypto.tryDecryptSecret(null), null);
  assert.equal(crypto.tryDecryptSecret("v2:a:b:c"), null);
});

test("密钥展示：指纹稳定且不含明文", () => {
  const key = "sk-verysecretvalue";
  const masked = crypto.maskSecret(key);
  assert.ok(!masked.includes("verysecret"), `打码结果不应含中间部分: ${masked}`);
  assert.match(masked, /^sk-ver…/);
  assert.equal(crypto.keyFingerprint(key), crypto.keyFingerprint(key), "同一 Key 指纹应稳定");
  assert.notEqual(crypto.keyFingerprint(key), crypto.keyFingerprint(key + "x"));
});

test("safeEqual：常量时间比较", () => {
  assert.ok(crypto.safeEqual("abc", "abc"));
  assert.ok(!crypto.safeEqual("abc", "abd"));
  assert.ok(!crypto.safeEqual("abc", "abcd"));
});

// ─── 关键词匹配 ──────────────────────────────────────────────────────────────

test("匹配：子串大小写不敏感", () => {
  assert.ok(match.matches("绿云GreenCloud 促销", "greencloud", "substring"));
  assert.ok(match.matches("绿云GreenCloud 促销", "绿云", "substring"));
  assert.ok(!match.matches("别的帖子", "绿云", "substring"));
});

test("匹配：正则模式", () => {
  assert.ok(match.matches("【出】搬瓦工 CN2 GIA", "搬瓦工.*(CN2|GIA)", "regex"));
  assert.ok(!match.matches("【收】搬瓦工", "搬瓦工.*(CN2|GIA)", "regex"));
});

test("匹配：非法正则返回 false 而不是抛错", () => {
  assert.equal(match.matches("任意标题", "([unclosed", "regex"), false);
});

test("ReDoS 防护：嵌套量词与反向引用必须被拒绝", () => {
  const bad = ["(a+)+$", "(a*)*b", "(a|a)+$", "(x+){2,}", ".*.*.*x", "(a)\\1"];
  for (const p of bad) {
    const r = match.validateRegex(p);
    assert.equal(r.ok, false, `应拒绝危险正则: ${p}（${r.reason || "无原因"}）`);
  }
});

test("ReDoS 防护：正常正则放行", () => {
  for (const p of ["搬瓦工", "CN2|GIA", "^\\[出\\]", "\\d+元"]) {
    assert.equal(match.validateRegex(p).ok, true, `应放行正常正则: ${p}`);
  }
});

test("输入校验：长度与控制字符", () => {
  assert.equal(match.validateKeyword("").ok, false);
  assert.equal(match.validateKeyword("x".repeat(101)).ok, false);
  assert.equal(match.validateKeyword("正常关键词").ok, true);
  assert.equal(match.validateKeyword("evil\u0000key").ok, false);
});

test("matchPost：备用源忽略版块限制，主源遵守", () => {
  const keywords = [{ keyword: "绿云", category: "trade", match_mode: "substring" }];
  const mainHit = match.matchPost(
    { title: "绿云 年付", category: "trade", source: 0 },
    keywords
  );
  const mainMiss = match.matchPost(
    { title: "绿云 年付", category: "daily", source: 0 },
    keywords
  );
  const backup = match.matchPost(
    { title: "绿云 年付", category: "telegram", source: 1 },
    keywords
  );
  assert.deepEqual(mainHit, ["绿云"]);
  assert.deepEqual(mainMiss, [], "主源非目标版块不应命中");
  assert.deepEqual(backup, ["绿云"], "备用源应忽略版块限制");
});
