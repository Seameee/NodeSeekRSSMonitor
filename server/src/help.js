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
      ["/bind", "开通账号（关键词与 AI 配置独立）"],
      ["/status", "我的状态与配额"],
    ],
  },
  {
    title: "关键词",
    items: [
      ["/add &lt;关键词&gt; [版块] [--regex]", "添加监控关键词"],
      ["/list", "查看我的关键词"],
      ["/remove &lt;序号|关键词&gt;", "删除（/del 同义）"],
      ["/pause &lt;序号|关键词&gt;", "暂停但不删除，可随时恢复"],
      ["/resume &lt;序号|关键词&gt;", "恢复被暂停的规则"],
      ["/categories", "可用版块说明"],
    ],
  },
  {
    title: "AI 摘要（可选）",
    items: [
      ["/ai set &lt;api_key&gt; [base_url]", "配置密钥与地址"],
      ["/ai fallback &lt;模型1,模型2&gt;", "配置模型链，第 1 个是主模型"],
      ["/ai num &lt;minLen&gt; &lt;maxPerRound&gt; &lt;maxTokens&gt; &lt;timeoutMs&gt;", "调参"],
      ["/ai prompt &lt;自定义提示词&gt;", "自定义摘要提示词"],
      ["/ai test", "连通性测试（消耗 1 次配额）"],
      ["/ai status", "当前配置与今日用量"],
      ["/ai on / /ai off", "启用 / 关闭"],
      ["/ai clear", "清除配置（含已加密的 Key）"],
    ],
  },
  {
    title: "其他",
    items: [
      ["/history [数量]", "最近推送记录"],
      ["/help", "本帮助"],
    ],
  },
];

/** 管理员命令：每项为 [命令写法, 说明] */
export const ADMIN_HELP_ITEMS = [
  ["/admin users [页码]", "用户列表"],
  ["/admin find &lt;ID|用户名&gt;", "搜索用户"],
  ["/admin info &lt;id&gt;", "用户详情"],
  ["/admin ban &lt;id&gt; / /admin unban &lt;id&gt;", "封禁 / 解封"],
  ["/admin quota &lt;id&gt; kw|ai|push &lt;数值|-1&gt;", "设置配额（-1 恢复默认，ai 设 0 为不限）"],
  ["/admin note &lt;id&gt; &lt;备注&gt;", "写备注"],
  ["/admin del &lt;id&gt;", "删除用户及其<b>全部数据&lt;/b&gt;"],
  ["/admin stats", "全局统计"],
  ["/admin multiuser on|off|default", "多用户模式开关"],
  ["/admin open on|off", "开关注册（仅多用户模式生效）"],
  ["/admin audit", "最近管理操作"],
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
  ["status", "我的状态"],
  ["history", "推送记录"],
  ["help", "帮助"],
];

/** 渲染成一行行「· 命令 — 说明」 */
export const renderItems = (items) =>
  items.map(([cmd, desc]) => `· <code>${cmd}&lt;/code&gt; — ${desc}`).join("\n");
