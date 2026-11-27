import * as fs from 'fs';

/**
 * 跨进程文件锁（写锁）。
 *
 * 为什么需要：同一个数据目录会被 server.ts（REST）、MCP（stdio）与 Electron 主进程同时打开，
 * 各自持一份内存副本。「写前 reload」只解决了"读到最新"，没解决"两个人同时读、同时写"——
 * A、B 都 reload 完，A 先写、B 后写，A 的改动就被静默吃掉了。
 *
 * 做法：O_EXCL 创建锁文件（Windows/macOS/Linux 都原子），拿到才进读改写区，写完立刻释放。
 * - 崩溃遗留：锁文件 mtime 超过 staleMs 视为无主，直接清掉重试；
 * - 同进程重入：写方法内部会触发 reload()，而 reload 在补号时又会 save()，不能自己把自己锁死；
 * - 等锁超时：抛 FileLockTimeoutError，消息里带持锁进程信息，便于排查而不是干等。
 */
export interface FileLockOptions {
  /** 等锁最长时间（毫秒），默认 3000 */
  timeoutMs?: number;
  /** 锁文件多久未更新视为崩溃遗留（毫秒），默认 15000 */
  staleMs?: number;
  /** 首次轮询间隔（毫秒），默认 10，之后指数退避到 50 */
  minDelayMs?: number;
}

/** 同进程重入计数：key 为锁文件绝对路径 */
const depth = new Map<string, number>();

/** 同步休眠：写库是同步流程，不能为了等锁改成 async 把上层全染一遍 */
function sleepSync(ms: number): void {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, Math.max(1, Math.floor(ms)));
}

export class FileLockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: string,
    public readonly waitedMs: number
  ) {
    super(`等待数据目录写锁超时（${waitedMs}ms）：${lockPath} 被 ${holder || '未知进程'} 持有`);
    this.name = 'FileLockTimeoutError';
  }
}

/**
 * 在文件锁内执行 fn。fn 必须同步——异步执行会让锁在 await 期间被其他进程拿走。
 * 返回值原样透出，异常原样抛出（锁一定释放）。
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const staleMs = opts.staleMs ?? 15000;
  const minDelay = opts.minDelayMs ?? 10;

  // 同进程重入：直接放行（外部那一层负责真正的加锁/释放）
  const owned = depth.get(lockPath) || 0;
  if (owned > 0) {
    depth.set(lockPath, owned + 1);
    try {
      return fn();
    } finally {
      const left = (depth.get(lockPath) || 1) - 1;
      if (left <= 0) depth.delete(lockPath);
      else depth.set(lockPath, left);
    }
  }

  const start = Date.now();
  let delay = minDelay;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // 持有者崩溃没来得及 unlink：mtime 超过 staleMs 就清掉重试
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // 锁刚好被释放，立刻重试
      }
      if (Date.now() - start >= timeoutMs) {
        let holder = '';
        try {
          holder = fs.readFileSync(lockPath, 'utf8').trim();
        } catch {
          /* 读不到就报未知 */
        }
        throw new FileLockTimeoutError(lockPath, holder, Date.now() - start);
      }
      sleepSync(Math.min(delay, 50) + Math.random() * 5);
      delay = Math.min(delay * 2, 50);
    }
  }

  depth.set(lockPath, 1);
  try {
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch {
      /* 写不进持有者信息不影响互斥本身 */
    }
    return fn();
  } finally {
    depth.delete(lockPath);
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* 已被 stale 清理或删掉，忽略 */
    }
  }
}