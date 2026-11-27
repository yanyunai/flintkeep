// 数据模型定义：覆盖服务器 / SSH密钥 / 云账号 / OSS / 宝塔 / MCP / 通用密钥 / 登录账号
// 所有敏感字段（密码、私钥、AK/SK、API Key）在“列出/搜索”时会被剥离，只在显式 get 时返回，并写审计。

import { t, hasKey, type MsgKey } from '../shared/i18n';

export type AssetType =
  | 'server'
  | 'ssh_key'
  | 'cloud_account'
  | 'oss'
  | 'baota'
  | 'mcp'
  | 'api_key'
  | 'login_account'
  | 'email_account'
  | 'note'
  | 'project';

/** 资产之间的关联角色（谁相对谁） */
export type LinkRole =
  | 'ssh_key' // 使用的 SSH 密钥
  | 'baota' // 管理用的宝塔面板
  | 'cloud' // 所属云 API 账号
  | 'oss' // 关联对象存储
  | 'login' // 控制台 / 网站登录账号
  | 'server' // 所属 / 对应的服务器
  | 'mcp'
  | 'api_key'
  | 'email_account' // 关联邮箱账号
  | 'related'; // 其它关联

export interface AssetLink {
  id: string;
  role?: LinkRole | string;
  /** 关联到项目的哪个入口（url 键，如 admin/web；平台账号挂在入口上时使用） */
  entry?: string;
}

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  tags: string[];
  group?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;

  /** 关联其它资产（存对方 id + 角色；反向关联由查询时扫描得出） */
  links?: AssetLink[];

  // rotation 轮换提醒
  rotationReminderDays?: number;
  lastRotatedAt?: string;

  // server：机器信息（登录凭证放到关联的 ssh_key）
  ip?: string; // 兼容旧数据；新数据请用 publicIp
  publicIp?: string; // 公网 IP（连机默认）
  privateIp?: string; // 私网 IP
  os?: string;
  openPorts?: number[];
  sshKeyId?: string; // 兼容旧字段；保存时可由 role=ssh_key 的 link 同步

  // 旧版曾写在 server 上的 SSH 字段（迁移后应落到 ssh_key；读取时作回退）
  sshPort?: number;
  authMethod?: 'password' | 'key';
  sshUser?: string;
  sshPassword?: string;

  // ssh_key / SSH 登录：端口、用户、密码或私钥
  sshHost?: string; // 可选；连服务器时优先用服务器公网 IP，此项可作独立登录主机
  publicKey?: string;
  privateKeyEnc?: string; // 私钥 PEM/OpenSSH 明文（保险库内加密存储）
  keyPassphrase?: string;
  keyFileName?: string; // 上传时的原文件名，如 198.51.100.10_id_ed25519
  keyFileRel?: string; // 独立目录相对路径，如 ssh_keys/<id>.key.enc（同样经主密钥加密，非明文落盘）

  // cloud_account / oss / login_account.provider
  provider?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  cloudService?: string;
  cloudVersion?: string;
  region?: string;

  // oss
  bucket?: string;
  endpoint?: string;

  // 腾讯云旧字段名：部分 CLI 同步/旧数据用 secretId/secretKey，读取时作回退
  secretId?: string;
  secretKey?: string;

  // baota
  panelUrl?: string;
  baotaPort?: number; // 面板端口，默认常见 8888；可与 panelUrl 分开填
  baotaUser?: string;
  baotaPassword?: string;
  baotaApiKey?: string;

  // mcp
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  envEnc?: Record<string, string>;

  // api_key / login_account
  username?: string;
  secret?: string;

  // login_account 额外（provider 选项列表见 data/field_catalog.json，设置页可维护）
  phone?: string;
  email?: string;
  loginUrl?: string;

  // login_account 认证信息：认证状态 + 对应认证名称（均选填）
  certStatus?: 'personal' | 'enterprise'; // personal=个人认证, enterprise=企业认证
  personalName?: string; // 个人认证名称
  enterpriseName?: string; // 企业认证名称

  // note 备忘录：正文（多行），随保险库一起加密存储
  content?: string;

  // project 项目（机房场景设备；docs/09 数据模型）
  kind?: string;                 // 项目种类：Web 应用 / iOS / API 服务 / 外包…
  status?: string;               // live | test | dev | idea | paused | archived
  progress?: number;             // 0-100（开发中项目显示进度壳）
  version?: string;
  color?: string;                // 机房设备色条
  start?: string;                // 开始日期 YYYY-MM-DD
  users?: number;                // 用户数
  client?: string;               // 客户 / 甲方
  contract?: number;             // 合同金额（元）
  envs?: string[];               // 环境变量名清单（只存名字，值另建密钥资产）
  /** 里程碑：上线/交付节点，done 表示已完成 */
  milestones?: { id: string; name: string; date?: string; done?: boolean }[];
  desc?: string;
  stack?: string[];              // 技术栈
  urls?: Record<string, string>; // web前端 api后端 db数据库 admin后台 repo仓库 deploy部署 pay收款 stats统计 docs文档 design设计稿

  /**
   * 稳定序号：每个类型独立编号（server 1,2,3…；cloud_account 1,2,3…）。
   * 创建时落库、删除不回收 —— 保证"跟 Agent 说服务器 3 号"永远指向同一台机器，
   * 不随列表排序/筛选变化。旧数据在 reload 时自动补号（按创建时间顺序）。
   */
  no?: number;

  // Model B 代理
  baseUrl?: string;
  proxyInject?: {
    mode: 'header' | 'basic' | 'baota' | 'aws' | 'aliyun' | 'tencent';
    headerName?: string;
  };

  /** 机房场景机位号（1-8：左列 1-4、右列 5-8；1 号位默认放第一台 server，其余点空位添加/认领） */
  upsSlot?: number;

  /**
   * 用户自定义字段的值（key 由 data/field_schema.json 定义，形如 cf_a1b2c3d4）。
   * 只用于展示/搜索/导出，不参与任何业务逻辑；敏感字段仍随整库加密。
   */
  extra?: Record<string, unknown>;
}

