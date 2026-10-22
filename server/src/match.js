// ============================================================================
// 关键词匹配
//
// 关键词由用户输入，正则是**不可信输入**，必须防 ReDoS（灾难性回溯）。
// 一个 (a+)+$ 就能把事件循环钉死，多用户场景下等于整台服务被一个人拖垮。
//
// 三重防护：
//   1. 长度上限（MAX_REGEX_LEN）
//   2. 静态分析：拒绝嵌套量词等经典回溯炸弹结构
//   3. 实际匹配在 worker 线程池里执行并带硬超时（见 worker-pool.js），
//      超时即终止该 worker，主进程不受影响
// ============================================================================
import { config } from "./config.js";

/** 已知的高风险结构：嵌套量词、可选重复的重复、交替项含量词 */
const REDOS_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/, // (a+)+ / (a*)*
  /\([^)]*[+*][^)]*\)\{\d*,?\d*\}/, // (a+){2,}
  /\([^)]*\|[^)]*\)[+*]/, // (a|a)+  —— 交替+量词，需人工确认
  /\[[^\]]*\][+*]\{/, // [a-z]+{2,}
  /(?:\.\*){2,}/, // .*.*.*
  /\\[1-9]/, // 反向引用，回溯风险高
];

/**
 * 校验用户输入的正则是否可安全使用。
 * 返回 { ok: true } 或 { ok: false, reason }
 */
export function validateRegex(pattern) {
  if (typeof pattern !== "string" || !pattern.length) {
    return { ok: false, reason: "正则不能为空" };
  }
  if (pattern.length > config.maxRegexLen) {
    return {
      ok: false,
      reason: `正则过长（当前 ${pattern.length} 字符，上限 ${config.maxRegexLen}）`,
    };
  }
  for (const re of REDOS_PATTERNS) {
    if (re.test(pattern)) {
      return {
        ok: false,
        reason: "正则包含容易造成灾难性回溯的结构（如嵌套量词、反向引用），请改写得更简单",
      };
    }
  }
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    return { ok: false, reason: `正则语法错误：${e.message}` };
  }
  return { ok: true };
}

/** 校验普通关键词 */
export function validateKeyword(keyword) {
  const s = String(keyword || "").trim();
  if (!s) return { ok: false, reason: "关键词不能为空" };
  if (s.length > config.maxKeywordLen) {
    return {
      ok: false,
      reason: `关键词过长（当前 ${s.length} 字符，上限 ${config.maxKeywordLen}）`,
    };
  }
  // 控制字符会污染输出与日志
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    return { ok: false, reason: "关键词不能包含控制字符" };
  }
  return { ok: true, value: s };
}

// ─── 编译缓存 ────────────────────────────────────────────────────────────────
// 同一批关键词每轮都要用，缓存编译结果避免重复编译；用修订号做失效。

const regexCache = new Map(); // pattern -> RegExp | null
const CACHE_MAX = 5_000;

export function compileRegex(pattern) {
  if (regexCache.has(pattern)) return regexCache.get(pattern);
  let re = null;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = null;
  }
  if (regexCache.size >= CACHE_MAX) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

/** 单条关键词是否命中标题 */
export function matches(title, keyword, mode = "substring") {
  if (mode === "regex") {
    const re = compileRegex(keyword);
    if (!re) return false;
    re.lastIndex = 0; // 防 g 标志带来的状态残留
    return re.test(title);
  }
  return title.toLowerCase().includes(keyword.toLowerCase());
}

/**
 * 用某个用户的关键词集合匹配一条帖子。
 * 返回命中的关键词数组（空数组表示没命中）。
 */
export function matchPost(post, keywords) {
  const hits = [];
  for (const kw of keywords) {
    // 备用源（source>0）忽略版块限制，主源按版块过滤。
    // category 可能是**逗号分隔的多个版块**（/add kw trade,info），
    // 必须按集合判断：用 === 直接比会让所有多版块规则永不命中——用户设了
    // daily,tech,info,expose,trade 却一条都匹配不到，就是这个原因。
    const cats = kw.category ? String(kw.category).split(",") : null;
    const categoryOk = post.source > 0 || !cats || cats.includes(post.category);
    if (!categoryOk) continue;
    if (matches(post.title, kw.keyword, kw.match_mode)) hits.push(kw.keyword);
  }
  return hits;
}

/** 供 worker 线程使用的批量匹配：对多条帖子跑同一组关键词 */
export function matchPostsBatch(posts, keywords) {
  return posts.map((p) => ({ post_id: p.post_id, matched: matchPost(p, keywords) }));
}

export function clearRegexCache() {
  regexCache.clear();
}
