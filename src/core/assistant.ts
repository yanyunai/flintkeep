// 资产管家：应用内口语指令智能体。口语 → Vercel AI SDK 工具调用 → 保险库操作。
// 设计边界：模型上下文永不接触秘密明文（写库可以，读出一律脱敏）；删除两段确认；
// 会话/记忆/模型配置全部存保险库加密集合，随整库加密与每日备份。
import { generateText, streamText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import * as net from 'net';
import { Vault } from './vault';
import { TYPE_LABELS, AssetType, resolveSshKeyId, resolveServerHost, suggestLinkRole, stripSecrets } from './schema';
import { normalizeAssetType } from './mcp-meta';
import { readProjects } from './project-store';
import { projectTree } from './project-registrar';
import { getCachedStatuses, probeOnce } from './project-probe';
import { startProject, stopProject, planStop } from './project-runner';
import { discoverProject } from './project-discovery';

export interface AiConf {
  base: string;
  model: string;
  key: string;
  name?: string;
}

type AnyRec = Record<string, any>;

const TYPE_HINT = Object.values(TYPE_LABELS).join(' / ');

function conf(v: Vault): AiConf | null {
  const c = v.getCollection('ai_conf');
  if (!c || !c.base || !c.model) return null;
  return c as AiConf;
}

export function getConf(v: Vault): AnyRec {
  const c = conf(v);
  return { base: c?.base || '', model: c?.model || '', name: c?.name || '自定义', hasKey: !!c?.key };
}

/** 返回是否因「换服务商但没给新 Key」而清空了旧 Key */
export function setConf(v: Vault, c: Partial<AiConf>): boolean {
  const cur = conf(v) || { base: '', model: '', key: '', name: '自定义' };
  const nextBase = c.base ?? cur.base;
  const hasNewKey = c.key !== undefined && c.key !== null && String(c.key).trim() !== '';
  // 换服务商时不能把 A 厂商的 Key 发给 B 的地址：没带新 Key 就清空，由界面提示重填
  const keyCleared = !!cur.key && nextBase !== cur.base && !hasNewKey;
  v.setCollection('ai_conf', {
    base: nextBase,
    model: c.model ?? cur.model,
    key: keyCleared ? '' : (c.key ?? cur.key),
    name: c.name ?? cur.name,
  });
  return keyCleared;
}

function modelOf(c: AiConf) {
  const provider = createOpenAICompatible({ name: c.name || 'conf', baseURL: c.base, apiKey: c.key || 'none' });
  return provider.chatModel(c.model);
}

/** 口语查询定位资产：id → 序号 → 名称全等 → 名称包含 */
function resolveQ(v: Vault, q: string, type?: AssetType): any {
  const s = String(q || '').trim();
  if (!s) return undefined;
  const all = v.list(type);
  const byId = all.find((a) => a.id === s);
  if (byId) return byId;
  const byNo = all.find((a) => String(a.no) === s.replace(/^#/, ''));
  if (byNo) return byNo;
  const exact = all.find((a) => a.name === s);
  if (exact) return exact;
  const loose = all.find((a) => a.name.includes(s) || s.includes(a.name));
  return loose;
}

function probeTcp(v: Vault, query: string): Promise<AnyRec> {
  const a = resolveQ(v, query, 'server');
  if (!a) return Promise.resolve({ ok: false, error: '找不到该服务器资产' });
  const full = v.peek(a.id);
  if (!full || full.type !== 'server') return Promise.resolve({ ok: false, error: '仅支持服务器类型' });
  const keyId = resolveSshKeyId(full);
  const key = keyId ? v.peek(keyId) : undefined;
  const host = String(key?.sshHost || resolveServerHost(full) || '').trim();
  const port = Number(key?.sshPort || full.sshPort || (full.openPorts || [])[0] || 22) || 22;
  if (!host) return Promise.resolve({ ok: false, error: '该资产未配置地址' });
  const t0 = Date.now();
  return new Promise<AnyRec>((resolve) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, host, port, ms: Date.now() - t0, error: '超时（3 秒无响应）' }); }, 3000);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve({ ok: true, host, port, ms: Date.now() - t0 }); });
    sock.once('error', (e: Error) => { clearTimeout(timer); resolve({ ok: false, host, port, ms: Date.now() - t0, error: e.message }); });
  });
}

