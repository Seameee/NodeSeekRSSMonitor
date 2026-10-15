// ============================================================================
// worker 线程池
//
// 解决两个问题：
//   1. 多线程：XML 解析与关键词正则匹配是 CPU 密集操作，放到 worker 后
//      主线程始终能及时响应 Telegram 命令，用户多时不会「发个命令要等半天」。
//   2. ReDoS 隔离：用户提交的正则若发生灾难性回溯，只会拖死某个 worker，
//      主进程按硬超时把它终止并重建，服务整体不受影响。
//
// 池不可用（WORKER_POOL_SIZE=0 或线程创建失败）时自动回退到进程内计算，
// 功能不受影响，只是失去超时保护。
// ============================================================================
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { parseRSS } from "./rss-parse.js";
import { matchPost } from "./match.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_ENTRY = join(__dirname, "worker-task.js");

class Pool {
  constructor(size, taskTimeoutMs) {
    this.size = size;
    this.taskTimeoutMs = taskTimeoutMs;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.seq = 0;
    this.disabled = size <= 0;
    if (!this.disabled) {
      for (let i = 0; i < size; i++) this.#spawn(i);
    }
  }

  #spawn(index) {
    let worker;
    try {
      worker = new Worker(TASK_ENTRY);
    } catch (e) {
      log.error("pool", `worker 创建失败，退化为进程内计算: ${e.message}`);
      this.disabled = true;
      return;
    }
    worker._index = index;
    worker._busy = null; // 当前任务
    worker.on("message", (msg) => this.#onDone(worker, null, msg));
    worker.on("error", (err) => {
      log.error("pool", `worker#${index} 错误: ${err.message}`);
      this.#recycle(worker, new Error(err.message));
    });
    worker.on("exit", (code) => {
      // 被 terminate() 的 worker 走这里；正常不应自己退出
      if (worker._busy) {
        log.warn("pool", `worker#${index} 异常退出 (code=${code})，重建`);
        this.#recycle(worker, new Error("worker 意外退出"));
      } else {
        this.workers = this.workers.filter((w) => w !== worker);
        this.idle = this.idle.filter((w) => w !== worker);
        if (!this.disabled && this.workers.length < this.size) this.#spawn(index);
      }
    });
    this.workers[index] = worker;
    this.idle.push(worker);
  }

  #onDone(worker, err, msg) {
    const task = worker._busy;
    worker._busy = null;
    if (task) {
      clearTimeout(task.timer);
      if (err) task.reject(err);
      else if (msg && msg.ok) task.resolve(msg.result);
      else task.reject(new Error(msg?.error || "worker 返回失败"));
    }
    if (!this.disabled && !this.workers.includes(worker)) return;
    if (this.idle.includes(worker)) return;
    this.idle.push(worker);
    this.#drain();
  }

  /** 超时或崩溃后：丢弃该 worker，重建一个替补 */
  #recycle(worker, err) {
    const task = worker._busy;
    worker._busy = null;
    if (task) {
      clearTimeout(task.timer);
      task.reject(err);
    }
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    worker.terminate().catch(() => {});
    if (!this.disabled) {
      this.#spawn(worker._index ?? this.workers.length);
      log.warn("pool", `已重建 worker#${worker._index}（原任务被终止）`);
    }
    this.#drain();
  }

  #drain() {
    while (this.queue.length && this.idle.length) {
      const worker = this.idle.shift();
      const task = this.queue.shift();
      worker._busy = task;
      task.timer = setTimeout(() => {
        log.error(
          "pool",
          `任务 ${task.type} 超过 ${this.taskTimeoutMs}ms 未完成，判定为异常（可能是恶意正则），已终止该 worker`
        );
        this.#recycle(worker, new Error("计算超时"));
      }, this.taskTimeoutMs);
      worker.postMessage(task.payload);
    }
  }

  /** 提交任务；池不可用时返回 null，由调用方回退 */
  run(type, payload) {
    if (this.disabled) return null;
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, type, payload: { ...payload, id: this.seq }, resolve, reject });
      this.#drain();
    });
  }

  stats() {
    return {
      size: this.size,
      disabled: this.disabled,
      idle: this.idle.length,
      queued: this.queue.length,
      alive: this.workers.filter(Boolean).length,
    };
  }

  async close() {
    this.disabled = true;
    this.queue.splice(0).forEach((t) => {
      clearTimeout(t.timer);
      t.reject(new Error("线程池关闭"));
    });
    await Promise.all(this.workers.filter(Boolean).map((w) => w.terminate().catch(() => {})));
    this.workers = [];
    this.idle = [];
  }
}

export const pool = new Pool(config.workerPoolSize, config.workerTaskTimeoutMs);

log.info(
  "pool",
  pool.disabled
    ? "worker 线程池已禁用，改为进程内计算（失去 ReDoS 硬超时保护）"
    : `worker 线程池已启动，${config.workerPoolSize} 个线程，单任务超时 ${config.workerTaskTimeoutMs}ms`
);

/** 解析 RSS：优先走 worker，失败则进程内兜底 */
export async function parseRSSAsync(xml, sourceIndex = 0) {
  const p = pool.run("parse", { xml, sourceIndex });
  if (p) {
    try {
      return await p;
    } catch (e) {
      log.warn("pool", `解析任务失败，回退进程内: ${e.message}`);
    }
  }
  return parseRSS(xml, sourceIndex);
}

/** 批量匹配：优先走 worker，失败则进程内兜底 */
export async function matchPostsAsync(posts, keywords) {
  if (!posts.length || !keywords.length) return posts.map((p) => ({ post_id: p.post_id, matched: [] }));
  const p = pool.run("match", { posts, keywords });
  if (p) {
    try {
      return await p;
    } catch (e) {
      log.warn("pool", `匹配任务失败，回退进程内: ${e.message}`);
    }
  }
  return posts.map((post) => ({ post_id: post.post_id, matched: matchPost(post, keywords) }));
}
