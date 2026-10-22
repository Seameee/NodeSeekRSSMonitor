// ============================================================================
// RSS 纯解析（无任何状态/DB 依赖）
//
// 单独成文件的目的：worker 线程只需要「纯函数」，
// 不能把 db.js 拖进去（SQLite 句柄不可跨线程共享）。
// ============================================================================

/** 在 XML 片段里取标签值，兼容 CDATA 与普通写法；编译结果按标签缓存 */
function makeTagReader(block) {
  const cache = new Map();
  return (tag) => {
    let re = cache.get(tag);
    if (!re) {
      re = new RegExp(
        `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>` +
          `|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`
      );
      cache.set(tag, re);
    }
    const m = block.match(re);
    return m ? (m[1] || m[2] || "").trim() : "";
  };
}

/**
 * 解析 RSS/Atom。
 * sourceIndex=0 为主源（带 category/author），其余为 Telegram 镜像源。
 */
export function parseRSS(xml, sourceIndex = 0) {
  const entries = [];
  const re = /<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi;
  let m;

  while ((m = re.exec(xml)) !== null) {
    const block = m[1] || m[2];
    if (!block) continue;
    const tag = makeTagReader(block);

    let link = tag("link") || (block.match(/<link[^>]+href="([^"]*)"/) || [])[1] || "";
    const id = tag("id") || tag("guid");
    const description = tag("description");

    let postId = null;
    let category = "";
    let author = "";

    if (sourceIndex === 0) {
      const pidM = id.match(/(\d+)/);
      if (!pidM) continue;
      postId = Number.parseInt(pidM[1], 10);
      category = tag("category");
      author = tag("author") || tag("dc:creator");
    } else {
      const nsLink =
        (/https:\/\/www\.nodeseek\.com\/post-\d+-\d+/.exec(description) || [])[0] || null;
      let pidM = nsLink ? nsLink.match(/post-(\d+)-/) : null;
      if (!pidM && link) pidM = link.match(/t\.me\/[^/]+\/(\d+)/);
      if (!pidM) continue;
      postId = Number.parseInt(pidM[1], 10);
      if (nsLink) link = nsLink;
      category = "telegram";
      author = tag("author") || "NodeSeek频道";
    }

    if (!postId) continue;
    entries.push({
      post_id: postId,
      title: tag("title"),
      link: link || `https://t.me/nodeseekc/${postId}`,
      category,
      author,
      source: sourceIndex,
      content: description,
    });
  }

  return entries;
}
