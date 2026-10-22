// ============================================================================
// 命令清单的唯一来源
//
// 这些命令此前在 5 个地方各写一份：/help、/admin 面板、/bind 成功提示、
// /ai 用法、Telegram 命令菜单。结果就是互相缺失、描述不一致（例如 /help 里
// /ai set 还写着早已去掉的 [model] 参数，管理员那节漏了 find 与 multiuser）。
//
// 现在只在这里维护，各处按需渲染。新增或改名命令时改这一处即可，
// 不会再出现"某个入口没跟上"。
// ============================================================================

/** 用户命令：按分组组织，每项为 [命令写法, 说明] */
export const USER_HELP_SECTIONS = [
  {
    title: "开始使用",
    items: [
      ["/bind", "开通账号，关键词与 AI 配置独立"],
      ["/status", "账号状态、今日用量与勿扰状态"],
    ],
  },
  {
    title: "关键词",
    items: [
      ["/add &lt;关键词&gt; [版块] [--regex]", "添加监控关键词"],
      ["/list", "查看我的关键词"],
      ["/remove &lt;序号…|关键词|all&gt;", "删除，/del 同义，支持批量"],
      ["/pause &lt;序号…|关键词|all&gt;", "暂停但不删除，可随时恢复，支持批量"],
      ["/resume &lt;序号…|关键词|all&gt;", "恢复被暂停的关键词，支持批量"],
      ["/categories", "列出可用版块"],
    ],
  },
  {
    // 三个命令共用同一套选择器，集中说明一次，避免在每个命令描述里重复
    title: "批量操作，三个命令通用",
    items: [
      ["/pause 3", "单条，即第 3 条"],
      ["/pause 1 3 5", "多条，空格或逗号分隔，如 1,3,5"],
      ["/pause 1-5", "范围，第 1 到 5 条"],
      ["/remove 绿云 搬瓦工", "按关键词名，不区分大小写"],
      ["/pause all", "全部，/resume all 恢复全部"],
      ["/remove all confirm", "删除全部需二次确认"],
    ],
  },
  {
    title: "AI 摘要，可选",
    items: [
      ["/ai set &lt;api_key&gt; [base_url]", "配置密钥与地址"],
      ["/ai fallback &lt;模型1,模型2&gt;", "配置模型链，第一个为主模型"],
      ["/ai num &lt;minLen&gt; &lt;maxPerRound&gt; &lt;maxTokens&gt; &lt;timeoutMs&gt;", "调整摘要参数"],
      ["/ai prompt &lt;自定义提示词&gt;", "自定义摘要提示词"],
      ["/ai test", "连通性测试，消耗 1 次配额"],
      ["/ai status", "当前配置与今日用量"],
      ["/ai on / /ai off", "启用或关闭"],
      ["/ai clear", "清除配置，含已加密的 Key"],
    ],
  },
  {
    title: "勿扰模式，暂停推送并可补看",
    items: [
      ["/dnd 2h", "暂停推送 2 小时，到点自动恢复"],
      ["/dnd 23:00-08:00", "每天该时段暂停，可跨零点"],
      ["/dnd on / /dnd off", "长期暂停或立即恢复"],
      ["/dnd backlog", "补看期间错过的帖子"],
      ["/dnd tz &lt;时区&gt;", "设置时区，如 Asia/Shanghai"],
      ["/dnd", "查看当前状态与错过条数"],
    ],
  },
  {
    title: "其他",
    items: [
      ["/history [数量]", "最近推送记录"],
      ["/help", "显示本帮助"],
    ],
  },
];

/** 管理员命令：每项为 [命令写法, 说明] */
export const ADMIN_HELP_ITEMS = [
  ["/admin users [页码]", "用户列表"],
  ["/admin find &lt;ID|用户名&gt;", "搜索用户"],
  ["/admin info &lt;id&gt;", "用户详情，含用量与 AI 状态"],
  ["/admin ban &lt;id&gt; / /admin unban &lt;id&gt;", "封禁或解封"],
  ["/admin quota &lt;id&gt; kw|ai|push &lt;数值|-1&gt;", "设置配额，-1 恢复默认，ai 设 0 为不限"],
  ["/admin note &lt;id&gt; &lt;备注&gt;", "添加备注"],
  ["/admin del &lt;id&gt;", "删除用户及其<b>全部数据</b>"],
  ["/admin stats", "全局统计与运行时状态"],
  ["/admin multiuser on|off|default", "切换运行模式"],
  ["/admin open on|off", "开关自助注册，仅多用户模式生效"],
  ["/admin audit", "最近的管理操作"],
];

/** Telegram 命令菜单（输入 / 时的提示），从上面的用户命令派生以免脱节 */
export const BOT_MENU = [
  ["bind", "开通账号"],
  ["add", "添加关键词"],
  ["list", "查看关键词"],
  ["remove", "删除关键词"],
  ["pause", "暂停关键词"],
  ["resume", "恢复关键词"],
  ["categories", "可用版块"],
  ["ai", "配置 AI 摘要"],
  ["dnd", "勿扰模式"],
  ["status", "账号状态"],
  ["history", "推送记录"],
  ["help", "查看帮助"],
];

/** 渲染成一行行「· 命令 — 说明」 */
export const renderItems = (items) =>
  items.map(([cmd, desc]) => `· <code>${cmd}</code> — ${desc}`).join("\n");
