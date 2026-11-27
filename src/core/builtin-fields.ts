/**
 * 内置字段定义（单一来源）：资产清单的列、新增/编辑表单都从这里派生。
 *
 * - 后端用它校验「字段改名/显隐」的覆盖项、识内置 key；
 * - 前端用它渲染列与表单（含各字段的取值 getter、控件类型）。
 *
 * 这里只放「类型专属字段」。名称/类型/标签/分组/备注是公共区，不在此列。
 * key 必须与 schema.ts 的 Asset 字段一致；自定义字段不走这里（存 Asset.extra）。
 */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'password'
  | 'select'
  | 'date'
  | 'url'
  | 'tags'
  | 'ports';

export type BuiltinField = {
  key: string;
  /** 中文兜底名；展示优先用 shared/i18n 的 meta.field.<key> */
  label: string;
  kind: FieldKind;
  /** i18n key（form.hint.*），由 field-registry 翻译后展示 */
  hint?: string;
  secret?: boolean;
  /** kind=select 的固定选项 */
  options?: string[];
  /** 下拉选项来自「设置 → 字段选项」的注册表（field-catalog） */
  catalogKey?: string;
  /** 默认出现在列配置里 */
  listDefault?: boolean;
  /** 默认出现在新增/编辑表单里 */
  formDefault?: boolean;
  /** 列里用等宽字体 */
  mono?: boolean;
  /** 表单占两列 */
  span2?: boolean;
  /** 表单独占一行 */
  full?: boolean;
  /** 下拉收窄 */
  narrow?: boolean;
  /** 列取值（缺省直接取 a[key]） */
  get?: (a: any) => any;
  /** 表单提交时的值转换 */
  transform?: 'ports' | 'args' | 'json';
};

export const FIELD_KINDS: FieldKind[] = [
  'text',
  'textarea',
  'number',
  'password',
  'select',
  'date',
  'url',
  'tags',
  'ports',
];

/** 字段类型的中文名（界面下拉/表格统一用它，避免直接把 key 摆给用户看） */
export const FIELD_KIND_LABELS: Record<FieldKind, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  password: '密码/敏感',
  select: '下拉选项',
  date: '日期',
  url: '网址',
  tags: '标签',
  ports: '端口',
};

/** 平台账号的认证名称：按认证状态取对应字段 */
export function certName(a: any): string {
  if (a?.certStatus === '个人认证') return a.personalName || '';
  if (a?.certStatus === '企业认证') return a.enterpriseName || '';
  return a?.personalName || a?.enterpriseName || '';
}

const COMMON_LIST_FIELDS: BuiltinField[] = [
  { key: 'group', label: '分组', kind: 'text', formDefault: false },
  { key: 'note', label: '备注', kind: 'text', formDefault: false },
];

function withCommon(fields: BuiltinField[]): BuiltinField[] {
  return [...fields, ...COMMON_LIST_FIELDS.map((f) => ({ ...f }))];
}

