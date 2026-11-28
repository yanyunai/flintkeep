import * as fs from 'fs';
import * as readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';
import { Vault, NeedSecretKeyError } from './vault';
import { AssetType, fieldKindLabel, fieldNameLabel, SECRET_FIELDS } from './schema';
import { TOOL_SPECS, TOOL_SPECS_V2, V2_TOOL_NAMES, MCP_INSTRUCTIONS, normalizeAssetType } from './mcp-meta';
import { resolveProxyBaseUrl, buildProxyInjection } from './proxy';
import { AssetTypeStore } from './asset-types';
import { FieldSchemaStore } from './field-schema';
import { BUILTIN_FIELDS } from './builtin-fields';
import { hasKey, t as tr } from '../shared/i18n';
import { WhitelistStore, runAll } from './whitelist';
import { AiUsageStore } from './ai-usage';
import { detectPublicIp } from './ipdetect';
import { SettingsStore, DEFAULT_SETTINGS, normalizeAgentPermission, type AgentPermission } from './settings';
import { lockedBlockReason } from './lock-state';
import { findAssetTarget } from './access-token';
import { resolveDataDir } from './data-dir';
import { resolveSecretKeySource } from './secret-key';
import { readProjects, childrenOf } from './project-store';
import { registerProject } from './project-registrar';
import { probeOnce } from './project-probe';
import { startProject, stopProject, planStop } from './project-runner';
import { discoverProject } from './project-discovery';

/**
 * 极简 MCP stdio 服务（不依赖第三方 SDK）：
 * 实现 JSON-RPC 2.0 的 initialize / tools/list / tools/call。
 * 任意支持 MCP 的 Agent / 客户端通过 stdio 接入后，
 * 可用自然语言让你“连生产服务器看看 Nginx 日志”，Agent 调工具取凭证，全程审计。
 */

// MCP 是给 Agent 宿主（任意支持 MCP 的客户端）调用的 stdio 服务，无法交互式输入口令，
// 因此从环境变量 VAULT_PASSPHRASE（兼容旧名 VAULT_MASTER_KEY）读取口令：
// - 首次运行：用该口令创建 keystore（salt + verifier）
// - 之后运行：用同一口令解锁；口令错误直接退出
// 桌面端（Electron + Vue）通过 REST 的 /api/unlock 传入用户口令，不依赖此环境变量。
let vault: Vault;
/**
 * 令牌模式：用 FK_TOKEN / VAULT_TOKEN 启动时，不加载整库，只经本地 REST
 * 取脱敏元数据与短期凭据。此时 vault 未初始化，任何整库操作在 handleCall 入口就被拦下。
 */
let tokenMode: { token: string; base: string } | null = null;
let whitelist: WhitelistStore;
let aiUsage: AiUsageStore;
/** MCP 与桌面端共享同一个 settings.json；未初始化时按 full（旧行为）处理 */
let settingsStore: SettingsStore | null = null;
/** 项目档案是独立 JSON，MCP 与 REST 共用同一目录；写入不要求应用在线或保险库解锁 */
let projectDataDir = './data';

/**
 * 初始化共享状态（stdio 入口与测试共用）。
 * 口令优先级：显式传入（测试用）> VAULT_PASSPHRASE > VAULT_MASTER_KEY。
 * Secret Key：显式传入 > VAULT_SECRET_KEY > FK_SK（支持 @file: 路径）；
 * 都没配时，若库是双因子，Vault 会退回到本机 secret_key.txt（「记住此设备」）。
 */
export function initMcp(opts: { dataDir?: string; passphrase?: string; secretKey?: string; token?: string } = {}) {
  const dataDir = resolveDataDir('./data', opts.dataDir);
  projectDataDir = dataDir;
  settingsStore = new SettingsStore(dataDir);
  // 令牌模式：拿到访问令牌就不碰密文 —— Agent 机器上不需要放主口令与 Secret Key
  const accessToken = opts.token || process.env.FK_TOKEN || process.env.VAULT_TOKEN;
  if (accessToken) {
    const base = (process.env.FK_BASE || `http://127.0.0.1:${Number(process.env.PORT || 8787)}`).replace(/\/+$/, '');
    tokenMode = { token: accessToken, base };
    return;
  }
  const sk =
    resolveSecretKeySource(opts.secretKey) ||
    resolveSecretKeySource(process.env.VAULT_SECRET_KEY) ||
    resolveSecretKeySource(process.env.FK_SK) ||
    undefined;
  try {
    vault = new Vault(dataDir, opts.passphrase, { secretKey: sk });
  } catch (e) {
    // 构造期就会解锁：双因子库缺 SK 时把「该配哪个环境变量」直接说清楚，
    // 否则 Agent 宿主只看到一句「还需要 Secret Key」，不知道去哪补
    if (e instanceof NeedSecretKeyError) {
      throw new Error(
        '保险库已启用 Secret Key：请设置 VAULT_PASSPHRASE 与 VAULT_SECRET_KEY（或 FK_SK=@file:~/secret_key.txt），两者都要对才能解锁'
      );
    }
    throw e;
  }
  if (vault.locked) {
    const st = vault.secretKeyStatus();
    throw new Error(
      st.enabled
        ? '保险库已启用 Secret Key：请设置 VAULT_PASSPHRASE 与 VAULT_SECRET_KEY（或 FK_SK=@file:~/secret_key.txt），两者都要对才能解锁'
        : '保险库未解锁：请在 MCP 配置中设置 VAULT_PASSPHRASE（首次运行即作为初始化口令）'
    );
  }
  whitelist = new WhitelistStore(dataDir);
  aiUsage = new AiUsageStore(dataDir);
}

// 我们实现的 JSON-RPC 面很小（initialize/tools/list/tools/call，均单请求逐行处理），
// 这些版本的客户端都能正常工作；协商时回显其中之一，否则回落到 2024-11-05。
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

function ok(content: any) {
  // 紧凑 JSON：老版本是 2 空格缩进，列表一多体积就大 38%，白白吃 Agent 的上下文
  return { content: [{ type: 'text', text: JSON.stringify(content) }] };
}

/** 带错误码与「下一步」的失败响应：模型读到 next 就能一次纠错，不用换工具穷举 */
function failWith(
  code: string,
  message: string,
  hint?: string,
  next?: { tool: string; args?: Record<string, any> },
  extra?: Record<string, any>
) {
  return fail({
    code,
    error: message,
    ...(hint ? { hint } : {}),
    ...(next ? { next } : {}),
    ...(extra || {}),
  });
}
/** 工具执行失败按 MCP 规范回 isError，避免 Agent 把 {error:...} 当成一次成功调用 */
function fail(content: any) {
  return { ...ok(content), isError: true };
}

/**
 * 旧工具名 → 新入口。默认 tools/list 不下发这些名字（只给 9 个任务入口），
 * 但 Agent 可能从旧会话记忆或旧技能里直接调用；这里统一转接，保证同名调用拿不到明文。
 */
const LEGACY_TO_NEW: Record<string, { to: 'show' | 'connect'; args: (a: any) => Record<string, any> }> = {
  get_asset: {
    to: 'show',
    args: (a) => {
      const target = a?.id ?? a?.target ?? (a?.type !== undefined && a?.no !== undefined ? `${a.type}:${a.no}` : '');
      return {
        target,
        ...(a?.reveal === true ? { reveal: true } : {}),
        ...(a?.fields ? { fields: a.fields } : {}),
      };
    },
  },
  get_server_connection: {
    to: 'connect',
    args: (a) => ({ target: a?.target ?? a?.id ?? '' }),
  },
};