/** 待确认删除：10 分钟有效且绑定发起会话，防止过期或跨会话误确认 */
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingDeletes = new Map<string, { id: string; name: string; ts: number; sessionId: string }>();
function newCid(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 会话存取（collections 'ai_sessions'）
export function listSessions(v: Vault): any[] {
  return ((v.getCollection('ai_sessions') || []) as any[]).map((s) => ({
    id: s.id, title: s.title, ts: s.ts, count: (s.msgs || []).length,
  }));
}
function loadSession(v: Vault, sessionId: string): AnyRec {
  const list = (v.getCollection('ai_sessions') || []) as any[];
  return list.find((s) => s.id === sessionId) || { id: sessionId, title: '', ts: '', msgs: [] };
}
function saveSession(v: Vault, sessionId: string, title: string, msgs: any[]): void {
  const list = (v.getCollection('ai_sessions') || []) as any[];
  const i = list.findIndex((s) => s.id === sessionId);
  const rec = { id: sessionId, title: title || '新会话', ts: new Date().toISOString(), msgs: msgs.slice(-40) };
  if (i >= 0) list[i] = rec;
  else list.unshift(rec);
  v.setCollection('ai_sessions', list.slice(0, 30));
}

const SYSTEM = [
  '你是「资产管家」——燧垒软件里管理资产数据的智能体。',
  '用户用口语下指令，你把它转成正确的工具调用，数据全部存入本机加密保险库。',
  '规则：',
  '- 不确定目标资产时，先 search_assets 查，再操作；不要凭空猜名称。',
  '- 新增/修改/查询/关联/记忆：直接执行，然后用一句简短中文汇报结果（带资产序号，如 服务器#5）。',
  '- 删除类操作必须调用 delete_asset 工具：它会返回 needsConfirm，你要把 summary 转告用户并请他点「确认删除」按钮；用户没确认前不要假装已删除。',
  '- 密码/私钥/Key 等可以写入资产，但回复里不要复述秘密明文。',
  '- 查询类问题直接用数据回答；没有的数据就说没有。',
  '- 除了资产，本软件还有一个「运行工作台」：登记本机项目的启动方式、依赖（容器/数据库）与启停状态。用户问「某项目怎么启动的、有哪些依赖、什么端口、把它跑起来/关掉」时，用 list_projects / get_project / start_project / stop_project / discover_project；这些是本机进程操作，不是资产数据，别去 add_asset。',
  '- 关闭项目要区分语义：只停主程序（only=self）、只关依赖（only=deps）、连带独占依赖一起停（only=all，默认）。共享依赖不会停，如实说明保留了哪些。',
  '- 回复始终简体中文，简短直接，不客套。',
].join('\n');

/** 流式输出的事件负载（server.ts 会包成 SSE 的 data 帧） */
export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'card'; card: any }
  | { type: 'done'; reply: string }
  | { type: 'error'; message: string };

/**
 * 对话主链路：不传 stream 时走 generateText 整段返回（兼容旧接口）；
 * 传 stream 时走 streamText，逐块推送文本与工具卡，结束后照常写回会话与审计。
 */
