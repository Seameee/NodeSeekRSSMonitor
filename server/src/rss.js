// ============================================================================
// RSS 抓取与解析
//
// 多用户下最重要的一条优化：**每轮只抓一次，所有用户复用同一份结果**。
// 抓取属于网络 I/O，与用户数无关；用户数只影响后续的内存匹配量。
// ============================================================================
import { RSS_SOURCES, config } from "./config.js";
import { getRssState, setRssState } from "./db.js";
import { log } from "./logger.js";
import { parseRSS } from "./rss-parse.js";

export { parseRSS };

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.nodeseek.com/",
  "Cache-Control": "no-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抓取单个源，支持 ETag / Last-Modified 条件请求 */
async function fetchOne(source, sourceIndex) {
  const state = getRssState(source.url);
  const headers = { ...FETCH_HEADERS };
  // 只在已成功抓过的情况下带条件头，避免首次就 304
  if (state?.etag) headers["If-None-Match"] = state.etag;
  if (state?.last_modified) headers["If-Modified-Since"] = state.last_modified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.rssTimeoutMs);
  try {
    const resp = await fetch(source.url, { headers, signal: controller.signal });
    if (resp.status === 304) {
      setRssState(source.url, { ok: true });
      return { notModified: true };
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    setRssState(source.url, {
      ok: true,
      etag: resp.headers.get("etag"),
      lastModified: resp.headers.get("last-modified"),
    });
    const entries = parseRSS(text, sourceIndex);
    if (!entries.length) throw new Error("解析结果为空");
    return { entries };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 多源抓取：主源优先，失败后依次切备用源。
 * 返回 { entries, sourceIndex, sourceName, notModified }。
 */
export async function fetchEntries() {
  let lastError = null;
  for (let i = 0; i < RSS_SOURCES.length; i++) {
    const source = RSS_SOURCES[i];
    for (let attempt = 0; attempt < config.rssRetries; attempt++) {
      try {
        const r = await fetchOne(source, i);
        if (r.notModified) {
          log.debug("rss", `${source.name} 未变更 (304)`);
          return { notModified: true, sourceIndex: i, sourceName: source.name };
        }
        log.info("rss", `${source.name} 取得 ${r.entries.length} 条`);
        return { entries: r.entries, sourceIndex: i, sourceName: source.name };
      } catch (e) {
        lastError = e;
        log.warn("rss", `${source.name} 第 ${attempt + 1}/${config.rssRetries} 次失败: ${e.message}`);
        if (attempt < config.rssRetries - 1) await sleep(1000 * 2 ** attempt);
      }
    }
    setRssState(source.url, { ok: false });
    log.warn("rss", `${source.name} 全部尝试失败，切换下一个源`);
  }
  throw new Error(`所有 RSS 源均不可用: ${lastError?.message || "未知错误"}`);
}
