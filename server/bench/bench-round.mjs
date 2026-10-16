// ============================================================================
// 负载基准：2000 用户 × 20 关键词，跑**真实的 runRound()**
//
// 用法（在 server/ 目录下）：
//   node bench/bench-round.mjs
//   BENCH_USERS=500 BENCH_HIT_USERS=50 node bench/bench-round.mjs
//
// 刻意不改动业务代码：网络层用 fetch mock 顶掉（RSS 返回夹具、Telegram 直接
// 返回 ok），其余全部走真实路径 —— 真实的 SQLite、真实的 worker 线程池、
// 真实的令牌桶限流。因此测出来的就是线上会花掉的时间。
//
// 每次运行使用独立的库文件（文件名带时间戳），不覆盖也不清理旧文件。
// ============================================================================
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
// 允许在别处运行（例如拷进容器 /tmp 跑），用环境变量指出源码与数据目录
const SRC = process.env.BENCH_SRC || "../src";
const BENCH_DIR = process.env.BENCH_DIR || join(HERE, "..", ".bench");

const USERS = Number(process.env.BENCH_USERS || 2000);
const KWS = Number(process.env.BENCH_KWS || 20);
const POST_COUNT = Number(process.env.BENCH_POSTS || 30);
// 前 N 个用户额外带一条「必然命中」的关键词，用来把发送链路也算进来
const HIT_USERS = Number(process.env.BENCH_HIT_USERS || 0);
// MATCH=1 时正则里带上真实会命中的分支（用来测发送限速），
// MATCH=0 时正则永不命中，从而把「抓取+匹配+写库」的结构开销单独量出来。
const MATCH = process.env.BENCH_MATCH === "1";
// BENCH_AI=1 时给所有用户配上相同的 AI 配置，用来量「同一帖子被 N 个用户
// 各调一次 AI」的重复度（AI 摘要是按用户×帖子生成的，跨用户不去重）。
const AI = process.env.BENCH_AI === "1";
const TAG = process.env.BENCH_TAG || String(Date.now());

const DB_PATH = join(BENCH_DIR, `bench-${USERS}u-${KWS}k-${HIT_USERS}h-${TAG}.db`);
mkdirSync(BENCH_DIR, { recursive: true });

process.env.NODE_ENV = "development";
process.env.TELEGRAM_BOT_TOKEN = "123456:BENCHTOKEN";
process.env.APP_MASTER_KEY = "0123456789abcdef".repeat(4);
process.env.DB_PATH = DB_PATH;
process.env.LOG_LEVEL = "error";
process.env.MULTI_USER_ENABLED = "true";
process.env.HEALTH_PORT = "0";
process.env.WORKER_POOL_SIZE = process.env.WORKER_POOL_SIZE || "4";
process.env.SEND_RATE_PER_SEC = process.env.SEND_RATE_PER_SEC || "20";

const db = await import(`${SRC}/db.js`);
const poller = await import(`${SRC}/poller.js`);
const cryptoMod = await import(`${SRC}/crypto.js`);
const { pool, matchPostsAsync } = await import(`${SRC}/worker-pool.js`);
const { config } = await import(`${SRC}/config.js`);

// ─── 计时工具 ────────────────────────────────────────────────────────────────

const ns = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
async function T(label, fn, note = "") {
  const t = ns();
  const r = await fn();
  console.log(`  ${label.padEnd(40)} ${ms(t).toFixed(0).padStart(7)} ms  ${note}`);
  return r;
}

// ─── 数据 ────────────────────────────────────────────────────────────────────