/** 递归剥掉密钥字段：总开关关闭时兜住所有工具的回显（增改回显、版本历史、备份导出） */
function stripSecretFields(node: any): any {
  if (Array.isArray(node)) return node.map(stripSecretFields);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if ((SECRET_FIELDS as string[]).includes(k)) continue;
    if (k === 'extra' && v && typeof v === 'object' && !Array.isArray(v)) {
      const extra: Record<string, any> = {};
      for (const [ek, ev] of Object.entries(v as Record<string, any>)) {
        // 用户自定义字段里的敏感键（cf_password 之类）同样不能出站
        if (/^(password|passwd|pwd|secret|privateKey|apiKey|accessKey|secretKey|token)$/i.test(ek)) continue;
        extra[ek] = stripSecretFields(ev);
      }
      out[k] = extra;
      continue;
    }
    out[k] = stripSecretFields(v);
  }
  return out;
}

/** 对响应正文做兜底剥离：isError 与 content 结构不动，只替换 text 里的 JSON */
function stripSecretFieldsFromResponse(res: any): any {
  const t = res?.content?.[0]?.text;
  if (typeof t !== 'string' || !t) return res;
  let parsed: any;
  try {
    parsed = JSON.parse(t);
  } catch {
    return res;
  }
  const clean = stripSecretFields(parsed);
  return { ...res, content: [{ ...res.content[0], text: JSON.stringify(clean) }] };
}

/** 被转接的旧调用：结果原样返回，另附 deprecated / hint / next，让 Agent 下次直接走新入口 */
function withDeprecatedNotice(res: any, oldName: string, newName: string, nextArgs: Record<string, any>) {
  const t = res?.content?.[0]?.text;
  let body: any;
  try {
    body = t ? JSON.parse(t) : {};
  } catch {
    body = { raw: t };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = { result: body };
  const merged = {
    ...body,
    deprecated: oldName,
    hint: `${oldName} 已停用，本次已按 ${newName} 执行；后续直接调用 ${newName}`,
    next: { tool: newName, args: nextArgs },
  };
  return { ...res, content: [{ type: 'text', text: JSON.stringify(merged) }] };
}

/** 权限档位：默认 full；读设置失败也回落 full，保证旧配置行为不变 */
/**
 * 执行类工具：会真的在本机跑命令，或整库覆盖。
 * 它们由「允许 Agent 执行本机命令」单独放行（默认关闭），与读写档位正交：
 * 即使把 agentPermission 调到 full，也不等于把命令执行权交出去。
 */
const EXEC_TOOLS = new Set(['project_upsert', 'project_start', 'project_stop', 'whitelist_sync', 'import_backup']);

const FULL_ONLY_TOOLS = new Set([
  'add_asset',
  'update_asset',
  'delete_asset',
  'upsert_field',
  'delete_field',
  'upsert_asset_type',
  'delete_asset_type',
  'export_backup',
  'import_backup',
  'whitelist_sync',
  'project_upsert',
  'project_start',
  'project_stop',
]);
const READONLY_TOOLS = new Set([
  'list_assets',
  'search_assets',
  'list_field_schema',
  'ai_usage_snapshot',
  'whitelist_status',
  'projects_status',
  'project_discover',
  // v2 只读入口
  'find',
  'show',
  'usage',
]);
const PERMISSION_LABELS: Record<AgentPermission, string> = { readonly: '只读', normal: '常规', full: '全自动' };

function currentSettings() {
  try {
    return settingsStore?.get() || DEFAULT_SETTINGS;
  } catch {
    // 设置读不出来时按默认（更保守）处理
    return DEFAULT_SETTINGS;
  }
}
function currentPermission(): AgentPermission {
  return normalizeAgentPermission(currentSettings().agentPermission, DEFAULT_SETTINGS.agentPermission);
}
function isToolAllowed(name: string, perm: AgentPermission): boolean {
  if (perm === 'full') return true;
  if (FULL_ONLY_TOOLS.has(name)) return false;
  return perm === 'normal' || READONLY_TOOLS.has(name);
}

// ===== MCP v2：任务导向入口 =====
// 设计目标：Agent 用「找 → 看 → 用」三步完成绝大多数工作，而不是在 27 个表操作里试探。
// 老工具仍然保留（legacy），v2 只做前置校验 + 少量原生实现 + 其余映射到老实现，降低改动风险。

const PERM_RANK: Record<AgentPermission, number> = { readonly: 0, normal: 1, full: 2 };

type V2Deny = {
  ok: false;
  code: string;
  message: string;
  hint: string;
  next?: { tool: string; args?: Record<string, any> };
};

/** v2 入口的权限与参数前置校验：错误必须说清「改哪个设置/缺哪个参数」 */
function v2Gate(name: string, args: any, perm: AgentPermission): { ok: true } | V2Deny {
  const deny = (code: string, message: string, hint: string, next?: V2Deny['next']): V2Deny => ({
    ok: false,
    code,
    message,
    hint,
    ...(next ? { next } : {}),
  });
  const level = (min: AgentPermission) => PERM_RANK[perm] >= PERM_RANK[min];
  const execOn = currentSettings().allowAgentExec === true;
  const execHint = '在「设置 → 后台与锁定 → 允许 Agent 执行本机命令」打开后重试，用完建议关回去';

  if ((name === 'connect' || name === 'note') && !level('normal')) {
    return deny(
      'permission.readonly',
      `当前是只读档位，不能调用 ${name}`,
      '把「设置 → 后台与锁定 → Agent 权限」调到「常规」'
    );
  }
  if ((name === 'manage' || name === 'backup') && !level('full')) {
    return deny('permission.normal', `${name} 会改数据，需要「全自动」档位`, '把 Agent 权限调到「全自动」后再试');
  }
  if (name === 'manage') {
    const a = String(args?.action || '');
    if (!['add', 'update', 'delete', 'history', 'restore'].includes(a)) {
      return deny(
        'args.invalid',
        `manage 不支持 action=${a || '(空)'}`,
        '可选 add / update / delete / history / restore'
      );
    }
    if (a === 'add' && (!args?.asset || typeof args.asset !== 'object')) {
      return deny(
        'args.invalid',
        'add 需要 asset 对象',
        '传 { action:"add", asset:{ type:"api_key", name:"…", secret:"…" } }'
      );
    }
    if (a !== 'add' && !args?.id) {
      return deny('args.invalid', `${a} 需要 id（也可用 target）`, '先用 find 查到 id，再传 id 或 target', {
        tool: 'find',
        args: { q: args?.name || '' },
      });
    }
    if (a === 'restore' && !args?.vid) {
      return deny('args.invalid', 'restore 需要 vid', '先 manage(action="history", id=…) 拿到 vid', {
        tool: 'manage',
        args: { action: 'history', id: args?.id },
      });
    }
  }
  if (name === 'run_project') {
    const rawAction = String(args?.action || '');
    const a = rawAction || 'status';
    if (!['status', 'list', 'start', 'stop', 'discover'].includes(a)) {
      return deny('args.invalid', `run_project 不支持 action=${a}`, '可选 status / list / start / stop / discover');
    }
    // 只给了目标、没给 action：以前会静默当 status 返回整个列表，调用方以为在启动
    if (!rawAction && (args?.id || args?.target)) {
      return deny(
        'args.invalid',
        'run_project 需要 action',
        '启停请传 action="start"/"stop"；只查列表用 action="list"'
      );
    }
    if (a === 'start' || a === 'stop' || a === 'discover') {
      if (!level('full'))
        return deny('permission.normal', '启停/体检项目需要「全自动」档位', '把 Agent 权限调到「全自动」');
      if (!execOn) return deny('exec.disabled', '「允许 Agent 执行本机命令」当前关闭', execHint);
      if ((a === 'start' || a === 'stop') && !args?.id) {
        return deny('args.invalid', `${a} 需要 id（也可用 target）`, '先用 run_project(action="list") 查 id', {
          tool: 'run_project',
          args: { action: 'list' },
        });
      }
      if (a === 'discover' && !args?.cwd) return deny('args.invalid', 'discover 需要 cwd', '传项目绝对路径');
    }
  }
  if (name === 'sync_whitelist') {
    const a = String(args?.action || 'status');
    if (!['status', 'sync'].includes(a))
      return deny('args.invalid', `sync_whitelist 不支持 action=${a}`, '可选 status / sync');
    if (a === 'sync') {
      if (!level('full'))
        return deny('permission.normal', '同步白名单需要「全自动」档位', '把 Agent 权限调到「全自动」');
      if (!execOn) return deny('exec.disabled', '「允许 Agent 执行本机命令」当前关闭', execHint);
    }
  }
  if (name === 'backup') {
    const a = String(args?.action || 'export');
    if (!['export', 'import'].includes(a))
      return deny('args.invalid', `backup 不支持 action=${a}`, '可选 export / import');
    if (a === 'import') {
      if (!args?.backup || !args?.passphrase)
        return deny('args.invalid', 'import 需要 backup 与 passphrase', '备份串与导出时使用的主口令');
      if (!execOn) return deny('exec.disabled', '「允许 Agent 执行本机命令」当前关闭', execHint);
    }
  }
  return { ok: true };
}

/** v2 → 老工具的映射；返回 null 表示走 v2 原生实现（find/show/connect） */
function mapV2(name: string, args: any): { name: string; args: any } | null {
  switch (name) {
    case 'manage': {
      const a = String(args?.action || '');
      if (a === 'add') return { name: 'add_asset', args: { asset: args.asset } };
      if (a === 'update') return { name: 'update_asset', args: { id: args.id, patch: args.patch } };
      if (a === 'delete') return { name: 'delete_asset', args: { id: args.id } };
      return null;
    }
    case 'run_project': {
      const a = String(args?.action || 'status');
      if (a === 'status' || a === 'list') return { name: 'projects_status', args: {} };
      if (a === 'start') return { name: 'project_start', args: { id: args.id } };
      if (a === 'stop') return { name: 'project_stop', args: { id: args.id, only: args.only } };
      if (a === 'discover') return { name: 'project_discover', args: { cwd: args.cwd, id: args.id } };
      return null;
    }
    case 'sync_whitelist':
      return args?.action === 'sync'
        ? { name: 'whitelist_sync', args: { bindingId: args.bindingId } }
        : { name: 'whitelist_status', args: { detect: args?.detect } };
    case 'usage':
      return { name: 'ai_usage_snapshot', args: { accountId: args?.accountId } };
    case 'note':
      return { name: 'log_agent_action', args: { description: args?.description, meta: args?.meta } };
    case 'backup':
      return args?.action === 'import'
        ? { name: 'import_backup', args: { backup: args.backup, passphrase: args.passphrase } }
        : { name: 'export_backup', args: {} };
    default:
      return null;
  }
}

/** 列表卡片：只保留定位与判断需要的字段，30 条资产从 13KB 降到 ~3KB */
/** 主机摘要要带端口：非 22 端口不写出来，调用方就会按默认端口直连，必然失败 */
function hostWithPort(a: any): string {
  const host = a.publicIp || a.sshHost || a.ip;
  if (!host) return '';
  const port = Number(a.sshPort);
  return Number.isFinite(port) && port > 0 && port !== 22 ? `${host}:${port}` : String(host);
}

function cardOf(a: any) {
  const hint = [
    hostWithPort(a),
    a.panelUrl || a.baseUrl,
    a.provider || a.cloudService,
    a.username || a.email || a.loginUrl,
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 64);
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    no: a.no,
    ...(Array.isArray(a.tags) && a.tags.length ? { tags: a.tags } : {}),
    ...(hint ? { hint } : {}),
  };
}

