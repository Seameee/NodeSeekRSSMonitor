# NodeSeek 关键词监控 Bot

NodeSeek 论坛关键词监控机器人：轮询 RSS，命中关键词的新帖通过 Telegram 推送，可选 AI 摘要。

提供两种部署方式，功能与数据模型一致，按需要选一个：

| 部署方式 | 运行环境 | 用户模型 | 适合场景 |
| --- | --- | --- | --- |
| **Docker（推荐）** | 任意 VPS / 家庭服务器，原生 Node.js | 单用户**或**多用户，部署时用变量选择 | 想给多人用、要数据自主、不想受平台限制 |
| Cloudflare Workers | Cloudflare 边缘网络 + D1 | 单用户 | 零成本、零运维、不想管服务器 |

> 本项目派生自 [Roddy-D/NodeSeekRSSMonitor](https://github.com/Roddy-D/NodeSeekRSSMonitor)，署名与授权说明见文末[来源与致谢](#来源与致谢)。

## 功能

两种部署方式共有的功能：

- 关键词监控：支持子串匹配与正则匹配，可按版块过滤
- 每分钟轮询 RSS，新帖命中关键词后推送通知
- 通知使用 Bot API 10.3 富文本消息：标题可点击、关键词可折叠；接口不可用时自动降级为经典 HTML
- 可选 AI 摘要：为通知附加一句帖子内容摘要，支持多级备用模型回退，并标注实际使用的模型
- 防洪控制：每轮推送有上限，超出部分合并为一条汇总消息
- 多源容错：主 RSS 源失败后自动切换备用源
- 首次运行静默初始化，不推送历史帖子
- 自动清理过期数据

**Docker 版额外提供**（详见 [Docker 部署](#docker-部署多用户)）：

- 多用户：任何人可在 Telegram 里 `/bind` 自助开通，各自拥有独立的关键词与 AI 配置
- 角色分离：普通用户只能管理自己的关键词与 AI；管理员独占用户管理、配额、封禁等能力
- 密钥加密：用户 API Key 以 AES-256-GCM 加密落库，明文不落盘、不进日志
- 防滥用：命令限流、日配额、注册冷却、ReDoS 防护与全局并发控制
- 多线程：CPU 密集的 XML 解析与正则匹配放进 worker 线程池，主线程始终响应命令

## 部署

### 方式一：Docker Compose（多用户）

见 [Docker 部署](#docker-部署多用户)。

### 方式二：Cloudflare Workers（单用户）

1. Cloudflare Dashboard → Workers & Pages → Create，选择 Hello World 模板
2. Settings → Variables and Secrets，添加基础环境变量
3. Settings → Bindings → D1 Database：先创建一个 D1 数据库，变量名填 `DB`，再选择该数据库
4. 将 `worker.js` 内容粘贴到编辑器，部署
5. Settings → Triggers → Cron Triggers：添加 `* * * * *`
6. 访问 `https://<你的域名>/setup`，完成 Telegram Webhook 注册与数据库初始化
7. 向 Bot 发送 `/start` 验证

### 基础环境变量

| 名称                 | 必填 | 说明                                             |
| -------------------- | ---- | ------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN` | 是   | Bot Token，从 [@BotFather](https://t.me/BotFather) 获取 |
| `ALLOWED_USER_ID`    | 是   | 你的 Telegram 用户 ID，从 [@userinfobot](https://t.me/userinfobot) 获取 |
| `WEBHOOK_SECRET`     | 否   | Webhook 校验串，建议设置                         |

建议将上述变量以 Secret 类型保存，避免在控制台明文可见。

## Docker 部署（多用户）

原生 Node.js 实现，不使用 Wrangler，也不依赖 Cloudflare。跑在你自己的服务器上，支持多用户。

### 与 Workers 版的区别

| 维度 | Docker 版 | Workers 版 |
| --- | --- | --- |
| 运行环境 | 你的服务器（Node.js 22.5+） | Cloudflare 边缘 |
| 数据库 | 本地 SQLite（WAL） | Cloudflare D1 |
| 用户模型 | 多用户，各自独立配置 | 单用户 |
| 通信方式 | 长轮询 `getUpdates` | Webhook |
| 第三方依赖 | **零**（含 SQLite 驱动，全用 Node 内置模块） | 零 |
| 成本 | 自己的服务器 | 免费额度内免费 |

### 系统要求

- Docker 20.10+ 与 Docker Compose v2（`docker compose` 命令）
- 内存 128 MB 起，单核即可支撑数百用户（瓶颈在网络 I/O，不在 CPU）
- 能访问 `api.telegram.org` 与 `rss.nodeseek.com` 的网络

### 快速开始

**1. 准备目录**

```bash
mkdir -p ~/nodeseek-monitor && cd ~/nodeseek-monitor
```

**2. 创建 `.env`**

```bash
cat > .env <<'EOF'
# 从 @BotFather 获取
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# 主密钥：加密用户 API Key 用，务必先备份
APP_MASTER_KEY=replace_me_with_openssl_rand_hex_32

# 运行模式：false = 单用户（默认），true = 多用户
MULTI_USER_ENABLED=false

# 可选。留空时，第一个 /bind 的人自动成为管理员
ADMIN_TELEGRAM_IDS=
EOF
chmod 600 .env
```

生成主密钥并直接写进文件：

```bash
sed -i "s|^APP_MASTER_KEY=.*|APP_MASTER_KEY=$(openssl rand -hex 32)|" .env
```

**3. 创建 `compose.yaml`**

```bash
cat > compose.yaml <<'EOF'
services:
  nodeseek-monitor:
    image: ghcr.io/seameee/nodeseek-monitor:latest
    container_name: nodeseek-monitor
    restart: unless-stopped
    env_file: .env
    volumes:
      # 命名卷：容器以非 root 运行，命名卷会继承镜像里 /data 的属主，
      # 开箱可用。改用宿主机目录见下方「改用宿主机目录」。
      - nodeseek-data:/data
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  nodeseek-data:
EOF
```

**4. 启动**

```bash
docker compose up -d
docker compose logs -f
```

看到 `健康检查监听 :8787/healthz` 与第一轮轮询日志即为正常。

**5. 认领管理员并开始使用**

在 Telegram 里给 Bot 发 `/bind`。**第一个绑定的人自动成为管理员**，然后：

```
/add 绿云              # 添加关键词
/list                  # 查看
/ai set sk-xxx         # 可选，配置 AI 摘要
/admin                 # 管理面板（仅管理员）
```

> 留空 `ADMIN_TELEGRAM_IDS` 部署时，请尽快自己先 `/bind` 完成认领。
> 若担心被陌生人抢先，可以先在 `.env` 里填上自己的 ID 再启动。

### 单用户模式与多用户模式

由 `.env` 里的 `MULTI_USER_ENABLED` 决定，**默认单用户**：

| | 单用户模式（默认） | 多用户模式 |
| --- | --- | --- |
| 谁能用 | 只有管理员 | 管理员 + 所有 `/bind` 的用户 |
| `/bind` | 只对第一个用户开放（认领管理员） | 任何人都可自助开通 |
| 配额 | 管理员不受限 | 普通用户受每日配额与关键词数限制 |
| 关键词与 AI 配置 | 各自独立 | 各自独立 |

**第一个 `/bind` 的用户永远是管理员**，两种模式下都一样 —— 这是新部署拿到管理权的唯一途径（除非你在 `.env` 里预填了 `ADMIN_TELEGRAM_IDS`）。

**管理员可随时切换**，不需要重启：

```
/admin multiuser on       # 开放给其他人使用
/admin multiuser off      # 收回，仅管理员可用
/admin multiuser default  # 清除覆盖，回到 .env 的设置
```

切换的三条保证：

- **数据不丢** —— 关闭多用户模式不会删除任何用户的关键词与 AI 配置
- **立即生效** —— 关闭后普通用户的命令被拒绝、当轮起不再向他们推送
- **可逆** —— 重新开启后他们立刻恢复，无需重新配置

优先级：**管理员覆盖 > `.env` 的 `MULTI_USER_ENABLED`**。覆盖值存在数据库里，重启后依然有效；`/admin multiuser default` 可清除覆盖回到环境变量。

### 关于预构建镜像（GHCR）

`ghcr.io/seameee/nodeseek-monitor:latest` 由 GitHub Actions 自动构建（多架构 amd64/arm64）。

**如果拉取时报 `401 Unauthorized` 或 `denied`**，说明该包不是公开的。GHCR 的容器包**默认继承仓库可见性、但需要手动确认为 public**，未公开时除作者与协作者外任何人都拉不到（这不是 `docker login` 能解决的 —— 私有包按协作者授权，陌生人登录也没用）。

仓库作者请到
`https://github.com/users/Seameee/packages/container/nodeseek-monitor/settings`
把 Visibility 改为 **Public**。改完无需重新构建。

如果暂时不想公开，请改用下面的从源码构建方式 —— 源码仓库是公开的，无需任何认证。

### 从源码构建镜像

不想用预构建镜像时，把 `compose.yaml` 里的 `image:` 换成：

```yaml
    build:
      context: https://github.com/Seameee/NodeSeekRSSMonitor.git#main:server
```

或本地克隆后：

```bash
cd server
docker compose up -d --build
```

### 环境变量

必填项：

| 名称 | 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot Token，从 [@BotFather](https://t.me/BotFather) 获取 |
| `APP_MASTER_KEY` | 加密用户 API Key 的主密钥，`openssl rand -hex 32` 生成 |

可选项，但通常要设：

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `MULTI_USER_ENABLED` | `false` | 运行模式。`false` = 单用户（只有管理员能用）；`true` = 允许多人自助 `/bind`。管理员可用 `/admin multiuser` 在运行时覆盖 |
| `ADMIN_TELEGRAM_IDS` | 空 | 预指定的管理员 ID，逗号分隔。**留空时第一个 `/bind` 的用户自动成为管理员**；填了则这些人始终是管理员，可用于找回管理权 |

> `APP_MASTER_KEY` **一旦设定不可更改**。改了之后所有用户已保存的 API Key 都无法解密，用户需要重新 `/ai set`。请与数据库一起备份。

常用可选项（完整列表见 `server/.env.example`）：

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | `60000` | 轮询间隔，最小 10000 |
| `REGISTRATION_OPEN` | `true` | 多用户模式下是否允许自助 `/bind`；关闭后仅管理员能开通（单用户模式下不生效） |
| `MAX_USERS` | `200` | 用户总数上限（仅多用户模式） |
| `DEFAULT_MAX_KEYWORDS` | `20` | 新用户关键词数量上限 |
| `DEFAULT_DAILY_AI_QUOTA` | `100` | 新用户每日 AI 调用上限 |
| `DEFAULT_DAILY_PUSH_QUOTA` | `200` | 新用户每日推送条数上限 |
| `COMMAND_RATE_PER_MIN` | `20` | 每用户每分钟命令数上限 |
| `WORKER_POOL_SIZE` | `4` | worker 线程数；设 `0` 则退化为单线程 |
| `AI_CONCURRENCY` | `8` | 同时在飞的 AI 请求数 |
| `SEND_RATE_PER_SEC` | `20` | 全局 Telegram 发送速率 |
| `ALLOW_GROUP_CHATS` | `false` | 是否允许群聊中使用 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### 命令一览

**所有用户**

| 命令 | 说明 |
| --- | --- |
| `/bind` | 开通账号（自助注册） |
| `/add <关键词> [版块] [--regex]` | 添加关键词 |
| `/remove <序号\|关键词>` | 删除关键词 |
| `/pause` / `/resume <序号\|关键词>` | 暂停 / 恢复关键词 |
| `/list` | 查看自己的关键词 |
| `/categories` | 查看可用版块 |
| `/ai set <key> [模型] [base_url]` | 配置 AI 摘要 |
| `/ai fallback <模型1,模型2>` | 设置备用模型链 |
| `/ai test` | 连通性测试 |
| `/ai status` / `/ai on` / `/ai off` / `/ai clear` | 查看 / 开关 / 清除 |
| `/status` | 我的状态与今日用量 |
| `/history [数量]` | 我的推送记录 |
| `/help` | 帮助 |

**仅管理员**

| 命令 | 说明 |
| --- | --- |
| `/admin` | 管理面板 |
| `/admin users [页码]` | 用户列表 |
| `/admin find <ID\|用户名>` | 搜索用户 |
| `/admin info <id>` | 用户详情（含用量、AI 配置状态） |
| `/admin ban` / `/admin unban <id>` | 封禁 / 解封 |
| `/admin quota <id> kw\|ai\|push <数值>` | 设置配额，`-1` 恢复默认 |
| `/admin note <id> <备注>` | 打标记 |
| `/admin del <id>` | 删除用户及其全部数据 |
| `/admin stats` | 全局统计与运行时状态 |
| `/admin multiuser on\|off\|default` | 多用户模式开关（见上文「单用户模式与多用户模式」） |
| `/admin open on\|off` | 开关注册（仅多用户模式生效） |
| `/admin audit` | 最近管理操作 |

### 权限模型

```
未注册用户 ──► 只放行 /start /help /bind
     │
     ▼ /bind（库为空时）
第一个用户 ──► 自动成为管理员，认领本实例

     ▼ /bind（已有用户时）
普通用户 ────► 只能操作自己的关键词与 AI 配置
     │         所有读写都带 telegram_id 条件，数据库层面无法跨用户
     │         单用户模式下会被拒绝，但数据保留
     ▼
管理员 ──────► 用户管理、配额、封禁、运行模式、全局设置
               来源有二：
                 ① 库内 role=admin（首个 /bind 用户自动获得）
                 ② 环境变量 ADMIN_TELEGRAM_IDS 白名单（预指定/找回）
               管理员不受配额限制，也不能被其他管理员封禁或删除
```

管理员身份无法通过任何用户命令获得 —— 测试里专门覆盖了「普通用户挨个尝试提权入口」的场景。

### 安全设计

**密钥加密**

用户的 API Key 用 **AES-256-GCM** 加密后存库：

- 格式 `v1:<iv>:<认证标签>:<密文>`，每次加密用独立随机 IV，相同明文产生不同密文
- GCM 的认证标签可检测密文被篡改
- 全库导出、SQL 注入或备份泄漏都拿不到明文
- `APP_MASTER_KEY` 只存在于环境变量，从不落盘、不进日志

> 关于「单向加密」：API Key 必须能被**还原**后才能拿去调用上游模型，因此只能用可逆的对称加密，不能用散列。用 SHA-256 之类单向散列存 Key，等于把 Key 丢掉、功能直接用不了。代码里 `hashSecret` / `safeEqual` 这对单向函数保留给「只需校验、无需还原」的场景。

**日志脱敏**

`logger.js` 对所有输出做模式匹配打码（`sk-`、`ghp_`、`Bearer`、URL 里的 token/key 等），Key 不会因为某个 `console.log` 而泄漏。

**ReDoS 防护**

关键词正则是用户可控输入，一个 `(a+)+$` 就能把事件循环钉死。三层防护：

1. 长度上限 `MAX_REGEX_LEN`
2. 静态分析拒绝嵌套量词、反向引用等回溯炸弹结构
3. 实际匹配跑在 worker 线程里并带硬超时，超时即终止该 worker 并重建，主进程不受影响

**SSRF 防护**

`/ai set` 的 `base_url` 会校验协议并拒绝解析到内网/本机地址（`127.`、`10.`、`192.168.`、`169.254.`、`localhost`、`::1` 等）。

**容器加固**

compose 里默认启用 `no-new-privileges`、`cap_drop: ALL`、只读根文件系统（仅 `/data` 与 `/tmp` 可写）、非 root 用户运行、tini 作为 PID 1 确保 `SIGTERM` 触发优雅退出。

### 防滥用

多用户服务最大的风险是被刷。默认策略：

| 层面 | 机制 | 默认值 |
| --- | --- | --- |
| 命令频率 | 每用户令牌桶 | 20 条/分钟 |
| 注册 | 冷却时间 + 总人数上限 | 30 秒 / 200 人 |
| 资源消耗 | 每用户每日 AI 调用配额 | 100 次 |
| 推送量 | 每用户每日推送配额 | 200 条 |
| 关键词数量 | 每用户上限 | 20 条 |
| 单轮规模 | 单用户单轮推送上限 | 10 条（超出合并汇总） |
| 全局限流 | Telegram 发送速率 | 20 条/秒 |

超限时的行为：命令限流会静默丢弃（只偶尔提示，避免限流本身变成放大器）；日配额用尽当天只提示一次。

**管理员不受任何配额限制**，也不受关键词数量上限约束 —— 单用户模式下只有管理员一个人，设限没有意义。

管理员可用 `/admin quota <id> ai 500` 给可信用户放宽。

### 性能设计

多用户下真正重要的是**别让用户数乘上网络开销**。

**一轮只抓一次 RSS**

```
抓取（1 次，与用户数无关）
   └─► 解析（worker 线程，1 次）
         └─► 内存匹配（每用户，纯内存操作）
               └─► AI 摘要（仅有配额且已配置的用户）
                     └─► 发送（每用户，受全局限速）
```

100 个用户和 1 个用户在**网络抓取**上的开销完全相同，只有内存匹配量随用户数线性增长。

**并发控制**

| 环节 | 机制 |
| --- | --- |
| CPU（解析 + 正则匹配） | worker 线程池，主线程不被拖住 |
| AI 请求 | 信号量限制同时在飞数量 |
| Telegram 发送 | 全局令牌桶 + 每 chat 串行（保证同一用户消息有序） |
| 用户间处理 | 分批推进，避免一次性展开所有用户的任务 |

**数据库**

- WAL 模式，读写不互斥，轮询写库不阻塞用户命令
- 预编译语句缓存，避免重复编译
- 索引覆盖热路径：`seen_posts(telegram_id,seen_at)`、`keywords(telegram_id,enabled)`、`notifications(telegram_id,sent_at)`
- 关键词列表按修订号缓存，改动时才失效
- 已见帖子批量查询与写入，一轮一次往返

### 数据与备份

数据库是容器内 `/data/nodeseek.db`（外加 WAL/SHM 文件），默认放在 Docker 命名卷 `nodeseek-data` 里。

备份：

```bash
docker compose stop
docker run --rm -v nodeseek-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/nodeseek-backup-$(date +%F).tar.gz -C /data .
cp .env nodeseek-backup-$(date +%F).env
docker compose start
```

**一定要连 `.env` 一起备份** —— 没有 `APP_MASTER_KEY`，数据库里的 API Key 就是一堆无法解密的密文。

恢复：

```bash
docker compose down
docker run --rm -v nodeseek-data:/data -v "$PWD:/backup" alpine \
  sh -c "tar xzf /backup/nodeseek-backup-YYYY-MM-DD.tar.gz -C /data"
docker compose up -d
```

### 改用宿主机目录

想把数据库直接放在宿主机上（方便用 `sqlite3` 查看，或纳入现有备份体系），把 compose 里的

```yaml
      - nodeseek-data:/data
```

换成

```yaml
      - ./data:/data
```

并删掉文件末尾的 `volumes:` 段。

**但必须先创建目录并把属主交给 uid 1000**，否则容器会以

```
Error: unable to open database file (ERR_SQLITE_ERROR, errcode 14)
```

反复崩溃重启 —— 容器以非 root 的 `node`(uid 1000) 运行，而 Docker 自动创建的宿主机目录属主是 root：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

之后数据就在 `./data/nodeseek.db`，用 `tar czf nodeseek-backup-$(date +%F).tar.gz data/ .env` 备份即可。

### 升级

```bash
docker compose pull && docker compose up -d
```

数据库 schema 用 `CREATE TABLE IF NOT EXISTS` 幂等创建，直接升级即可。

### 健康检查与排障

容器内置健康检查，`docker compose ps` 显示 `healthy` 即正常。手动查看运行时状态：

```bash
docker compose exec nodeseek-monitor curl -s localhost:8787/healthz | head
```

返回 JSON 含最近一轮耗时、推送数、worker 池状态、限流表大小等。

常见问题：

| 现象 | 原因与处理 |
| --- | --- |
| 日志出现 `409 Conflict` | 同一个 Bot Token 在别处也在长轮询。停掉另一处（包括旧 Worker 的 Webhook）即可 |
| 收不到推送 | 先在 Telegram 发 `/status` 看配额；`/list` 确认关键词已添加且未暂停 |
| 通知里没有 AI 摘要 | `/ai status` 看配置；日志搜 `[ai]`；确认该帖有正文（约 20% 的帖子被作者设为「仅注册用户可见」，取不到正文，会跳过摘要） |
| 日志 `API Key 无法解密` | `APP_MASTER_KEY` 被改过。让该用户重新 `/ai set` |
| 内存持续增长 | 检查 `WORKER_POOL_SIZE` 与 `AI_CONCURRENCY`；worker 超时会重建，正常不会泄漏 |
| 容器反复重启，日志 `unable to open database file` | 用了绑定挂载但宿主机目录属主是 root。执行 `sudo chown -R 1000:1000 data`，或改回默认的命名卷 |
| `docker compose up` 报 `401 Unauthorized` / `denied` | GHCR 上的包不是公开的。作者需把包可见性改为 Public，或改用「从源码构建镜像」 |
| 别人 `/bind` 提示「单用户模式」 | 这是默认行为。需要开放时发 `/admin multiuser on`，或在 `.env` 里设 `MULTI_USER_ENABLED=true` 后重启 |
| 自己不是管理员了 | 说明被别的账号抢先 `/bind` 认领了。在 `.env` 里填上 `ADMIN_TELEGRAM_IDS=你的ID` 后重启，即可拿回管理权 |

### 不用 Compose 直接跑

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

或完全不用 Docker：

```bash
cd server
APP_MASTER_KEY=$(openssl rand -hex 32) \
TELEGRAM_BOT_TOKEN=xxx \
ADMIN_TELEGRAM_IDS=123456789 \
DB_PATH=./data/nodeseek.db \
node src/index.js
```

需要 Node.js 22.5 以上（用到内置的 `node:sqlite`），无需 `npm install`。

## AI 摘要（可选）

为每条命中通知附加一句模型生成的帖子内容摘要。不配置 `AI_API_KEY` 与 `AI_MODEL` 时，该功能完全关闭，行为与未启用时一致。

### 配置项

| 名称                 | 必填 | 默认值                        | 说明                                                             |
| -------------------- | ---- | ----------------------------- | ---------------------------------------------------------------- |
| `AI_API_KEY`         | 是   | 无                            | 模型服务的 API Key                                               |
| `AI_MODEL`           | 是   | 无                            | 主模型名，例如 `deepseek-chat`                                   |
| `AI_MODEL_FALLBACK`  | 否   | 无                            | 备用模型，逗号分隔多个，按顺序依次尝试                           |
| `AI_BASE_URL`        | 否   | `https://api.deepseek.com/v1` | OpenAI 兼容端点，末尾不要带 `/`                                  |
| `AI_MIN_LEN`         | 否   | `0`                           | 正文短于此长度则跳过摘要，调大可节省 token                       |
| `AI_MAX_PER_ROUND`   | 否   | `5`                           | 每轮最多生成几条摘要                                             |
| `AI_MAX_TOKENS`      | 否   | `4000`                        | 单次生成上限。推理型模型不宜调小，否则思考会耗尽预算导致空回复   |
| `AI_TIMEOUT_MS`      | 否   | `15000`                       | 单次调用超时（毫秒）                                             |
| `AI_PROMPT`          | 否   | 内置提示词                    | 自定义 system prompt                                             |

### 回退机制

主模型调用失败时，依次尝试 `AI_MODEL_FALLBACK` 中的模型，第一个成功的结果即被采用。以下情况均判定为失败并触发回退：

- 网络异常或超时
- HTTP 状态码非 2xx
- 返回内容为空（推理型模型思考耗尽 `max_tokens` 时的典型表现）

全部模型均失败时，仅缺少摘要，通知照常发送。回退是逐级的，顺序即优先级。部分中转服务的渠道会被临时摘除并返回 `No available channel`，配置多个备用模型可显著提高成功率。

每次尝试各自受 `AI_TIMEOUT_MS` 约束。配置 N 个备用模型时，单条帖子最坏耗时为 (N+1) × `AI_TIMEOUT_MS`，建议配置备用链后将该值调小，例如 `8000`。

### 其他行为

- 正文取自 RSS 的 `<description>` 字段，实测与帖子页面的 `<article class="post-content">` 内容一致，无需额外抓取帖子页面
- 正文为空的帖子直接跳过，不调用模型。实测约 20% 的帖子正文为空，均为发帖人设置了「仅注册用户可见」，主源与备用 TG 镜像源都取不到内容
- 通知里的摘要会标注**实际产出该条摘要的模型**，发生回退时显示的是备用模型而非链路首项
- 摘要文本经过 HTML 转义，不会破坏消息解析
- 摘要与关键词同属一条消息，注意富文本 32768 字符上限

### 排查：通知中没有摘要

1. 向 Bot 发送 `/status`，查看 `AI 摘要` 一行
   - 显示“关闭（未配置 AI_API_KEY / AI_MODEL）”：环境变量未生效。确认两个变量都已填写，保存后在 Worker 中重新部署
   - 显示“开启（模型 xxx）”：配置正常，进入下一步
2. 在 Worker → Observability 中查看 `[AI]` 开头的日志

   | 日志内容                                     | 含义                                                       |
   | -------------------------------------------- | ---------------------------------------------------------- |
   | `[AI] 本轮生成 N 条摘要（模型 …）`           | 正常调用                                                   |
   | `[AI] 摘要成功 0/1 条`                       | 已调用但未取得内容，常见于推理型模型 `AI_MAX_TOKENS` 过小 |
   | `[AI] <模型名> HTTP 401/404: …`              | Key 无效，或 `AI_BASE_URL` / `AI_MODEL` 配置错误           |
   | `[AI] 本轮 N 条通知均无可用正文（正文为空）` | 帖子为纯图片帖或已删除帖，跳过属正常行为                   |
   | `[AI] <模型名> 调用失败: …`                  | 网络异常或超时                                             |
   | `[AI] 模型 A 失败，回退到 B`                 | 主模型失败，正在尝试备用模型                               |

   若完全没有 `[AI]` 日志，说明 AI 未启用，回到第 1 步

3. Dev 模式同样会生成摘要，与普通模式共用同一代码路径，无需额外配置

## 通知样式

优先使用 Bot API 10.3 的富文本消息（`sendRichMessage`），按以下层级组织：

| 顺序 | 元素                                                        | 作用                                       |
| ---- | ----------------------------------------------------------- | ------------------------------------------ |
| 1    | `<h3><a href="帖子链接">标题</a></h3>`                       | 标题即链接，整块可点击                     |
| 2    | `<p>&nbsp;</p>` + `<p>版块 · 作者</p>`                      | 元信息紧跟标题下方，与标题之间空一行       |
| 3    | `<blockquote>摘要<cite>AI 摘要 · 模型名</cite></blockquote>` | 摘要以引用块呈现，`cite` 标明由 AI 生成并附上实际使用的模型 |
| 4    | `<details><summary>命中关键词</summary><pre>…</pre></details>` | 长正则默认折叠，位于消息最底部             |

要点：

- 关键词短于 60 字符时自动展开（`<details open>`），仅长正则折叠
- 富文本上限为 32768 字符，普通消息仅 4096 字符
- 自动降级：`sendRichMessage` 返回错误或抛出异常时，改用经典 `sendMessage` 配合 `<blockquote expandable>`，通知不会丢失。降级会在日志中记录 `[TG] sendRichMessage 失败`
- 富文本需要较新的 Telegram 客户端才能完整渲染

## Bot 命令

| 命令                                | 说明                                 |
| ----------------------------------- | ------------------------------------ |
| `/start`、`/help`                   | 查看命令列表与版块说明               |
| `/add <关键词> [--regex] [版块]`    | 添加监控关键词                       |
| `/remove <序号或关键词>`            | 删除关键词                           |
| `/pause <序号或关键词>`             | 暂停关键词                           |
| `/resume <序号或关键词>`            | 恢复关键词                           |
| `/list`                             | 查看监控列表                         |
| `/history [数量]`                   | 查看推送记录，默认 10 条             |
| `/categories`                       | 查看可用版块                         |
| `/dev [条数\|exit]`                 | 进入或退出 Dev 模式                  |
| `/status`                           | 查看运行状态，含 Dev 模式与 AI 配置  |

## Dev 模式

用于调试：临时关闭关键词过滤，任何新帖都触发推送，便于验证 RSS 抓取、AI 摘要与消息排版。

| 命令        | 行为                                              |
| ----------- | ------------------------------------------------- |
| `/dev`      | 进入 Dev 模式，无限推送，直到执行 `/dev exit`     |
| `/dev 5`    | 进入 Dev 模式，推送 5 条后自动退出                |
| `/dev exit` | 立即退出并恢复关键词监控（`off`、`stop`、`0` 同义） |

行为细节：

- 强制拉取全版块 RSS，不受关键词的版块限制影响
- 未配置任何关键词时同样可用（普通模式下无关键词会直接跳过轮询）
- 每轮仍受防洪上限 10 条约束，因此 `/dev 50` 会分多轮推送完成
- 配额用满时，本轮剩余帖子不会被标记为已见，退出 Dev 模式后仍会参与关键词评估，不会丢帖
- Dev 模式无关键词，推送记录以 `(dev)` 占位，`/history` 仍可查看
- `/dev` 不带数字为无限模式，长时间不退出会持续推送，仅需少量样本时建议使用 `/dev 5`
- 状态保存在 D1 的 `settings.dev_left`，Worker 重启不丢失

## 可用版块

| 代码           | 名称 | 代码            | 名称 |
| -------------- | ---- | --------------- | ---- |
| `daily`        | 日常 | `tech`          | 技术 |
| `info`         | 情报 | `review`        | 测评 |
| `trade`        | 交易 | `carpool`       | 拼车 |
| `dev`          | Dev  | `photo-share`   | 贴图 |
| `expose`       | 曝光 | `sandbox`       | 沙盒 |

## 使用示例

```
/add 搬瓦工                     # 监控全部版块的「搬瓦工」
/add 搬瓦工 trade               # 仅监控交易版
/add 搬瓦工 trade,info          # 交易版与情报版
/add 补货 --regex info,trade    # 正则匹配，情报版与交易版
/add 搬瓦工.*(CN2|GIA) --regex  # 正则匹配全部版块

/remove 2                       # 删除列表中第 2 条
/remove 搬瓦工                  # 按关键词删除
/pause 1                        # 暂停第 1 条
/resume 1                       # 恢复第 1 条
```

## 运行机制

- **轮询**：Cron Trigger 每分钟触发一次 `pollRSS`
- **多源容错**：主源为 `rss.nodeseek.com`，失败后依次切换两个 Telegram 频道镜像源；每个源重试 3 次，退避间隔 1/2 秒，单次请求超时 15 秒
- **去重**：帖子 ID 记录在 `seen_posts` 表，已推送的帖子不会重复通知
- **发送重试**：单条消息发送失败后重试 3 次，退避间隔 1 秒、2 秒
- **失败告警**：RSS 连续失败 30 次时推送一条告警消息

### 资源占用控制

Workers 免费版的约束是 **每次调用 10ms CPU** 与 **50 个子请求**（D1 查询计入后者）。为把每轮开销压到最低，做了以下处理：

- **建表只执行一次**：用 `settings.schema_ready` 标记，避免每分钟重复执行 4 条 `CREATE TABLE`
- **已见帖批量查询**：一轮 20 帖由 20 次 `SELECT` 合并为 1 次 `WHERE post_id IN (...)`
- **已见帖批量写入**：一轮消费的帖子合并为 1 次 `db.batch()`
- **settings 批量读取**：一轮所需的多个配置项合并为 1 次 `WHERE key IN (...)`
- **清理降频 + 建索引**：`seen_at` / `sent_at` 建有索引，清理由每分钟改为每小时一次

优化后每轮 D1 往返从约 28 次降至 5~8 次。

## 附带文件

| 文件                      | 用途                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `worker.js`               | 主体代码，部署到 Cloudflare Workers                          |
| `proxy-server.js`         | 可选。部署在 VPS 上的简易 HTTP 转发服务，用于解决 RSS 源访问问题 |
| `proxy-server-express.js` | 同上，基于 Express 的实现                                    |
| `LICENSE`                 | MIT 许可证，仅覆盖本仓库新增与修改的部分                      |
| `NOTICE`                  | 上游来源与授权范围划分说明                                    |
| `Dockerfile`              | 用于容器化部署上述代理服务                                   |

Docker 多用户版的全部文件在 `server/` 目录：

| 文件/目录                      | 用途                                                       |
| ------------------------------ | ---------------------------------------------------------- |
| `server/src/`                  | 服务端源码（18 个模块，零第三方依赖）                       |
| `server/Dockerfile`            | 多阶段构建，基于 `node:24-alpine`，非 root 运行             |
| `server/docker-compose.yml`    | Compose 部署编排，含安全加固与资源限制                      |
| `server/.env.example`          | 环境变量模板，含全部可调项与说明                            |
| `server/test/`                 | 测试套件（41 项，覆盖加密、隔离、权限、轮询与配额）          |
| `.github/workflows/docker.yml` | 自动构建多架构镜像并推送到 GHCR                             |

## 数据表

| 表名            | 用途                       | 保留策略 |
| --------------- | -------------------------- | -------- |
| `keywords`      | 监控关键词                 | 持久     |
| `seen_posts`    | 已处理的帖子 ID，用于去重  | 7 天     |
| `notifications` | 推送历史，供 `/history` 查询 | 30 天    |
| `settings`      | 运行状态（初始化标记、Dev 模式、RSS 失败计数等） | 持久 |

## 来源与致谢

本项目的初始实现派生自 [Roddy-D/NodeSeekRSSMonitor](https://github.com/Roddy-D/NodeSeekRSSMonitor)。

上游提供了基础框架：RSS 多源抓取与容错、关键词匹配（子串与正则）、D1 去重、Telegram 推送、Bot 命令集合、防洪上限与溢出汇总、首次运行静默初始化、过期数据清理。

本仓库在上游基础上新增或重写的部分：

| 类别     | 内容                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 通知排版 | 改用 Bot API 10.3 富文本消息（标题即链接、关键词折叠、引用块承载摘要、cite 标注模型），保留经典 HTML 降级 |
| AI 摘要  | 新增功能：正文提取、多级备用模型回退、通知中标注实际生效的模型、正文为空时跳过                           |
| Dev 模式 | 新增功能：临时关闭关键词过滤，支持 `/dev`、`/dev N`、`/dev exit`                                         |
| 资源占用 | 重写 D1 访问模式（批量查询与写入、建表只执行一次、加索引、清理降频），适配 Workers 免费版限制             |
| 文档     | README 重写                                                                                             |

规模对比：上游 `worker.js` 为 536 行，本仓库当前约 1044 行，其中 12 个函数为本仓库新增。

### 授权状态

**上游仓库未附带任何开源许可证。** 其根目录仅有 `README.md` 与 `worker.js`，两者均无版权或许可声明。按著作权法默认规则，未声明许可证即视为保留所有权利，上游作者对其原始代码仍持有全部权利。

因此：

- 本仓库**不对上游原始代码主张任何许可**，该部分权利归 [Roddy-D](https://github.com/Roddy-D) 所有
- 本仓库新增或修改的部分按根目录 `LICENSE`（MIT）授权
- 两部分的具体划分见 `NOTICE`

如需将上游原始代码用于本项目之外的用途，请自行联系原作者取得授权。

### 致谢

感谢 [Roddy-D](https://github.com/Roddy-D) 公开的初始实现。本项目的通知排版、AI 摘要与资源占用优化，都建立在它提供的骨架之上。