export const BUILTIN_FIELDS: Record<string, BuiltinField[]> = {
  server: withCommon([
    {
      key: 'publicIp',
      label: '公网 IP',
      kind: 'text',
      hint: 'form.hint.server.publicIp',
      listDefault: true,
      mono: true,
      get: (a) => a.publicIp || a.ip,
    },
    { key: 'privateIp', label: '私网 IP', kind: 'text', listDefault: true, mono: true },
    { key: 'os', label: '系统', kind: 'text', listDefault: true },
    {
      key: 'openPorts',
      label: '开放端口',
      kind: 'ports',
      hint: 'form.hint.server.openPorts',
      listDefault: true,
      get: (a) => (a.openPorts || []).join(','),
      transform: 'ports',
    },
    { key: 'sshUser', label: 'SSH 用户(旧)', kind: 'text', listDefault: true, formDefault: false },
    {
      key: 'sshPort',
      label: 'SSH 端口(旧)',
      kind: 'number',
      listDefault: true,
      formDefault: false,
      get: (a) => a.sshPort || 22,
    },
  ]),

  ssh_key: withCommon([
    {
      key: 'sshHost',
      label: '主机(可选)',
      kind: 'text',
      hint: 'form.hint.ssh.sshHost',
      listDefault: true,
    },
    { key: 'sshPort', label: 'SSH 端口', kind: 'number', listDefault: true },
    { key: 'sshUser', label: 'SSH 用户名', kind: 'text', listDefault: true },
    {
      key: 'authMethod',
      label: '认证方式',
      kind: 'select',
      options: ['password', 'key'],
      hint: 'form.hint.ssh.authMethod',
      listDefault: true,
    },
    { key: 'sshPassword', label: 'SSH 密码', kind: 'password', secret: true, formDefault: true },
    {
      key: 'keyFileName',
      label: '来源文件名',
      kind: 'text',
      hint: 'form.hint.ssh.keyFileName',
    },
    {
      key: 'publicKey',
      label: '公钥',
      kind: 'textarea',
      hint: 'form.hint.ssh.publicKey',
    },
    {
      key: 'privateKeyEnc',
      label: '私钥内容',
      kind: 'textarea',
      secret: true,
      hint: 'form.hint.ssh.privateKeyEnc',
    },
    { key: 'keyPassphrase', label: '私钥口令(若有)', kind: 'password', secret: true },
  ]),

  cloud_account: withCommon([
    { key: 'provider', label: '厂商(阿里云/腾讯云/AWS)', kind: 'text', listDefault: true },
    { key: 'accessKeyId', label: 'AccessKeyId', kind: 'text', listDefault: true, mono: true },
    { key: 'secretAccessKey', label: 'SecretAccessKey', kind: 'password', secret: true },
    { key: 'region', label: '区域(Region)', kind: 'text', listDefault: true, mono: true, hint: 'form.hint.cloud.region' },
    { key: 'cloudService', label: '云服务', kind: 'text', formDefault: false },
    { key: 'baseUrl', label: '接口基址', kind: 'url', mono: true, formDefault: false },
  ]),

  oss: withCommon([
    { key: 'provider', label: '厂商', kind: 'text', listDefault: true },
    { key: 'bucket', label: 'Bucket', kind: 'text', listDefault: true, mono: true },
    { key: 'endpoint', label: 'Endpoint', kind: 'text', listDefault: true, mono: true },
    { key: 'region', label: '区域(Region)', kind: 'text', mono: true, hint: 'form.hint.oss.region' },
    { key: 'accessKeyId', label: 'AccessKeyId', kind: 'text', mono: true },
    { key: 'secretAccessKey', label: 'SecretAccessKey', kind: 'password', secret: true },
    { key: 'baseUrl', label: '接口基址', kind: 'url', mono: true, formDefault: false },
  ]),

  baota: withCommon([
    {
      key: 'panelUrl',
      label: '面板地址',
      kind: 'url',
      hint: 'form.hint.baota.panelUrl',
      listDefault: true,
      mono: true,
    },
    { key: 'baotaPort', label: '面板端口', kind: 'number', listDefault: true, hint: 'form.hint.baota.baotaPort' },
    { key: 'baotaUser', label: '用户名', kind: 'text', listDefault: true },
    { key: 'baotaPassword', label: '密码', kind: 'password', secret: true },
    { key: 'baotaApiKey', label: 'API Key', kind: 'password', secret: true },
    { key: 'baseUrl', label: '代理目标 baseUrl', kind: 'url', mono: true, formDefault: false },
  ]),

  mcp: withCommon([
    { key: 'transport', label: '传输', kind: 'select', options: ['stdio', 'http'], listDefault: true },
    { key: 'command', label: '启动命令', kind: 'text', listDefault: true, mono: true },
    { key: 'args', label: '参数', kind: 'text', hint: 'form.hint.mcp.args', transform: 'args' },
    { key: 'envEnc', label: '环境变量(JSON, secret)', kind: 'textarea', secret: true, transform: 'json' },
  ]),

  api_key: withCommon([
    {
      key: 'provider',
      label: '厂商/平台',
      kind: 'select',
      options: ['火山引擎', '阿里云百炼', '阿里云', 'OpenAI', 'DeepSeek', '腾讯混元', '智谱', '月之暗面', '自定义'],
      listDefault: true,
    },
    { key: 'username', label: '账号/应用名(可选)', kind: 'text', listDefault: true },
    { key: 'secret', label: 'API Key / Secret', kind: 'password', secret: true },
    {
      key: 'baseUrl',
      label: 'API 基址(可选)',
      kind: 'url',
      hint: 'form.hint.api.baseUrl',
      mono: true,
      full: true,
    },
    {
      key: 'proxyInjectMode',
      label: '代理注入模式',
      kind: 'select',
      options: ['', 'header', 'basic'],
      hint: 'form.hint.api.proxyMode',
      full: true,
      formDefault: true,
    },
    {
      key: 'proxyInjectHeader',
      label: '自定义头名',
      kind: 'text',
      hint: 'form.hint.api.proxyHeader',
      full: true,
    },
  ]),

  login_account: withCommon([
    {
      key: 'provider',
      label: '平台/网站',
      kind: 'select',
      catalogKey: 'login_account.provider',
      hint: 'form.hint.login.provider',
      span2: true,
      listDefault: true,
    },
    { key: 'username', label: '登录名/用户名', kind: 'text', listDefault: true },
    { key: 'phone', label: '手机号', kind: 'text' },
    { key: 'email', label: '邮箱', kind: 'text' },
    { key: 'loginUrl', label: '登录地址(可选)', kind: 'url', mono: true },
    { key: 'secret', label: '登录密码', kind: 'password', secret: true },
    { key: 'certStatus', label: '认证状态', kind: 'select', options: ['个人认证', '企业认证'], narrow: true, listDefault: true },
    { key: 'personalName', label: '个人认证名称(选填)', kind: 'text' },
    { key: 'enterpriseName', label: '企业认证名称(选填)', kind: 'text' },
    { key: 'certName', label: '认证名称', kind: 'text', formDefault: false, get: (a) => certName(a) },
  ]),

  email_account: withCommon([
    { key: 'provider', label: '邮箱服务商', kind: 'text', hint: 'form.hint.email.provider', listDefault: true },
    { key: 'email', label: '邮箱地址', kind: 'text', listDefault: true, mono: true },
    { key: 'secret', label: '密码/授权码', kind: 'password', secret: true, hint: 'form.hint.email.secret' },
    { key: 'recoveryEmail', label: '辅助/恢复邮箱', kind: 'text', listDefault: true },
    { key: 'phone', label: '绑定手机号', kind: 'text' },
    { key: 'loginUrl', label: '登录入口(可选)', kind: 'url', mono: true },
  ]),

  project: withCommon([
    { key: 'kind', label: '项目种类', kind: 'text', listDefault: true, hint: 'form.hint.project.kind' },
    { key: 'status', label: '状态', kind: 'select', options: ['live', 'test', 'dev', 'idea', 'paused', 'archived'], listDefault: true },
    { key: 'progress', label: '进度(0-100)', kind: 'number', listDefault: true },
    { key: 'version', label: '版本', kind: 'text', listDefault: true },
    { key: 'color', label: '机柜色条', kind: 'text', hint: 'form.hint.project.color', mono: true },
    { key: 'start', label: '开始日期', kind: 'date', listDefault: true },
    { key: 'users', label: '用户数', kind: 'number', listDefault: true },
    { key: 'client', label: '客户', kind: 'text' },
    { key: 'contract', label: '合同金额(元)', kind: 'number', listDefault: true },
    { key: 'stack', label: '技术栈', kind: 'tags', hint: 'form.hint.project.stack', get: (a) => (a.stack || []).join(',') },
    {
      key: 'envs',
      label: '环境变量名',
      kind: 'tags',
      hint: 'form.hint.project.envs',
      get: (a) => (a.envs || []).join(','),
    },
    { key: 'desc', label: '简介', kind: 'textarea' },
  ]),

  note: [
    { key: 'content', label: '正文', kind: 'textarea', listDefault: true },
  ],
};

/** 每个 scope 的内置 key 集合，供后端校验覆盖项 */
export const BUILTIN_KEYS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(BUILTIN_FIELDS).map(([scope, fields]) => [scope, new Set(fields.map((f) => f.key))])
);

export function isKnownBuiltin(scope: string, key: string): boolean {
  return !!BUILTIN_KEYS[scope]?.has(key);
}

/** 默认列（用于「恢复默认」与后端缺省） */
export function defaultColumns(scope: string): string[] {
  return (BUILTIN_FIELDS[scope] || []).filter((f) => f.listDefault).map((f) => f.key);
}