/** 字段投影：只保留调用方点名的字段（id/type/name 始终保留），进一步压低单次响应体积 */
function projectFields(obj: any, fields: unknown, always: string[] = []) {
  if (!Array.isArray(fields) || !fields.length) return obj;
  const keep = new Set<string>([...always, ...fields.filter((f): f is string => typeof f === 'string')]);
  const out: Record<string, any> = {};
  for (const k of keep) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

/**
 * 目标解析：id / 名称 / 「类型:序号」/ 唯一纯序号 / 唯一模糊命中。
 * 关键是让 Agent 直接说「web-01」「服务器 3 号」，不必先查一次 id。
 */
function resolveAssetTarget(target: string): { asset?: any; candidates?: any[] } {
  // 目标解析只保留一套实现（与 CLI 共用 access-token 里的 findAssetTarget）。
  // 以前这里是第二份拷贝：改了一处另一处不变，于是同一个 IP 在 CLI 里能找到、
  // 在 MCP 里却报「未找到」——Agent 只能退化成「猜 IP + 默认 22 端口」。
  return findAssetTarget(vault, String(target || '').trim(), new AssetTypeStore(projectDataDir).aliases());
}

function notFound(target: string, candidates?: any[]) {
  // 有候选就是「歧义」而不是「不存在」：两者对 Agent 的下一步完全不同。
  // 以前一律回 asset.not_found，还只在文案里说「可能是下面几条之一」却不给列表，
  // 调用方会以为库里没这条资产，转头自己去猜 IP + 默认端口。
  if (candidates?.length) {
    const cards = candidates.map((a) => cardOf(a));
    return failWith(
      'asset.ambiguous',
      `「${target}」匹配到 ${cards.length} 条，无法唯一确定`,
      '用 id，或按「类型:序号」（如 ssh_key:4）重试；candidates 已列出可选条目',
      { tool: 'find', args: { q: target } },
      { candidates: cards }
    );
  }
  return failWith('asset.not_found', `未找到「${target}」`, '用 find(q) 搜索，或确认名称', {
    tool: 'find',
    args: { q: target },
  });
}

/** v2 原生实现：find / show / connect（其余 v2 入口映射到老实现） */
async function handleNativeV2(name: string, args: any) {
  if (name === 'manage') {
    const a = String(args?.action || '');
    const id = String(args?.id || '');
    if (a === 'history') {
      const items = vault.listAssetVersions(id);
      return ok({ id, total: items.length, items });
    }
    if (a === 'restore') {
      const restored = vault.restoreAssetVersion(id, String(args?.vid || ''));
      if (!restored) return notFound(id, []);
      // 回滚结果按列表口径返回（脱敏），要看完整值再走 show(reveal=true)
      const masked = vault.list().find((x: any) => x.id === id);
      return ok({ restored: true, asset: masked || null });
    }
  }
  if (name === 'find') {
    const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50);
    const offset = Math.max(Number(args?.offset) || 0, 0);
    const q = String(args?.q || '').trim();
    let rows: any[];
    if (q) {
      rows = vault.search(q);
      if (args?.kind) {
        const store = new AssetTypeStore(projectDataDir);
        const ty = normalizeAssetType(args.kind, store.aliases());
        if (!ty) {
          return failWith(
            'type.unknown',
            `未知资产类型「${args.kind}」`,
            '可用类型见 find 的 kind 说明；也可以不带 kind 直接按关键词搜',
            {
              tool: 'find',
              args: { q: String(args?.q || '') },
            }
          );
        }
        rows = rows.filter((a) => a.type === ty);
      }
    } else {
      let ty: AssetType | undefined;
      if (args?.kind !== undefined && args?.kind !== '') {
        const store = new AssetTypeStore(projectDataDir);
        const n = normalizeAssetType(args.kind, store.aliases());
        if (!n) {
          return failWith(
            'type.unknown',
            `未知资产类型「${args.kind}」`,
            '可用类型见 find 的 kind 说明；也可以不带 kind 直接列出',
            {
              tool: 'find',
              args: { q: '' },
            }
          );
        }
        ty = n as AssetType;
      }
      rows = vault.list(ty, args?.tag);
      // 与界面一致：不带 kind 时备忘录不进清单（显式 kind=note 才能查到）
      if (!args?.kind) rows = rows.filter((a) => a.type !== 'note');
    }
    const total = rows.length;
    const page = rows
      .slice(offset, offset + limit)
      .map((a) => projectFields(cardOf(a), args?.fields, ['id', 'type', 'name']));
    const nextOffset = offset + page.length < total ? offset + page.length : null;
    return ok({ total, offset, limit, nextOffset, items: page });
  }

  if (name === 'show') {
    const r = resolveAssetTarget(String(args?.target || ''));
    if (!r.asset) return notFound(String(args?.target || ''), r.candidates);
    if (args?.reveal === true) {
      // 总开关默认关闭：明文的唯一出口是「用户明确要求 + 设置允许」。
      // 拒绝时仍返回脱敏内容，Agent 不用再发一次 show 就能继续做事。
      if (currentSettings().agentExposeSecrets !== true) {
        const masked = vault.list().find((a) => a.id === r.asset!.id);
        return failWith(
          'secret.exposure_disabled',
          '「允许 Agent 查看密钥」当前为关闭状态，show 不返回明文',
          '取用凭证用 connect（短期凭据，真密钥不进上下文）；确需原文时让用户在桌面端「设置 → 后台与锁定」打开该开关，或在终端用 fk show --reveal / fk env / fk inject',
          { tool: 'show', args: { target: String(args?.target || '') } },
          { asset: projectFields(masked, args?.fields, ['id', 'type', 'name']) }
        );
      }
      const full = vault.get(r.asset.id); // 写审计
      return full
        ? ok(projectFields(full, args?.fields, ['id', 'type', 'name']))
        : notFound(String(args?.target || ''));
    }
    const masked = vault.list().find((a) => a.id === r.asset!.id);
    return ok(projectFields(masked, args?.fields, ['id', 'type', 'name']));
  }

  if (name === 'connect') {
    const target = String(args?.target || '');
    const r = resolveAssetTarget(target);
    if (!r.asset) return notFound(target, r.candidates);
    const a = r.asset;
    const ttl = Math.min(Math.max(Number(args?.ttl) || 900, 60), 14400);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    if (a.type === 'server' || a.type === 'ssh_key') {
      const s = vault.issueSshAccess(a.id, ttl);
      return ok({
        mode: 'ssh',
        asset: cardOf(a),
        dial: s.targetHint,
        command: `ssh -o StrictHostKeyChecking=no -p ${s.proxyPort} ${s.token}@${s.proxyHost}`,
        expiresAt,
        next: '直接执行 command；真实密钥由燧垒注入，不要再取密码',
      });
    }

    if (a.type === 'cloud_account' || a.type === 'oss' || a.type === 'baota' || a.type === 'api_key') {
      const base = resolveProxyBaseUrl(a);
      if (!base) {
        return failWith(
          'asset.no_base_url',
          `「${a.name}」没有配置 baseUrl / panelUrl，无法代理`,
          '在界面编辑该资产补上 API 基址（例如 https://api.example.com），或让 manage 更新 baseUrl',
          { tool: 'manage', args: { action: 'update', id: a.id, patch: { baseUrl: 'https://' } } }
        );
      }
      const token = vault.issueProxyToken(a.id, ttl);
      const inj = buildProxyInjection(a);
      const url = `${base.replace(/\/+$/, '')}/${a.id}/`;
      return ok({
        mode: 'proxy',
        asset: cardOf(a),
        baseUrl: url,
        token,
        expiresAt,
        inject: { headers: Object.keys(inj.headers), query: Object.keys(inj.query) },
        example: `curl "${url}<path>" -H "Authorization: Bearer ${token}"`,
        next: '把 <path> 换成目标 API 路径；真实密钥由代理注入，令牌勿外传',
      });
    }

    if (a.type === 'mcp') {
      const full = vault.peek(a.id) || a;
      return ok({
        mode: 'launch',
        asset: cardOf(a),
        command: full.command || null,
        args: full.args || [],
        envKeys: Object.keys(full.envEnc || {}),
        next: 'env 值属敏感字段：用户明确要求时用 show(target, reveal=true)（写审计）',
      });
    }

    if (a.type === 'login_account' || a.type === 'email_account') {
      return ok({
        mode: 'credential',
        asset: cardOf(a),
        username: a.username || a.email || null,
        loginUrl: a.loginUrl || null,
        next: '密码属敏感字段：用户明确要求时用 show(target, reveal=true)（写审计）',
      });
    }

    return ok({
      mode: 'none',
      asset: cardOf(a),
      next: `该类型没有可注入的连接，用 show("${a.name}") 看明细`,
    });
  }

  return failWith('tool.unknown', `未知工具 ${name}`);
}