export const SECRET_FIELDS: (keyof Asset)[] = [
  'sshPassword',
  'keyPassphrase',
  'privateKeyEnc',
  'secretAccessKey',
  // 腾讯云旧字段名：AI 用量会读它们做回退，列表/搜索同样必须脱敏
  'secretId',
  'secretKey',
  'baotaPassword',
  'baotaApiKey',
  'secret',
  'envEnc',
];

/**
 * 剥离敏感字段。extraSecretKeys 是用户自定义字段里的敏感 key（来自字段定义），
 * 列表/搜索时同样不能返回；显式 get_asset 不走这里。
 */
export function stripSecrets(a: Asset, extraSecretKeys?: Set<string>): Asset {
  const copy: Asset = { ...a };
  for (const f of SECRET_FIELDS) delete (copy as any)[f];
  if (copy.extra) {
    const extra: Record<string, unknown> = { ...copy.extra };
    if (extraSecretKeys) for (const k of extraSecretKeys) delete extra[k];
    copy.extra = extra;
  }
  return copy;
}

export const TYPE_LABELS: Record<AssetType, string> = {
  server: '服务器',
  ssh_key: 'SSH 登录',
  cloud_account: '云账号(API)',
  oss: '对象存储 OSS',
  baota: '宝塔面板',
  mcp: 'MCP 服务',
  api_key: 'API/模型密钥',
  login_account: '平台账号',
  email_account: '邮箱账号',
  note: '备忘录',
  project: '项目',
};

export const LINK_ROLE_LABELS: Record<string, string> = {
  login: '平台账号',
  ssh_key: 'SSH 登录',
  baota: '宝塔面板',
  cloud: '云 API 账号',
  oss: '对象存储',
  server: '服务器',
  mcp: 'MCP',
  api_key: 'API 密钥',
  email_account: '邮箱账号',
  related: '全部类型',
  project: '所属项目',
};

/**
 * 下面四个解析函数是「带语言的展示名」入口：
 * 内置 key 走 i18n 字典，未知（用户自定义）原样返回中文，不会丢信息。
 * 不要直接用 TYPE_LABELS / LINK_ROLE_LABELS 渲染，那是中文常量，只作兜底与兼容。
 */
function lookup(prefix: string, key: string, fallback: Record<string, string>): string {
  const dictKey = `${prefix}.${key}`;
  if (hasKey(dictKey)) return t(dictKey as MsgKey);
  return fallback[key] || key;
}

/** 资产类型名，如 server → 服务器 / Server */
export function typeLabel(type: string): string {
  return lookup('meta.type', type, TYPE_LABELS as Record<string, string>);
}

/** 关联角色名，如 login → 平台账号 / Platform Account */
export function roleLabel(role: string): string {
  return lookup('meta.role', role, LINK_ROLE_LABELS);
}

/** 项目/资产状态名，如 live → 运行中 / Live */
export function statusLabel(status: string): string {
  return lookup('meta.status', status, {});
}

/**
 * 老数据的兼容：早期自定义类型的 category 存的是中文名（如「自定义」），
 * 这里先归一到 key，否则切到英文后分组标题还是中文。
 */
const CATEGORY_ALIASES: Record<string, string> = {
  项目: 'project',
  云资源: 'cloud',
  账号与密钥: 'account',
  自定义: 'custom',
  其他: 'other',
};

/** 资产分类名；自定义分类原样返回 */
export function categoryLabel(category: string): string {
  return lookup('meta.category', CATEGORY_ALIASES[category] || category, {});
}

/**
 * 审计/列头里的字段名，如 publicIp → 公网 IP / Public IP。
 * fallback 用于字典还没覆盖的字段（自定义字段或新加的字段），保持原文不丢信息。
 */
