/**
 * 「运行工作台」档案存储。
 *
 * 设计要点：
 * - 静态档案（Agent 一次性写入 / 页面编辑）与运行态（探测层实时计算）严格分离；
 * - 独立明文 JSON，不进加密保险库：锁屏时页面与菜单栏仍要能启停项目；
 * - MCP 进程与 REST 进程共用本模块，每次读盘不缓存，写入用原子 rename + 文件锁，
 *   避免两个进程各持内存副本互相覆盖。
 */
import * as fs from 'fs';
import * as path from 'path';

export type ProjectKind = 'process' | 'compose' | 'docker';
export type StopPolicy = 'self' | 'cascade' | 'keep';
export type CommandKind = 'setup' | 'service';
export type ProjectStatus =
  | 'stopped' | 'starting' | 'waiting' | 'running'
  | 'unhealthy' | 'failed' | 'unknown';

export interface ProjectCommand {
  cmd: string;
  /** setup 串行执行并等待退出码；service 常驻。留空时最后一条视为 service */
  kind?: CommandKind;
  cwd?: string;
  timeoutMs?: number;
}

export interface ProjectProbe {
  /** 判活端口，可多个 */
  ports?: number[];
  /** 「打开」按钮地址 */
  url?: string;
  healthUrl?: string;
  /**
   * 特征校验：端口开着时再抓 healthUrl 的响应内容，包含此字符串才算本项目在跑。
   * 防止「别的服务恰好占了同一个端口」被误判成 running（vite 被占端口会自动跳号，撞口并不罕见）。
   * 推荐 dev server 用页面 <title> 文本。未配置时退回只看 HTTP 2xx。仅 HTTP 服务可用。
   */
  fingerprint?: string;
  /** 多端口判活策略，默认 any */
  mode?: 'any' | 'all';
  readyTimeoutMs?: number;
  docker?: { container?: string; composeService?: string; projectName?: string };
}

export interface ProjectRecord {
  id: string;
  name: string;
  cwd: string;
  pathMac?: string;
  notes?: string;
  tags?: string[];
  kind?: ProjectKind;
  commands: ProjectCommand[];
  /** 容器节点必填：程序不猜容器内部结构，怎么停由这条命令决定 */
  stopCommand?: string;
  probe: ProjectProbe;
  dependsOn?: string[];
  /**
   * 从属关系：本节点挂在哪个主项目下面（如 PG/Redis 挂在 BuildingAI 下）。
   * 与 dependsOn 等价但语义更明确——有 parent 就自动算作父项目的依赖，
   * Agent 只写主项目时由程序自动派生，不用自己拼依赖图。
   */
  parent?: string;
  stopPolicy?: StopPolicy;
  shared?: boolean;
  registeredBy?: string;
  updatedAt?: string;
}

export interface ProjectFile {
  version: number;
  projects: ProjectRecord[];
}

export interface RuntimeEntry {
  pgid?: number;
  pids: number[];
  startedAt: string;
  cwd?: string;
}

/** 关闭后仍有存活的东西：说明没停干净（漏了节点，或进程被杀前又拉起了） */
export interface ResidualInfo {
  ports: number[];
  containers: string[];
  checkedAt: string;
}

export interface ProjectRuntimeState {
  status: ProjectStatus;
  source?: 'managed' | 'external';
  portsOpen: number[];
  portsTotal: number;
  pids: number[];
  phase?: string;
  lastError?: string;
  lastStartedAt?: string;
  dockerState?: string;
  /** 刚关过、但仍有端口/容器活着 */
  residual?: ResidualInfo;
  checkedAt: string;
}

const RUNTIME_FIELDS = new Set([
  'status', 'pid', 'pgid', 'startedAt', 'source', 'logs', 'runtime',
]);
/** 只属于界面/体检展示的字段，落盘前剔除，避免把 UI 状态写进档案 */
const UI_ONLY_FIELDS = new Set(['registered', 'evidence', 'warnings', 'errors']);

export function projectFilePath(dataDir: string): string {
  return path.join(dataDir, 'myprojects.json');
}
export function runtimeFilePath(dataDir: string): string {
  return path.join(dataDir, 'myprojects-runtime.json');
}
export function logDir(dataDir: string, id: string): string {
  return path.join(dataDir, 'myproject-logs', id.replace(/[^a-z0-9_-]/gi, '_'));
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

/** 跨进程写锁：MCP 与 REST 可能同时写。拿不到锁时短暂重试，超时则直接写（原子 rename 兜底） */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  let got = false;
  for (let i = 0; i < 15 && !got; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      got = true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 5000) fs.unlinkSync(lock); // 清掉崩溃残留
      } catch { /* ignore */ }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* 忙等 20ms，避免引入定时器依赖 */ }
    }
  }
  try {
    return fn();
  } finally {
    if (got) { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
  }
}

