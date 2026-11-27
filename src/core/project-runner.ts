/**
 * 项目启动 / 停止执行器。
 *
 * - 启动：依赖优先的拓扑序，逐条串行执行 setup（带超时/退出码），service 常驻；
 * - 停止：逆序，独占依赖默认连带停（含容器数据库），共享依赖保留；
 * - 容器怎么停由档案里的 stopCommand 决定，程序不猜容器内部结构。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  readProjects, readRuntime, writeRuntime, activeCwd, topoOrder, resolveDependents,
  logDir, type ProjectRecord,
} from './project-store';
import {
  setTransient, clearTransient, waitReady, getCachedStatuses, probeOnce,
  findPidOnPort, pidBelongsTo, markStopped, clearStopMark,
} from './project-probe';

function spawnCmd(cwd: string, cmd: string, keepOpen: boolean, logFile: string) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} ${keepOpen ? '常驻服务' : '准备步骤'} =====\n${cmd}\n`);
  const opts: any = { cwd, detached: true, stdio: ['ignore', fd, fd] };
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', [keepOpen ? '/k' : '/c', cmd], opts)
    : spawn('bash', ['-c', cmd], opts);
  child.once('exit', () => { try { fs.closeSync(fd); } catch { /* ignore */ } });
  child.unref();
  return child;
}

function killProcess(pid: number, sig: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* ignore */ } }
  } catch { /* ignore */ }
}

function killGroup(pid: number): void {
  killProcess(pid, 'SIGTERM');
  setTimeout(() => killProcess(pid, 'SIGKILL'), 1500).unref();
}

async function runOnce(cwd: string, cmd: string, timeoutMs: number, logFile: string): Promise<{ code: number; error?: string }> {
  const child = spawnCmd(cwd, cmd, false, logFile);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!child.pid) return;
      killProcess(child.pid, 'SIGKILL');
      if (!settled) { settled = true; resolve({ code: -1, error: `命令超时（${timeoutMs}ms）：${cmd}` }); }
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve({ code: -1, error: e.message }); }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve({ code: code ?? -1 }); }
    });
  });
}

async function runCommands(dataDir: string, p: ProjectRecord): Promise<{ pids: number[]; error?: string }> {
  const cwd = activeCwd(p);
  if (!fs.existsSync(cwd)) return { pids: [], error: `目录不存在：${cwd}` };
  const pids: number[] = [];
  const cmds = p.commands || [];
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    const isService = c.kind === 'service';
    const log = path.join(logDir(dataDir, p.id), `step-${i + 1}.log`);
    const child = spawnCmd(c.cwd || cwd, c.cmd, isService, log);
    if (!child.pid) return { pids, error: `第 ${i + 1} 条命令起不来：${c.cmd}` };
    if (isService) {
      pids.push(child.pid);
      continue;
    }
    const code = await new Promise<number>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        killProcess(child.pid!, 'SIGKILL');
        if (!settled) { settled = true; resolve(-1); }
      }, c.timeoutMs || 180000);
      child.once('error', () => { clearTimeout(timer); if (!settled) { settled = true; resolve(-1); } });
      child.once('exit', (n) => { clearTimeout(timer); if (!settled) { settled = true; resolve(n ?? -1); } });
    });
    if (code !== 0) {
      return { pids, error: `准备步骤 ${i + 1} 失败或超时（退出码 ${code}）：${c.cmd}` };
    }
  }
  return { pids };
}

