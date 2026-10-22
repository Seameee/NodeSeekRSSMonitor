// ============================================================================
// worker 线程任务入口
//
// 只做纯计算，不碰数据库、不发网络请求。主进程通过 postMessage 派活，
// 因此这里可以安全地被超时终止重建。
// ============================================================================
import { parentPort } from "node:worker_threads";
import { parseRSS } from "./rss-parse.js";
import { matchPost } from "./match.js";

parentPort.on("message", (task) => {
  try {
    if (task.type === "parse") {
      parentPort.postMessage({ id: task.id, ok: true, result: parseRSS(task.xml, task.sourceIndex) });
    } else if (task.type === "match") {
      // 对多条帖子跑同一组关键词，一次消息传递完成整批匹配
      const out = task.posts.map((p) => ({ post_id: p.post_id, matched: matchPost(p, task.keywords) }));
      parentPort.postMessage({ id: task.id, ok: true, result: out });
    } else {
      parentPort.postMessage({ id: task.id, ok: false, error: `未知任务类型: ${task.type}` });
    }
  } catch (e) {
    parentPort.postMessage({ id: task.id, ok: false, error: e.message });
  }
});