/** 每次都读盘，保证 MCP 写入后应用立刻可见 */
export function readProjects(dataDir: string): ProjectFile {
  const f = readJson<ProjectFile>(projectFilePath(dataDir), { version: 1, projects: [] });
  return { version: 1, projects: Array.isArray(f.projects) ? f.projects : [] };
}

export function writeProjects(dataDir: string, file: ProjectFile): void {
  withLock(projectFilePath(dataDir), () => atomicWrite(projectFilePath(dataDir), file));
}

export function getProject(dataDir: string, id: string): ProjectRecord | undefined {
  return readProjects(dataDir).projects.find((p) => p.id === id);
}

export function readRuntime(dataDir: string): Record<string, RuntimeEntry> {
  return readJson<Record<string, RuntimeEntry>>(runtimeFilePath(dataDir), {});
}

export function writeRuntime(dataDir: string, rt: Record<string, RuntimeEntry>): void {
  withLock(runtimeFilePath(dataDir), () => atomicWrite(runtimeFilePath(dataDir), rt));
}

export function activeCwd(p: ProjectRecord): string {
  return process.platform === 'darwin' && p.pathMac ? p.pathMac : p.cwd;
}

function cleanInput(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (v === undefined || RUNTIME_FIELDS.has(k) || UI_ONLY_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function normalizeCommands(cmds: ProjectCommand[] | string | (string | ProjectCommand)[]): ProjectCommand[] {
  // Agent 可以直接传多行字符串，一行一条，省 token；也接受 ["npm i", "npm run dev"] 这种字符串数组
  const raw: ProjectCommand[] = typeof cmds === 'string'
    ? cmds.split(/\r?\n/).filter((s) => s.trim()).map((cmd) => ({ cmd }))
    : (Array.isArray(cmds)
      ? cmds.filter(Boolean).map((c) => (typeof c === 'string' ? { cmd: c } : c))
      : []);
  const list = raw.filter((c) => c && String(c.cmd || '').trim());
  if (!list.length) return [];
  const last = list.length - 1;
  return list.map((c, i) => {
    const kind: CommandKind = c.kind === 'service' || c.kind === 'setup'
      ? c.kind
      : (i === last ? 'service' : 'setup');
    return {
      cmd: String(c.cmd).trim(),
      kind,
      ...(c.cwd ? { cwd: String(c.cwd) } : {}),
      timeoutMs: kind === 'setup' ? Number(c.timeoutMs || 180000) : Number(c.timeoutMs || 0) || undefined,
    };
  });
}

/** 直属子节点（从属关系：这些节点的 parent 是它） */
export function childrenOf(projects: ProjectRecord[], id: string): ProjectRecord[] {
  return projects.filter((p) => p.parent === id);
}

/** 依赖优先的拓扑序（含自身）；有环或引用不存在时抛错。parent 关系等价于 dependsOn */
export function topoOrder(projects: ProjectRecord[], id: string): ProjectRecord[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: ProjectRecord[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (x: string) => {
    if (seen.has(x)) return;
    if (stack.has(x)) throw new Error(`依赖存在循环：${x}`);
    const p = byId.get(x);
    if (!p) throw new Error(`依赖项目不存在：${x}`);
    stack.add(x);
    // 显式 dependsOn + 从属于它的子节点，都要先起
    for (const d of [...(p.dependsOn || []), ...projects.filter((c) => c.parent === x).map((c) => c.id)]) visit(d);
    stack.delete(x);
    seen.add(x);
    out.push(p);
  };
  visit(id);
  return out;
}

/** 直接使用该节点的其他节点 id（共享依赖引用计数用；含从属它的父项目） */
export function resolveDependents(projects: ProjectRecord[], id: string): string[] {
  return projects
    .filter((p) => p.id !== id && ((p.dependsOn || []).includes(id) || p.parent === id))
    .map((p) => p.id);
}

export interface UpsertResult {
  ok: boolean;
  project?: ProjectRecord;
  errors: string[];
  warnings: string[];
  /** 命中了「同一份资源被多个项目登记」的节点，已双向标成 shared */
  sharedWith?: { id: string; name: string }[];
}

/**
 * 依赖节点的资源指纹：用来判断两个节点是不是**同一份资源**。
 * 只认强证据（同一个容器 / 同一个 compose service / 容器节点的独占端口），
 * 宁可漏判也不误合并 —— 误判成共享会导致该停的库没停。
 */
export function depFingerprint(p: ProjectRecord): string | null {
  const docker = p.probe?.docker;
  if (docker?.container) return `container:${docker.container}`;
  if (docker?.projectName && docker?.composeService) return `compose:${docker.projectName}/${docker.composeService}`;
  const ports = p.probe?.ports || [];
  if ((p.kind === 'docker' || p.kind === 'compose') && ports.length === 1) return `port:${ports[0]}`;
  return null;
}

/** 按资源指纹分组，只返回「被 2 个以上节点登记」的组 —— 这些就是同名的共享依赖 */
function duplicateGroups(projects: ProjectRecord[]): { key: string; ids: string[] }[] {
  const map = new Map<string, string[]>();
  for (const p of projects) {
    const k = depFingerprint(p);
    if (!k) continue;
    map.set(k, [...(map.get(k) || []), p.id]);
  }
  return [...map.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids }));
}

/** 页面用：节点 id → 与它同资源的其他节点（用于把重复依赖「亮灯」） */
export function sharingMap(projects: ProjectRecord[]): Record<string, { id: string; name: string }[]> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: Record<string, { id: string; name: string }[]> = {};
  for (const g of duplicateGroups(projects)) {
    for (const id of g.ids) {
      out[id] = g.ids
        .filter((x) => x !== id)
        .map((x) => ({ id: x, name: byId.get(x)?.name || x }));
    }
  }
  return out;
}