/** 字段/类型工具共用的 scope 解析：类型 key、中文名或 *（所有类型） */
function resolveScope(raw: unknown): { scope: string; label: string } | null {
  const store = new AssetTypeStore(projectDataDir);
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (s === '*') return { scope: '*', label: '所有类型' };
  const t = normalizeAssetType(s, store.aliases());
  return t ? { scope: t, label: store.labels()[t] || t } : null;
}

function normalizeOptions(v: any): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string')
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return undefined;
}

/** 列出内置字段（应用覆盖后）+ 自定义字段；scopeFilter 为空表示全部类型 */
function collectFields(scopeFilter?: string) {
  const typeStore = new AssetTypeStore(projectDataDir);
  const schema = new FieldSchemaStore(projectDataDir).get();
  const types = typeStore.list();
  const out: any[] = [];

  for (const scope of scopeFilter ? [scopeFilter] : types.map((t) => t.key)) {
    const t = types.find((x) => x.key === scope);
    for (const f of BUILTIN_FIELDS[scope] || []) {
      const ov = schema.overrides?.[scope]?.[f.key] || {};
      out.push({
        scope,
        typeLabel: t?.label || scope,
        key: f.key,
        label: ov.label || fieldNameLabel(f.key, { [f.key]: f.label }),
        kind: f.kind,
        kindLabel: fieldKindLabel(f.kind),
        secret: !!f.secret,
        list: ov.list !== false,
        form: ov.form !== false,
        builtin: true,
        options: f.options || null,
        hint: f.hint ? (hasKey(f.hint) ? tr(f.hint as any) : f.hint) : null,
      });
    }
  }

  for (const f of schema.custom) {
    if (scopeFilter && f.scope !== scopeFilter && f.scope !== '*') continue;
    const t = types.find((x) => x.key === f.scope);
    out.push({
      scope: f.scope,
      typeLabel: f.scope === '*' ? '所有类型' : t?.label || f.scope,
      key: f.key,
      label: f.label,
      kind: f.kind,
      kindLabel: fieldKindLabel(f.kind),
      secret: !!f.secret,
      list: f.list,
      form: f.form,
      builtin: false,
      options: f.options || null,
      hint: f.hint || null,
    });
  }

  return { types, fields: out };
}

// ===== 令牌模式（服务账号语义 S2）=====
// 只允许三类操作：查元数据、看脱敏详情、换短期凭据。整库操作一律拒绝。
const TOKEN_TOOLS = new Set(['find', 'show', 'connect']);

