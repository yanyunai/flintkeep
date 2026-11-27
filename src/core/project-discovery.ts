/**
 * 项目体检：从项目目录里读出「跟这个项目有关、但可能没登记」的节点。
 *
 * 只做静态读取，不执行任何命令、不改任何文件：
 * - docker-compose / compose 文件 → 每个 service 建议登记成一个容器节点
 * - .env / .env.example → 端口（DB_PORT/POSTGRES_EXTERNAL_PORT/REDIS_PORT…）
 * - package.json scripts → 启动命令建议
 * - ecosystem.config.js → pm2 应用名与目录
 * - 本机 docker ps → 端口与本项目 .env 撞上的容器（docker run 起的那种没有 compose 归属）
 *
 * 目的只有一个：让「漏登记」在关闭之前就暴露出来，而不是关完发现数据库还在跑。
 */
import * as fs from 'fs';
import * as path from 'path';
import { readProjects, type ProjectRecord } from './project-store';
import { dockerContainers } from './project-probe';

export interface SuggestNode {
  id: string;
  name: string;
  kind: 'process' | 'compose' | 'docker';
  cwd: string;
  commands: { cmd: string; kind: 'setup' | 'service'; timeoutMs?: number }[];
  stopCommand?: string;
  probe: { ports: number[]; docker?: { container?: string; composeService?: string; projectName?: string } };
  shared: boolean;
  stopPolicy: 'self' | 'cascade' | 'keep';
  /** 主项目节点会自动挂上本次扫出来的依赖节点 id，批量登记时一次连成图 */
  dependsOn?: string[];
  notes: string;
  /** 已登记过（id 或容器名/端口命中） */
  registered: boolean;
  /** 命中依据，给页面显示「为什么推荐它」 */
  evidence: string[];
}

export interface DiscoverResult {
  cwd: string;
  suggestions: SuggestNode[];
  missing: number;
  scanned: string[];
  warnings: string[];
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function exists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** 轻量解析 compose 的 services（不引 yaml 依赖：只取 service 名与宿主机端口） */
export function parseComposeServices(text: string): { name: string; ports: number[]; image: string }[] {
  const out: { name: string; ports: number[]; image: string }[] = [];
  const lines = text.split(/\r?\n/);
  let inServices = false;
  let baseIndent = -1;
  let cur: { name: string; ports: number[]; image: string } | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }
    // 出现顶格的新键（networks:/volumes:）说明 services 块结束
    if (/^\S/.test(line)) { inServices = false; cur = null; continue; }