// 真实感标题：NodeSeek 上高频出现的词都在里面
const TITLES = [
  "【出】绿云 GreenCloud 洛杉矶 1C1G 年付 20 美元 三网优化",
  "搬瓦工 CN2 GIA-E 传家宝补货 年付 49.99 刀",
  "【收】DMIT 香港 月付 5 美元以内",
  "NodeSeek 论坛签到脚本分享，支持多账号",
  "Cloudflare Workers 免费额度又调整了？",
  "小鸡测评：RackNerd 圣何塞 10 美元一年实测",
  "【拼车】Netflix 高级会员 4K 车位 招 2 人",
  "甲骨文 ARM 永久免费机开了，4C24G",
  "求推荐便宜好用的境外 VPS，预算 30 元/月",
  "【曝光】某商家跑路，注意避坑",
  "Docker 镜像加速方案汇总 2026",
  "自建 DNS 去广告 AdGuardHome 教程",
  "【日常】今天终于把博客迁移完了",
  "腾讯云轻量 2C4G 三年 288 元值不值",
  "OpenWrt 软路由选购指南",
  "【技术】聊聊 eBPF 在服务器上的实际用途",
  "Vultr 新用户送 100 美元 白嫖教程",
  "【情报】某 IDC 即将涨价，先续费",
  "GCP 300 美元额度到期了怎么办",
  "【贴图】我的桌面 setup 2026 版",
  "买个域名做什么好？求指路",
  "华为云 618 活动 1C2G 一年 99",
  "【沙盒】测试一下新版发帖功能",
  "Nginx 反代 WebSocket 配置踩坑记录",
  "【交易】出一个阿里云香港轻量 剩余 8 个月",
  "IPv6 only 小鸡怎么访问 IPv4 网络",
  "WireGuard 组网实战：三地互联",
  "【拼车】Spotify 家庭组 年付 拼 3 人",
  "收一台 OneProvider 巴黎 年付",
  "SSH 密钥登录配置与安全加固清单",
];

function makeRss(items) {
  const body = items
    .map(
      (it) => `<item>
      <title><![CDATA[${it.title}]]></title>
      <link>https://www.nodeseek.com/post-${it.id}-1</link>
      <guid>${it.id}</guid>
      <category><![CDATA[${it.category}]]></category>
      <author><![CDATA[alice]]></author>
      <description><![CDATA[${it.content}]]></description>
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>NodeSeek</title>${body}</channel></rss>`;
}

const POSTS = Array.from({ length: POST_COUNT }, (_, i) => ({
  id: 900000 + i,
  title: TITLES[i % TITLES.length],
  category: ["trade", "daily", "tech", "info", "review"][i % 5],
  content: "正文内容 ".repeat(60),
}));
const RSS = makeRss(POSTS);
let currentRss = RSS;

// ─── 网络 mock ───────────────────────────────────────────────────────────────

let sent = 0;
let aiCalls = 0;
const aiKeys = new Set(); // 按「发给上游的内容」去重，反映重复调用比例
const json = (o, status = 200) => ({
  ok: status < 300,
  status,
  headers: new Map(),
  json: async () => o,
  text: async () => JSON.stringify(o),
});
const xml = (t) => ({
  ok: true,
  status: 200,
  headers: new Map([["etag", '"bench-etag"'], ["last-modified", "Wed, 01 Jan 2026 00:00:00 GMT"]]),
  json: async () => ({}),
  text: async () => t,
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    if (method === "getUpdates") return json({ ok: true, result: [] });
    if (method === "sendMessage" || method === "sendRichMessage") {
      sent++;
      return json({ ok: true, result: { message_id: sent } });
    }
    return json({ ok: true, result: true });
  }
  if (u.includes("/chat/completions")) {
    aiCalls++;
    const body = JSON.parse(init.body || "{}");
    aiKeys.add(`${body.model}::${JSON.stringify(body.messages)}`);
    return json({ choices: [{ message: { content: "这是摘要内容。" } }] });
  }
  if (u.includes("nodeseek") || u.includes("seaya") || u.includes("rsshub")) return xml(currentRss);
  throw new Error(`未预期的请求: ${u}`);
};

// ─── 建库 ────────────────────────────────────────────────────────────────────

const uid = (i) => 500000 + i;
const POST_IDS = POSTS.map((p) => p.id);
const benchKeywords = new Map(); // uid -> keyword 行，供组件分解复用

console.log(
  `\n配置：用户 ${USERS} × 关键词 ${KWS} / 帖子 ${POST_COUNT} / ` +
    `命中模式 ${MATCH ? `开（${HIT_USERS} 人必然命中）` : "关（零推送）"} / ` +
    `worker 线程 ${config.workerPoolSize} / 发送限速 ${config.sendRatePerSec} msg/s`
);

await T(
  "建库：用户 + 关键词（DB 写入）",
  () => {
    db.db.exec("BEGIN");
    for (let i = 0; i < USERS; i++) {
      db.createUser({ telegramId: uid(i), username: `user${i}` });
      for (let k = 0; k < KWS / 2; k++) db.addKeyword(uid(i), `zzsub_${i}_${k}`, null, "substring");
      for (let k = 0; k < KWS / 2; k++) {
        // 真实正则：交替 + 字符类 + 量词，跟用户实际会写的东西接近
        db.addKeyword(
          uid(i),
          MATCH ? `zzre_${i}_${k}|vps\\d+|小鸡[0-9]*` : `zzre_${i}_${k}|zzrx_${i}_${k}`,
          null,
          "regex"
        );
      }
      if (i < HIT_USERS) db.addKeyword(uid(i), "绿云", null, "substring");
    }
    if (AI) {
      const apiKeyEnc = cryptoMod.encryptSecret("sk-bench-0123456789abcdef");
      for (let i = 0; i < USERS; i++) {
        db.upsertAiConfig(uid(i), {
          baseUrl: "https://api.example.com/v1",
          apiKeyEnc,
          apiKeyHint: "sk-ben…cdef (00000000)",
          model: "bench-model",
          fallback: null,
          minLen: 0,
          maxPerRound: 5,
          maxTokens: 4000,
          timeoutMs: 15_000,
          prompt: null,
          enabled: true,
        });
      }
    }
    db.db.exec("COMMIT");
  },
  `关键词行数 ${(USERS * KWS + HIT_USERS).toLocaleString()}`
);

// 预载关键词用于组件分解
await T("listUsers(100000)", () => db.listUsers({ limit: 100_000, status: "active" }));
for (let i = 0; i < USERS; i++) benchKeywords.set(uid(i), db.listKeywords(uid(i), { onlyEnabled: true }));

// ─── 组件分解 ────────────────────────────────────────────────────────────────

console.log("\n── 组件分解（同一份数据）─────────────────────────");

await T(`filterUnseen × ${USERS}`, () => {
  let n = 0;
  for (let i = 0; i < USERS; i++) n += db.filterUnseen(uid(i), POST_IDS).size;
  return n;
});

await T(`matchPostsAsync × ${USERS}（串行）`, async () => {
  for (let i = 0; i < USERS; i++) await matchPostsAsync(POSTS, benchKeywords.get(uid(i)));
});

await T(`matchPostsAsync × ${USERS}（8 并发，同 poller）`, async () => {
  let cur = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (true) {
        const i = cur++;
        if (i >= USERS) return;
        await matchPostsAsync(POSTS, benchKeywords.get(uid(i)));
      }
    })
  );
});

