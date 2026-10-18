# NodeSeek 关键词监控 Bot（Docker 版）

轮询 NodeSeek 的 RSS，**新帖标题命中你设的关键词，就推一条 Telegram 通知**，可选 AI 摘要。

跑在你自己的服务器上，支持多用户：任何人 `/bind` 就能自助开通，各自的关键词与 AI 配置互不可见。

> 本分支（`docker`）只包含 Docker 多用户版。Cloudflare Workers 单用户版在 `main` 分支。
> 本项目派生自 [Roddy-D/NodeSeekRSSMonitor](https://github.com/Roddy-D/NodeSeekRSSMonitor)，署名与授权见文末[来源与致谢](#来源与致谢)。

---

## 一句话部署（给 AI Agent）

如果你是在用 Claude Code / Codex / Cursor 这类 AI agent 部署本项目，把下面这句话连同仓库地址一起丢给它即可：

> **克隆 `https://github.com/Seameee/NodeSeekRSSMonitor.git` 的 `docker` 分支，进入 `server/`，从 `.env.example` 复制出 `.env` 并填好 `TELEGRAM_BOT_TOKEN`（向用户索取）与 `APP_MASTER_KEY`（用 `openssl rand -hex 32` 生成），设置 `MULTI_USER_ENABLED=true`，然后执行 `docker compose up -d`，等 `docker compose ps` 显示 `healthy` 后，把 `.env` 里的 `APP_MASTER_KEY` 备份提醒和「第一个发 `/bind` 的人会成为管理员」告知用户。**

可复制版：

```
部署这个项目：git clone -b docker https://github.com/Seameee/NodeSeekRSSMonitor.git && cd NodeSeekRSSMonitor/server && cp .env.example .env，然后在 .env 里填 TELEGRAM_BOT_TOKEN（问我）、APP_MASTER_KEY 用 openssl rand -hex 32 生成、MULTI_USER_ENABLED=true，最后 docker compose up -d，确认 docker compose ps 显示 healthy。
```

Agent 需要知道的三个硬约束（写在这里省得它踩坑）：

1. **`APP_MASTER_KEY` 不可事后更改** —— 改了所有用户已存的 API Key 全部解不开。生成一次，备份好。
2. **数据在命名卷 `nodeseek-data` 里**，`docker compose down` 不会删数据，`down -v` 会。别乱加 `-v`。
3. **不要设 `WORKER_POOL_SIZE`** —— 留空时它按 `os.availableParallelism()`（读 cgroup 限额）自动取值，手动设反而容易配错。

---

## 部署

### 前置条件

- Docker 20.10+ 与 Docker Compose v2（`docker compose` 命令）
- 1 核 CPU 起（compose 默认 `cpus: "1.0"`，见下方[CPU 与并发](#cpu-与并发)）
- 内存 128 MB 起（默认限制 512 MB）
- 能访问 `api.telegram.org` 与 `rss.nodeseek.com`
- 一个 Bot Token：[@BotFather](https://t.me/BotFather) → `/newbot`

### 三步启动

**1. 拉代码**

```bash
git clone -b docker https://github.com/Seameee/NodeSeekRSSMonitor.git
cd NodeSeekRSSMonitor/server
```

**2. 配置 `.env`**

```bash
cp .env.example .env
chmod 600 .env
```

至少要改这两项：

```bash
# 从 @BotFather 获取
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# 主密钥，加密用户 API Key 用。生成后立刻备份，改动即不可逆
APP_MASTER_KEY=
```

`APP_MASTER_KEY` 用这条命令直接写进去：

```bash
sed -i "s|^APP_MASTER_KEY=.*|APP_MASTER_KEY=$(openssl rand -hex 32)|" .env
```

想开放给多人用，再加一行：

```bash
MULTI_USER_ENABLED=true
```

> 默认是 `false`（单用户，只有管理员能用）。**开放注册前请先自己 `/bind` 认领管理员**，否则先找到这个 Bot 的陌生人会变成管理员。

**3. 启动**

```bash
docker compose up -d
docker compose logs -f
```

看到这两行就是正常：

```
[health] 健康检查监听 :8787/healthz
[poller] 本轮完成：20 帖 / 0 用户 / 推送 0 条 / 摘要 0 条 / 耗时 220ms
```

`Ctrl+C` 退出日志（容器继续在后台跑）。确认状态：

```bash
docker compose ps     # 应显示 healthy
```

**4. 认领管理员**

在 Telegram 私聊你的 Bot，发 `/bind`。**第一个绑定的人自动成为管理员。**

```
/add 绿云              # 添加关键词
/list                  # 查看
/ai set sk-xxx         # 可选，配置 AI 摘要
/admin                 # 管理面板（仅管理员）
```

> ⚠️ **新部署的第一轮会把当前 RSS 里的 20 条帖子当作新帖**（因为还没有「已见」水位线）。所以别一开始就加大词——先加一个精确词，看一轮推送长什么样再往上加。

---

## 用预构建镜像，还是自己构建

默认用 GitHub Actions 构建好的镜像，多架构（amd64/arm64）：

```yaml
image: ghcr.io/seameee/nodeseek-monitor:latest
```

> ⚠️ **同一台机器上只能跑一份。** compose 里写死了 `container_name: nodeseek-monitor`，再部署一份会因为容器名重复而失败（报 `Conflict. The container name "/nodeseek-monitor" is already in use`）。确实需要多实例时，把 `container_name` 改成别的名字、并把 compose 里的卷名和数据目录一并区分开。

**如果 `docker compose up` 报 `401 Unauthorized` / `denied`**：说明 GHCR 上的包不是公开的。容器包**不会**自动继承仓库可见性，需要作者手动设为 Public：

`https://github.com/users/Seameee/packages/container/nodeseek-monitor/settings` → Visibility → Public

改完不需要重新构建。不想公开也没关系，改用源码构建（源码仓库是公开的）：

```bash
# 方式一：本地克隆后构建
cd server && docker compose up -d --build

# 方式二：让 compose 直接拉源码构建
#   把 compose 里的 image: 换成：
#     build:
#       context: https://github.com/Seameee/NodeSeekRSSMonitor.git#docker:server
```

---

## 单用户 vs 多用户

由 `MULTI_USER_ENABLED` 决定，**默认单用户**：

| | 单用户（默认） | 多用户 |
| --- | --- | --- |
| 谁能用 | 只有管理员 | 管理员 + 所有 `/bind` 的用户 |
| `/bind` | 仅第一个用户（认领管理员） | 任何人都可自助开通 |
| 配额 | 管理员不受限 | 普通用户受配额限制 |
| 关键词与 AI 配置 | 各自独立 | 各自独立 |

**不用重启就能切换**，管理员随时可用：

```
/admin multiuser on       # 开放给其他人
/admin multiuser off      # 收回，仅管理员可用
/admin multiuser default  # 清除覆盖，回到 .env 的设置
```

切换的三条保证：**数据不丢**（关闭不删任何用户的关键词与配置）、**立即生效**（普通用户命令被拒、当轮起不再推送）、**可逆**（重开后立刻恢复，无需重配）。

优先级：**管理员覆盖（存在库里，重启仍有效）> `.env` 的 `MULTI_USER_ENABLED`**。

---

## 命令一览

### 所有用户

| 命令 | 说明 |
| --- | --- |
| `/bind` | 开通账号（自助注册） |
| `/add <关键词> [版块] [--regex]` | 添加关键词 |
| `/list` | 查看自己的关键词 |
| `/remove <序号…\|关键词\|all>` | 删除（`/del` 同义），支持批量 |
| `/pause <序号…\|关键词\|all>` | 暂停但不删除，支持批量 |
| `/resume <序号…\|关键词\|all>` | 恢复，支持批量 |
| `/categories` | 可用版块 |
| `/ai set <key> [base_url]` | 配置 AI 密钥与地址 |
| `/ai fallback <模型1,模型2>` | 模型链，第 1 个是主模型 |
| `/ai num <minLen> <maxPerRound> <maxTokens> <timeoutMs>` | 调参 |
| `/ai prompt <提示词>` | 自定义摘要提示词 |
| `/ai test` | 连通性测试（消耗 1 次配额） |
| `/ai status` / `/ai on` / `/ai off` / `/ai clear` | 查看 / 开关 / 清除 |
| `/status` | 状态与今日用量 |
| `/history [数量]` | 最近推送记录 |
| `/help` | 帮助 |

### 仅管理员

| 命令 | 说明 |
| --- | --- |
| `/admin` | 管理面板 |
| `/admin users [页码]` | 用户列表 |
| `/admin find <ID\|用户名>` | 搜索用户 |
| `/admin info <id>` | 用户详情（含用量、AI 状态） |
| `/admin ban` / `/admin unban <id>` | 封禁 / 解封 |
| `/admin quota <id> kw\|ai\|push <数值\|-1>` | 设置配额，`-1` 恢复默认，`ai` 设 `0` 为不限 |
| `/admin note <id> <备注>` | 写备注 |
| `/admin del <id>` | 删除用户及其**全部数据** |
| `/admin stats` | 全局统计与运行时状态 |
| `/admin multiuser on\|off\|default` | 运行模式开关 |
| `/admin open on\|off` | 开关注册（仅多用户模式生效） |
| `/admin audit` | 最近管理操作 |

### 使用示例

```
/add 搬瓦工                     # 全部版块的「搬瓦工」
/add 搬瓦工 trade               # 只看交易版
/add 搬瓦工 trade,info          # 交易版与情报版（拆成 2 条，各占配额）
/add 补货.*(CN2|GIA) --regex    # 正则，全部版块

/remove 2                       # 删第 2 条
/pause 绿云                     # 按关键词操作也行
```

### 批量操作

`/remove`、`/pause`、`/resume` 共用同一套选择器，**一次可以处理多条**——关键词上限 20 条，而一条往往是几百字符的品牌名正则，逐条操作成本很高。

```
/pause 3                        # 单条（和以前一样）
/pause 1 3 5                    # 多个序号，空格或逗号分隔
/pause 1,3,5                    # 同上（中文逗号也认）
/pause 1-5                      # 一个范围
/pause 绿云 搬瓦工              # 按关键词名（不区分大小写）
/pause all                      # 全部
```

几种写法可以混用，比如 `/remove 1 kw4`。序号、范围、关键词名会**合并去重**后一次性处理，重复的序号只生效一次。

结果会告诉你实际改了几条、剩几条，并列出受影响的关键词（长正则自动截断）。有越界或不存在的目标时，**有效的照样执行**，无效的单独列出来，不会因为一个错项把整批撤销：

```
✅ 已暂停 2 条

· greencloud ·trade
· 搬瓦工

⚠️ 未处理：序号 99 不存在（共 5 条）
```

两个细节：

- **序号按执行前的列表计算。** `/remove 1 2` 删的是原来第 1、2 条，不会因为先删了第 1 条就把原第 3 条当第 2 条删掉。
- **`/remove all` 需要二次确认**：第一次只回复「将删除全部 N 条」并给出 `/remove all confirm`，避免手滑清空一堆辛苦写好的正则。`/pause all`、`/resume all` 可逆，无需确认。

`/pause`、`/resume` 遇到本来就是目标状态的条目会跳过并说明，不会假装成功。

**匹配规则要点：**

- **只匹配标题，不匹配正文。**
- 子串模式**不区分大小写**；正则模式也自动带 `i` 标志（**不要写 `(?i)`**，JS 不支持，会报语法错误）。
- 关键词之间是**「或」**关系。
- 多版块会拆成多条记录，**各占一条关键词配额**。

### 可用版块

| 代码 | 名称 | 代码 | 名称 |
| --- | --- | --- | --- |
| `daily` | 日常 | `tech` | 技术 |
| `info` | 情报 | `review` | 测评 |
| `trade` | 交易 | `carpool` | 拼车 |
| `dev` | Dev | `photo-share` | 贴图 |
| `expose` | 曝光 | `sandbox` | 沙盒 |

---

## AI 摘要（可选）

**默认关闭，且不通过环境变量配置。** 每个用户用自己的 Key，在 Telegram 里配。

配了之后，每条推送多一句摘要，并标注**实际产出该摘要的模型**：

```
/ai set sk-你的key https://api.deepseek.com/v1
/ai fallback kimi-k2.6,deepseek-flash,qwen3.8-27b   # 第 1 个是主模型
/ai test                                            # 验证连通性
```

行为说明：

- **回退是逐级的**：网络异常、非 2xx、返回内容为空，都会触发下一级；全失败只是没有摘要，**通知照常发**。
- **正文为空的帖子跳过摘要**（约 20% 的帖子被作者设为「仅注册用户可见」，取不到正文），属正常行为。
- 单条最坏耗时约 `(模型数) × timeoutMs`，配了回退链后建议把 `timeoutMs` 调小（如 `8000`）。
- 推理型模型**别把 `max_tokens` 调太小**（默认 4000）：思考会吃光预算，表现为 HTTP 200 但内容为空。

**没摘要时怎么查**，按顺序：

1. `/ai status` —— 没配置就直接显示用法；配置了会显示链路和今日用量
2. `/ai test` —— 直接报上游的错（401 是 Key 无效、404 是模型名或地址写错）
3. 日志搜 `[ai]` —— 会打印 `HTTP 状态 + 上游响应前 160 字符`

---

## 安全与隐私

### 用户的 API Key

用 **AES-256-GCM** 加密后存库，格式 `v1:<iv>:<认证标签>:<密文>`，每次用独立随机 IV，认证标签可检测篡改。

| 场景 | 能否读到明文 |
| --- | --- |
| 拿到数据库文件（备份泄漏、卷被读） | ❌ 不能，只有密文 |
| 同时拿到 `.env` 里的 `APP_MASTER_KEY` | ✅ 能 |

> **这里要说实话**：因为 Bot 必须用用户的 Key 去调上游模型，所以用的是**可逆**对称加密，不是散列（散列会让 Key 直接不可用）。因此**作为服务器运维者，你技术上能解密用户存的 Key** —— 这是「服务端代调用」架构决定的，不是实现缺陷。`/ai status` 和管理员 `/admin info` 都只显示打码串（`sk-otb…nCDV`），没有任何「查看明文」的入口，日志也做了脱敏。
>
> 建议在给用户说明时讲清这一点，并建议他们用**可随时吊销、设了限额**的 Key。另外**别把 `.env` 和数据库打包进同一个备份**——两者分离，数据库才真正安全。

**`APP_MASTER_KEY` 一旦设定不可更改**：改了之后所有用户已存的 Key 全部解不开（服务会跳过该用户并记一条 `API Key 无法解密`，不会崩）。

### 三层防护

**ReDoS 防护** —— 关键词正则是用户可控输入，`(a+)+$` 能把事件循环钉死。三层拦截：

1. 长度上限（`MAX_REGEX_LEN`，默认 500）
2. 静态分析拒绝嵌套量词、反向引用等回溯炸弹结构
3. 实际匹配跑在 worker 线程并带硬超时，超时即终止并重建该 worker，主进程不受影响

**SSRF 防护** —— `/ai set` 的 `base_url` 做词法校验，拒绝本机/内网/链路本地/CGNAT（含云元数据 `100.100.100.200`）/IPv6 本地等字面量地址。

> **残余风险**（写明白）：词法校验挡不住「攻击者控制的域名解析到内网」。单用户自用可接受；**公开多用户部署建议额外做容器出口限制**（只允许必要公网），或改成解析 DNS 后校验目标 IP。后者当前未实现。

**容器加固** —— compose 默认启用 `no-new-privileges`、`cap_drop: ALL`、只读根文件系统（仅 `/data` 与 `/tmp` 可写）、非 root（uid 1000）运行、tini 作 PID 1 保证 `SIGTERM` 优雅退出。

**日志脱敏** —— `logger.js` 对输出做模式匹配打码（`sk-`、`Bearer`、URL 里的 token 等）。

### 防滥用默认值

| 层面 | 机制 | 默认值 |
| --- | --- | --- |
| 命令频率 | 每用户令牌桶 | 20 条/分钟 |
| 注册 | 冷却 + 总人数上限 | 30 秒 / 200 人 |
| 推送量 | 每用户每日推送配额 | 500 条 |
| 关键词数量 | 每用户上限 | 20 条 |
| 单轮规模 | 单用户单轮推送上限 | 10 条（超出合并为汇总消息） |
| 全局限流 | Telegram 发送速率 | 20 条/秒 |
| AI 调用 | 每用户每日配额 | 不限（`0` = 不限） |

**管理员不受任何配额限制**（单用户模式下只有管理员一人，设限没意义）。可用 `/admin quota <id> ai 500` 给可信用户放宽。

---

## 环境变量

完整列表与逐项说明见 [`server/.env.example`](server/.env.example)（写得很细，建议直接读）。

### 必填

| 名称 | 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot Token，从 [@BotFather](https://t.me/BotFather) 获取 |
| `APP_MASTER_KEY` | 加密用户 API Key 的主密钥，`openssl rand -hex 32` 生成，**不可事后更改** |

### 常用

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `MULTI_USER_ENABLED` | `false` | `false` = 单用户；`true` = 允许多人自助 `/bind`。管理员可用 `/admin multiuser` 运行时覆盖 |
| `ADMIN_TELEGRAM_IDS` | 空 | 预指定管理员，逗号分隔。留空时第一个 `/bind` 的人成为管理员。填了可防止被陌生人认领，也可用于**找回管理权** |
| `REGISTRATION_OPEN` | `true` | 多用户下是否开放自助注册；关闭后仅管理员能开通 |
| `MAX_USERS` | `200` | 用户总数上限（仅多用户） |
| `DEFAULT_MAX_KEYWORDS` | `20` | 新用户关键词上限 |
| `DEFAULT_DAILY_PUSH_QUOTA` | `500` | 新用户每日推送上限 |
| `DEFAULT_DAILY_AI_QUOTA` | `0` | 新用户每日 AI 上限（**`0` = 不限**） |
| `COMMAND_RATE_PER_MIN` | `20` | 每用户每分钟命令数 |
| `POLL_INTERVAL_MS` | `60000` | 轮询间隔，最小 10000 |
| `SEND_RATE_PER_SEC` | `20` | 全局发送速率（Bot API 上限约 30） |
| `AI_CONCURRENCY` | `8` | 同时在飞的 AI 请求数 |
| `ALLOW_GROUP_CHATS` | `false` | 是否允许群聊使用 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### 需要留意的两个

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `WORKER_POOL_SIZE` | 自动 | **建议不设**。留空时取 `max(2, min(4, os.availableParallelism()))`——后者会读 cgroup 限额。设 `0` 可禁用 worker（退化为进程内计算，**会失去 ReDoS 硬超时保护**） |
| `WORKER_TASK_TIMEOUT_MS` | `5000` | 单任务超时，超时即判恶意正则并终止 worker。**弱机器上正常任务也可能超时**：实测 1 CPU 容器里「4 万关键词 × 30 帖」要 24.6 秒，会被误杀 |

---

## 性能与容量

### CPU 与并发

**默认给容器 1 核**（`docker-compose.yml` 里的 `deploy.resources.limits.cpus: "1.0"`）。

这个服务是 **I/O 密集**的：大部分时间在等 RSS、等 Telegram、等 AI 上游，CPU 只在解析 XML 和跑关键词正则时短暂忙一下。所以 1 核足够常规规模使用，也不会跟同机的其它服务抢资源——默认值取保守，需要的人自己调大。

worker 线程池会**自动**跟着配额走（用 `os.availableParallelism()` 读 cgroup 限额）：

| `cpus` | 容器可用 CPU | 自动线程数 | 匹配阶段（2000 用户 × 20 词） |
| --- | --- | --- | --- |
| `"1.0"`（默认） | 1 | 2 | 3180 ms |
| `"2.0"` | 2 | 2 | 1437 ms |
| `"3.0"` | 3 | 3 | — |
| `"4.0"` | 4 | 4 | — |

从 1 核放到 2 核，匹配阶段快约 2 倍（正好等于配额翻倍）。**用户数到千级、或关键词是大列表正则时，建议给到 2~4 核。**

改法：编辑 `docker-compose.yml` 里的 `cpus`，然后 `docker compose up -d` 重建容器。

> **注意两个坑：**
>
> 1. `cpus` 是 cgroup 配额，**不会**让 `os.cpus()` 变小——它照样报宿主机核数。所以线程数绝不能按 `os.cpus()` 取，否则会在 1 核配额里开 4 个线程互相抢（实测同一负载 452 ms → 3180 ms）。代码里已经用 `availableParallelism()` 修正，**不要手动设 `WORKER_POOL_SIZE` 覆盖它**。
> 2. 给满（如 `"4.0"`）时，突发流量下本服务可以和同机其它容器争满 4 核。共享机器上请留余量。

如果你的宿主核数较多、又不想改 git 里的默认值，用 override 文件即可（不会和上游改动冲突）：

```yaml
# docker-compose.override.yml，与 docker-compose.yml 同目录
services:
  nodeseek-monitor:
    deploy:
      resources:
        limits:
          cpus: "4.0"
```

### 一轮只抓一次 RSS

```
抓取（1 次，与用户数无关）
  └─► 解析（worker 线程，1 次）
        └─► 内存匹配（每用户，纯内存）
              └─► AI 摘要（仅有配额且已配置的用户）
                    └─► 发送（受全局限速）
```

100 个用户和 1 个用户在**网络抓取**上的开销完全相同，只有内存匹配量随用户数线性增长。

### 各环节的实际上限

| 环节 | 上限 | 折算 |
| --- | --- | --- |
| **Telegram 发送** | ~1180 条/轮（20 条/秒 × 60 秒） | 平均每人每轮命中 < 0.59 帖；调到 30 条/秒则 ~1775 |
| **AI 摘要** | 不再是瓶颈（同帖场景 200 人 104ms） | 内容各异的极限约 `AI_CONCURRENCY × 轮询间隔 / 单次延迟` |
| **关键词匹配** | 够用，约占一轮 1% | 到 1 万用户仍有余量 |
| **数据库** | 水位线恒定 2000 行 / 0.3 MiB | 不随用户数或时间增长 |

**发送速率才是第一瓶颈。** 2000 个用户一轮全都有命中时需要约 100 秒 > 60 秒间隔，表现是**跳过后续轮次并丢通知**（RSS 只给最新约 20 条，掉出窗口的帖子不会再推）。真到那个量级要动这两个参数：

```bash
POLL_INTERVAL_MS=90000     # 把突发摊开
SEND_RATE_PER_SEC=30       # Telegram 文档上限
```

### 已见记录：一个关键的实现选择

**不是「每用户 × 每帖一行」，而是每个「用户 × 源」只存一行「见过的最大 post_id」**（`seen_state` 表）。帖子号随发帖时间严格递增，所以「id ≤ 水位线」等价于「已见过」。

旧实现的问题：实测 NodeSeek 约 2.8 帖/分钟，2000 用户 7 天会涨到 **约 6000 万行 / 6 GiB**，而 RSS 只暴露最新约 20 条——绝大多数行永远查不到。每小时清理还是一次全表扫描（490 万行实测 6.9 秒，且跑在主线程上，期间 bot 不响应命令）。

改水位线后：**2000 行 / 0.3 MiB 恒定**，`filterUnseen` 2000 用户 13 ms、`markSeen` 58 ms，且不再需要按时间清理。

> **升级垫片**：老库有 `seen_posts` 但无水位线时，会按需用旧表里该用户的最大 `post_id` 初始化水位线（走主键索引，单次 O(log n)）。少了这一步，升级后第一轮会把整个 feed 当全新帖，给每个老用户推最多 10 条。
>
> 旧表不再被读取，但历史数据仍占磁盘，服务会在每小时维护里**分批**清空（约 8 万行/秒，受 `LEGACY_SEEN_PURGE_MS` 预算约束）。6000 万行约需 20 天排完；想立刻拿回空间就重建数据卷。

---

## 运维

### 数据与备份

数据库在容器内 `/data/nodeseek.db`（含 WAL/SHM），默认放在命名卷 `nodeseek-data`。

```bash
# 备份（含 .env！没有 APP_MASTER_KEY，Key 就是一堆解不开的密文）
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

把 compose 里的 `- nodeseek-data:/data` 换成 `- ./data:/data`（并删掉末尾 `volumes:` 段）。

**必须先建目录并交给 uid 1000**，否则会因属主是 root 而反复崩溃：

```
Error: unable to open database file (ERR_SQLITE_ERROR, errcode 14)
```

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

之后数据在 `./data/nodeseek.db`，备份 `tar czf nodeseek-backup-$(date +%F).tar.gz data/ .env` 即可。

### 升级

```bash
docker compose pull && docker compose up -d
```

schema 用 `CREATE TABLE IF NOT EXISTS` 幂等创建，直接升级即可，无需手动迁移。

### 健康检查

```bash
docker compose ps                                          # 看 healthy
docker compose exec nodeseek-monitor curl -s localhost:8787/healthz | head
```

返回 JSON 含最近一轮耗时、推送数、worker 池状态、限流表大小等。

### 排障

| 现象 | 原因与处理 |
| --- | --- |
| 日志 `409 Conflict` | 同一 Bot Token 在别处长轮询。停掉另一处（含旧的 Worker Webhook） |
| 收不到推送 | `/status` 看配额；`/list` 确认关键词已加且未暂停；新用户第一轮可能有延迟 |
| 没有 AI 摘要 | `/ai status` 看配置；`/ai test` 看上游报错；日志搜 `[ai]`；确认该帖有正文 |
| 日志 `API Key 无法解密` | `APP_MASTER_KEY` 被改过。让该用户重新 `/ai set` |
| 容器反复重启 + `unable to open database file` | 用了绑定挂载但目录属主是 root。`sudo chown -R 1000:1000 data`，或改回命名卷 |
| `401 Unauthorized` / `denied`（拉镜像） | GHCR 包不是公开的。见上文[用预构建镜像](#用预构建镜像还是自己构建) |
| `Conflict. The container name ... is already in use` | 本机已有一份在跑。同一台机器只能跑一份，或改 `container_name` 与卷名 |
| 别人 `/bind` 提示「单用户模式」 | 默认行为。`/admin multiuser on` 或 `.env` 设 `MULTI_USER_ENABLED=true` |
| 自己不是管理员了 | 被别的账号抢先认领了。`.env` 填 `ADMIN_TELEGRAM_IDS=你的ID` 后重启即可拿回 |
| 富文本推送变成旧版式 | `sendRichMessage` 失败会降级成经典 HTML。日志搜 `降级为经典格式`；网络抖动会自动重试 2 次 |
| 内存持续增长 | 检查 `WORKER_POOL_SIZE` 与 `AI_CONCURRENCY`；worker 超时会重建，正常不泄漏 |

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

不用 Docker 直接跑（需要 Node.js **22.5+**，用到内置 `node:sqlite`，**无需 `npm install`**）：

```bash
cd server
APP_MASTER_KEY=$(openssl rand -hex 32) \
TELEGRAM_BOT_TOKEN=xxx \
ADMIN_TELEGRAM_IDS=123456789 \
DB_PATH=./data/nodeseek.db \
node src/index.js
```

---

## 仓库结构

```
├── server/                    ← Docker 版全部内容
│   ├── src/                   ← 19 个模块，零第三方依赖（全用 Node 内置）
│   ├── test/                  ← 16 个测试文件，124 项
│   ├── Dockerfile             ← 多阶段构建，node:24-alpine，非 root
│   ├── docker-compose.yml     ← 含安全加固与资源限制
│   └── .env.example           ← 环境变量模板（写得很细）
├── .github/workflows/docker.yml  ← 多架构构建并推送 GHCR
├── worker.js                  ← Workers 版（main 分支的内容，本分支保留但不使用）
├── proxy-server*.js           ← 可选的反向代理辅助工具
├── LICENSE                    ← MIT，仅覆盖本仓库新增与修改部分
└── NOTICE                     ← 上游来源与授权范围划分
```

跑测试：

```bash
cd server && node --check src/*.js && node --test test/*.test.js
```

### 数据表

| 表 | 用途 |
| --- | --- |
| `users` | 用户、角色、状态、配额覆盖 |
| `keywords` | 监控关键词 |
| `ai_configs` | AI 配置（`api_key_enc` 为密文） |
| `seen_state` | 已见水位线（每用户每源一行） |
| `notifications` | 推送历史，供 `/history`（保留 30 天） |
| `usage_daily` | 日用量计数（保留 90 天） |
| `audit_log` | 管理操作审计（保留 30 天） |
| `rss_state` | 各源 ETag / 失败计数 |
| `settings` | 运行状态（模式覆盖、关键词修订号等） |
| `seen_posts` | **已废弃**，旧版遗留，仅分批清空 |

---

## 来源与致谢

本项目派生自 [Roddy-D/NodeSeekRSSMonitor](https://github.com/Roddy-D/NodeSeekRSSMonitor)。

上游提供了基础骨架：RSS 多源抓取与容错、关键词匹配（子串与正则）、D1 去重、Telegram 推送、Bot 命令集合、防洪上限与溢出汇总。

本仓库新增或重写的部分：

| 类别 | 内容 |
| --- | --- |
| 多用户服务端 | 原生 Node.js + SQLite 实现，角色分离、自助注册、配额与封禁 |
| 通知排版 | Bot API 10.3 富文本（标题即链接、关键词折叠、引用块承载摘要、cite 标注模型），含经典 HTML 降级与重试 |
| AI 摘要 | 用户自带 Key、多级模型回退、按内容去重与在飞请求合并 |
| 性能 | worker 线程池 + ReDoS 硬超时、水位线去重、AI 跨用户拍平、发送令牌桶 |
| 安全 | AES-256-GCM 加密 Key、日志脱敏、SSRF 词法校验、容器加固 |
| 工程 | 124 项测试、可复跑基准脚本、多架构 CI 构建 |

### 授权状态

**上游仓库未附带任何开源许可证**（根目录只有 `README.md` 与 `worker.js`，均无版权或许可声明）。按著作权法默认规则，未声明即视为保留所有权利。

因此：

- 本仓库**不对上游原始代码主张任何许可**，该部分权利归 [Roddy-D](https://github.com/Roddy-D) 所有
- 本仓库新增或修改的部分按根目录 `LICENSE`（MIT）授权
- 两部分的具体划分见 `NOTICE`

如需将上游原始代码用于本项目之外的用途，请自行联系原作者取得授权。

### 致谢

感谢 [Roddy-D](https://github.com/Roddy-D) 公开的初始实现。本项目的通知排版、AI 摘要与性能优化，都建立在它提供的骨架之上。
