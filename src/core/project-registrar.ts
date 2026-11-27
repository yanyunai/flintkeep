/**
 * 项目登记编排：Agent 只写一条主项目，程序自己把依赖拆成子节点。
 *
 * 解决的问题：以前让 Agent 自己决定「拆几个节点、id 叫什么、依赖怎么连」，
 * 同一个项目两次能写出不同形状（这次 3 条、下次 1 条），卡片数量飘忽不定。
 * 现在统一由程序推断，Agent 只描述「这个项目在哪、怎么起、占哪个端口」。
 *
 * 派生策略保守：
 * - `.env` 端口命中本机容器 → 强证据，直接收（kind=docker）
 * - compose service 且镜像像数据库/中间件 → 收（kind=compose）
 * - 其余一律不写，只在 skipped 里说明，交给人决定
 */
import {
  upsertProject, readProjects, childrenOf,
  type ProjectRecord, type UpsertResult,
} from './project-store';
import { discoverProject, type SuggestNode } from './project-discovery';

/** 数据库/中间件类镜像：只有这类才自动拆成依赖节点，避免把普通 sidecar 也收进来 */
const DATA_LIKE = /postgres|pgvector|mysql|maria|mongo|redis|rabbit|kafka|minio|memcached|elastic|milvus|qdrant|clickhouse|zookeeper/i;

export interface RegisterResult extends UpsertResult {
  /** 本次顺带登记的子节点 */
  derived: { id: string; name: string; kind: string; ports: number[] }[];
  /** 扫到但没自动登记（需要人决定） */
  skipped: { name: string; reason: string }[];
  /** 已挂在该项目下的子节点（含此前就有的） */
  children: { id: string; name: string; kind: string }[];
}

function shouldAutoAdopt(s: SuggestNode): { ok: boolean; reason?: string } {
  if (s.kind === 'process') return { ok: false, reason: '看起来是主程序本身，不重复登记' };
  // .env 端口 + 本机容器命中，已经是强证据
  if (s.kind === 'docker') return { ok: true };
  if (s.kind === 'compose') {
    if (!(s.probe.ports || []).length) return { ok: false, reason: 'compose 里没声明宿主机端口，无法判活，需要手工确认' };
    if (!DATA_LIKE.test(`${s.name} ${s.id}`)) return { ok: false, reason: '不是数据库/中间件类服务，需要手工确认是否属于本项目' };
    return { ok: true };
  }
  return { ok: false, reason: '类型未知' };
}

export function registerProject(
  dataDir: string,
  input: Record<string, any>,
  opts: { autoDiscover?: boolean } = {},
): RegisterResult {
  const base = upsertProject(dataDir, input);
  if (!base.ok || !base.project) {
    return { ...base, derived: [], skipped: [], children: [] };
  }
  const project = base.project;

  const derived: RegisterResult['derived'] = [];
  const skipped: RegisterResult['skipped'] = [];

  // 只有「新增 / 明确要求」时才自动拆：编辑时不偷偷加节点
  const explicitDeps = (input.dependsOn || []).length > 0 || Array.isArray(input.nodes);
  const auto = opts.autoDiscover !== false && !explicitDeps;

  if (auto) {
    const scan = discoverProject(dataDir, project.cwd, project.id);
    for (const s of scan.suggestions) {
      if (s.id === project.id || s.registered) continue;
      const verdict = shouldAutoAdopt(s);
      if (!verdict.ok) {
        skipped.push({ name: s.name, reason: verdict.reason || '未通过自动判定' });
        continue;
      }
      // 子节点：挂 parent，不再重复写 dependsOn；cwd 继承主项目
      const r = upsertProject(dataDir, {
        ...s,
        id: s.id,
        parent: project.id,
        cwd: project.cwd,
        dependsOn: [],
        shared: false,
        stopPolicy: 'cascade',
      });
      if (r.ok) derived.push({ id: r.project!.id, name: r.project!.name, kind: r.project!.kind || 'process', ports: r.project!.probe?.ports || [] });
      else skipped.push({ name: s.name, reason: `写入失败：${r.errors.join('；')}` });
    }
    for (const w of scan.warnings) skipped.push({ name: '（扫描提示）', reason: w });
  }

  const all = readProjects(dataDir).projects;
  return {
    ...base,
    derived,
    skipped,
    children: childrenOf(all, project.id).map((c) => ({ id: c.id, name: c.name, kind: c.kind || 'process' })),
  };
}

/** 一次登记多个节点（批量/体检勾选）：被依赖的先写，自动多轮重试 */
export function registerBatch(
  dataDir: string,
  inputs: Record<string, any>[],
): { id: string; ok: boolean; errors?: string[]; warnings?: string[] }[] {
  const results: { id: string; ok: boolean; errors?: string[]; warnings?: string[] }[] = [];
  let pending = inputs.slice();
  for (let round = 0; round < 4 && pending.length; round++) {
    const retry: Record<string, any>[] = [];
    for (const item of pending) {
      const r = upsertProject(dataDir, item);
      if (r.ok) results.push({ id: item?.id, ok: true, warnings: r.warnings });
      else if (round < 3 && r.errors.some((e) => e.includes('不存在'))) retry.push(item);
      else results.push({ id: item?.id, ok: false, errors: r.errors });
    }
    if (retry.length === pending.length) {
      retry.forEach((item) => results.push({ id: item?.id, ok: false, errors: ['依赖/parent 不存在（多轮重试后仍失败）'] }));
      break;
    }
    pending = retry;
  }
  return results;
}

/** 按 parent 分组：主项目 → 子节点，供页面/托盘折叠展示 */
export function projectTree(dataDir: string): { project: ProjectRecord; children: ProjectRecord[] }[] {
  const all = readProjects(dataDir).projects;
  const ids = new Set(all.map((p) => p.id));
  return all
    .filter((p) => !p.parent || !ids.has(p.parent)) // 只把「没有父节点」的当卡片
    .map((p) => ({ project: p, children: all.filter((c) => c.parent === p.id) }));
}