    const head = line.match(/^(\s+)([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (head) {
      const indent = head[1].length;
      if (baseIndent === -1) baseIndent = indent;
      if (indent === baseIndent) {
        cur = { name: head[2], ports: [], image: '' };
        out.push(cur);
        continue;
      }
    }
    if (!cur) continue;

    const img = line.match(/^\s+image:\s*["']?([^"'\s]+)/);
    if (img && !cur.image) cur.image = img[1];

    // ports 两种写法： - 5432:5432 / - "127.0.0.1:5432:5432" / - "5432"
    // 第一个数字是宿主机端口（探测用），第二个是容器内端口
    const pm = line.match(/-\s*["']?(?:[0-9.]+:)?([0-9]{2,5})(?::([0-9]{2,5}))?["']?\s*(?:#.*)?$/);
    if (pm) {
      const host = Number(pm[1]);
      if (Number.isInteger(host) && host > 0 && host <= 65535) cur.ports.push(host);
    }
  }
  return out.filter((s) => !!s.name);
}

/** 从 .env 里挑出端口类配置 */
export function parseEnvPorts(text: string): { key: string; port: number }[] {
  const out: { key: string; port: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]*PORT[A-Z0-9_]*)\s*=\s*["']?(\d{2,5})/);
    if (m) out.push({ key: m[1], port: Number(m[2]) });
  }
  return out;
}

function parsePackageScripts(text: string): Record<string, string> {
  try {
    const j = JSON.parse(text);
    return (j && typeof j.scripts === 'object' && j.scripts) || {};
  } catch { return {}; }
}

/** 是否已登记：id 命中、cwd+容器名命中、或端口命中且 id 相近 */
function hitRegistered(projects: ProjectRecord[], id: string, ports: number[], container?: string): boolean {
  return projects.some((p) => {
    if (p.id === id) return true;
    const dc = p.probe?.docker;
    if (container) {
      // compose 里 service 叫 redis，实际容器名可能是 yanyun-redis / buildingai-redis（带前缀），
      // 数据库甚至叫 yanyun-pg。只比全等会把已经登记过的节点又报成「没登记」，诱导重复登记。
      // 所以拿「容器名 / compose service / id / 名称 / 停止命令」一起做包含匹配。
      const known = [dc?.container, dc?.composeService, p.id, p.name, p.stopCommand]
        .filter(Boolean).join(' ').toLowerCase();
      if (known.includes(container.toLowerCase())) return true;
    }
    const ps = p.probe?.ports || [];
    return ports.length > 0 && ports.some((q) => ps.includes(q)) && (p.id.includes(id) || id.includes(p.id));
  });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
}

export function discoverProject(dataDir: string, cwd: string, id?: string): DiscoverResult {
  const warnings: string[] = [];
  const scanned: string[] = [];
  const suggestions: SuggestNode[] = [];
  const projects = readProjects(dataDir).projects;

  if (!cwd || !path.isAbsolute(cwd)) {
    return { cwd: cwd || '', suggestions: [], missing: 0, scanned, warnings: ['cwd 必须是绝对路径'] };
  }
  if (!fs.existsSync(cwd)) {
    return { cwd, suggestions: [], missing: 0, scanned, warnings: [`目录不存在：${cwd}`] };
  }

  const projectId = id ? slug(id) : slug(path.basename(cwd));
  const envText = ['.env', '.env.local', '.env.example'].map((f) => readText(path.join(cwd, f))).join('\n');
  const envPorts = parseEnvPorts(envText);
  if (envText) scanned.push('.env');

  // 1) compose services
  for (const file of COMPOSE_FILES) {
    const full = path.join(cwd, file);
    if (!exists(full)) continue;
    scanned.push(file);
    const services = parseComposeServices(readText(full));
    const projectName = (readText(full).match(/^name:\s*["']?([\w.-]+)/m)?.[1]) || undefined;
    for (const s of services) {
      const nodeId = slug(`${projectId}-${s.name}`);
      const ports = s.ports.length ? s.ports : envPorts.filter((e) => e.key.includes(s.name.toUpperCase())).map((e) => e.port);
      const registered = hitRegistered(projects, nodeId, ports, s.name);
      const isData = /postgres|mysql|maria|mongo|redis|rabbit|kafka|minio|pgvector|(^|-)(db|database)(-|$)/i.test(`${s.name} ${s.image}`);
      suggestions.push({
        id: nodeId,
        name: `${s.name}${s.image ? `（${s.image.split('/').pop()}）` : ''}`,
        kind: 'compose',
        cwd,
        commands: [{ cmd: `docker compose -f ${file} up -d ${s.name}`, kind: 'setup', timeoutMs: 180000 }],
        stopCommand: `docker compose -f ${file} stop ${s.name}`,
        probe: { ports, docker: { composeService: s.name, projectName } },
        // 默认按「本项目独占」处理，关闭时连带停；多个项目共用同一个库时请手动改成 keep
        shared: false,
        stopPolicy: 'cascade',
        notes: `由 ${file} 的 ${s.name} 服务推断；端口 ${ports.join(',') || '未声明'}。确认归属后登记，关闭时才能按容器粒度停。`
          + (isData ? ' 数据库/缓存类：若被其他项目共用，请改为「共享依赖」以免连带停掉。' : ''),
        registered,
        evidence: [`${file} → services.${s.name}`, s.image ? `image: ${s.image}` : '', ports.length ? `ports: ${ports.join(',')}` : ''].filter(Boolean),
      });
    }
  }

  // 2) .env 里声明了端口、但既不是本项目端口也不是已登记节点的端口 → 大概率是外部依赖
  if (envPorts.length) {
    const known = new Set<number>();
    for (const p of projects) (p.probe?.ports || []).forEach((q) => known.add(q));
    const base = projects.find((p) => p.id === projectId);
    (base?.probe?.ports || []).forEach((q) => known.add(q));
    const dock = dockerContainers();
    const ALIAS: Record<string, string[]> = {
      db: ['postgres', 'pg', 'mysql', 'maria', 'mongo'],
      database: ['postgres', 'pg', 'mysql', 'maria', 'mongo'],
      cache: ['redis', 'memcached'],
    };
    for (const e of envPorts) {
      if (known.has(e.port)) continue;
      const keyBase = e.key.toLowerCase().replace(/_external$/, '').replace(/_port$/, '');
      const words = [keyBase, ...(ALIAS[keyBase] || [])];
      // 撞上本机容器（按容器名/service 名猜）→ 强烈提示这是容器依赖
      const hit = dock.available
        ? dock.list.find((c) => {
          const hay = `${c.name} ${c.service}`.toLowerCase();
          return words.some((w) => w.length > 1 && hay.includes(w));
        })
        : undefined;
      const nodeId = slug(`${projectId}-${keyBase}`);
      const ports = [e.port];
      const registered = hitRegistered(projects, nodeId, ports);
      if (!hit) {
        // 推断不出启动方式就不给假建议，交给人工确认
        if (!registered) warnings.push(`.env 里 ${e.key}=${e.port} 有端口，但没找到对应容器，无法推断启动/停止命令，请手工登记该依赖`);
        continue;
      }
      suggestions.push({
        id: nodeId,
        name: `${hit.name}（端口 ${e.port}）`,
        // docker run 起的容器没有 compose 归属，只能按容器名启停
        kind: 'docker',
        cwd,
        commands: [{ cmd: `docker start ${hit.name}`, kind: 'setup', timeoutMs: 120000 }],
        stopCommand: `docker stop ${hit.name}`,
        probe: { ports, docker: { container: hit.name } },
        shared: false,
        stopPolicy: 'cascade',
        notes: `.env 里 ${e.key}=${e.port}，对应本机容器 ${hit.name}。若该容器被多个项目共用，请改为「共享依赖」。`,
        registered,
        evidence: [`.env → ${e.key}=${e.port}`, `本机容器 ${hit.name}（${hit.state}）`],
      });
    }
  }

  // 3) package.json 脚本 → 只是提示，不单独成一个节点
  const pkgFile = path.join(cwd, 'package.json');
  if (exists(pkgFile)) {
    scanned.push('package.json');
    const scripts = parsePackageScripts(readText(pkgFile));
    const runner = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn' : 'npm';
    const entry = scripts.start ? `${runner} start` : scripts.dev ? `${runner} dev` : '';
    const existing = projects.find((p) => p.id === projectId);
    suggestions.unshift({
      id: projectId,
      name: id || path.basename(cwd),
      kind: 'process',
      cwd,
      commands: entry
        ? [{ cmd: entry, kind: 'service' }]
        : [{ cmd: `${runner} run dev`, kind: 'service' }],
      // 主项目端口猜不出来，不瞎填：留空让人补，否则会把「端口通」误判成「项目在跑」
      probe: { ports: existing?.probe?.ports || [] },
      shared: false,
      stopPolicy: 'cascade',
      notes: `主项目节点，启动入口按 package.json 推断为「${entry || `${runner} run dev`}」。探测端口需人工确认。`,
      registered: !!existing,
      evidence: [`package.json → scripts.${scripts.start ? 'start' : scripts.dev ? 'dev' : '默认'}`],
    });
    if (!entry) warnings.push('package.json 里没有 start/dev 脚本，启动命令需要人工确认');
  }

  // 4) ecosystem.config.js（pm2）
  const eco = path.join(cwd, 'ecosystem.config.js');
  if (exists(eco)) {
    scanned.push('ecosystem.config.js');
    const t = readText(eco);
    const names = [...t.matchAll(/name:\s*["']([^"']+)["']/g)].map((m) => m[1]);
    if (names.length) warnings.push(`检测到 pm2 应用：${names.join('、')}；停止命令建议用 pnpm stop / pm2 stop <app>`);
  }

  // 主项目节点自动挂依赖：批量登记后即形成「关主项目 → 连带停容器」的图
  const main = suggestions.find((s) => s.id === projectId);
  const depIds = suggestions.filter((s) => s !== main && s.kind !== 'process').map((s) => s.id);
  if (main && depIds.length) {
    main.dependsOn = [...new Set([...(main.dependsOn || []), ...depIds])];
    main.stopPolicy = 'cascade';
    main.notes += ` 依赖 ${depIds.join('、')}：关闭本项目会连带停它们（共享依赖请单独改成 keep）。`;
  }

  const missing = suggestions.filter((s) => !s.registered).length;
  if (!suggestions.length) warnings.push('没有扫描到可推断的启动信息，需要手工填写');
  return { cwd, suggestions, missing, scanned, warnings };
}