/** 一键整理：把重复登记的节点全部标成 shared（关闭任一项目都不会带走它） */
export function applySharedDuplicates(dataDir: string): { ok: boolean; changed: { id: string; name: string; resource: string }[] } {
  const file = readProjects(dataDir);
  const changed: { id: string; name: string; resource: string }[] = [];
  for (const g of duplicateGroups(file.projects)) {
    for (const id of g.ids) {
      const p = file.projects.find((x) => x.id === id);
      if (!p || p.shared) continue;
      p.shared = true;
      changed.push({ id: p.id, name: p.name, resource: g.key });
    }
  }
  if (changed.length) writeProjects(dataDir, { version: 1, projects: file.projects });
  return { ok: true, changed };
}

/** 幂等写入：同 id 覆盖，可只传要改的字段。返回写后完整档案 + 校验结果，Agent 一次调用即可确认 */
export function upsertProject(dataDir: string, input: Record<string, any>): UpsertResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patch = cleanInput(input);
  const id = String(patch.id || '').trim();
  if (!/^[a-z0-9_-]+$/.test(id)) errors.push('id 必须是小写字母/数字/-/_ 组成的标识（如 flintkeep）');

  const file = readProjects(dataDir);
  const existing = file.projects.find((p) => p.id === id);
  const merged = { ...(existing || {}), ...patch, id } as ProjectRecord;

  if (!String(merged.name || '').trim()) errors.push('缺少 name（项目名称）');

  // 子节点没写 cwd 时继承父项目：Agent 只关心主项目路径，容器节点不用重复填
  merged.parent = merged.parent ? String(merged.parent).trim() : undefined;
  if (merged.parent && !String(merged.cwd || '').trim()) {
    const parentRec = file.projects.find((p) => p.id === merged.parent);
    if (parentRec?.cwd) merged.cwd = parentRec.cwd;
  }
  if (merged.parent === id) errors.push('parent 不能指向自己');

  const cwd = String(merged.cwd || '').trim();
  if (!cwd || !path.isAbsolute(cwd)) errors.push('cwd 必须是绝对路径');
  else if (!fs.existsSync(activeCwd(merged))) warnings.push(`目录当前不存在：${activeCwd(merged)}（可先写入，启动前请确认）`);

  merged.commands = normalizeCommands((merged.commands as any) || []);
  if (!merged.commands.length) errors.push('commands 至少需要一条启动命令');
  // 容器节点（compose/docker）的启动命令本身就是「一次性拉起容器」，不强求常驻进程
  const isContainerNode = merged.kind === 'compose' || merged.kind === 'docker';
  if (!isContainerNode && !merged.commands.some((c) => c.kind === 'service')) {
    errors.push('commands 至少需要一条常驻服务命令（最后一条默认即 service）');
  }

  const probe: ProjectProbe = { ...(merged.probe || {}) };
  if (probe.ports !== undefined) {
    if (!Array.isArray(probe.ports)) errors.push('probe.ports 必须是数字数组');
    else {
      probe.ports = probe.ports.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
      probe.ports = [...new Set(probe.ports)];
    }
  }
  for (const key of ['url', 'healthUrl'] as const) {
    const u = probe[key];
    if (u && !/^https?:\/\//i.test(String(u))) errors.push(`probe.${key} 必须是 http(s):// 开头的地址`);
  }
  if (probe.mode && probe.mode !== 'any' && probe.mode !== 'all') errors.push('probe.mode 只能是 any 或 all');
  merged.probe = probe;

  merged.kind = merged.kind || 'process';
  if (!['process', 'compose', 'docker'].includes(merged.kind)) errors.push('kind 只能是 process / compose / docker');
  if ((merged.kind === 'compose' || merged.kind === 'docker') && !String(merged.stopCommand || '').trim()) {
    errors.push('容器节点必须写 stopCommand（如 docker compose stop postgres / docker stop <容器名>），否则程序不知道怎么停容器');
  }
  if (merged.stopPolicy && !['self', 'cascade', 'keep'].includes(merged.stopPolicy)) errors.push('stopPolicy 只能是 self / cascade / keep');
  if (merged.dependsOn && !Array.isArray(merged.dependsOn)) errors.push('dependsOn 必须是 id 数组');
  if (merged.parent && ![...file.projects.filter((p) => p.id !== id), merged].some((p) => p.id === merged.parent)) {
    errors.push(`parent 主项目不存在：${merged.parent}`);
  }

  // 漏节点提醒：不阻断写入（可能确实不用容器），但必须说出来，否则「关不干净」没人知道
  const deps = merged.dependsOn || [];
  const dir = fs.existsSync(activeCwd(merged)) ? activeCwd(merged) : '';
  if (dir) {
    const composeFile = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
      .find((f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } });
    if (composeFile && !deps.length) {
      warnings.push(`目录下有 ${composeFile}，但 dependsOn 为空：若数据库/Redis 由它提供，关闭本项目不会停它们。建议先 project_discover 扫描再补登记。`);
    }
  }
  if (!deps.length && merged.commands.some((c) => /docker\s+(compose\s+)?(up|start|run)/i.test(c.cmd))) {
    warnings.push('启动命令里出现 docker，但没有任何依赖节点：容器不会被连带停，关闭后端口可能仍被占用。');
  }

  merged.updatedAt = new Date().toISOString();
  const all = [...file.projects.filter((p) => p.id !== id), merged];
  if (!errors.length) {
    try { topoOrder(all, id); } catch (e) { errors.push((e as Error).message); }
  }

  if (errors.length) return { ok: false, errors, warnings };

  /* 同一份资源被两个项目各登记一次（同一个容器 / 同一个 compose service / 同一端口）：
     双向标成 shared —— 关任何一个项目都不会把它带走，避免「关了 A 把 B 的数据库干掉」。
     只动依赖节点，不动别人当主项目的卡片（那种只提示）。 */
  const sharedWith: { id: string; name: string }[] = [];
  const mine = merged.parent ? depFingerprint(merged) : null;
  if (mine) {
    for (const o of file.projects) {
      if (o.id === id || depFingerprint(o) !== mine) continue;
      if (!o.parent) {
        warnings.push(`该资源与主项目「${o.name}」是同一份（${mine}）：建议让本项目 dependsOn 复用它，而不是各登记一份。`);
        continue;
      }
      o.shared = true;
      merged.shared = true;
      sharedWith.push({ id: o.id, name: o.name });
    }
    if (sharedWith.length) {
      warnings.push(
        `同一份资源已被 ${sharedWith.map((s) => s.name).join('、')} 登记：已把这些节点和本项目都标成共享依赖（shared），关闭任一项目都不会自动停它。`,
      );
    }
  }

  const next = existing
    ? file.projects.map((p) => (p.id === id ? merged : p))
    : [...file.projects, merged];
  writeProjects(dataDir, { version: 1, projects: next });
  return { ok: true, project: merged, errors, warnings, ...(sharedWith.length ? { sharedWith } : {}) };
}

/**
 * 删除档案。从属它的子节点一起删（避免留下孤儿卡片），
 * 但被别的项目显式 dependsOn 的子节点会保留——只解除 parent，变成独立节点。
 */
export function deleteProject(dataDir: string, id: string): boolean {
  const file = readProjects(dataDir);
  if (!file.projects.some((p) => p.id === id)) return false;

  const rest = file.projects.filter((p) => p.id !== id);
  const children = rest.filter((p) => p.parent === id);
  const keep = rest.filter((p) => p.parent !== id);
  const next = [
    ...keep,
    // 还被别人用着的子节点：保留并解除从属，别把别人依赖的库一起删掉
    ...children
      .filter((c) => keep.some((o) => (o.dependsOn || []).includes(c.id)))
      .map((c) => { const { parent: _parent, ...others } = c; return others as ProjectRecord; }),
  ];

  writeProjects(dataDir, { version: 1, projects: next });
  const rt = readRuntime(dataDir);
  const removed = [id, ...children.filter((c) => !next.some((n) => n.id === c.id)).map((c) => c.id)];
  for (const x of removed) delete rt[x];
  writeRuntime(dataDir, rt);
  return true;
}
