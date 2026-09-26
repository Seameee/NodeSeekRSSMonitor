# NodeSeek Keywords Monitor — Cloudflare Workers

基于 Cloudflare Workers + D1 的 NodeSeek 论坛关键词监控 Telegram Bot。

## 功能

- 关键词监控，支持子串匹配和正则匹配
- 支持按版块过滤，多版块逗号分隔（如 `trade,info`）
- 每分钟自动轮询 RSS，新帖匹配后推送 Telegram 通知
- 命中关键词用可折叠引用块展示，长正则不再刷屏
- 可选 AI 摘要：给每条通知附一句帖子内容摘要（OpenAI 兼容接口）
- 首次运行静默初始化，不发历史通知
- 防洪上限 + 溢出汇总，避免刷屏
- RSS 连续失败告警
- 发送失败自动重试（30 次指数退避）
- 自动清理过期数据（seen_posts 7 天，notifications 30 天）

## 部署步骤

1. **Cloudflare Dashboard → Workers & Pages → Create → 从 Hello World! 开始**
2. **进入 Worker Settings → Variables and Secrets**，添加以下环境变量：

   | 名称                   | 值                    | 说明                                         |
   | ---------------------- | --------------------- | -------------------------------------------- |
   | `TELEGRAM_BOT_TOKEN` | 你的 Bot Token        | 从[@BotFather](https://t.me/BotFather) 获取     |
   | `ALLOWED_USER_ID`    | 你的 Telegram 用户 ID | 从[@userinfobot](https://t.me/userinfobot) 获取 |
   | `WEBHOOK_SECRET`     | 随便编一个随机字符串  | 可选，建议设置                               |
3. **Worker Settings → Bindings → D1 Database**：

   - 先在 D1 页面创建一个数据库，名字随意，之后去 Worker 内绑定
   - Variable name 填：`DB`
   - 选择刚创建的数据库
4. **粘贴 `worker.js` 代码，部署**
5. **Worker Settings → Triggers → Cron Triggers**：

   - 添加 `* * * * *`（每分钟执行一次）
6. **访问 `https://你的worker域名/setup`** 完成 Telegram Webhook 注册和数据库初始化（可能需要等待一段时间）
7. **给 Bot 发 `/start` 测试**

## AI 摘要（可选）

给每条命中通知附一句模型生成的帖子内容摘要：

```
🔔 关键词提醒
▎^(?!.*收).*(家人|bitsflow|jtti|…|greencloud)          ← 折叠，点箭头展开

📌 【出】shandun uk 3刀版 8折出 总价16.8缘
📝 8 折出 shandun UK 3 刀版，总价 16.8 元，需 push 转移。
🏷 交易
👤 marchael
🔗 https://www.nodeseek.com/post-949604-1
```

**不配置 `AI_API_KEY` 和 `AI_MODEL` 时该功能完全关闭**，行为与以前完全一致。在 Worker 的
Settings → Variables and Secrets 里按需添加：

| 名称                 | 必填 | 默认值                      | 说明                                                         |
| -------------------- | ---- | --------------------------- | ------------------------------------------------------------ |
| `AI_API_KEY`       | 是   | —                          | 模型服务的 API Key                                           |
| `AI_MODEL`         | 是   | —                          | 模型名，如 `deepseek-chat`                                 |
| `AI_BASE_URL`      | 否   | `https://api.deepseek.com/v1` | 任意 OpenAI 兼容端点，**末尾不要带 `/`**              |
| `AI_MIN_LEN`       | 否   | `0`                       | 正文短于此长度就跳过摘要，调大可省 token                     |
| `AI_MAX_PER_ROUND` | 否   | `5`                       | 每轮最多生成几条摘要                                         |
| `AI_MAX_TOKENS`    | 否   | `4000`                    | 单次生成上限。**推理型模型别调太小**，否则思考会吃光预算导致空回复 |
| `AI_TIMEOUT_MS`    | 否   | `15000`                   | 单次调用超时（毫秒）                                         |
| `AI_PROMPT`        | 否   | 内置提示词                  | 自定义 system prompt                                         |

行为说明：

- 正文取自 RSS 的 `<description>`，实测与帖子页面 `<article class="post-content">` 内容一致，**不需要额外抓取帖子页面**。
- 正文为空的帖子（纯图片帖、已删帖）直接跳过，不会调用模型。
- 模型调用失败（超时 / 401 / 500 / 返回空）只会少一行摘要，**通知照常发送**。
- 摘要文本会做 HTML 转义，不会破坏 Telegram 的 HTML 解析。
- 摘要与关键词同属一条消息，注意 Telegram 单条 4096 字符上限。

## Bot 命令

| 命令                               | 说明                       |
| ---------------------------------- | -------------------------- |
| `/add <关键词> [--regex] [版块]` | 添加监控关键词             |
| `/remove <序号或关键词>`         | 删除关键词                 |
| `/pause <序号或关键词>`          | 暂停关键词                 |
| `/resume <序号或关键词>`         | 恢复关键词                 |
| `/list`                          | 查看监控列表               |
| `/history [数量]`                | 查看推送记录（默认 10 条） |
| `/categories`                    | 查看可用版块               |
| `/status`                        | 查看运行状态               |

## 可用版块

| 代码       | 名称 | 代码            | 名称 |
| ---------- | ---- | --------------- | ---- |
| `daily`  | 日常 | `tech`        | 技术 |
| `info`   | 情报 | `review`      | 测评 |
| `trade`  | 交易 | `carpool`     | 拼车 |
| `dev`    | Dev  | `photo-share` | 贴图 |
| `expose` | 曝光 | `sandbox`     | 沙盒 |

## 使用示例

```
/add 搬瓦工                        # 全部版块监控 搬瓦工
/add 搬瓦工 trade                  # 仅交易版
/add 搬瓦工 trade,info             # 交易 + 情报
/add 补货 --regex info,trade     # 正则匹配，情报 + 交易
/add 搬瓦工.*(CN2|GIA) --regex     # 正则匹配全部版块
/remove 2                        # 删除列表中第 2 条
/remove 搬瓦工                     # 按关键词删除
/pause 1                         # 暂停第 1 条
/resume 1                        # 恢复第 1 条
```
