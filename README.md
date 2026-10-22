# NodeSeek 关键词监控 Bot

[![Node](https://img.shields.io/badge/node-24.22.1-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-185%20passing-brightgreen?style=flat-square)](server/test)
[![Registry](https://img.shields.io/badge/ghcr.io-nodeseek--monitor-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/Seameee/packages/container/nodeseek-monitor)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

轮询 NodeSeek 的 RSS，新帖标题命中关键词时推送一条 Telegram 通知，可选附 AI 摘要。服务跑在自己的服务器上，支持多用户：任何人在 Telegram 里发 `/bind` 即可开通，各自的关键词与 AI 配置互不可见。

本项目派生自 [Roddy-D/NodeSeekRSSMonitor](https://github.com/Roddy-D/NodeSeekRSSMonitor)，署名与授权范围见[来源与致谢](#来源与致谢)。

## 目录

- [Docker 部署](#docker-部署)
- [Cloudflare Workers 部署](#cloudflare-workers-部署)
- [运行模式](#运行模式)
- [命令](#命令)
- [匹配规则](#匹配规则)
- [AI 摘要](#ai-摘要)
- [勿扰模式](#勿扰模式)
- [安全与隐私](#安全与隐私)
- [环境变量](#环境变量)
- [性能与容量](#性能与容量)
- [运维](#运维)
- [Node 版本与安全更新](#node-版本与安全更新)
- [仓库结构](#仓库结构)

## Docker 部署

### 前置条件

- Docker 20.10+ 与 Docker Compose v2（`docker compose` 命令）
- 1 核 CPU、128 MB 内存起（compose 默认 `cpus: "1.0"`、内存上限 512 MB）
- 能访问 `api.telegram.org` 与 `rss.nodeseek.com`
- 一个 Bot Token，从 [@BotFather](https://t.me/BotFather) 用 `/newbot` 获取

### 启动步骤

**1. 拉取代码**

```bash
git clone https://github.com/Seameee/NodeSeekRSSMonitor.git
cd NodeSeekRSSMonitor/server
```

如果 `server/` 目录不存在，说明默认分支尚未包含 Docker 版代码，此时指定分支再克隆：

```bash
git clone -b docker https://github.com/Seameee/NodeSeekRSSMonitor.git
cd NodeSeekRSSMonitor/server
```

**2. 生成 `.env`**

```bash
cp .env.example .env
chmod 600 .env
```

必填两项：

```bash
# 从 @BotFather 获取
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# 用于加密用户 API Key。生成后立即备份，改动即不可逆
APP_MASTER_KEY=
```

主密钥可用下面这条命令直接写入 `.env`：

```bash
sed -i "s|^APP_MASTER_KEY=.*|APP_MASTER_KEY=$(openssl rand -hex 32)|" .env
```

要开放给多人使用，再加一行：

```bash
MULTI_USER_ENABLED=true
```

默认为 `false`，即单用户模式，只有管理员可用。开放注册前应先用自己的账号 `/bind` 完成认领，否则第一个找到这个 Bot 的陌生人会成为管理员。

**3. 启动**

```bash
docker compose up -d
docker compose logs -f
```

日志出现以下两行即为正常启动：

```
[health] 健康检查监听 :8787/healthz
[poller] 本轮完成：20 帖 / 0 用户 / 推送 0 条 / 摘要 0 条 / 耗时 220ms
```

按 `Ctrl+C` 退出日志，容器继续在后台运行。确认容器状态：

```bash
docker compose ps     # 应显示 healthy
```

**4. 认领管理员**

在 Telegram 私聊你的 Bot，发送 `/bind`。第一个绑定的人自动成为管理员。

```
/add 绿云              # 添加关键词
/list                  # 查看关键词
/ai set sk-xxx         # 可选，配置 AI 摘要
/admin                 # 管理面板，仅管理员
```

新部署的第一轮会把当前 RSS 里的约 20 条帖子当作新帖，因为此时还没有「已见」水位线。建议先加一个精确的词观察推送格式，再逐步放宽。

### 关于 AI Agent 部署

如果由 AI agent 执行部署，需要遵守三条约束：

1. `APP_MASTER_KEY` 不可事后更改。改动后所有用户已存的 API Key 全部无法解密。生成一次并备份。
2. 数据位于命名卷 `nodeseek-data`。`docker compose down` 不删数据，`down -v` 会删除。
3. 不要设置 `WORKER_POOL_SIZE`。留空时按 `os.availableParallelism()`（读取 cgroup 限额）自动取值，手动指定容易出现线程数与 CPU 配额不匹配。

可复制的部署指令：

```
部署这个项目：git clone https://github.com/Seameee/NodeSeekRSSMonitor.git（若 server/ 不存在则加 -b docker）&& cd NodeSeekRSSMonitor/server && cp .env.example .env，然后在 .env 里填 TELEGRAM_BOT_TOKEN（向我索取）、APP_MASTER_KEY 用 openssl rand -hex 32 生成、MULTI_USER_ENABLED=true，最后 docker compose up -d，确认 docker compose ps 显示 healthy。
```

### 预构建镜像与源码构建

默认使用 GitHub Actions 构建的镜像，同时提供 amd64 与 arm64：

```yaml
image: ghcr.io/seameee/nodeseek-monitor:latest
```

同一台机器上只能运行一份。compose 中固定了 `container_name: nodeseek-monitor`，再次部署会因容器名重复而失败，报错为 `Conflict. The container name "/nodeseek-monitor" is already in use`。确需多实例时，需同时修改 `container_name`、卷名和数据目录。

若 `docker compose up` 报 `401 Unauthorized` 或 `denied`，说明 GHCR 上的包不是公开的。容器包不会自动继承仓库可见性，需要手动设为 Public：`https://github.com/users/Seameee/packages/container/nodeseek-monitor/settings` → Visibility → Public。改完无需重新构建。

也可以改为源码构建：

```bash
# 方式一：本地克隆后构建
cd server && docker compose up -d --build
```

```yaml
# 方式二：让 compose 直接拉取源码构建
# 把 compose 里的 image: 换成：
build:
  context: https://github.com/Seameee/NodeSeekRSSMonitor.git#docker:server
```

## Cloudflare Workers 部署

Workers 版（`worker.js`）是单用户部署，运行在 Cloudflare 边缘，无需自备服务器。与 Docker 版相比有几点不同：

| | Docker 版 | Workers 版 |
| --- | --- | --- |
| 用户数 | 多用户，自助 `/bind` | 单用户，只服务 `ALLOWED_USER_ID` |
| 存储 | 本地 SQLite | Cloudflare D1 |
| 接收方式 | 长轮询 | Webhook |
| 调度 | 进程内定时器 | Cron Trigger |
| 命令 | 完整命令集，含 `/bind`、`/ai`、`/admin` | 无 `/bind`、`/ai`、`/admin` |
| AI 摘要 | 每个用户在 Telegram 内自带 Key | 通过环境变量统一配置 |
| 首轮行为 | 推送当前约 20 条帖子 | 静默标记，不推送 |

Workers 版需要 D1 数据库绑定、一个 Cron Trigger 和若干环境变量。仓库内没有附带 `wrangler.toml`，因为数据库 ID 与绑定需与实际账号对应，无法预先写死。下面给出完整的配置内容。

### 前置条件

- Cloudflare 账号
- Node.js 22.13 及以上（供 `wrangler` 运行）
- 一个 Bot Token，从 [@BotFather](https://t.me/BotFather) 用 `/newbot` 获取
- 自己的 Telegram 用户 ID，从 [@userinfobot](https://t.me/userinfobot) 获取

### 创建 D1 数据库

```bash
npx wrangler login
npx wrangler d1 create nodeseek
```

命令会输出 `database_id`，填入下一步的配置文件。

### 编写 wrangler.toml

在仓库根目录（与 `worker.js` 同级）创建 `wrangler.toml`：

```toml
name = "nodeseek-monitor"
main = "worker.js"
compatibility_date = "2026-10-22"

[[d1_databases]]
binding = "DB"
database_name = "nodeseek"
database_id = "这里填 d1 create 输出的 ID"

[triggers]
crons = ["* * * * *"]
```

`binding = "DB"` 必须保持这个名称，代码通过 `env.DB` 访问数据库。

### 配置环境变量

必填三项：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`ALLOWED_USER_ID` 不是密钥，可写在 `wrangler.toml` 的 `[vars]` 段：

```toml
[vars]
ALLOWED_USER_ID = "你的 Telegram 用户 ID"
```

`WEBHOOK_SECRET` 用随机字符串即可，`openssl rand -hex 32` 生成一个。它用于校验 Webhook 请求来源，未设置时代码会跳过校验。

需要 AI 摘要时再补以下变量，全部通过 `wrangler secret put` 设置或写入 `[vars]`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 无 | 上游模型密钥，未设置则不启用摘要 |
| `AI_MODEL` | 无 | 主模型名称，与 `AI_API_KEY` 同时存在才启用 |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | 上游地址，需兼容 OpenAI 协议 |
| `AI_MODEL_FALLBACK` | 空 | 备用模型，逗号分隔，按顺序回退 |
| `AI_MIN_LEN` | `0` | 正文最小长度，短于该值不生成摘要 |
| `AI_MAX_PER_ROUND` | `5` | 每轮最多生成几条摘要 |
| `AI_MAX_TOKENS` | `4000` | 单次生成上限。推理型模型不宜设得过小，否则思考过程会耗尽预算并返回空内容 |
| `AI_TIMEOUT_MS` | `15000` | 单次请求超时 |
| `AI_PROMPT` | 内置默认 | 自定义摘要提示词 |

### 部署与初始化

```bash
npx wrangler deploy
```

部署后会得到一个 `https://<worker名>.<子域>.workers.dev` 域名。首次部署完成后需要执行一次初始化，它会建表并注册 Webhook：

```bash
curl -s https://<worker名>.<子域>.workers.dev/setup
```

返回内容应包含 `"database": "ok"` 与 Telegram 的 Webhook 注册结果。若 `webhook` 部分报错，通常是因为 `TELEGRAM_BOT_TOKEN` 未设置或填写错误。

初始化完成后，Cron Trigger 会每分钟触发一次轮询。首次轮询只做静默标记，不会推送历史帖子。

在 Telegram 私聊 Bot 发送 `/status` 确认部署正常。

### 注意事项

- 同一 Bot Token 不能同时用于长轮询和 Webhook。若该 Token 已被 Docker 版使用，需先停掉 Docker 版，否则 Telegram 侧会返回 `409 Conflict`。
- Workers 版的状态（包括勿扰设置）存储在 D1 的 `settings` 表，与 Docker 版不共享数据。
- 查看实时日志：

```bash
npx wrangler tail
```

- 修改 `worker.js` 后需重新执行 `npx wrangler deploy` 才会生效。

## 运行模式

由 `MULTI_USER_ENABLED` 决定，默认为单用户模式。

| | 单用户（默认） | 多用户 |
| --- | --- | --- |
| 可用范围 | 只有管理员 | 管理员与所有 `/bind` 用户 |
| `/bind` | 仅第一个用户，即认领管理员 | 任何人可自助开通 |
| 配额 | 管理员不受限 | 普通用户受配额限制 |
| 关键词与 AI 配置 | 各自独立 | 各自独立 |

切换无需重启，管理员随时可执行：

```
/admin multiuser on       # 开放给其他人
/admin multiuser off      # 收回，仅管理员可用
/admin multiuser default  # 清除覆盖，回到 .env 的设置
```

切换有三条保证：数据不丢（关闭不删除任何用户的关键词与配置）、立即生效（普通用户命令被拒，当轮起不再推送）、可逆（重新开启后立即恢复，无需重新配置）。

优先级为：管理员覆盖（存于数据库，重启后仍有效）优先于 `.env` 中的 `MULTI_USER_ENABLED`。

## 命令

下表为 Docker 版命令集。Workers 版没有 `/bind`、`/ai`、`/admin`，其余命令（`/add`、`/list`、`/remove`、`/pause`、`/resume`、`/categories`、`/dnd`、`/status`、`/history`、`/help`）行为相同，另外多一个 `/dev` 用于临时跳过关键词过滤、推送全部新帖，详见 [Workers 部署](#cloudflare-workers-部署)。

### 所有用户

| 命令 | 说明 |
| --- | --- |
| `/bind` | 开通账号 |
| `/add <关键词> [版块] [--regex]` | 添加关键词 |
| `/list` | 查看自己的关键词 |
| `/remove <序号…\|关键词\|all>` | 删除，`/del` 同义，支持批量 |
| `/pause <序号…\|关键词\|all>` | 暂停但不删除，支持批量 |
| `/resume <序号…\|关键词\|all>` | 恢复，支持批量 |
| `/categories` | 列出可用版块 |
| `/ai set <key> [base_url]` | 配置 AI 密钥与地址 |
| `/ai fallback <模型1,模型2>` | 配置模型链，第一个为主模型 |
| `/ai num <minLen> <maxPerRound> <maxTokens> <timeoutMs>` | 调整摘要参数 |
| `/ai prompt <提示词>` | 自定义摘要提示词 |
| `/ai test` | 连通性测试，消耗 1 次配额 |
| `/ai status`、`/ai on`、`/ai off`、`/ai clear` | 查看、开关、清除配置 |
| `/dnd <时长\|时段\|on\|off\|backlog\|tz>` | 勿扰模式，暂停推送并可补看，`/mute` 同义 |
| `/status` | 状态与今日用量，含勿扰状态 |
| `/history [数量]` | 最近推送记录 |
| `/help` | 帮助 |

### 仅管理员

| 命令 | 说明 |
| --- | --- |
| `/admin` | 管理面板 |
| `/admin users [页码]` | 用户列表 |
| `/admin find <ID\|用户名>` | 搜索用户 |
| `/admin info <id>` | 用户详情，含用量与 AI 状态 |
| `/admin ban`、`/admin unban <id>` | 封禁、解封 |
| `/admin quota <id> kw\|ai\|push <数值\|-1>` | 设置配额，`-1` 恢复默认，`ai` 设 `0` 为不限 |
| `/admin note <id> <备注>` | 添加备注 |
| `/admin del <id>` | 删除用户及其全部数据 |
| `/admin stats` | 全局统计与运行时状态 |
| `/admin multiuser on\|off\|default` | 切换运行模式 |
| `/admin open on\|off` | 开关自助注册，仅多用户模式生效 |
| `/admin audit` | 最近的管理操作 |

### 示例

```
/add 搬瓦工                     # 全部版块
/add 搬瓦工 trade               # 仅交易版
/add 搬瓦工 trade,info          # 交易版与情报版，拆成 2 条，各占配额
/add 补货.*(CN2|GIA) --regex    # 正则，全部版块

/remove 2                       # 删除第 2 条
/pause 绿云                     # 按关键词名操作
```

### 批量操作

`/remove`、`/pause`、`/resume` 共用同一套选择器，一次可处理多条。个人关键词上限为 20 条，而单条往往是几百字符的品牌名正则，逐条操作成本较高。

```
/pause 3                        # 单条
/pause 1 3 5                    # 多个序号，空格或逗号分隔
/pause 1,3,5                    # 同上，中文逗号亦可
/pause 1-5                      # 范围
/pause 绿云 搬瓦工              # 按关键词名，不区分大小写
/pause all                      # 全部
```

多种写法可以混用，例如 `/remove 1 kw4`。序号、范围与关键词名会合并去重后一次性处理，重复的序号只生效一次。

关键词名本身含空格时（如 `绿云 补货`，或正则里的 `补货 .*(CN2|GIA)`），将整个名称原样写出即可。匹配时会先尝试把整个参数当作一条完整名称，命中则按单条处理：

```
/pause 绿云 补货                 # 命中名为「绿云 补货」的那一条
/pause 补货 .*(CN2|GIA)          # 正则含空格也能整体匹配
```

执行结果会说明改动条数、剩余条数，并列出受影响的关键词（长正则自动截断）。若选择器中有越界或不存在的目标，有效项照常执行，无效项单独列出，不会因单项错误撤销整批。

```
已暂停 2 条

· greencloud ·trade
· 搬瓦工

未处理：序号 99 不存在（共 5 条）
```

两点需要留意：

- 序号按执行前的列表计算。`/remove 1 2` 删除的是原来的第 1、2 条，不会因先删除第 1 条而把原第 3 条当作第 2 条。
- `/remove all` 需要二次确认：首次仅回复待删除数量并提示 `/remove all confirm`，避免误删积累的正则。`/pause all` 与 `/resume all` 可逆，无需确认。

`/pause`、`/resume` 遇到本就处于目标状态的条目会跳过并说明，不会虚报成功。

## 匹配规则

- 只匹配标题，不匹配正文。
- 子串模式不区分大小写；正则模式自动带 `i` 标志。不要写 `(?i)`，JavaScript 不支持该语法，会报错。
- 多个关键词之间是「或」关系。
- 指定多个版块时会拆成多条记录，各占一条关键词配额。

### 可用版块

| 代码 | 名称 | 代码 | 名称 |
| --- | --- | --- | --- |
| `daily` | 日常 | `tech` | 技术 |
| `info` | 情报 | `review` | 测评 |
| `trade` | 交易 | `carpool` | 拼车 |
| `dev` | Dev | `photo-share` | 贴图 |
| `expose` | 曝光 | `sandbox` | 沙盒 |

## AI 摘要

默认关闭，且不通过环境变量配置。每个用户使用自己的 API Key，在 Telegram 中设置。

配置后每条推送会多一句摘要，并标注实际产出该摘要的模型：

```
/ai set sk-你的key https://api.deepseek.com/v1
/ai fallback kimi-k2.6,deepseek-flash,qwen3.8-27b   # 第一个为主模型
/ai test                                            # 验证连通性
```

行为说明：

- 回退逐级进行。网络异常、非 2xx 响应、返回内容为空都会触发下一级；全部失败时只是没有摘要，通知照常发送。
- 正文为空的帖子跳过摘要。约 20% 的帖子被作者设为「仅注册用户可见」，取不到正文，属于正常情况。
- 单条最坏耗时约为 `模型数 × timeoutMs`。配置回退链后建议调小 `timeoutMs`，例如 `8000`。
- 推理型模型的 `max_tokens` 不宜过小（默认 4000）。思考过程会耗光预算，表现为 HTTP 200 但内容为空。

摘要缺失时的排查顺序：

1. `/ai status`：未配置会直接显示用法，已配置会显示链路与今日用量
2. `/ai test`：直接返回上游错误，401 为 Key 无效，404 为模型名或地址错误
3. 日志搜索 `[ai]`：会打印 HTTP 状态与上游响应的前 160 字符

## 勿扰模式

暂停推送，但不丢消息。每个用户独立设置，互不影响，管理员同样适用。

```bash
/dnd 2h                      # 暂停推送 2 小时，到点自动恢复
/dnd 90m                     # 90 分钟，也支持 1d、1.5h、8小时、45分钟
/dnd 23:00-08:00             # 每天该时段暂停，可跨零点
/dnd on                      # 一直暂停，直到 /dnd off
/dnd off                     # 立即恢复推送
/dnd backlog                 # 补看期间错过的帖子
/dnd backlog --clear         # 看完后清空，之后只显示新的
/dnd tz Asia/Shanghai        # 设置时区，定时段时使用
/dnd                         # 查看当前状态与错过条数
```

### 为什么用暂停推送而不是静音发送

最初的实现使用 Bot API 的 `disable_notification` 参数。该方案经实测后被否决。

官方文档对该参数的说明是「Users will receive a notification with no sound」，即声音消失但通知照常弹出。实际使用反馈「依旧在提醒」，用一条静音消息与一条普通消息对照验证，确认静音消息确实无声，但通知仍会出现。

因此改为完全不发送。期间命中的帖子写入 `notifications` 表，状态为 `muted`，通过 `/dnd backlog` 补看。

### 无法实现 Telegram 客户端的「灰色圆点」

「只显示灰色圆点标记有新消息，不进未读也不弹通知」对应 Telegram 客户端的「归档并静音」。这是账号级的 chat 设置，Bot API 没有修改接收方聊天状态的权限，任何 bot 都无法做到，并非本项目的实现限制。

需要该效果时，在 Telegram 中对 Bot 会话长按或点击顶部名称，选择「归档并静音」，设置一次即长期有效。两种方式定位不同，可以并存：

| 方案 | 消息送达 | 通知栏 | 未读标记 | 需事前设置 |
| --- | --- | --- | --- | --- |
| 客户端「归档并静音」 | 是 | 不弹 | 灰色圆点 | 是，永久 |
| `/dnd` 暂停推送 | 否，不发送 | 不弹 | 无 | 否，可定时 |

### 实现细节

- 跨零点时段：`23:00-08:00` 指 23 点之后或早上 8 点之前，凌晨几个小时同样计入。判定使用「或」而非区间包含。
- 时区单独存储。容器内通常为 UTC，而 `23:00` 指用户本地钟点，直接按 UTC 比较会使整个窗口偏移 8 小时。默认 `Asia/Shanghai`，可用 `DND_TIMEZONE` 环境变量修改，用户也可用 `/dnd tz` 覆盖。
- 补看的锚点指向「此刻之后 1 秒」而非清空。若置空，兜底逻辑会退回 24 小时前，刚看过的记录会重新列出，用户会以为清空未生效。

### 边界与限制

- 单次暂停上限 30 天，最小 1 分钟。超出范围会提示，不会静默截断。
- 起止时间相同的 `23:00-23:00` 会被拒收。「整天暂停」与「未设置」两种解释都成立，用 `/dnd on` 表达没有歧义。
- 勿扰期间跳过 AI 摘要。消息不发送，摘要无人查看，但仍会消耗用户的上游费用。
- `/history` 不显示被拦下的帖子，它们从未发出，不能算作推送记录。补看走 `/dnd backlog`，两条路径语义分开。
- 勿扰只影响设置者本人。管理员开启勿扰不会影响其他用户，该行为有测试覆盖。
- 老库升级时会自动 `ALTER TABLE` 补齐字段并记录日志，操作幂等，已有用户默认为 `off`。
- Worker 版（`worker.js`）提供同一套 `/dnd` 与 `/dnd backlog`。它是单用户部署，状态存于 `settings` 表。

## 安全与隐私

### 用户 API Key 的存储

Key 经 AES-256-GCM 加密后入库，格式为 `v1:<iv>:<认证标签>:<密文>`，每次使用独立随机 IV，认证标签可检测篡改。

| 场景 | 能否读到明文 |
| --- | --- |
| 仅拿到数据库文件（备份泄漏、卷被读取） | 否，只有密文 |
| 同时拿到 `.env` 中的 `APP_MASTER_KEY` | 是 |

由于 Bot 需要用用户的 Key 调用上游模型，加密必须是可逆的对称加密而非散列，散列会使 Key 不可用。因此作为服务器运维者，技术上可以解密用户存储的 Key。这由「服务端代调用」的架构决定，不是实现缺陷。`/ai status` 与管理员 `/admin info` 均只显示打码串（形如 `sk-otb…nCDV`），没有查看明文的入口，日志也做了脱敏。

建议向用户说明这一点，并建议他们使用可随时吊销、设有额度限制的 Key。另外，不要把 `.env` 与数据库打包进同一个备份，两者分离时数据库才真正安全。

`APP_MASTER_KEY` 一经设定即不可更改。修改后所有用户已存的 Key 都无法解密，服务会跳过该用户并记录一条 `API Key 无法解密`，不会崩溃。

### 防护措施

**ReDoS 防护。** 关键词正则是用户可控输入，`(a+)+$` 这类模式可以钉死事件循环。防护分三层：

1. 长度上限，`MAX_REGEX_LEN` 默认 500
2. 静态分析拒绝嵌套量词、反向引用等回溯炸弹结构
3. 实际匹配运行在 worker 线程并带硬超时，超时即终止并重建该 worker，主进程不受影响

**SSRF 防护。** `/ai set` 的 `base_url` 做词法校验，拒绝本机、内网、链路本地、CGNAT（含云元数据 `100.100.100.200`）与 IPv6 本地等字面量地址。

词法校验挡不住「攻击者控制的域名解析到内网」。单用户自用可以接受；公开多用户部署建议额外限制容器出口，只放行必要的公网地址，或改为解析 DNS 后校验目标 IP。后者当前未实现。

**容器加固。** compose 默认启用 `no-new-privileges`、`cap_drop: ALL`、只读根文件系统（仅 `/data` 与 `/tmp` 可写）、以非 root（uid 1000）运行，并用 tini 作为 PID 1 保证 `SIGTERM` 优雅退出。

**日志脱敏。** `logger.js` 对输出做模式匹配打码，覆盖 `sk-` 前缀、`Bearer` 令牌、URL 中的 token 等。

### 防滥用默认值

| 层面 | 机制 | 默认值 |
| --- | --- | --- |
| 命令频率 | 每用户令牌桶 | 20 条/分钟 |
| 注册 | 冷却与人数上限 | 30 秒，200 人 |
| 推送量 | 每用户每日配额 | 500 条 |
| 关键词数量 | 每用户上限 | 20 条 |
| 单轮规模 | 单用户单轮推送上限 | 10 条，超出合并为汇总消息 |
| 全局限流 | Telegram 发送速率 | 20 条/秒 |
| AI 调用 | 每用户每日配额 | 不限，`0` 表示不限 |

管理员不受任何配额限制，单用户模式下只有管理员一人，设限没有意义。可用 `/admin quota <id> ai 500` 为可信用户放宽。

## 环境变量

完整列表与逐项说明见 [`server/.env.example`](server/.env.example)。

### 必填

| 名称 | 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot Token，从 [@BotFather](https://t.me/BotFather) 获取 |
| `APP_MASTER_KEY` | 加密用户 API Key 的主密钥，`openssl rand -hex 32` 生成，不可事后更改 |

### 常用

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `MULTI_USER_ENABLED` | `false` | `false` 为单用户，`true` 允许多人自助 `/bind`。管理员可用 `/admin multiuser` 运行时覆盖 |
| `ADMIN_TELEGRAM_IDS` | 空 | 预指定管理员，逗号分隔。留空时第一个 `/bind` 的人成为管理员。填写可防止被陌生人认领，也可用于找回管理权 |
| `REGISTRATION_OPEN` | `true` | 多用户模式下是否开放自助注册，关闭后仅管理员能开通 |
| `MAX_USERS` | `200` | 用户总数上限，仅多用户模式生效 |
| `DEFAULT_MAX_KEYWORDS` | `20` | 新用户关键词上限 |
| `DEFAULT_DAILY_PUSH_QUOTA` | `500` | 新用户每日推送上限 |
| `DEFAULT_DAILY_AI_QUOTA` | `0` | 新用户每日 AI 上限，`0` 表示不限 |
| `COMMAND_RATE_PER_MIN` | `20` | 每用户每分钟命令数 |
| `POLL_INTERVAL_MS` | `60000` | 轮询间隔，最小 10000 |
| `SEND_RATE_PER_SEC` | `20` | 全局发送速率，Bot API 上限约为 30 |
| `AI_CONCURRENCY` | `8` | 同时在飞的 AI 请求数 |
| `ALLOW_GROUP_CHATS` | `false` | 是否允许在群聊中使用 |
| `DND_TIMEZONE` | `Asia/Shanghai` | 勿扰模式定时段的默认时区，用户可用 `/dnd tz` 覆盖 |
| `LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error` |

### 需要留意的两项

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `WORKER_POOL_SIZE` | 自动 | 建议不设。留空时取 `max(2, min(4, os.availableParallelism()))`，后者读取 cgroup 限额。设为 `0` 可禁用 worker，退化为进程内计算，但会失去 ReDoS 硬超时保护 |
| `WORKER_TASK_TIMEOUT_MS` | `5000` | 单任务超时，超时即判定为恶意正则并终止 worker。弱机器上正常任务也可能超时：实测 1 CPU 容器中「4 万关键词 × 30 帖」需 24.6 秒，会被误杀 |

## 性能与容量

### CPU 与并发

容器默认分配 1 核，对应 `docker-compose.yml` 中的 `deploy.resources.limits.cpus: "1.0"`。

本服务以 I/O 为主，大部分时间在等待 RSS、Telegram 与 AI 上游，CPU 只在解析 XML 和运行关键词正则时短暂繁忙。1 核足以应对常规规模，也不会与同机其他服务争抢资源。默认值取保守，需要时由使用者调大。

worker 线程池自动跟随配额，通过 `os.availableParallelism()` 读取 cgroup 限额：

| `cpus` | 容器可用 CPU | 自动线程数 | 匹配阶段（2000 用户 × 20 词） |
| --- | --- | --- | --- |
| `"1.0"`（默认） | 1 | 2 | 3180 ms |
| `"2.0"` | 2 | 2 | 1437 ms |
| `"3.0"` | 3 | 3 | — |
| `"4.0"` | 4 | 4 | — |

从 1 核提升到 2 核，匹配阶段约快一倍，与配额增幅一致。用户数达到千级、或关键词为大列表正则时，建议分配 2 到 4 核。

修改方式为编辑 `docker-compose.yml` 中的 `cpus`，然后执行 `docker compose up -d` 重建容器。

两点需要留意：

1. `cpus` 是 cgroup 配额，不会使 `os.cpus()` 返回的核数变小，它仍报宿主机核数。线程数不能按 `os.cpus()` 取值，否则会在 1 核配额里开启 4 个线程互相争抢（同一负载实测从 452 ms 恶化到 3180 ms）。代码已改用 `availableParallelism()`，不要手动设置 `WORKER_POOL_SIZE` 覆盖它。
2. 配额给满（如 `"4.0"`）时，突发流量下本服务可与同机其他容器争用全部核心。共享机器上应留出余量。

宿主机核数较多、又不希望修改 git 中的默认值时，可使用 override 文件，避免与上游改动冲突：

```yaml
# docker-compose.override.yml，与 docker-compose.yml 同目录
services:
  nodeseek-monitor:
    deploy:
      resources:
        limits:
          cpus: "4.0"
```

### 一轮只抓取一次 RSS

```
抓取（1 次，与用户数无关）
  └─► 解析（worker 线程，1 次）
        └─► 内存匹配（每用户，纯内存）
              └─► AI 摘要（仅有配额且已配置的用户）
                    └─► 发送（受全局限速）
```

100 个用户与 1 个用户在网络抓取上的开销完全相同，只有内存匹配量随用户数线性增长。

### 各环节的实际上限

| 环节 | 上限 | 折算 |
| --- | --- | --- |
| Telegram 发送 | 约 1180 条/轮（20 条/秒 × 60 秒） | 平均每人每轮命中需低于 0.59 帖；调到 30 条/秒则约 1775 |
| AI 摘要 | 不再是瓶颈（同帖场景 200 人 104 ms） | 内容各异的极限约为 `AI_CONCURRENCY × 轮询间隔 / 单次延迟` |
| 关键词匹配 | 约占一轮的 1% | 到 1 万用户仍有余量 |
| 数据库 | 水位线恒定 2000 行 / 0.3 MiB | 不随用户数或时间增长 |

发送速率是第一瓶颈。2000 个用户在同一轮全部命中时需要约 100 秒，超过 60 秒的轮询间隔，表现为跳过后续轮次并丢失通知（RSS 只提供最新约 20 条，掉出窗口的帖子不会再推）。达到该量级需调整两个参数：

```bash
POLL_INTERVAL_MS=90000     # 摊开突发
SEND_RATE_PER_SEC=30       # Telegram 文档上限
```

### 已见记录的实现选择

已见记录不是「每用户 × 每帖一行」，而是每个「用户 × 源」只存一行「见过的最大 post_id」（`seen_state` 表）。帖子号随发帖时间严格递增，因此「id 小于等于水位线」等价于「已见过」。

旧实现存在容量问题：实测 NodeSeek 约 2.8 帖/分钟，2000 用户 7 天会增长到约 6000 万行、6 GiB，而 RSS 只暴露最新约 20 条，绝大多数行永远不会被查询。每小时清理仍是一次全表扫描（490 万行实测 6.9 秒），且运行在主线程上，期间 bot 不响应命令。

改为水位线后，数据量恒定为 2000 行、0.3 MiB，`filterUnseen` 处理 2000 用户耗时 13 ms，`markSeen` 耗时 58 ms，且不再需要按时间清理。

老库只有 `seen_posts` 而缺少水位线时，会按需用旧表中该用户的最大 `post_id` 初始化水位线，走主键索引，单次 O(log n)。缺少这一步时，升级后第一轮会把整个 feed 当作全新帖子，为每个老用户推送最多 10 条。

旧表不再被读取，但历史数据仍占磁盘空间，服务会在每小时维护中分批清空（约 8 万行/秒，受 `LEGACY_SEEN_PURGE_MS` 预算约束）。6000 万行约需 20 天清理完毕；需要立即释放空间则重建数据卷。

## 运维

### 数据与备份

数据库位于容器内 `/data/nodeseek.db`，含 WAL 与 SHM 文件，默认放在命名卷 `nodeseek-data`。

```bash
# 备份。需包含 .env，否则没有 APP_MASTER_KEY 时 Key 是无法解开的密文
docker compose stop
docker run --rm -v nodeseek-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/nodeseek-backup-$(date +%F).tar.gz -C /data .
cp .env nodeseek-backup-$(date +%F).env
docker compose start
```

```bash
# 恢复
docker compose down
docker run --rm -v nodeseek-data:/data -v "$PWD:/backup" alpine \
  sh -c "tar xzf /backup/nodeseek-backup-YYYY-MM-DD.tar.gz -C /data"
docker compose up -d
```

### 改用宿主机目录

将 compose 中的 `- nodeseek-data:/data` 改为 `- ./data:/data`，并删除末尾的 `volumes:` 段。

必须预先创建目录并将属主改为 uid 1000，否则会因属主为 root 而反复崩溃：

```
Error: unable to open database file (ERR_SQLITE_ERROR, errcode 14)
```

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

之后数据位于 `./data/nodeseek.db`，备份命令为 `tar czf nodeseek-backup-$(date +%F).tar.gz data/ .env`。

### 升级

```bash
docker compose pull && docker compose up -d
```

schema 通过 `CREATE TABLE IF NOT EXISTS` 幂等创建，可直接升级，无需手动迁移。

修改 compose 或 `.env` 后，`docker compose up -d` 会通过配置哈希检测变化并自动重建容器。实测修改 `cpus` 或 `env_file` 都会触发 `Recreated`，通常不需要手动 `--force-recreate`。

若修改配置后看到 `Container ... Running` 而没有 `Recreated`，说明 compose 认为配置未变化，此时才需要 `--force-recreate`。修改后建议直接核对容器的实际值：

```bash
docker inspect nodeseek-monitor --format 'NanoCpus={{.HostConfig.NanoCpus}}'   # 1e9 为 1 核
docker exec nodeseek-monitor sh -c 'cat /sys/fs/cgroup/cpu.max'                # 100000 100000 为 1 核
```

### 健康检查

```bash
docker compose ps                                          # 查看 healthy
docker compose exec nodeseek-monitor curl -s localhost:8787/healthz | head
```

返回的 JSON 包含最近一轮耗时、推送数、worker 池状态与限流表大小。

### 排障

| 现象 | 原因与处理 |
| --- | --- |
| 日志出现 `409 Conflict` | 同一 Bot Token 在别处长轮询。停掉另一处，包括旧的 Worker Webhook |
| 收不到推送 | 用 `/status` 查看配额，用 `/list` 确认关键词已添加且未暂停。新用户第一轮可能有延迟 |
| 没有 AI 摘要 | 用 `/ai status` 查看配置，`/ai test` 查看上游报错，日志搜索 `[ai]`，并确认该帖有正文 |
| 日志出现 `API Key 无法解密` | `APP_MASTER_KEY` 被修改过。需让该用户重新执行 `/ai set` |
| 容器反复重启并报 `unable to open database file` | 使用绑定挂载但目录属主为 root。执行 `sudo chown -R 1000:1000 data`，或改回命名卷 |
| 拉镜像报 `401 Unauthorized` 或 `denied` | GHCR 包不是公开的，见[预构建镜像与源码构建](#预构建镜像与源码构建) |
| 报 `Conflict. The container name ... is already in use` | 本机已有一份在运行。同一台机器只能运行一份，或修改 `container_name` 与卷名 |
| 他人 `/bind` 提示单用户模式 | 这是默认行为。执行 `/admin multiuser on`，或在 `.env` 中设置 `MULTI_USER_ENABLED=true` |
| 自己不再是管理员 | 被其他账号抢先认领。在 `.env` 中填写 `ADMIN_TELEGRAM_IDS=你的ID` 后重启 |
| 富文本推送变成旧版式 | `sendRichMessage` 失败后降级为经典 HTML。日志搜索 `降级为经典格式`，网络抖动会自动重试 2 次 |
| 内存持续增长 | 检查 `WORKER_POOL_SIZE` 与 `AI_CONCURRENCY`。worker 超时后会重建，正常情况下不泄漏 |

### 不用 Compose

```bash
docker run -d --name nodeseek-monitor \
  --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN=xxx \
  -e ADMIN_TELEGRAM_IDS=123456789 \
  -e APP_MASTER_KEY=$(openssl rand -hex 32) \
  -v "$PWD/data:/data" \
  --read-only --tmpfs /tmp:size=16m \
  --security-opt no-new-privileges --cap-drop ALL \
  ghcr.io/seameee/nodeseek-monitor:latest
```

不使用 Docker 直接运行需要 Node.js 22.13 及以上（依赖内置 `node:sqlite`），无需执行 `npm install`：

```bash
cd server
APP_MASTER_KEY=$(openssl rand -hex 32) \
TELEGRAM_BOT_TOKEN=xxx \
ADMIN_TELEGRAM_IDS=123456789 \
DB_PATH=./data/nodeseek.db \
node src/index.js
```

## Node 版本与安全更新

基础镜像钉定到具体补丁版本：`node:24.22.1-alpine`。

2026-10-21 的 Node.js 安全公告（[原文](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)）修复了 4 个 HIGH 级问题，修复版本为 24.22.1：

| CVE | 问题 |
| --- | --- |
| CVE-2026-111497 | Brotli 解码器越界写，可导致远程代码执行 |
| CVE-2026-105482 | `dns.resolve` 截断含 NUL 字符的名称 |
| CVE-2026-105483 | IP 写成全角数字时绕过 TLS 主机名校验 |
| CVE-2026-106069 | 主机名宽松解析为 IP 时绕过 TLS 证书校验 |

不使用浮动的 `24-alpine` 标签，原因是浮动标签虽然通常能跟随上游更新，但构建结果不可复现。基础镜像缓存或镜像源滞后时会静默回退到带漏洞的版本，而 CI 仍然通过，无法从结果中察觉。钉定补丁号后，升级成为一次显式的、可审计的变更。

升级方式为修改 `Dockerfile` 中的 `ARG NODE_VERSION`，先确认标签存在：

```bash
docker run --rm node:24.22.1-alpine node --version   # 应输出 v24.22.1
```

确认容器内的实际版本：

```bash
docker exec nodeseek-monitor node --version
```

## 仓库结构

```
├── server/                    ← Docker 版全部内容
│   ├── src/                   ← 20 个模块，零第三方依赖，全部使用 Node 内置能力
│   ├── test/                  ← 19 个测试文件，185 项
│   ├── Dockerfile             ← 多阶段构建，node:24.22.1-alpine，非 root
│   ├── docker-compose.yml     ← 含安全加固与资源限制
│   └── .env.example           ← 环境变量模板
├── .github/workflows/docker.yml  ← 多架构构建并推送 GHCR
├── worker.js                  ← Cloudflare Workers 单用户版
├── proxy-server*.js           ← 可选的反向代理辅助工具
├── LICENSE                    ← MIT，仅覆盖本仓库新增与修改部分
└── NOTICE                     ← 上游来源与授权范围划分
```

运行测试：

```bash
cd server && node --check src/*.js && node --test test/*.test.js
```

### 数据表

| 表 | 用途 |
| --- | --- |
| `users` | 用户、角色、状态、配额覆盖、勿扰设置 |
| `keywords` | 监控关键词 |
| `ai_configs` | AI 配置，`api_key_enc` 为密文 |
| `seen_state` | 已见水位线，每用户每源一行 |
| `notifications` | 推送历史，供 `/history` 与 `/dnd backlog`，保留 30 天 |
| `usage_daily` | 日用量计数，保留 90 天 |
| `audit_log` | 管理操作审计，保留 30 天 |
| `rss_state` | 各源 ETag 与失败计数 |
| `settings` | 运行状态，含模式覆盖、关键词修订号等 |
| `seen_posts` | 已废弃，旧版遗留，仅分批清空 |

## 来源与致谢

本项目派生自 [Roddy-D/NodeSeekRSSMonitor](https://github.com/Roddy-D/NodeSeekRSSMonitor)。

上游提供了基础骨架：RSS 多源抓取与容错、关键词匹配（子串与正则）、D1 去重、Telegram 推送、Bot 命令集合、防洪上限与溢出汇总。

本仓库新增或重写的部分：

| 类别 | 内容 |
| --- | --- |
| 多用户服务端 | 原生 Node.js 与 SQLite 实现，角色分离、自助注册、配额与封禁 |
| 通知排版 | Bot API 10.3 富文本（标题即链接、关键词折叠、引用块承载摘要、cite 标注模型），含经典 HTML 降级与重试 |
| AI 摘要 | 用户自带 Key、多级模型回退、按内容去重与在飞请求合并 |
| 性能 | worker 线程池与 ReDoS 硬超时、水位线去重、AI 跨用户拍平、发送令牌桶 |
| 安全 | AES-256-GCM 加密 Key、日志脱敏、SSRF 词法校验、容器加固 |
| 勿扰模式 | 按用户暂停推送、定时与每日时段、跨零点与时区处理、补看 |
| 工程 | 185 项测试、可复跑基准脚本、多架构 CI 构建 |

### 授权状态

上游仓库未附带任何开源许可证，根目录只有 `README.md` 与 `worker.js`，均无版权或许可声明。按著作权法默认规则，未声明即视为保留所有权利。

因此：

- 本仓库不对上游原始代码主张任何许可，该部分权利归 [Roddy-D](https://github.com/Roddy-D) 所有
- 本仓库新增或修改的部分按根目录 `LICENSE`（MIT）授权
- 两部分的具体划分见 `NOTICE`

如需将上游原始代码用于本项目之外的用途，请联系原作者取得授权。

### 致谢

感谢 [Roddy-D](https://github.com/Roddy-D) 公开的初始实现。本项目的通知排版、AI 摘要与性能优化，都建立在它提供的骨架之上。