/** 启动：依赖先起、等就绪，再起主项目 */
export async function startProject(dataDir: string, id: string): Promise<{ ok: boolean; message?: string }> {
  const { projects } = readProjects(dataDir);
  let order: ProjectRecord[];
  try {
    order = topoOrder(projects, id);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  // MCP 进程里没有常驻探测轮，先现算一轮，否则「依赖已在跑」判断恒为 false，会重复拉起共享依赖
  await probeOnce(dataDir).catch(() => {});
  const rt = readRuntime(dataDir);
  for (const node of order) {
    const cached = getCachedStatuses()[node.id];
    if (cached?.status === 'running') continue; // 共享依赖已在跑，不重复起
    setTransient(node.id, {
      phase: node.id === id ? 'starting' : 'waiting',
      lastError: undefined,
      lastStartedAt: new Date().toISOString(),
    });
    const r = await runCommands(dataDir, node);
    if (r.error) {
      setTransient(node.id, { phase: 'failed', lastError: r.error });
      return { ok: false, message: `${node.name}：${r.error}` };
    }
    rt[node.id] = {
      pgid: r.pids[0],
      pids: r.pids,
      startedAt: new Date().toISOString(),
      cwd: activeCwd(node),
    };
    writeRuntime(dataDir, rt);
    setTransient(node.id, { phase: undefined });
    if ((node.probe?.ports || []).length || node.probe?.docker) {
      const ready = await waitReady(dataDir, node.id, node.probe?.readyTimeoutMs || 60000);
      if (!ready) {
        const msg = `${node.name} 启动命令已执行完，但等待 ${node.probe?.readyTimeoutMs || 60000}ms 后仍未就绪`;
        setTransient(node.id, { phase: 'failed', lastError: msg });
        return { ok: false, message: msg };
      }
    }
  }
  return { ok: true };
}

async function stopOne(dataDir: string, p: ProjectRecord): Promise<string | undefined> {
  const rt = readRuntime(dataDir);
  const entry = rt[p.id];
  let warning: string | undefined;
  const cwd = activeCwd(p);

  if (p.stopCommand) {
    const r = await runOnce(cwd, p.stopCommand, 60000, path.join(logDir(dataDir, p.id), 'stop.log'));
    if (r.code !== 0) warning = `停止命令未成功：${r.error || `退出码 ${r.code}`}`;
  }

  if (entry?.pids?.length) {
    for (const pid of entry.pids) killGroup(pid);
  }

  // 兜底复检：stopCommand 经常「成功但没真停」（pm2 里已没有这个进程、docker 停了但前台进程还在、
  // 或者当初是别的 Agent 在终端起的）。只要端口还通，就按归属校验再做一次。
  for (const port of p.probe?.ports || []) {
    const pid = findPidOnPort(port);
    if (!pid) continue;
    if (pidBelongsTo(pid, p)) {
      await new Promise((r) => setTimeout(r, 1200)); // 给停止命令一点时间，避免刚停又补一刀
      const again = findPidOnPort(port);
      if (again && pidBelongsTo(again, p)) killGroup(again);
    } else if (!warning) {
      warning = `端口 ${port} 上的进程 ${pid} 不像本项目，未关闭（请手动确认）`;
    }
  }

  delete rt[p.id];
  writeRuntime(dataDir, rt);
  clearTransient(p.id);
  return warning;
}

export interface StopPlanItem {
  id: string;
  name: string;
  reason: 'self' | 'dependency';
  shared: boolean;
  ports: number[];
  container?: string;
}

export interface StopPlan {
  id: string;
  /** all = 正常关闭（自己 + 独占依赖）；deps = 只关依赖，主程序留着 */
  only: 'all' | 'deps';
  /** 实际会连带停：档案 stopPolicy 不是 self，且调用方没显式关掉 */
  cascade: boolean;
  targets: StopPlanItem[];
  /** 不会停的依赖，以及原因 —— 关之前让人看清「哪些东西还留着」 */
  survivors: { id: string; name: string; reason: string }[];
}

/**
 * 关闭预演：只算不动手。页面弹窗和 MCP 回执都用它，
 * 保证「实际会停什么」与「告诉用户会停什么」是同一份计算。
 */
export async function planStop(
  dataDir: string,
  id: string,
  opts: { cascade?: boolean; only?: 'all' | 'deps' } = {},
): Promise<StopPlan | { error: string }> {
  const { projects } = readProjects(dataDir);
  const p = projects.find((x) => x.id === id);
  if (!p) return { error: `项目不存在：${id}` };

  // MCP 进程没有常驻探测轮，先现算一轮，否则「别的项目是否还在用」判断会漏
  await probeOnce(dataDir).catch(() => {});
  const statuses = getCachedStatuses();

  // only=deps：只关依赖、主程序留着（比如「把数据库停掉、服务先挂着」）
  const depsOnly = opts.only === 'deps';
  const plan: StopPlan = {
    id,
    only: depsOnly ? 'deps' : 'all',
    cascade: depsOnly ? true : opts.cascade !== false && p.stopPolicy !== 'self',
    targets: [],
    survivors: [],
  };
  if (depsOnly) {
    plan.survivors.push({ id: p.id, name: p.name, reason: '主程序：本次只关依赖' });
  } else {
    plan.targets.push({
      id: p.id, name: p.name, reason: 'self', shared: !!p.shared,
      ports: p.probe?.ports || [], container: p.probe?.docker?.container,
    });
  }
  if (!plan.cascade) {
    if (p.stopPolicy === 'self') plan.survivors.push({ id: '-', name: '全部依赖', reason: '本节点 stopPolicy=self，只停自己' });
    return plan;
  }

  const deps = topoOrder(projects, id).filter((x) => x.id !== id).reverse();
  for (const d of deps) {
    if (d.shared || d.stopPolicy === 'keep') {
      plan.survivors.push({
        id: d.id, name: d.name,
        reason: d.shared ? '共享依赖（shared）' : '标记为保留（stopPolicy=keep）',
      });
      continue;
    }
    const others = resolveDependents(projects, d.id)
      .filter((x) => x !== id && statuses[x]?.status === 'running');
    if (others.length) {
      plan.survivors.push({ id: d.id, name: d.name, reason: `仍在被其他运行中的项目使用：${others.join('、')}` });
      continue;
    }
    plan.targets.push({
      id: d.id, name: d.name, reason: 'dependency', shared: !!d.shared,
      ports: d.probe?.ports || [], container: d.probe?.docker?.container,
    });
  }
  return plan;
}

/**
 * 关闭：独占依赖默认连带停，共享依赖（shared / keep）保留。
 * 停完等一个 SIGKILL 宽限期再复检，把「还活着的东西」如实返回。
 */
export async function stopProject(
  dataDir: string,
  id: string,
  opts: { cascade?: boolean; only?: 'all' | 'deps'; verify?: boolean } = {},
): Promise<{
  ok: boolean;
  message?: string;
  plan?: StopPlan;
  residual?: { id: string; name: string; ports: number[]; containers: string[] }[];
}> {
  const planned = await planStop(dataDir, id, opts);
  if ('error' in planned) return { ok: false, message: planned.error };
  const plan = planned;

  const { projects } = readProjects(dataDir);
  const warnings: string[] = [];
  for (const item of plan.targets) {
    const node = projects.find((x) => x.id === item.id);
    if (!node) continue;
    setTransient(node.id, { lastError: undefined });
    clearStopMark(node.id);
    const w = await stopOne(dataDir, node);
    if (w) warnings.push(`${node.name}：${w}`);
    markStopped(node.id, node.probe?.ports || [], node.probe?.docker?.container);
  }

  // 复检：等过 kill 宽限期（1.5s）再探，仍通/仍 running 就是没停干净
  let residual: { id: string; name: string; ports: number[]; containers: string[] }[] = [];
  if (opts.verify !== false) {
    await new Promise((r) => setTimeout(r, 4000));
    const snap = await probeOnce(dataDir).catch(() => ({} as any));
    residual = plan.targets
      .map((t) => ({
        id: t.id, name: t.name,
        ports: snap[t.id]?.residual?.ports || [],
        containers: snap[t.id]?.residual?.containers || [],
      }))
      .filter((x) => x.ports.length || x.containers.length);
  }

  return {
    ok: true,
    message: warnings.length ? warnings.join('；') : undefined,
    plan,
    residual,
  };
}

export function readProjectLogs(dataDir: string, id: string): { step: string; content: string }[] {
  const dir = logDir(dataDir, id);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => ({
      step: f.replace(/\.log$/, ''),
      content: fs.readFileSync(path.join(dir, f), 'utf8').slice(-20000),
    }));
  } catch {
    return [];
  }
}