const TOKEN_INSTRUCTIONS = [
  '你在「令牌模式」：本进程用访问令牌启动，没有整库访问权限，也没有主口令。',
  '只有 3 个工具可用：',
  '- find(q, kind, tag, limit, offset)：查脱敏元数据（自动限定在令牌 scope 内）',
  '- show(target)：单条脱敏详情（不含任何密钥）',
  '- connect(target, mode)：换短期凭据。server/ssh_key → 可直接粘贴的 ssh 命令；其它类型 → 代理地址 + 令牌',
  '不要尝试 manage / run_project / sync_whitelist / backup：会返回 token.tool_denied。',
  '不要调用 get_asset / get_server_connection（旧名，已停用）：令牌模式直接拒绝，用上面的 find / show / connect。',
  'scope 之外的资产返回 token.scope —— 这不是参数错误，重试无用；需要更多权限请找人重签令牌。',
].join('\n');

/** 本地 REST 调用：令牌模式的所有数据都从这里来 */
async function restCall(
  tm: { token: string; base: string },
  payload: Record<string, any>
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${tm.base}/api/access-token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tm.token, ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** 把 REST 的失败转成 MCP 错误：保留后端 code，让模型知道「重试无用」还是「可以改参数」 */
function restFail(status: number, json: any, name: string) {
  const code = String(json?.code || (status === 401 ? 'token.invalid' : 'token.failed'));
  const hint =
    code === 'token.scope'
      ? '目标不在令牌 scope 内：不要重试，找签发人扩大范围或换一个目标'
      : code === 'token.invalid' || code === 'token.expired' || code === 'token.revoked'
        ? '令牌不可用：确认 FK_TOKEN 未过期/未撤销'
        : code === 'vault.locked'
          ? '本机保险库已锁定：请在桌面端解锁后重试'
          : undefined;
  return failWith(code, String(json?.error || `令牌换发失败（HTTP ${status}）`), hint, {
    tool: name,
    args: json?.target ? { target: json.target } : {},
  });
}

async function handleTokenCall(name: string, args: any, tm: { token: string; base: string }) {
  if (!TOKEN_TOOLS.has(name)) {
    return failWith(
      'token.tool_denied',
      `令牌模式不支持 ${name}`,
      '令牌模式只有 find / show / connect；整库操作请用 FK_PASSPHRASE + FK_SK 启动',
      { tool: 'find', args: {} }
    );
  }
  try {
    if (name === 'find') {
      const r = await restCall(tm, {
        action: 'find',
        q: args?.q,
        kind: args?.kind,
        tag: args?.tag,
        limit: args?.limit,
        offset: args?.offset,
      });
      if (r.status !== 200) return restFail(r.status, r.json, name);
      return ok(r.json);
    }
    if (name === 'show') {
      const r = await restCall(tm, { action: 'show', target: args?.target ?? args?.id ?? args?.q });
      if (r.status !== 200) return restFail(r.status, r.json, name);
      return ok(r.json);
    }
    const mode = String(args?.mode || 'auto');
    const action = mode === 'proxy' || mode === 'ssh' ? mode : 'auto';
    const r = await restCall(tm, { action, target: args?.target ?? args?.id ?? args?.q, ttl: args?.ttl });
    if (r.status !== 200) return restFail(r.status, r.json, name);
    return ok(r.json);
  } catch (e) {
    return failWith(
      'token.rest_unreachable',
      `连不上本地燧垒服务：${(e as Error).message}`,
      `预期地址 ${tm.base}；先启动桌面端或 npm run server，或用 FK_BASE 指对端口`,
      { tool: name, args: {} }
    );
  }
}

/** 对外入口：先跑工具，再按总开关做密钥兜底剥离 */
export async function handleCall(name: string, args: any): Promise<any> {
  const res = await handleCallInner(name, args);
  // 总开关关闭（默认）时，任何工具都不带回密钥字段：show(reveal) 已在源头拒绝，
  // 这里再兜一层，覆盖 add/update 回显、版本历史、备份导出这些旁路。
  if (currentSettings().agentExposeSecrets === true) return res;
  return stripSecretFieldsFromResponse(res);
}

async function handleCallInner(name: string, args: any): Promise<any> {
  // 目标参数统一：show/connect 用 target，manage/run_project 用 id。
  // Agent 记不住两套名字（真实使用里就踩了「history 需要 id」），这里双向补齐，任一个都能用。
  if (args && typeof args === 'object') {
    const t = args.target ?? args.id;
    if (t && args.id === undefined) args = { ...args, id: t };
    if (t && args.target === undefined) args = { ...args, target: t };
  }
  if (tokenMode) return handleTokenCall(name, args, tokenMode);

  // 旧工具名：转到新入口，结果里补 deprecated / next。
  // 放在 tokenMode 之后：令牌模式仍按原规则拒绝，不因转接而扩大权限。
  const legacy = LEGACY_TO_NEW[name];
  if (legacy) {
    const nextArgs = legacy.args(args);
    const mapped = await handleCallInner(legacy.to, nextArgs);
    return withDeprecatedNotice(mapped, name, legacy.to, nextArgs);
  }

  const perm = currentPermission();

  // ===== v2 任务导向入口 =====
  // 校验顺序：v2 语义校验（权限/参数/执行开关）→ 锁定态 → 原生实现或映射到老工具。
  // 映射后继续走老工具的权限检查，保证"v2 是门面、老实现仍是唯一数据路径"。
  if (V2_TOOL_NAMES.includes(name)) {
    const gate = v2Gate(name, args, perm);
    if (!gate.ok) return failWith(gate.code, gate.message, gate.hint, gate.next);
    const manageAction = String(args?.action || '');
    if (name === 'manage' && (manageAction === 'delete' || manageAction === 'restore') && args?.confirm !== true) {
      return ok({
        needsConfirm: true,
        id: args?.id || null,
        ...(manageAction === 'restore' ? { vid: args?.vid || null } : {}),
        hint:
          manageAction === 'delete'
            ? '删除不可逆（审计保留恢复点）。确认请重新调用 manage(action="delete", id=…, confirm=true)。'
            : '回滚会覆盖当前值（当前值也会留一版，可再回滚）。确认请重新调用 manage(action="restore", id=…, vid=…, confirm=true)。',
      });
    }
    const v2Blocked = lockedBlockReason(projectDataDir, currentSettings().allowLockedAccess === true);
    if (v2Blocked) return fail({ code: 'vault.locked', error: v2Blocked, locked: true, tool: name });
    const mapped = mapV2(name, args);
    if (!mapped) {
      try {
        return await handleNativeV2(name, args);
      } catch (e) {
        return failWith('internal.error', (e as Error).message);
      }
    }
    name = mapped.name;
    args = mapped.args;
  }

  if (!isToolAllowed(name, perm)) {
    return fail({
      error: `当前 Agent 权限为「${PERMISSION_LABELS[perm]}」，不允许调用 ${name}`,
      permission: perm,
      hint: '在应用「设置 → 后台与锁定 → Agent 权限」调整，保存后即刻生效',
    });
  }
  // 执行类工具：默认关。登记项目本身不危险，但登记的命令一旦被启动就是本机命令执行，
  // 所以「登记」和「启停」一起放在这个开关后面，语义更好理解。
  if (EXEC_TOOLS.has(name) && !currentSettings().allowAgentExec) {
    return fail({
      error: `「允许 Agent 执行本机命令」当前为关闭状态，${name} 不可用`,
      permission: perm,
      hint: '在应用「设置 → 后台与锁定 → 允许 Agent 执行本机命令」打开后重试；用完建议关回去',
    });
  }
  // 锁定态：桌面端锁定后，Agent 默认也断开（可在设置里改回“锁屏仍允许连接”）
  const cfg = currentSettings();
  const blocked = lockedBlockReason(projectDataDir, cfg.allowLockedAccess === true);
  if (blocked) return fail({ error: blocked, locked: true, tool: name });
  try {
    // 注意：桌面端的自动锁定【不影响】MCP——MCP 持有口令是既定设计，
    // 锁标记挡不住新拉起的进程，只会打断正在工作的 Agent 会话（教训见 audit 的 vault_lock 记录）。
    // 要彻底断开 Agent 访问，应删除 Agent 配置里的 flintkeep MCP 条目。
    switch (name) {
      case 'list_assets': {
        if (args.type !== undefined && args.type !== '') {
          const typeStore = new AssetTypeStore(projectDataDir);
          const t = normalizeAssetType(args.type, typeStore.aliases());
          if (!t) {
            return fail({
              error: `未知资产类型「${args.type}」`,
              hint:
                '可用类型：' + Object.keys(typeStore.labels()).join(' / ') + '（也接受中文名如「服务器」「SSH 登录」）',
            });
          }
          return ok(vault.list(t as AssetType, args.tag));
        }
        return ok(vault.list(undefined, args.tag));
      }
      case 'search_assets':
        return ok(vault.search(args.query));
      case 'get_asset': {
        // 支持按 id，或按 type + no（稳定序号，如「服务器 3 号」）；type 接受中文/别名
        let id = args.id as string | undefined;
        if (!id && args.type !== undefined && args.no !== undefined) {
          const typeStore = new AssetTypeStore(projectDataDir);
          const t = normalizeAssetType(args.type, typeStore.aliases());
          if (!t) {
            return fail({
              error: `未知资产类型「${args.type}」`,
              hint: '可用类型：' + Object.keys(typeStore.labels()).join(' / '),
            });
          }
          const byNo = vault.getByNo(t as AssetType, Number(args.no));
          id = byNo?.id;
        }
        const a = id ? vault.get(id) : undefined;
        return a ? ok(a) : fail({ error: '未找到', id: args.id, type: args.type, no: args.no });
      }
      case 'get_server_connection': {
        const s = vault.getServerConnection(args.target);
        return s ? ok(s) : fail({ error: '未找到服务器', target: args.target });
      }
      case 'add_asset': {
        const input = { ...(args.asset || {}) } as any;
        // Agent 可能传中文类型名（含用户自定义类型），统一归一化成 key
        if (typeof input.type === 'string' && input.type.trim()) {
          const typeStore = new AssetTypeStore(projectDataDir);
          const t = normalizeAssetType(input.type, typeStore.aliases());
          if (!t) {
            return fail({
              error: `未知资产类型「${input.type}」`,
              hint: '可用类型：' + Object.keys(typeStore.labels()).join(' / '),
            });
          }
          input.type = t;
        }
        return ok(vault.add(input));
      }
      case 'update_asset': {
        const patch = { ...(args.patch || {}) } as any;
        if (typeof patch.type === 'string' && patch.type.trim()) {
          const typeStore = new AssetTypeStore(projectDataDir);
          const t = normalizeAssetType(patch.type, typeStore.aliases());
          if (!t) {
            return fail({
              error: `未知资产类型「${patch.type}」`,
              hint: '可用类型：' + Object.keys(typeStore.labels()).join(' / '),
            });
          }
          patch.type = t;
        }
        const updated = vault.update(args.id, patch);
        return updated ? ok(updated) : fail({ error: '未找到', id: args.id });
      }
      case 'delete_asset':
        return ok({ deleted: vault.remove(args.id) });
      case 'list_field_schema': {
        let filter: { scope: string; label: string } | null = null;
        if (args.type !== undefined && args.type !== '') {
          filter = resolveScope(args.type);
          if (!filter) {
            const store = new AssetTypeStore(projectDataDir);
            return fail({
              error: `未知资产类型「${args.type}」`,
              hint: '可用类型：' + Object.keys(store.labels()).join(' / ') + '（也接受自定义类型与 *）',
            });
          }
        }
        const { types, fields } = collectFields(filter?.scope);
        return ok({
          types: types.map((t) => ({ key: t.key, label: t.label, category: t.category, builtin: t.builtin })),
          fields,
        });
      }
      case 'upsert_field': {
        const scopeInfo = resolveScope(args.type);
        if (!scopeInfo) {
          return fail({ error: `未知资产类型「${args.type}」`, hint: 'type 可传类型 key、中文名，或 * 表示所有类型' });
        }
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const store = new FieldSchemaStore(projectDataDir);
        const typeStore = new AssetTypeStore(projectDataDir);
        const schema = store.get();

        // 内置字段：只能改显示名/列/表单，kind 与 key 不可动
        const builtin =
          scopeInfo.scope !== '*' ? (BUILTIN_FIELDS[scopeInfo.scope] || []).find((f) => f.key === key) : undefined;
        if (builtin) {
          const ov: any = { ...(schema.overrides[scopeInfo.scope]?.[key] || {}) };
          if (typeof args.label === 'string') {
            const label = args.label.trim().slice(0, 30);
            if (label) ov.label = label;
            else delete ov.label;
          }
          if (typeof args.list === 'boolean') ov.list = args.list;
          if (typeof args.form === 'boolean') ov.form = args.form;
          schema.overrides[scopeInfo.scope] = schema.overrides[scopeInfo.scope] || {};
          schema.overrides[scopeInfo.scope][key] = ov;
          try {
            store.save({ overrides: schema.overrides, custom: schema.custom }, { scopes: typeStore.scopes() });
          } catch (e) {
            return fail({ error: (e as Error).message });
          }
          vault.logAgentAction(`MCP 修改内置字段：${scopeInfo.label}.${builtin.label}`, {
            tool: 'upsert_field',
            scope: scopeInfo.scope,
            key,
          });
          const field = collectFields(scopeInfo.scope).fields.find((f) => f.scope === scopeInfo.scope && f.key === key);
          return ok({ updated: true, builtin: true, field });
        }

        // 自定义字段：有 key 则更新，没有则新增（后端生成 cf_ 开头的 key）
        const existing = schema.custom.find((f) => f.scope === scopeInfo.scope && f.key === key);
        let target: any;
        if (existing) {
          if (typeof args.label === 'string' && args.label.trim()) existing.label = args.label.trim().slice(0, 30);
          if (typeof args.kind === 'string') existing.kind = args.kind;
          if (typeof args.secret === 'boolean') existing.secret = args.secret;
          if (args.options !== undefined) existing.options = normalizeOptions(args.options);
          if (typeof args.list === 'boolean') existing.list = args.list;
          if (typeof args.form === 'boolean') existing.form = args.form;
          if (typeof args.hint === 'string') existing.hint = args.hint.slice(0, 120);
          if (args.width !== undefined) existing.width = Number(args.width);
          target = existing;
        } else {
          if (!args.label || !String(args.label).trim()) {
            return fail({ error: '新增字段需要 label（显示名）', hint: '改已有字段请传 key；新增字段不传 key 或传空' });
          }
          target = {
            key,
            label: String(args.label).trim().slice(0, 30),
            scope: scopeInfo.scope,
            kind: typeof args.kind === 'string' ? args.kind : 'text',
            secret: !!args.secret,
            options: args.options !== undefined ? normalizeOptions(args.options) : undefined,
            list: args.list !== false,
            form: args.form !== false,
            hint: typeof args.hint === 'string' ? args.hint.slice(0, 120) : undefined,
            width: args.width !== undefined ? Number(args.width) : undefined,
          };
          schema.custom.push(target);
        }
        const idx = schema.custom.indexOf(target);
        let saved;
        try {
          saved = store.save({ overrides: schema.overrides, custom: schema.custom }, { scopes: typeStore.scopes() });
        } catch (e) {
          return fail({ error: (e as Error).message });
        }
        const field = idx >= 0 ? saved.custom[idx] : saved.custom[saved.custom.length - 1];
        vault.logAgentAction(
          `MCP ${existing ? '修改' : '新增'}自定义字段：${scopeInfo.label}.${field?.label || target.label}`,
          { tool: 'upsert_field', scope: scopeInfo.scope, key: field?.key }
        );
        return ok({ updated: !!existing, field });
      }
      case 'delete_field': {
        const scopeInfo = resolveScope(args.type);
        if (!scopeInfo) return fail({ error: `未知资产类型「${args.type}」` });
        const key = String(args.key || '').trim();
        if (!key) return fail({ error: '缺少 key' });
        if (scopeInfo.scope !== '*' && (BUILTIN_FIELDS[scopeInfo.scope] || []).some((f) => f.key === key)) {
          return fail({ error: '内置字段不能删除', hint: '可以用 upsert_field 把 list 或 form 设为 false 隐藏它' });
        }
        const store = new FieldSchemaStore(projectDataDir);
        const typeStore = new AssetTypeStore(projectDataDir);
        const schema = store.get();
        const before = schema.custom.length;
        schema.custom = schema.custom.filter((f) => !(f.scope === scopeInfo.scope && f.key === key));
        if (schema.custom.length === before)
          return fail({ error: '未找到这个自定义字段', scope: scopeInfo.scope, key });
        try {
          store.save({ overrides: schema.overrides, custom: schema.custom }, { scopes: typeStore.scopes() });
        } catch (e) {
          return fail({ error: (e as Error).message });
        }
        vault.logAgentAction(`MCP 删除自定义字段：${scopeInfo.label}.${key}`, {
          tool: 'delete_field',
          scope: scopeInfo.scope,
          key,
        });
        return ok({ deleted: true, scope: scopeInfo.scope, key });
      }
      case 'upsert_asset_type': {
        const store = new AssetTypeStore(projectDataDir);
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        try {
          const t = key
            ? store.update(key, { label: args.label, category: args.category, color: args.color })
            : store.create({ label: args.label, category: args.category, color: args.color });
          vault.logAgentAction(`MCP ${key ? '修改' : '新增'}资产类型：${t.label}`, {
            tool: 'upsert_asset_type',
            key: t.key,
          });
          return ok(t);
        } catch (e) {
          return fail({ error: (e as Error).message });
        }
      }
      case 'delete_asset_type': {
        const key = String(args.key || '').trim();
        if (!key) return fail({ error: '缺少 key' });
        const store = new AssetTypeStore(projectDataDir);
        const def = store.list().find((t) => t.key === key);
        if (!def) return fail({ error: '类型不存在', key });
        if (def.builtin) return fail({ error: '内置类型不能删除' });
        const used = vault.list(key as any).length;
        if (used) return fail({ error: `该类型下还有 ${used} 条资产，请先删除或改类型` });
        store.remove(key);
        new FieldSchemaStore(projectDataDir).removeScope(key);
        vault.logAgentAction(`MCP 删除资产类型：${def.label}`, { tool: 'delete_asset_type', key });
        return ok({ deleted: true, key });
      }
      case 'log_agent_action':
        return ok({ logged: true, entry: vault.logAgentAction(args.description, args.meta || {}) });
      case 'export_backup':
        return ok({ backup: vault.exportBackup() });
      case 'import_backup':
        try {
          return ok(vault.importBackup(args.backup, args.passphrase, { secretKey: args.secretKey }));
        } catch (e) {
          return fail({ error: (e as Error).message });
        }
      case 'request_proxy_access': {
        try {
          const ttl = args.ttl || 3600;
          const token = vault.issueProxyToken(args.assetId, ttl);
          const port = process.env.PROXY_PORT || Number(process.env.PORT || 8787) + 1;
          const base = process.env.PROXY_BASE || `http://127.0.0.1:${port}`;
          return ok({ proxyBase: base, token, ttl, note: '真实密钥由代理注入，Agent 仅持此令牌' });
        } catch (e) {
          return fail({ error: (e as Error).message });
        }
      }
      case 'request_ssh_access': {
        try {
          return ok(vault.issueSshAccess(args.assetId, args.ttl || 3600));
        } catch (e) {
          return fail({ error: (e as Error).message });
        }
      }
      case 'whitelist_status': {
        const ips = args.detect === false ? [] : await detectPublicIp();
        return ok({
          publicIps: ips,
          ...(ips.length ? {} : { note: '未探测到公网 IP（离线或网络受限），绑定状态不受影响' }),
          bindings: whitelist.list().map((b) => ({
            id: b.id,
            name: b.name,
            provider: b.provider,
            region: b.region,
            target: b.prefixListId || b.addressTemplateId || '',
            enabled: b.enabled,
            lastRunAt: b.lastRunAt,
            lastResult: b.lastResult,
            lastMessage: b.lastMessage,
            lastIp: b.lastIp,
          })),
          schedule: whitelist.getSchedule(),
        });
      }
      case 'whitelist_sync': {
        if (args.bindingId && !whitelist.get(String(args.bindingId))) {
          return fail({ error: '未找到该白名单绑定', bindingId: args.bindingId });
        }
        const results = await runAll(vault, whitelist, { onlyId: args.bindingId });
        return ok({ results });
      }
      case 'ai_usage_snapshot': {
        const cloudAccounts = vault.list('cloud_account');
        const ids = args.accountId
          ? [String(args.accountId)]
          : [...new Set([...Object.keys(aiUsage.getConfig().accounts || {}), ...cloudAccounts.map((a) => a.id)])];
        const cfg = aiUsage.getConfig();
        return ok({
          lastRunAt: cfg.lastRunAt || null,
          accounts: ids.map((id) => ({
            accountId: id,
            accountName: cloudAccounts.find((a) => a.id === id)?.name || null,
            snapshot: aiUsage.getSnapshot(id),
          })),
        });
      }
      case 'project_upsert': {
        const input = args.project && typeof args.project === 'object' ? args.project : args;
        // 默认开启自动派生：Agent 只写主项目，程序扫目录把数据库/缓存拆成子节点
        const r = registerProject(projectDataDir, input as Record<string, any>, {
          autoDiscover: args.autoDiscover !== false,
        });
        if (!r.ok) return fail({ error: '项目档案校验失败', errors: r.errors, warnings: r.warnings });
        try {
          vault.logAgentAction(
            `登记项目启动配置：${r.project!.name}（${r.project!.id}）` +
              (r.derived.length ? `，自动派生 ${r.derived.map((d) => d.id).join('、')}` : ''),
            { tool: 'project_upsert', id: r.project!.id }
          );
        } catch {
          /* 审计失败不影响写入 */
        }
        return ok({
          saved: true,
          project: r.project,
          warnings: r.warnings,
          derived: r.derived,
          children: r.children,
          ...(r.sharedWith ? { sharedWith: r.sharedWith } : {}),
          ...(r.skipped.length ? { skipped: r.skipped } : {}),
          hint: r.sharedWith?.length
            ? `检测到同一份资源已被 ${r.sharedWith.map((s) => s.name).join('、')} 登记，已把两边都标成共享依赖（shared）：关闭任一项目都不会停它。`
            : r.derived.length
              ? `已顺带登记 ${r.derived.length} 个依赖节点（挂在 ${r.project!.id} 下），页面上会折叠成一张卡。启停主项目会按依赖顺序自动带上它们。`
              : '已生效，读盘即写入，不需要重启应用。之后可用 project_start / project_stop 启停，或由页面与菜单栏按钮操作。',
        });
      }
      case 'projects_status': {
        const statuses = await probeOnce(projectDataDir);
        const all = readProjects(projectDataDir).projects;
        const projects = all.map((p) => ({
          id: p.id,
          name: p.name,
          cwd: p.cwd,
          ports: p.probe?.ports || [],
          url: p.probe?.url || '',
          kind: p.kind || 'process',
          dependsOn: p.dependsOn || [],
          shared: !!p.shared,
          // 从属关系：子节点的 parent 指向主项目；主项目带 children 便于一次性理解结构
          parent: p.parent || null,
          children: childrenOf(all, p.id).map((c) => c.id),
          status: statuses[p.id]?.status || 'stopped',
          source: statuses[p.id]?.source,
          residual: statuses[p.id]?.residual,
        }));
        return ok({ total: projects.length, projects, statuses });
      }
      case 'project_start': {
        const id = String(args.id || '').trim();
        if (!id) return fail({ error: '缺少 id' });
        if (!readProjects(projectDataDir).projects.some((p) => p.id === id)) {
          return fail({
            error: `未登记的项目：${id}`,
            hint: '先调 project_upsert 登记，或先 project_discover 扫描目录看该登记哪些节点',
          });
        }
        // 默认异步发出：启动可能几十秒到几分钟，长时间占着 stdio 会让其他工具调用排队
        if (args.wait !== true) {
          void startProject(projectDataDir, id).catch(() => {});
          try {
            vault.logAgentAction(`MCP 启动项目：${id}`, { tool: 'project_start', id });
          } catch {
            /* 审计失败不影响 */
          }
          return ok({
            started: true,
            async: true,
            id,
            hint: '启动指令已发出。用 projects_status 轮询状态（starting → waiting → running / failed）；页面上也会自动看到。',
          });
        }
        const r = await startProject(projectDataDir, id);
        try {
          vault.logAgentAction(`MCP 启动项目：${id}（${r.ok ? '成功' : '失败'}）`, { tool: 'project_start', id });
        } catch {
          /* ignore */
        }
        const statuses = await probeOnce(projectDataDir).catch(() => ({}) as any);
        return r.ok
          ? ok({ started: true, id, status: statuses[id] || null })
          : fail({ error: r.message || '启动失败', id, status: statuses[id] || null });
      }
      case 'project_stop': {
        const id = String(args.id || '').trim();
        if (!id) return fail({ error: '缺少 id' });
        const only = args.only === 'deps' ? 'deps' : 'all';
        const planned = await planStop(projectDataDir, id, { cascade: args.cascade, only });
        if ('error' in planned) return fail({ error: planned.error });
        const r = await stopProject(projectDataDir, id, { cascade: args.cascade, only });
        try {
          vault.logAgentAction(`MCP 关闭项目：${id}${only === 'deps' ? '（仅依赖）' : ''}`, {
            tool: 'project_stop',
            id,
            only,
          });
        } catch {
          /* ignore */
        }
        if (!r.ok) return fail({ error: r.message || '关闭失败', plan: planned });
        return ok({
          stopped: true,
          id,
          only,
          plan: {
            targets: planned.targets.map((t) => ({ id: t.id, name: t.name, reason: t.reason })),
            survivors: planned.survivors,
          },
          residual: r.residual || [],
          // 残留非空 = 还有端口/容器活着，多半是有节点没登记
          ...(r.residual?.length
            ? { warning: '关闭后仍有端口/容器存活，可能漏登记了节点。用 project_discover 扫描该目录补登记。' }
            : {}),
          ...(r.message ? { message: r.message } : {}),
        });
      }
      case 'project_discover': {
        const cwd = String(args.cwd || '').trim();
        if (!cwd) return fail({ error: '缺少 cwd（项目绝对路径）' });
        const r = discoverProject(projectDataDir, cwd, args.id ? String(args.id) : undefined);
        return ok({
          ...r,
          hint: r.missing
            ? `发现 ${r.missing} 个疑似未登记的节点。确认后用 project_upsert 逐个登记（或页面「体检」勾选批量写入）；登记全了关闭才能关干净。`
            : '没有发现漏登记的节点。',
        });
      }
      case 'list_collections':
        return ok(vault.listCollectionNames());
      case 'get_collection': {
        const name = String(args.name || '').trim();
        if (!name) return fail({ error: '缺少集合名 name', hint: '先调 list_collections 查看可用集合' });
        return ok(vault.readCollection(name));
      }
      default:
        return fail({ error: '未知工具', name });
    }
  } catch (e) {
    // 兜底：工具内部任何异常都转成错误结果回应，绝不能让 stdio 进程崩溃掉线
    return fail({ error: (e as Error).message || String(e), tool: name });
  }
}

function send(obj: any) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  try {
    initMcp();
  } catch (e) {
    console.error('[mcp] ' + (e as Error).message);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // 按 JSON-RPC 规范回 parse error，而不是静默丢掉让客户端一直等
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效的 JSON' } });
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // 通知类/坏消息忽略
    try {
      if (msg.method === 'initialize') {
        const client = msg.params?.clientInfo;
        if (client && !tokenMode) vault.setActor(`${client.name}${client.version ? '/' + client.version : ''}`);
        const requested = msg.params?.protocolVersion;
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion:
              typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'flintkeep', version: '0.2.0' },
            // 把标准路径直接写进协议层：模型不用靠试探去猜「先 list 还是先 get」
            instructions: tokenMode ? TOKEN_INSTRUCTIONS : MCP_INSTRUCTIONS,
          },
        });
      } else if (msg.method === 'tools/list') {
        if (tokenMode) {
          // 只下发令牌模式能用的三个工具：列了也用不了的工具只会让模型瞎试
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { tools: TOOL_SPECS_V2.filter((t) => TOKEN_TOOLS.has(t.name)) },
          });
          return;
        }
        const perm = currentPermission();
        const execOk = currentSettings().allowAgentExec;
        // 默认只下发 v2 的 9 个入口：27 个工具会让模型在近义工具间反复试探。
        // 需要字段/类型/集合等高级能力时，设 FLINTKEEP_MCP_PROFILE=full 一并下发。
        // 两处都能开：环境变量给脚本/CI，设置页开关给普通用户；任一为真即全量下发
        const fullBySettings = currentSettings().mcpFullTools === true;
        const profile = String(process.env.FLINTKEEP_MCP_PROFILE || 'core').toLowerCase();
        const specs = profile === 'full' || fullBySettings ? [...TOOL_SPECS_V2, ...TOOL_SPECS] : TOOL_SPECS_V2;
        // 不把用不了的工具列出来，避免 Agent 反复尝试后被拒
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: specs.filter((t) => isToolAllowed(t.name, perm) && (execOk || !EXEC_TOOLS.has(t.name))) },
        });
      } else if (msg.method === 'tools/call') {
        const res = await handleCall(msg.params?.name, msg.params?.arguments || {});
        send({ jsonrpc: '2.0', id: msg.id, result: res });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '方法不存在' } });
      }
    } catch (e) {
      // 协议层兜底：坏请求回错误响应，进程保持存活
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (e as Error).message || '内部错误' } });
    }
  });
}

// 直接以 `tsx src/core/mcp.ts` 运行时才启动 stdio 服务；被测试 import 时不启动
// 只比字面路径在软链场景会误判（macOS 的 /tmp → /private/tmp、项目目录被软链），
// 结果就是"进程起来了、一句话没有、静默退出"。用 realpath 兜一层。
const isMain = (() => {
  if (!process.argv[1]) return false;
  const direct = pathToFileURL(process.argv[1]).href === import.meta.url;
  if (direct) return true;
  try {
    const a = pathToFileURL(fs.realpathSync(process.argv[1])).href;
    const b = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
    return a === b;
  } catch {
    return false;
  }
})();
if (isMain) main();
