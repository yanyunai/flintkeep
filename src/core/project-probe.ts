/**
 * 项目运行状态探测：应用后端内部每 3 秒跑一轮，与 Agent / MCP 完全无关。
 *
 * 判活只看本机事实：TCP 握手 +（容器项目）docker ps 状态。
 * 状态不落库、每次重算，所以应用重启、别的 Agent 在终端起的服务，都能自动发现。
 */
import * as net from 'net';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import {
  readProjects, readRuntime, activeCwd,
  type ProjectRecord, type ProjectRuntimeState, type ProjectStatus,
} from './project-store';

export function portOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      // 连上后先发 FIN 再销毁：直接 destroy 会发 RST，个别简陋服务会因此报 ECONNRESET
      try { sock.end(); } catch { /* ignore */ }
      const t = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } }, 200);
      if (typeof (t as any).unref === 'function') (t as any).unref();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 端口反查 PID：关闭「外部启动」的项目时用 */
export function findPidOnPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as any });
      for (const line of String(out).split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
      return null;
    }
    // 必须限定 LISTEN：不加的话连上来的浏览器/探活客户端也会被列出来，
    // 取到的是客户端 PID，归属校验必然失败 → 表现为「点关闭没反应」。
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as any,
    });
    const pid = Number(String(out).trim().split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 进程的工作目录（命令行里看不出项目时，靠它判断归属；Windows 上返回空走原逻辑） */
function pidCwd(pid: number): string {
  if (process.platform === 'win32') return '';
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] as any,
    });
    const line = String(out).split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : '';
  } catch {
    return '';
  }
}

/**
 * 该 PID 是否属于本项目（防止误杀 IDE / 别的 Agent 的终端）。
 * 命令行匹配不到时再看进程工作目录 —— 否则「pnpm dev 起的 vite」这类进程永远判不出归属，
 * 用户点关闭只会一直收到「不像本项目，未关闭」。
 */
export function pidBelongsTo(pid: number, p: ProjectRecord): boolean {
  // /var 与 /private/var 这类符号链接差异会让纯字符串比较失效，统一取真实路径
  const real = (s: string) => {
    try { return fs.realpathSync(s).toLowerCase(); } catch { return s.toLowerCase(); }
  };
  const cwd = real(activeCwd(p));
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] as any });
    const cmd = String(out).toLowerCase();
    if (cmd.includes(cwd) || cmd.includes(p.id.toLowerCase()) || cmd.includes(p.name.toLowerCase())) return true;
  } catch {
    return false; // 进程已不在
  }
  const pcwd = real(pidCwd(pid) || '/__none__');
  return pcwd !== '/__none__' && (pcwd === cwd || pcwd.startsWith(cwd.replace(/\/+$/, '') + '/'));
}

interface DockerContainer {
  name: string;
  state: string;
  project: string;
  service: string;
}

let dockerCache: { at: number; available: boolean; list: DockerContainer[] } | null = null;

/** 一次 docker ps 拿到全部容器（含 compose 归属标签），5 秒缓存 */
export function dockerContainers(force = false): { available: boolean; list: DockerContainer[] } {
  if (!force && dockerCache && Date.now() - dockerCache.at < 5000) return dockerCache;
  try {
    const out = execFileSync(
      'docker',
      ['ps', '--format', '{{.Names}}|{{.State}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] as any },
    );
    const list = String(out).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, state, project, service] = l.split('|');
      return { name, state, project: project || '', service: service || '' };
    });
    dockerCache = { at: Date.now(), available: true, list };
  } catch {
    dockerCache = { at: Date.now(), available: false, list: [] };
  }
  return dockerCache;
}

function dockerStateOf(p: ProjectRecord): string | undefined {
  const d = p.probe?.docker;
  if (!d) return undefined;
  const dock = dockerContainers();
  if (!dock.available) return 'unknown';
  const hit = dock.list.find((c) => d.container
    ? c.name === d.container
    : (!!d.composeService && c.service === d.composeService && (!d.projectName || c.project === d.projectName)));
  return hit ? hit.state : 'missing';
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface Transient {
  phase?: 'starting' | 'waiting' | 'failed';
  lastError?: string;
  lastStartedAt?: string;
}

const transient = new Map<string, Transient>();

/**
 * 关闭标记：runner 停完一个节点就登记一次，之后每轮探测复检。
 * 仍能探到端口/容器存活 → 状态里带 residual（页面标红「没停干净」）；
 * 都干净了 → 自动撤掉标记，不长期污染状态。
 */
interface StopMark { at: number; ports: number[]; container?: string }
const stopMarks = new Map<string, StopMark>();

export function markStopped(id: string, ports: number[], container?: string): void {
  stopMarks.set(id, { at: Date.now(), ports: [...ports], container });
}

export function clearStopMark(id: string): void {
  stopMarks.delete(id);
}

let snapshot: Record<string, ProjectRuntimeState> = {};
let probeDataDir = '';
let lastSignature = '';
const subscribers = new Set<(data: Record<string, ProjectRuntimeState>) => void>();

export function getCachedStatuses(): Record<string, ProjectRuntimeState> {
  return snapshot;
}

/** runner 在开始/失败/完成时打瞬时标记，立即触发一次重算 */
export function setTransient(id: string, patch: Partial<Transient>): void {
  const cur = transient.get(id) || {};
  const next = { ...cur, ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as any)[k];
  }
  if (Object.keys(next).length) transient.set(id, next);
  else transient.delete(id);
  if (probeDataDir) void probeOnce(probeDataDir).catch(() => {});
}