export async function assistantChat(
  v: Vault, sessionId: string, text: string,
  stream?: { emit: (e: ChatStreamEvent) => void; signal?: AbortSignal },
): Promise<{ reply: string; cards: any[] }> {
  const c = conf(v);
  if (!c) throw new Error('未配置模型接口：先在右上角选择模型并填写 API Key');
  const sess = loadSession(v, sessionId);
  const msgs: any[] = (sess.msgs || []).slice(-20);

  const tools = {
    add_asset: tool({
      description: `新增任意类型的资产。type 用中文类型名或别名（${TYPE_HINT}）。fields 里放该资产的具体字段（如 content、username、secret、publicIp、sshPort、loginUrl、note 等）。`,
      inputSchema: z.object({
        type: z.string().describe('中文类型名或别名，如：服务器'),
        name: z.string().describe('资产名称'),
        fields: z.string().describe('具体字段，JSON 对象字符串，如 {"publicIp":"1.2.3.4","content":"..."}；没有就传 "{}"').optional(),
        linkTo: z.string().describe('要关联到的目标资产名称或序号').optional(),
        linkRole: z.string().describe('关联角色，缺省自动推断').optional(),
      }),
      execute: async ({ type, name, fields, linkTo, linkRole }) => {
        const t = normalizeAssetType(type) as AssetType | null;
        if (!t) return { ok: false, error: `未知资产类型「${type}」`, hint: '可用类型：' + TYPE_HINT };
        let data: any = {};
        try { data = fields ? JSON.parse(fields) : {}; } catch { return { ok: false, error: 'fields 不是合法 JSON' }; }
        for (const sk of ['sshPort', 'baotaPort']) if (data[sk] != null) data[sk] = Number(data[sk]);
        const asset = v.add({ type: t, name, tags: [], ...data });
        let linked = '';
        if (linkTo) {
          const target = resolveQ(v, linkTo);
          if (target) {
            const role = linkRole || suggestLinkRole(t);
            v.update(target.id, { links: [...(target.links || []), { id: asset.id, role }] });
            linked = `，已关联「${target.name}」`;
          }
        }
        return { ok: true, summary: `已新增 ${TYPE_LABELS[t]}「${name}」（#${asset.no}）${linked}`, id: asset.id, no: asset.no };
      },
    }),
    update_asset: tool({
      description: '修改已有资产的字段。query 用资产名称/序号；data 放要改的字段。',
      inputSchema: z.object({
        query: z.string(),
        data: z.string().describe('要修改的字段，JSON 对象字符串'),
      }),
      execute: async ({ query, data }) => {
        const a = resolveQ(v, query);
        if (!a) return { ok: false, error: `找不到资产「${query}」` };
        let d: any = {};
        try { d = data ? JSON.parse(data) : {}; } catch { return { ok: false, error: 'data 不是合法 JSON' }; }
        for (const sk of ['sshPort', 'baotaPort']) if (d[sk] != null) d[sk] = Number(d[sk]);
        v.update(a.id, d);
        return { ok: true, summary: `已修改 ${(TYPE_LABELS as Record<string,string>)[a.type]}「${a.name}」(#${a.no})` };
      },
    }),
    delete_asset: tool({
      description: '删除资产（需要用户确认：工具会返回 needsConfirm=true 和 cid，把 summary 转告用户并请他点「确认删除」按钮）。',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const a = resolveQ(v, query);
        if (!a) return { ok: false, error: `找不到资产「${query}」` };
        const cid = newCid();
        pendingDeletes.set(cid, { id: a.id, name: a.name, ts: Date.now(), sessionId });
        if (pendingDeletes.size > 50) {
          const first = pendingDeletes.keys().next().value;
          if (first) pendingDeletes.delete(first);
        }
        return { needsConfirm: true, cid, summary: `将删除 ${(TYPE_LABELS as Record<string,string>)[a.type]}「${a.name}」(#${a.no})，删除后可在审计日志恢复` };
      },
    }),
    search_assets: tool({
      description: '搜索资产列表（不含秘密明文）。q 关键词可空；type 中文类型名或别名可空。',
      inputSchema: z.object({ q: z.string().optional(), type: z.string().optional() }),
      execute: async ({ q, type }) => {
        const t = type ? (normalizeAssetType(type) as AssetType | null) : undefined;
        if (type && !t) return { count: 0, items: [], summary: `未知资产类型「${type}」，可用：${TYPE_HINT}` };
        let list = v.list(t || undefined);
        if (q) list = list.filter((a) => JSON.stringify(stripSecrets(a)).toLowerCase().includes(q.toLowerCase()));
        const items = list.slice(0, 10).map((a) => ({ name: a.name, type: (TYPE_LABELS as Record<string,string>)[a.type], no: a.no, ip: a.publicIp || a.ip || '', username: a.username || '' }));
        const summary = list.length
          ? `找到 ${list.length} 条${list.length > items.length ? `（显示前 ${items.length} 条）` : ''}：` + items.slice(0, 3).map((i) => `${i.name}(#${i.no})`).join('、')
          : '没有匹配的资产';
        return { count: list.length, items, summary };
      },
    }),
    get_asset: tool({
      description: '查询单个资产详情（秘密字段已打码）。',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const a = resolveQ(v, query);
        if (!a) return { ok: false, error: `找不到资产「${query}」` };
        const full = v.peek(a.id);
        const masked = stripSecrets(full as any);
        if (masked.content && String(masked.content).length > 300) masked.content = String(masked.content).slice(0, 300) + '…';
        // 卡片摘要只放元数据，不带 note/content，避免把用户记在备注里的秘密显示出来
        const m: any = masked;
        const parts = [
          `${(TYPE_LABELS as Record<string,string>)[m.type] || m.type}「${m.name}」(#${m.no})`,
          m.publicIp || m.ip ? `IP ${m.publicIp || m.ip}` : '',
          m.username ? `登录名 ${m.username}` : '',
          m.loginUrl ? `地址 ${m.loginUrl}` : '',
          m.tags?.length ? `标签 ${m.tags.join('/')}` : '',
        ].filter(Boolean);
        return { ...masked, summary: parts.join(' · ') };
      },
    }),
    link_assets: tool({
      description: '在两个资产之间建立关联（如 服务器↔SSH 登录、项目↔平台账号）。role 可省略（自动推断）。',
      inputSchema: z.object({ a: z.string(), b: z.string(), role: z.string().optional() }),
      execute: async ({ a: qa, b: qb, role }) => {
        const a = resolveQ(v, qa);
        const b = resolveQ(v, qb);
        if (!a || !b) return { ok: false, error: '找不到其中一个资产' };
        const r = role || suggestLinkRole(b.type);
        v.update(a.id, { links: [...(a.links || []), { id: b.id, role: r }] });
        return { ok: true, summary: `已建立关联：「${a.name}」→「${b.name}」（${r}）` };
      },
    }),
    remember: tool({
      description: '把用户偏好/事实写入长期记忆（跨会话有效）。',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const mem = (v.getCollection('ai_memory') || []) as any[];
        mem.unshift({ text, ts: new Date().toISOString() });
        v.setCollection('ai_memory', mem.slice(0, 200));
        return { ok: true, summary: '已记住' };
      },
    }),
    recall: tool({
      description: '按关键词检索长期记忆。',
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => {
        const mem = (v.getCollection('ai_memory') || []) as any[];
        const hits = mem.filter((m) => m.text.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
        const items = hits.map((m) => m.text);
        const summary = hits.length ? `想起 ${hits.length} 条：` + items.slice(0, 3).join('；') : '没有相关记忆';
        return { count: hits.length, items, summary };
      },
    }),
    probe_server: tool({
      description: 'TCP 探测服务器连通性（真实连接测试）。',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const r = await probeTcp(v, query);
        return { ...r, summary: r.ok ? `${r.host}:${r.port} 连通（${r.ms}ms）` : `不可达：${r.error}` };
      },
    }),

    /* ---------- 运行工作台：本机项目的启停与依赖 ---------- */
    list_projects: tool({
      description: '列出「运行工作台」登记的所有本地项目：主项目 + 挂在它下面的依赖（容器/数据库），含运行状态、端口、依赖 id。用户问「我有哪些项目 / 哪个在跑 / 某项目依赖什么」时先用它。',
      inputSchema: z.object({}),
      execute: async () => {
        const st = await probeOnce(v.dir).catch(() => getCachedStatuses());
        const tree = projectTree(v.dir);
        return {
          total: tree.length,
          projects: tree.map(({ project: p, children }) => ({
            id: p.id, name: p.name, kind: p.kind || 'process', cwd: p.cwd,
            status: st[p.id]?.status || 'stopped',
            ports: p.probe?.ports || [],
            dependsOn: p.dependsOn || [],
            children: children.map((c) => ({
              id: c.id, name: c.name, kind: c.kind || 'process',
              status: st[c.id]?.status || 'stopped', ports: c.probe?.ports || [], shared: !!c.shared,
            })),
          })),
          summary: tree.length ? `共 ${tree.length} 个主项目` : '还没有登记任何本地项目',
        };
      },
    }),
    get_project: tool({
      description: '查一个本地项目的完整信息：启动命令（按顺序执行、最后一条常驻）、停止命令、类型（process/compose/docker）、端口、访问地址、依赖（子节点与 dependsOn）、停止策略、当前状态。用户问「这个项目怎么启动的 / 有哪些依赖 / 端口是多少」时用它。',
      inputSchema: z.object({ id: z.string().describe('项目 id（或名称）') }),
      execute: async ({ id }) => {
        const all = readProjects(v.dir).projects;
        const p = all.find((x) => x.id === id) || all.find((x) => x.name === id);
        if (!p) return { error: `没有登记叫「${id}」的项目`, hint: '先调 list_projects 拿准确 id' };
        const st = await probeOnce(v.dir).catch(() => getCachedStatuses());
        return {
          id: p.id, name: p.name, kind: p.kind || 'process', cwd: p.cwd,
          commands: (p.commands || []).map((c) => ({ cmd: c.cmd, kind: c.kind || 'setup' })),
          stopCommand: p.stopCommand || null,
          stopPolicy: p.stopPolicy || 'cascade', shared: !!p.shared,
          ports: p.probe?.ports || [], url: p.probe?.url || null, healthUrl: p.probe?.healthUrl || null,
          parent: p.parent || null, dependsOn: p.dependsOn || [],
          children: all.filter((c) => c.parent === p.id).map((c) => ({ id: c.id, name: c.name, kind: c.kind || 'process' })),
          docker: p.probe?.docker || null,
          status: st[p.id]?.status || 'stopped',
          notes: p.notes || null,
        };
      },
    }),
    start_project: tool({
      description: '启动一个本地项目：按依赖拓扑序先起依赖（容器/数据库），再起主程序并等到端口就绪。用户说「把 X 跑起来」时用。',
      inputSchema: z.object({ id: z.string().describe('项目 id') }),
      execute: async ({ id }) => {
        const r = await startProject(v.dir, id);
        return { ...r, summary: r.ok ? `「${id}」已启动` : `启动失败：${r.message || '未知原因'}` };
      },
    }),
    stop_project: tool({
      description: '关闭一个本地项目。only=all（默认）关自己 + 独占依赖，共享依赖（shared/keep）会保留；only=self 只停主程序、依赖不动；only=deps 只关依赖、主程序留着。返回将停清单与保留原因。',
      inputSchema: z.object({
        id: z.string().describe('项目 id'),
        only: z.enum(['all', 'self', 'deps']).optional().describe('all=自己+依赖；self=只停自己；deps=只关依赖'),
      }),
      execute: async ({ id, only }) => {
        const mode = only || 'all';
        const opts = { cascade: mode !== 'self', only: (mode === 'deps' ? 'deps' : 'all') as 'deps' | 'all' };
        const planned = await planStop(v.dir, id, opts);
        if ('error' in planned) return { error: planned.error };
        const r = await stopProject(v.dir, id, opts);
        const stopped = planned.targets.map((t) => t.name);
        return {
          ok: r.ok,
          message: r.message,
          stopped,
          kept: planned.survivors.map((s) => `${s.name}（${s.reason}）`),
          residual: r.residual || [],
          summary: r.ok ? `已关闭：${stopped.join('、') || '（无节点）'}` : (r.message || '关闭失败'),
        };
      },
    }),
    discover_project: tool({
      description: '体检：扫描项目目录（docker-compose services、.env 端口、package.json 脚本），列出「跟它有关但还没登记」的依赖节点（数据库/Redis/容器）。只读，登记要用 MCP 的 project_upsert。',
      inputSchema: z.object({ id: z.string().describe('项目 id') }),
      execute: async ({ id }) => {
        const p = readProjects(v.dir).projects.find((x) => x.id === id);
        if (!p) return { error: `没有登记叫「${id}」的项目` };
        const d = discoverProject(v.dir, p.cwd, p.id);
        return { ...d, summary: `发现 ${d.missing} 个疑似未登记的依赖节点` };
      },
    }),
  };

  const common = {
    model: modelOf(c),
    system: SYSTEM,
    messages: [...msgs, { role: 'user' as const, content: text }],
    tools,
    stopWhen: stepCountIs(6),
    maxRetries: 2,
  };
  const cards: any[] = [];
  let reply = '';
  const persist = (final: string) => {
    const hist = [...msgs, { role: 'user', content: text }, { role: 'assistant', content: final }];
    saveSession(v, sessionId, (sess.title || text.slice(0, 18)), hist);
    v.auditExternal('assistant_chat', { sessionId, text: String(text).slice(0, 80) });
  };

  if (stream) {
    // 用户点「停止」与 2 分钟超时共用一个中断信号
    const timeout = AbortSignal.timeout(120_000);
    const signal = stream.signal ? AbortSignal.any([stream.signal, timeout]) : timeout;
    const result = streamText({ ...common, abortSignal: signal });
    try {
      for await (const part of result.stream) {
        const p = part as any;
        if (p.type === 'text-delta') {
          reply += p.text || '';
          stream.emit({ type: 'delta', text: p.text || '' });
        } else if (p.type === 'tool-result') {
          const card = { tool: p.toolName, args: p.input, result: p.output };
          cards.push(card);
          stream.emit({ type: 'card', card });
        } else if (p.type === 'error') {
          stream.emit({ type: 'error', message: String(p.error?.message || p.error || '模型调用出错') });
        }
      }
    } catch (e) {
      // 中断或异常时把已生成的部分写回，避免用户消息和半截回复一起丢失
      if (reply.trim()) persist(reply + (stream.signal?.aborted ? '\n（已中断）' : ''));
      throw e;
    }
    reply = reply || '（已完成）';
    persist(reply);
    stream.emit({ type: 'done', reply });
  } else {
    const result = await generateText({ ...common, abortSignal: AbortSignal.timeout(120_000) });
    for (const st of (result.steps || []) as any[]) {
      for (const tr of st.toolResults || []) {
        cards.push({ tool: tr.toolName, args: tr.args, result: tr.result });
      }
    }
    reply = result.text || '（已完成）';
    persist(reply);
  }
  return { reply, cards };
}

/** 应用/丢弃待确认的删除 */
export function confirmDelete(v: Vault, cid: string, approve: boolean, sessionId?: string): any {
  const op = pendingDeletes.get(cid);
  if (!op) throw new Error('确认已过期或不存在，请重新发起删除');
  pendingDeletes.delete(cid); // 一次性：过期/跨会话的 cid 直接作废，防止重放
  if (Date.now() - op.ts > CONFIRM_TTL_MS) throw new Error('确认已超过 10 分钟，请重新发起删除');
  if (sessionId && op.sessionId !== sessionId) throw new Error('该确认来自其它会话，请重新发起删除');
  if (!approve) return { ok: true, dropped: true };
  const a = v.peek(op.id);
  const ok = v.remove(op.id);
  return { ok, name: a?.name || op.name };
}
