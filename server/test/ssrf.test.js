// ============================================================================
// AI base_url 的 SSRF 校验（审查报告 F3）
//
// 此前该函数零测试覆盖，报告实测出多条放行路径。这里把「必须拦」与
// 「必须放行」两侧都钉住，防止以后改动黑名单时误伤正常地址。
// 注意：词法校验挡不住「攻击者控制的域名解析到内网」，那需要 DNS 解析后
// 校验或出口层限制，已在 README 标注为公开多用户部署的额外要求。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { teardown } from "./helpers.js";

const { validateBaseUrl } = await import("../src/ai.js");

test.after(async () => {
  await teardown();
});

test("SSRF：内网与本机地址必须拦截", () => {
  const mustBlock = [
    "http://127.0.0.1/v1",
    "http://localhost/v1",
    "http://0.0.0.0/v1",
    "http://10.0.0.1/v1",
    "http://169.254.169.254/v1",       // 云元数据
    "http://192.168.1.1/v1",
    "http://172.16.0.1/v1",
    "http://172.31.255.254/v1",
    "http://[::1]/v1",
    "http://[fc00::1]/v1",
    "http://[fd12::1]/v1",             // ULA fd00::/8（曾漏）
    "http://[fe80::1]/v1",
    "http://[::ffff:127.0.0.1]/v1",    // IPv4-mapped（曾漏）
    "http://100.100.100.200/v1",       // 阿里云元数据 / CGNAT（曾漏）
    "http://100.64.0.1/v1",            // CGNAT 段起点
    "http://metadata.google.internal/v1",
    "http://x.localhost/v1",
    "http://2130706433/v1",            // 十进制 127.0.0.1
    "http://0x7f.0.0.1/v1",            // 十六进制
    "http://0177.0.0.1/v1",            // 八进制
  ];
  for (const u of mustBlock) {
    assert.equal(validateBaseUrl(u).ok, false, `${u} 必须被拦截`);
  }
});

test("SSRF：正常公网地址必须放行", () => {
  for (const u of [
    "https://api.deepseek.com/v1",
    "https://api.openai.com/v1",
    "http://napi.example.com/v1",
  ]) {
    assert.equal(validateBaseUrl(u).ok, true, `${u} 应放行`);
  }
});

test("SSRF：非 http(s) 协议与非法 URL 必须拒绝", () => {
  for (const u of ["ftp://example.com/v1", "file:///etc/passwd", "not a url", ""]) {
    assert.equal(validateBaseUrl(u).ok, false, `${JSON.stringify(u)} 必须被拒绝`);
  }
});

test("SSRF：返回值去掉末尾斜杠、保留 origin+path", () => {
  const r = validateBaseUrl("https://api.example.com/v1/");
  assert.equal(r.ok, true);
  assert.equal(r.value, "https://api.example.com/v1");
});
