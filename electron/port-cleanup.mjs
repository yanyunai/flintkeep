/**
 * 端口清理：解决「改了后端代码重启却不生效」的根因。
 *
 * 背景：Electron 被强杀 / 崩溃时走不到 before-quit，后端 node 子进程会变成孤儿，
 * 一直占着 8787。下次启动检测到端口被占就"复用现有后端"——于是新代码永远不生效
 * （用户原话："我他妈要重启电脑才算重启吗"）。
 *
 * 对策：启动前主动清掉**确认属于本应用**的残留后端。
 * 单独成模块是为了能脱离 Electron 环境做真实测试（main.mjs 一 import electron 就跑不起来）。
 */
import { execSync } from 'child_process';
import net from 'net';

/** 端口是否已在监听（短超时探测） */
export function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 找出监听指定端口的进程 PID；没找到返回 null */
export function findPidOnPort(port) {
  try {
    const out =
      process.platform === 'win32'
        ? execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true })
        : execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' });
    if (process.platform !== 'win32') {
      const pid = Number(String(out).trim().split('\n')[0]);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
    for (const line of String(out).split('\n')) {
      if (!line.includes('LISTENING')) continue;
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      const pid = Number(line.trim().split(/\s+/).pop());
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 确认端口上是**本应用的后端**才允许动手，绝不误杀别的软件。
 * 判据：GET /api/locked 返回形如 {locked:true|false} —— 这是我们自己的接口。
 * 实测：Vite(8790) 等其它服务不会命中。
 */
export async function isOurBackend(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/api/locked`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return typeof j?.locked === 'boolean';
  } catch {
    return false;
  }
}

/** 轮询等待端口关闭 */
export function waitPortClosed(port, host = '127.0.0.1', timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = async () => {
      if (!(await portOpen(port, host, 400))) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

/**
 * 清理上一轮残留的后端。
 * @returns {Promise<{cleaned: boolean, pid: number|null, reason: string}>}
 */
export async function cleanupStaleBackend(port) {
  if (!(await portOpen(port))) return { cleaned: false, pid: null, reason: '端口空闲，无需清理' };

  const pid = findPidOnPort(port);
  if (!pid) return { cleaned: false, pid: null, reason: '端口被占但解析不出 PID' };
  if (pid === process.pid) return { cleaned: false, pid, reason: '占用者是自己，跳过' };

  if (!(await isOurBackend(port))) {
    return { cleaned: false, pid, reason: `端口被非本应用进程占用(PID ${pid})，不动它` };
  }

  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* 可能已经退了 */
  }
  const closed = await waitPortClosed(port);
  return { cleaned: closed, pid, reason: closed ? '旧后端已清理' : '已发出终止命令但端口未释放' };
}