export function clearTransient(id: string): void {
  transient.delete(id);
  if (probeDataDir) void probeOnce(probeDataDir).catch(() => {});
}

export function subscribe(fn: (data: Record<string, ProjectRuntimeState>) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function broadcast(): void {
  const sig = Object.entries(snapshot)
    .map(([k, v]) => `${k}:${v.status}:${v.source || ''}:${v.portsOpen.join(',')}:${v.dockerState || ''}:${v.lastError || ''}`
      + `:${v.residual ? `${v.residual.ports.join('+')}/${v.residual.containers.join('+')}` : ''}`)
    .join('|');
  if (sig === lastSignature) return;
  lastSignature = sig;
  for (const fn of subscribers) {
    try { fn(snapshot); } catch { /* ignore */ }
  }
}

/** 全量探测一轮（所有端口并发，容器只跑一次 docker ps） */
export async function probeOnce(dataDir: string): Promise<Record<string, ProjectRuntimeState>> {
  const { projects } = readProjects(dataDir);
  const rt = readRuntime(dataDir);
  const next: Record<string, ProjectRuntimeState> = {};

  await Promise.all(projects.map(async (p) => {
    const ports = p.probe?.ports || [];
    const opened: number[] = [];
    const checks = await Promise.all(ports.map((q) => portOpen(q)));
    checks.forEach((ok, i) => { if (ok) opened.push(ports[i]); });
    const mode = p.probe?.mode || 'any';
    const portOk = ports.length
      ? (mode === 'all' ? opened.length === ports.length : opened.length > 0)
      : false;

    const ds = dockerStateOf(p);
    const tr = transient.get(p.id);
    const entry = rt[p.id];
    const managed = !!entry && (entry.pids || []).some(pidAlive);
    const hasProbe = ports.length > 0 || !!p.probe?.docker;

    // 配了健康检查地址就再确认一次 HTTP 层，避免「端口被别的服务占了」误判为本项目在跑。
    // 配了 fingerprint 再验一层内容：HTTP 2xx 但内容不含特征串 = 别人的服务在听这个口。
    let healthy: boolean | undefined;
    /** HTTP 通了但特征不匹配 → 端口上的服务不是本项目（true = 被别人占了） */
    let foreignPort: boolean | undefined;
    if (portOk && p.probe?.healthUrl) {
      try {
        const r = await fetch(p.probe.healthUrl, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) {
          healthy = false;
        } else if (p.probe.fingerprint) {
          const body = (await r.text()).slice(0, 200 * 1024);
          if (body.includes(p.probe.fingerprint)) healthy = true;
          else { healthy = false; foreignPort = true; }
        } else {
          healthy = true;
        }
      } catch { healthy = false; }
    }

    let status: ProjectStatus;
    if (tr?.phase === 'starting' || tr?.phase === 'waiting') status = tr.phase;
    else if (tr?.phase === 'failed') status = 'failed';
    else if (healthy === false && foreignPort) status = managed ? 'unhealthy' : 'stopped'; // 端口被占≠本项目在跑：没托管就老老实实算停了
    else if (healthy === false) status = 'unhealthy';
    else if ((portOk && foreignPort !== true) || ds === 'running') status = 'running';
    else if (ds === 'unhealthy' || (managed && hasProbe)) status = 'unhealthy';
    else if (managed && !hasProbe) status = 'running'; // 没配探测目标时，进程活着就算在跑
    else if (ds === 'unknown') status = 'unknown';
    else status = 'stopped';

    // 关闭后残留复检：等 3 秒（进程组还在 SIGKILL 的宽限期内），之后仍探到活口就标残留
    let residual: ProjectRuntimeState['residual'];
    const mark = stopMarks.get(p.id);
    if (mark && Date.now() - mark.at >= 3000) {
      const livePorts = mark.ports.filter((q) => opened.includes(q));
      const liveContainers = mark.container && ds === 'running' ? [mark.container] : [];
      if (livePorts.length || liveContainers.length) {
        residual = { ports: livePorts, containers: liveContainers, checkedAt: new Date().toISOString() };
      } else {
        stopMarks.delete(p.id);
      }
    }

    next[p.id] = {
      status,
      source: status === 'running' ? (managed ? 'managed' : 'external') : undefined,
      portsOpen: opened,
      portsTotal: ports.length,
      pids: entry?.pids || [],
      phase: tr?.phase,
      lastError: tr?.lastError,
      lastStartedAt: tr?.lastStartedAt || entry?.startedAt,
      dockerState: ds,
      ...(residual ? { residual } : {}),
      checkedAt: new Date().toISOString(),
    };
  }));

  snapshot = next;
  broadcast();
  return next;
}

/** 等某个项目就绪（依赖启动后使用） */
export async function waitReady(dataDir: string, id: string, timeoutMs = 60000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await probeOnce(dataDir);
    if (s[id]?.status === 'running') return true;
    if (s[id]?.status === 'failed') return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function startProbeLoop(dataDir: string, intervalMs = 3000): () => void {
  probeDataDir = dataDir;
  void probeOnce(dataDir).catch(() => {});
  const timer = setInterval(() => { void probeOnce(dataDir).catch(() => {}); }, intervalMs);
  return () => {
    clearInterval(timer);
    probeDataDir = '';
  };
}