await T(`匹配纯计算（1 次调用含全部 ${USERS * KWS} 条）`, () =>
  matchPostsAsync(POSTS, [...benchKeywords.values()].flat())
);

await T(`markSeen × ${USERS}（每人 3 帖）`, () => {
  for (let i = 0; i < USERS; i++) db.markSeen(uid(i), POST_IDS.slice(0, 3));
});

// ─── 端到端 ──────────────────────────────────────────────────────────────────

console.log("\n── 端到端 runRound() ──────────────────────────────");
sent = 0;
const r1 = await T("第 1 轮（全部帖子都是新的）", () => poller.runRound(), "← 冷启动最坏情况");
const r2 = await T("第 2 轮（帖子都已见）", () => poller.runRound(), "← 线上绝大多数轮次长这样");
const r3 = await T("第 3 轮（稳态重复）", () => poller.runRound());

// 第 4 轮：真实节奏。NodeSeek 实测约 2.8 帖/分钟，所以一轮里只有 3 条是新帖，
// 其余 27 条都已见。这才是线上绝大多数轮次的真实形状。
const NEW3 = [
  { id: 990101, title: "【出】绿云 GreenCloud 东京 年付 25 刀", category: "trade", content: "正文 ".repeat(50) },
  { id: 990102, title: "搬瓦工 新机房上线 测速", category: "tech", content: "正文 ".repeat(50) },
  { id: 990103, title: "【日常】周末装机记录", category: "daily", content: "正文 ".repeat(50) },
];
currentRss = makeRss([...NEW3, ...POSTS.slice(3)]);
const r4 = await T("第 4 轮（真实节奏：仅 3 条新帖）", () => poller.runRound(), "← 线上稳态的真实形状");
console.log(`  r1 = ${JSON.stringify(r1)}`);
console.log(`  r3 = ${JSON.stringify(r3)}`);
console.log(`  r4 = ${JSON.stringify(r4)}`);
console.log(`  Telegram 发送条数：${sent}`);
if (AI) {
  console.log(
    `  AI 调用次数：${aiCalls}，其中发给上游的**不同内容**只有 ${aiKeys.size} 种 ` +
      `→ 重复率 ${(100 - (aiKeys.size / Math.max(aiCalls, 1)) * 100).toFixed(1)}%`
  );
}

console.log("\n── 环境 ───────────────────────────────────────────");
console.log(`  CPU 核心 ${os.cpus().length} / 内存 ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB / ${JSON.stringify(pool.stats())}`);

await pool.close();
db.closeDb();