export function fieldNameLabel(key: string, fallback?: Record<string, string>): string {
  return lookup('meta.field', key, fallback || {});
}

/** 自定义字段类型名，如 text → 单行文本 / Text */
export function fieldKindLabel(kind: string): string {
  return lookup('meta.kind', kind, {});
}

/** 操作来源：user / agent / system */
export function actorLabel(actor: string): string {
  return lookup('meta.actor', actor, {});
}

/** 是否有对应的审计动作文案（没有就原样显示 action） */
export function auditActionLabel(action: string): string | null {
  const k = `meta.audit.${action}`;
  return hasKey(k) ? k : null;
}

/** 按目标资产类型推荐的关联角色 */
export function suggestLinkRole(targetType: AssetType): LinkRole {
  switch (targetType) {
    case 'ssh_key':
      return 'ssh_key';
    case 'baota':
      return 'baota';
    case 'cloud_account':
      return 'cloud';
    case 'oss':
      return 'oss';
    case 'login_account':
      return 'login';
    case 'server':
      return 'server';
    case 'mcp':
      return 'mcp';
    case 'api_key':
      return 'api_key';
    case 'email_account':
      return 'email_account';
    default:
      return 'related';
  }
}

/** 关联角色 → 候选资产类型；related / 未知 → null（不过滤） */
export function linkRoleToAssetType(role?: string): AssetType | null {
  switch (role) {
    case 'ssh_key':
      return 'ssh_key';
    case 'baota':
      return 'baota';
    case 'cloud':
      return 'cloud_account';
    case 'oss':
      return 'oss';
    case 'login':
      return 'login_account';
    case 'server':
      return 'server';
    case 'mcp':
      return 'mcp';
    case 'api_key':
      return 'api_key';
    case 'email_account':
      return 'email_account';
    default:
      return null;
  }
}

/** 从 links / sshKeyId 解析 SSH 密钥资产 id */
export function resolveSshKeyId(a: Asset): string | undefined {
  if (a.sshKeyId) return a.sshKeyId;
  const hit = (a.links || []).find((l) => l.role === 'ssh_key');
  return hit?.id;
}

/** 连机主机：默认公网（publicIp → 旧 ip → 私网） */
export function resolveServerHost(server: Asset, prefer: 'public' | 'private' = 'public'): string {
  const pub = String(server.publicIp || server.ip || '').trim();
  const priv = String(server.privateIp || '').trim();
  if (prefer === 'private') return priv || pub;
  return pub || priv;
}

/** 名称或 IP 是否命中该服务器（含公网/私网/旧 ip） */
export function serverMatchesNameOrIp(server: Asset, nameOrIp: string): boolean {
  const key = nameOrIp.toLowerCase();
  if (server.name.toLowerCase() === key) return true;
  for (const v of [server.publicIp, server.privateIp, server.ip]) {
    if (v && String(v).toLowerCase() === key) return true;
  }
  return false;
}

/** 名称像「…服务器ssh」这类误建在 server 下的登录项 */
export function looksLikeSshCredentialServer(a: Asset): boolean {
  if (a.type !== 'server') return false;
  const n = (a.name || '').trim();
  if (!/ssh$/i.test(n) && !/服务器\s*ssh/i.test(n)) return false;
  // 没有明显机器档案字段时更倾向整条转为 SSH 登录
  const hasInventory = !!(a.privateIp || a.os || (a.openPorts && a.openPorts.length));
  return !hasInventory;
}

export function serverHasInlineSshCreds(a: Asset): boolean {
  return !!(
    a.sshPassword ||
    a.sshUser ||
    a.sshPort ||
    a.authMethod ||
    a.privateKeyEnc
  );
}

export const LLM_PROVIDERS = [
  '火山引擎',
  '阿里云百炼',
  '阿里云',
  'OpenAI',
  'DeepSeek',
  '腾讯混元',
  '智谱',
  '月之暗面',
  '自定义',
] as const;

/** 项目入口（urls 键）统一清单：项目详情页与工作台快捷入口共用 */
export const URL_ENTRIES: { k: string; label: string }[] = [
  { k: 'web', label: '前端' },
  { k: 'api', label: '后端' },
  { k: 'db', label: '数据库' },
  { k: 'admin', label: '管理后台' },
  { k: 'repo', label: '代码仓库' },
  { k: 'deploy', label: '部署平台' },
  { k: 'pay', label: '收款' },
  { k: 'stats', label: '统计' },
  { k: 'docs', label: '文档' },
  { k: 'design', label: '设计稿' },
];

const URL_ENTRY_LABELS: Record<string, string> = Object.fromEntries(URL_ENTRIES.map((e) => [e.k, e.label]));

/** 入口名（前端/后端/…），跟随语言；自定义 key 原样返回 */
export function urlEntryLabel(k: string): string {
  return lookup('meta.url', k, URL_ENTRY_LABELS);
}
