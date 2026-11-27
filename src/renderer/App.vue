<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue';
import {
  LINK_ROLE_LABELS,
  linkRoleToAssetType,
  URL_ENTRIES,
  SECRET_FIELDS,
  actorLabel,
  auditActionLabel,
  categoryLabel,
  fieldKindLabel,
  fieldNameLabel,
  roleLabel,
  statusLabel,
  urlEntryLabel,
  typeLabel as schemaTypeLabel,
} from '../core/schema';
import { FIELD_DEFS } from '../core/field-catalog-defs';
import McpGuide from './McpGuide.vue';
import SettingsPanel from './SettingsPanel.vue';
import MyProjects from './MyProjects.vue';
import AssetsView from './views/AssetsView.vue';
import WhitelistView from './views/WhitelistView.vue';
import MemoView from './views/MemoView.vue';
import AuditView from './views/AuditView.vue';
import IdeasView from './views/IdeasView.vue';
import TasksView from './views/TasksView.vue';
import FinanceView from './views/FinanceView.vue';
import ProjectsView from './views/ProjectsView.vue';
import DocsView from './views/DocsView.vue';
import StudioView from './views/StudioView.vue';
import { uiMode, uiTheme, uiTemplate, sideOpen } from './ui/appearance';
import { createApi } from './api-client';
import { sideIcon } from './ui/icons';
import { lang, useT, syncLangFromServer } from './ui/i18n';
import { df } from '../shared/i18n';
import { columnPool, formFieldsFor, defaultColumnKeys, customFormValue, customFieldLabel, isCustomSecret } from './field-registry';
import type { FieldSchema } from '../core/field-schema';
import type { AssetTypeDef } from '../core/asset-types';
import { BUILTIN_TYPE_META } from '../core/asset-type-meta';
import { FIELD_KINDS, BUILTIN_FIELDS, type FieldKind } from '../core/builtin-fields';
// 类型标签由后端返回；字段配置用于动态渲染表单
const types = ref<Record<string, string>>({});
const assets = ref<any[]>([]);
const audit = ref<any[]>([]);
const auditTotal = ref(0);
const auditPage = ref(1);
const auditPageSize = ref(20);
const filter = ref('');
/** 首屏落在「机房」页 */
const tab = ref<'myprojects' | 'assets' | 'studio' | 'aiusage' | 'audit' | 'mcp' | 'settings' | 'whitelist' | 'memo' | 'aiassistant' | 'ideas' | 'tasks' | 'finance' | 'projects' | 'docs'>('studio');

/**
 * 侧栏「工作台」分组的入口顺序与文案。
 * 这些原来指向 旧版工作台内嵌页 的 iframe 页面，现在全部是自有页面。
 * icon：src/renderer/ui/icons.ts 里的线性 SVG 图标 key（此前这些动态项只能用 ◦ 占位）。
 */
const OPC_PAGES = [
  { k: 'studio', labelKey: 'shell.nav.studio', icon: 'studio' },
  { k: 'projects', labelKey: 'shell.nav.projects', icon: 'projects' },
  { k: 'finance', labelKey: 'shell.nav.finance', icon: 'finance' },
  { k: 'tasks', labelKey: 'shell.nav.tasks', icon: 'tasks' },
  { k: 'ideas', labelKey: 'shell.nav.ideas', icon: 'ideas' },
  { k: 'docs', labelKey: 'shell.nav.docs', icon: 'docs' },
] as const;

/** 翻译函数：模板里统一用 tr()，避免和 v-for="t in …" 的循环变量撞名 */
const tr = useT();

/** 入口 key → 自有页面 tab */
const OWN_PAGES: Record<string, string> = { studio: 'studio', ideas: 'ideas', tasks: 'tasks', finance: 'finance', projects: 'projects', docs: 'docs' };
function navOpc(k: string) {
  // 所有 OPC 入口都已有自有页面；万一还有没映射的，落到机房页而不是白屏
  tab.value = (OWN_PAGES[k] || 'studio') as any;
}

/** 侧栏当前页高亮：入口 key 映射到自有页面 tab 后直接比对 */
function isNavOn(k: string): boolean {
  return !!OWN_PAGES[k] && tab.value === OWN_PAGES[k];
}

/** 「项目」页的数据：资产库里的 project 类型资产（不是 collections.projects 那张空表） */
const projectList = computed(() => assets.value.filter((a: any) => a.type === 'project'));

// ===== 深色模式// ===== 深色模式（Apple：纯黑 #000 底 + #272729 表面 + 亮蓝 #2997ff 强调） =====
/**
 * 经典壳的深浅色只是 `uiTheme` 的别名：主题真源唯一在 `ui/appearance.ts`（`mgui.theme`）。
 * 以前这里自己读 `mg-theme`、默认 light，和新模板的 `mgui.theme`（默认 dark）各走一套，
 * 结果「只设过 mg-theme，新模板仍是深色」。
 */
const theme = computed<'light' | 'dark'>({
  get: () => uiTheme.value,
  set: (v) => {
    uiTheme.value = v;
  },
});
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme.value);
}
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
}
applyTheme();
// 新模板侧切换（侧栏按钮）或旧键迁移后，html 上的属性也要立即跟上
watch(uiTheme, () => applyTheme());

const detail = ref<any | null>(null);
const showSecrets = ref(false);
const editing = ref<any | null>(null); // null=关闭, 'new'=新建, object=编辑
/** 保存成功后自增：抽屉据此退出编辑态、刷新只读内容 */
const editVersion = ref(0);
const formType = ref('server');
const form = ref<any>({});
const formReveal = ref<Record<string, boolean>>({}); // 表单里各敏感字段的「眼睛」显隐
const formLinks = ref<{ id: string; role?: string }[]>([]);
/** 项目入口地址（asset.urls：web/api/db/admin/…）；单独存一份，避免 form 里嵌套对象被整体覆盖 */
const formUrls = ref<Record<string, string>>({});
/** 项目里程碑（asset.milestones）：数组，同样单独存，增删行不影响表单其它字段 */
const formMilestones = ref<{ id: string; name: string; date?: string; done?: boolean }[]>([]);
function addMilestone() {
  formMilestones.value.push({
    id: 'ms_' + Math.random().toString(36).slice(2, 8),
    name: '',
    date: '',
    done: false,
  });
}
const linkPickId = ref('');
const linkPickRole = ref('related');
const issueInfo = ref<any | null>(null);
/** 字段选项目录（设置页可维护；key = type.field） */
const fieldCatalog = ref<Record<string, { options: string[]; allowCustom: boolean }>>({});
/** 资产类型标签颜色（设置页可配置；键为 AssetType） */
const typeColors = ref<Record<string, string>>({});

/** 按背景亮度选对比色：深色自定义类型上用白字，浅色上用深字 */
function readableOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#1f2328' : '#ffffff';
}

/** 类型标签自定义颜色；未配置则回落 CSS 默认色 */
function typeStyle(t: string) {
  const c = typeColors.value[t];
  if (!c) return undefined;
  // 不要给 borderColor：那会把 CSS 里配好的描边染成背景色，标签看着像没边框
  // 自定义类型没有专属 CSS，前景色要一起给，否则深蓝底会配深灰字
  return t.startsWith('ct_') ? { background: c, color: readableOn(c) } : { background: c };
}

/** 内置字段的中文名兑底：meta.field.* 没覆盖的 key（如 certStatus）跟表单同一套 label */
const BUILTIN_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_FIELDS)
    .flat()
    .map((f) => [f.key, f.label]),
);

/**
 * 分类筛选按钮的颜色：选中时不加内联底色。
 * 原因：内联样式优先级高于 CSS，会把 .on 的高亮背景盖成浅色，
 * 而 .on 的文字是白色 → 变成「浅底白字」看着像一片白。选中态交给 CSS 处理。
 */
function chipStyle(k: string) {
  // 选中态交给 CSS（自定义类型用强调蓝），避免内联浅底盖掉选中色
  return filter.value === k ? undefined : typeStyle(k);
}

/** 平台账号的认证名称（按认证状态取对应字段） */
function certName(a: any): string {
  if (a?.certStatus === '个人认证') return a.personalName || '';
  if (a?.certStatus === '企业认证') return a.enterpriseName || '';
  return a?.personalName || a?.enterpriseName || '';
}

/** 自定义字段的非空值（跳过敏感字段，列表不展示） */
function customExtraPairs(a: any): { label: string; text: string }[] {
  const extra = a?.extra || {};
  const out: { label: string; text: string }[] = [];
  for (const f of fieldSchema.value.custom || []) {
    if (f.scope !== a?.type && f.scope !== '*') continue;
    if (f.secret) continue;
    const raw = extra[f.key];
    if (raw === null || raw === undefined || raw === '') continue;
    out.push({ label: f.label, text: Array.isArray(raw) ? raw.join(',') : String(raw) });
  }
  return out;
}

/** 通用「关键信息」文本：用于全部 / 待轮换 / 搜索结果等混合视图 */
function metaText(a: any): string {
  const t = a?.type;
  if (t === 'server') {
    const parts = [
      tr('assets.meta.public', { ip: a.publicIp || a.ip || '—' }),
      a.privateIp ? tr('assets.meta.private', { ip: a.privateIp }) : '',
      tr('assets.meta.ports', { ports: (a.openPorts || []).join(',') || '—' }),
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (t === 'ssh_key') {
    return `${a.sshUser || 'root'}${a.sshHost ? '@' + a.sshHost : ''}:${a.sshPort || 22}${a.keyFileName ? ' · ' + a.keyFileName : ''}`;
  }
  if (t === 'cloud_account' || t === 'oss') return [a.provider, a.region].filter(Boolean).join(' · ') || '—';
  if (t === 'baota') return `${a.panelUrl || '—'}${a.baotaPort ? ':' + a.baotaPort : ''}`;
  if (t === 'api_key') return [a.provider || 'API', a.baseUrl || a.username || a.note].filter(Boolean).join(' · ');
  if (t === 'login_account') {
    const base = a.phone || a.email || a.username || '—';
    const inner = a.certStatus ? `${a.certStatus}${certName(a) ? ' · ' + certName(a) : ''}` : '';
    return base + (inner ? tr('assets.meta.cert', { v: inner }) : '');
  }
  if (t === 'email_account') return `${a.email || '—'}${a.provider ? ' · ' + a.provider : ''}`;
  // 自定义类型：没有内置摘要规则，取前两个非空的自定义字段
  const pairs = customExtraPairs(a);
  if (pairs.length) return pairs.slice(0, 2).map((p) => `${p.label} ${p.text}`).join(' · ');
  return a?.group || a?.note || '—';
}


/** 后端保存的列配置：{ [AssetType]: 字段 key 列表 } */
const columnConfig = ref<Record<string, string[]>>({});
async function loadColumnConfig() {
  try {
    const r = await api('GET', '/column-config');
    columnConfig.value = r?.columns || {};
  } catch {
    /* 旧服务端无此接口时忽略 */
  }
}

/**
 * 字段定义：内置默认在 core/builtin-fields.ts，用户改名/显隐与自定义字段存 data/field_schema.json。
 * 列池与表单都从这里派生，不再写死在页面里。
 */
const fieldSchema = ref<FieldSchema>({ version: 1, overrides: {}, custom: [] });
async function loadFieldSchema() {
  try {
    const r = await api('GET', '/field-schema');
    if (r && r.version === 1) fieldSchema.value = r;
  } catch {
    /* 旧服务端无此接口时退回内置默认 */
  }
}
function colsFor(type: string) {
  return columnPool(type, fieldSchema.value);
}
/** 设置页保存后：字段定义、类型列表与颜色都可能变，重新拉一遍 */
function onSettingsSaved() {
  loadFieldCatalog();
  loadFieldSchema();
  loadAssetTypes();
}

/**
 * 混合视图（全部 / 待轮换 / 搜索）用的列。
 * 这里只留一列「关键信息」：以前「平台/厂商」对服务器/SSH 永远是「—」，
 * 白白占一列宽度，还把真正要看的 IP、端口挤成两行。
 */
const fallbackColumns = computed(() => [{ key: 'meta', label: tr('assets.col.meta'), get: metaText }]);

/** 当前视图使用的列：具体类型用其配置列，混合视图用回退列 */
const activeColumns = computed(() => {
  void lang.value; // 列标题跟语言走
  const t = searchResults.value ? '' : filter.value;
  if (!t || t === 'due') return fallbackColumns.value;
  const pool = colsFor(t);
  if (!pool.length) return fallbackColumns.value;
  const keys = columnConfig.value[t]?.length ? columnConfig.value[t] : defaultColumnKeys(t, fieldSchema.value);
  const cols = keys.map((k) => pool.find((f) => f.key === k)).filter(Boolean) as typeof pool;
  return cols.length ? cols : fallbackColumns.value;
});

// ===== 列配置弹窗（每个类型独立） =====
const colEditorOpen = ref(false);
const colEditorType = ref('');
const colEditorSel = ref<string[]>([]);

function openColEditor() {
  const t = filter.value;
  if (!t || t === 'due') return;
  colEditorType.value = t;
  colEditorSel.value = columnConfig.value[t]?.length
    ? [...columnConfig.value[t]]
    : [...defaultColumnKeys(t, fieldSchema.value)];
  colEditorOpen.value = true;
}
// 列配置弹窗里的字段搜索（字段多的类型一屏放不下）
const colSearch = ref('');
const colPoolList = computed(() => colsFor(colEditorType.value));
const colPoolFiltered = computed(() => {
  const q = colSearch.value.trim().toLowerCase();
  if (!q) return colPoolList.value;
  return colPoolList.value.filter(
    (f: any) => String(f.label).toLowerCase().includes(q) || String(f.key).toLowerCase().includes(q)
  );
});

function toggleCol(key: string) {
  colEditorSel.value = colEditorSel.value.includes(key)
    ? colEditorSel.value.filter((k) => k !== key)
    : [...colEditorSel.value, key];
}
function moveCol(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= colEditorSel.value.length) return;
  const next = [...colEditorSel.value];
  const tmp = next[i];
  next[i] = next[j];
  next[j] = tmp;
  colEditorSel.value = next;
}
function resetColEditor() {
  colEditorSel.value = [...defaultColumnKeys(colEditorType.value, fieldSchema.value)];
}
function labelOfKey(type: string, key: string): string {
  const f = colsFor(type).find((x) => x.key === key);
  return f ? f.label : key;
}
async function saveColEditor() {
  const r = await api('PUT', '/column-config', { type: colEditorType.value, keys: colEditorSel.value });
  columnConfig.value = r?.columns || {};
  colEditorOpen.value = false;
}

/** 各字段列的默认宽度（px）：关键信息要宽，其余等宽 */
const COL_WIDTHS: Record<string, number> = { meta: 380, provider: 130, category: 110 };
/** 列宽（px）：固定列 + 中间字段列；列多时表格横向滚动，不压缩内容 */
const colWidths = computed(() => {
  const mid = activeColumns.value.map((c) => COL_WIDTHS[c.key] || 120);
  return [44, 200, 120, ...mid, 110, 132];
});
/** 带 catalog 的字段：下拉是否处于「自定义…」 */
const catalogCustom = ref<Record<string, boolean>>({});
const CATALOG_CUSTOM = '__custom__';

// 解锁：服务端默认锁定，桌面端先输口令解锁再展示数据
const locked = ref(false);
const passphrase = ref('');
/** 双因子库的第二把钥匙：解锁页按需显示，成功后立刻清空 */
const secretKey = ref('');
const needSk = ref(false);
const skHint = ref('');
/** 手输 SK 后是否记住到本机（默认勾选：同机每次手抄 28 位太折磨） */
const rememberSk = ref(true);
const unlockError = ref('');
const unlocking = ref(false);
const showPass = ref(false);


// 云/宝塔等也可配 Model B HTTP 代理字段（与类型字段合并展示）
const PROXY_FIELDS = [
  {
    k: 'baseUrl',
    labelKey: 'meta.field.proxyBaseUrl',
    full: true,
    hintKey: 'form.hint.proxy.baseUrl',
  },
  {
    k: 'proxyInjectMode',
    labelKey: 'meta.field.proxyInjectMode',
    select: ['', 'header', 'basic', 'baota', 'aws', 'aliyun', 'tencent'],
    full: true,
    hintKey: 'form.hint.proxy.mode',
  },
  {
    k: 'proxyInjectHeader',
    labelKey: 'meta.field.proxyInjectHeader',
    full: true,
    hintKey: 'form.hint.proxy.header',
  },
];

const COMMON_BASIC = computed(() => [
  { k: 'name', label: tr('form.fieldName'), required: true },
  { k: 'tags', label: tr('form.fieldTags') },
  { k: 'group', label: tr('meta.field.group') },
]);

// 轮换提醒：每个资产可设“多少天提醒换密 + 最近换密日期”
const ROTATION = computed(() => [
  { k: 'rotationReminderDays', label: tr('meta.field.rotationReminderDays'), num: true },
  { k: 'lastRotatedAt', label: tr('meta.field.lastRotatedAt'), date: true },
]);

function isDue(a: any) {
  if (!a.rotationReminderDays || !a.lastRotatedAt) return false;
  const due = new Date(a.lastRotatedAt).getTime() + a.rotationReminderDays * 86400000;
  return Date.now() >= due;
}

/** 资产类型（内置 + 用户自定义），来自 /api/asset-types；未加载时回退 /api/types */
const assetTypes = ref<AssetTypeDef[]>([]);
const typeKeys = computed(() => {
  const list = assetTypes.value.length
    ? assetTypes.value
    // ct_* 是用户自建类型：key 是内部标识，不能让 label 走内置字典把它翻成 key 本身
    : Object.entries(types.value).map(([key, label], i) => ({ key, label, category: '', order: i, builtin: !key.startsWith('ct_') }));
  return list.filter((t) => t.key !== 'note').map((t) => t.key);
});
/** 顶部 tab 按分类分组；note（备忘）是独立页，不在这里 */
const typeGroups = computed(() => {
  void lang.value; // 语言切换后重新算分组标题与类型名
  const raw = assetTypes.value.length
    ? assetTypes.value
    : Object.entries(types.value).map(([key, label], i) => ({ key, label, category: 'other', order: i, builtin: !key.startsWith('ct_') }));
  // 后端返回的 label/category 是按后端语言算的；这里用前端语言覆盖，避免两边不一致。
  // 内置类型的分类直接按 key 查表，后端还没重启（返回中文分类名）时也不会漏翻。
  const list = raw.map((t: any) => ({
    ...t,
    label: t.builtin ? typeLabel(t.key) : t.label,
    category: categoryLabel((t.builtin && BUILTIN_TYPE_META[t.key]?.category) || t.category || 'other'),
  }));
  const groups: { category: string; types: AssetTypeDef[] }[] = [];
  for (const t of list) {
    if (t.key === 'note') continue;
    // 项目不进资产清单（独立页面 + 机房页在用）；类型下拉仍保留，编辑项目资产要用
    if (t.key === 'project') continue;
    const cat = t.category || categoryLabel('other');
    let g = groups.find((x) => x.category === cat);
    if (!g) {
      g = { category: cat, types: [] };
      groups.push(g);
    }
    g.types.push(t);
  }
  return groups;
});
const typeCategories = computed(() => [...new Set(assetTypes.value.map((t) => t.category).filter(Boolean))]);

/** 下拉/表单用的类型选项（含自定义类型，label 已就绪） */
const typeOptions = computed(() => {
  void lang.value;
  const list = assetTypes.value.length
    ? assetTypes.value
    : Object.entries(types.value).map(
        ([key, label], i) => ({ key, label, category: '', order: i, builtin: !key.startsWith('ct_') } as AssetTypeDef)
      );
  return list
    .filter((t: any) => t.key !== 'note')
    .map((t: any) => ({ ...t, label: t.builtin ? typeLabel(t.key) : t.label }));
});

/**
 * 类型 key → 展示名：统一入口，避免新类型在下拉里露出 ct_xxx。
 * 内置类型必须走 i18n 字典（后端返回的 label 是按后端语言算的，切语言不会变）；
 * 自定义类型用用户自己起的名字，不做翻译。
 */
function typeLabel(k: string): string {
  const def = assetTypes.value.find((t) => t.key === k);
  // 自定义类型优先用用户起的名字；内置类型走字典。
  // 字典查不到会原样返回 key：这时再退回 def.label，避免界面上冒出 ct_xxxxxxxx。
  const dict = schemaTypeLabel(k);
  if (dict && dict !== k) return dict;
  return def?.label || k;
}

async function loadAssetTypes() {
  try {
    const r = await api('GET', '/asset-types');
    if (Array.isArray(r?.types)) {
      assetTypes.value = r.types;
      for (const t of r.types) {
        types.value[t.key] = t.label;
        if (t.color) typeColors.value[t.key] = t.color;
      }
    }
  } catch {
    /* 旧服务端无此接口时退回内置列表 */
  }
}

// ===== 自定义资产类型：新增 / 编辑 / 删除（顶部「＋」） =====
const typeEditorOpen = ref(false);
const typeEditingKey = ref('');
const typeForm = ref({ label: '', category: '自定义', color: '#e8eef5' });
const typeFields = ref<{ label: string; kind: FieldKind; list: boolean; form: boolean }[]>([]);
const typeErr = ref('');
const typeBusy = ref(false);

function ensureOk(r: any) {
  if (r?.error) throw new Error(r.error);
  return r;
}

function openTypeEditor(t?: AssetTypeDef) {
  typeErr.value = '';
  if (t) {
    typeEditingKey.value = t.key;
    typeForm.value = { label: t.label, category: t.category, color: t.color || '#e8eef5' };
    typeFields.value = [];
  } else {
    typeEditingKey.value = '';
    typeForm.value = { label: '', category: '自定义', color: '#e8eef5' };
    typeFields.value = [{ label: '', kind: 'text', list: true, form: true }];
  }
  typeEditorOpen.value = true;
}

async function saveType() {
  typeErr.value = '';
  const label = typeForm.value.label.trim();
  if (!label) {
    typeErr.value = tr('type.err.name');
    return;
  }
  typeBusy.value = true;
  try {
    let key = typeEditingKey.value;
    if (key) {
      ensureOk(
        await api('PUT', `/asset-types/${encodeURIComponent(key)}`, {
          label,
          category: typeForm.value.category,
          color: typeForm.value.color,
        })
      );
    } else {
      const created = ensureOk(
        await api('POST', '/asset-types', {
          label,
          category: typeForm.value.category,
          color: typeForm.value.color,
        })
      );
      key = created.key;
      const valid = typeFields.value.filter((f) => f.label.trim());
      if (valid.length) {
        const sch = ensureOk(await api('GET', '/field-schema'));
        const custom = (sch.custom || []).filter((f: any) => f.scope !== key);
        for (const f of valid) {
          custom.push({ label: f.label.trim(), scope: key, kind: f.kind, list: f.list, form: f.form });
        }
        ensureOk(await api('PUT', '/field-schema', { overrides: sch.overrides || {}, custom }));
      }
    }
    await loadAssetTypes();
    await loadFieldSchema();
    typeEditorOpen.value = false;
    filter.value = key;
  } catch (e: any) {
    typeErr.value = e?.message || tr('type.err.save');
  } finally {
    typeBusy.value = false;
  }
}

async function removeType() {
  const key = typeEditingKey.value;
  if (!key) return;
  if (!confirm(tr('type.confirm.delete', { name: typeForm.value.label }))) return;
  typeErr.value = '';
  try {
    ensureOk(await api('DELETE', `/asset-types/${encodeURIComponent(key)}`));
    await loadAssetTypes();
    await loadFieldSchema();
    if (filter.value === key) filter.value = '';
    typeEditorOpen.value = false;
  } catch (e: any) {
    typeErr.value = e?.message || tr('type.err.delete');
  }
}
const LINK_ROLE_OPTIONS = Object.keys(LINK_ROLE_LABELS);

const linkCandidates = computed(() => {
  const selfId = editing.value && editing.value !== 'new' ? (editing.value as any).id : '';
  const taken = new Set(formLinks.value.map((l) => l.id));
  const typeFilter = linkRoleToAssetType(linkPickRole.value);
  return assets.value.filter((a) => {
    if (a.id === selfId || taken.has(a.id)) return false;
    if (typeFilter && a.type !== typeFilter) return false;
    return true;
  });
});

/** 角色名（跟随语言）；没填 role 时按「全部类型」显示 */
function linkRoleName(role?: string) {
  return roleLabel(role || 'related');
}

/** 下拉选项展示：状态走字典；空值代表「不使用代理」 */
function optionLabel(f: any, o: any): string {
  if (o === '') return tr('form.proxyNone');
  if (f?.k === 'status') return statusLabel(String(o));
  return String(o);
}

function assetById(id: string) {
  return assets.value.find((a) => a.id === id);
}

/** 关联下拉用的鉴别信息（平台/IP/厂商等） */
function linkAssetHint(a: any): string {
  if (!a) return '';
  switch (a.type) {
    case 'login_account':
      return String(a.provider || '').trim();
    case 'server':
      return String(a.publicIp || a.ip || a.privateIp || '').trim();
    case 'cloud_account':
    case 'oss':
    case 'api_key':
      return String(a.provider || '').trim();
    case 'baota': {
      const u = String(a.panelUrl || '').trim();
      if (u) return u;
      return a.baotaPort != null && a.baotaPort !== '' ? String(a.baotaPort) : '';
    }
    case 'ssh_key': {
      const user = String(a.sshUser || '').trim();
      const host = String(a.sshHost || '').trim();
      const port = a.sshPort && a.sshPort !== 22 ? `:${a.sshPort}` : '';
      if (user || host) return `${user || 'root'}${host ? '@' + host : ''}${port}`;
      return String(a.keyFileName || '').trim();
    }
    default:
      return String(a.group || '').trim();
  }
}

/** withType：未按类型过滤（关联=全部）时带上类型名 */
function linkAssetLabel(a: any, withType = false): string {
  if (!a) return '';
  const parts: string[] = [];
  if (withType) parts.push(types.value[a.type] || a.type);
  const hint = linkAssetHint(a);
  if (hint) parts.push(hint);
  parts.push(a.name || a.id);
  return parts.join(' · ');
}

function addFormLink() {
  if (!linkPickId.value) return;
  const role = linkPickRole.value || 'related';
  formLinks.value = [...formLinks.value, { id: linkPickId.value, role }];
  linkPickId.value = '';
}

function removeFormLink(id: string) {
  formLinks.value = formLinks.value.filter((l) => l.id !== id);
}

function onLinkRoleChange() {
  linkPickId.value = '';
}

function formLinkLabel(id: string) {
  const a = assetById(id);
  return a ? linkAssetLabel(a, false) : id;
}

/** 详情：我指向别人 + 别人指向我（含旧 sshKeyId） */
const detailRelations = computed(() => {
  if (!detail.value) return { out: [] as any[], inn: [] as any[] };
  const id = detail.value.id;
  const out = (detail.value.links || []).map((l: any) => {
    const a = assetById(l.id);
    return {
      ...l,
      name: a ? linkAssetLabel(a, false) : l.id,
      type: a?.type,
      missing: !a,
    };
  });
  // 兼容仅写了 sshKeyId 的旧数据
  if (detail.value.sshKeyId && !out.some((l: any) => l.id === detail.value.sshKeyId)) {
    const a = assetById(detail.value.sshKeyId);
    out.unshift({
      id: detail.value.sshKeyId,
      role: 'ssh_key',
      name: a ? linkAssetLabel(a, false) : detail.value.sshKeyId,
      type: a?.type || 'ssh_key',
      missing: !a,
    });
  }
  const inn = assets.value
    .filter(
      (a) =>
        a.id !== id &&
        ((a.links || []).some((l: any) => l.id === id) || a.sshKeyId === id)
    )
    .map((a) => {
      const link = (a.links || []).find((l: any) => l.id === id);
      return {
        id: a.id,
        name: linkAssetLabel(a, false),
        type: a.type,
        role: a.sshKeyId === id && !link ? 'ssh_key' : link?.role || 'related',
      };
    });
  return { out, inn };
});

async function openRelated(id: string) {
  const a = assetById(id);
  if (a) await openDetail(a);
}

// 模糊搜索：命中结果优先于类型筛选；清空后回到类型筛选
const searchQuery = ref('');
const searchResults = ref<any[] | null>(null);
let searchTimer: any = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250); // 防抖，避免每敲一个字都打接口
}
async function runSearch() {
  const q = searchQuery.value.trim();
  if (!q) {
    searchResults.value = null;
    return;
  }
  const r = await api('GET', '/search?q=' + encodeURIComponent(q));
  searchResults.value = Array.isArray(r) ? r : [];
}
function clearSearch() {
  searchQuery.value = '';
  searchResults.value = null;
}

// 资产清单不展示「项目」：项目有独立页面，机房/工作台也直接复用这批数据。
// 数据不删，只是不进这份清单，避免同一批内容在两处维护。
const listAssets = computed(() => assets.value.filter((a) => a.type !== 'project'));

const filteredAssets = computed(() => {
  if (searchResults.value) return searchResults.value.filter((a) => a.type !== 'project');
  if (filter.value === 'due') return listAssets.value.filter((a) => isDue(a));
  return filter.value ? listAssets.value.filter((a) => a.type === filter.value) : listAssets.value;
});

// 切换类型筛选时清空搜索，避免两套条件混用造成的困惑
watch(filter, () => clearSearch());

/**
 * 新版模板下给 <html> 挂 class：
 * html/body 的底色和滚动条必须在最外层处理，否则内容区之外会露出一圈浅色底。
 */
watch(
  [uiMode, uiTheme, uiTemplate],
  () => {
    const isNew = uiMode.value === 'new';
    const el = document.documentElement;
    el.classList.toggle('mg-dark', isNew && uiTheme.value === 'dark');
    el.classList.toggle('mg-light', isNew && uiTheme.value === 'light');
    // 模板不同，整窗底色也不同（黑曜 #07080a / 纸墨 #1c1a15）
    el.classList.toggle('mg-atlas', isNew && uiTemplate.value === 'atlas');
    // 新版页面内部滚动，不需要给 html 预留滚动条槽位
    el.classList.toggle('mg-scroll', isNew);
    // 新模式下同步 html[data-theme]：App 自有弹窗（列配置、类型编辑器）不在 [data-mgui] 子树内，
    // 若 html 还挂着经典深色，[data-theme='dark'] 的硬编码规则会泄进新 UI 弹窗（docs/19 §2-④）。
    // 切回经典时恢复经典自己的深浅状态，否则 theme 未变、经典侧 watch 不触发，会卡在新版主题上。
    if (isNew) el.setAttribute('data-theme', uiTheme.value);
    else el.setAttribute('data-theme', theme.value);
  },
  { immediate: true }
);

/**
 * 打开编辑/新增面板后自动聚焦第一个输入框。
 * 之前面板一出来焦点还停在「编辑」按钮上，得先点一下输入框才能打字，
 * 长表单还会停在中间位置。
 */
watch(editing, async (v) => {
  if (!v) return;
  await nextTick();
  requestAnimationFrame(() => {
    const box = document.querySelector('.mg-modal .box') as HTMLElement | null;
    if (!box) return;
    box.scrollTop = 0;
    // 新建才自动聚焦（编辑态不聚）：Chrome 聚焦后光标落末尾会把输入框滚到值的尾部，
    // 用户会误以为「名称丢了前两个字」（实机截图确认过的误会）
    if (editing.value !== 'new') return;
    // 优先落到文本输入（名称），不要落到「类型」下拉上
    const first =
      (box.querySelector(
        'input[type="text"]:not(.search-input), input:not([type]):not(.search-input)'
      ) as HTMLElement | null) ||
      (box.querySelector('textarea') as HTMLElement | null) ||
      (box.querySelector('select') as HTMLElement | null);
    first?.focus();
    // 光标放到末尾：直接打字是追加，不会误把原名称整段替换掉
    if (first instanceof HTMLInputElement) {
      const len = first.value.length;
      first.setSelectionRange(len, len);
    }
  });
});
// 切换页签回到顶部：内容多/少切换时不会停在中间，配合 html 预留滚动条宽度消除横向跳动
watch(tab, () => {
  // 资产清单不展示项目：机房页「新增项目」会把 filter 置成 project，回到清单时清掉
  if (tab.value === 'assets' && filter.value === 'project') filter.value = '';
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' });
});

// ===== 新版资产清单（黑曜模板）：只换渲染层，数据与筛选仍由本文件管 =====
/** 类型 key → 中文名 + 颜色，供新组件渲染色点与类型列 */
const typeMetaMap = computed(() => {
  const m: Record<string, { label: string; color?: string }> = {};
  for (const t of typeOptions.value) m[t.key] = { label: t.label, color: typeColors.value[t.key] || (t as any).color };
  return m;
});
/** 新组件的搜索框：保持原来的防抖搜索链路 */
function onViewSearch(v: string) {
  searchQuery.value = v;
  onSearchInput();
}

const counts = computed(() => {
  const c: Record<string, number> = {};
  for (const k of typeKeys.value) c[k] = listAssets.value.filter((a) => a.type === k).length;
  return c;
});

/** 待轮换徽标与「全部/待轮换」chip 的计数：一律基于全量 assets，与点击后的筛选口径一致（docs/19 #12） */
const dueCount = computed(() => assets.value.filter((a) => isDue(a)).length);

// ===== 白名单模块：绑定管理 / 探测公网 IP / 执行更新 =====
const wlBindings = ref<any[]>([]);
const wlIps = ref<string[]>([]);
const wlLogs = ref<any[]>([]);
const wlSched = ref<any>({ enabled: false, intervalMinutes: 30 });
const wlBusy = ref(false);
const wlDetecting = ref(false);
const wlMsg = ref('');
const wlEditing = ref<any | null>(null); // null=关闭, 'new'=新建, object=编辑
const wlForm = ref<any>({});

/** 可作为白名单凭据来源的云账号资产 */
const cloudAccounts = computed(() => assets.value.filter((a: any) => a.type === 'cloud_account'));

/**
 * 白名单表单的下拉数据：地域 + 前缀列表/地址模板。
 * 这两项是云上生成的 ID（如 atm-xxxx），用户既不知道从哪复制又容易填错，
 * 所以用账号 AK/SK 实时拉真实列表来选；拉取失败才退回手填。
 */
const wlRegions = ref<any[]>([]);
const wlTargets = ref<any[]>([]);
const wlOptBusy = ref(false);
const wlOptErr = ref('');
const wlOptHint = ref('');

async function loadWlOptions(withTargets: boolean) {
  const f = wlForm.value || {};
  if (!f.provider || !f.assetId) {
    wlRegions.value = [];
    wlTargets.value = [];
    return;
  }
  wlOptBusy.value = true;
  wlOptErr.value = '';
  wlOptHint.value = '';
  try {
    let q = `/whitelist/options?assetId=${encodeURIComponent(f.assetId)}&provider=${encodeURIComponent(f.provider)}`;
    if (withTargets && f.region) q += `&region=${encodeURIComponent(f.region)}`;
    const r = await api('GET', q);
    if (!withTargets) wlRegions.value = r?.regions || [];
    else wlTargets.value = r?.targets || [];
    if (r?.error) {
      wlOptErr.value = r.error;
      wlOptHint.value = r.hint || '';
    }
  } catch (e: any) {
    wlOptErr.value = e.message || tr('wl.err.fetch');
  } finally {
    wlOptBusy.value = false;
  }
}

// 换厂商/换账号 → 重拉地域（目标随地域变，一并清空）
watch(
  () => [wlForm.value?.provider, wlForm.value?.assetId],
  () => {
    wlTargets.value = [];
    loadWlOptions(false);
  }
);
// 选了地域 → 拉该地域下的白名单目标
watch(
  () => wlForm.value?.region,
  (r) => {
    if (r) loadWlOptions(true);
    else wlTargets.value = [];
  }
);
function cloudAccountLabel(id: string) {
  const a = assets.value.find((x: any) => x.id === id);
  return a ? `${a.name}${a.provider ? ' · ' + a.provider : ''}` : id;
}

async function loadWhitelist() {
  const [b, logs, sch] = await Promise.all([
    api('GET', '/whitelist/bindings'),
    api('GET', '/whitelist/logs'),
    api('GET', '/whitelist/schedule'),
  ]);
  wlBindings.value = Array.isArray(b) ? b : [];
  wlLogs.value = Array.isArray(logs) ? logs : [];
  wlSched.value = sch && typeof sch === 'object' ? sch : { enabled: false, intervalMinutes: 30 };
  if (!wlIps.value.length) detectIp();
}

/** 保存定时调度（应用内定时：每 N 分钟执行一次） */
async function saveWlSched() {
  const r = await api('PUT', '/whitelist/schedule', {
    enabled: !!wlSched.value.enabled,
    intervalMinutes: Number(wlSched.value.intervalMinutes) || 30,
  });
  wlSched.value = r && typeof r === 'object' ? r : wlSched.value;
  wlMsg.value = wlSched.value.enabled
    ? tr('wl.msg.schedOn', { n: wlSched.value.intervalMinutes })
    : tr('wl.msg.schedOff');
}

const wlNextText = computed(() => {
  const n = wlSched.value?.nextRunAt;
  if (!wlSched.value?.enabled || !n) return tr('wl.notScheduled');
  return df(n, { dateStyle: 'medium', timeStyle: 'short', hour12: false });
});

async function detectIp() {
  wlDetecting.value = true;
  try {
    const r = await api('GET', '/whitelist/detect');
    wlIps.value = r.ips || [];
    if (!wlIps.value.length) wlMsg.value = tr('wl.msg.noIp');
  } catch (e: any) {
    wlMsg.value = tr('wl.msg.detectFail', { msg: e.message });
  } finally {
    wlDetecting.value = false;
  }
}

async function runWhitelist(id?: string, force = false) {
  wlBusy.value = true;
  wlMsg.value = '';
  try {
    const r = await api('POST', '/whitelist/run', { id, force });
    const rs: any[] = r.results || [];
    const ok = rs.filter((x) => x.ok && !x.skipped).length;
    const skipped = rs.filter((x) => x.skipped).length;
    const failed = rs.filter((x) => !x.ok).length;
    wlMsg.value = tr('wl.msg.runDone', { ok, skipped, failed });
    for (const x of rs) if (!x.ok) wlMsg.value += ` ｜ ${x.message}`;
    await loadWhitelist();
  } catch (e: any) {
    wlMsg.value = tr('wl.msg.runFail', { msg: e.message });
  } finally {
    wlBusy.value = false;
  }
}

function openWlNew() {
  wlForm.value = { provider: 'aliyun', enabled: true };
  wlEditing.value = 'new';
}
function openWlEdit(b: any) {
  wlForm.value = { ...b, targetId: b.prefixListId || b.addressTemplateId || '' };
  wlEditing.value = b;
}
function closeWlForm() {
  wlEditing.value = null;
}
async function saveWl() {
  const f = wlForm.value;
  if (!f.provider || !f.assetId || !f.region) {
    wlMsg.value = tr('wl.msg.needFields');
    return;
  }
  const payload: any = {
    name: f.name || undefined,
    provider: f.provider,
    assetId: f.assetId,
    region: f.region,
    securityGroupId: f.securityGroupId || undefined,
    prefixListId: f.provider === 'aliyun' ? f.targetId || undefined : undefined,
    addressTemplateId: f.provider === 'tencent' ? f.targetId || undefined : undefined,
    enabled: f.enabled !== false,
  };
  if (wlEditing.value === 'new') await api('POST', '/whitelist/bindings', payload);
  else await api('PUT', '/whitelist/bindings/' + (wlEditing.value as any).id, payload);
  wlEditing.value = null;
  await loadWhitelist();
}
async function removeWl(b: any) {
  if (!confirm(tr('wl.confirm.remove', { name: b.name || b.id }))) return;
  await api('DELETE', '/whitelist/bindings/' + b.id);
  await loadWhitelist();
}
async function toggleWl(b: any) {
  await api('PUT', '/whitelist/bindings/' + b.id, { enabled: !b.enabled });
  await loadWhitelist();
}
function wlProviderLabel(p: string) {
  return p === 'aliyun' ? tr('wl.vendor.aliyun') : p === 'tencent' ? tr('wl.vendor.tencent') : p;
}
function wlTarget(b: any) {
  return b.provider === 'aliyun' ? b.prefixListId : b.addressTemplateId;
}
function wlResultTag(b: any) {
  if (!b.lastResult) return '—';
  if (b.lastResult === 'ok') return tr('wl.result.ok');
  if (b.lastResult === 'skipped') return tr('wl.result.skipped');
  return tr('wl.result.fail');
}

// ===== 备忘录：随燧垒一起加密存储的多条备忘 =====
const memos = ref<any[]>([]);
const memoEditing = ref<any | null>(null); // null=关闭, 'new'=新建, object=编辑
const memoForm = ref<any>({});

async function loadMemos() {
  const r = await api('GET', '/assets?type=note');
  memos.value = Array.isArray(r) ? r : [];
}
function openMemoNew() {
  memoForm.value = { name: '', content: '' };
  memoEditing.value = 'new';
}
function openMemoEdit(m: any) {
  memoForm.value = { name: m.name || '', content: m.content || '' };
  memoEditing.value = m;
}
function closeMemoForm() {
  memoEditing.value = null;
}
async function saveMemo() {
  const f = memoForm.value;
  if (!f.name && !f.content) return;
  const payload: any = { type: 'note', name: f.name || tr('assets.unnamed'), content: f.content || '', tags: f.tags || [] };
  if (memoEditing.value === 'new') await api('POST', '/assets', payload);
  else await api('PUT', '/assets/' + (memoEditing.value as any).id, payload);
  memoEditing.value = null;
  await loadMemos();
}
async function removeMemo(m: any) {
  if (!confirm(tr('memo.confirm.delete', { name: m.name }))) return;
  await api('DELETE', '/assets/' + m.id);
  await loadMemos();
}

/**
 * 后端连不上（开发时重启服务、进程被杀）时，页面原本只会「数据变空」，
 * 看着就像数据丢了。这里置一个标志，顶部给一条明确的「连接已断开」提示。
 */
const apiOffline = ref(false);
/**
 * 所有接口调用都走这里。非 2xx 由 api-client 抛 ApiError，401/423 直接切回锁屏页——
 * 绝不让 `{ error, needUnlock }` 这种错误体流进业务数据（历史上资产列表因此整页白屏）。
 */
const api = createApi({
  hooks: {
    onOk: () => {
      apiOffline.value = false;
    },
    onNetworkError: () => {
      apiOffline.value = true;
    },
    onSessionLost: () => handleLocked(),
  },
});
function reconnect() {
  apiOffline.value = false;
  location.reload();
}

async function loadFieldCatalog() {
  try {
    const r = await api('GET', '/field-catalog');
    const map: Record<string, { options: string[]; allowCustom: boolean }> = {};
    for (const f of r.fields || []) {
      map[f.key] = { options: f.options || [], allowCustom: !!f.allowCustom };
    }
    fieldCatalog.value = map;
    if (r.typeColors) typeColors.value = r.typeColors;
  } catch {
    /* 旧服务端无此接口时忽略 */
  }
}

async function loadAll() {
  try {
    const [t, a] = await Promise.all([api('GET', '/types'), api('GET', '/assets')]);
    // 形状兜底：接口形状不对时保留上一份数据，绝不做 `assets.value = 对象`
    // （那样十几处 .filter() 会连锁抛 TypeError，整页白屏）
    if (t && typeof t === 'object' && !Array.isArray(t)) types.value = t as Record<string, string>;
    if (Array.isArray(a)) assets.value = a;
    else console.warn('[loadAll] /assets 返回的不是数组，已保留上次数据', a);
  } catch (e) {
    // 401/423 已由 onSessionLost 切到锁屏页；其它错误保持旧数据 + 顶部断线提示
    console.warn('[loadAll] 加载失败，保留上次数据：', (e as Error)?.message);
  }
  await loadFieldCatalog();
}

function catalogOpts(key?: string): string[] {
  if (!key) return [];
  return fieldCatalog.value[key]?.options || [];
}

function catalogAllowCustom(key?: string): boolean {
  if (!key) return false;
  return !!fieldCatalog.value[key]?.allowCustom;
}

function catalogSelectValue(f: { k: string; catalogKey?: string }) {
  if (catalogCustom.value[f.k]) return CATALOG_CUSTOM;
  const v = form.value[f.k];
  const opts = catalogOpts(f.catalogKey);
  if (v && opts.includes(v)) return v;
  if (v) return CATALOG_CUSTOM; // 已有值不在列表中 → 显示为自定义
  return opts[0] || '';
}

function onCatalogSelect(f: { k: string; catalogKey?: string }, ev: Event) {
  const val = (ev.target as HTMLSelectElement).value;
  if (val === CATALOG_CUSTOM) {
    catalogCustom.value = { ...catalogCustom.value, [f.k]: true };
    if (catalogOpts(f.catalogKey).includes(form.value[f.k])) {
      form.value[f.k] = '';
    }
    return;
  }
  catalogCustom.value = { ...catalogCustom.value, [f.k]: false };
  form.value[f.k] = val;
}

function initCatalogCustomFlags() {
  const next: Record<string, boolean> = {};
  for (const f of formFieldList.value) {
    if (!f.catalogKey) continue;
    const v = form.value[f.k];
    const opts = catalogOpts(f.catalogKey);
    next[f.k] = !!(v && !opts.includes(v));
    // 新建且未填时默认选中第一项，避免界面显示了选项但未写入 form
    if (!v && !next[f.k] && opts[0]) form.value[f.k] = opts[0];
  }
  catalogCustom.value = next;
}

watch(formType, () => {
  if (!editing.value) return;
  initCatalogCustomFlags();
});

async function loadAudit(page?: number) {
  if (page != null) auditPage.value = page;
  // 筛选走服务端：只过滤当前页的话，Agent 记录在别的页，切过去永远空白
  const kind = auditFilter.value === 'all' ? '' : auditFilter.value;
  const q = `?page=${auditPage.value}&pageSize=${auditPageSize.value}${kind ? '&kind=' + encodeURIComponent(kind) : ''}`;
  const r = await api('GET', '/audit' + q);
  if (Array.isArray(r)) {
    audit.value = r;
    auditTotal.value = r.length;
  } else {
    audit.value = r.items || [];
    auditTotal.value = r.total || 0;
    auditPage.value = r.page || 1;
    auditPageSize.value = r.pageSize || auditPageSize.value;
  }
}

// ===== 审计日志：人工/Agent 分类 + 中文动作 + 恢复 =====
const auditFilter = ref<'all' | 'user' | 'agent'>('all');
const AUDIT_SYSTEM = new Set(['vault_lock', 'vault_unlock', 'migrate_server_to_ssh_key', 'migrate_inline_ssh_to_link']);
function auditCategory(e: any): 'user' | 'agent' | 'system' {
  if (e.action === 'agent_action' || (e.actor && e.actor !== 'unknown')) return 'agent';
  if (AUDIT_SYSTEM.has(e.action)) return 'system';
  return 'user';
}
function auditKindLabel(e: any): string {
  void lang.value; // 这些函数在模板里直接调用，读一次 lang 才能跟着切语言重渲染
  return actorLabel(auditCategory(e));
}
function auditCn(e: any): string {
  void lang.value;
  // 名字的引号风格按语言走：中文「」，英文 ""
  const name = e.name ? (lang.value === 'en-US' ? `"${e.name}"` : `「${e.name}」`) : '';
  if (e.action === 'agent_action') return e.description || tr('meta.audit.agent_action');
  const key = auditActionLabel(e.action);
  if (!key) return e.action; // 未知动作原样显示，便于排查
  return tr(key as any, { type: e.type ? typeLabel(e.type) : '', name });
}
// 服务端已按 kind 过滤并分页，这里直接用返回结果
const auditFiltered = computed(() => audit.value);
// 切换「全部 / 人工 / Agent」时回到第一页重新拉取
watch(auditFilter, () => {
  if (tab.value === 'audit') loadAudit(1);
});
const AUDIT_FIELD_CN: Record<string, string> = {
  name: '名称', kind: '类型', status: '状态', progress: '进度', version: '版本', desc: '简介', stack: '技术栈', envs: '环境变量',
  urls: '入口地址', color: '颜色', users: '用户数', client: '客户', contract: '合同金额', start: '开始日期', content: '内容',
  username: '账号', secret: '密码', provider: '服务商', email: '邮箱', publicIp: '公网 IP', privateIp: '私网 IP', os: '系统',
  sshHost: '主机', sshPort: 'SSH 端口', sshUser: 'SSH 用户', panelUrl: '面板地址', baotaPort: '面板端口', baotaUser: '面板用户',
  accessKeyId: 'AccessKeyId', baseUrl: '接口基址', loginUrl: '登录地址', links: '关联', tags: '标签', group: '分组',
  note: '备注', phone: '手机号', no: '序号', type: '类型', bucket: 'Bucket', endpoint: 'Endpoint', region: '地域', command: '命令',
};
function auditFieldCn(k: string): string {
  void lang.value;
  return fieldNameLabel(k);
}
/** 审计明细兜底：不整条 JSON.stringify，避免把 ct_ 类型 key、内部 id 直接暴露给用户 */
function auditRawCn(e: any): string {
  void lang.value;
  const parts: string[] = [];
  if (e.type) parts.push(`${tr('meta.field.type')}：${typeLabel(e.type)}`);
  if (e.name) parts.push(`${fieldNameLabel('name')}：${e.name}`);
  if (!parts.length && e.id) parts.push(`ID：${String(e.id).slice(0, 8)}…`);
  return parts.join(tr('meta.audit.sep')) || tr('common.state.none');
}

function auditPreviewCn(pv: any): string {
  void lang.value;
  const parts: string[] = [];
  for (const k of Object.keys(AUDIT_FIELD_CN)) {
    if (pv[k] !== undefined && pv[k] !== '' && !/secret|password|keyEnc|ApiKey/.test(k)) {
      parts.push(tr('meta.audit.kv', { k: fieldNameLabel(k), v: String(pv[k]) }));
    }
  }
  return parts.join(tr('meta.audit.sep')) || tr('common.state.none');
}
async function auditRestore(e: any) {
  if (!e.undo) return;
  if (!confirm(tr('asset.confirm.restore'))) return;
  try {
    const r = await api('POST', '/undo', { uid: e.undo });
    loadAudit();
    alert(tr('asset.restored', { name: r.name || '' }));
  } catch (err: any) {
    alert(tr('asset.restoreFail', { msg: err?.message || err }));
  }
}

const auditPageCount = computed(() => Math.max(1, Math.ceil(auditTotal.value / auditPageSize.value)));

function formatTs(ts?: string) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function onAuditPageSizeChange() {
  auditPage.value = 1;
  loadAudit(1);
}

async function openNew() {
  await loadFieldCatalog();
  // 在哪个类型页点「新增资产」，就默认建该类型的资产（"全部"/"待轮换"页回落为 server）
  formType.value =
    filter.value && filter.value !== 'due' && typeKeys.value.includes(filter.value)
      ? filter.value
      : 'server';
  form.value = {};
  formReveal.value = {};
  formLinks.value = [];
  formUrls.value = {};
  formMilestones.value = [];
  linkPickId.value = '';
  linkPickRole.value = 'related';
  catalogCustom.value = {};
  editing.value = 'new';
}
async function openEdit(a: any) {
  // 字段定义也必须等到位：否则自定义字段没回填，表单是空的，
  // 一保存就把已存的自定义字段值全写成空（表现为「我填的信息又没了」）。
  await Promise.all([loadFieldCatalog(), loadFieldSchema()]);
  // 列表已脱敏，编辑前拉完整资产，否则 SecretAccessKey 等会显示成空（其实已存本地）
  const full = await api('GET', '/assets/' + a.id);
  const src = full?.id ? full : a;
  formType.value = src.type;
  form.value = { ...src };
  formReveal.value = {};
  formLinks.value = [...(src.links || [])];
  // urls 是对象，复制一份再编辑：直接绑 form.value.urls 会把原资产的引用改掉（取消编辑也回不去）
  formUrls.value = { ...(src.urls || {}) };
  formMilestones.value = (src.milestones || []).map((m: any) => ({
    id: m.id || 'ms_' + Math.random().toString(36).slice(2, 8),
    name: m.name || '',
    date: m.date ? String(m.date).slice(0, 10) : '',
    done: !!m.done,
  }));
  if (src.sshKeyId && !formLinks.value.some((l) => l.id === src.sshKeyId)) {
    formLinks.value.push({ id: src.sshKeyId, role: 'ssh_key' });
  }
  initCatalogCustomFlags();
  linkPickId.value = '';
  linkPickRole.value = 'related';
  if (Array.isArray(src.tags)) form.value.tags = src.tags.join(',');
  if (Array.isArray(src.openPorts)) form.value.openPorts = src.openPorts.join(',');
  if (Array.isArray(src.args)) form.value.args = src.args.join(',');
  if (Array.isArray(src.stack)) form.value.stack = src.stack.join(',');
  if (Array.isArray(src.envs)) form.value.envs = src.envs.join(',');
  if (src.start) form.value.start = String(src.start).slice(0, 10); // date 输入只认 YYYY-MM-DD
  if (src.lastRotatedAt) form.value.lastRotatedAt = src.lastRotatedAt.slice(0, 10);
  if (src.proxyInject?.mode) form.value.proxyInjectMode = src.proxyInject.mode;
  if (src.proxyInject?.headerName) form.value.proxyInjectHeader = src.proxyInject.headerName;
  // 旧 server.ip → 表单公网 IP
  if (src.type === 'server' && !src.publicIp && src.ip) form.value.publicIp = src.ip;
  // 自定义字段：从 extra 平铺回表单（v-model key 是 extra:xxx）
  for (const f of formFieldsFor(src.type, fieldSchema.value)) {
    if (!f.extraKey) continue;
    const v = customFormValue(src, f.extraKey);
    // 服务端读接口会把敏感字段剥掉（拿回来的就是空），这时不要往表单里塞空串：
    // 塞了就等于「回填为空」，保存会把已存的密钥/敏感值覆盖成空。
    if (v === '' || v === undefined || v === null) continue;
    form.value[f.k] = v;
  }
  editing.value = src;
}

function toggleFormReveal(key: string) {
  formReveal.value = { ...formReveal.value, [key]: !formReveal.value[key] };
}

const keyUploadMsg = ref('');

function looksLikePrivateKey(text: string) {
  return /BEGIN .+PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/.test(text);
}

async function onUploadPrivateKey(ev: Event) {
  keyUploadMsg.value = '';
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (!looksLikePrivateKey(text)) {
      keyUploadMsg.value = tr('form.upload.notPrivate');
    } else {
      keyUploadMsg.value = tr('form.upload.privateOk', { name: file.name });
    }
    form.value.privateKeyEnc = text.replace(/\r\n/g, '\n').trim() + '\n';
    form.value.keyFileName = file.name;
    if (!form.value.name) {
      form.value.name = file.name.replace(/\.pem$/i, '').replace(/^id_/, '');
    }
    formReveal.value = { ...formReveal.value, privateKeyEnc: false };
  } catch (e: any) {
    keyUploadMsg.value = tr('form.upload.readFail', { msg: e.message || String(e) });
  }
  input.value = '';
}

async function onUploadPublicKey(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    form.value.publicKey = (await file.text()).replace(/\r\n/g, '\n').trim();
    keyUploadMsg.value =
      (keyUploadMsg.value ? keyUploadMsg.value + tr('form.sep') : '') + tr('form.upload.publicOk', { name: file.name });
  } catch (e: any) {
    keyUploadMsg.value = tr('form.upload.publicFail', { msg: e.message || String(e) });
  }
  input.value = '';
}

/** 表单字段列表：缓存成 computed，避免每次输入重新拼数组 */
/** 代理注入三项：label/hint 存的是 i18n key，这里翻成当前语言再拼进表单 */
const proxyFormFields = computed(() => {
  void lang.value;
  return PROXY_FIELDS.map((f: any) => ({
    ...f,
    label: tr(f.labelKey as any),
    hint: tr(f.hintKey as any),
  }));
});

const formFieldList = computed(() => {
  void lang.value;
  const base = formFieldsFor(formType.value, fieldSchema.value);
  if (formType.value === 'api_key' || formType.value === 'login_account') return base;
  if (['cloud_account', 'oss', 'baota', 'mcp'].includes(formType.value)) return [...base, ...(proxyFormFields.value as any[])];
  return base;
});
/** 从机房空位发起新增时记住机位号；普通新增为 null（旧流程遗留，必须声明） */
let pendingUpsSlot: number | null = null;

/** 新增表单里是否已经有内容（用于避免误关把已填信息丢掉） */
function formHasInput(): boolean {
  if (!editing.value) return false;
  const f = form.value || {};
  for (const [k, v] of Object.entries(f)) {
    // 系统字段不算「用户填的内容」
    if (k === 'id' || k === 'createdAt' || k === 'updatedAt' || k === 'no') continue;
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    return true;
  }
  if (formLinks.value.length) return true;
  if (Object.keys(formUrls.value || {}).length) return true;
  if ((formMilestones.value || []).some((m) => String(m.name ?? '').trim())) return true;
  return false;
}

/** 关闭表单。force=true 时不确认（保存成功后清场用） */
function closeForm(force = false) {
  // 新建时误点取消/关闭会丢掉刚填的一堆内容，有输入就先确认一次
  if (!force && editing.value === 'new' && formHasInput()) {
    if (!confirm(tr('common.confirm.discardForm'))) return;
  }
  editing.value = null;
  pendingUpsSlot = null;
}

/** Esc 关闭编辑面板：走与「取消」相同的确认路径 */
function onFormEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !editing.value) return;
  // 原生下拉展开时 Esc 只用于收起下拉，不要顺手把整个面板关了
  if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
  e.preventDefault();
  closeForm();
}
watch(editing, (v) => {
  if (typeof window === 'undefined') return;
  if (v) window.addEventListener('keydown', onFormEsc);
  else window.removeEventListener('keydown', onFormEsc);
});

// ===== 新增/编辑资产弹窗里就地加字段（不用跳去「设置 → 字段管理」） =====
const quickFieldLabel = ref('');
const quickFieldKind = ref<FieldKind>('text');
const quickFieldBusy = ref(false);
const quickFieldMsg = ref('');

/** 当前类型下的自定义字段（侧栏列表用） */
const formCustomFields = computed(() =>
  (fieldSchema.value.custom || []).filter((f) => f.scope === formType.value)
);

async function addQuickField() {
  const label = quickFieldLabel.value.trim();
  if (!label || quickFieldBusy.value) return;
  quickFieldBusy.value = true;
  quickFieldMsg.value = '';
  try {
    const kind = quickFieldKind.value;
    const next = [
      ...(fieldSchema.value.custom || []),
      {
        key: '',
        label,
        scope: formType.value,
        kind,
        secret: kind === 'password',
        list: false,
        form: true,
      },
    ];
    const r = await api('PUT', '/field-schema', { overrides: fieldSchema.value.overrides, custom: next });
    if (r?.error) {
      quickFieldMsg.value = r.error;
      return;
    }
    fieldSchema.value = r;
    // 新字段的 key 由服务端生成，回填到表单，立刻能填值
    const added = (r.custom || []).find((f: any) => f.label === label && f.scope === formType.value);
    if (added) form.value['extra:' + added.key] = form.value['extra:' + added.key] ?? '';
    quickFieldLabel.value = '';
    quickFieldMsg.value = tr('form.fieldAdded', { name: label });
  } finally {
    quickFieldBusy.value = false;
  }
}

async function removeQuickField(f: any) {
  if (!confirm(tr('form.confirmRemoveField', { name: f.label }))) return;
  quickFieldBusy.value = true;
  quickFieldMsg.value = '';
  try {
    const next = (fieldSchema.value.custom || []).filter((x) => x.key !== f.key);
    const r = await api('PUT', '/field-schema', { overrides: fieldSchema.value.overrides, custom: next });
    if (r?.error) {
      quickFieldMsg.value = r.error;
      return;
    }
    fieldSchema.value = r;
    delete form.value['extra:' + f.key];
    quickFieldMsg.value = tr('form.fieldRemoved', { name: f.label });
  } finally {
    quickFieldBusy.value = false;
  }
}

async function save() {
  const f = form.value;
  const payload: any = {
    type: formType.value,
    // 名称是必填项：万一表单没回填到，别把已存的名字覆盖成空
    name:
      String(f.name ?? '').trim() ||
      (editing.value !== 'new' ? String((editing.value as any)?.name ?? '').trim() : '') ||
      tr('assets.unnamed'),
    tags: (f.tags || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    group: f.group || undefined,
    note: f.note || undefined,
    links: formLinks.value.map((l) => ({ id: l.id, role: l.role || 'related' })),
  };
  // 项目入口：只写有值的项，空字符串不落库（清空某项 = 从对象里删掉）
  if (formType.value === 'project') {
    const urls: Record<string, string> = {};
    for (const e of URL_ENTRIES) {
      const v = String(formUrls.value[e.k] ?? '').trim();
      if (v) urls[e.k] = v;
    }
    payload.urls = urls;
    // 里程碑：没名字的空行直接丢掉，别在库里留垃圾
    payload.milestones = formMilestones.value
      .filter((m) => String(m.name ?? '').trim())
      .map((m) => ({ id: m.id, name: m.name.trim(), date: m.date || '', done: !!m.done }));
  }
  const sshLink = formLinks.value.find((l) => l.role === 'ssh_key');
  if (sshLink) payload.sshKeyId = sshLink.id;
  else if (editing.value !== 'new') payload.sshKeyId = ''; // 清空旧关联

  // 自定义字段：值写进 asset.extra；空字符串也要提交（否则清空旧值不生效）
  const customExtra: Record<string, any> = {};
  let hasCustomField = false;
  for (const field of formFieldList.value) {
    let v = f[field.k];
    if (field.extraKey) {
      // 表单里压根没有这个键 = 回填没跑到（字段刚加上 / 定义加载晚了）。
      // 这种情况不能写空值，否则会把已存的内容清掉。
      if (!(field.k in f)) continue;
      hasCustomField = true;
      customExtra[field.extraKey] = v === undefined || v === null ? '' : v;
      continue;
    }
    if (v === undefined || v === '') continue;
    if (field.num) v = Number(v);
    if (field.ports) v = String(v).split(',').map((s: string) => Number(s.trim())).filter(Boolean);
    if (field.args) v = String(v).split(',').map((s: string) => s.trim()).filter(Boolean);
    if (field.json) v = JSON.parse(v);
    if (field.k === 'proxyInjectMode' || field.k === 'proxyInjectHeader') continue;
    payload[field.k] = v;
  }
  if (hasCustomField) {
    const oldExtra = editing.value !== 'new' && (editing.value as any)?.extra ? (editing.value as any).extra : {};
    payload.extra = { ...oldExtra, ...customExtra };
  }
  const mode = f.proxyInjectMode;
  if (mode) {
    payload.proxyInject = { mode };
    if (f.proxyInjectHeader) payload.proxyInject.headerName = f.proxyInjectHeader;
  }
  for (const field of ROTATION.value) {
    let v = form.value[field.k];
    if (v === undefined || v === '') continue;
    if (field.num) v = Number(v);
    payload[field.k] = v;
  }
  // 服务器：公网写入兼容字段 ip；凭证改由关联的 SSH 登录承载
  if (formType.value === 'server') {
    if (payload.publicIp) payload.ip = payload.publicIp;
    payload.sshPort = '';
    payload.sshUser = '';
    payload.sshPassword = '';
    payload.authMethod = '';
  }

  // 宝塔：有独立端口且地址未带端口时，合并进 panelUrl（代理转发用）
  if (formType.value === 'baota' && payload.panelUrl && payload.baotaPort) {
    try {
      const raw = String(payload.panelUrl).trim();
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (!u.port) {
        u.port = String(payload.baotaPort);
        payload.panelUrl = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
      }
    } catch {
      /* 保留原地址 */
    }
  }
  if (formType.value === 'server' && editing.value === 'new' && pendingUpsSlot) {
    payload.upsSlot = pendingUpsSlot; // 从机房空位发起的新增：落到该机位
  }
  pendingUpsSlot = null;
  const editingId = editing.value === 'new' ? '' : (editing.value as any)?.id || '';
  const saved =
    editing.value === 'new'
      ? await api('POST', '/assets', payload)
      : await api('PUT', '/assets/' + (editing.value as any).id, payload);
  // 保存失败就别关弹窗，否则用户以为存上了（其实没存）
  if (saved?.error) {
    alert(tr('asset.saveFail', { msg: saved.error }));
    return;
  }
  editing.value = null;
  editVersion.value++;
  await loadAll();
  // 详情页开着同一条时，保存后立刻重新拉一次，避免还显示旧值（看着像「刚填的没了」）
  if (editingId && detail.value?.id === editingId) {
    detail.value = await api('GET', '/assets/' + editingId);
  }

}

/** 抽屉内基础编辑：只提交改动字段，后端 update 是合并语义 */
async function quickSave(a: any, patch: any) {
  const r = await api('PUT', '/assets/' + a.id, patch);
  if (r?.error) return r;
  editVersion.value++;
  await loadAll();
  return { ok: true };
}

async function remove(a: any) {
  if (!confirm(tr('common.confirm.delete', { name: a.name }))) return;
  await api('DELETE', '/assets/' + a.id);
  await loadAll();
}

// ===== 版本历史：详情右栏列该资产的历史版本，可回滚（回滚本身也留一版）=====
const versions = ref<any[]>([]);
const versionsLoaded = ref(false);
/** 版本来源 → 文案 key：模板里不再拼字符串，i18n 检查器按字面量判断 key 是否存在 */
const VERSION_SRC_KEY: Record<string, string> = {
  update: 'versions.src.update',
  delete: 'versions.src.delete',
  restore: 'versions.src.restore',
};
function versionSrcLabel(src?: string) {
  return tr((VERSION_SRC_KEY[src || 'update'] || 'versions.src.update') as any);
}

async function loadVersions(assetId: string) {
  try {
    const r = await api('GET', `/assets/${assetId}/versions`);
    versions.value = r?.items || [];
    versionsLoaded.value = true;
  } catch {
    versions.value = [];
  }
}

async function openDetail(a: any) {
  const full = await api('GET', '/assets/' + a.id);
  detail.value = full;
  showSecrets.value = false;
  issueInfo.value = null;
  versions.value = [];
  versionsLoaded.value = false;
  void loadVersions(a.id);
}

async function restoreVersion(v: any) {
  if (!detail.value) return;
  const when = df(new Date(v.ts).getTime(), { dateStyle: 'medium', timeStyle: 'short', hour12: false });
  if (!confirm(tr('versions.confirm', { name: detail.value.name, when }))) return;
  const r = await api('POST', `/assets/${detail.value.id}/versions/${v.vid}/restore`);
  if (r?.error) {
    alert(r.error);
    return;
  }
  detail.value = await api('GET', '/assets/' + detail.value.id);
  await loadVersions(detail.value.id);
  await loadAll();
}

// ===== 从密码管理器导入（1Password / Bitwarden / Chrome / KeePass）=====
const impOpen = ref(false);
const impContent = ref('');
const impBase64 = ref('');
const impFormat = ref('');
const impPreview = ref<any>(null);
const impMode = ref<'skip' | 'update' | 'append'>('skip');
const impResult = ref<any>(null);
const impBusy = ref(false);
const impErr = ref('');

function openImport() {
  impOpen.value = true;
  impContent.value = '';
  impBase64.value = '';
  impFormat.value = '';
  impPreview.value = null;
  impResult.value = null;
  impErr.value = '';
  impMode.value = 'skip';
}

function importPayload() {
  return {
    format: impFormat.value || undefined,
    content: impContent.value || undefined,
    base64: impBase64.value || undefined,
  };
}

async function previewImport() {
  if (!impContent.value.trim() && !impBase64.value) {
    impErr.value = tr('imp.empty');
    return;
  }
  impBusy.value = true;
  impErr.value = '';
  impResult.value = null;
  try {
    const r = await api('POST', '/import/preview', importPayload());
    if (r?.error) {
      impErr.value = r.error;
      impPreview.value = null;
      return;
    }
    impPreview.value = r;
    impFormat.value = r.format || impFormat.value;
  } catch (e: any) {
    impErr.value = e?.message || 'preview failed';
  } finally {
    impBusy.value = false;
  }
}

async function commitImport() {
  impBusy.value = true;
  impErr.value = '';
  try {
    const r = await api('POST', '/import/commit', { ...importPayload(), mode: impMode.value });
    if (r?.error) {
      impErr.value = r.error;
      return;
    }
    impResult.value = r;
    impPreview.value = null;
    impContent.value = '';
    impBase64.value = '';
    await loadAll();
  } catch (e: any) {
    impErr.value = e?.message || 'import failed';
  } finally {
    impBusy.value = false;
  }
}

function onImportFile(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const reader = new FileReader();
  if (/\.1pux$/i.test(f.name)) {
    reader.onload = () => {
      const s = String(reader.result || '');
      impBase64.value = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s;
      impContent.value = '';
      impFormat.value = 'onepassword-1pux';
      void previewImport();
    };
    reader.readAsDataURL(f);
  } else {
    reader.onload = () => {
      impContent.value = String(reader.result || '');
      impBase64.value = '';
      impFormat.value = '';
      void previewImport();
    };
    reader.readAsText(f, 'utf-8');
  }
}

// ===== 资产管家（自写 AI 助手页）：落地页 + 对话流 + 确认卡 =====
const aiView = ref<'landing' | 'chat'>('landing');
const aiMsgs = ref<any[]>([]);
const aiInput = ref('');
const stewardBusy = ref(false);
const aiSessionId = ref('');
const aiSessions = ref<any[]>([]);
const aiConf = ref<any>({ base: '', model: '', name: '', hasKey: false });
const aiSessOpen = ref(false);
const aiModelOpen = ref(false);
const aiSkillTab = ref('common');
let aiAbort: AbortController | null = null;
let aiMsgSeq = 0;
const aiMsgId = () => 'm' + (++aiMsgSeq);
const aiCurrentTitle = computed(() => aiSessions.value.find((s: any) => s.id === aiSessionId.value)?.title || tr('ai.untitled'));
const aiThinking = computed(() => stewardBusy.value && !aiMsgs.value[aiMsgs.value.length - 1]?.text);
function aiStop() { aiAbort?.abort(); }
/** 流式期间自动滚到底；用户手动上翻时不打断 */
function aiScrollToEnd(force = false) {
  nextTick(() => {
    const el = document.getElementById('aiThread');
    if (!el) return;
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  });
}
const AI_SKILL_TABS: { key: string; labelKey: string }[] = [
  { key: 'common', labelKey: 'ai.skill.tab.common' },
  { key: 'assets', labelKey: 'ai.skill.tab.assets' },
  { key: 'server', labelKey: 'ai.skill.tab.server' },
  { key: 'advisor', labelKey: 'ai.skill.tab.advisor' },
];
function aiSkills(tab: string): string[] {
  return [1, 2, 3].map((i) => tr(`ai.skill.${tab}.${i}` as any));
}
const AI_MODEL_PRESETS = computed(() => [
  { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: tr('set.ai.preset.bailian'), base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: tr('set.ai.preset.volc'), base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'deepseek-v3' },
  { name: tr('set.ai.preset.ollama'), base: 'http://127.0.0.1:11434/v1', model: '' },
]);
function newAiSessionId(): string {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
async function openAiPage() {
  if (!aiSessionId.value) aiSessionId.value = newAiSessionId();
  aiView.value = aiMsgs.value.length ? 'chat' : 'landing';
  try {
    aiConf.value = await api('GET', '/assistant/config');
    aiSessions.value = await api('GET', '/assistant/sessions');
  } catch { /* 锁定态忽略 */ }
}
function aiNewSession() {
  aiAbort?.abort();
  aiSessionId.value = newAiSessionId();
  aiMsgs.value = [];
  aiView.value = 'landing';
  aiModelOpen.value = false;
}
async function aiDelSession(id: string) {
  if (!confirm(tr('ai.confirmDeleteSession'))) return;
  await api('DELETE', '/assistant/session?id=' + encodeURIComponent(id));
  aiSessions.value = await api('GET', '/assistant/sessions');
  if (aiSessionId.value === id) aiNewSession();
}
async function aiOpenSession(id: string) {
  aiAbort?.abort();
  const s = await api('GET', '/assistant/session?id=' + encodeURIComponent(id));
  aiSessionId.value = id;
  aiMsgs.value = (s.msgs || []).map((m: any) => ({ id: aiMsgId(), role: m.role, text: m.content }));
  aiModelOpen.value = false;
  aiView.value = 'chat';
  aiScrollToEnd(true);
}
function aiFill(text: string) {
  aiInput.value = text;
  (document.getElementById('aiInbox') as HTMLTextAreaElement | null)?.focus();
}
function aiGrow(e: Event) {
  const t = e.target as HTMLTextAreaElement;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}
const AI_TOOL_KEYS: Record<string, string> = {
  add_asset: 'ai.tool.add_asset', update_asset: 'ai.tool.update_asset', delete_asset: 'ai.tool.delete_asset',
  search_assets: 'ai.tool.search_assets', get_asset: 'ai.tool.get_asset', link_assets: 'ai.tool.link_assets',
  remember: 'ai.tool.remember', recall: 'ai.tool.recall', probe_server: 'ai.tool.probe_server',
};
function aiToolCn(t: string): string {
  const k = AI_TOOL_KEYS[t];
  return k ? tr(k as any) : t;
}
/** 工具没给 summary 时，卡片兜底显示精简结果，避免只剩一个空标题 */
function aiBriefCard(r: any): string {
  if (!r || typeof r !== 'object') return '';
  const rest: any = { ...r };
  delete rest.needsConfirm; delete rest.cid; delete rest.summary;
  try {
    const s = JSON.stringify(rest);
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  } catch { return ''; }
}
async function aiSend() {
  const text = aiInput.value.trim();
  if (!text || stewardBusy.value) return;
  aiInput.value = '';
  aiModelOpen.value = false;
  const userId = aiMsgId();
  aiMsgs.value.push({ id: userId, role: 'user', text });
  // 流式占位必须是响应式对象，逐块改 text 才会触发渲染；失败时保留原文供重试
  const reply = reactive({
    id: aiMsgId(), role: 'assistant', text: '',
    failed: false, retryText: text, retryUserId: userId,
  });
  aiMsgs.value.push(reply);
  stewardBusy.value = true;
  aiView.value = 'chat';
  aiScrollToEnd(true);
  const ac = new AbortController();
  aiAbort = ac;
  try {
    const res = await fetch('/api/assistant/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: aiSessionId.value, text }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(tr('ai.err.http', { s: res.status }));
    if (!res.body) throw new Error(tr('ai.err.noStream'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const onEvent = (evt: any) => {
      if (evt.type === 'delta') {
        reply.text += evt.text || '';
        aiScrollToEnd();
      } else if (evt.type === 'card') {
        const c = evt.card || {};
        aiMsgs.value.splice(Math.max(0, aiMsgs.value.length - 1), 0, {
          id: aiMsgId(), role: 'assistant', kind: 'tool', tool: aiToolCn(c.tool),
          summary: c.result?.summary || aiBriefCard(c.result),
          needsConfirm: !!c.result?.needsConfirm, cid: c.result?.cid || '',
        });
        aiScrollToEnd(true);
      } else if (evt.type === 'error') {
        reply.failed = true;
        reply.text += (reply.text ? '\n' : '') + tr('ai.err.generic', { msg: evt.message || tr('ai.err.unknown') });
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* 忽略坏帧 */ }
      }
    }
    if (!reply.text.trim()) reply.text = tr('ai.done');
    try { aiSessions.value = await api('GET', '/assistant/sessions'); } catch { /* 锁定态忽略 */ }
  } catch (e: any) {
    reply.failed = true;
    if (e?.name === 'AbortError') {
      if (!reply.text.trim()) reply.text = tr('ai.stopped');
    } else {
      reply.text += (reply.text ? '\n' : '') + tr('ai.err.generic', { msg: e?.message || e });
    }
  } finally {
    stewardBusy.value = false;
    aiAbort = null;
    aiScrollToEnd();
  }
}
/** 失败后重试：移除失败的回复气泡和它对应的提问，再按原文重发 */
function aiRetry(m: any) {
  if (stewardBusy.value) return;
  const drop = new Set([m.id, m.retryUserId].filter(Boolean));
  aiMsgs.value = aiMsgs.value.filter((x) => !drop.has(x.id));
  aiInput.value = m.retryText || '';
  aiSend();
}
async function aiConfirm(cid: string, approve: boolean) {
  try {
    const r = await api('POST', '/assistant/confirm', { cid, approve, sessionId: aiSessionId.value });
    aiMsgs.value.push({ id: aiMsgId(), role: 'assistant', kind: 'tool', tool: approve ? tr('ai.tool.delete_asset') : tr('ai.tool.cancel'), summary: approve ? tr('ai.deleted', { name: r.name }) : tr('ai.deleteCancelled') });
  } catch (e: any) {
    aiMsgs.value.push({ id: aiMsgId(), role: 'assistant', kind: 'tool', tool: tr('ai.tool.delete_asset'), summary: tr('ai.actionFailed', { msg: e?.message || e }) });
  }
}
async function aiPickModel(p: { name: string; base: string; model: string }) {
  if (!p.model) { aiModelOpen.value = false; tab.value = 'settings'; return; } // Ollama 等需自填模型名 → 去设置
  const r = await api('PUT', '/assistant/config', { base: p.base, name: p.name, model: p.model });
  aiConf.value = r;
  aiModelOpen.value = false;
  if (r.keyCleared) {
    // 复用全局轻提示：换服务商后旧 Key 已清空，必须提醒重填
    clipMsg.value = tr('msg.providerSwitched');
    setTimeout(() => (clipMsg.value = ''), 4000);
  }
}

async function issueHttpProxy() {
  if (!detail.value) return;
  const r = await api('POST', '/proxy/issue', { assetId: detail.value.id, ttl: 3600 });
  issueInfo.value = r.error ? r : { kind: 'http', ...r };
}

async function issueSshProxy() {
  if (!detail.value) return;
  const r = await api('POST', '/ssh/issue', { assetId: detail.value.id, ttl: 3600 });
  issueInfo.value = r.error ? r : { kind: 'ssh', ...r };
}

function mask(v: any) {
  if (v === undefined || v === null || v === '') return '—';
  return showSecrets.value ? String(v) : '••••••••';
}

function detailRows(a: any) {
  const skip = ['id', 'createdAt', 'updatedAt', 'type', 'links', 'extra'];
  const rows = Object.entries(a).filter(([k]) => !skip.includes(k));
  // 自定义字段平铺展示（中文名从字段定义里取）
  for (const [k, v] of Object.entries(a?.extra || {})) rows.push([k, v]);
  return rows;
}

// ===== 详情页：字段显示名 + 一键复制 =====
// 字段名统一走 shared/i18n 的 meta.field.*（审计日志、列头、详情抽屉同一套），不要再本地维护映射

/** 描述性字段不给复制按钮（名称 / 备注 / 标签 / 分组） */
const NO_COPY = new Set(['name', 'note', 'tags', 'group']);
/** 与后端 stripSecrets / 审计脱敏共用 schema 里的唯一清单 */
const SECRET_KEYS: string[] = SECRET_FIELDS as string[];

function fieldLabel(k: string): string {
  void lang.value;
  // 自定义字段用用户起的名字；内置字段走 i18n 字典，再退回内置字段定义的中文名，
  // 抽屉和表单同一套 label（certStatus 这类没进 meta.field 的不再露 raw key）
  return customFieldLabel(fieldSchema.value, k) || fieldNameLabel(k, BUILTIN_FIELD_LABELS);
}
function isSecretField(k: string): boolean {
  return SECRET_KEYS.includes(k) || isCustomSecret(fieldSchema.value, k);
}
/**
 * 某条资产的敏感字段 key 清单（内置 SECRET_FIELDS + 标记为敏感的自定义 extra 字段）。
 * 列表接口已把这些字段剥掉（vault.ts stripSecrets），抽屉拿不到值；
 * 这里只负责告诉渲染层「哪些字段该渲染脱敏占位行」，不拉明文。
 */
function secretKeysOf(a: any): string[] {
  if (!a) return [];
  const keys = new Set<string>();
  for (const f of formFieldsFor(a.type, fieldSchema.value)) {
    // 自定义字段的 f.k 形如 extra:cf_xxx，资产里存的是裸 key；统一用裸 key，
    // 否则抽屉里会露出 extra:cf_xxx 这种内部标识，而且同一字段会出现两行
    if (f.secret || isSecretField(f.k)) keys.add(f.extraKey || f.k);
  }
  for (const f of fieldSchema.value.custom || []) {
    if (f.secret && (f.scope === a.type || f.scope === '*')) keys.add(f.key);
  }
  return [...keys];
}
function displayValue(v: any): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function canCopy(k: string, v: any): boolean {
  if (NO_COPY.has(k)) return false;
  return !(v === undefined || v === null || v === '');
}

/** 复制真实值：敏感字段即使屏幕上打码，复制出来的仍是明文，方便直接粘贴使用 */
const copiedKey = ref('');
const clipMsg = ref('');
let clipTimer: number | undefined;
/** 敏感值复制 30s 后自动清空剪贴板；期间用户复制了别的内容则不动它 */
function scheduleClipboardClear(k: string, text: string) {
  if (!isSecretField(k)) return;
  if (clipTimer) clearTimeout(clipTimer);
  clipTimer = window.setTimeout(async () => {
    try {
      const cur = await navigator.clipboard.readText();
      if (cur === text) {
        await navigator.clipboard.writeText('');
        clipMsg.value = tr('msg.clipCleared');
        setTimeout(() => (clipMsg.value = ''), 3000);
      }
    } catch {
      /* 拿不到剪贴板读取权限时跳过清空 */
    }
  }, 30_000);
}
async function copyValue(k: string, v: any) {
  const text = Array.isArray(v) ? v.join(', ') : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copiedKey.value = k;
    scheduleClipboardClear(k, text);
    setTimeout(() => {
      if (copiedKey.value === k) copiedKey.value = '';
    }, 1500);
  } catch {
    copiedKey.value = '';
  }
}


/** 列表类型旁徽章：来自 FIELD_DEFS.listBesideType */
function listBesideBadges(a: any): { key: string; label: string }[] {
  if (!a?.type) return [];
  // 该字段若已在表格里单独成列，类型标签旁就不再重复显示（避免同一信息出现两次）
  const shownAsColumn = new Set(
    activeColumns.value.map((c: any) => c.key).filter(Boolean)
  );
  const out: { key: string; label: string }[] = [];
  for (const d of FIELD_DEFS) {
    if (!d.listBesideType || d.assetType !== a.type) continue;
    if (shownAsColumn.has(d.fieldKey)) continue;
    const v = a[d.fieldKey];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    out.push({ key: d.key, label: String(v).trim() });
  }
  return out;
}

// ===== 模型用量（AI 用量监控：余额 / 消费 / 资源包 / 模型清单 / 探测） =====

/**
 * 模型用量专用请求：通用 api() 不检查 HTTP 状态码，
 * 404 时返回 {error:'not found'} 会被当成正常结果导致静默失败，这里显式校验。
 */
async function aiApi(method: string, path: string, body?: any) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(tr('err.apiMissing'));
    }
    throw new Error(j?.error || tr('err.request', { status: res.status }));
  }
  return j;
}

const aiAccounts = ref<any[]>([]);
/** 选中的云账号 id；`__all__` = 合并全部账号（免费额度/模型清单左侧标账号名） */
const AI_ALL = '__all__';
const aiAccountId = ref('');
const aiViewAll = computed(() => aiAccountId.value === AI_ALL);
const aiSnapshot = ref<any>(null);
/** 全局价目目录（与账号无关；悬停详情 / 改价监控） */
const aiCatalog = ref<any>(null);
/** 「全部」模式下各账号快照（单账号模式不用） */
const aiAllSnapshots = ref<{ accountId: string; accountName: string; snap: any }[]>([]);
const aiConfig = ref<any>({ probeIntervalHours: 6, accounts: {}, probeModels: [] });
/** 百炼 CLI 的 Profile 列表：多账号时每个阿里云账号登录到一个独立 Profile */
const aiProfiles = ref<any[]>([]);
const aiCliOk = ref(false);
const aiCliReason = ref('');
const aiCliSuggest = ref('');
/** bl 的可执行完整路径（装在项目 node_modules/.bin，不在用户 PATH）——由后端下发 */
const aiBlCmd = ref('bl');
/** thcli 完整路径（腾讯云 TokenHub） */
const aiThCmd = ref('thcli');
/** arkcli 完整路径（火山方舟） */
const aiArkCmd = ref('arkcli');
/** 当前账号对应的 CLI 厂商 */
const aiCliProvider = ref<'aliyun' | 'tencent' | 'volcengine'>('aliyun');
/** CLI 未登录时的登录引导展开态（修复「教你登录的按钮要登录后才出现」的死循环） */
const aiCliSetupOpen = ref(false);
const aiBindProfile = ref('');
/**
 * 后端还没有 `/ai-usage/profiles`（改了后端但没重启）时为 true。
 * 此时不能用 Profile 下拉，降级为「绑定 CLI 当前登录身份」的老路径，
 * 否则用户会看到绑定入口凭空消失。
 */
const aiCliApiMissing = ref(false);
/** CLI 自检结果（网关通不通、当前激活是谁、修复命令是什么） */
const aiCliStatus = ref<any>(null);
const aiCliChecking = ref(false);
/** 百炼控制台一键续期进行中（可能打开浏览器并等待） */
const aiCliRenewing = ref(false);
/** 修复 CLI 登录态的命令（可复制） */
const aiCliFixCmd = computed(() => {
  if (aiCliProvider.value === 'tencent') {
    return String(aiCliStatus.value?.loginCmd || aiCliStatus.value?.fix || `${aiThCmd.value} auth login`);
  }
  if (aiCliProvider.value === 'volcengine') {
    return String(aiCliStatus.value?.loginCmd || aiCliStatus.value?.fix || `${aiArkCmd.value} auth login volc-sso`);
  }
  return aiCliStatus.value?.ok === false
    ? String(aiCliStatus.value?.fix || 'bl auth login --console')
    : 'bl auth login --console';
});
/** 当前选中云账号的适配器 id */
const aiAccountProviderId = computed(() => {
  if (aiViewAll.value) return 'aliyun';
  const a = aiAccounts.value.find((x: any) => x.id === aiAccountId.value);
  const p = String(a?.provider || '');
  if (p === 'tencent' || p.includes('腾讯')) return 'tencent';
  if (p === 'volcengine' || p.includes('火山')) return 'volcengine';
  return 'aliyun';
});
const aiIsTencent = computed(() => aiAccountProviderId.value === 'tencent');
const aiIsVolc = computed(() => aiAccountProviderId.value === 'volcengine');
const aiCloudLabel = computed(() =>
  aiIsTencent.value ? tr('cloud.tencent') : aiIsVolc.value ? tr('cloud.volcano') : tr('cloud.aliyun')
);
const aiCliLabel = computed(() =>
  aiIsTencent.value ? tr('cli.tencent') : aiIsVolc.value ? tr('cli.volcano') : tr('cli.aliyun')
);
/** 主登录命令（按厂商） */
const aiLoginCmd = computed(() => {
  if (aiIsTencent.value) return `${aiThCmd.value} auth login`;
  if (aiIsVolc.value) return `${aiArkCmd.value} auth login volc-sso`;
  return `${aiBlCmd.value} auth login --console`;
});
/** 是否展开「添加新登录身份」面板 */
const aiAddCliOpen = ref(false);
/** 新增身份的 Profile 名（留空则用后端建议名） */
const aiNewProfileName = ref('');
const aiNewProfileEff = computed(
  () => (aiNewProfileName.value || '').trim() || aiCliSuggest.value || 'profile-2'
);
/** 为当前账号新登录一个 CLI 身份的命令（computed 内必须 .value，否则会拼成 [object Object]） */
const aiAddCmd = computed(() => {
  const name = String(aiNewProfileEff.value || 'profile-2').trim() || 'profile-2';
  // 给 shell 用：名字含空格/特殊字符时加引号，避免 zsh bad pattern
  const safe = /^[A-Za-z0-9._-]+$/.test(name) ? name : JSON.stringify(name);
  if (aiIsTencent.value) {
    // TokenHub：先 create profile 再 login（两条命令；界面只展示登录，create 写在步骤说明里）
    return `${aiThCmd.value} auth login --profile ${safe}`;
  }
  if (aiIsVolc.value) {
    // Ark：先 SSO 登录（不要带尚未创建的 --profile），再 profile create
    return `${aiArkCmd.value} auth login volc-sso`;
  }
  return `${aiBlCmd.value} auth login --console --config ${safe}`;
});
/** 当前选中账号的显示名（引导文案里要点名，避免用户搞混是为哪个账号登录） */
const aiAccountName = computed(
  () =>
    aiViewAll.value
      ? tr('aiu.allAccounts')
      : aiAccounts.value.find((a: any) => a.id === aiAccountId.value)?.name || tr('aiu.thisAccount')
);
/** 当前账号是否已绑定 CLI Profile（未绑定 → 不显示任何额度，只给绑定入口） */
const aiNeedBind = computed(() => {
  if (aiViewAll.value) return false;
  const c = aiSnapshot.value?.cli;
  return !!c && c.ok === true && c.bound !== true;
});
/** 免费额度的数据来源说明：失败要写原因、过期要标注、成功要标明来自哪个身份 */
const aiQuotaSource = computed(() => {
  const c = aiSnapshot.value?.cli;
  if (!c || !c.ok) return null;
  if (c.quotaError) {
    return {
      kind: 'err' as const,
      text: `取免费额度失败：${c.quotaError}`,
      stale: !!c.quotaStale,
    };
  }
  if (c.quotaStale) {
    return {
      kind: 'stale' as const,
      text: `本次没取到新数据，下面是上次成功取到的结果（${
        c.quotaFetchedAt ? c.quotaFetchedAt.slice(0, 19).replace('T', ' ') : '时间未知'
      }）`,
      stale: true,
    };
  }
  return null;
});
/** 余额/账单是否为上次成功取到的旧值（本次刷新失败时沿用，见 collectAccount 的逐字段沿用逻辑） */
const aiAcctStale = computed(() => {
  const s = aiSnapshot.value;
  if (!s?.acctStale) return null;
  const t = s.acctFetchedAt ? s.acctFetchedAt.slice(0, 19).replace('T', ' ') : '时间未知';
  return `余额/账单本次没取到新数据，显示的是上次成功取到的结果（${t}）${s.error ? '；本次失败原因：' + s.error : ''}`;
});
/** 已绑定身份的一行摘要：随时能核对「这些额度到底是谁的」 */
const aiBoundSummary = computed(() => {
  const c = aiSnapshot.value?.cli;
  if (!c?.ok || !c.bound) return null;
  return {
    profile: c.boundProfile || '—',
    workspace: c.boundWorkspace || c.identity?.workspaceId || '',
    apiKey: c.identity?.apiKey || '',
  };
});
/** 选中的 Profile 跟本账号对不上时的风险提示（仍然允许绑，但不能让你蒙着眼绑） */
const aiBindWarn = computed(() => {
  const sel = aiProfiles.value.find((p: any) => p.name === aiBindProfile.value);
  if (!sel || !aiProfiles.value.length) return '';
  if (sel.match) return '';
  if (sel.boundTo) {
    return `「${sel.name}」已经被另一个云账号绑定了，同一个身份绑到两个账号会让两边显示同一份额度。`;
  }
  if (aiProfiles.value.some((p: any) => p.match)) {
    return `「${sel.name}」与本账号的 API Key / 业务空间对不上，绑了以后这里显示的可能是别的阿里云账号的额度。`;
  }
  return '';
});
/** 下拉里标注「哪个 Profile 才是本账号的」，避免用户靠猜 */
const aiProfileLabel = (p: any) => {
  const bits = [p.name + (p.active ? ' · 当前激活' : '')];
  if (p.match) bits.push('✓ 属于本账号');
  else if (p.boundTo) bits.push(`已被其他账号绑定`);
  bits.push(p.identity?.workspaceId ? `空间 ${p.identity.workspaceId}` : '空间未知');
  bits.push(p.identity?.apiKey || '未登录');
  return bits.join('｜');
};
const aiSubTab = ref<'free' | 'spend' | 'models' | 'changes'>('free');
const AI_SUB_KEYS: Record<string, string> = {
  free: 'aiu.sub.free',
  spend: 'aiu.sub.spend',
  models: 'aiu.sub.models',
  changes: 'aiu.sub.changes',
};
const aiSubLabel = computed(() => tr((AI_SUB_KEYS[aiSubTab.value] || 'aiu.sub.free') as any));

// ===== 模型清单列配置（和资产清单同一套思路：按需显示列，选择本地记住） =====
const AI_COL_DEFS = [
  { k: 'model', label: '模型', fixed: true },
  { k: 'kind', label: '类型' },
  { k: 'quota', label: '剩余 / 总量' },
  { k: 'pct', label: '剩余 %' },
  { k: 'expires', label: '到期' },
  { k: 'reset', label: '重置' },
  { k: 'price', label: '用完后价' },
  { k: 'switch', label: '计费开关' },
];
const AI_COLS_KEY = 'mgui.aiusage.cols';
const aiColOpts = AI_COL_DEFS.filter((c) => !c.fixed);
const aiCols = ref<string[]>((() => {
  try {
    const raw = localStorage.getItem(AI_COLS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length) return arr.filter((k: string) => aiColOpts.some((c) => c.k === k));
  } catch {
    /* 忽略损坏的本地配置 */
  }
  // 默认全开：列配置是为了「关掉不关心的」，不是让用户一开始就看不到数据
  return aiColOpts.map((c) => c.k);
})());
function aiColOn(k: string): boolean {
  if (k === 'model') return true;
  return aiCols.value.includes(k);
}
function aiToggleCol(k: string) {
  if (k === 'model') return;
  aiCols.value = aiCols.value.includes(k) ? aiCols.value.filter((x) => x !== k) : [...aiCols.value, k];
  try {
    localStorage.setItem(AI_COLS_KEY, JSON.stringify(aiCols.value));
  } catch {
    /* 隐身模式忽略 */
  }
}
function aiColsAll(on: boolean) {
  aiCols.value = on ? aiColOpts.map((c) => c.k) : [];
  try {
    localStorage.setItem(AI_COLS_KEY, JSON.stringify(aiCols.value));
  } catch {
    /* 同上 */
  }
}

// ===== 模型清单（目录表）列配置：名称/能力/发布/价格 =====
const AI_DIR_COLS_KEY = 'mgui.aiusage.dircols';
const aiDirOpts = [
  { k: 'name', label: '名称' },
  { k: 'caps', label: '能力' },
  { k: 'published', label: '发布' },
  { k: 'price', label: '价格' },
];
const aiDirCols = ref<string[]>((() => {
  try {
    const raw = localStorage.getItem(AI_DIR_COLS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length) return arr.filter((k: string) => aiDirOpts.some((c) => c.k === k));
  } catch {
    /* 忽略 */
  }
  return aiDirOpts.map((c) => c.k);
})());
/** 列配置弹窗：'' 关闭 / 'quota' 免费额度表 / 'dir' 模型清单表 */
const aiColPicker = ref<'' | 'quota' | 'dir'>('');
function pickerHas(k: string): boolean {
  return aiColPicker.value === 'quota' ? aiCols.value.includes(k) : aiDirCols.value.includes(k);
}
function pickerToggle(k: string) {
  if (aiColPicker.value === 'quota') aiToggleCol(k);
  else aiDirToggleCol(k);
}
function pickerAll(on: boolean) {
  if (aiColPicker.value === 'quota') {
    aiColsAll(on);
    return;
  }
  aiDirCols.value = on ? aiDirOpts.map((c) => c.k) : [];
  try {
    localStorage.setItem(AI_DIR_COLS_KEY, JSON.stringify(aiDirCols.value));
  } catch {
    /* 忽略 */
  }
}
function aiDirColOn(k: string): boolean {
  return aiDirCols.value.includes(k);
}
function aiDirToggleCol(k: string) {
  aiDirCols.value = aiDirCols.value.includes(k) ? aiDirCols.value.filter((x) => x !== k) : [...aiDirCols.value, k];
  try {
    localStorage.setItem(AI_DIR_COLS_KEY, JSON.stringify(aiDirCols.value));
  } catch {
    /* 忽略 */
  }
}
const aiBusy = ref(false);
const aiMsg = ref('');
const aiErr = ref('');
const aiModality = ref('全部');

/** 距下次自动探测的剩余时间（基于上次运行时间 + 配置间隔推算） */
const aiNextProbe = computed(() => {
  const cfg = aiConfig.value || {};
  const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
  if (!last) return tr('aiu.firstProbe');
  const due = last + (Number(cfg.probeIntervalHours) || 6) * 3600 * 1000;
  const left = due - Date.now();
  if (left <= 0) return tr('aiu.probeDue');
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  return h > 0 ? tr('aiu.inHours', { h, m }) : tr('aiu.inMinutes', { n: m });
});

async function loadAiUsage() {
  aiErr.value = '';
  try {
    // 每次进入都重拉云账号列表 —— 资产里改名后下拉必须跟着变（以前只在空列表时拉一次）
    const all = await api('GET', '/assets');
    aiAccounts.value = (all || []).filter((a: any) => a.type === 'cloud_account');
    // 当前选中的账号若已被删，退回「全部」；首次进入默认全部账号
    if (
      aiAccountId.value &&
      aiAccountId.value !== AI_ALL &&
      !aiAccounts.value.some((a: any) => a.id === aiAccountId.value)
    ) {
      aiAccountId.value = AI_ALL;
    }
    if (!aiAccountId.value) aiAccountId.value = aiAccounts.value.length ? AI_ALL : '';
    await loadAiSnapshot();
  } catch (e: any) {
    aiErr.value = e.message || '加载失败';
  }
}

async function loadAiCatalog(provider = 'aliyun') {
  try {
    const r = await aiApi('GET', '/ai-usage/catalog?provider=' + encodeURIComponent(provider));
    if (r?.catalog) aiCatalog.value = r.catalog;
  } catch {
    /* 目录可选，失败不挡主流程 */
  }
}

async function aiRefreshCatalog() {
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const r = await aiApi('POST', '/ai-usage/catalog/refresh', { provider: 'aliyun' });
    aiCatalog.value = r?.catalog || null;
    const d = r?.catalog?.lastDiff;
    const n =
      (d?.added?.length || 0) + (d?.removed?.length || 0) + (d?.priceChanged?.length || 0);
    if (r?.catalog?.error) aiErr.value = r.catalog.error;
    else if (n)
      aiMsg.value = `价目已更新：新增 ${d.added?.length || 0} / 下架 ${d.removed?.length || 0} / 改价 ${d.priceChanged?.length || 0}`;
    else aiMsg.value = `价目已刷新（${r?.catalog?.total || 0} 个模型家族，本次无变更）`;
    // 用新价目 enrich 当前清单
    await loadAiSnapshot();
  } catch (e: any) {
    aiErr.value = e.message || '刷新价目失败';
  } finally {
    aiBusy.value = false;
  }
}

async function loadAiSnapshot() {
  if (!aiAccountId.value) {
    aiSnapshot.value = null;
    aiAllSnapshots.value = [];
    return;
  }
  try {
    if (aiViewAll.value) {
      const rows: { accountId: string; accountName: string; snap: any }[] = [];
      let cfg: any = null;
      let cat: any = null;
      for (const a of aiAccounts.value) {
        const r = await aiApi('GET', '/ai-usage/snapshot?accountId=' + encodeURIComponent(a.id));
        if (r?.config) cfg = r.config;
        if (r?.catalog) cat = r.catalog;
        rows.push({ accountId: a.id, accountName: a.name || a.id, snap: r?.snapshot || null });
      }
      aiAllSnapshots.value = rows;
      if (cfg) aiConfig.value = cfg;
      if (cat) aiCatalog.value = cat;
      else await loadAiCatalog('aliyun');
      // 合成一个只读快照，供 KPI / 子页复用既有字段路径
      const freeQuotas: any[] = [];
      const models: any[] = [];
      let modelTotal = 0;
      let spendTotal = 0;
      let aiSpend = 0;
      let hasSnap = false;
      for (const row of rows) {
        const s = row.snap;
        if (!s) continue;
        hasSnap = true;
        if (typeof s.spendTotal === 'number') spendTotal += s.spendTotal;
        if (typeof s.aiSpend === 'number') aiSpend += s.aiSpend;
        for (const q of s.freeQuotas || []) {
          freeQuotas.push({ ...q, accountId: row.accountId, accountName: row.accountName });
        }
        for (const m of s.models || []) {
          models.push({
            ...m,
            accountId: row.accountId,
            accountName: row.accountName,
            _rowKey: `${row.accountId}:${m.id}`,
          });
        }
        modelTotal += Number(s.modelTotal || (s.models || []).length || 0);
      }
      aiSnapshot.value = hasSnap
        ? {
            accountId: AI_ALL,
            ts: new Date().toISOString(),
            freeQuotas,
            models,
            modelTotal,
            spendTotal,
            aiSpend,
            balance: null,
            packages: [],
            spendRows: [],
            probes: [],
            changes: { added: [], removed: [] },
            cli: { ok: true, bound: true },
          }
        : null;
      await loadAiProfiles();
      return;
    }
    aiAllSnapshots.value = [];
    const r = await aiApi('GET', '/ai-usage/snapshot?accountId=' + encodeURIComponent(aiAccountId.value));
    aiSnapshot.value = r?.snapshot || null;
    if (r?.config) aiConfig.value = r.config;
    if (r?.catalog) aiCatalog.value = r.catalog;
    else await loadAiCatalog(r?.snapshot?.provider || 'aliyun');
    await loadAiProfiles();
  } catch (e: any) {
    aiErr.value = e.message || '加载失败';
  }
}

/** 免费额度行：挂上价目摘要（用完后按量价） */
function quotaPriceOf(model: string): { summary: string; prices: any[] } {
  const id = String(model || '');
  const fromModels = (aiSnapshot.value?.models || []).find((m: any) => m.id === id);
  if (fromModels?.price || fromModels?.prices?.length) {
    return { summary: fromModels.price || '—', prices: fromModels.prices || [] };
  }
  const cat = aiCatalog.value?.models || [];
  const exact = cat.find((m: any) => m.id === id);
  if (exact) return { summary: exact.price || '—', prices: exact.prices || [] };
  let best: any = null;
  let bestLen = -1;
  for (const m of cat) {
    if (id.startsWith(m.id + '-') || id.startsWith(m.id + '_') || id.startsWith(m.id + '.')) {
      if (String(m.id).length > bestLen) {
        best = m;
        bestLen = String(m.id).length;
      }
    }
  }
  return best
    ? { summary: best.price || '—', prices: best.prices || [] }
    : { summary: '—', prices: [] };
}

/** 价目条目名（厂商给的是中文名，如「输入」「输出（缓存命中）」） */
function priceName(name?: string, fallback?: string): string {
  const n = String(name || '');
  if (!n) return fallback || tr('aiu.price.item');
  if (n === '输入') return tr('price.name.input');
  if (n === '输出') return tr('price.name.output');
  if (/^输入.*缓存命中/.test(n)) return tr('price.name.inputCache');
  if (/^输出.*缓存命中/.test(n)) return tr('price.name.outputCache');
  if (n === '缓存命中') return tr('price.name.cacheHit');
  let m = n.match(/^写缓存（(.+)）$/);
  if (m) return tr('price.name.cacheWrite', { t: m[1] });
  m = n.match(/^(\d+)小时显式缓存创建$/);
  if (m) return tr('price.name.cacheCreateH', { h: m[1] });
  m = n.match(/^(\d+)分钟显式缓存创建$/);
  if (m) return tr('price.name.cacheCreateM', { m: m[1] });
  m = n.match(/^(\d+K)图片生成$/);
  if (m) return tr('price.name.imgGen', { r: m[1] });
  m = n.match(/^(\d+K)图片输入$/);
  if (m) return tr('price.name.imgInput', { r: m[1] });
  return n;
}
/** 价目单位（厂商给的是中文单位） */
function priceUnit(u?: string): string {
  const s = String(u || '');
  if (!s) return '';
  if (/百万\s*tokens?/i.test(s)) return tr('price.unit.million');
  if (/千\s*tokens?/i.test(s)) return tr('price.unit.thousand');
  if (/万字符/.test(s)) return tr('price.unit.tenKChars');
  if (/每秒|\/秒/.test(s) || s === '秒') return tr('price.unit.second');
  if (/每张|\/张/.test(s) || s === '张') return tr('price.unit.image');
  return s.replace(/^每/, '');
}
/** 价目摘要：后端/缓存里存的是中文摘要（入 10 / 出 30 · 百万tokens），英文界面就地改写 */
function priceSummary(s?: string): string {
  if (!s) return '—';
  if (lang.value !== 'en-US') return s;
  return s
    .replace(/标价免费/g, tr('price.free'))
    .replace(/入 /g, tr('price.in') + ' ')
    .replace(/出 /g, tr('price.out') + ' ')
    .replace(/百万\s*tokens/g, tr('price.unit.million'))
    .replace(/千\s*tokens/g, tr('price.unit.thousand'))
    .replace(/万字符/g, tr('price.unit.tenKChars'))
    .replace(/(\S+)\/(\S+)起/g, (_, a, b) => tr('price.startFrom', { p: a, u: b }));
}

/** 额度重置说明（后端/缓存里是中文） */
const RESET_TEXT_KEY: Record<string, string> = {
  免费推理额度: 'ark.reset.freeQuota',
  每月1日重置: 'reset.monthly',
  周期重置: 'reset.cyclic',
  到期作废: 'reset.expired',
};
function resetText(q: any): string {
  const raw = q?.reset?.text || '—';
  const k = RESET_TEXT_KEY[raw];
  return k ? tr(k as any) : raw;
}

function formatPriceLine(p: any): string {
  const disc =
    p.discount != null && Number(p.discount) > 0 && Number(p.discount) < 1
      ? tr('aiu.price.discount', { pct: Math.round((1 - Number(p.discount)) * 100) })
      : '';
  const unit = p.unit ? ` / ${priceUnit(p.unit)}` : '';
  return `${priceName(p.name, p.type)}: ¥${p.price}${unit}${disc}`;
}

/** 读取 CLI 的 Profile 列表与各自身份，供「哪个 Profile 属于哪个云账号」的选择 */
async function loadAiProfiles() {
  try {
    const params = new URLSearchParams();
    if (aiAccountId.value && !aiViewAll.value) params.set('accountId', aiAccountId.value);
    params.set('provider', aiAccountProviderId.value);
    const probe = await fetch('/api/ai-usage/profiles?' + params.toString());
    aiCliApiMissing.value = !probe.ok;
    if (!probe.ok) return;
    const r = await probe.json().catch(() => null);
    aiCliProvider.value =
      r?.provider === 'tencent' ? 'tencent' : r?.provider === 'volcengine' ? 'volcengine' : 'aliyun';
    aiCliOk.value = !!r?.ok;
    // CLI 已装但未登录：用 loggedIn / reason 引导
    if (r?.provider === 'tencent' && r?.ok && r?.loggedIn === false) {
      aiCliOk.value = false;
      aiCliReason.value = 'TokenHub CLI 未登录（需 thcli auth login）';
    } else if (r?.provider === 'volcengine' && r?.ok && r?.loggedIn === false) {
      aiCliOk.value = false;
      aiCliReason.value = 'Ark CLI 未登录（需 arkcli auth login volc-sso）';
    } else {
      aiCliReason.value = r?.reason || '';
    }
    aiCliSuggest.value = r?.suggest || '';
    if (r?.blCmd) aiBlCmd.value = r.blCmd;
    if (r?.thCmd) aiThCmd.value = r.thCmd;
    if (r?.arkCmd) aiArkCmd.value = r.arkCmd;
    aiProfiles.value = r?.profiles || [];
    const bound = aiConfig.value?.cliBindings?.[aiAccountId.value];
    aiBindProfile.value =
      bound ||
      (r?.profiles || []).find((p: any) => p.match)?.name ||
      (r?.profiles || []).find((p: any) => p.active)?.name ||
      '';
  } catch {
    aiProfiles.value = [];
  }
}

/**
 * 在终端为另一个阿里云账号登录 CLI 之后，刷新身份列表。
 * 不用重启应用 —— `bl config list` 是实时读配置的。
 * 刷到「属于本账号」的身份就自动选中并把面板收起，省得用户再找一遍。
 */
async function aiRefreshProfiles() {
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const before = aiProfiles.value.map((p: any) => p.name);
    await loadAiProfiles();
    const names = aiProfiles.value.map((p: any) => p.name);
    const added = names.filter((n) => !before.includes(n));
    const m = aiProfiles.value.find((p: any) => p.match);
    if (added.length && m) {
      aiBindProfile.value = m.name;
      aiAddCliOpen.value = false;
      aiMsg.value = `已读到新身份「${added.join('、')}」，且匹配本账号 —— 点「绑定到本账号」即可`;
    } else if (added.length) {
      aiBindProfile.value = added[0];
      aiMsg.value = `已读到新身份「${added.join('、')}」，但没能自动匹配本账号，请核对下拉里的业务空间后再绑`;
    } else {
      aiMsg.value = `CLI 现有身份：${names.join('、') || '（无）'}。新身份没出现的话，确认终端那步是否已登录成功`;
    }
  } catch (e: any) {
    aiErr.value = e.message || '刷新身份列表失败';
  } finally {
    aiBusy.value = false;
  }
}

/**
 * CLI 自检：免费额度空白时，一键判断是「没装 / 没登录 / 令牌失效」。
 * 会真的打一次控制台网关（只读查询，不消耗额度）。
 */
async function loadAiCliStatus() {
  aiCliChecking.value = true;
  try {
    const params = new URLSearchParams({ check: '1', provider: aiAccountProviderId.value });
    if (aiAccountId.value && !aiViewAll.value) params.set('accountId', aiAccountId.value);
    const r = await fetch('/api/ai-usage/cli-status?' + params.toString());
    aiCliStatus.value = await r.json().catch(() => null);
    if (aiCliStatus.value?.blCmd) aiBlCmd.value = String(aiCliStatus.value.blCmd);
    if (aiCliStatus.value?.thCmd) aiThCmd.value = String(aiCliStatus.value.thCmd);
    if (aiCliStatus.value?.arkCmd) aiArkCmd.value = String(aiCliStatus.value.arkCmd);
    if (aiCliStatus.value?.provider === 'volcengine') aiCliProvider.value = 'volcengine';
    else if (aiCliStatus.value?.provider === 'tencent') aiCliProvider.value = 'tencent';
  } catch {
    aiCliStatus.value = null;
  } finally {
    aiCliChecking.value = false;
  }
}

/**
 * 百炼控制台一键续期：先用现有登录态拉额度；仅过期才 AK 换票；
 * 无团队权限则打开浏览器（约等 120 秒）。成功后直接读已写入的快照，不再立刻全量刷新毁掉登录态。
 */
async function aiRenewCli() {
  if (!aiAccountId.value || aiViewAll.value) {
    aiErr.value = '请先选中具体阿里云账号再续期';
    return;
  }
  if (aiAccountProviderId.value !== 'aliyun') {
    aiErr.value = '一键续期目前只支持阿里云百炼';
    return;
  }
  aiCliRenewing.value = true;
  aiErr.value = '';
  aiMsg.value =
    '正在续期… 若弹出浏览器：请用有百炼权限的账号点「授权」（浏览器已登录时通常只需点一下）。';
  try {
    const r = await aiApi('POST', '/ai-usage/cli-renew', {
      accountId: aiAccountId.value,
      profile: aiBindProfile.value || aiConfig.value?.cliBindings?.[aiAccountId.value] || undefined,
      launchBrowser: true,
      waitBrowserMs: 120_000,
    });
    if (r?.ok) {
      aiMsg.value = r.message || `续期成功，取到 ${r.quotaCount ?? 0} 条免费额度`;
      // 额度已在续期接口写入快照；先重载快照让错误条消失，再轻量刷新账单（不会再用 AK 覆盖登录态）
      await loadAiSnapshot();
      await loadAiCliStatus();
      try {
        await aiRefresh(false, true);
      } catch {
        /* 账单刷新失败不影响已写入的免费额度 */
      }
    } else {
      aiErr.value = r?.message || r?.error || '续期未完成';
      if (r?.browserLaunched) {
        aiMsg.value =
          '已打开浏览器。请完成授权后再次点「一键续期」（不必先点刷新）。';
      }
      await loadAiCliStatus();
    }
  } catch (e: any) {
    aiErr.value = e.message || '续期失败';
  } finally {
    aiCliRenewing.value = false;
  }
}

/** 把选中的 CLI Profile 绑定到当前云账号（之后该账号的额度一律用 --config <profile> 取） */
async function aiBindNow() {
  if (!aiAccountId.value || aiViewAll.value) return;
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const r = await aiApi('POST', '/ai-usage/bind', {
      accountId: aiAccountId.value,
      provider: aiAccountProviderId.value,
      profile: aiBindProfile.value,
    });
    aiConfig.value = r?.config || aiConfig.value;
    const ws = r?.identity?.workspaceId;
    const ks = r?.keySync;
    let msg = aiBindProfile.value
      ? `已把 Profile「${aiBindProfile.value}」${ws ? `（业务空间 ${ws}）` : ''}绑定到本账号`
      : '已解绑本账号的 CLI Profile';
    if (aiBindProfile.value && ks?.ok) {
      msg += ks.created
        ? `；已新建 API 密钥资产「${ks.name}」`
        : `；已更新 API 密钥资产「${ks.name}」`;
    } else if (aiBindProfile.value && ks && !ks.ok) {
      msg += `（未能同步 API Key：${ks.reason || '未知原因'}）`;
    }
    aiMsg.value = msg;
    // 绑定后必须立刻取一次数，故绕过限频（force）
    await aiRefresh(false, true);
    // 绑定只是「确认归属」，绝不能因为绑定就把已有额度清空 —— 取数失败要明说
    const qe = aiSnapshot.value?.cli?.quotaError;
    if (qe) aiErr.value = `已绑定「${aiBindProfile.value}」，但取额度失败：${qe}`;
  } catch (e: any) {
    aiErr.value = e.message || '绑定失败';
  } finally {
    aiBusy.value = false;
  }
}

/**
 * 降级绑定：后端没重启、拿不到 Profile 列表时使用。
 * 直接把 CLI **当前登录的身份**绑到本账号（旧接口 refresh 的 bindCli 参数）。
 * 只能绑一个账号 —— 多账号必须重启后用 Profile 下拉。
 */
async function aiBindLegacy() {
  if (!aiAccountId.value) return;
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const r = await aiApi('POST', '/ai-usage/refresh', {
      accountId: aiAccountId.value,
      probe: false,
      bindCli: true,
      force: true,
    });
    if (r?.snapshot?.error) aiErr.value = r.snapshot.error;
    // 绑定信息写在 config 里，refresh 只回 snapshot —— 必须重拉一次才能让「已绑定」状态立刻可见
    await loadAiSnapshot();
    // 再核对一次：太旧的后端（连 bindCli 都没有）会静默忽略绑定，必须明确告知而不是假装成功
    if (aiConfig.value?.cliBindings?.[aiAccountId.value]) {
      aiMsg.value = '已把 CLI 当前登录身份绑定到本账号';
    } else {
      aiErr.value = '绑定未生效 —— 当前运行的后端版本过旧（缺少绑定能力），请重启桌面端后再试';
    }
  } catch (e: any) {
    aiErr.value = e.message || '绑定失败';
  } finally {
    aiBusy.value = false;
  }
}

/**
 * 切换额度开关：
 * - 阿里云：用完即停（autoStop）
 * - 腾讯云：启用按 Token 计费（postpaid / PaymentEnabled）
 */
async function aiToggleStop(
  model: string,
  current: boolean | string | null,
  accountId?: string,
  endpointId?: string
) {
  const aid = accountId || (aiViewAll.value ? '' : aiAccountId.value);
  if (!aid) {
    aiErr.value = '请先选择具体账号，或在「全部」视图点某一行的开关（需带账号）';
    return;
  }
  const on = current !== true;
  const isTh = (() => {
    const a = aiAccounts.value.find((x: any) => x.id === aid);
    const p = String(a?.provider || '');
    return p === 'tencent' || p.includes('腾讯') || (!aiViewAll.value && aiIsTencent.value);
  })();
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const body: Record<string, unknown> = { accountId: aid, model, on };
    if (isTh) {
      if (endpointId) body.endpointId = endpointId;
      body.provider = 'tencent';
    }
    await aiApi('POST', '/ai-usage/freetier', body);
    const q = (aiSnapshot.value?.freeQuotas || []).find(
      (x: any) => x.model === model && (!aiViewAll.value || x.accountId === aid)
    );
    if (q) {
      if (isTh) {
        q.postpaid = on;
        q.autoStop = !on;
      } else {
        q.autoStop = on;
      }
    }
    aiMsg.value = isTh
      ? `${model}：按 Token 计费已${on ? '开启' : '关闭'}`
      : `${model}：用完即停已${on ? '开启' : '关闭'}`;
  } catch (e: any) {
    aiErr.value = e.message || '切换失败';
  } finally {
    aiBusy.value = false;
  }
}

/** 全部模型一键开/关（百炼=用完即停；腾讯=按 Token 计费） */
async function aiToggleStopAll(on: boolean) {
  if (aiViewAll.value) {
    aiErr.value = '「全部」视图不支持批量开关，请先选到具体账号';
    return;
  }
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    await aiApi('POST', '/ai-usage/freetier', {
      accountId: aiAccountId.value,
      all: true,
      on,
      provider: aiAccountProviderId.value,
    });
    aiMsg.value = aiIsTencent.value
      ? `全部接入点按 Token 计费已${on ? '开启' : '关闭'}，点「刷新数据」查看结果`
      : `全部模型用完即停已${on ? '开启' : '关闭'}，点「刷新数据」查看结果`;
  } catch (e: any) {
    aiErr.value = e.message || '切换失败';
  } finally {
    aiBusy.value = false;
  }
}

/** 腾讯云：领取免费额度（thcli models free） */
async function aiClaimFree(models: string[] | 'all') {
  if (aiViewAll.value) {
    aiErr.value = '「全部」视图不支持领取，请先选到具体腾讯云账号';
    return;
  }
  if (!aiIsTencent.value) {
    aiErr.value = '领取免费额仅支持腾讯云 TokenHub';
    return;
  }
  if (!aiAccountId.value) return;
  const label = models === 'all' ? '全部可领模型' : models.join(', ');
  if (!confirm(`确认用已绑定的 TokenHub 身份领取「${label}」的免费额度？`)) return;
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const body: Record<string, unknown> = {
      accountId: aiAccountId.value,
      provider: 'tencent',
    };
    if (models === 'all') body.all = true;
    else body.models = models;
    const r = await aiApi('POST', '/ai-usage/claim-free', body);
    aiMsg.value = r?.message || '领取完成，正在刷新额度…';
    await aiRefresh(false, true);
  } catch (e: any) {
    aiErr.value = e.message || '领取失败';
  } finally {
    aiBusy.value = false;
  }
}

function thStatusLabel(status?: string): string {
  const s = String(status || '').toLowerCase();
  if (s === 'online') return tr('aiu.status.online');
  if (s === 'pre-offline') return tr('aiu.status.preOffline');
  if (s === 'discontinued') return tr('aiu.status.discontinued');
  return status || '—';
}

async function aiRefresh(withProbe: boolean, force = false) {
  if (!aiAccountId.value) return;
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    if (aiViewAll.value) {
      const errs: string[] = [];
      for (const a of aiAccounts.value) {
        try {
          const r = await aiApi('POST', '/ai-usage/refresh', {
            accountId: a.id,
            probe: withProbe,
            force,
          });
          if (r?.snapshot?.error) errs.push(`${a.name}：${r.snapshot.error}`);
        } catch (e: any) {
          errs.push(`${a.name}：${e.message || '失败'}`);
        }
      }
      await loadAiSnapshot();
      if (errs.length) aiErr.value = errs.join('；');
      else aiMsg.value = withProbe
        ? `已刷新全部 ${aiAccounts.value.length} 个账号并探测`
        : `已刷新全部 ${aiAccounts.value.length} 个账号`;
      return;
    }
    const r = await aiApi('POST', '/ai-usage/refresh', {
      accountId: aiAccountId.value,
      probe: withProbe,
      force,
    });
    aiSnapshot.value = r?.snapshot || null;
    if (r?.snapshot?.error) aiErr.value = r.snapshot.error;
    else aiMsg.value = withProbe ? '已刷新并探测（消耗了少量额度）' : '已刷新数据（未消耗额度）';
  } catch (e: any) {
    aiErr.value = e.message || '刷新失败';
  } finally {
    aiBusy.value = false;
  }
}

/**
 * 自动刷新时是否顺带探测。
 * 探测是真实调用模型，会消耗额度（约 10 tokens/次）且会触发限流（429）。
 * 有 CLI 提供精确免费额度后，探测不再是必需项，故**默认关闭**（必须显式 === true 才开）。
 */
const aiAutoProbe = computed({
  get: () => aiConfig.value?.autoProbe === true,
  set: (v: boolean) => { aiConfig.value = { ...aiConfig.value, autoProbe: v }; },
});

async function aiSaveAutoProbe() {
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const r = await aiApi('PUT', '/ai-usage/config', { autoProbe: aiAutoProbe.value });
    if (r?.config) aiConfig.value = r.config;
    aiMsg.value = aiAutoProbe.value
      ? '自动刷新将同时探测（每次约 120 tokens）'
      : '自动刷新只走免费数据源，不再消耗额度';
  } catch (e: any) {
    aiErr.value = e.message || '保存失败';
  } finally {
    aiBusy.value = false;
  }
}

async function aiSaveInterval() {
  aiBusy.value = true;
  aiErr.value = '';
  aiMsg.value = '';
  try {
    const r = await aiApi('PUT', '/ai-usage/config', { probeIntervalHours: Number(aiConfig.value.probeIntervalHours) });
    aiConfig.value = r?.config || aiConfig.value;
    aiMsg.value = `探测间隔已设为 ${aiConfig.value.probeIntervalHours} 小时`;
  } catch (e: any) {
    aiErr.value = e.message || '保存失败';
  } finally {
    aiBusy.value = false;
  }
}

/** 账单里已产生费用的百炼模型（实例 ID 第三段是模型名） */
const aiBilledModels = computed(() => {
  const set = new Set<string>();
  for (const b of aiSnapshot.value?.billRows || []) {
    if (/百炼|大模型|dashscope|bailian/i.test(b.product || '')) {
      const id = (b.instance || '').split(';')[2] || b.instance;
      if (id) set.add(String(id).trim());
    }
  }
  return set;
});

/**
 * 免费额度判定（本项目核心）：
 *   探测可用 + 无账单 → 仍在免费额度内
 *   探测可用 + 有账单 → 已开始计费（免费额度耗尽）
 *   429             → 已达限额，不等于不可用
 */
const aiFreeStatus = computed(() => {
  const billed = aiBilledModels.value;
  return (aiSnapshot.value?.probes || []).map((p: any) => {
    const mod = (aiSnapshot.value?.models || []).find((m: any) => m.id === p.modelId);
    const isBilled = billed.has(p.modelId);
    let verdict = '不可用';
    if (p.status === 'available') verdict = isBilled ? '已计费' : '免费额度内';
    else if (p.status === 'limited') verdict = '已达限额';
    else if (p.status === 'unknown') verdict = '未知';
    return {
      modelId: p.modelId,
      modality: mod?.modality || '—',
      price: mod?.price || '—',
      status: p.status,
      http: p.httpStatus ?? '',
      verdict,
      ts: p.ts,
    };
  });
});

const aiFreeInUse = computed(() => aiFreeStatus.value.filter((x: any) => x.verdict === '免费额度内').length);

/** 百炼 CLI 返回的免费额度（权威数据，含到期日与用完即停） */
const aiQuotas = computed<any[]>(() => aiSnapshot.value?.freeQuotas || []);

/** 30 天内到期的额度（易被忽略，单独高亮）。长期有效的（2099…）不算在内。 */
const aiExpiringSoon = computed<any[]>(() => {
  const cutoff = Date.now() + 30 * 86400000;
  return aiQuotas.value
    .filter((q) => q.expires && !isLongTerm(q) && new Date(q.expires).getTime() <= cutoff)
    .sort((a, b) => new Date(a.expires).getTime() - new Date(b.expires).getTime());
});

/** 长期有效的额度条数（用于页面说明，避免用户以为永远用不完而不去用） */
const aiLongTermCount = computed(() => aiQuotas.value.filter(isLongTerm).length);

/** 距离到期天数 */
function daysLeft(expires?: string | null): number | null {
  if (!expires) return null;
  return Math.ceil((new Date(expires).getTime() - Date.now()) / 86400000);
}

const aiQuotaType = ref('全部');
const aiQuotaTypes = computed(() => {
  const c: Record<string, number> = {};
  for (const q of aiQuotas.value) c[q.type || '其他'] = (c[q.type || '其他'] || 0) + 1;
  return c;
});
/** 英文类型 → 展示名（跟随语言） */
const TYPE_KEY: Record<string, string> = {
  Text: 'aiu.type.text',
  Vision: 'aiu.type.vision',
  Multimodal: 'aiu.type.multimodal',
  Audio: 'aiu.type.audio',
  Embedding: 'aiu.type.embedding',
  '-': 'aiu.other',
};
function typeCn(t?: string): string {
  const k = TYPE_KEY[t || ''];
  return k ? tr(k as any) : (t || '—');
}

/** 表头排序：点击切换升/降 */
const aiSort = ref<{ key: 'model' | 'remainingPercent' | 'expires'; dir: 1 | -1 }>({
  key: 'remainingPercent',
  dir: 1,
});
function aiToggleSort(key: 'model' | 'remainingPercent' | 'expires') {
  if (aiSort.value.key === key) aiSort.value.dir = aiSort.value.dir === 1 ? -1 : 1;
  else aiSort.value = { key, dir: 1 };
}
function aiSortArrow(key: string): string {
  if (aiSort.value.key !== key) return '↕';
  return aiSort.value.dir === 1 ? '↑' : '↓';
}

/**
 * 2099-01-01 这类哨兵日期 = 平台标记的「长期有效」，不是真的到期日。
 * 阈值与后端 LONG_TERM_YEAR 保持一致（2090）：覆盖 2099，且不误判真实到期日。
 */
const LONG_TERM_YEAR = 2090;
function isLongTerm(q: any): boolean {
  if (q?.expiresAt) return new Date(q.expiresAt).getUTCFullYear() >= LONG_TERM_YEAR;
  const y = Number(String(q?.expires || '').slice(0, 4));
  return Number.isFinite(y) && y >= LONG_TERM_YEAR;
}

const aiQuotasFiltered = computed(() => {
  let list = [...aiQuotas.value];
  if (aiQuotaType.value !== '全部') list = list.filter((q) => (q.type || '其他') === aiQuotaType.value);
  const { key, dir } = aiSort.value;
  list.sort((a, b) => {
    if (key === 'model') return a.model.localeCompare(b.model) * dir;
    if (key === 'expires') {
      // 长期有效（2099…）永远排在末尾：它不该和「快到期」的混在一起抢注意力
      const la = isLongTerm(a) ? 1 : 0;
      const lb = isLongTerm(b) ? 1 : 0;
      if (la !== lb) return la - lb; // 长期有效始终沉底，不随升/降翻转
      const ta = a.expires ? new Date(a.expires).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.expires ? new Date(b.expires).getTime() : Number.MAX_SAFE_INTEGER;
      return (ta - tb) * dir;
    }
    return ((a.remainingPercent ?? 100) - (b.remainingPercent ?? 100)) * dir;
  });
  return list;
});

const aiModalityCounts = computed(() => {
  const c: Record<string, number> = {};
  for (const m of aiSnapshot.value?.models || []) c[m.modality] = (c[m.modality] || 0) + 1;
  return c;
});

const aiFilteredModels = computed(() => {
  const ms: any[] = aiSnapshot.value?.models || [];
  return aiModality.value === '全部' ? ms : ms.filter((m: any) => m.modality === aiModality.value);
});

const PROBE_KEY: Record<string, string> = {
  available: 'aiu.probe.available',
  limited: 'aiu.probe.limited',
  unknown: 'aiu.probe.unknown',
  unavailable: 'aiu.probe.unavailable',
};
function probeText(k: string): string {
  const key = PROBE_KEY[k];
  return key ? tr(key as any) : k;
}
/** 探测结论（后端给中文值，显示时翻译） */
function verdictText(v: string): string {
  if (v === '免费额度内') return tr('aiu.verdict.free');
  if (v === '已计费') return tr('aiu.verdict.billed');
  return v;
}

async function boot() {
  // 语言优先：/api/locked 之前同步，锁屏页才不会先出中文再变英文
  await syncLangFromServer();
  try {
    const res = await fetch('/api/locked');
    const r = await res.json();
    // vault 未初始化时也可能 423 + needUnlock / locked
    if (r.locked || r.needUnlock || res.status === 423) {
      locked.value = true;
      // 先问一次双因子状态：本库要求 SK 时直接摆出第二个输入框，
      // 避免用户先白输一次口令、再被「还需要 Secret Key」打断
      try {
        const sj = await (await fetch('/api/sk')).json();
        if (sj?.enabled) {
          needSk.value = true;
          skHint.value = sj.hint || skHint.value;
        }
      } catch {
        /* 老版本后端没有 /api/sk：按单因子处理 */
      }
      return;
    }
  } catch {
    /* 服务端未就绪：仍显示解锁遮罩，避免误进空数据页 */
    locked.value = true;
    return;
  }
  await loadFieldSchema();
  await loadAll();
  (window as any).__MG_DBG__ = { assetsLen: Array.isArray(assets.value) ? assets.value.length : '非数组:' + typeof assets.value, locked: locked.value };
  await loadColumnConfig();
  await loadAssetTypes();
}

/** 进入锁定态：切回解锁页，并清掉上次输入的口令（不能留在输入框里） */
function handleLocked() {
  locked.value = true;
  passphrase.value = '';
  secretKey.value = '';
  unlockError.value = '';
}

/** 任何页面一键锁定（悬浮按钮） */
async function lockNow() {
  try {
    await fetch('/api/lock', { method: 'POST' });
  } catch {
    /* 后端不可达就当已锁 */
  }
  handleLocked();
}

async function doUnlock() {
  unlockError.value = '';
  unlocking.value = true;
  try {
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passphrase: passphrase.value,
        secretKey: secretKey.value || undefined,
        rememberSecretKey: needSk.value ? rememberSk.value : undefined,
      }),
    });
    const j = await res.json().catch(() => ({} as any));
    // 后端用 needSecretKey 标记「缺的是 SK，不是口令错」：据此切换出第二个输入框，
    // 而不是让用户反复改口令（双因子库最常见的困惑就在这里）
    if (j && j.needSecretKey) {
      needSk.value = true;
      if (j.secretKeyHint) skHint.value = j.secretKeyHint;
    }
    if (res.status === 401) {
      unlockError.value = j.error || (j?.needSecretKey ? tr('shell.lock.errSk') : tr('shell.lock.wrong'));
      return;
    }
    if (res.status === 429) {
      unlockError.value = j.error || tr('shell.lock.tooMany');
      return;
    }
    if (!res.ok) { unlockError.value = tr('shell.lock.fail', { status: res.status }); return; }
    locked.value = false;
    passphrase.value = '';
    secretKey.value = '';
    needSk.value = false;
    await loadAll();
    } catch (e: any) {
    unlockError.value = tr('shell.lock.reqFail', { msg: e.message });
  } finally {
    unlocking.value = false;
  }
}

// 用户活动心跳：纯浏览/编辑表单不会触发其它 API，靠节流心跳重置自动锁定计时
let lastBeat = 0;
function activityBeat() {
  const now = Date.now();
  if (now - lastBeat < 60_000) return;
  lastBeat = now;
  fetch('/api/activity', { method: 'POST' }).catch(() => {});
}

onMounted(() => {
  boot();
  window.addEventListener('click', activityBeat);
  window.addEventListener('keydown', activityBeat);
  // 自动锁定 / 托盘手动锁定后，界面切回解锁页（轮询不重置自动锁定计时）
  setInterval(async () => {
    if (locked.value) return;
    try {
      const res = await fetch('/api/locked');
      const r = await res.json();
      if (r.locked) handleLocked();
    } catch {
      /* 服务端暂时不可达时忽略 */
    }
  }, 30_000);
});
</script>

<template>
  <!-- 解锁遮罩：服务端默认锁定，先输口令 -->
  <div v-if="locked" class="unlock">
    <div class="unlock-box">
      <div class="unlock-brand">🔐</div>
      <h2>{{ tr('shell.brand') }}</h2>
      <p class="unlock-sub">{{ tr('shell.lock.sub') }}</p>
      <div class="unlock-field">
        <input
          v-model="passphrase"
          :type="showPass ? 'text' : 'password'"
          :placeholder="tr('shell.lock.placeholder')"
          @keyup.enter="doUnlock"
          :disabled="unlocking"
          autofocus
        />
        <button type="button" class="unlock-eye" @click="showPass = !showPass" tabindex="-1">{{ showPass ? tr('shell.lock.hide') : tr('shell.lock.show') }}</button>
      </div>
      <div v-if="needSk" class="unlock-sk">
        <div class="unlock-field">
          <input
            v-model="secretKey"
            type="text"
            :placeholder="skHint ? tr('shell.lock.skPlaceholderHint', { hint: skHint }) : tr('shell.lock.skPlaceholder')"
            @keyup.enter="doUnlock"
            :disabled="unlocking"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <label class="unlock-remember">
          <input v-model="rememberSk" type="checkbox" />
          <span>{{ tr('shell.lock.skRemember') }}</span>
        </label>
        <p class="unlock-sub">{{ tr('shell.lock.skHint') }}</p>
      </div>
      <button class="unlock-btn" :disabled="unlocking" @click="doUnlock">
        {{ unlocking ? tr('shell.lock.busy') : tr('shell.lock.submit') }}
      </button>
      <p v-if="unlockError" class="err">{{ unlockError }}</p>
      <p class="unlock-foot">{{ tr('shell.lock.foot') }}</p>
    </div>
  </div>

  <div v-else class="app">
    <!-- 后端断开提示：开发时重启服务后，页面只会「数据变空」，容易被当成数据丢了 -->
    <div v-if="apiOffline" class="offline-bar">
      <span>{{ tr('shell.offlineBar') }}</span>
      <button @click="reconnect">{{ tr('shell.offline.reconnect') }}</button>
    </div>
    <!-- 新版外壳：黑曜模板侧栏（模板驱动，颜色字号全部来自 token） -->
    <div v-if="uiMode === 'new'" data-mgui :data-template="uiTemplate" :data-theme="uiTheme" class="mgui-sidebar">
      <div class="shell" :class="{ 'side-open': sideOpen }">
      <aside class="side">
        <div class="side-brand" :title="tr('shell.brand.title')"><span class="logo">{{ lang === 'en-US' ? 'V' : '库' }}</span><span class="name">{{ tr('shell.brand') }}</span><button
          class="side-fold"
          :title="sideOpen ? tr('shell.nav.collapse') : tr('shell.nav.expand')"
          :aria-label="sideOpen ? tr('shell.nav.collapse') : tr('shell.nav.expand')"
          @click="sideOpen = !sideOpen"
        ><i class="ic" v-html="sideIcon(sideOpen ? 'chevL' : 'chevR')"></i></button></div>

        <div class="side-group">{{ tr('shell.group.workbench') }}</div>
        <button class="side-item" :class="{ on: tab === 'myprojects' }" @click="tab = 'myprojects'">
          <i class="ic" v-html="sideIcon('runner')"></i><i class="pg">01</i><span class="nm">{{ tr('shell.nav.runner') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: tab === 'aiassistant' }" @click="tab = 'aiassistant'; openAiPage()">
          <i class="ic" v-html="sideIcon('assistant')"></i><i class="pg">02</i><span class="nm">{{ tr('shell.nav.assistant') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: isNavOn('studio') }" @click="navOpc('studio')">
          <i class="ic" v-html="sideIcon('studio')"></i><i class="pg">03</i><span class="nm">{{ tr('shell.nav.studio') }}</span><span class="leader"></span>
        </button>
        <button
          v-for="(p, i) in OPC_PAGES.filter(p => p.k !== 'docs' && p.k !== 'studio' && p.k !== 'ai' && p.k !== 'settings')"
          :key="p.k"
          class="side-item"
          :class="{ on: isNavOn(p.k) }"
          @click="navOpc(p.k)"
        >
          <i class="ic" v-html="sideIcon(p.icon)"></i><i class="pg">{{ String(i + 4).padStart(2, '0') }}</i><span class="nm">{{ tr(p.labelKey) }}</span><span class="leader"></span>
        </button>

        <div class="side-group">{{ tr('shell.group.assets') }}</div>
        <button class="side-item" :class="{ on: tab === 'assets' }" @click="tab = 'assets'">
          <i class="ic" v-html="sideIcon('assets')"></i><i class="pg">11</i><span class="nm">{{ tr('shell.nav.assets') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: tab === 'memo' }" @click="tab = 'memo'; loadMemos()">
          <i class="ic" v-html="sideIcon('memo')"></i><i class="pg">12</i><span class="nm">{{ tr('shell.nav.memo') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: tab === 'docs' }" @click="tab = 'docs'">
          <i class="ic" v-html="sideIcon('docs')"></i><i class="pg">13</i><span class="nm">{{ tr('shell.nav.docs') }}</span><span class="leader"></span>
        </button>

        <div class="side-group">{{ tr('shell.group.auto') }}</div>
        <button class="side-item" :class="{ on: tab === 'whitelist' }" @click="tab = 'whitelist'; loadWhitelist()">
          <i class="ic" v-html="sideIcon('whitelist')"></i><i class="pg">21</i><span class="nm">{{ tr('shell.nav.whitelist') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: tab === 'aiusage' }" @click="tab = 'aiusage'; loadAiUsage()">
          <i class="ic" v-html="sideIcon('aiusage')"></i><i class="pg">22</i><span class="nm">{{ tr('shell.nav.aiusage') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: tab === 'mcp' }" @click="tab = 'mcp'">
          <i class="ic" v-html="sideIcon('mcp')"></i><i class="pg">23</i><span class="nm">{{ tr('shell.nav.mcp') }}</span><span class="leader"></span>
        </button>

        <div class="side-group">{{ tr('shell.group.system') }}</div>
        <button class="side-item" :class="{ on: tab === 'audit' }" @click="tab = 'audit'; loadAudit(1)">
          <i class="ic" v-html="sideIcon('audit')"></i><i class="pg">31</i><span class="nm">{{ tr('shell.nav.audit') }}</span><span class="leader"></span>
        </button>
        <button class="side-item" :class="{ on: tab === 'settings' }" @click="tab = 'settings'">
          <i class="ic" v-html="sideIcon('settings')"></i><i class="pg">32</i><span class="nm">{{ tr('shell.nav.settings') }}</span><span class="leader"></span>
        </button>

        <div class="side-foot">
          <button
            class="side-item side-tgl"
            :title="uiTheme === 'dark' ? tr('shell.theme.toLight') : tr('shell.theme.toDark')"
            :aria-label="uiTheme === 'dark' ? tr('shell.theme.toLight') : tr('shell.theme.toDark')"
            @click="uiTheme = uiTheme === 'dark' ? 'light' : 'dark'"
          >
            <i class="ic" v-html="uiTheme === 'dark' ? sideIcon('sun') : sideIcon('moon')"></i><i class="pg"></i>
            <span class="nm">{{ uiTheme === 'dark' ? tr('shell.theme.light') : tr('shell.theme.dark') }}</span><span class="leader"></span>
          </button>
        </div>
      </aside>
      </div>
    </div>

    <!-- 左侧整体导航：模块入口（新增动作在各页面内） -->
    <aside v-else class="side">
      <div class="side-brand">🔐 {{ tr('shell.brand') }}</div>
      <nav class="side-nav">
        <p class="side-group">{{ tr('shell.group.workbench') }}</p>
        <button :class="{ on: isNavOn('studio') }" @click="navOpc('studio')">⌂ {{ tr('shell.nav.studio') }}</button>
        <button :class="{ on: tab === 'myprojects' }" @click="tab = 'myprojects'">🚀 {{ tr('shell.nav.runner') }}</button>
        <button :class="{ on: tab === 'aiassistant' }" @click="tab = 'aiassistant'; openAiPage()">✦ {{ tr('shell.nav.assistant') }}</button>
        <button
          v-for="p in OPC_PAGES.filter(p => p.k !== 'docs' && p.k !== 'studio' && p.k !== 'ai')"
          :key="p.k"
          :class="{ on: isNavOn(p.k) }"
          @click="navOpc(p.k)"
        >{{ tr(p.labelKey) }}</button>
        <button :class="{ on: tab === 'settings' }" @click="tab = 'settings'">🧰 {{ tr('shell.nav.settings') }}</button>
        <p class="side-group">{{ tr('shell.group.assets') }}</p>
        <button :class="{ on: tab === 'assets' }" @click="tab = 'assets'">📋 {{ tr('shell.nav.assets') }}</button>
        <button :class="{ on: tab === 'memo' }" @click="tab = 'memo'; loadMemos()">📝 {{ tr('shell.nav.memo') }}</button>
        <button :class="{ on: tab === 'docs' }" @click="tab = 'docs'">🗂 {{ tr('shell.nav.docs') }}</button>
        <p class="side-group">{{ tr('shell.group.auto') }}</p>
        <button :class="{ on: tab === 'whitelist' }" @click="tab = 'whitelist'; loadWhitelist()">🛡 {{ tr('shell.nav.whitelist') }}</button>
        <button :class="{ on: tab === 'aiusage' }" @click="tab = 'aiusage'; loadAiUsage()">📊 {{ tr('shell.nav.aiusage') }}</button>
        <button :class="{ on: tab === 'mcp' }" @click="tab = 'mcp'">🔌 {{ tr('shell.nav.mcp') }}</button>
        <p class="side-group">{{ tr('shell.group.system') }}</p>
        <button :class="{ on: tab === 'audit' }" @click="tab = 'audit'; loadAudit(1)">🧾 {{ tr('shell.nav.audit') }}</button>
        <button :class="{ on: tab === 'settings' }" @click="tab = 'settings'">⚙ {{ tr('shell.nav.settings') }}</button>
      </nav>
      <div class="side-foot">
        <button
          class="theme-toggle"
          :title="theme === 'dark' ? tr('shell.theme.toLight') : tr('shell.theme.toDark')"
          :aria-label="theme === 'dark' ? tr('shell.theme.toLight') : tr('shell.theme.toDark')"
          @click="toggleTheme"
        >{{ theme === 'dark' ? '☀ ' + tr('shell.theme.light') : '☾ ' + tr('shell.theme.dark') }}</button>
      </div>
    </aside>
    <main
      class="main"
      :class="{
        'main-plain':
          [
            'assets',
            'whitelist',
            'memo',
            'audit',
            'aiusage',
            'mcp',
            'settings',
            'myprojects',
            'aiassistant',
            'studio',
            'ideas',
            'tasks',
            'finance',
            'projects',
            'docs',
          ].includes(tab) && uiMode === 'new',
      }"
    >
    <!-- 资产清单 -->
    <!-- 资产管家（自写 AI 助手页） -->
    <section
      v-if="tab === 'aiassistant'"
      class="ai-page"
      :class="{ 'mg-token': uiMode === 'new' }"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
    >
      <div class="ai-backdrop" v-if="aiSessOpen" @click="aiSessOpen = false"></div>
      <!-- 顶部工具条：固定占位，消息只在其下方滚动；后续工具按钮统一放 .ai-topbar-tools -->
      <header class="ai-topbar">
        <button class="ai-sess-fab" v-if="!aiSessOpen" @click="aiSessOpen = true" :title="tr('ai.sessList')">☰</button>
        <span class="ai-topbar-title">{{ aiCurrentTitle }}</span>
        <div class="ai-topbar-tools">
          <button class="ai-topbar-btn" @click="aiNewSession" :title="tr('ai.newSession')">{{ tr('ai.newSession') }}</button>
        </div>
      </header>
      <div class="ai-sess-drawer" :class="{ open: aiSessOpen }">
        <div class="ai-sess-hd">
          <span class="t">{{ tr('ai.sessions') }}</span>
          <button class="ai-hd-btn" @click="aiNewSession" :title="tr('ai.newSession')">＋</button>
          <button class="ai-hd-btn" @click="aiSessOpen = false" :title="tr('ai.collapse')">✕</button>
        </div>
        <button v-for="s in aiSessions" :key="s.id" class="ai-sess-item" :class="{ on: s.id === aiSessionId }" @click="aiOpenSession(s.id)">
          <span class="ai-sess-t">{{ s.title }}</span>
          <span class="ai-sess-x" @click.stop="aiDelSession(s.id)">×</span>
        </button>
        <div v-if="!aiSessions.length" class="ai-sess-empty">{{ tr('ai.noSessions') }}</div>
      </div>

      <!-- 新会话落地页 -->
      <div v-if="aiView === 'landing'" class="ai-landing">
        <h1 class="ai-greet">{{ tr('ai.greet') }}</h1>
        <p class="ai-greet-sub">{{ tr('ai.greetSub') }}</p>
        <div class="ai-skill-tabs">
          <button v-for="g in AI_SKILL_TABS" :key="g.key" :class="{ on: aiSkillTab === g.key }" @click="aiSkillTab = g.key">{{ tr(g.labelKey as any) }}</button>
        </div>
        <div class="ai-chips">
          <button v-for="p in aiSkills(aiSkillTab)" :key="p" @click="aiFill(p)">{{ p }}</button>
        </div>
        <div class="ai-big-composer">
          <textarea id="aiInbox" v-model="aiInput" rows="3" :placeholder="tr('ai.placeholder')" @keydown.enter.exact.prevent="aiSend" @input="aiGrow"></textarea>
          <div class="ai-bc-foot">
            <span class="ai-plus">＋</span>
            <span style="flex:1"></span>
            <button class="ai-model-pill" @click="aiModelOpen = !aiModelOpen">{{ aiConf.model || tr('ai.noModel') }} ▾</button>
            <button class="ai-send-circle" @click="aiSend">↑</button>
            <div class="ai-model-backdrop" v-if="aiModelOpen" @click="aiModelOpen = false"></div>
            <div v-if="aiModelOpen" class="ai-model-pop">
            <button v-for="p in AI_MODEL_PRESETS" :key="p.base" class="ai-model-item" @click="aiPickModel(p)">
              <span>{{ p.name }}</span><span class="ai-model-m">{{ p.model }}</span>
            </button>
            <button class="ai-model-item" @click="aiModelOpen = false; tab = 'settings'"><span>{{ tr('ai.customKey') }}</span><span class="ai-model-m">{{ tr('ai.goSettings') }}</span></button>
          </div>
          </div>
        </div>
        <div class="ai-hint">{{ tr('ai.hint') }}</div>
      </div>

      <!-- 对话中 -->
      <div v-else class="ai-chat">
        <div class="ai-thread" id="aiThread">
          <template v-for="(m, i) in aiMsgs" :key="m.id || i">
            <div v-if="m.role === 'user'" class="ai-msg user"><div class="ai-bubble-u">{{ m.text }}</div></div>
            <div v-else-if="m.kind === 'tool'" class="ai-msg ai">
              <div class="ai-tool-card" :class="{ warn: m.needsConfirm, ok: !m.needsConfirm }">
                <div class="ai-tc-head">{{ m.needsConfirm ? '⚠ ' : '✓ ' }}{{ m.tool }}</div>
                <div class="ai-tc-body" v-if="m.summary || m.needsConfirm">{{ m.summary }}<span v-if="m.needsConfirm"><br>{{ tr('ai.restoreHint') }}</span></div>
                <div v-if="m.needsConfirm" class="ai-tc-ops">
                  <button class="ai-danger" @click="aiConfirm(m.cid, true)">{{ tr('ai.confirmDelete') }}</button>
                  <button class="ai-mini" @click="aiConfirm(m.cid, false)">{{ tr('common.btn.cancel') }}</button>
                </div>
              </div>
            </div>
            <div v-else class="ai-msg ai">
              <div class="ai-plain">{{ m.text }}</div>
              <button v-if="m.failed" class="ai-retry" @click="aiRetry(m)">↻ {{ tr('ai.retry') }}</button>
            </div>
          </template>
          <div v-if="aiThinking" class="ai-msg ai"><div class="ai-plain ai-typing">{{ tr('ai.thinking') }}</div></div>
        </div>
        <div class="ai-composer">
          <textarea id="aiInbox" v-model="aiInput" rows="1" :placeholder="tr('ai.continuePh')" @keydown.enter.exact.prevent="aiSend" @input="aiGrow"></textarea>
          <button class="ai-model-pill ai-composer-model" @click="aiModelOpen = !aiModelOpen" :title="aiConf.name || aiConf.model || tr('ai.configModel')">{{ aiConf.model || tr('ai.noModel') }} ▾</button>
          <button class="ai-send" :class="{ stopping: stewardBusy }" @click="stewardBusy ? aiStop() : aiSend()">{{ stewardBusy ? tr('ai.stop') : tr('ai.send') }}</button>
          <div class="ai-model-backdrop" v-if="aiModelOpen" @click="aiModelOpen = false"></div>
          <div v-if="aiModelOpen" class="ai-model-pop">
            <button v-for="p in AI_MODEL_PRESETS" :key="p.base" class="ai-model-item" @click="aiPickModel(p)">
              <span>{{ p.name }}</span><span class="ai-model-m">{{ p.model }}</span>
            </button>
            <button class="ai-model-item" @click="aiModelOpen = false; tab = 'settings'"><span>{{ tr('ai.customKey') }}</span><span class="ai-model-m">{{ tr('ai.goSettings') }}</span></button>
          </div>
        </div>
        <div class="ai-hint" style="padding:0 22px 12px">{{ tr('ai.hint2') }}</div>
      </div>
    </section>

    <section v-else-if="tab === 'assets' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <AssetsView
          :rows="filteredAssets"
          :columns="activeColumns as any"
          :counts="counts"
          :groups="typeGroups"
          :filter="filter"
          :total="listAssets.length"
          :due-count="dueCount"
          :type-meta="typeMetaMap"
          :is-due="isDue"
          :field-label="fieldLabel"
          :secret-keys-of="secretKeysOf"
          :query="searchQuery"
          :open-type-editor="() => openTypeEditor()"
          :quick-save="quickSave"
          :edit-version="editVersion"
          @filter="filter = $event"
          @query="onViewSearch"
          @import="openImport"
          @new="openNew"
          @edit="openEdit"
          @advanced="openEdit"
          @remove="remove"
          @colcfg="openColEditor"
          @addtype="openTypeEditor"
        />
      </div>
    </section>
    <section v-else-if="tab === 'assets'">
      <div class="page-head">
        <h2>资产清单</h2>
        <p>全部凭证与资产的加密清单；跟 Agent 对话可直接说「服务器 N 号」。</p>
      </div>
      <div class="toolbar">
        <div class="chips">
          <button :class="{ on: filter === '' }" @click="filter = ''">全部 ({{ listAssets.length }})</button>
          <template v-for="g in typeGroups" :key="g.category">
            <span class="chip-cat">{{ g.category }}</span>
            <button
              v-for="t in g.types"
              :key="t.key"
              class="chip-type"
              :class="['t-' + t.key, { on: filter === t.key, 'chip-custom': t.key.startsWith('ct_') }]"
              :style="chipStyle(t.key)"
              @click="filter = t.key"
            >
              {{ t.label }} ({{ counts[t.key] || 0 }})
            </button>
          </template>
          <button :class="{ on: filter === 'due' }" @click="filter = 'due'">⚠ 待轮换 ({{ dueCount }})</button>
          <button class="chip-add" title="新增资产类型" @click="openTypeEditor()">＋</button>
        </div>
        <div class="toolbar-right">
          <button class="primary" @click="openNew">＋ 新增资产</button>
          <div class="search-box">
            <input
              v-model="searchQuery"
              class="search-input"
              placeholder="搜索名称 / IP / 备注…"
              @input="onSearchInput"
              @keyup.enter="runSearch"
            />
            <button v-if="searchQuery" class="search-clear" title="清除搜索" @click="clearSearch">×</button>
          </div>
          <button
            v-if="filter && filter !== 'due'"
            class="col-cfg-btn"
            title="配置该分类要显示的列"
            @click="openColEditor"
          >⚙ 列配置</button>
        </div>
      </div>
      <p v-if="searchResults" class="search-hint">
        「{{ searchQuery }}」匹配 <strong>{{ searchResults.length }}</strong> 条
        <button class="link-btn" @click="clearSearch">清除搜索</button>
      </p>

      <div v-if="filteredAssets.length" class="tbl-scroll">
      <table class="tbl-assets assets-tbl">
        <colgroup>
          <col v-for="(w, i) in colWidths" :key="i" :style="{ width: w + 'px' }" />
        </colgroup>
        <thead>
          <tr>
            <th class="no-cell" title="稳定序号：每类独立编号，创建后不变。跟 Agent 对话可直接说「服务器 3 号」">#</th>
            <th>名称</th>
            <th>类型</th>
            <th v-for="c in activeColumns" :key="c.key">{{ c.label }}</th>
            <th>标签</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in filteredAssets" :key="a.id">
            <td class="no-cell mono" :title="typeLabel(a.type) + ' ' + (a.no ?? '—') + ' 号'">{{ a.no ?? '—' }}</td>
            <td>{{ a.name }} <span v-if="isDue(a)" class="due">⚠ 待换密</span></td>
            <td class="type-cell">
              <div class="type-cell-in">
                <span class="tag type-tag" :class="'t-' + a.type" :style="typeStyle(a.type)">{{ typeLabel(a.type) }}</span>
                <span
                  v-for="b in listBesideBadges(a)"
                  :key="b.key"
                  class="tag sm badge-field"
                  :title="b.label"
                >{{ b.label }}</span>
              </div>
            </td>
            <td
              v-for="c in activeColumns"
              :key="c.key"
              class="meta"
              :class="{ mono: (c as any).mono }"
              :title="String(c.get(a) ?? '') || undefined"
            >{{ c.get(a) || '—' }}</td>
            <td class="tags-cell"><span v-for="t in (a.tags||[])" :key="t" class="tag sm">{{ t }}</span></td>
            <td class="ops">
              <button @click="openDetail(a)">查看</button>
              <button @click="openEdit(a)">编辑</button>
              <button class="del" @click="remove(a)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <div v-else class="empty">
        <p>暂无资产</p>
        <button class="primary add-btn" @click="openNew">+ 新增资产</button>
      </div>

      <!-- 列配置：每个分类独立 -->
    </section>

    <!-- 机房（自有场景页，替换 OPC studio） -->
    <section v-else-if="tab === 'studio' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <StudioView
          @new-asset="(t: string) => { filter = t; openNew(); }"
          @edit-asset="openEdit"
        />
      </div>
    </section>

    <!-- 资料证书（自有页面） -->
    <section v-else-if="tab === 'docs' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <DocsView />
      </div>
    </section>

    <!-- 迭代任务 / 收支 / 项目（自有页面，替换 OPC 同名页） -->
    <section v-else-if="tab === 'tasks' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <TasksView />
      </div>
    </section>
    <section v-else-if="tab === 'finance' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <FinanceView />
      </div>
    </section>
    <section v-else-if="tab === 'projects' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <ProjectsView
          :projects="projectList"
          @new="filter = 'project'; openNew()"
          @edit="openEdit"
          @remove="remove"
        />
      </div>
    </section>

    <!-- 灵感池（新版 / 黑曜模板） -->
    <section v-else-if="tab === 'ideas' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <IdeasView />
      </div>
    </section>

    <!-- 白名单（新版 / 黑曜模板） -->
    <section v-else-if="tab === 'whitelist' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <WhitelistView
          :ips="wlIps"
          :detecting="wlDetecting"
          :bindings="wlBindings"
          :logs="wlLogs"
          :sched="wlSched"
          :next-text="wlNextText"
          :msg="wlMsg"
          :busy="wlBusy"
          :provider-label="wlProviderLabel"
          :account-label="cloudAccountLabel"
          :target-text="wlTarget"
          :result-text="wlResultTag"
          @detect="detectIp"
          @run="(id?: string) => runWhitelist(id, true)"
          @new="openWlNew"
          @edit="openWlEdit"
          @toggle="toggleWl"
          @remove="removeWl"
          @sched-change="(v: any) => { wlSched.enabled = v.enabled; wlSched.intervalMinutes = v.intervalMinutes; saveWlSched(); }"
        />
      </div>
    </section>

    <!-- 白名单：探测公网 IP → 更新云安全组 -->
    <section v-else-if="tab === 'whitelist'">
      <div class="page-head">
        <h2>IP 白名单</h2>
        <p>公网 IP 变了，云上放行规则自动跟着改；IP 没变就不调云 API。</p>
      </div>
      <div class="toolbar">
        <div class="wl-ip-bar">
          <span class="wl-cap">当前公网 IP</span>
          <span v-for="ip in wlIps" :key="ip" class="tag sm">{{ ip }}</span>
          <span v-if="!wlIps.length" class="wl-none">未探测</span>
          <button :disabled="wlDetecting" @click="detectIp">{{ wlDetecting ? '探测中…' : '重新探测' }}</button>
        </div>
        <div class="toolbar-right">
          <button class="primary" @click="openWlNew">＋ 新增绑定</button>
          <button :disabled="wlBusy" @click="runWhitelist(undefined, true)">
            {{ wlBusy ? '执行中…' : '▶ 立即执行（全部）' }}
          </button>
        </div>
      </div>
      <p v-if="wlMsg" class="backup-msg">{{ wlMsg }}</p>

      <!-- 定时调度 -->
      <div class="wl-sched">
        <span class="wl-cap">定时任务</span>
        <label class="wl-check">
          <input type="checkbox" v-model="wlSched.enabled" @change="saveWlSched" /> 启用
        </label>
        <span class="wl-none">每</span>
        <select v-model.number="wlSched.intervalMinutes" @change="saveWlSched">
          <option :value="5">5 分钟</option>
          <option :value="15">15 分钟</option>
          <option :value="30">30 分钟</option>
          <option :value="60">1 小时</option>
          <option :value="120">2 小时</option>
        </select>
        <span class="wl-none">下次运行：{{ wlNextText }}</span>
        <span v-if="wlSched.lastSummary" class="wl-none">上次：{{ wlSched.lastSummary }}</span>
      </div>
      <p class="wl-tip">
        定时仅在本工具运行时生效；需要关机也执行，请用系统任务计划挂载
        <code>npm run whitelist:run</code>（需先设置 <code>VAULT_PASSPHRASE</code>）。
      </p>

      <table v-if="wlBindings.length" class="tbl-assets">
        <colgroup>
          <col style="width: 15%" />
          <col style="width: 9%" />
          <col style="width: 16%" />
          <col style="width: 12%" />
          <col style="width: 16%" />
          <col style="width: 11%" />
          <col style="width: 11%" />
          <col style="width: 10%" />
        </colgroup>
        <thead>
          <tr>
            <th>名称</th><th>厂商</th><th>云账号</th><th>地域</th>
            <th>目标(模板/前缀列表)</th><th>上次IP</th><th>上次结果</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in wlBindings" :key="b.id">
            <td>{{ b.name || '—' }} <span v-if="!b.enabled" class="wl-off">已停用</span></td>
            <td><span class="tag">{{ b.provider === 'aliyun' ? '阿里云' : '腾讯云' }}</span></td>
            <td class="meta">{{ cloudAccountLabel(b.assetId) }}</td>
            <td class="meta">{{ b.region }}</td>
            <td class="mono small">{{ wlTarget(b) || '—' }}</td>
            <td class="meta">{{ b.lastIp || '—' }}</td>
            <td :class="{ wlok: b.lastResult === 'ok', wlfail: b.lastResult === 'fail' }">
              {{ wlResultTag(b) }}
              <span v-if="b.lastMessage" class="wl-msg" :title="b.lastMessage">{{ b.lastMessage }}</span>
            </td>
            <td class="ops">
              <button @click="runWhitelist(b.id, true)">执行</button>
              <button @click="openWlEdit(b)">编辑</button>
              <button @click="toggleWl(b)">{{ b.enabled ? '停用' : '启用' }}</button>
              <button class="del" @click="removeWl(b)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">还没有白名单绑定，点右上角「+ 新增绑定」开始。</p>

      <h4 class="wl-h4">执行记录（最近 {{ wlLogs.length }} 条）</h4>
      <table v-if="wlLogs.length" class="tbl-assets">
        <colgroup>
          <col style="width: 20%" /><col style="width: 10%" /><col style="width: 16%" />
          <col style="width: 14%" /><col style="width: 10%" /><col style="width: 30%" />
        </colgroup>
        <thead>
          <tr><th>时间</th><th>厂商</th><th>目标</th><th>IP</th><th>结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="(e, i) in wlLogs.slice(-20).reverse()" :key="i">
            <td class="mono small">{{ e.ts }}</td>
            <td>{{ e.provider === 'aliyun' ? '阿里云' : '腾讯云' }}</td>
            <td class="mono small">{{ e.target || '—' }}</td>
            <td class="meta">{{ (e.ips || []).join(', ') || '—' }}</td>
            <td>{{ e.skipped ? '跳过' : e.ok ? '成功' : '失败' }}</td>
            <td class="meta">{{ e.message || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">还没有执行记录。</p>

      <!-- 新增 / 编辑绑定 -->
    </section>

    <!-- 备忘录 -->
    <section v-else-if="tab === 'memo' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <MemoView
          :memos="memos"
          :copied-id="copiedKey"
          @new="openMemoNew"
          @edit="openMemoEdit"
          @remove="removeMemo"
          @copy="(m: any) => copyValue(m.id, m.content)"
        />
      </div>
    </section>

    <section v-else-if="tab === 'memo'">
      <div class="page-head">
        <h2>备忘录</h2>
        <p>共 {{ memos.length }} 条 · 内容随燧垒一起加密存储。</p>
      </div>
      <div class="toolbar">
        <div class="toolbar-right">
          <button class="primary" @click="openMemoNew">＋ 新增备忘</button>
        </div>
      </div>

      <div v-if="memos.length" class="memo-list">
        <div v-for="m in memos" :key="m.id" class="memo-card">
          <div class="memo-head">
            <strong>{{ m.name || '（无标题）' }}</strong>
            <span class="wl-none">{{ (m.updatedAt || '').slice(0, 19).replace('T', ' ') }}</span>
            <div class="memo-ops">
              <button @click="copyValue(m.id, m.content)">{{ copiedKey === m.id ? '已复制' : '复制' }}</button>
              <button @click="openMemoEdit(m)">编辑</button>
              <button class="del" @click="removeMemo(m)">删除</button>
            </div>
          </div>
          <pre class="memo-body">{{ m.content || '—' }}</pre>
        </div>
      </div>
      <p v-else class="empty">{{ tr('aiu.memos.empty') }}</p>

      <!-- 新增 / 编辑备忘 -->
    </section>

    <!-- 模型用量 -->
    <section
      v-else-if="tab === 'aiusage'"
      class="mg-legacy"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
    >
      <div v-if="uiMode === 'new'" class="statusbar statusbar-bleed">
        <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
        <span>{{ tr('assets.crypto') }}</span>
        <span class="sp"></span>
        <span>{{ tr('aiu.accountsSummary', { n: aiAccounts.length }) }} · {{ aiSubLabel }}</span>
      </div>

      <div v-if="uiMode === 'new'" class="page-head">
        <div>
          <div class="kicker">{{ tr('aiu.kicker') }}</div>
          <div class="page-title">{{ tr('aiu.title') }} <span class="cnt">{{ tr('aiu.accountsCnt', { n: aiAccounts.length }) }}</span></div>
        </div>
      </div>
      <div v-else class="page-head">
        <h2>{{ tr('aiu.title') }}</h2>
        <p>{{ tr('aiu.lead') }}</p>
      </div>
      <div class="toolbar">
        <div class="wl-ip-bar">
          <span class="wl-cap">{{ tr('aiu.title') }}</span>
          <label class="ai-pick">{{ tr('aiu.account') }}
            <select v-model="aiAccountId" @change="loadAiSnapshot">
              <option :value="AI_ALL">{{ tr('aiu.allAccounts') }}</option>
              <option v-for="a in aiAccounts" :key="a.id" :value="a.id">{{ a.name }} · {{ a.provider || a.type }}</option>
            </select>
          </label>
        </div>
        <div class="toolbar-right">
          <button :disabled="aiBusy || !aiAccountId" @click="aiRefresh(false)">{{ tr('aiu.refresh') }}</button>
          <button
            :disabled="aiBusy"
            :title="tr('aiu.catalogHint')"
            @click="aiRefreshCatalog"
          >{{ tr('aiu.refreshCatalog') }}</button>
          <button :disabled="aiBusy || !aiAccountId || aiViewAll" :title="aiViewAll ? tr('aiu.probeGuard') : ''" @click="aiRefresh(true)">{{ aiBusy ? tr('aiu.probing') : tr('aiu.probeNow') }}</button>
        </div>
      </div>

      <div class="ai-cfg">
        <span class="ai-cfg-l">{{ tr('aiu.probeInterval') }}</span>
        <select v-model.number="aiConfig.probeIntervalHours">
          <option :value="1">{{ tr('aiu.hours', { n: 1 }) }}</option>
          <option :value="2">{{ tr('aiu.hours', { n: 2 }) }}</option>
          <option :value="3">{{ tr('aiu.hours', { n: 3 }) }}</option>
          <option :value="6">{{ tr('aiu.hours', { n: 6 }) }}</option>
          <option :value="12">{{ tr('aiu.hours', { n: 12 }) }}</option>
          <option :value="24">{{ tr('aiu.hours', { n: 24 }) }}</option>
        </select>
        <button :disabled="aiBusy" @click="aiSaveInterval">{{ tr('common.btn.save') }}</button>
        <label class="ai-pick" :title="tr('aiu.autoProbeHint')">
          <input type="checkbox" v-model="aiAutoProbe" @change="aiSaveAutoProbe" />
          {{ tr('aiu.autoProbe') }}
        </label>
        <span v-if="aiConfig.lastRunAt" class="ai-last">{{ tr('aiu.lastRun', { t: (aiConfig.lastRunAt || '').slice(0, 19).replace('T', ' ') }) }}</span>
        <span class="ai-last">{{ aiAutoProbe ? tr('aiu.nextProbe') : tr('aiu.nextRefresh') }}: {{ aiNextProbe }}</span>
        <span v-if="aiMsg" class="ok">{{ aiMsg }}</span>
      </div>

      <!-- 多账号：CLI 的哪个 Profile 属于当前这个阿里云账号（「全部」视图不绑定） -->
      <div v-if="aiViewAll" class="ai-cfg ai-bindbar">
        <span class="ai-cfg-l">{{ tr('aiu.cliIdentity') }}</span>
        <span class="ai-last">{{ tr('aiu.allViewHint') }}</span>
      </div>
      <div v-else class="ai-cfg ai-bindbar">
        <span class="ai-cfg-l">{{ tr('aiu.cliIdentity') }}</span>
        <template v-if="aiCliOk && aiProfiles.length">
          <select v-model="aiBindProfile">
            <option value="">{{ tr('aiu.noBinding') }}</option>
            <option v-for="p in aiProfiles" :key="p.name" :value="p.name">{{ aiProfileLabel(p) }}</option>
          </select>
          <button class="primary" :disabled="aiBusy" @click="aiBindNow">
            {{ aiConfig.cliBindings?.[aiAccountId] ? tr('aiu.rebind') : tr('aiu.bindHere') }}
          </button>
          <span v-if="aiBoundSummary" class="ai-bound">
            {{ tr('aiu.bound', { p: aiBoundSummary.profile }) }}<template v-if="aiBoundSummary.workspace"> · {{ tr('aiu.workspace', { w: aiBoundSummary.workspace }) }}</template><template v-if="aiBoundSummary.apiKey"> · {{ aiBoundSummary.apiKey }}</template> ✓
          </span>
          <button v-if="aiConfig.cliBindings?.[aiAccountId]" :disabled="aiBusy" @click="aiBindProfile = ''; aiBindNow()">
            {{ tr('aiu.unbind') }}
          </button>
          <button :disabled="aiCliChecking" @click="loadAiCliStatus">
            {{ aiCliChecking ? tr('aiu.checking') : tr('aiu.cliCheck') }}
          </button>
          <!-- 常驻入口：加第二个阿里云账号的 CLI 登录（不随绑定状态消失） -->
          <button :disabled="aiBusy" @click="aiAddCliOpen = !aiAddCliOpen">
            {{ aiAddCliOpen ? tr('aiu.addCliCollapse') : tr('aiu.addCli') }}
          </button>
        </template>
        <span v-else-if="aiCliReason" class="ai-last">
          {{ aiCliReason }}
          <button type="button" class="col-cfg-btn" @click="aiCliSetupOpen = !aiCliSetupOpen">
            {{ aiCliSetupOpen ? tr('aiu.howLoginCollapse') : tr('aiu.howLogin') }}
          </button>
        </span>
        <!-- 降级：旧后端还没有 /profiles（未重启），退回「绑定 CLI 当前登录身份」的老路径 -->
        <template v-else-if="aiCliApiMissing">
          <button class="primary" :disabled="aiBusy || !aiAccountId" @click="aiBindLegacy">
            {{ aiConfig.cliBindings?.[aiAccountId] ? tr('aiu.boundRebind') : tr('aiu.bindCliHere') }}
          </button>
          <span class="ai-last">
            {{ tr('aiu.restartHint') }}
          </span>
        </template>
        <span class="ai-last">
          <template v-if="aiCliOk">
            {{ tr('aiu.addSecond', { cloud: aiCloudLabel }) }}
          </template>
          <template v-else>
            {{ tr('aiu.firstUse', { cli: aiCliLabel }) }}
          </template>
        </span>
      </div>

      <!-- CLI 未登录时的登录指引 -->
      <div v-if="aiCliSetupOpen && !aiCliOk" class="ai-addcli">
        <div class="ai-addcli-body">
          <ol class="ai-steps">
            <li>
              <span class="ai-step-n">1</span>
              <div>
                {{ tr('aiu.stepCopyA') }}<strong>{{ tr('aiu.terminal') }}</strong>{{ tr('aiu.stepCopyB') }}<br />
                <span class="ai-cmdline">
                  <code>{{ aiLoginCmd }}</code>
                  <button class="ai-copy" :title="tr('aiu.copyCmd')" @click="copyValue('cli-login', aiLoginCmd)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
                    </svg>
                  </button>
                </span>
              </div>
            </li>
            <li>
              <span class="ai-step-n">2</span>
              <div>
                {{ tr('aiu.step2A') }}<strong>{{ tr('aiu.accountOf', { cloud: aiCloudLabel }) }}</strong>{{ tr('aiu.step2B') }}
              </div>
            </li>
            <li>
              <span class="ai-step-n">3</span>
              <div>
                {{ tr('aiu.step3A') }}
                <button :disabled="aiCliChecking" @click="loadAiProfiles(); loadAiCliStatus()">
                  {{ aiCliChecking ? tr('aiu.detecting') : tr('aiu.recheck') }}
                </button>
                {{ tr('aiu.step3B') }}
              </div>
            </li>
          </ol>
        </div>
      </div>

      <!-- 添加第二个 CLI 登录身份（常驻入口在上方「CLI 身份」栏，不随绑定状态消失） -->
      <div v-if="aiAddCliOpen && aiCliOk" class="ai-addcli">
        <div class="ai-addcli-body">
          <ol class="ai-steps">
            <li>
              <span class="ai-step-n">0</span>
              <div>
                {{ tr('aiu.step0A', { name: aiAccountName }) }}
                <strong>{{ tr('aiu.step0Key', { p: aiIsTencent ? 'TokenHub' : (aiIsVolc ? tr('aiu.volcShort') : tr('aiu.bailianShort')) }) }}</strong>{{ tr('aiu.step0B') }}
              </div>
            </li>
            <li>
              <span class="ai-step-n">1</span>
              <div>
                {{ tr('aiu.step1A') }}
                <template v-if="aiIsTencent">{{ tr('aiu.step1Tencent') }}
                  <code>{{ aiThCmd }} profile create --name {{ aiNewProfileEff }}</code>
                </template>
                <template v-else-if="aiIsVolc">
                  {{ tr('aiu.step1Volc') }}
                  <code>{{ aiArkCmd }} profile create --name {{ aiNewProfileEff }} --type platform --region cn-beijing --project default --set-default --no-interactive</code>
                </template>
                {{ tr('aiu.step1B') }}<br />
                <span class="ai-cmdline">
                  <input v-model="aiNewProfileName" :placeholder="aiCliSuggest || 'profile-2'" spellcheck="false" />
                  <code>{{ aiAddCmd }}</code>
                  <button class="ai-copy" :title="tr('aiu.copyCmd')" @click="copyValue('add-cli', aiAddCmd)">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
                    </svg>
                  </button>
                </span>
              </div>
            </li>
            <li>
              <span class="ai-step-n">2</span>
              <div>
                {{ tr('aiu.step2PasteA') }}<strong>{{ tr('aiu.step2PasteKey', { name: aiAccountName, cloud: aiCloudLabel }) }}</strong>{{ tr('aiu.step2PasteB') }}
                {{ tr('aiu.step2Note') }}
                <br />
                <span class="ai-hint">{{ tr('aiu.cmdPathA') }}<code>{{ aiIsTencent ? 'thcli' : (aiIsVolc ? 'arkcli' : 'bl') }}</code>{{ tr('aiu.cmdPathB') }}</span>
              </div>
            </li>
            <li>
              <span class="ai-step-n">3</span>
              <div>
                回到这里点
                <button :disabled="aiBusy" @click="aiRefreshProfiles">{{ tr('aiu.refreshIdentities') }}</button>
                {{ tr('aiu.step3Add') }}
              </div>
            </li>
          </ol>
        </div>
      </div>

      <p v-if="aiErr" class="ai-alert">{{ aiErr }}</p>

      <p v-if="!aiViewAll && aiSnapshot?.apiKeyFrom?.shared" class="ai-warn">
        {{ tr('aiu.borrowWarn', { name: aiSnapshot.apiKeyFrom.name }) }}
      </p>

      <!-- 免费额度的来源与取数状态：失败必须说人话，绝不留一片空白让人猜 -->
      <div v-if="aiQuotaSource" class="ai-warn ai-srcbar" :class="{ 'ai-srcbar-err': aiQuotaSource.kind === 'err' }">
        <span class="ai-src-ico">{{ aiQuotaSource.kind === 'err' ? '!' : 'i' }}</span>
        <div class="ai-src-txt">
          <div>{{ aiQuotaSource.text }}</div>
          <div v-if="aiQuotaSource.stale" class="ai-src-sub">
            {{ tr('aiu.staleHint') }}
          </div>
        </div>
        <button
          v-if="aiAccountProviderId === 'aliyun' && !aiViewAll && aiQuotaSource.kind === 'err'"
          class="ai-src-btn primary"
          :disabled="aiCliRenewing || aiBusy"
          @click="aiRenewCli"
        >
          {{ aiCliRenewing ? tr('aiu.renewing') : tr('aiu.renew') }}
        </button>
        <button class="ai-src-btn" :disabled="aiCliChecking" @click="loadAiCliStatus">
          {{ aiCliChecking ? tr('aiu.checking') : tr('aiu.cliCheck') }}
        </button>
      </div>

      <div v-if="aiCliStatus" class="ai-cli-box">
        <div class="ai-cli-row">
          <b>{{ tr('aiu.cliCheck') }}</b>
          <span v-if="!aiCliStatus.ok" class="bad">{{ tr('aiu.cliNotReady', { reason: aiCliStatus.reason }) }}</span>
          <span v-else>
            {{ tr('aiu.cliInstalled', { p: aiCliStatus.active }) }}
            <span v-if="aiCliStatus.gateway?.ok === true" class="ok">{{ tr('aiu.gatewayOk', { n: aiCliStatus.gateway.count }) }}</span>
            <span v-else-if="aiCliStatus.gateway?.ok === false" class="bad">{{ tr('aiu.gatewayBad', { e: aiCliStatus.gateway.error }) }}</span>
            <span v-else>{{ tr('aiu.gatewayUnknown') }}</span>
          </span>
        </div>
        <div v-if="!aiCliStatus.ok || aiCliStatus.gateway?.ok === false" class="ai-cli-fix">
          <template v-if="aiAccountProviderId === 'aliyun' && !aiViewAll">
            <button
              class="primary"
              :disabled="aiCliRenewing || aiBusy || !aiAccountId"
              @click="aiRenewCli"
            >
              {{ aiCliRenewing ? tr('aiu.renewingBrowser') : tr('aiu.renewNoTerm') }}
            </button>
            <span class="ai-src-sub">
              {{ tr('aiu.renewHint', { p: aiCliStatus.checkProfile || aiCliStatus.active || '—' }) }}
            </span>
          </template>
          <template v-else>
            {{ tr('aiu.fixRun') }}
            <code>{{ aiCliFixCmd }}</code>
            <button class="ai-copy" :title="tr('aiu.copyCmd')" @click="copyValue('fix-cli', aiCliFixCmd)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
              </svg>
            </button>
            <span class="ai-src-sub">{{ tr('aiu.fixDone') }}</span>
          </template>
        </div>
        <div v-if="aiCliStatus.ok && aiCliStatus.profiles?.length" class="ai-cli-fix">
          {{ tr('aiu.loggedIdentities') }}
          <span v-for="p in aiCliStatus.profiles" :key="p.name" class="ai-cli-p">
            {{ p.name }}{{ p.active ? tr('aiu.activated') : '' }}｜{{ p.identity?.workspaceId || tr('aiu.spaceUnknown') }}｜{{ p.identity?.apiKey || tr('aiu.notLogged') }}
          </span>
        </div>
      </div>

      <p v-if="!aiAccounts.length" class="empty">{{ tr('aiu.emptyAccounts') }}</p>

      <template v-else>
        <div class="stats">
          <div class="stat">
            <div class="k">{{ aiViewAll ? tr('aiu.stat.accounts') : tr('aiu.stat.balance') }}</div>
            <div class="v num">
              <template v-if="aiViewAll">{{ aiAccounts.length }}</template>
              <template v-else>{{ aiSnapshot?.balance ? aiSnapshot.balance.amount.toFixed(2) + ' ' + aiSnapshot.balance.currency : '—' }}</template>
            </div>
          </div>
          <div class="stat">
            <div class="k">{{ tr('aiu.stat.spend') }}</div>
            <div class="v num">{{ aiSnapshot?.spendTotal != null ? '¥' + aiSnapshot.spendTotal.toFixed(2) : '—' }}</div>
          </div>
          <div class="stat">
            <div class="k">{{ tr('aiu.stat.aiSpend') }}</div>
            <div class="v num" :class="{ zero: (aiSnapshot?.aiSpend ?? 0) === 0 }">
              {{ aiSnapshot?.aiSpend != null ? '¥' + aiSnapshot.aiSpend.toFixed(2) : '—' }}
            </div>
          </div>
          <div class="stat">
            <div class="k">{{ tr('aiu.stat.models') }}</div>
            <div class="v num">{{ aiSnapshot?.modelTotal ?? '—' }}</div>
          </div>
          <div class="stat">
            <div class="k">{{ aiQuotas.length ? tr('aiu.stat.withQuota') : (aiNeedBind ? tr('aiu.stat.freeQuota') : tr('aiu.stat.freeInUse')) }}</div>
            <div class="v num">{{ aiQuotas.length ? aiQuotas.length : (aiNeedBind || !aiSnapshot ? '—' : aiFreeInUse) }}</div>
          </div>
        </div>

        <p v-if="aiAcctStale" class="ai-warn">⏳ {{ aiAcctStale }}</p>

        <div v-if="uiMode === 'new'" class="seg">
          <button :class="{ on: aiSubTab === 'free' }" @click="aiSubTab = 'free'">{{ tr('aiu.sub.free') }}</button>
          <button :class="{ on: aiSubTab === 'spend' }" @click="aiSubTab = 'spend'">{{ tr('aiu.sub.spend') }}</button>
          <button :class="{ on: aiSubTab === 'models' }" @click="aiSubTab = 'models'">{{ tr('aiu.sub.models') }}</button>
          <button :class="{ on: aiSubTab === 'changes' }" @click="aiSubTab = 'changes'">{{ tr('aiu.sub.changes') }}</button>
        </div>
        <div v-else class="ai-subtabs">
          <button :class="{ on: aiSubTab === 'free' }" @click="aiSubTab = 'free'">{{ tr('aiu.sub.free') }}</button>
          <button :class="{ on: aiSubTab === 'spend' }" @click="aiSubTab = 'spend'">{{ tr('aiu.sub.spend') }}</button>
          <button :class="{ on: aiSubTab === 'models' }" @click="aiSubTab = 'models'">{{ tr('aiu.sub.models') }}</button>
          <button :class="{ on: aiSubTab === 'changes' }" @click="aiSubTab = 'changes'">{{ tr('aiu.sub.changes') }}</button>
        </div>

        <p v-if="!aiSnapshot" class="empty">{{ tr('aiu.emptyNoData') }}</p>

        <template v-else>
          <!-- 免费额度：严格按账号归属 —— 未绑定 CLI 就不显示任何额度，只给绑定入口 -->
          <div v-if="aiSubTab === 'free'">
            <!-- 状态一：本账号未绑定 CLI 身份 → 空着 + 引导绑定（绝不显示来源不明的数据） -->
            <div v-if="aiNeedBind" class="ai-bindcard">
              <div class="ai-bc-ico">?</div>
              <div class="ai-bc-body">
                <div class="ai-bc-t">{{ tr('aiu.bc.title') }}</div>
                <p class="ai-bc-p">
                  {{ tr('aiu.bc.bodyA') }}<strong>{{ tr('aiu.bc.bodyStrong') }}</strong>{{ tr('aiu.bc.bodyB') }}
                </p>
                <div v-if="aiCliOk && aiProfiles.length" class="ai-bc-act">
                  <select v-model="aiBindProfile">
                    <option value="">{{ tr('aiu.noBinding') }}</option>
                    <option v-for="p in aiProfiles" :key="p.name" :value="p.name">{{ aiProfileLabel(p) }}</option>
                  </select>
                  <button class="primary" :disabled="aiBusy || !aiBindProfile" @click="aiBindNow">{{ tr('aiu.bindHere') }}</button>
                </div>
                <p v-if="aiBindWarn && aiBindProfile" class="ai-warn ai-bc-warn">⚠ {{ aiBindWarn }}</p>

                <template v-if="aiCliOk && aiProfiles.length">
                  <p class="ai-bc-hint">
                    {{ tr('aiu.bc.hint1A') }}<span class="ai-bc-good">{{ tr('aiu.bc.hint1Good') }}</span>{{ tr('aiu.bc.hint1B') }}
                    <template v-if="aiProfiles.every((p: any) => !p.match)">
                      {{ tr('aiu.bc.hintNoMatch', { n: aiProfiles.length }) }}<strong>{{ tr('aiu.bc.hintNoMatchStrong') }}</strong>{{ tr('aiu.bc.hintNoMatchB', { name: aiAccountName }) }}
                    </template>
                  </p>

                  <p class="ai-bc-hint">
                    {{ tr('aiu.bc.hint2A') }}
                    <button type="button" class="link-btn" @click="aiAddCliOpen = true">{{ tr('aiu.addCli') }}</button>
                  </p>
                </template>
                <p v-else class="ai-bc-hint">
                  {{ tr('aiu.bc.cliHintA', { reason: aiCliReason || tr('aiu.cliUnavailable') }) }}
                  <code>bl auth login --console</code>{{ tr('aiu.bc.cliHintB') }}
                </p>
              </div>
            </div>

            <template v-else-if="aiQuotas.length">
              <p v-if="aiExpiringSoon.length" class="ai-alert">
                {{ tr('aiu.expiring', { n: aiExpiringSoon.length }) }}
                <template v-if="daysLeft(aiExpiringSoon[0].expires) !== null">
                  {{ tr('aiu.expiringSub', { d: aiExpiringSoon[0].expires, n: daysLeft(aiExpiringSoon[0].expires)!, p: aiExpiringSoon[0].remainingPercent }) }}
                </template>
              </p>

              <!-- 官方明文规则：解释「到期」与「重置」的区别，避免把到期日当成重置点 -->
              <p class="ai-note">
                <strong>{{ tr('aiu.rule.title') }}</strong>{{ tr('aiu.rule.a') }}<strong>{{ tr('aiu.rule.days') }}</strong>{{ tr('aiu.rule.b') }}<strong>{{ tr('aiu.rule.strong') }}</strong>{{ tr('aiu.rule.c') }}<strong>{{ tr('aiu.rule.strong2') }}</strong>{{ tr('aiu.rule.d') }}
                <template v-if="aiLongTermCount">
                  {{ tr('aiu.rule.longA') }}<strong>{{ aiLongTermCount }}</strong>{{ tr('aiu.rule.longB') }}<strong>{{ tr('aiu.rule.longStrong') }}</strong>{{ tr('aiu.rule.longC') }}
                </template>
                <br />
                <span class="ai-note-dim">
                  {{ tr('aiu.rule.footA') }}
                  <a href="https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota" target="_blank" rel="noopener">{{ tr('aiu.rule.footLink') }}</a>{{ tr('aiu.rule.footB') }}
                </span>
              </p>

              <div class="ai-mod-bar">
                <button :class="{ on: aiQuotaType === '全部' }" @click="aiQuotaType = '全部'">
                  {{ tr('aiu.all') }}<span class="ai-mod-n">{{ aiQuotas.length }}</span>
                </button>
                <!-- 显示用中文，aiQuotaType 仍存英文 key 用于过滤 -->
                <button v-for="(n, t) in aiQuotaTypes" :key="t" :class="{ on: aiQuotaType === t }" @click="aiQuotaType = t">
                  {{ typeCn(t) }}<span class="ai-mod-n">{{ n }}</span>
                </button>
              </div>

              <div v-if="uiMode === 'new'" class="ai-colbar">
                <span class="ai-note-t">{{ tr('aiu.modelsCount', { n: aiQuotasFiltered.length }) }}</span>
                <span class="sp"></span>
                <button class="ai-colbtn" @click="aiColPicker = 'quota'">
                  {{ tr('aiu.colConfig') }} <span class="num">{{ aiCols.length }}/{{ aiColOpts.length }}</span>
                </button>
              </div>

              <table class="tbl-assets">
                <colgroup>
                  <col v-if="aiViewAll" style="width:10%" />
                  <col :style="aiViewAll ? 'width:18%' : 'width:20%'" />
                  <col v-if="aiColOn('kind')" style="width:8%" />
                  <col v-if="aiColOn('quota')" style="width:15%" />
                  <col v-if="aiColOn('pct')" style="width:8%" />
                  <col v-if="aiColOn('expires')" style="width:12%" />
                  <col v-if="aiColOn('reset')" style="width:10%" />
                  <col v-if="aiColOn('price')" style="width:14%" />
                  <col v-if="aiColOn('switch')" style="width:10%" />
                </colgroup>
                <thead>
                  <tr>
                    <th v-if="aiViewAll">{{ tr('aiu.th.account') }}</th>
                    <th class="ai-th-sort" @click="aiToggleSort('model')">{{ tr('aiu.th.model') }} {{ aiSortArrow('model') }}</th>
                    <th v-if="aiColOn('kind')">{{ tr('aiu.th.kind') }}</th>
                    <th v-if="aiColOn('quota')">{{ tr('aiu.th.quota') }}</th>
                    <th v-if="aiColOn('pct')" class="ai-th-sort" @click="aiToggleSort('remainingPercent')">{{ tr('aiu.th.pct') }} {{ aiSortArrow('remainingPercent') }}</th>
                    <th v-if="aiColOn('expires')" class="ai-th-sort" @click="aiToggleSort('expires')">{{ tr('aiu.th.expires') }} {{ aiSortArrow('expires') }}</th>
                    <th
                      v-if="aiColOn('reset')"
                      class="ai-th-help"
                      :title="tr('aiu.th.resetHelp')"
                    >{{ tr('aiu.th.reset') }} ⓘ</th>
                    <th v-if="aiColOn('price')" class="ai-th-help" :title="tr('aiu.th.priceHelp')">{{ tr('aiu.th.price') }} ⓘ</th>
                    <th
                      v-if="aiColOn('switch')"
                      class="ai-th-help"
                      :title="aiViewAll
                        ? tr('aiu.th.switchAllHelp')
                        : (aiIsTencent
                          ? tr('aiu.th.switchTencentHelp')
                          : tr('aiu.th.switchAliyunHelp'))"
                    >{{ aiViewAll ? tr('aiu.th.switch') : (aiIsTencent ? tr('aiu.th.switchTencent') : tr('aiu.th.switchAliyun')) }} ⓘ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="q in aiQuotasFiltered" :key="(q.accountId || '') + ':' + q.model + ':' + (q.endpointId || '')">
                    <td v-if="aiViewAll"><span class="ai-acct-tag" :title="q.accountName">{{ q.accountName || '—' }}</span></td>
                    <td class="mono ai-model-cell">
                      <span class="ai-model-id">{{ q.model }}</span>
                      <button
                        class="ai-copy"
                        :class="{ done: copiedKey === 'quota:' + (q.accountId || '') + ':' + q.model }"
                        :title="copiedKey === 'quota:' + (q.accountId || '') + ':' + q.model ? tr('aiu.copied') : tr('aiu.copy.modelName', { m: q.model })"
                        :aria-label="tr('aiu.copy.modelNameAria', { m: q.model })"
                        @click="copyValue('quota:' + (q.accountId || '') + ':' + q.model, q.model)"
                      >
                        <svg v-if="copiedKey !== 'quota:' + q.model" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                          <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
                          <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 0 2.5 4.5v5a1.5 1.5 0 0 0 1.5 1.5h1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                        </svg>
                        <svg v-else viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                          <path d="M3.5 8.6l3 3 6-6.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </td>
                    <td v-if="aiColOn('kind')">{{ typeCn(q.type) }}</td>
                    <td v-if="aiColOn('quota')" class="mono">
                      {{ q.remaining != null ? q.remaining.toLocaleString() : '—' }}
                      / {{ q.total != null ? q.total.toLocaleString() : '—' }}
                      <span v-if="q.unit" class="ai-unit">{{ q.unit }}</span>
                    </td>
                    <td v-if="aiColOn('pct')">
                      <span
                        class="ai-verdict"
                        :class="(q.remainingPercent ?? 100) <= 20 ? 'bad' : ((q.remainingPercent ?? 100) <= 60 ? 'warn' : 'ok')"
                      >{{ q.remainingPercent != null ? q.remainingPercent + '%' : '—' }}</span>
                    </td>
                    <td v-if="aiColOn('expires')" class="ai-ts">
                      <!-- 2099 这类哨兵日期 = 平台设的「长期有效」，显示日期毫无意义 -->
                      <template v-if="isLongTerm(q)">
                        <span class="ai-long">{{ tr('aiu.longTerm') }}</span>
                      </template>
                      <template v-else>
                        {{ q.expires || '—' }}
                        <span
                          v-if="daysLeft(q.expires) !== null && daysLeft(q.expires)! <= 30"
                          class="ai-days"
                        >{{ daysLeft(q.expires)! <= 0 ? tr('aiu.expired') : tr('aiu.daysLeft', { n: daysLeft(q.expires)! }) }}</span>
                      </template>
                    </td>
                    <td v-if="aiColOn('reset')" class="ai-reset" :class="{ 'ai-reset-na': !q.reset || q.reset.kind === 'unknown' }">
                      <span :title="lang === 'en-US' ? '' : q.reset?.note || ''">{{ resetText(q) }}</span>
                    </td>
                    <td v-if="aiColOn('price')" class="ai-price-cell">
                      <span class="ai-price-sum">{{ priceSummary(quotaPriceOf(q.model).summary) }}</span>
                      <div v-if="quotaPriceOf(q.model).prices.length" class="ai-price-tip" role="tooltip">
                        <div class="ai-price-tip-h">{{ tr('aiu.priceTip', { m: q.model }) }}</div>
                        <ul>
                          <li v-for="(p, i) in quotaPriceOf(q.model).prices" :key="i">{{ formatPriceLine(p) }}</li>
                        </ul>
                      </div>
                    </td>
                    <td v-if="aiColOn('switch')">
                      <!-- 腾讯云：按 Token 计费（postpaid / PaymentEnabled） -->
                      <button
                        v-if="q.postpaid === true || q.postpaid === false"
                        class="ai-switch"
                        :class="{ on: q.postpaid === true }"
                        :disabled="aiBusy || !q.endpointId"
                        :title="!q.endpointId
                          ? tr('aiu.noEndpoint')
                          : (q.postpaid === true
                            ? tr('aiu.toggleOffPostpaid')
                            : tr('aiu.toggleOnPostpaid'))"
                        @click="aiToggleStop(q.model, q.postpaid, q.accountId, q.endpointId)"
                      >
                        <span class="ai-knob"></span>{{ q.postpaid === true ? tr('aiu.on') : tr('aiu.off') }}
                      </button>
                      <!-- 阿里云：用完即停 -->
                      <button
                        v-else-if="q.autoStop === true || q.autoStop === false"
                        class="ai-switch"
                        :class="{ on: q.autoStop === true }"
                        :disabled="aiBusy"
                        :title="q.autoStop === true ? tr('aiu.toggleOffAutoStop') : tr('aiu.toggleOnAutoStop')"
                        @click="aiToggleStop(q.model, q.autoStop, q.accountId)"
                      >
                        <span class="ai-knob"></span>{{ q.autoStop === true ? tr('aiu.on') : tr('aiu.off') }}
                      </button>
                      <span v-else class="ai-ts">{{ tr('aiu.notSupported') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!aiViewAll" class="ai-bulk">
                <span class="ai-note-t">{{ tr('aiu.bulk') }}</span>
                <template v-if="aiIsTencent">
                  <button :disabled="aiBusy" @click="aiClaimFree('all')" title="thcli models free all">{{ tr('aiu.claimAll') }}</button>
                  <button :disabled="aiBusy" @click="aiToggleStopAll(true)">{{ tr('aiu.allPostpaidOn') }}</button>
                  <button :disabled="aiBusy" @click="aiToggleStopAll(false)">{{ tr('aiu.allOff') }}</button>
                  <span class="ai-note-t">{{ tr('aiu.enabledCount', { on: aiQuotas.filter((q: any) => q.postpaid === true).length, total: aiQuotas.length }) }}</span>
                </template>
                <template v-else>
                  <button :disabled="aiBusy" @click="aiToggleStopAll(true)">{{ tr('aiu.allAutoStopOn') }}</button>
                  <button :disabled="aiBusy" @click="aiToggleStopAll(false)">{{ tr('aiu.allOff') }}</button>
                  <span class="ai-note-t">{{ tr('aiu.enabledCount', { on: aiQuotas.filter((q: any) => q.autoStop === true).length, total: aiQuotas.length }) }}</span>
                </template>
              </div>
              <p v-else class="ai-note">{{ tr('aiu.allViewNote') }}</p>

              <p v-if="aiIsTencent" class="ai-note">
                {{ tr('aiu.note.tencentA') }}<code>thcli endpoint list</code> / <code>plan list</code>{{ tr('aiu.note.tencentB') }}<code>thcli endpoint postpaid on|off</code>{{ tr('aiu.note.tencentC') }}<code>thcli models free all</code>{{ tr('aiu.note.tencentD') }}
              </p>
              <p v-else-if="aiIsVolc" class="ai-note">
                {{ tr('aiu.note.volcA') }}<code>arkcli usage balance --type free-quota</code>{{ tr('aiu.note.volcB') }}<code>pricing models</code>{{ tr('aiu.note.volcC') }}<code>models list</code>{{ tr('aiu.note.volcD') }}
              </p>
              <p v-else class="ai-note">
                {{ tr('aiu.note.aliyunA') }}<code>bl usage free</code>{{ tr('aiu.note.aliyunB') }}
              </p>
            </template>

            <template v-else>
              <p v-if="aiSnapshot?.cli && !aiSnapshot.cli.ok" class="ai-warn">
                {{ tr('aiu.fb.cliOff', { r: aiSnapshot.cli.reason }) }}
              </p>
              <!-- 已绑定却一条都没有：分清「本次取数失败」和「这个账号真没有免费额度」 -->
              <p v-else-if="aiSnapshot?.cli?.quotaError" class="ai-warn">
                {{ tr('aiu.fb.quotaErr', { p: aiSnapshot.cli.boundProfile, e: aiSnapshot.cli.quotaError }) }}
              </p>
              <p v-else-if="aiSnapshot?.cli?.ok" class="ai-note">
                {{ tr('aiu.fb.noQuotaInline', { p: aiSnapshot.cli.boundProfile }) }}<strong>{{ tr('aiu.fb.noQuotaStrong') }}</strong>{{ tr('aiu.fb.noQuotaB') }}
                <template v-if="aiIsTencent">
                  {{ tr('aiu.fb.claimFirst') }}
                  <button type="button" class="link-btn" :disabled="aiBusy || aiViewAll" @click="aiClaimFree('all')">{{ tr('aiu.claimAll') }}</button>
                  {{ tr('aiu.fb.claimThen') }}
                </template>
                <template v-else>{{ tr('aiu.fb.retry') }}</template>
              </p>
              <table v-if="aiFreeStatus.length" class="tbl-assets">
                <colgroup><col style="width:26%" /><col style="width:12%" /><col style="width:14%" /><col style="width:18%" /><col style="width:14%" /><col style="width:16%" /></colgroup>
                <thead><tr><th>{{ tr('aiu.th.model') }}</th><th>{{ tr('aiu.th.modality') }}</th><th>{{ tr('aiu.th.pricing') }}</th><th>{{ tr('aiu.th.probeStatus') }}</th><th>{{ tr('aiu.th.verdict') }}</th><th>{{ tr('aiu.th.probeTime') }}</th></tr></thead>
                <tbody>
                  <tr v-for="p in aiFreeStatus" :key="p.modelId">
                    <td class="mono">{{ p.modelId }}</td>
                    <td>{{ p.modality }}</td>
                    <td>{{ p.price }}</td>
                    <td>
                      <span class="ai-dot" :class="'s-' + p.status"></span>{{ probeText(p.status) }}
                      <span v-if="p.http" class="ai-http">{{ p.http }}</span>
                    </td>
                    <td><span class="ai-verdict" :class="p.verdict === '免费额度内' ? 'ok' : (p.verdict === '已计费' ? 'warn' : 'bad')">{{ verdictText(p.verdict) }}</span></td>
                    <td class="ai-ts">{{ (p.ts || '').slice(0, 19).replace('T', ' ') }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="empty">{{ tr('aiu.noProbe') }}</p>
              <p class="ai-note">{{ tr('aiu.verdictRule') }}</p>
            </template>
          </div>

          <!-- 消费明细 -->
          <div v-else-if="aiSubTab === 'spend'">
            <h4 class="ai-h4">{{ tr('aiu.pkg.title') }}</h4>
            <table v-if="(aiSnapshot.packages || []).length" class="tbl-assets">
              <colgroup><col style="width:26%" /><col style="width:14%" /><col style="width:14%" /><col style="width:12%" /><col style="width:17%" /><col style="width:17%" /></colgroup>
              <thead><tr><th>{{ tr('aiu.th.name') }}</th><th>{{ tr('aiu.th.total') }}</th><th>{{ tr('aiu.th.remaining') }}</th><th>{{ tr('aiu.th.unit') }}</th><th>{{ tr('aiu.th.effective') }}</th><th>{{ tr('aiu.th.expiry') }}</th></tr></thead>
              <tbody>
                <tr v-for="(p, i) in aiSnapshot.packages" :key="i">
                  <td>{{ p.name }}</td>
                  <td class="mono">{{ p.total }}</td>
                  <td class="mono">{{ p.remaining }}</td>
                  <td>{{ p.unit }}</td>
                  <td class="ai-ts">{{ (p.start || '—').slice(0, 10) }}</td>
                  <td class="ai-ts">{{ (p.expiry || '—').slice(0, 10) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="empty">{{ tr('aiu.noPkg') }}</p>

            <p v-if="aiSnapshot?.aiSpend != null" class="ai-note">
              {{ tr('aiu.spendNoteA') }}<strong>¥{{ aiSnapshot.aiSpend.toFixed(2) }}</strong>
              <span v-if="aiSnapshot.aiSpend === 0">{{ tr('aiu.spendNoteZero') }}</span>
            </p>

            <h4 class="ai-h4">{{ tr('aiu.ledger.title') }}</h4>
            <table v-if="(aiSnapshot.spendRows || []).length" class="tbl-assets">
              <colgroup><col style="width:26%" /><col style="width:20%" /><col style="width:34%" /><col style="width:20%" /></colgroup>
              <thead><tr><th>{{ tr('aiu.th.time') }}</th><th>{{ tr('aiu.th.cycle') }}</th><th>{{ tr('aiu.th.account') }}</th><th class="r">{{ tr('aiu.th.amount') }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in aiSnapshot.spendRows.slice(0, 50)" :key="i">
                  <td class="ai-ts">{{ (r.time || '—').slice(0, 10) }}</td>
                  <td>{{ r.billingCycle || '—' }}</td>
                  <td>{{ r.account || '—' }}</td>
                  <td class="mono r">¥{{ r.amount.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="empty">{{ tr('aiu.noLedger') }}</p>
          </div>

          <!-- 模型清单 -->
          <div v-else-if="aiSubTab === 'models'">
            <div class="ai-mod-bar">
              <button
                v-for="m in ['全部', ...Object.keys(aiModalityCounts)]"
                :key="m"
                :class="{ on: aiModality === m }"
                @click="aiModality = m"
              >{{ m === '全部' ? tr('aiu.all') : m }}<span v-if="m !== '全部'" class="ai-mod-n">{{ aiModalityCounts[m] }}</span></button>
            </div>
            <div v-if="uiMode === 'new'" class="ai-colbar">
              <span class="ai-note-t">{{ tr('aiu.modelsCount', { n: aiFilteredModels.length }) }}</span>
              <span class="sp"></span>
              <button class="ai-colbtn" @click="aiColPicker = 'dir'">
                {{ tr('aiu.colConfig') }} <span class="num">{{ aiDirCols.length }}/{{ aiDirOpts.length }}</span>
              </button>
            </div>
            <p v-if="aiCatalog?.ts" class="ai-note" style="margin-top:0">
              {{ tr('aiu.catalog.ts', { t: (aiCatalog.ts || '').slice(0, 19).replace('T', ' ') }) }}
              {{ tr('aiu.catalog.families', { n: aiCatalog.total || (aiCatalog.models || []).length }) }}
              {{ tr('aiu.catalog.source', { s: aiCatalog.source || '—' }) }}
              <span v-if="aiCatalog.error"> · {{ aiCatalog.error }}</span>
              <template v-else>{{ tr('aiu.catalog.hoverTip') }}</template>
            </p>
            <p v-else class="ai-note" style="margin-top:0">
              {{ tr('aiu.catalog.empty') }}
            </p>
            <div v-if="aiIsTencent && !aiViewAll" class="ai-bulk" style="margin-bottom:8px">
              <button :disabled="aiBusy" @click="aiClaimFree('all')" title="thcli models free all">{{ tr('aiu.claimAll') }}</button>
              <span class="ai-note-t">{{ tr('aiu.trialDeclared', { n: aiFilteredModels.filter((m: any) => m.freeTrial).length }) }}</span>
            </div>
            <table class="tbl-assets">
              <colgroup>
                <col v-if="aiViewAll" style="width:9%" />
                <col :style="aiViewAll ? (aiIsTencent ? 'width:18%' : 'width:22%') : (aiIsTencent ? 'width:20%' : 'width:26%')" />
                <col style="width:14%" />
                <col style="width:14%" />
                <col style="width:10%" />
                <col v-if="aiIsTencent" style="width:10%" />
                <col v-if="aiIsTencent" style="width:10%" />
                <col :style="aiIsTencent ? 'width:14%' : 'width:22%'" />
                <col v-if="aiIsTencent && !aiViewAll" style="width:9%" />
              </colgroup>
              <thead>
                <tr>
                  <th v-if="aiViewAll">{{ tr('aiu.th.account') }}</th>
                  <th>{{ tr('aiu.th.modelId') }}</th>
                  <th v-if="aiDirColOn('name')">{{ tr('aiu.th.name') }}</th>
                  <th v-if="aiDirColOn('caps')">{{ tr('aiu.th.caps') }}</th>
                  <th v-if="aiDirColOn('published')">{{ tr('aiu.th.published') }}</th>
                  <th v-if="aiIsTencent" class="ai-th-help" :title="tr('aiu.statusHelp')">{{ tr('aiu.th.status') }} ⓘ</th>
                  <th v-if="aiIsTencent" class="ai-th-help" :title="tr('aiu.offlineHelp')">{{ tr('aiu.th.offline') }} ⓘ</th>
                  <th v-if="aiDirColOn('price')">{{ tr('aiu.th.price2') }}</th>
                  <th v-if="aiIsTencent && !aiViewAll">{{ tr('aiu.th.claim') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in aiFilteredModels.slice(0, 200)" :key="m._rowKey || m.id">
                  <td v-if="aiViewAll"><span class="ai-acct-tag" :title="m.accountName">{{ m.accountName || '—' }}</span></td>
                  <td class="mono ai-model-cell">
                    <span class="ai-model-id">{{ m.id }}</span>
                    <button
                      class="ai-copy"
                      :class="{ done: copiedKey === 'model:' + (m._rowKey || m.id) }"
                      :title="copiedKey === 'model:' + (m._rowKey || m.id) ? tr('aiu.copied') : tr('aiu.copy.modelId', { m: m.id })"
                      :aria-label="tr('aiu.copy.modelIdAria', { m: m.id })"
                      @click="copyValue('model:' + (m._rowKey || m.id), m.id)"
                    >
                      <svg v-if="copiedKey !== 'model:' + (m._rowKey || m.id)" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                        <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
                        <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 0 2.5 4.5v5a1.5 1.5 0 0 0 1.5 1.5h1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                      </svg>
                      <svg v-else viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                        <path d="M3.5 8.6l3 3 6-6.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </td>
                  <td v-if="aiDirColOn('name')">{{ m.name || '—' }}</td>
                  <td v-if="aiDirColOn('caps')" class="ai-caps">{{ (m.capabilities || []).join(' / ') || '—' }}</td>
                  <td v-if="aiDirColOn('published')" class="ai-ts">{{ (m.publishedAt || '—').slice(0, 10) }}</td>
                  <td v-if="aiIsTencent">
                    <span
                      class="ai-verdict"
                      :class="String(m.status || '') === 'online' ? 'ok' : (String(m.status || '') === 'pre-offline' ? 'warn' : (m.status ? 'bad' : ''))"
                      :title="m.discontinuedAt ? tr('aiu.discontinuedAt', { d: m.discontinuedAt }) : ''"
                    >{{ thStatusLabel(m.status) }}</span>
                  </td>
                  <td v-if="aiIsTencent" class="ai-ts">{{ m.offlineAt || '—' }}</td>
                  <td v-if="aiDirColOn('price')" class="ai-price-cell">
                    <span class="ai-price-sum">{{ m.price || '—' }}</span>
                    <div v-if="(m.prices || []).length" class="ai-price-tip" role="tooltip">
                      <div class="ai-price-tip-h">{{ m.name || m.id }}</div>
                      <ul>
                        <li v-for="(p, i) in m.prices" :key="i">{{ formatPriceLine(p) }}</li>
                      </ul>
                    </div>
                  </td>
                  <td v-if="aiIsTencent && !aiViewAll">
                    <button
                      v-if="m.freeTrial"
                      class="link-btn"
                      :disabled="aiBusy"
                      :title="tr('aiu.claimHintTitle')"
                      @click="aiClaimFree([m.id])"
                    >{{ tr('aiu.claimModel') }}</button>
                    <span v-else class="ai-ts">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="ai-note">
              {{ tr('aiu.listFoot', { n: aiFilteredModels.length }) }}
              <template v-if="aiIsTencent">{{ tr('aiu.listFootA') }}<code>models list</code>{{ tr('aiu.listFootTencent') }}<code>models free</code>{{ tr('aiu.listFootTencentEnd') }}</template>
              <template v-else>{{ tr('aiu.listFoot.other') }}</template>
            </p>
          </div>

          <!-- 变更记录 -->
          <div v-else-if="aiSubTab === 'changes'">
            <h4 class="ai-h4">{{ tr('aiu.chg.catalogTitle') }}</h4>
            <p v-if="aiCatalog?.ts" class="ai-note" style="margin-top:0">
              {{ tr('aiu.chg.lastTs', { t: (aiCatalog.ts || '').slice(0, 19).replace('T', ' ') }) }}
              {{ tr('aiu.chg.updatedBy') }}
              {{ tr('aiu.chg.vendors') }}
            </p>
            <template v-if="(aiCatalog?.history || []).length">
              <div v-for="(ev, ei) in aiCatalog.history" :key="ei" class="ai-chg-block">
                <div class="ai-ts">{{ (ev.ts || '').slice(0, 19).replace('T', ' ') }}</div>
                <ul v-if="(ev.added || []).length" class="ai-chg">
                  <li v-for="id in ev.added" :key="'ca' + ei + id"><span class="ai-chg-t add">{{ tr('aiu.tag.add') }}</span><span class="mono">{{ id }}</span></li>
                </ul>
                <ul v-if="(ev.removed || []).length" class="ai-chg">
                  <li v-for="id in ev.removed" :key="'cr' + ei + id"><span class="ai-chg-t del">{{ tr('aiu.tag.remove') }}</span><span class="mono">{{ id }}</span></li>
                </ul>
                <ul v-if="(ev.priceChanged || []).length" class="ai-chg">
                  <li v-for="pc in ev.priceChanged" :key="'cp' + ei + pc.id">
                    <span class="ai-chg-t price">{{ tr('aiu.tag.price') }}</span>
                    <span class="mono">{{ pc.id }}</span>
                    <span class="ai-chg-p">{{ pc.before }} → {{ pc.after }}</span>
                  </li>
                </ul>
              </div>
            </template>
            <p v-else class="empty">{{ tr('aiu.noCatalogChanges') }}</p>

            <template v-if="!aiViewAll">
              <h4 class="ai-h4">{{ tr('aiu.chg.accountTitle') }}</h4>
              <div v-if="(aiSnapshot.changes?.added || []).length || (aiSnapshot.changes?.removed || []).length || (aiSnapshot.changes?.priceChanged || []).length">
                <ul v-if="(aiSnapshot.changes?.added || []).length" class="ai-chg">
                  <li v-for="id in aiSnapshot.changes.added" :key="'a' + id"><span class="ai-chg-t add">{{ tr('aiu.tag.new') }}</span><span class="mono">{{ id }}</span></li>
                </ul>
                <ul v-if="(aiSnapshot.changes?.removed || []).length" class="ai-chg">
                  <li v-for="id in aiSnapshot.changes.removed" :key="'r' + id"><span class="ai-chg-t del">{{ tr('aiu.tag.remove') }}</span><span class="mono">{{ id }}</span></li>
                </ul>
                <ul v-if="(aiSnapshot.changes?.priceChanged || []).length" class="ai-chg">
                  <li v-for="pc in aiSnapshot.changes.priceChanged" :key="'p' + pc.id">
                    <span class="ai-chg-t price">{{ tr('aiu.tag.price') }}</span>
                    <span class="mono">{{ pc.id }}</span>
                    <span class="ai-chg-p">{{ pc.before }} → {{ pc.after }}</span>
                  </li>
                </ul>
              </div>
              <p v-else class="empty">{{ tr('aiu.noAccountChanges') }}</p>
            </template>
          </div>
        </template>
      </template>
    </section>

    <!-- 我的项目：本地项目启停与状态监控 -->
    <!-- 未逐页重写的页面：统一套模板变量桥接，保证配色跟随模板（结构后续再拆） -->
    <div
      v-else-if="tab === 'myprojects'"
      class="mg-page"
      :class="{ 'mg-legacy': uiMode === 'new' }"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
    >
      <MyProjects />
    </div>

    <!-- MCP 接入教程 -->
    <div
      v-else-if="tab === 'mcp'"
      class="mg-page"
      :class="{ 'mg-token': uiMode === 'new' }"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
    >
      <McpGuide />
    </div>

    <!-- 设置：改口令等 -->
    <div
      v-else-if="tab === 'settings'"
      class="mg-page mg-token"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
    >
      <SettingsPanel @saved="onSettingsSaved" @imported="loadAll" @locked="handleLocked" />
    </div>

    <!-- 审计日志 -->
    <section v-else-if="tab === 'audit' && uiMode === 'new'" class="assets-new">
      <div data-mgui class="mgui-root" :data-template="uiTemplate" :data-theme="uiTheme">
        <AuditView
          :rows="auditFiltered"
          :total="auditTotal"
          :filter="auditFilter"
          :page="auditPage"
          :page-count="auditPageCount"
          :page-size="auditPageSize"
          :ts-text="formatTs"
          :kind-label="auditKindLabel"
          :category="auditCategory"
          :action-text="auditCn"
          :field-cn="auditFieldCn"
          :preview-text="auditPreviewCn"
          @filter="auditFilter = $event"
          @page="loadAudit($event)"
          @page-size="(n: number) => { auditPageSize = n; onAuditPageSizeChange(); }"
          @restore="auditRestore"
        />
      </div>
    </section>

    <section v-else-if="tab === 'audit'">
      <div class="page-head">
        <h2>审计日志</h2>
        <p>谁在什么时候取了什么、干了什么，全部留痕；超 5MB 自动轮转。</p>
      </div>
      <div class="audit-bar">
        <div class="audit-tabs">
          <button type="button" :class="{ on: auditFilter === 'all' }" @click="auditFilter = 'all'">全部</button>
          <button type="button" :class="{ on: auditFilter === 'user' }" @click="auditFilter = 'user'">人工操作</button>
          <button type="button" :class="{ on: auditFilter === 'agent' }" @click="auditFilter = 'agent'">Agent 操作</button>
        </div>
        <span class="audit-meta">共 {{ auditTotal }} 条</span>
        <label class="audit-size">
          <span>每页</span>
          <select v-model.number="auditPageSize" @change="onAuditPageSizeChange">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
          <span>行</span>
        </label>
        <div class="audit-pager">
          <button type="button" :disabled="auditPage <= 1" @click="loadAudit(auditPage - 1)">上一页</button>
          <span>{{ auditPage }} / {{ auditPageCount }}</span>
          <button type="button" :disabled="auditPage >= auditPageCount" @click="loadAudit(auditPage + 1)">下一页</button>
        </div>
      </div>
      <table v-if="auditFiltered.length">
        <thead><tr><th>时间</th><th>操作方</th><th>动作</th><th>明细</th></tr></thead>
        <tbody>
          <tr v-for="(e, i) in auditFiltered" :key="i">
            <td class="mono ts">{{ formatTs(e.ts) }}</td>
            <td><span class="tag" :class="{ act: auditCategory(e) === 'agent' }">{{ auditKindLabel(e) }}</span></td>
            <td>
              {{ auditCn(e) }}
              <button v-if="e.undo" type="button" class="audit-undo" @click="auditRestore(e)">↺ 恢复</button>
            </td>
            <td class="mono small">
              <div v-if="e.changes && e.changes.length" class="audit-detail">
                <div v-for="c in e.changes" :key="c.k">{{ auditFieldCn(c.k) }}：{{ c.from }} → {{ c.to }}</div>
              </div>
              <div v-else-if="e.preview" class="audit-detail">{{ auditPreviewCn(e.preview) }}</div>
              <div v-else class="audit-detail">{{ auditRawCn(e) }}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">暂无该分类的记录。</p>
    </section>

    <!-- 从其它密码管理器导入 -->
    <div v-if="impOpen" class="modal" @click.self="impOpen = false">
      <div class="box imp-box">
        <div class="box-head">
          <h3>{{ tr('imp.title') }}</h3>
          <button class="close" @click="impOpen = false">关闭</button>
        </div>
        <p class="hint sub">{{ tr('imp.hint') }}</p>
        <div class="imp-pick">
          <label class="btn">{{ tr('imp.pick') }}<input type="file" accept=".csv,.1pux" @change="onImportFile" /></label>
          <span v-if="impFormat" class="imp-fmt">{{ impFormat }}</span>
        </div>
        <textarea v-model="impContent" class="imp-text" rows="4" :placeholder="tr('imp.paste')"></textarea>
        <div class="imp-actions">
          <button class="btn" :disabled="impBusy" @click="previewImport">{{ impBusy ? tr('imp.busy') : tr('imp.preview') }}</button>
          <label class="imp-mode">
            {{ tr('imp.mode') }}
            <select v-model="impMode">
              <option value="skip">{{ tr('imp.mode.skip') }}</option>
              <option value="update">{{ tr('imp.mode.update') }}</option>
              <option value="append">{{ tr('imp.mode.append') }}</option>
            </select>
          </label>
          <button class="btn primary" :disabled="impBusy || !impPreview" @click="commitImport">{{ tr('imp.confirm') }}</button>
        </div>
        <p v-if="impErr" class="imp-err">{{ impErr }}</p>
        <p v-if="impResult" class="imp-ok">{{ tr('imp.result', impResult) }}</p>
        <template v-if="impPreview">
          <p class="hint sub">{{ tr('imp.total', { n: impPreview.total, d: impPreview.duplicates }) }}</p>
          <div class="imp-list">
            <div v-for="(it, i) in impPreview.items" :key="i" class="imp-row">
              <span class="imp-name">{{ it.title || it.site || '—' }}</span>
              <span class="imp-site">{{ it.site }}</span>
              <span class="imp-user">{{ it.username }}</span>
              <span class="imp-mark">{{ it.hasPassword ? '•••' : '' }}{{ it.hasTotp ? ' TOTP' : '' }}</span>
              <span v-if="it.duplicateOf" class="imp-dup">{{ tr('imp.dup') }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 详情弹窗：加宽左右布局 -->
    <div v-if="detail" class="modal" @click.self="detail = null">
      <div class="box box-wide">
        <div class="box-head">
          <h3>{{ detail.name }} <span class="tag type-tag" :class="'t-' + detail.type" :style="typeStyle(detail.type)">{{ typeLabel(detail.type) }}</span></h3>
          <div class="box-head-actions">
            <button class="secret-toggle" @click="showSecrets = !showSecrets">{{ showSecrets ? '隐藏敏感' : '显示敏感' }}</button>
            <button class="close" @click="detail = null; issueInfo = null">关闭</button>
          </div>
        </div>
        <div class="split">
          <div class="split-main">
            <div class="issue-bar">
              <button v-if="detail.type === 'server'" @click="issueSshProxy">签发 SSH 代理</button>
              <button v-if="detail.baseUrl || detail.panelUrl || detail.proxyInject" @click="issueHttpProxy">签发 HTTP 代理</button>
            </div>
            <pre v-if="issueInfo" class="issue-box">{{ JSON.stringify(issueInfo, null, 2) }}</pre>
            <table class="kv">
              <tr v-for="[k, v] in detailRows(detail)" :key="k">
                <th>{{ fieldLabel(k) }}</th>
                <td :class="{ secret: isSecretField(k) }">
                  <span class="kv-val">{{ isSecretField(k) ? mask(v) : displayValue(v) }}</span>
                  <button
                    v-if="canCopy(k, v)"
                    class="copy-btn"
                    :class="{ done: copiedKey === k }"
                    :title="isSecretField(k) ? '复制明文（屏幕上已打码，复制出来是真实值）' : '复制该值'"
                    @click="copyValue(k, v)"
                  >{{ copiedKey === k ? '已复制' : '复制' }}</button>
                </td>
              </tr>
            </table>
          </div>
          <aside class="split-side">
            <h4>{{ tr('versions.title') }}</h4>
            <template v-if="versions.length">
              <div v-for="v in versions" :key="v.vid" class="ver-item">
                <div class="ver-head">
                  <span>{{ df(new Date(v.ts).getTime(), { dateStyle: 'medium', timeStyle: 'short', hour12: false }) }}</span>
                  <span class="ver-src">{{ versionSrcLabel(v.source) }}</span>
                </div>
                <div class="ver-changed">
                  {{ v.changed && v.changed.length ? v.changed.map((k: string) => fieldLabel(k)).join(' / ') : tr('versions.noChange') }}
                </div>
                <button type="button" class="ver-btn" @click="restoreVersion(v)">{{ tr('versions.restore') }}</button>
              </div>
            </template>
            <p v-else class="side-empty">{{ versionsLoaded ? tr('versions.empty') : '…' }}</p>

            <h4>关联</h4>
            <template v-if="detailRelations.out.length || detailRelations.inn.length">
              <div v-if="detailRelations.out.length" class="rel-group">
                <div class="rel-cap">本项关联到</div>
                <button
                  v-for="r in detailRelations.out"
                  :key="'o'+r.id"
                  type="button"
                  class="rel-chip"
                  :class="{ missing: r.missing }"
                  @click="!r.missing && openRelated(r.id)"
                >
                  <span class="tag sm">{{ linkRoleName(r.role) }}</span>
                  {{ r.name }}
                </button>
              </div>
              <div v-if="detailRelations.inn.length" class="rel-group">
                <div class="rel-cap">被谁关联</div>
                <button
                  v-for="r in detailRelations.inn"
                  :key="'i'+r.id"
                  type="button"
                  class="rel-chip"
                  @click="openRelated(r.id)"
                >
                  <span class="tag sm">{{ linkRoleName(r.role) }}</span>
                  {{ r.name }}
                </button>
              </div>
            </template>
            <p v-else class="side-empty">暂无关联</p>
          </aside>
        </div>
      </div>
    </div>

    <!-- 新增/编辑表单：加宽左右布局 -->
    <div
      v-if="editing"
      class="modal"
      :class="{
        'mg-modal': uiMode === 'new',
        'mg-panel': uiMode === 'new' && editing !== 'new',
        'mg-center': uiMode === 'new' && editing === 'new',
      }"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
    >
      <div class="box box-wide">
        <div class="box-head">
          <h3>{{ editing === 'new' ? tr('form.newAsset') : tr('form.editAsset') }}</h3>
          <label class="ftype inline">{{ tr('meta.field.type') }}
            <select v-model="formType">
              <option v-for="t in typeOptions" :key="t.key" :value="t.key">{{ t.label }}</option>
            </select>
          </label>
          <!-- 右上角 ×：显式出口，不用滚到底部找「取消」，也和抽屉的 × 行为一致 -->
          <button v-if="uiMode === 'new'" type="button" class="mg-x" :aria-label="tr('assets.btn.close')" @click="closeForm()">×</button>
        </div>
        <div class="split">
          <div class="split-main">
            <div class="form-grid">
              <label v-for="f in COMMON_BASIC" :key="f.k">{{ f.label }}
                <input v-model="form[f.k]" :placeholder="f.label" />
              </label>
              <label v-for="f in formFieldList" :key="f.k" :class="{ 'with-hint': !!f.hint && !f.span2, 'full-row': f.textarea || f.full || f.secret, 'span-2': !!f.span2 }">
                <span class="flabel" :title="f.hint || undefined">{{ f.label }}{{ f.secret ? tr('form.sensitive') : '' }}</span>
                <span v-if="f.hint && !f.span2" class="fhint">{{ f.hint }}</span>
                <template v-if="f.catalogKey">
                  <div class="combo-row">
                    <select :value="catalogSelectValue(f)" @change="onCatalogSelect(f, $event)">
                      <option v-for="o in catalogOpts(f.catalogKey)" :key="o" :value="o">{{ o }}</option>
                      <option v-if="catalogAllowCustom(f.catalogKey)" :value="CATALOG_CUSTOM">{{ tr('form.catalogCustom') }}</option>
                    </select>
                    <input
                      v-if="catalogSelectValue(f) === CATALOG_CUSTOM"
                      v-model="form[f.k]"
                      type="text"
                      :placeholder="tr('form.catalogPh')"
                      class="catalog-custom"
                    />
                  </div>
                </template>
                <select v-else-if="f.select" v-model="form[f.k]" :class="{ 'narrow-select': f.narrow }">
                  <option v-for="o in f.select" :key="String(o)" :value="o">{{ optionLabel(f, o) }}</option>
                </select>
                <div v-else-if="f.secret && f.textarea" class="secret-input col">
                  <textarea
                    v-model="form[f.k]"
                    rows="4"
                    :placeholder="editing === 'new' ? tr('form.secretPh') : tr('form.savedKeep')"
                    :class="{ masked: !formReveal[f.k] }"
                    spellcheck="false"
                  />
                  <button type="button" class="eye" @click="toggleFormReveal(f.k)">
                    {{ formReveal[f.k] ? tr('form.hide') : tr('form.show') }}
                  </button>
                </div>
                <div v-else-if="f.secret" class="secret-input">
                  <input
                    v-model="form[f.k]"
                    :placeholder="editing === 'new' ? f.label : tr('form.savedKeep')"
                    :type="formReveal[f.k] ? 'text' : 'password'"
                    autocomplete="off"
                  />
                  <button type="button" class="eye" @click="toggleFormReveal(f.k)">
                    {{ formReveal[f.k] ? tr('form.hide') : tr('form.show') }}
                  </button>
                </div>
                <textarea v-else-if="f.textarea" v-model="form[f.k]" rows="3" :placeholder="f.label" spellcheck="false" />
                <input
                  v-else
                  v-model="form[f.k]"
                  :placeholder="f.label"
                  :type="f.date ? 'date' : f.num ? 'number' : 'text'"
                />
              </label>

              <!-- 项目入口：机房机柜的 W/A/D 按钮、项目页的入口列表都读这份 urls -->
              <div v-if="formType === 'project'" class="proj-urls">
                <div class="flabel">{{ tr('form.projUrls') }}</div>
                <p class="fhint">{{ tr('form.projUrlsHint') }}</p>
                <div class="proj-url-grid">
                  <label v-for="e in URL_ENTRIES" :key="e.k">
                    <span class="fhint">{{ urlEntryLabel(e.k) }}</span>
                    <input v-model="formUrls[e.k]" :placeholder="e.k === 'web' ? 'https://…' : tr('form.optional')" spellcheck="false" />
                  </label>
                </div>
              </div>

              <!-- 项目里程碑：上线/交付节点 -->
              <div v-if="formType === 'project'" class="proj-ms">
                <div class="flabel">{{ tr('form.milestones') }}</div>
                <p class="fhint">{{ tr('form.milestonesHint') }}</p>
                <div v-for="(m, i) in formMilestones" :key="m.id" class="ms-row">
                  <input v-model="m.name" :placeholder="tr('form.msNamePh')" />
                  <input v-model="m.date" type="date" />
                  <label class="ms-done"><input v-model="m.done" type="checkbox" />{{ tr('form.msDone') }}</label>
                  <button type="button" class="ms-del" :title="tr('assets.btn.delete')" @click="formMilestones.splice(i, 1)">×</button>
                </div>
                <button type="button" class="ms-add" @click="addMilestone">{{ tr('form.msAdd') }}</button>
              </div>
            </div>
          </div>
          <aside class="split-side">
            <div v-if="formType === 'ssh_key'" class="upload-box side-block">
              <div class="flabel">{{ tr('form.uploadKey') }}</div>
              <p class="fhint">{{ tr('form.uploadKeyHint') }}</p>
              <div class="upload-actions">
                <label class="file-btn">
                  {{ tr('form.pickPrivate') }}
                  <input type="file" @change="onUploadPrivateKey" />
                </label>
                <label class="file-btn ghost">
                  {{ tr('form.pickPublic') }}
                  <input type="file" accept="*/*" @change="onUploadPublicKey" />
                </label>
              </div>
              <p v-if="keyUploadMsg" class="upload-msg">{{ keyUploadMsg }}</p>
            </div>

            <div class="side-block qf-block">
              <h4>{{ tr('form.fieldsOfType') }}</h4>
              <p class="fhint">{{ tr('form.fieldsOfTypeHint', { name: typeLabel(formType) }) }}</p>
              <ul v-if="formCustomFields.length" class="qf-list">
                <li v-for="f in formCustomFields" :key="f.key">
                  <span class="qf-name">{{ f.label }}</span>
                  <span class="qf-kind">{{ fieldKindLabel(f.kind) }}</span>
                  <button type="button" class="link-rm" :disabled="quickFieldBusy" @click="removeQuickField(f)">{{ tr('assets.btn.delete') }}</button>
                </li>
              </ul>
              <p v-else class="fhint qf-empty">{{ tr('form.noCustomFields') }}</p>
              <div class="qf-add">
                <input
                  v-model="quickFieldLabel"
                  :placeholder="tr('form.newFieldPh')"
                  @keyup.enter="addQuickField"
                />
                <select v-model="quickFieldKind">
                  <option v-for="k in FIELD_KINDS" :key="k" :value="k">{{ fieldKindLabel(k) }}</option>
                </select>
                <button type="button" :disabled="!quickFieldLabel.trim() || quickFieldBusy" @click="addQuickField">{{ tr('form.addField') }}</button>
              </div>
              <p v-if="quickFieldMsg" class="fhint qf-msg">{{ quickFieldMsg }}</p>
            </div>

            <div class="side-block">
              <h4>{{ tr('form.note') }}</h4>
              <label class="note-field">
                <textarea v-model="form.note" rows="3" :placeholder="tr('form.notePh')"></textarea>
              </label>
            </div>

            <div class="side-block">
              <h4>{{ tr('form.links') }}</h4>
              <p class="fhint">{{ tr('form.linksHint') }}</p>
              <ul v-if="formLinks.length" class="link-list">
                <li v-for="l in formLinks" :key="l.id">
                  <span class="tag sm">{{ linkRoleName(l.role) }}</span>
                  {{ formLinkLabel(l.id) }}
                  <button type="button" class="link-rm" @click="removeFormLink(l.id)">{{ tr('form.linkRemove') }}</button>
                </li>
              </ul>
              <div class="link-add col">
                <label class="link-pick-label">{{ tr('form.linkRole') }}
                  <select v-model="linkPickRole" @change="onLinkRoleChange">
                    <option v-for="r in LINK_ROLE_OPTIONS" :key="r" :value="r">{{ roleLabel(r) }}</option>
                  </select>
                </label>
                <label class="link-pick-label">{{ tr('form.linkPick') }}
                  <select v-model="linkPickId">
                    <option value="">{{ linkCandidates.length ? tr('form.linkPickPh') : tr('form.linkNone') }}</option>
                    <option v-for="a in linkCandidates" :key="a.id" :value="a.id">
                      {{ linkAssetLabel(a, !linkRoleToAssetType(linkPickRole)) }}
                    </option>
                  </select>
                </label>
                <button type="button" @click="addFormLink" :disabled="!linkPickId">{{ tr('form.linkAdd') }}</button>
              </div>
            </div>

            <div class="side-block">
              <h4>{{ tr('form.rotation') }}</h4>
              <div class="rot-row">
                <label v-for="f in ROTATION" :key="f.k" class="rot-label">{{ f.label }}
                  <input v-model="form[f.k]" :type="f.date ? 'date' : (f.num ? 'number' : 'text')" :placeholder="f.label" />
                </label>
              </div>
            </div>
          </aside>
        </div>
        <div class="form-actions bar">
          <button class="primary" @click="save">{{ tr('common.btn.save') }}</button>
          <button @click="closeForm()">{{ tr('common.btn.cancel') }}</button>
        </div>
      </div>
    </div>
    </main>

    <!-- 白名单/备忘弹窗：放在主区分支之外，新旧界面共用 -->
    <div
      v-if="wlEditing"
      class="modal"
      :class="{ 'mg-modal mg-center': uiMode === 'new' }"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
      @click.self="closeWlForm"
    >
      <div class="box">
        <h3>{{ wlEditing === 'new' ? '新增白名单绑定' : '编辑白名单绑定' }}</h3>
        <div class="form-grid">
          <label>名称（可选）
            <input v-model="wlForm.name" placeholder="如：家里宽带" />
          </label>
          <label>厂商
            <select v-model="wlForm.provider">
              <option value="aliyun">阿里云（前缀列表）</option>
              <option value="tencent">腾讯云（地址模板）</option>
            </select>
          </label>
          <label class="full">云账号（AK/SK 从燧垒取，不落盘）
            <select v-model="wlForm.assetId">
              <option v-for="a in cloudAccounts" :key="a.id" :value="a.id">
                {{ a.name }} · {{ a.provider || a.type }}
              </option>
            </select>
          </label>
          <label>地域 Region
            <select v-if="wlRegions.length" v-model="wlForm.region">
              <option value="">（请选择）</option>
              <option v-if="wlForm.region && !wlRegions.some((r: any) => r.id === wlForm.region)" :value="wlForm.region">
                {{ wlForm.region }}（已保存）
              </option>
              <option v-for="r in wlRegions" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
            <input v-else v-model="wlForm.region" placeholder="如 cn-hangzhou / ap-shanghai" />
          </label>
          <label>安全组 ID（可选）
            <input v-model="wlForm.securityGroupId" placeholder="sg-xxxx" />
          </label>
          <label class="full">{{ wlForm.provider === 'aliyun' ? '前缀列表' : '地址模板' }}
            <select v-if="wlTargets.length" v-model="wlForm.targetId">
              <option value="">（请选择）</option>
              <option v-if="wlForm.targetId && !wlTargets.some((t: any) => t.id === wlForm.targetId)" :value="wlForm.targetId">
                {{ wlForm.targetId }}（已保存）
              </option>
              <option v-for="t in wlTargets" :key="t.id" :value="t.id">{{ t.name }}{{ t.desc ? ' · ' + t.desc : '' }}</option>
            </select>
            <input v-else v-model="wlForm.targetId" :placeholder="wlForm.provider === 'aliyun' ? 'pl-xxxx' : 'atm-xxxx'" />
          </label>
          <div class="full wl-opt">
            <button :disabled="wlOptBusy || !wlForm.assetId" @click="loadWlOptions(false); if (wlForm.region) loadWlOptions(true)">
              {{ wlOptBusy ? '拉取中…' : '重新拉取' }}
            </button>
            <span v-if="!wlOptBusy && !wlOptErr" class="wl-opt-tip">
              地域与「{{ wlForm.provider === 'aliyun' ? '前缀列表' : '地址模板' }}」会用本账号的 AK/SK 实时拉取，选一下即可，不用手填。
              <template v-if="wlForm.provider === 'tencent' && wlForm.region && !wlTargets.length">
                该地域下还没建地址模板 —— 去腾讯云控制台「VPC → IP地址模板」新建一个再来选。
              </template>
            </span>
            <span v-if="wlOptErr" class="wl-opt-err">{{ wlOptErr }}</span>
            <span v-if="wlOptHint" class="wl-opt-tip">{{ wlOptHint }}</span>
          </div>
          <label class="full wl-check">
            <input type="checkbox" v-model="wlForm.enabled" /> 启用（停用后手动与定时都不执行）
          </label>
        </div>
        <p class="wl-form-note">
          <template v-if="wlForm.provider === 'tencent'">
            腾讯云的原理：把当前公网 IP 写进<strong>地址模板</strong>，
            安全组规则里<strong>引用</strong>该模板即自动放行 —— 所以真正被更新的是地址模板，
            「安全组 ID」只是备注、不填也能跑。模板需在腾讯云控制台
            「私有网络 VPC → IP 地址模板」先建好，然后回来在上面选中它。
          </template>
          <template v-else>
            阿里云的原理：更新 ECS <strong>前缀列表</strong> 的条目（移除旧 IP + 加入当前 IP），
            安全组规则引用该前缀列表即自动放行。
          </template>
        </p>
        <div class="form-actions">
          <button class="primary" @click="saveWl">保存</button>
          <button @click="closeWlForm">{{ tr('common.btn.cancel') }}</button>
        </div>
      </div>
    </div>
    <div
      v-if="memoEditing"
      class="modal"
      :class="{ 'mg-modal mg-center': uiMode === 'new' }"
      :data-mgui="uiMode === 'new' ? '' : undefined"
      :data-template="uiMode === 'new' ? uiTemplate : undefined"
      :data-theme="uiMode === 'new' ? uiTheme : undefined"
      @click.self="closeMemoForm"
    >
      <div class="box">
        <h3>{{ memoEditing === 'new' ? '新增备忘' : '编辑备忘' }}</h3>
        <div class="form-grid">
          <label class="full">标题
            <input v-model="memoForm.name" placeholder="如：阿里云 AK/SK" />
          </label>
          <label class="full">内容（支持多行）
            <textarea v-model="memoForm.content" rows="12" placeholder="可完整粘贴密钥、账号等信息"></textarea>
          </label>
        </div>
        <div class="form-actions">
          <button class="primary" @click="saveMemo">保存</button>
          <button @click="closeMemoForm">{{ tr('common.btn.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 资产相关的两个弹窗：放在主区分支之外，旧版/新版资产清单共用 -->
      <!-- 模型用量列配置：复用资产清单那套两栏弹窗的视觉，不再用右下角浮层遮表格 -->
      <div
        v-if="aiColPicker"
        class="modal"
        :class="{ 'mg-modal mg-center': uiMode === 'new' }"
        :data-mgui="uiMode === 'new' ? '' : undefined"
        :data-template="uiMode === 'new' ? uiTemplate : undefined"
        :data-theme="uiMode === 'new' ? uiTheme : undefined"
        @click.self="aiColPicker = ''"
      >
        <div class="box colcfg2 cc-pick">
          <header class="cc-head">
            <div>
              <h3>{{ tr('col.title') }}</h3>
              <p>{{ aiColPicker === 'quota' ? tr('col.sub.quota') : tr('col.sub.models') }} · {{ tr('col.pickHint') }}</p>
            </div>
            <button class="cc-x" :aria-label="tr('assets.btn.close')" @click="aiColPicker = ''">×</button>
          </header>
          <div class="cc-pick-body">
            <button
              v-for="c in aiColPicker === 'quota' ? aiColOpts : aiDirOpts"
              :key="c.k"
              type="button"
              class="cc-item"
              :class="{ on: pickerHas(c.k) }"
              @click="pickerToggle(c.k)"
            >
              <i class="cc-ck">{{ pickerHas(c.k) ? '✓' : '' }}</i>
              <span class="cc-name">{{ c.label }}</span>
            </button>
          </div>
          <footer class="cc-foot">
            <span class="cc-count">
              {{ (aiColPicker === 'quota' ? aiCols : aiDirCols).length }} /
              {{ (aiColPicker === 'quota' ? aiColOpts : aiDirOpts).length }}
            </span>
            <span class="cc-sp"></span>
            <button type="button" class="cc-btn" @click="pickerAll(true)">{{ tr('col.all') }}</button>
            <button type="button" class="cc-btn" @click="pickerAll(false)">{{ tr('col.allNone') }}</button>
            <button type="button" class="cc-btn primary" @click="aiColPicker = ''">{{ tr('col.done') }}</button>
          </footer>
        </div>
      </div>

      <div
        v-if="colEditorOpen"
        class="modal"
        :class="{ 'mg-modal mg-center': uiMode === 'new' }"
        :data-mgui="uiMode === 'new' ? '' : undefined"
        :data-template="uiMode === 'new' ? uiTemplate : undefined"
        :data-theme="uiMode === 'new' ? uiTheme : undefined"
        @click.self="colEditorOpen = false"
      >
        <div class="box colcfg2">
          <header class="cc-head">
            <div>
              <h3>{{ tr('col.title') }}</h3>
              <p>{{ tr('col.sub.type', { name: typeLabel(colEditorType) }) }}</p>
            </div>
            <button class="cc-x" :aria-label="tr('assets.btn.close')" @click="colEditorOpen = false">×</button>
          </header>

          <div class="cc-body">
            <section class="cc-pool">
              <div class="cc-h">
                <span>{{ tr('col.pool') }}</span>
                <input v-model="colSearch" class="cc-search" :placeholder="tr('col.search')" />
              </div>
              <div class="cc-list">
                <button
                  v-for="f in colPoolFiltered"
                  :key="f.key"
                  type="button"
                  class="cc-item"
                  :class="{ on: colEditorSel.includes(f.key) }"
                  @click="toggleCol(f.key)"
                >
                  <i class="cc-ck">{{ colEditorSel.includes(f.key) ? '✓' : '' }}</i>
                  <span class="cc-name">{{ f.label }}</span>
                </button>
                <p v-if="!colPoolFiltered.length" class="cc-none">{{ tr('col.none') }}</p>
              </div>
            </section>

            <section class="cc-picked">
              <div class="cc-h">
                <span>{{ tr('col.picked') }}</span>
                <em>{{ colEditorSel.length }}</em>
              </div>
              <ul>
                <li v-for="(k, i) in colEditorSel" :key="k">
                  <i class="cc-idx">{{ i + 1 }}</i>
                  <span class="cc-name">{{ labelOfKey(colEditorType, k) }}</span>
                  <b class="cc-mv">
                    <button type="button" :aria-label="tr('col.up')" :disabled="i === 0" @click="moveCol(i, -1)">↑</button>
                    <button
                      type="button"
                      :aria-label="tr('col.down')"
                      :disabled="i === colEditorSel.length - 1"
                      @click="moveCol(i, 1)"
                    >↓</button>
                    <button type="button" :aria-label="tr('col.remove')" class="cc-rm" @click="toggleCol(k)">×</button>
                  </b>
                </li>
              </ul>
              <p v-if="!colEditorSel.length" class="cc-none">{{ tr('col.empty') }}</p>
            </section>
          </div>

          <footer class="cc-foot">
            <span class="cc-count">{{ tr('col.count', { n: colEditorSel.length }) }}</span>
            <span class="cc-sp"></span>
            <button type="button" class="cc-btn" @click="resetColEditor">{{ tr('col.reset') }}</button>
            <button type="button" class="cc-btn" @click="colEditorOpen = false">{{ tr('common.btn.cancel') }}</button>
            <button type="button" class="cc-btn primary" @click="saveColEditor">{{ tr('common.btn.save') }}</button>
          </footer>
        </div>
      </div>

      <!-- 新增/编辑资产类型：名称、分类、颜色，以及这个类型要有哪些字段 -->
      <div
        v-if="typeEditorOpen"
        class="modal"
        :class="{ 'mg-modal': uiMode === 'new' }"
        :data-mgui="uiMode === 'new' ? '' : undefined"
        :data-template="uiMode === 'new' ? uiTemplate : undefined"
        :data-theme="uiMode === 'new' ? uiTheme : undefined"
        @click.self="typeEditorOpen = false"
      >
        <div class="box box-wide">
          <div class="box-head">
            <h3>{{ typeEditingKey ? tr('type.edit') : tr('type.new') }}</h3>
            <button class="colcfg-x" :aria-label="tr('assets.btn.close')" @click="typeEditorOpen = false">×</button>
          </div>
          <div class="type-form">
            <label>{{ tr('type.fieldName') }}
              <input v-model="typeForm.label" :placeholder="tr('type.fieldNamePh')" />
            </label>
            <label>{{ tr('type.category') }}
              <input v-model="typeForm.category" list="type-cats" :placeholder="tr('type.categoryPh')" />
            </label>
            <label>{{ tr('type.color') }}
              <input v-model="typeForm.color" type="color" />
            </label>
          </div>
          <datalist id="type-cats">
            <option v-for="c in typeCategories" :key="c" :value="c" />
          </datalist>

          <template v-if="!typeEditingKey">
            <h4 class="type-h4">{{ tr('type.fields') }}</h4>
            <div v-for="(f, i) in typeFields" :key="i" class="type-field-row">
              <input v-model="f.label" :placeholder="tr('type.fieldLabelPh')" />
              <select v-model="f.kind">
                <option v-for="k in FIELD_KINDS" :key="k" :value="k">{{ fieldKindLabel(k) }}</option>
              </select>
              <label class="type-chk"><input v-model="f.list" type="checkbox" /> {{ tr('type.col') }}</label>
              <label class="type-chk"><input v-model="f.form" type="checkbox" /> {{ tr('type.form') }}</label>
              <button class="type-del" :title="tr('col.remove')" @click="typeFields.splice(i, 1)">×</button>
            </div>
            <button class="type-add" @click="typeFields.push({ label: '', kind: 'text', list: true, form: true })">{{ tr('type.addField') }}</button>
            <p class="type-tip">{{ tr('type.tip') }}</p>
          </template>

          <p v-if="typeErr" class="err">{{ typeErr }}</p>
          <div class="type-foot">
            <button v-if="typeEditingKey" class="type-del-btn" @click="removeType">{{ tr('type.delete') }}</button>
            <button class="primary" :disabled="typeBusy" @click="saveType">{{ typeBusy ? tr('type.saveBusy') : tr('common.btn.save') }}</button>
          </div>
        </div>
      </div>
  </div>

  <!-- 悬浮锁定按钮：AI 助手页（落地页 + 对话页）不显示，避免遮挡输入区 -->
  <!-- 新版资产清单里锁定动作放在状态条/设置里，右下角这个白圆钮会盖住表格，先隐藏 -->
  <button
    v-if="!locked && tab !== 'aiassistant' && uiMode !== 'new'"
    class="lock-fab"
    title="立即锁定燧垒"
    @click="lockNow"
  >🔒</button>

  <!-- 剪贴板自动清空的全局提示 -->
  <div v-if="clipMsg" class="clip-toast">{{ clipMsg }}</div>
</template>

<style scoped>
/* ===== 视觉体系 v2（对标 旧版工作台-OPC 的质感，自写实现）=====
   平底浅灰页面 + 白卡片 + 细边框 + 圆角 + 深色主按钮；列表=卡片化表格 */
.app {
  width: 100%;
  display: grid;
  /* 外层列宽跟随侧栏折叠：新版侧栏收起时整列降到 62px，内容区多出 150px */
  grid-template-columns: var(--app-side, var(--side-w, 212px)) minmax(0, 1fr);
  /* 深浅色切换平滑化：.app 在 data-mgui 之外，过渡必须写在这里（生成 CSS 会被加前缀而失配） */
  transition: grid-template-columns 0.22s cubic-bezier(0.32, 0.72, 0, 1), background-color .2s ease, color .2s ease;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #171717;
  min-height: 100vh;
  box-sizing: border-box;
  background: #f5f5f4;
}
/* 后端断开提示条：横跨整宽，粘在顶部 */
.offline-bar {
  grid-column: 1 / -1;
  position: sticky;
  top: 0;
  z-index: var(--z-offline);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: #fff4e5;
  color: #8a4b00;
  border-bottom: 1px solid #ffd8a8;
  font-size: 12.5px;
}
.offline-bar button {
  margin-left: auto;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #ffb066;
  background: #fff;
  color: #8a4b00;
  cursor: pointer;
}

/* 左侧整体导航：固定宽度、整高 sticky；新增入口永远在这里，不随页面切换变形 */
.side {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  background: var(--surface);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.side-brand { font-size: 15px; font-weight: 700; padding: 0 6px; white-space: nowrap; }
.side-nav { display: flex; flex-direction: column; gap: 2px; }
.side-group { margin: 8px 6px 2px; font-size: 11px; color: var(--text-3); letter-spacing: .05em; }
.side-nav > button {
  background: none; border: none; text-align: left; font-size: 13.5px; padding: 8px 10px;
  border-radius: 8px; cursor: pointer; color: var(--text-2); white-space: nowrap;
}
.side-nav > button:hover { background: var(--surface-2); color: var(--text); }
.side-nav > button.on { background: #e9e9e7; color: var(--text); font-weight: 650; }
[data-theme='dark'] .side-nav > button.on { background: #2c2c2e; color: #f5f5f7; }
.side-foot { margin-top: auto; padding: 0 4px; }
.side-foot .theme-toggle { width: 100%; box-sizing: border-box; }
.main { padding: 20px 24px 48px; min-width: 0; box-sizing: border-box; }
/* 新版资产清单：主区不再留内边距，页面自己铺满（用负 margin 拼凑会在顶部/右侧漏出浅色底） */
.main.main-plain { padding: 0; height: 100vh; overflow: hidden; }
.assets-new { margin: 0; height: 100vh; overflow: hidden; }
/* 未逐页重写的页面容器：只在模板模式下撑满，经典模式保持原样 */
[data-mgui].mg-page { height: 100vh; overflow: auto; }
/* 只做变量桥接、不改内边距的页面（AI 助手这种自带全屏布局的）。
   新版模式：旧令牌名 → 模板令牌；--panel-2 取 --hover（次级面板底，与经典 surface-2「比 surface 亮一档」同语义） */
[data-mgui].mg-token {
  --panel-2: var(--hover);
  --surface: var(--panel);
  --surface-2: var(--panel-2);
  --surface-3: var(--hover);
  --border: var(--line-2);
  --border-strong: var(--line-2);
  --chip-bg: var(--hover);
  background: var(--bg);
  color: var(--text);
}
/* 强制样式排除 [type=color]（会毁掉取色器），勾选框补主题强调色（docs/设置页 F9） */
[data-mgui].mg-token input:not([type='color']),
[data-mgui].mg-token textarea,
[data-mgui].mg-token select {
  background: var(--panel) !important;
  border: 1px solid var(--line-2) !important;
  color: var(--text) !important;
}
[data-mgui].mg-token input[type='checkbox'] { accent-color: var(--accent); }
/* 经典模式同款：设置页无条件挂了 mg-token 但没有 [data-mgui]，勾选框走这条 */
.mg-page.mg-token:not([data-mgui]) input[type='checkbox'] { accent-color: var(--accent); }
/* 经典模式：设置页无条件挂了 mg-token，但模板令牌（--panel/--line/--danger/--r-*…）
   只存在于 [data-mgui] 下，这里反向补齐最小集（docs/19 §2-② F1/F2）。
   :not([data-mgui]) 保证新版不受这些旧字面量遮蔽（否则会盖掉模板的 --danger/--accent-ink 等） */
.mg-page.mg-token:not([data-mgui]) {
  --panel: var(--surface);
  --panel-2: var(--surface-2);
  --bg: var(--surface-3);
  --line: var(--border);
  --line-2: var(--border-strong);
  --hover: var(--surface-2);
  --accent-soft: rgba(47, 127, 240, .12);
  --danger: #d0453b;
  --ok: #1a7f37;
  --warn: #9a6700;
  --accent-ink: #ffffff;
  --r-xs: 4px; --r-sm: 6px; --r-md: 8px; --r-lg: 10px;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

/* 尚未逐页重构的页面（如模型用量）：整页套模板变量桥接，
   旧样式里的 --surface / --border / --text 全部映射到模板 token，
   先保证不跳浅色，布局后续再逐块重写 */
[data-mgui].mg-legacy {
  --surface: var(--panel);
  --surface-2: var(--bg);
  --surface-3: var(--hover);
  --border: var(--line);
  --border-strong: var(--line-2);
  --chip-bg: var(--hover);
  /* 旧页面把「编辑 / 日志 / 删除」这些小按钮放在 --text-3 上；
     黑曜的三级文字在纯黑底上太暗（3:1 都不到），这里提到二级 */
  --text-3: var(--text-2);
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  overflow: auto;
  padding: 24px;
  box-sizing: border-box;
  scrollbar-width: thin;
}
[data-mgui].mg-legacy h2 { color: var(--text); }
[data-mgui].mg-legacy p { color: var(--text-2); }
[data-mgui].mg-legacy select,
[data-mgui].mg-legacy input:not([type='checkbox']) {
  background: var(--panel) !important;
  border: 1px solid var(--line-2) !important;
  color: var(--text) !important;
  border-radius: var(--r-sm) !important;
}
[data-mgui].mg-legacy input[type='checkbox'] { accent-color: var(--accent); }
[data-mgui].mg-legacy table { background: transparent; }
[data-mgui].mg-legacy .primary {
  background: var(--accent) !important;
  border-color: var(--accent) !important;
  color: var(--accent-ink) !important;
}
/* 旧样式里写死的深绿/深红在深色底上几乎不可读，统一换成模板的高亮色 */
[data-mgui].mg-legacy .ok,
[data-mgui].mg-legacy .ai-bound { color: var(--accent) !important; }
[data-mgui].mg-legacy .err { color: var(--danger) !important; }
[data-mgui].mg-legacy .ai-last,
[data-mgui].mg-legacy .ai-step-n { color: var(--text-3) !important; }
[data-mgui].mg-legacy .ai-cfg button:hover { border-color: var(--line-2-strong); color: var(--text); }
[data-mgui].mg-legacy .tag,
[data-mgui].mg-legacy .chip { background: var(--hover) !important; color: var(--text-2) !important; }
[data-mgui].mg-legacy h4,
[data-mgui].mg-legacy strong { color: var(--text) !important; }
[data-mgui].mg-legacy td,
[data-mgui].mg-legacy th { border-color: var(--line) !important; }
[data-mgui].mg-legacy thead th { background: var(--bg) !important; color: var(--text-3) !important; }
/* 分段切换（免费额度 / 消费明细 / 模型清单 / 变更记录） */
[data-mgui].mg-legacy .seg {
  display: inline-flex;
  gap: 2px;
  background: var(--hover);
  border-radius: var(--r-sm);
  padding: 2px;
  margin: var(--s-3) 0 var(--s-4);
}
[data-mgui].mg-legacy .seg button {
  border: 0;
  background: none;
  color: var(--text-2);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 4px;
}
[data-mgui].mg-legacy .seg button:hover { color: var(--text); }
[data-mgui].mg-legacy .seg button.on {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
[data-mgui].mg-legacy .stat .v.zero { color: var(--text-3); }
/* 5 个指标排一行，别让第 5 个掉到下一行 */
[data-mgui].mg-legacy .stats {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: var(--s-4);
}
@media (max-width: 1100px) {
  [data-mgui].mg-legacy .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* 状态条要铺满整页宽度，抵消 .mg-legacy 的内边距 */
[data-mgui].mg-legacy .statusbar-bleed {
  margin: -24px -24px 20px;
}
/* 模型清单：列配置条与浮层 */
[data-mgui].mg-legacy .ai-colbar {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
  margin: 0 0 8px;
}
[data-mgui].mg-legacy .ai-colbar .sp { flex: 1; }
[data-mgui].mg-legacy .ai-colbtn {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
}
[data-mgui].mg-legacy .ai-colbtn:hover { color: var(--text); border-color: var(--line-2-strong); }
[data-mgui].mg-legacy .ai-colpop {
  position: absolute;
  right: 0;
  top: 34px;
  z-index: 20;
  width: 200px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  padding: 10px 12px;
}
[data-mgui].mg-legacy .ai-colpop-h {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 8px;
}
[data-mgui].mg-legacy .ai-colpop label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  padding: 3px 0;
}
[data-mgui].mg-legacy .ai-colpop-f {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
[data-mgui].mg-legacy .ai-colpop-f button {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 11.5px;
  padding: 0;
}
.mgui-root { height: 100%; }
/* 新版外壳侧栏：外层占满 .app 的第一列，内层 .shell 负责「展开态」排版
   （base.css 的规则都是 [data-mgui] .shell.side-open … 形式，.shell 必须是后代，不能是同一个元素） */
.mgui-sidebar { height: 100vh; min-height: 0; overflow: hidden; }
/* 折叠态用 --side-wx（62px），展开态用 --side-w（212px），由 .side-open 切换 */
[data-mgui].mgui-sidebar .shell {
  grid-template-columns: var(--side-wx);
  height: 100%;
  transition: grid-template-columns 0.22s cubic-bezier(0.32, 0.72, 0, 1);
}
[data-mgui].mgui-sidebar .shell.side-open {
  grid-template-columns: var(--side-w);
}
[data-mgui].mgui-sidebar .side { height: 100%; }
/* 产品名不要被 logo 挤成一条缝；右端预留 IDE 风格折叠钮的位置 */
[data-mgui].mgui-sidebar .side-brand .name {
  flex: 1;
  min-width: 0;
  padding-right: 26px;
  white-space: nowrap;
  overflow: visible;
  /* 品牌名之前用死色 #171717，深色底上等于看不见 */
  color: var(--text);
  font-size: var(--f-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}
/* 纸墨模板品牌行居中排版：名称不拉伯 flex，避免左对齐 */
[data-mgui][data-template='atlas'].mgui-sidebar .side-brand .name {
  flex: none;
  padding-right: 26px;
}
[data-mgui].mgui-sidebar .side-brand {
  gap: 10px;
  position: relative;
}
[data-mgui].mgui-sidebar .side-tgl { font-family: var(--font-mono); }
/* IDE 风格折叠钮：品牌行右端的小图标钮（替代原先 side-foot 里的整行折叠项） */
[data-mgui].mgui-sidebar .side-fold {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  padding: 0;
  color: var(--text-3);
  background: var(--side-bg);
  transition: opacity .15s ease, background-color .15s, color .15s;
}
[data-mgui].mgui-sidebar .side-fold:hover { color: var(--text); background: var(--hover); }
[data-mgui].mgui-sidebar .side-fold .ic { width: 14px; display: block; }
[data-mgui].mgui-sidebar .side-fold .ic svg { width: 14px; height: 14px; display: block; }
/* 折叠态：品牌名隐藏、logo 居中；折叠钮低透明度常显，悬停侧栏时提亮（无 hover 场景也有可见展开入口） */
[data-mgui].mgui-sidebar .shell:not(.side-open) .side-brand .logo {
  margin: 0 auto;
}
[data-mgui].mgui-sidebar .shell:not(.side-open) .side-fold { opacity: .4; }
[data-mgui].mgui-sidebar .side:hover .side-fold { opacity: 1; }
/* 深浅色切换：太阳/月亮图标交换时轻弹一下；reduced-motion 下关闭 */
[data-mgui].mgui-sidebar .side-foot .side-item .ic svg { animation: mg-ic-in .26s ease; }
@keyframes mg-ic-in {
  from { opacity: 0; transform: rotate(-45deg) scale(.7); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-mgui].mgui-sidebar .side-foot .side-item .ic svg { animation: none; }
  .app { transition: none; }
  [data-mgui].mgui-sidebar .side-fold { transition: none; }
}
/* 外层 grid 跟着收：否则侧栏内容变窄了，第一列还占着 212px 空着 */
.app:has(.mgui-sidebar .shell:not(.side-open)) {
  --app-side: var(--side-wx, 62px);
}
/* 工作台页：去掉全部内边距，iframe 铺满整个内容区（像原生页面一样无框） */
.main.main-flush { padding: 0; height: 100vh; overflow: hidden; }
/* 资产管家页：同样去内边距——抽屉/折叠钮直接顶到窗口顶部与侧栏右缘 */
.main:has(.ai-page) { padding: 0; }
/* 工作台页整页锁定视口：消除 24px 溢出（滚轮出现的空白） */
.app:has(.main-flush) { min-height: 0; height: 100vh; overflow: hidden; }
/* 工作台 iframe 固定原版浅色：容器背景保持浅色，深色模式下 iframe 加载前也不闪黑 */
.main.main-flush { background: #efefec; }
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
  gap: 12px;
  flex-wrap: wrap;
  background: transparent;
}
h1 { font-size: 20px; margin: 0; }
.sub { font-size: 12px; color: var(--text-3); margin-left: 6px; }
.header-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
nav button { background: none; border: none; font-size: 14px; padding: 6px 12px; cursor: pointer; color: var(--text-2); }
nav button.on { color: var(--accent); border-bottom: 2px solid var(--accent); }
.add-btn { font-size: 14px; padding: 8px 16px; white-space: nowrap; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin: 14px 0; flex-wrap: wrap; gap: 8px; }
.toolbar-right { display: flex; gap: 8px; align-items: center; }
.toolbar-right button { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
/* 修正：.toolbar-right button(0-1-1) 特异性高于 .primary(0-1-0)，会把主按钮刷成白底白字导致文字看不见 */
.toolbar-right button.primary { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
.toolbar-right button.primary:hover { background: #000; }
.backup-msg { font-size: 12px; color: #1f883d; margin: -6px 0 8px; }
.issue-bar { display: flex; gap: 8px; margin: 8px 0 10px; }
.issue-bar button { border: 1px solid var(--accent); background: #ddf4ff; color: var(--accent); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.issue-box { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 11px; overflow: auto; max-height: 160px; }
.chips button { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 999px; padding: 4px 12px; margin-right: 6px; margin-bottom: 4px; cursor: pointer; font-size: 13px; }
.chips button.on:not(.chip-type) { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
[data-theme='dark'] .chips button.on:not(.chip-type) { background: #f5f5f7; color: #111; border-color: #f5f5f7; }
/* 注意：不要在 td 上写 display:flex —— 单元格脱离 table-cell 布局后，
   行高与边框会和其他列错位（表现为「类型下面多出一条断开的横线」）。用内层 div 做 flex。 */
.type-cell-in { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.badge-field {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border-strong);
  font-weight: 500;
}
.type-tag, .chips .chip-type { border: 1px solid transparent; }
.type-tag.t-project, .chips .chip-type.t-project { background: #d9f3ef; color: #0a7d6c; border-color: #b3e2da; }
.type-tag.t-server, .chips .chip-type.t-server { background: #ddf4ff; color: #0550ae; border-color: #a5d6ff; }
.type-tag.t-ssh_key, .chips .chip-type.t-ssh_key { background: #dafbe1; color: #116329; border-color: #4ac26b; }
.type-tag.t-cloud_account, .chips .chip-type.t-cloud_account { background: #fbefff; color: #8250df; border-color: #e2c7ff; }
.type-tag.t-oss, .chips .chip-type.t-oss { background: #ffeff7; color: #bf3989; border-color: #f7c0dd; }
.type-tag.t-baota, .chips .chip-type.t-baota { background: #fff1e5; color: #bc4c00; border-color: #ffc67a; }
.type-tag.t-mcp, .chips .chip-type.t-mcp { background: #e0f7fa; color: #0e7490; border-color: #a5f3fc; }
.type-tag.t-api_key, .chips .chip-type.t-api_key { background: #fff8c5; color: #9a6700; border-color: #f0d060; }
.type-tag.t-login_account, .chips .chip-type.t-login_account { background: #ffebe9; color: #cf222e; border-color: #ffcecb; }
.chips .chip-type.on { color: #fff !important; border-color: transparent !important; }
.chips .chip-type.t-server.on { background: var(--accent); }
.chips .chip-type.t-ssh_key.on { background: #1a7f37; }
.chips .chip-type.t-cloud_account.on { background: #8250df; }
.chips .chip-type.t-oss.on { background: #bf3989; }
.chips .chip-type.t-baota.on { background: #bc4c00; }
.chips .chip-type.t-mcp.on { background: #0e7490; }
.chips .chip-type.t-api_key.on { background: #9a6700; }
.chips .chip-type.t-login_account.on { background: #cf222e; }
.audit-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  margin: 12px 0 8px; font-size: 13px; color: var(--text-2);
}
.audit-tabs { display: flex; gap: 0; border: 1px solid var(--border-strong); border-radius: 8px; overflow: hidden; }
.audit-tabs button { border: 0; background: var(--surface); color: var(--text-2); padding: 6px 16px; cursor: pointer; font-size: 13px; }
.audit-tabs button + button { border-left: 1px solid var(--border-strong); }
.audit-tabs button.on { background: #1d1d1f; color: #fff; font-weight: 650; }
[data-theme='dark'] .audit-tabs button.on { background: #f5f5f7; color: #111; }
.audit-undo { margin-left: 8px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--accent); border-radius: 6px; padding: 1px 8px; font-size: 11.5px; cursor: pointer; }
.audit-undo:hover { border-color: var(--accent); }
.audit-size select { margin: 0 4px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border-strong); }
.audit-pager { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.audit-pager button {
  border: 1px solid var(--border-strong); background: var(--surface); border-radius: 6px;
  padding: 4px 10px; cursor: pointer; font-size: 12px;
}
.audit-pager button:disabled { opacity: 0.45; cursor: default; }
td.ts { white-space: nowrap; color: var(--text); }
.primary { background: #1d1d1f; color: #fff; border: none; border-radius: 8px; padding: 7px 15px; cursor: pointer; font-weight: 600; }
[data-theme='dark'] .primary { background: #f5f5f7; color: #111; }
/* 列表风格：扁平（同工作台）——无外框无圆角，灰表头 + 发丝行线，靠留白呼吸 */
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; background: transparent; }
/* 类型 tab：分类小标题 + 末尾「＋」 */
.chip-cat { font-size: 11px; color: var(--text-3); margin: 0 2px 0 8px; align-self: center; }
.chip-add { width: 30px; padding: 0 !important; font-size: 16px; line-height: 1; }
/* 新增/编辑资产类型弹窗 */
.type-form { display: grid; grid-template-columns: 1.2fr 1fr 80px; gap: 10px; }
.type-form label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-2); }
.type-form input { padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface); color: var(--text); }
.type-h4 { margin: 16px 0 8px; font-size: 13px; }
.type-field-row { display: grid; grid-template-columns: 1.4fr 124px 54px 54px 26px; gap: 8px; align-items: center; margin-bottom: 7px; }
.type-field-row input:not([type='checkbox']), .type-field-row select { padding: 6px 8px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text); }
.type-chk { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); }
.type-del { border: none; background: transparent; color: var(--text-3); cursor: pointer; font-size: 15px; }
.type-add { border: 1px dashed var(--border-strong); background: transparent; color: var(--text-2); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.type-tip { font-size: 11.5px; color: var(--text-3); margin: 10px 0 0; }
.type-foot { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 18px; }
.type-del-btn { border: 1px solid #f0c4c4; background: var(--surface); color: #cf222e; border-radius: 7px; padding: 7px 12px; font-size: 12.5px; cursor: pointer; margin-right: auto; }
/* 列可自定义后列数不固定：窄屏/多列时横向滚动，不压缩单元格 */
.tbl-scroll { overflow-x: auto; }
.tbl-scroll > table { width: max-content; min-width: 100%; }
th, td { text-align: left; padding: 10px 14px; border-bottom: none; }
tbody td { border-top: 1px solid var(--border); }
thead th { color: var(--text-3); font-weight: 600; background: var(--surface-2); font-size: 12px; letter-spacing: .02em; border-bottom: 1px solid var(--border); }
tbody tr:last-child td { border-bottom: 1px solid var(--border); }
table .ops:last-child, table td:last-child { border-right: none; }
.meta { color: var(--text-2); }
.tag { background: #ddf4ff; color: var(--accent); border-radius: 4px; padding: 1px 7px; font-size: 12px; }
.tag.sm { margin-right: 4px; }
.due { background: #fff5e6; color: #bc4c00; border: 1px solid #f0c36d; border-radius: 4px; padding: 1px 6px; font-size: 11px; margin-left: 6px; }
.link-n { display: inline-block; margin-left: 8px; font-size: 11px; color: var(--accent); background: #ddf4ff; border-radius: 4px; padding: 1px 6px; }
/* finesse · component: column-config-modal · register=product
 * states: default · hover · focus-visible · active · disabled · selected
 * tokens: 沿用项目主色 var(--accent)；圆角层级 18 / 12 / 10，弃用 999px 药丸 */
.col-cfg-btn { white-space: nowrap; }

/* 弹窗：分区式（头 / 体 / 脚），不是一整块内容堆 */
.colcfg { padding: 0; border-radius: 18px; overflow: hidden; max-width: 780px; width: 96vw; }

.colcfg-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid rgba(0, 0, 0, .06);
}
.colcfg-title { flex: 1; min-width: 0; }
.colcfg-title h3 { margin: 0; font-size: 16px; letter-spacing: -.01em; color: var(--text); }
.colcfg-sub { margin: 4px 0 0; font-size: 12px; color: #6b7078; }
.colcfg-x {
  border: none; background: none; color: #8b9096; cursor: pointer;
  font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 8px;
  transition: background .12s, color .12s;
}
@media (hover: hover) { .colcfg-x:hover { background: rgba(0, 0, 0, .05); color: var(--text); } }
.colcfg-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.colcfg-body { padding: 16px 20px 18px; max-height: 60vh; overflow: auto; }
.colcfg-sec + .colcfg-sec { margin-top: 18px; }
.colcfg-sec-h {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 8px;
}
.colcfg-sec-h > span:first-child { font-size: 12px; font-weight: 600; color: var(--text-2); }
.colcfg-hint { font-size: 11px; color: #8b9096; font-variant-numeric: tabular-nums; }

/* 可选字段：宽屏三列 / 中屏两列 / 窄屏单列，一屏看完不用滑动 */
.colcfg-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
@media (max-width: 760px) { .colcfg-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .colcfg-grid { grid-template-columns: minmax(0, 1fr); } }

.colcfg-field {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 11px; min-height: 44px;
  border: 1px solid rgba(0, 0, 0, .08); border-radius: 12px;
  background: var(--surface); color: var(--text-2); font-size: 13px; text-align: left;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s, transform .08s;
  outline: 2px solid transparent; outline-offset: 1px;
}
@media (hover: hover) {
  .colcfg-field:hover { border-color: rgba(9, 105, 218, .45); background: #f7fafd; }
}
.colcfg-field:focus-visible { outline-color: var(--accent); }
.colcfg-field:active { transform: translateY(1px); }
.colcfg-field.on {
  background: rgba(9, 105, 218, .07);
  border-color: rgba(9, 105, 218, .5);
  color: #0550ae;
}
.colcfg-check {
  flex: none; width: 16px; height: 16px; border-radius: 5px;
  border: 1px solid rgba(0, 0, 0, .16); background: var(--surface);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; color: #fff;
  transition: background .12s, border-color .12s;
}
.colcfg-field.on .colcfg-check { background: var(--accent); border-color: var(--accent); }
.colcfg-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.colcfg-key { flex: none; font-size: 10.5px; color: #9aa0a6; font-family: ui-monospace, monospace; }

/* 显示顺序 */
.colcfg-order { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.colcfg-order li {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; min-height: 40px;
  background: var(--surface-2); border: 1px solid rgba(0, 0, 0, .05);
  border-radius: 10px; font-size: 12.5px; color: var(--text);
}
.colcfg-idx {
  flex: none; width: 18px; height: 18px; border-radius: 6px;
  background: rgba(9, 105, 218, .1); color: #0550ae;
  font-size: 11px; font-variant-numeric: tabular-nums;
  display: inline-flex; align-items: center; justify-content: center;
}
.colcfg-oname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.colcfg-mv { flex: none; display: flex; gap: 4px; }
.colcfg-mv button {
  border: 1px solid rgba(0, 0, 0, .1); background: var(--surface); border-radius: 7px;
  padding: 2px 8px; cursor: pointer; font-size: 12px; color: var(--text-2);
  transition: background .12s, border-color .12s;
}
@media (hover: hover) { .colcfg-mv button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); } }
.colcfg-mv button:disabled { opacity: .45; cursor: not-allowed; }
.colcfg-mv button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.colcfg-empty { margin: 6px 0 0; font-size: 12px; color: #8b9096; }

/* 底部操作栏 */
.colcfg-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 14px 20px; border-top: 1px solid rgba(0, 0, 0, .06); background: var(--surface-3);
}
/* 按钮收窄：水平内边距 16→11，最小高 40→36，字号 13→12.5 */
.colcfg-btn {
  border: 1px solid rgba(0, 0, 0, .1); background: var(--surface); color: var(--text-2);
  border-radius: 10px; padding: 7px 11px; min-height: 36px;
  cursor: pointer; font-size: 12.5px; white-space: nowrap;
  transition: background .12s, border-color .12s, transform .08s;
  outline: 2px solid transparent; outline-offset: 1px;
}
@media (hover: hover) { .colcfg-btn:hover { border-color: var(--accent); color: var(--accent); } }
.colcfg-btn:focus-visible { outline-color: var(--accent); }
.colcfg-btn:active { transform: translateY(1px); }
.colcfg-btn.primary {
  background: #1d1d1f; border-color: rgba(0, 0, 0, .08); color: #fff; font-weight: 500;
  box-shadow: 0 1px 2px rgba(31, 136, 61, .28);
}
@media (hover: hover) { .colcfg-btn.primary:hover { background: #000; color: #fff; } }
@media (prefers-reduced-motion: reduce) {
  .colcfg-field, .colcfg-btn, .colcfg-x, .colcfg-mv button { transition: none; }
  .colcfg-field:active, .colcfg-btn:active { transform: none; }
}

/* 平台账号认证标记 */
.cert-tag { display: inline-block; margin-left: 6px; font-size: 11px; color: #8250df; background: #fbefff; border: 1px solid #e2c7ff; border-radius: 4px; padding: 1px 6px; }
.full { grid-column: 1 / -1; font-weight: 600; color: var(--text-2); border-top: 1px dashed #e5e7eb; padding-top: 6px; }
.full-row { grid-column: 1 / -1; }
.link-editor { display: flex; flex-direction: column; gap: 8px; }
.link-list { list-style: none; margin: 0; padding: 0; }
.link-list li {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 8px; background: var(--surface-2); border-radius: 6px; margin-bottom: 4px; font-size: 13px;
}
.link-rm { margin-left: auto; border: none; background: none; color: #cf222e; cursor: pointer; font-size: 12px; }
.link-add { display: flex; flex-wrap: wrap; gap: 6px; }
.link-add select { flex: 1; min-width: 140px; }
.link-add button { border: 1px solid var(--accent); background: #ddf4ff; color: var(--accent); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
.link-add button:disabled { opacity: 0.5; cursor: default; }
.rel-block { margin: 12px 0; padding: 10px 12px; background: var(--surface-2); border-radius: 8px; border: 1px solid var(--border); }
.rel-block h4 { margin: 0 0 8px; font-size: 13px; }
.imp-box { max-width: 720px; }
.imp-pick { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.imp-pick input[type='file'] { display: none; }
.imp-fmt { font-size: 12px; color: var(--text-3); }
.imp-text { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; }
.imp-actions { display: flex; align-items: center; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
.imp-mode { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-2); }
.imp-err { margin: 4px 0; font-size: 12.5px; color: var(--warn); }
.imp-ok { margin: 4px 0; font-size: 12.5px; color: var(--accent); }
.imp-list { max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.imp-row { display: grid; grid-template-columns: 1.4fr 1fr 1fr 60px 60px; gap: 8px; align-items: center; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid var(--border); }
.imp-row:last-child { border-bottom: 0; }
.imp-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-site, .imp-user { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-mark { color: var(--text-3); }
.imp-dup { color: var(--warn); }
.ver-item { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; }
.ver-head { display: flex; gap: 6px; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-2); }
.ver-src { color: var(--accent); }
.ver-changed { margin: 2px 0 4px; font-size: 11.5px; color: var(--text-3); word-break: break-all; }
.ver-btn { padding: 1px 8px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--accent); border-radius: 6px; font-size: 11.5px; cursor: pointer; }
.ver-btn:hover { border-color: var(--accent); }
.rel-group { margin-bottom: 8px; }
.rel-cap { font-size: 11px; color: var(--text-3); margin-bottom: 4px; }
.rel-chip {
  display: inline-flex; align-items: center; gap: 6px; margin: 0 6px 6px 0;
  border: 1px solid var(--border-strong); background: var(--surface); border-radius: 999px;
  padding: 4px 10px; cursor: pointer; font-size: 12px;
}
.rel-chip.missing { opacity: 0.6; cursor: default; text-decoration: line-through; }
.rel-type { color: var(--text-3); font-size: 11px; }
.ops button { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 5px; padding: 3px 8px; margin-right: 4px; cursor: pointer; font-size: 12px; }
.ops button.del { color: #cf222e; border-color: #f0c4c4; }
.empty { color: var(--text-3); margin-top: 48px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.empty p { margin: 0; }
.modal {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
  display: flex; align-items: center; justify-content: center;
  padding: 16px; box-sizing: border-box;
}

/* ===== 模板化弹窗（黑曜）：右侧滑出，与抽屉同一套 token =====
   弹窗渲染在根节点，拿不到 [data-mgui] 的变量，所以弹窗自己挂 data-mgui；
   旧样式用的是 --surface/--border 这套名字，这里做一次变量桥接，
   表单里几十处 var(--surface) 就不用逐个改。 */
[data-mgui].modal.mg-modal {
  --surface: var(--panel);
  --surface-2: var(--bg);
  --surface-3: var(--hover);
  --border: var(--line);
  --border-strong: var(--line-2);
  --chip-bg: var(--hover);
  z-index: var(--z-modal);
  background: var(--scrim-bg);
  align-items: stretch;
  justify-content: flex-end;
  /* 让出左侧导航栏，弹窗从主区开始，而不是压在侧栏上 */
  padding: 0 0 0 var(--mg-side, var(--side-w, 212px));
}
@media (max-width: 1180px) {
  [data-mgui].modal.mg-modal { --mg-side: var(--side-wx, 62px); }
}
[data-mgui].modal.mg-modal .box,
[data-mgui].modal.mg-modal .box-wide {
  background: var(--panel);
  color: var(--text);
  border-left: 1px solid var(--line-2);
  border-radius: 0;
  box-shadow: none;
  width: min(560px, 100vw);
  max-width: none;
  height: 100%;
  max-height: none;
  padding: 20px 22px;
  overflow: auto;
  animation: mg-panel-in .22s cubic-bezier(.2, .8, .2, 1);
}
/* 编辑已有资产：直接覆盖右侧抽屉，视觉上就是「抽屉变宽、切换成编辑态」，
   不再弹出一个和抽屉并排的面板 */
[data-mgui].modal.mg-modal.mg-panel {
  padding-right: 0;
}
[data-mgui].modal.mg-modal.mg-panel .box,
[data-mgui].modal.mg-modal.mg-panel .box-wide {
  /* 大屏 880，小屏不超过「窗口宽 - 侧栏」，不会压到左边内容或溢出 */
  width: min(880px, calc(100vw - var(--mg-side, var(--side-w, 212px))));
  border-left: 1px solid var(--line-2);
  border-right: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
[data-mgui].modal.mg-modal.mg-panel .box > .split {
  flex: 1;
  min-height: 0;
}
/* 编辑面板右上角的 ×：和抽屉 .d-x 同一套（无框悬浮，悬停浅底） */
[data-mgui].modal.mg-modal .mg-x {
  flex: none;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
[data-mgui].modal.mg-modal .mg-x:hover {
  background: var(--hover);
  color: var(--text);
}
/* 底部动作按钮与抽屉 .act / .btn.primary 完全同一套度量与配色 */
[data-mgui].modal.mg-modal .form-actions button {
  height: 32px;
  padding: 0 13px;
  border-radius: var(--r-sm);
  font-size: var(--f-xs);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: var(--ctl-border);
  background: var(--act-bg);
  color: var(--text-2);
  cursor: pointer;
}
[data-mgui].modal.mg-modal .form-actions button:hover {
  color: var(--accent);
  border-color: var(--accent);
}
[data-mgui].modal.mg-modal .form-actions .primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  box-shadow: var(--accent-btn-shadow);
}
[data-mgui].modal.mg-modal .form-actions .primary:hover {
  color: var(--accent-ink);
  border-color: var(--accent);
  filter: brightness(1.06);
}
/* 头部「类型」标签与抽屉 d-id 同一语言：mono 全大写小字 */
[data-mgui].modal.mg-modal .ftype.inline {
  font-family: var(--font-mono);
  font-size: var(--f-xxs);
  letter-spacing: var(--ls-caps);
  text-transform: var(--tt-caps);
  color: var(--text-3);
}
/* 侧栏分组标题与抽屉 .d-sec .h 同一语言：mono 全大写小节头 */
[data-mgui].modal.mg-modal .side-block h4 {
  font-family: var(--font-mono);
  font-size: var(--f-xxs);
  letter-spacing: var(--ls-caps);
  text-transform: var(--tt-caps);
  color: var(--text-3);
  font-weight: 500;
  margin: 0 0 var(--s-3);
}
/* 列配置这类宽内容：居中卡片 */
[data-mgui].modal.mg-modal.mg-center {
  align-items: center;
  justify-content: center;
  padding: 20px;
}
[data-mgui].modal.mg-modal.mg-center .box {
  height: auto;
  max-height: 88vh;
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-pop);
  animation: mg-fade-in .18s ease-out;
}
[data-mgui].modal.mg-modal.mg-center .box-wide {
  width: min(1000px, 94vw);
}
@keyframes mg-panel-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes mg-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
/* 表单控件统一到模板 token（旧样式特异性较高，这里用 !important 压住） */
[data-mgui].modal.mg-modal input,
[data-mgui].modal.mg-modal select,
[data-mgui].modal.mg-modal textarea {
  background: var(--bg) !important;
  border: 1px solid var(--line-2) !important;
  color: var(--text) !important;
  border-radius: var(--r-sm) !important;
}
[data-mgui].modal.mg-modal input::placeholder,
[data-mgui].modal.mg-modal textarea::placeholder {
  color: var(--text-3) !important;
}
/* 勾选框跟主题强调色一致，别用浏览器默认蓝 */
[data-mgui].modal.mg-modal input[type='checkbox'],
[data-mgui].modal.mg-modal input[type='radio'] {
  accent-color: var(--accent);
  background: var(--bg) !important;
}

/* ===== 列配置弹窗：左「可选字段」右「显示列」，不再是一个竖着堆的表单 ===== */
[data-mgui].modal.mg-modal .box.colcfg2 {
  width: min(760px, 94vw);
  height: auto;
  max-height: 82vh;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
}
.cc-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--line);
}
.cc-head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text);
}
.cc-head p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.cc-x {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 16px;
  line-height: 1;
}
.cc-x:hover {
  background: var(--hover);
  color: var(--text);
}
.cc-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 268px;
}
.cc-pool {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
}
.cc-picked {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.cc-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 8px;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.cc-h em {
  margin-left: auto;
  font-style: normal;
  font-family: var(--font-mono);
  color: var(--accent);
}
.cc-search {
  margin-left: auto;
  width: 150px;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}
.cc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 14px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  align-content: start;
}
.cc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  text-align: left;
  overflow: hidden;
}
.cc-item:hover {
  background: var(--hover);
  color: var(--text);
}
.cc-item.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.cc-ck {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  display: grid;
  place-items: center;
  font-size: 10px;
  font-style: normal;
}
.cc-item.on .cc-ck {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}
.cc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cc-picked ul {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0 10px 12px;
}
.cc-picked li {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--text-2);
}
.cc-idx {
  width: 16px;
  flex: none;
  font-style: normal;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
}
.cc-mv {
  margin-left: auto;
  display: flex;
  gap: 2px;
  font-weight: 400;
}
.cc-mv button {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1;
}
.cc-mv button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.cc-mv button:disabled {
  opacity: 0.3;
}
.cc-mv .cc-rm:hover {
  color: var(--danger);
}
.cc-none {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-3);
}
.cc-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
}
.cc-sp {
  flex: 1;
}
.cc-count {
  font-size: 11.5px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.cc-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
}
.cc-btn:hover {
  color: var(--text);
  border-color: var(--line-2-strong);
}
.cc-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
/* 模型用量：列没有顺序概念，单栏勾选就够 */
[data-mgui].modal.mg-modal .box.cc-pick {
  width: min(480px, 94vw);
}
.cc-pick-body {
  padding: 10px 16px 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
}
[data-mgui].modal.mg-modal .box-head {
  border-bottom: 1px solid var(--line);
  padding-bottom: 12px;
}
[data-mgui].modal.mg-modal .box-head h3 {
  color: var(--text);
  /* 与抽屉 d-title 同一字体语言：display 字体 + 标题字距，两套面板看起来是一家人 */
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: var(--w-title);
  letter-spacing: var(--ls-title);
}
[data-mgui].modal.mg-modal .primary {
  background: var(--accent) !important;
  border-color: var(--accent) !important;
  color: var(--accent-ink) !important;
  font-weight: 600;
}
[data-mgui].modal.mg-modal .secondary,
[data-mgui].modal.mg-modal .btn {
  background: transparent;
  border: 1px solid var(--line-2);
  color: var(--text-2);
}
/* 表单里的文字：标签和占位符在深色底上必须能看清（原来用 --text-3 太暗） */
[data-mgui].modal.mg-modal .flabel {
  color: var(--text-2) !important;
  font-size: 12.5px;
  letter-spacing: 0.01em;
}
[data-mgui].modal.mg-modal .sub {
  color: var(--text-3) !important;
}
[data-mgui].modal.mg-modal .fhint {
  color: #7c828b !important;
}
[data-mgui].modal.mg-modal input::placeholder,
[data-mgui].modal.mg-modal textarea::placeholder {
  color: #6f7681 !important;
}
[data-mgui].modal.mg-modal .box {
  scroll-behavior: smooth;
}
.box {
  background: var(--surface); border-radius: 12px; padding: 18px 20px;
  width: 560px; max-width: 96vw; max-height: 90vh; overflow: auto;
  box-shadow: 0 10px 40px rgba(0,0,0,.2);
}
.box-wide {
  width: min(1100px, 96vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.box-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap; margin-bottom: 12px; flex-shrink: 0;
}
.box-head h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 17px; }
.box-head-actions { display: flex; gap: 8px; align-items: center; }
.split {
  display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.9fr);
  gap: 16px; min-height: 0; flex: 1; overflow: hidden;
}
.split-main, .split-side { min-height: 0; overflow: auto; }
.split-side {
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px;
}
.split-side h4 { margin: 0 0 8px; font-size: 13px; color: #1f2328; }
.side-block { margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px dashed #d0d7de; }

/* 弹窗内「这个类型的字段」：列表 + 一行内联新增 */
.qf-list { list-style: none; margin: 6px 0 8px; padding: 0; }
.qf-list li { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12.5px; }
.qf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qf-kind { flex: 0 0 auto; font-size: 11px; color: var(--text-3); background: var(--surface-2); border-radius: 4px; padding: 1px 5px; }
.qf-list .link-rm { margin-left: 0; }
.qf-add { display: flex; gap: 6px; align-items: center; }
.qf-add input { flex: 1 1 auto; min-width: 0; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font-size: 12.5px; }
.qf-add select { flex: 0 0 auto; padding: 6px 6px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font-size: 12px; }
.qf-add button { flex: 0 0 auto; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 12.5px; cursor: pointer; }
.qf-add button:disabled { opacity: .5; cursor: default; }
.qf-empty { margin: 4px 0 8px; }
.qf-msg { color: #1a7f37; }
.side-block:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
.side-empty { color: var(--text-3); font-size: 12px; margin: 0; }
.note-field textarea {
  width: 100%; box-sizing: border-box; min-height: 64px; max-height: 160px;
  padding: 6px 8px; border: 1px solid var(--border-strong); border-radius: 6px;
  font-size: 12px; font-family: inherit; resize: vertical; line-height: 1.45;
  background: var(--surface);
}
.link-add.col { flex-direction: column; gap: 8px; }
.link-add.col select, .link-add.col button { width: 100%; }
.link-pick-label {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 12px; color: var(--text-2);
}
.link-pick-label select { margin-top: 0; }
.rot-label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; font-size: 12px; color: var(--text-2); }
.form-actions.bar {
  flex-shrink: 0; margin-top: 14px; padding-top: 12px;
  border-top: 1px solid var(--border); justify-content: flex-end;
}
.ftype.inline { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; }
.ftype.inline select { margin: 0; }
@media (max-width: 860px) {
  /* 以下响应式规则为经典壳设计：新版壳（.mgui-sidebar）有自己的折叠机制，
     不得命中——否则窄窗口下新版侧栏占满整行、主区被挤到视口外（2026-11-20 w800 探查确认） */
  .app:not(:has(.mgui-sidebar)) { grid-template-columns: minmax(0, 1fr); }
  .app:not(:has(.mgui-sidebar)) .side { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); flex-direction: row; flex-wrap: wrap; align-items: center; }
  .app:not(:has(.mgui-sidebar)) .side-nav { flex-direction: row; flex-wrap: wrap; }
  .app:not(:has(.mgui-sidebar)) .side-group { display: none; }
  .app:not(:has(.mgui-sidebar)) .side-foot { margin: 0 0 0 auto; }
  .split { grid-template-columns: 1fr; }
  .box-wide { max-height: 92vh; overflow: auto; }
}
.kv th { text-align: right; color: var(--text-2); width: 140px; vertical-align: top; padding-top: 10px; }
.kv td.secret { color: #cf222e; font-family: monospace; word-break: break-all; }
.kv td { word-break: break-all; }
.kv-val { margin-right: 6px; }
.copy-btn { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); border-radius: 5px; padding: 1px 7px; font-size: 11px; cursor: pointer; vertical-align: middle; white-space: nowrap; }
.copy-btn:hover { background: var(--surface-2); color: var(--accent); border-color: var(--accent); }
.copy-btn.done { background: #dafbe1; color: #1a7f37; border-color: #1a7f37; }

/* ===== 白名单页面 ===== */
.wl-ip-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wl-cap { font-size: 12px; color: var(--text-2); font-weight: 600; }
.wl-none { font-size: 12px; color: var(--text-3); }
.wl-ip-bar button { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.wl-off { background: var(--surface-2); color: var(--text-3); border: 1px solid var(--border-strong); border-radius: 4px; padding: 1px 6px; font-size: 11px; margin-left: 4px; }
.wlok { color: #1a7f37; }
.wlfail { color: #cf222e; }
.wl-msg { display: block; font-size: 11px; color: var(--text-3); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.wl-h4 { margin: 22px 0 0; font-size: 14px; color: #1f2328; }
.wl-check { display: flex; flex-direction: row; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.wl-check input { margin: 0; width: auto; }
.wl-sched {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 10px 0 0; padding: 10px 12px;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
}
.wl-sched select { padding: 4px 8px; border: 1px solid var(--border-strong); border-radius: 6px; font-size: 13px; background: var(--surface); }
.wl-tip { font-size: 12px; color: var(--text-3); margin: 6px 0 0; line-height: 1.6; }
.wl-tip code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: 11px; border: 1px solid var(--border); }
/* 地域 / 白名单目标的下拉拉取状态 */
.wl-opt { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; margin-top: -2px; }
.wl-opt button {
  border: 1px solid var(--border-strong); background: var(--surface);
  border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.wl-opt-tip { color: var(--text-3); line-height: 1.6; }
.wl-opt-err { color: #cf222e; line-height: 1.6; }
[data-theme='dark'] .wl-opt-err { color: #ff9d95; }
/* 弹窗里的原理说明：解释「为什么不用填安全组」 */
.wl-form-note {
  margin: 6px 0 0; font-size: 12px; line-height: 1.7; color: var(--text-3);
  background: var(--surface-2); border-radius: 8px; padding: 8px 12px;
}
.wl-form-note strong { color: var(--text-2); }

/* ===== 备忘录 ===== */
.memo-list { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.memo-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.memo-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.memo-head strong { font-size: 14px; color: #1f2328; }
.memo-ops { margin-left: auto; display: flex; gap: 6px; }
.memo-ops button { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 5px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
.memo-ops button.del { color: #cf222e; border-color: #f0c4c4; }
.memo-body {
  margin: 8px 0 0; padding: 10px 12px; background: var(--surface-2); border-radius: 8px;
  font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.7;
  color: var(--text); white-space: pre-wrap; word-break: break-all; max-height: 420px; overflow: auto;
}
.secret-toggle { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 5px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.close { border: 1px solid var(--border-strong); background: var(--surface); border-radius: 6px; padding: 6px 14px; cursor: pointer; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-content: start; }
.port-tag { color: var(--text-2); font-size: 12px; margin-left: 2px; }
/* 平台/网站：下拉与「自定义」输入框并排一行；短下拉不再铺满整列 */
.combo-row { display: flex; gap: 6px; align-items: center; margin-top: 3px; }
.combo-row select { flex: 0 1 46%; min-width: 104px; margin-top: 0; }
.combo-row input { flex: 1 1 54%; min-width: 104px; margin-top: 0; }
.catalog-custom { margin-top: 0; }
.form-grid label.span-2 { grid-column: span 2; }
.form-grid select.narrow-select { max-width: 150px; }
/* 项目入口块：整行铺开，两列入力 */
.proj-urls { grid-column: 1 / -1; border-top: 1px dashed var(--border, #ddd); padding-top: 10px; margin-top: 2px; }
.proj-url-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; margin-top: 8px; }
.proj-url-grid label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.proj-url-grid input { margin-top: 0; }
/* 项目里程碑：名称 / 日期 / 完成 / 删除 */
.proj-ms { grid-column: 1 / -1; border-top: 1px dashed var(--border, #ddd); padding-top: 10px; margin-top: 2px; }
.ms-row { display: grid; grid-template-columns: minmax(0, 1fr) 150px 66px 28px; gap: 8px; align-items: center; margin-top: 8px; }
.ms-row input[type='date'] { margin-top: 0; }
.ms-done { display: flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; }
.ms-done input { margin: 0; }
.ms-del { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: none; cursor: pointer; line-height: 1; }
.ms-add { margin-top: 10px; font-size: 12px; padding: 5px 12px; border-radius: 6px; border: 1px dashed var(--border, #bbb); background: none; cursor: pointer; }
.ftype { display: block; margin-bottom: 6px; font-size: 13px; }
.ftype select { margin-left: 8px; }
label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-2); }
label.with-hint { grid-column: 1 / -1; }
.flabel { font-weight: 500; color: #1f2328; }
.fhint { font-size: 11px; color: var(--text-3); line-height: 1.45; margin: 2px 0 4px; }
input, select { margin-top: 3px; padding: 6px 8px; border: 1px solid var(--border-strong); border-radius: 6px; font-size: 13px; }
.secret-input { display: flex; gap: 6px; margin-top: 3px; align-items: stretch; }
.secret-input.col { flex-direction: column; }
.secret-input input, .secret-input textarea { flex: 1; margin-top: 0; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.secret-input textarea.masked { -webkit-text-security: disc; text-security: disc; }
.secret-input .eye {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  align-self: flex-start;
}
.upload-box {
  border: 1px dashed #c9d1d9;
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--surface-2);
  margin-top: 4px;
}
.upload-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.file-btn {
  display: inline-flex; align-items: center;
  background: #1f883d; color: #fff; border-radius: 8px; padding: 8px 12px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.file-btn.ghost { background: var(--surface); color: var(--accent); border: 1px solid var(--accent); font-weight: 500; }
.file-btn input { display: none; }
.upload-msg { margin: 8px 0 0; font-size: 12px; color: #1f883d; line-height: 1.5; }
.form-actions { margin-top: 14px; display: flex; gap: 8px; }
.mono { font-family: monospace; }
.small { font-size: 11px; color: var(--text-2); }
.tag.act { background: #fff0f6; color: #bf3989; border: 1px solid #f7c0dd; }
td.actdesc { color: #1f2328; font-weight: 500; }
/* ===== 锁屏（打开客户端第一屏）===== */
.unlock { position: fixed; inset: 0; background: radial-gradient(1200px 800px at 20% -10%, #1c2733, #0d1117 60%), #0d1117; display: flex; align-items: center; justify-content: center; z-index: var(--z-unlock); }
.unlock-box { width: 360px; background: rgba(255, 255, 255, .04); border: 1px solid rgba(255, 255, 255, .1); border-radius: 16px; padding: 34px 30px 22px; text-align: center; box-shadow: 0 24px 64px rgba(0, 0, 0, .5); backdrop-filter: blur(8px); }
.unlock-brand { font-size: 34px; }
.unlock-box h2 { margin: 10px 0 4px; color: #f6f8fa; font-size: 20px; letter-spacing: .08em; }
.unlock-sub { margin: 0 0 22px; font-size: 12px; color: #8b949e; line-height: 1.6; }
.unlock-field { position: relative; margin-bottom: 12px; }
.unlock-field input { width: 100%; box-sizing: border-box; padding: 11px 58px 11px 14px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .06); color: #f6f8fa; font-size: 14px; outline: none; transition: border-color .15s, box-shadow .15s; }
.unlock-field input:focus { border-color: #2f81f7; box-shadow: 0 0 0 3px rgba(47, 129, 247, .25); }
.unlock-sk {
  margin-top: 10px;
}
.unlock-remember {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.85;
  cursor: pointer;
}
.unlock-sk .unlock-sub {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.75;
  line-height: 1.5;
}
.unlock-eye { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: none; background: none; color: #8b949e; font-size: 12px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
.unlock-eye:hover { color: #f6f8fa; }
.unlock-btn { width: 100%; padding: 11px 0; border-radius: 10px; border: none; background: linear-gradient(135deg, #2f81f7, #1f6feb); color: #fff; font-size: 14.5px; font-weight: 650; letter-spacing: .3em; text-indent: .3em; cursor: pointer; transition: filter .15s; }
.unlock-btn:hover:not(:disabled) { filter: brightness(1.12); }
.unlock-btn:disabled { opacity: .6; cursor: default; }
.unlock-foot { margin: 18px 0 0; font-size: 11px; color: #6e7681; }
.unlock .err { margin: 10px 0 0; color: #ff7b72; font-size: 12.5px; animation: unlock-shake .3s; }
@keyframes unlock-shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
.clip-toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%); background: #1f2328; color: #f6f8fa; padding: 9px 16px; border-radius: 8px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.35); z-index: var(--z-toast); }
.lock-fab {
  position: fixed; right: 26px; bottom: 26px; width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: var(--surface); font-size: 17px; line-height: 1;
  cursor: pointer; z-index: 950; box-shadow: 0 8px 24px rgba(0,0,0,.25);
  display: flex; align-items: center; justify-content: center;
}
.lock-fab:hover { border-color: #cf222e; box-shadow: 0 8px 24px rgba(207,34,46,.3); }

/* ===== 资产管家（自写 AI 助手页）===== */
/* 抽屉收起时向左移出内容区，必须在水平方向裁剪，否则会盖住左侧 sticky 导航 */
.ai-page { position: relative; display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0; overflow-x: clip; }
/* 顶部工具条：不透明背景 + 高于消息区，消息滚上来只会被这一行挡住 */
.ai-topbar {
  flex: 0 0 44px; box-sizing: border-box; display: flex; align-items: center; gap: 10px;
  padding: 0 14px; border-bottom: 1px solid var(--border);
  background: var(--surface); position: relative; z-index: 4;
}
.ai-topbar-title { font-size: 12.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-topbar-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.ai-topbar-btn {
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2);
  border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.ai-topbar-btn:hover { border-color: var(--accent); color: var(--accent); }
.ai-sess-fab {
  flex: 0 0 auto; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--text-2); font-size: 14px; cursor: pointer;
}
.ai-sess-fab:hover { border-color: var(--accent); color: var(--accent); }
.ai-sess-hd { display: flex; align-items: center; gap: 4px; padding: 0 4px 10px; }
.ai-sess-hd .t { flex: 1; font-size: 11px; color: var(--text-3); letter-spacing: .05em; }
.ai-hd-btn { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); font-size: 13px; cursor: pointer; line-height: 1; }
.ai-hd-btn:hover { border-color: var(--accent); color: var(--accent); }
.ai-backdrop { position: absolute; inset: 0; z-index: 5; }
.ai-sess-drawer {
  position: absolute; left: 0; top: 0; bottom: 0; width: 250px; z-index: 6; pointer-events: none;
  background: var(--surface); border-right: 1px solid var(--border-strong);
  box-shadow: 8px 0 24px rgba(0,0,0,.15); padding: 14px 8px; overflow-y: auto;
  /* 收起后彻底隐藏：动画结束再切 hidden，避免残留绘制及隐藏按钮被键盘聚焦 */
  visibility: hidden; transform: translateX(-105%);
  transition: transform .18s ease-out, visibility 0s linear .18s;
}
.ai-sess-drawer.open {
  transform: none; pointer-events: auto; visibility: visible;
  transition: transform .18s ease-out, visibility 0s;
}
[data-theme='dark'] .ai-sess-drawer { box-shadow: 8px 0 24px rgba(0,0,0,.5); }
.ai-sess-h { font-size: 11px; color: var(--text-3); letter-spacing: .05em; padding: 0 10px 8px; }
.ai-sess-item { display: flex; justify-content: space-between; align-items: center; gap: 6px; width: 100%; text-align: left; border: 0; background: none; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
.ai-sess-item:hover { background: var(--surface-2); color: var(--text); }
.ai-sess-item.on { background: var(--surface-2); color: var(--text); font-weight: 650; }
.ai-sess-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-sess-x { color: var(--text-3); padding: 0 4px; border-radius: 4px; }
.ai-sess-x:hover { color: var(--danger, #d64545); }
.ai-sess-empty { font-size: 12px; color: var(--text-3); padding: 4px 10px; }

/* 中间内容整体垂直居中并略偏下，不再全部堆在窗口顶部 */
.ai-landing { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 72px 24px 24px; }
.ai-greet { font-size: 26px; font-weight: 700; margin: 0 0 8px; }
.ai-greet-sub { margin: 0 0 24px; font-size: 12.5px; color: var(--text-3); }
.ai-skill-tabs { display: flex; gap: 4px; background: var(--surface-2); border-radius: 999px; padding: 3px; }
.ai-skill-tabs button { border: 0; background: none; padding: 6px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.ai-skill-tabs button.on { background: var(--surface); color: var(--text); font-weight: 650; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
[data-theme='dark'] .ai-skill-tabs button.on { box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.ai-chips { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin: 18px 0 26px; min-height: 32px; }
.ai-chips button { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); border-radius: 999px; padding: 7px 18px; font-size: 13px; cursor: pointer; }
.ai-chips button:hover { border-color: var(--accent); color: var(--accent); }
.ai-big-composer {
  width: min(680px, 100%); border: 1px solid var(--border-strong); border-radius: 16px;
  position: relative;
  background: var(--surface); padding: 12px 14px 10px; box-sizing: border-box;
  box-shadow: 0 8px 28px rgba(0,0,0,.07); position: relative;
}
[data-theme='dark'] .ai-big-composer { box-shadow: 0 8px 28px rgba(0,0,0,.35); }
.ai-big-composer textarea { width: 100%; box-sizing: border-box; border: 0; outline: none; resize: none; overflow-y: auto; max-height: 140px; background: none; color: var(--text); font-size: 14px; line-height: 1.6; font-family: inherit; }
.ai-bc-foot { display: flex; align-items: center; gap: 10px; padding-top: 6px; }
.ai-plus { color: var(--text-3); font-size: 17px; }
.ai-model-pill { border: 1px solid var(--border); background: none; color: var(--text-2); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.ai-model-pill:hover { border-color: var(--accent); color: var(--accent); }
.ai-send-circle { width: 32px; height: 32px; border-radius: 50%; border: 0; background: #1d1d1f; color: #fff; font-size: 15px; cursor: pointer; }
[data-theme='dark'] .ai-send-circle { background: #f5f5f7; color: #111; }
.ai-model-pop {
  position: absolute; right: 10px; bottom: 52px; width: 260px; z-index: 9;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,.2); padding: 6px; text-align: left;
}
[data-theme='dark'] .ai-model-pop { box-shadow: 0 12px 32px rgba(0,0,0,.5); }
.ai-model-backdrop { position: fixed; inset: 0; z-index: 8; }
.ai-model-item { display: flex; justify-content: space-between; gap: 10px; width: 100%; border: 0; background: none; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
.ai-model-item:hover { background: var(--surface-2); }
.ai-model-m { color: var(--text-3); font-size: 11.5px; font-family: ui-monospace, monospace; }
.ai-hint { margin-top: 16px; font-size: 11.5px; color: var(--text-3); }

/* 对话页锁定在视口内：消息区内部滚动、输入框常驻底部，不再产生整页右侧滚动条 */
.ai-chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ai-thread { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 22px 12px; display: flex; flex-direction: column; gap: 14px; }
.ai-msg { display: flex; }
.ai-msg.user { justify-content: flex-end; }
.ai-bubble-u { max-width: 70%; background: #1d1d1f; color: #fff; padding: 8px 13px; border-radius: 12px 12px 3px 12px; font-size: 13.5px; line-height: 1.55; }
[data-theme='dark'] .ai-bubble-u { background: #f5f5f7; color: #111; }
.ai-msg.ai { flex-direction: column; gap: 8px; max-width: 86%; }
.ai-plain { font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; }
.ai-typing { color: var(--text-3); }
.ai-tool-card { border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); overflow: hidden; }
.ai-tool-card.warn { border-color: var(--danger, #d64545); }
.ai-tc-head { padding: 7px 12px; font-size: 12.5px; font-weight: 650; border-bottom: 1px solid var(--border); }
.ai-tool-card.ok .ai-tc-head { color: #1d7a4f; }
[data-theme='dark'] .ai-tool-card.ok .ai-tc-head { color: #62e08c; }
.ai-tool-card.warn .ai-tc-head { color: var(--danger, #d64545); }
.ai-tc-body { padding: 8px 12px; font-size: 12.5px; line-height: 1.7; color: var(--text-2); }
.ai-tc-ops { display: flex; gap: 8px; padding: 0 12px 10px; }
.ai-danger { border: 0; border-radius: 7px; padding: 4px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; background: var(--danger, #d64545); color: #fff; }
.ai-composer { position: relative; display: flex; gap: 8px; align-items: flex-end; padding: 10px 22px 6px; }
.ai-composer textarea { flex: 1; min-width: 0; resize: none; box-sizing: border-box; font-family: inherit; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); color: var(--text); font-size: 13.5px; padding: 10px 12px; min-height: 40px; max-height: 140px; outline: none; overflow-y: auto; }
.ai-composer-model { flex: 0 1 auto; max-width: 190px; height: 40px; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-send { flex: 0 0 auto; border: 0; border-radius: 10px; background: #1d1d1f; color: #fff; padding: 10px 18px; font-size: 13px; font-weight: 650; cursor: pointer; }
.ai-send.stopping { background: var(--danger, #d64545); color: #fff; }
.ai-retry { margin-top: 6px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.ai-retry:hover { border-color: var(--accent); color: var(--accent); }
[data-theme='dark'] .ai-send { background: #f5f5f7; color: #111; }
[data-theme='dark'] .ai-send.stopping { background: var(--danger, #d64545); color: #fff; }



/* ===== 搜索框 ===== */
.search-box { position: relative; display: flex; align-items: center; }
.search-input {
  width: 220px; padding: 6px 26px 6px 10px; border: 1px solid var(--border-strong); border-radius: 6px;
  font-size: 13px; background: var(--surface); box-sizing: border-box;
}
.search-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15); }
.search-clear {
  position: absolute; right: 4px; border: none; background: none; color: var(--text-3);
  cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px;
}
.search-clear:hover { color: #cf222e; }
.search-hint { margin: 8px 0 0; font-size: 12px; color: var(--text-2); }
.link-btn { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0 4px; text-decoration: underline; }

/* ================= 统一 UI 工艺层（覆盖式，置于末尾确保生效） =================
 * 令牌：圆角 弹窗18 / 卡片14 / 控件10 / 徽章6；边框一律发丝 rgba(0,0,0,.05–.12)
 * 颜色沿用项目既有主色 var(--accent) 与功能绿 #1f883d，不引入新色。 */

/* 弹窗：遮罩带色调（不用纯黑）；矩形圆角按 Apple 规范 ≤12px，单一柔和阴影 */
.modal { background: rgba(16, 20, 24, .42); padding: 20px; }
.box {
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, .05);
  box-shadow: rgba(0, 0, 0, .22) 3px 5px 30px 0px;
}
.box-wide { border-radius: 12px; }
.colcfg { border-radius: 12px; }

/* 弹窗头部与内容分隔 */
.box-head {
  align-items: flex-start;
  margin: 0 0 14px;
  padding: 0 0 12px;
  border-bottom: 1px solid rgba(0, 0, 0, .06);
}
.box-head h3 { font-size: 16px; letter-spacing: -.01em; color: var(--text); }

/* 表格：表头弱化、行 hover 微底、分隔发丝 */
thead th {
  font-size: 11.5px; font-weight: 600; color: #6b7078;
  background: var(--surface-3);
  border-bottom: 1px solid rgba(0, 0, 0, .09);
  white-space: nowrap;
}
th, td { padding: 9px 10px; border-bottom: 1px solid rgba(0, 0, 0, .05); }
@media (hover: hover) { tbody tr:hover { background: rgba(9, 105, 218, .035); } }

/* 筛选按钮：弃药丸 + 弃硬灰边 */
.chips button {
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, .09);
  background: var(--surface);
  padding: 5px 12px;
  font-size: 12.5px;
  color: var(--text-2);
  transition: background .12s, border-color .12s, color .12s;
}
@media (hover: hover) { .chips button:hover { border-color: rgba(9, 105, 218, .45); color: var(--accent); } }

/* 按钮：圆角与高度统一 */
button { border-radius: 10px; transition: background .12s, border-color .12s, color .12s; }
.primary {
  border-radius: 10px;
  padding: 7px 14px;
  box-shadow: 0 1px 2px rgba(31, 136, 61, .26);
}
@media (hover: hover) { .primary:hover { background: #000; } }
[data-theme='dark'] .primary:hover { background: #fff; }
.ops button {
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, .1);
  padding: 4px 9px;
  font-size: 12px;
  color: var(--text-2);
}
@media (hover: hover) { .ops button:hover { border-color: var(--accent); color: var(--accent); } }
.ops button.del { color: #cf222e; border-color: rgba(207, 34, 44, .28); }
@media (hover: hover) { .ops button.del:hover { background: rgba(207, 34, 44, .07); border-color: #cf222e; color: #cf222e; } }
nav button:focus-visible, .chips button:focus-visible, .ops button:focus-visible, .primary:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

/* 表单控件：统一高度与焦点环 */
input, select, textarea {
  border: 1px solid rgba(0, 0, 0, .12);
  border-radius: 10px;
  padding: 7px 9px;
  font-size: 13px;
  min-height: 36px;
  transition: border-color .12s, box-shadow .12s;
}
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(9, 105, 218, .16);
}

/* 徽章统一小圆角 */
.tag { border-radius: 6px; padding: 2px 8px; font-size: 11.5px; border: 1px solid transparent; }
.due { border-radius: 6px; font-size: 11px; }
.cert-tag { border-radius: 6px; }

/* 卡片 */
.split-side {
  background: var(--surface-3); border: 1px solid rgba(0, 0, 0, .06);
  border-radius: 14px; padding: 14px;
}
.memo-card {
  border: 1px solid rgba(0, 0, 0, .07);
  border-radius: 14px; padding: 14px 16px;
  box-shadow: 0 1px 3px rgba(16, 24, 40, .04);
  transition: border-color .12s, box-shadow .12s;
}
@media (hover: hover) {
  .memo-card:hover { border-color: rgba(9, 105, 218, .28); box-shadow: 0 2px 8px rgba(16, 24, 40, .06); }
}

@media (prefers-reduced-motion: reduce) {
  button, .chips button, input, select, textarea, tbody tr, .memo-card { transition: none; }
}

/* ===== 编辑表单紧凑化：控件收窄压低，尽量一页看完不出滚动条 =====
 * 短字段自动填充 ~168px 列，长字段（密钥/URL/textarea）仍由 .full-row 占整行 */
.form-grid {
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 8px 10px;
}
.form-grid input,
.form-grid select,
.form-grid textarea {
  min-height: 30px;
  padding: 5px 8px;
  font-size: 12.5px;
}
.form-grid textarea { min-height: 58px; }
.form-grid .fhint { font-size: 11px; }

/* 轮换提醒：周期天数与最近换密日期并排一行 */
.rot-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.rot-label { margin-bottom: 0; }
.rot-row input { min-height: 30px; padding: 5px 8px; font-size: 12.5px; }

/* 侧栏区块收紧，减少整弹窗高度 */
.side-block h4 { margin: 0 0 6px; font-size: 12px; }

/* ================= 模型用量页 ================= */
/* label 全局是 column（表单用）；这里勾选必须横排，否则复选框会跑到文字上方 */
.ai-pick {
  display: inline-flex; flex-direction: row; align-items: center; gap: 6px;
  margin-left: 10px; font-size: 12px; color: var(--text-2);
}
.ai-cfg > .ai-pick { margin-left: 0; }
.ai-cfg { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0 14px; font-size: 12px; color: var(--text-2); }
.ai-cfg-l { font-weight: 600; }
.ai-cfg select { width: auto; min-height: 28px; padding: 2px 8px; font-size: 12px; }
.ai-cfg button {
  border: 1px solid var(--border-strong); background: var(--surface);
  border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; color: var(--text-2);
}
.ai-cfg .ok { color: #1a7f37; }
.ai-cfg .err { color: #cf222e; }
.ai-last { color: var(--text-3); }
/* 醒目告警：接口不存在 / 权限不足等情况必须一眼看到，不能静默失败 */
.ai-alert {
  margin: 0 0 14px; padding: 10px 14px;
  background: rgba(207, 34, 44, .08);
  border: 1px solid rgba(207, 34, 44, .34);
  border-radius: 10px;
  font-size: 13px; line-height: 1.6; color: #cf222e;
}
[data-theme='dark'] .ai-alert {
  background: rgba(255, 105, 97, .14); border-color: rgba(255, 105, 97, .38); color: #ff9d95;
}
/* 借用别账号 Key 的告警：黄条，避免把别账号的额度当成本账号的 */
.ai-warn {
  margin: 0 0 14px; padding: 10px 14px;
  background: rgba(191, 135, 0, .1);
  border: 1px solid rgba(191, 135, 0, .34);
  border-radius: 10px;
  font-size: 13px; line-height: 1.6; color: #9a6700;
}
[data-theme='dark'] .ai-warn {
  background: rgba(240, 185, 66, .14); border-color: rgba(240, 185, 66, .36); color: #ffd60a;
}

.ai-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
@media (max-width: 900px) { .ai-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 620px) { .ai-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* 大模型消费为 0 = 全在免费额度内，用绿色强调这个好消息 */
.ai-kpi-zero { color: #1a7f37; }
[data-theme='dark'] .ai-kpi-zero { color: #6ede8a; }
.ai-kpi { background: var(--surface-2); border-radius: 10px; padding: 12px 14px; }
.ai-kpi-l { font-size: 12px; color: var(--text-2); margin-bottom: 4px; }
.ai-kpi-v { font-size: 22px; font-weight: 500; letter-spacing: -.02em; color: var(--text); }

.ai-subtabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.ai-subtabs button {
  border: 1px solid var(--border-strong); background: var(--surface);
  border-radius: 980px; padding: 5px 14px; cursor: pointer; font-size: 13px; color: var(--text-2);
}
.ai-subtabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }

.ai-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.ai-dot.s-available { background: #1a7f37; }
.ai-dot.s-limited { background: #bf8700; }
.ai-dot.s-unknown { background: #8b9096; }
.ai-dot.s-unavailable { background: #cf222e; }
.ai-http { margin-left: 6px; font-size: 11px; color: var(--text-3); }
.ai-verdict { font-size: 12px; padding: 1px 8px; border-radius: 6px; border: 1px solid transparent; }
.ai-verdict.ok { background: rgba(26, 127, 55, .12); color: #1a7f37; border-color: rgba(26, 127, 55, .3); }
.ai-verdict.warn { background: rgba(191, 135, 0, .14); color: #9a6700; border-color: rgba(191, 135, 0, .32); }
.ai-verdict.bad { background: rgba(207, 34, 44, .1); color: #cf222e; border-color: rgba(207, 34, 44, .3); }

.ai-ts { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.r { text-align: right; }
/* 到期倒计时：临近到期要一眼看见 */
.ai-days {
  margin-left: 6px; font-size: 11px; padding: 0 6px; border-radius: 6px;
  background: rgba(191, 135, 0, .16); color: #9a6700;
}
[data-theme='dark'] .ai-days { background: rgba(240, 185, 66, .18); color: #ffd60a; }
.ai-note { margin: 10px 0 0; font-size: 12px; line-height: 1.6; color: var(--text-3); }
.ai-h4 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; color: var(--text); }
.ai-mod-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.ai-mod-bar button {
  border: 1px solid var(--border-strong); background: var(--surface);
  border-radius: 980px; padding: 4px 12px; cursor: pointer; font-size: 12px; color: var(--text-2);
}
.ai-mod-bar button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.ai-mod-n { margin-left: 5px; font-size: 11px; opacity: .8; }
.ai-caps { font-size: 11.5px; color: var(--text-2); }
/* 可排序表头：点击切换升/降 */
.ai-th-sort { cursor: pointer; user-select: none; white-space: nowrap; }
.ai-th-sort:hover { color: var(--accent); }
.ai-bindbar { border-top: 1px solid var(--border); padding-top: 8px; margin-top: 0; }
.ai-bindbar select { max-width: 420px; }
.ai-bound { font-size: 12px; color: #1a7f37; }
[data-theme='dark'] .ai-bound { color: #6ede8a; }
/* 额度单位（接口不返回，按模型名+数量级推断，不能推断时不显示） */
.ai-unit { margin-left: 4px; font-size: 10.5px; color: var(--text-3); }
/* 「长期有效」：2099 这类哨兵日期的替代展示 */
.ai-long {
  font-size: 11px; padding: 1px 6px; border-radius: 6px;
  background: rgba(0, 113, 227, .10); color: var(--accent);
}
[data-theme='dark'] .ai-long { background: rgba(10, 132, 255, .18); color: #6cb6ff; }
/* 模型 ID 旁的复制图标：平时半透明，hover/复制后显形 */
.ai-model-cell { display: flex; align-items: center; gap: 6px; }
.ai-model-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ai-copy {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-3);
  cursor: pointer; opacity: .45;
  transition: opacity .15s, color .15s, background .15s;
}
.ai-model-cell:hover .ai-copy { opacity: 1; }
.ai-copy:hover { color: var(--accent); background: var(--surface-2); }
.ai-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; opacity: 1; }
.ai-copy.done { opacity: 1; color: #1a7f37; }
[data-theme='dark'] .ai-copy.done { color: #6ede8a; }
/* 深色下三级灰字 + 0.45 透明度几乎隐形：给足亮度和描边，让按钮一眼可辨 */
[data-theme='dark'] .ai-copy {
  opacity: .85;
  color: rgba(245, 245, 247, .8);
  background: rgba(255, 255, 255, .07);
  border-color: rgba(255, 255, 255, .18);
}
[data-theme='dark'] .ai-copy:hover { background: rgba(41, 151, 255, .18); border-color: rgba(41, 151, 255, .45); }

/* 重置规则（推断值，非接口字段） */
.ai-reset { font-size: 11.5px; white-space: nowrap; }
.ai-reset-na { color: var(--text-3); }
.ai-th-help { cursor: help; }
.ai-note-dim { color: var(--text-3); }

/* 免费额度数据来源条：取数失败 / 数据过期 / 未绑定归属，必须显式告知 */
.ai-srcbar {
  display: flex; align-items: flex-start; gap: 10px;
}
.ai-srcbar-err {
  background: rgba(207, 34, 44, .08); border-color: rgba(207, 34, 44, .34); color: #cf222e;
}
[data-theme='dark'] .ai-srcbar-err {
  background: rgba(255, 105, 97, .14); border-color: rgba(255, 105, 97, .38); color: #ff9d95;
}
.ai-src-ico {
  flex: none; width: 18px; height: 18px; margin-top: 1px;
  border-radius: 50%; border: 1px solid currentColor;
  font-size: 12px; font-weight: 700; line-height: 16px; text-align: center;
}
.ai-src-txt { flex: 1; min-width: 0; }
.ai-src-sub { font-size: 12px; opacity: .82; margin-top: 2px; }
.ai-src-btn {
  flex: none; border: 1px solid currentColor; background: transparent; color: inherit;
  border-radius: 980px; padding: 3px 12px; cursor: pointer; font-size: 12px;
}
.ai-src-btn:hover { background: rgba(127, 127, 127, .14); }

/* CLI 自检面板：把「为什么没有额度」的答案直接摆出来 */
.ai-cli-box {
  margin: 0 0 14px; padding: 10px 14px;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 10px; font-size: 12.5px; line-height: 1.7; color: var(--text-2);
}
.ai-cli-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.ai-cli-row b { color: var(--text); }
.ai-cli-box .bad { color: #cf222e; }
[data-theme='dark'] .ai-cli-box .bad { color: #ff9d95; }
.ai-cli-fix { margin-top: 4px; word-break: break-all; }
.ai-cli-box code {
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: 1px 6px; margin: 0 4px;
}
.ai-cli-p { display: inline-block; margin-right: 10px; }
.ai-cli-box .ai-copy { opacity: .7; vertical-align: middle; }
.ai-cli-box .ai-copy:hover { opacity: 1; }
/* 表格空态：说明「一次都没取到」还是「这个筛选下没有」 */
.ai-empty-note { font-size: 12px; color: var(--text-3); margin-top: 6px; }

/* 未绑定 CLI 时的引导卡片：明确「这里为什么是空的」+ 直接可绑定 */
.ai-bindcard {
  display: flex; gap: 12px; align-items: flex-start;
  margin: 4px 0 14px; padding: 16px 18px;
  background: var(--surface-2); border: 1px dashed var(--border-strong);
  border-radius: 12px;
}
.ai-bc-ico {
  flex: none; width: 26px; height: 26px; margin-top: 2px;
  border-radius: 50%; border: 1px solid var(--border-strong);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700; color: var(--text-3);
}
.ai-bc-body { flex: 1; min-width: 0; }
.ai-bc-t { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
.ai-bc-p { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--text-2); }
.ai-bc-act { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 8px; }
.ai-bc-act select { max-width: 460px; }
.ai-bc-hint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--text-3); }
.ai-bc-hint code {
  font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: 1px 6px; margin: 0 2px;
}
.ai-bc-good { color: #1a7f37; }
[data-theme='dark'] .ai-bc-good { color: #6ede8a; }
.ai-bc-warn { margin: 0 0 8px; font-size: 12.5px; }

/* 添加新 CLI 登录身份：多账号场景的必经步骤，入口要显眼、命令要能直接复制 */
.ai-addcli { margin-top: 10px; }
.ai-addcli-btn {
  border: 1px dashed var(--border-strong); background: transparent; color: var(--accent);
  border-radius: 980px; padding: 5px 14px; cursor: pointer; font-size: 12.5px;
}
.ai-addcli-btn:hover { background: var(--surface); border-style: solid; }
.ai-addcli-body { margin-top: 10px; }
.ai-steps { margin: 0; padding: 0; list-style: none; }
.ai-steps li { display: flex; gap: 10px; margin-bottom: 10px; font-size: 12.5px; line-height: 1.7; color: var(--text-2); }
.ai-step-n {
  flex: none; width: 20px; height: 20px; margin-top: 2px;
  border-radius: 50%; background: var(--surface-2); border: 1px solid var(--border-strong);
  font-size: 11px; font-weight: 600; color: var(--text-3);
  display: flex; align-items: center; justify-content: center;
}
.ai-cmdline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.ai-cmdline input {
  width: 130px; padding: 3px 8px; font-size: 12px;
  border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--surface); color: var(--text);
}
.ai-cmdline code {
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 4px 10px;
}
.ai-cmdline .ai-copy { opacity: .7; }
.ai-cmdline .ai-copy:hover { opacity: 1; }
.ai-hint { display: inline-block; margin-top: 4px; color: var(--text-3, #8b949e); font-size: 12px; }
/* 账号标签：只用语义令牌，禁止浅色 fallback —— 深色下 --text-2 是亮字，配死浅底会看不见 */
.ai-acct-tag {
  display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 1px 7px; border-radius: 4px; font-size: 12px; line-height: 1.6;
  background: var(--chip-bg); color: var(--text); border: 1px solid var(--border);
}
.ai-note a { color: var(--accent); }
.ai-bindbar code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 6px; padding: 1px 5px;
}

/* 用完即停开关 */
.ai-switch {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-strong); background: var(--surface);
  border-radius: 980px; padding: 2px 10px 2px 4px;
  cursor: pointer; font-size: 11.5px; color: var(--text-3);
}
.ai-switch.on { background: rgba(26, 127, 55, .12); border-color: rgba(26, 127, 55, .34); color: #1a7f37; }
[data-theme='dark'] .ai-switch.on { background: rgba(63, 185, 80, .18); border-color: rgba(63, 185, 80, .34); color: #6ede8a; }
.ai-knob {
  width: 18px; height: 10px; border-radius: 999px; background: var(--border-strong);
  position: relative; flex: none;
}
.ai-knob::after {
  content: ''; position: absolute; top: 1px; left: 1px;
  width: 8px; height: 8px; border-radius: 50%; background: #fff;
}
.ai-switch.on .ai-knob { background: #1a7f37; }
.ai-switch.on .ai-knob::after { left: 9px; }
.ai-switch:disabled { opacity: .55; cursor: default; }
.ai-bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; }
.ai-bulk button {
  border: 1px solid var(--border-strong); background: var(--surface);
  border-radius: 8px; padding: 3px 10px; cursor: pointer; font-size: 12px; color: var(--text-2);
}
.ai-bulk button:hover { border-color: var(--accent); color: var(--accent); }
.ai-note-t { font-size: 12px; color: var(--text-3); }
.ai-chg { list-style: none; margin: 0 0 12px; padding: 0; }
.ai-chg li { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 12.5px; flex-wrap: wrap; }
.ai-chg-t { width: 44px; font-size: 12px; flex: none; }
.ai-chg-t.add { color: #1a7f37; }
.ai-chg-t.del { color: #cf222e; }
.ai-chg-t.price { color: #9a6700; }
.ai-chg-p { color: var(--text-2); font-size: 12px; }
.ai-chg-block { margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px dashed var(--border); }
.ai-price-cell { position: relative; font-size: 12px; color: var(--text-2); max-width: 220px; }
.ai-price-sum {
  display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border-bottom: 1px dashed transparent; cursor: default;
}
.ai-price-cell:hover .ai-price-sum { color: var(--accent); border-bottom-color: var(--accent); }
.ai-price-tip {
  display: none; position: absolute; right: 0; top: calc(100% + 4px); z-index: 40;
  min-width: 260px; max-width: 360px; max-height: 280px; overflow: auto;
  padding: 10px 12px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--border-strong);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
  color: var(--text); font-size: 12px; line-height: 1.55;
}
.ai-price-cell:hover .ai-price-tip { display: block; }
.ai-price-tip-h { font-weight: 600; margin-bottom: 6px; color: var(--text); }
.ai-price-tip ul { margin: 0; padding: 0; list-style: none; }
.ai-price-tip li { padding: 2px 0; color: var(--text-2); border-bottom: 1px solid var(--border); }
.ai-price-tip li:last-child { border-bottom: none; }
[data-theme='dark'] .ai-price-tip { box-shadow: 0 10px 28px rgba(0, 0, 0, .45); }
[data-theme='dark'] .ai-chg-t.price { color: #ffd60a; }

/* 深色下语义色提亮，保证对比度 */
[data-theme='dark'] .ai-verdict.ok { background: rgba(63, 185, 80, .18); color: #6ede8a; border-color: rgba(63, 185, 80, .34); }
[data-theme='dark'] .ai-verdict.warn { background: rgba(240, 185, 66, .18); color: #ffd60a; border-color: rgba(240, 185, 66, .34); }
[data-theme='dark'] .ai-verdict.bad { background: rgba(255, 105, 97, .18); color: #ff9d95; border-color: rgba(255, 105, 97, .34); }
[data-theme='dark'] .ai-chg-t.add { color: #6ede8a; }
[data-theme='dark'] .ai-chg-t.del { color: #ff9d95; }

/* ================= Apple 设计系统修正 =================
 * 强调色 Apple Blue #0071e3（仅交互元素）· 矩形圆角 ≤12px · pill 仅用于导航/CTA
 * 参考：awesome-design-md/references/apple.md */
nav button {
  border-radius: 980px;
  padding: 6px 14px;
  font-size: 13px;
  color: rgba(0, 0, 0, .8);
  letter-spacing: -.08px;
  border-bottom: none;
  transition: background .12s, color .12s;
}
/* 选中态：填充蓝底 + 白字（此前只有一条下划线，太弱） */
nav button.on { background: #0071e3; color: #fff; }
@media (hover: hover) { nav button:not(.on):hover { background: rgba(0, 0, 0, .05); } }
nav button.on:focus-visible { outline: 2px solid #0071e3; outline-offset: 2px; }

/* 主按钮改 Apple Blue + 8px 标准圆角 */
.primary { background: #0071e3; border-radius: 8px; box-shadow: none; }
@media (hover: hover) { .primary:hover { background: #0077ed; } }

/* 审计日志工具条：全部压到一行（!important 防止任何规则把它改回竖排） */
.audit-bar { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; }
/* 明细是整条 JSON 长串：必须可断行并限宽，否则把表格顶出横向滚动条 */
.audit-detail { max-width: 520px; word-break: break-all; white-space: normal; line-height: 1.5; }
section .actdesc, section td.actdesc { word-break: break-word; }
.audit-bar .audit-size {
  display: inline-flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  gap: 6px;
  white-space: nowrap;
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}
.audit-bar .audit-size > * { flex: none; }
.audit-size select { width: auto; min-height: 28px; padding: 2px 6px; font-size: 12px; margin: 0; }
.audit-pager { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; font-size: 12px; margin-left: auto; }

/* 表单列再放宽一点，避免敏感字段（输入框+显示按钮）被挤压 */
.form-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }

/* 主题切换按钮 */
.theme-toggle {
  border: 1px solid rgba(0, 0, 0, .12); background: var(--surface-2); color: rgba(0, 0, 0, .8);
  border-radius: 980px; padding: 5px 12px; min-height: 32px;
  cursor: pointer; font-size: 14px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .12s, border-color .12s, color .12s;
}
@media (hover: hover) { .theme-toggle:hover { border-color: #0071e3; color: #0071e3; } }
.theme-toggle:focus-visible { outline: 2px solid #0071e3; outline-offset: 2px; }

/* ================= 深色模式（Apple：纯黑底 + #272729 表面 + #2997ff 亮蓝） ================= */
[data-theme='dark'] .app { color: #f5f5f7; background: none; } /* 去掉浅色渐变，露出 body 的纯黑底 */
[data-theme='dark'] .side { background: var(--surface); }
/* 深色下残留的硬编码浅色元素统一收敛 */
[data-theme='dark'] .split-side h4,
[data-theme='dark'] .wl-h4,
[data-theme='dark'] .memo-head strong,
[data-theme='dark'] .flabel,
[data-theme='dark'] td.actdesc { color: #f5f5f7; }
[data-theme='dark'] .issue-bar button,
[data-theme='dark'] .link-add button {
  background: rgba(41, 151, 255, .16); color: #2997ff; border-color: rgba(41, 151, 255, .4);
}
[data-theme='dark'] .colcfg-field:hover { background: rgba(41, 151, 255, .12); }
[data-theme='dark'] h1,
[data-theme='dark'] h3,
[data-theme='dark'] h4,
[data-theme='dark'] strong { color: #f5f5f7; }
[data-theme='dark'] .box,
[data-theme='dark'] .memo-card,
[data-theme='dark'] .split-side,
[data-theme='dark'] .wl-sched,
[data-theme='dark'] .memo-body,
[data-theme='dark'] .side-block {
  background: #272729; border-color: rgba(255, 255, 255, .08); color: #f5f5f7;
}
[data-theme='dark'] .box { box-shadow: rgba(0, 0, 0, .5) 3px 5px 30px 0px; }
[data-theme='dark'] table { color: #f5f5f7; }
[data-theme='dark'] thead th {
  background: #1d1d1f; color: rgba(245, 245, 247, .7); border-bottom-color: rgba(255, 255, 255, .1);
}
[data-theme='dark'] th,
[data-theme='dark'] td { border-bottom-color: rgba(255, 255, 255, .07); }
@media (hover: hover) { [data-theme='dark'] tbody tr:hover { background: rgba(41, 151, 255, .14); } }
[data-theme='dark'] input,
[data-theme='dark'] select,
[data-theme='dark'] textarea {
  background: #1d1d1f; color: #f5f5f7; border-color: rgba(255, 255, 255, .14);
}
[data-theme='dark'] .chips button,
[data-theme='dark'] .ops button,
[data-theme='dark'] .colcfg-btn,
[data-theme='dark'] .theme-toggle,
[data-theme='dark'] .colcfg-field {
  background: #1d1d1f; color: #f5f5f7; border-color: rgba(255, 255, 255, .14);
}
[data-theme='dark'] .colcfg-field.on {
  background: rgba(41, 151, 255, .16); border-color: rgba(41, 151, 255, .5); color: #2997ff;
}
[data-theme='dark'] .colcfg-foot,
[data-theme='dark'] .colcfg-head { border-color: rgba(255, 255, 255, .08); background: #1d1d1f; }
[data-theme='dark'] .colcfg-title h3,
[data-theme='dark'] .colcfg-sub { color: #f5f5f7; }
[data-theme='dark'] .colcfg-order li { background: #1d1d1f; border-color: rgba(255, 255, 255, .08); color: #f5f5f7; }
[data-theme='dark'] .wl-none,
[data-theme='dark'] .audit-meta,
[data-theme='dark'] .side-empty { color: rgba(245, 245, 247, .6); }
[data-theme='dark'] nav button { color: rgba(245, 245, 247, .8); }
[data-theme='dark'] nav button.on { background: #0071e3; color: #fff; }
@media (hover: hover) { [data-theme='dark'] nav button:not(.on):hover { background: rgba(255, 255, 255, .08); } }
[data-theme='dark'] .modal { background: rgba(0, 0, 0, .66); }

/* 深色下的彩色徽章：改「半透明色底 + 亮色字」，否则浅底配亮字会看不清 */
[data-theme='dark'] .tag { background: rgba(41, 151, 255, .16); color: #2997ff; }
[data-theme='dark'] .link-n { background: rgba(41, 151, 255, .16); color: #2997ff; }
[data-theme='dark'] .ai-acct-tag {
  background: rgba(41, 151, 255, .16); color: #2997ff; border-color: rgba(41, 151, 255, .34);
}
[data-theme='dark'] .due {
  background: rgba(255, 159, 10, .18); color: #ffd60a; border-color: rgba(255, 159, 10, .32);
}
[data-theme='dark'] .cert-tag {
  background: rgba(163, 113, 247, .2); color: #c4a7ff; border-color: rgba(163, 113, 247, .34);
}
[data-theme='dark'] .tag.act {
  background: rgba(219, 109, 168, .2); color: #ff9ec4; border-color: rgba(219, 109, 168, .34);
}

/* 类型标签在深色下用专属深色配色（!important 覆盖用户在设置里配的颜色，
   避免「浅色自定义底 + 亮字」导致不可读；浅色模式仍按用户配置显示） */
[data-theme='dark'] .type-tag.t-server,
[data-theme='dark'] .chips .chip-type.t-server {
  background: rgba(85, 160, 255, .2) !important; color: #8ab4ff !important; border-color: rgba(85, 160, 255, .34) !important;
}
[data-theme='dark'] .type-tag.t-ssh_key,
[data-theme='dark'] .chips .chip-type.t-ssh_key {
  background: rgba(63, 185, 80, .2) !important; color: #6ede8a !important; border-color: rgba(63, 185, 80, .34) !important;
}
[data-theme='dark'] .type-tag.t-cloud_account,
[data-theme='dark'] .chips .chip-type.t-cloud_account {
  background: rgba(163, 113, 247, .22) !important; color: #c4a7ff !important; border-color: rgba(163, 113, 247, .36) !important;
}
[data-theme='dark'] .type-tag.t-oss,
[data-theme='dark'] .chips .chip-type.t-oss {
  background: rgba(219, 109, 168, .22) !important; color: #ff9ec4 !important; border-color: rgba(219, 109, 168, .36) !important;
}
[data-theme='dark'] .type-tag.t-baota,
[data-theme='dark'] .chips .chip-type.t-baota {
  background: rgba(255, 159, 10, .2) !important; color: #ffd60a !important; border-color: rgba(255, 159, 10, .34) !important;
}
[data-theme='dark'] .type-tag.t-project,
[data-theme='dark'] .chips .chip-type.t-project {
  background: rgba(45, 212, 191, .18) !important; color: #5eead4 !important; border-color: rgba(45, 212, 191, .34) !important;
}
[data-theme='dark'] .type-tag.t-mcp,
[data-theme='dark'] .chips .chip-type.t-mcp {
  background: rgba(94, 200, 220, .2) !important; color: #7fd8e8 !important; border-color: rgba(94, 200, 220, .34) !important;
}
[data-theme='dark'] .type-tag.t-api_key,
[data-theme='dark'] .chips .chip-type.t-api_key {
  background: rgba(240, 208, 96, .18) !important; color: #ffe066 !important; border-color: rgba(240, 208, 96, .32) !important;
}
[data-theme='dark'] .type-tag.t-login_account,
[data-theme='dark'] .chips .chip-type.t-login_account {
  background: rgba(255, 105, 97, .2) !important; color: #ff9d95 !important; border-color: rgba(255, 105, 97, .34) !important;
}
/* 选中态始终为强调色填充 + 白字，覆盖上面的类型底色 */
[data-theme='dark'] .chips .chip-type.on {
  background: var(--accent) !important; color: #ffffff !important; border-color: transparent !important;
}
</style>

<style>
/* ===== z-index 层级表（全局唯一事实源）=====
   相对层级：scrim < drawer < offline < modal < modal-top < unlock < toast。
   unlock 压过一切业务层，toast 最高；散落的 z-index 数字一律引用这里的令牌。 */
:root {
  --z-scrim: 50;
  --z-drawer: 60;
  --z-offline: 70;
  --z-modal: 80;
  --z-modal-top: 200;
  --z-unlock: 1000;
  --z-toast: 1100;
}
/* 全局（非 scoped）：预留滚动条槽位，避免内容多 / 少切换时页面横向跳动 */
html { scrollbar-gutter: stable; }
/* 新版模板页在内部滚动，html 不预留槽位；否则每个页面右侧都多 15px 白边 */
html.mg-scroll { scrollbar-gutter: auto; }
/* ===== 新版模板下：整个窗口底色/滚动条都跟着深色走 =====
   以前只有内容区是深色，html/body 还是 #f3f3f2，任何缝隙（右侧滚动条槽、
   底部留白）都会露出一圈白底。 */
html.mg-dark,
html.mg-dark body,
html.mg-dark #app,
html.mg-dark .app {
  background: #07080a;
  background-image: none;
}
html.mg-dark {
  color-scheme: dark;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
}
html.mg-dark::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
html.mg-dark::-webkit-scrollbar-track {
  background: #07080a;
}
html.mg-dark::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 5px;
}
html.mg-dark::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
}
/* 全站统一细滚动条：8px、半透明滑块、透明轨道（含表格横向滚动） */
html.mg-dark ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
html.mg-dark ::-webkit-scrollbar-track {
  background: transparent;
}
html.mg-dark ::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 4px;
}
html.mg-dark ::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
}
html.mg-dark ::-webkit-scrollbar-corner {
  background: transparent;
}
/* ===== 纸墨模板（atlas）覆盖整窗底色 =====
   上面的 #07080a / #f4f4f1 是黑曜模板的值，atlas 深色 #1c1a15、浅色 #faf8f3。 */
html.mg-atlas.mg-dark,
html.mg-atlas.mg-dark body,
html.mg-atlas.mg-dark #app,
html.mg-atlas.mg-dark .app {
  background: #1c1a15;
  background-image: none;
}
html.mg-atlas.mg-dark::-webkit-scrollbar-track {
  background: #1c1a15;
}
html.mg-atlas.mg-light,
html.mg-atlas.mg-light body,
html.mg-atlas.mg-light #app,
html.mg-atlas.mg-light .app {
  background: #faf8f3;
  background-image: none;
}
/* 有些滚动条挂在 #app / .app 上，一起盖掉，避免右侧留一条浅色轨道 */
html.mg-dark #app,
html.mg-dark .app,
html.mg-dark .mg-view {
  scrollbar-color: rgba(255, 255, 255, 0.16) #07080a;
}
html.mg-dark #app::-webkit-scrollbar,
html.mg-dark .app::-webkit-scrollbar,
html.mg-dark .mg-view::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
html.mg-dark #app::-webkit-scrollbar-track,
html.mg-dark .app::-webkit-scrollbar-track,
html.mg-dark .mg-view::-webkit-scrollbar-track {
  background: #07080a;
}
html.mg-dark #app::-webkit-scrollbar-thumb,
html.mg-dark .app::-webkit-scrollbar-thumb,
html.mg-dark .mg-view::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 4px;
}
html.mg-light,
html.mg-light body,
html.mg-light #app {
  background: #f4f4f1;
}
/* AI 助手页锁定视口：不预留滚动条槽位；消息区与输入框保留滚动但不画滚动条 */
html:has(.ai-page) { scrollbar-gutter: auto; }
.ai-thread, .ai-big-composer textarea, .ai-composer textarea { scrollbar-width: none; }
.ai-thread::-webkit-scrollbar,
.ai-big-composer textarea::-webkit-scrollbar,
.ai-composer textarea::-webkit-scrollbar { display: none; }

/* ===== 语义化颜色令牌：组件一律用变量，深色模式只改这一处 ===== */
:root {
  /* 浅色令牌与工作台（旧版工作台-OPC）暖灰系对齐：--surface=其--panel、--border=其--line、--accent=其--blue */
  --surface: #ffffff;        /* 卡片 / 弹窗 / 输入框 */
  --surface-2: #f3f3f2;      /* 次级底：表头、代码块、侧栏（= 其 --fill） */
  --surface-3: #f9f9f8;      /* 更浅一级：操作栏 */
  --text: #171717;           /* 主文字（= 其 --ink） */
  --text-2: #5c5c5a;         /* 次要文字（= 其 --ink2） */
  --text-3: #9a9a97;         /* 三级 / 提示文字（= 其 --ink3） */
  --border: #ececea;         /* 发丝边框（= 其 --line） */
  --border-strong: #e2e2df;  /* 控件边框（= 其 --line2） */
  --accent: #2f7ff0;         /* 交互蓝（= 其 --blue） */
  --chip-bg: #f0f0ee;        /* 小标签底；深色必须另配，勿写死浅色 fallback */
}
[data-theme='dark'] {
  --surface: #1d1d1f;
  --surface-2: #272729;
  --surface-3: #242426;
  --text: #f5f5f7;
  --text-2: rgba(245, 245, 247, .72);
  --text-3: rgba(245, 245, 247, .45);
  --border: rgba(255, 255, 255, .1);
  --border-strong: rgba(255, 255, 255, .18);
  --accent: #2997ff;         /* 深色背景上用亮蓝 */
  --chip-bg: rgba(255, 255, 255, .1);
}

/* 工作台页：宿主容器锁视口（消除 24px 溢出导致的滚动空白） */
#app:has(.main-flush) { height: 100vh; overflow: hidden; }

/* 页面底色由 CSS 控制（不能写在 body 的 inline style 里，否则深色盖不掉） */
body { margin: 0; background: var(--surface-2); color: var(--text); }

/* 深色模式：Apple 用纯黑 #000 作页面底 */
html[data-theme='dark'],
html[data-theme='dark'] body {
  background: #000000;
  color: #f5f5f7;
}
[data-theme='dark'] { color-scheme: dark; }

/* ================= 液态玻璃升级（只作用于关键层，控制模糊面积保性能） =================
 * 思路：页面底铺柔和光斑 → 侧栏/类型栏/弹窗/表格做成半透明玻璃，靠 backdrop-filter 折射；
 * 不给每一行、每个按钮单独开模糊（那样 20+ 层模糊会拖慢 Chromium），保证滚动顺滑。
 * 深色模式单独给令牌；不支持 backdrop-filter 时回退为不透明面板。 */
:root {
  --mg-glow-a: rgba(64, 132, 255, .18);
  --mg-glow-b: rgba(120, 210, 255, .16);
  --mg-glow-c: rgba(255, 196, 120, .12);
  --glass: rgba(255, 255, 255, .62);
  --glass-strong: rgba(255, 255, 255, .82);
  --glass-border: rgba(255, 255, 255, .72);
  --glass-hi: rgba(255, 255, 255, .92);
  --glass-shadow: 0 10px 30px rgba(25, 35, 55, .10), 0 1px 2px rgba(25, 35, 55, .05);
  --glass-blur: blur(22px) saturate(180%);
}
[data-theme='dark'] {
  --mg-glow-a: rgba(41, 151, 255, .20);
  --mg-glow-b: rgba(120, 90, 255, .14);
  --mg-glow-c: rgba(255, 120, 180, .10);
  --glass: rgba(30, 30, 32, .55);
  --glass-strong: rgba(38, 38, 41, .80);
  --glass-border: rgba(255, 255, 255, .14);
  --glass-hi: rgba(255, 255, 255, .18);
  --glass-shadow: 0 14px 40px rgba(0, 0, 0, .55), 0 1px 2px rgba(0, 0, 0, .40);
}

/* 页面底光斑：给玻璃层提供可折射的内容，避免“灰蒙蒙一片” */
.app {
  background-image:
    radial-gradient(1200px 620px at 6% -12%, var(--mg-glow-a), transparent 62%),
    radial-gradient(900px 520px at 102% -4%, var(--mg-glow-b), transparent 60%),
    radial-gradient(1000px 720px at 62% 112%, var(--mg-glow-c), transparent 64%);
  background-attachment: fixed;
  background-repeat: no-repeat;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* 侧栏：整块磨砂玻璃，右侧只留一条发丝边 */
.side {
  background: var(--glass);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border-right: 1px solid var(--glass-border);
  box-shadow: inset -1px 0 0 rgba(255, 255, 255, .28), 8px 0 28px rgba(20, 30, 50, .05);
}
.side-nav > button.on {
  background: var(--glass-strong);
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 2px 6px rgba(0, 0, 0, .06);
}

/* 顶部类型栏：一条玻璃轨道，chip 本身不再各自模糊（20 个 chip = 20 层模糊，会卡） */
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 16px;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-hi);
}
.chips > button { margin: 0 !important; }
.chips button {
  border-radius: 11px;
  border: 1px solid transparent;
  background: transparent;
  box-shadow: none;
  padding: 6px 11px;
  font-size: 12.5px;
  transition: background .15s, color .15s, border-color .15s, transform .12s, box-shadow .15s;
}
@media (hover: hover) {
  .chips button:hover {
    background: rgba(255, 255, 255, .55);
    border-color: rgba(255, 255, 255, .55);
    color: var(--text);
    transform: translateY(-1px);
  }
  [data-theme='dark'] .chips button:hover {
    background: rgba(255, 255, 255, .08);
    border-color: rgba(255, 255, 255, .10);
  }
}
.chips button.on { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25), 0 3px 10px rgba(0, 0, 0, .12); }
.chips button:active { transform: scale(.97); }

/* 分类小标题：竖向分隔 + 轻字重 */
.chip-cat {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: .04em;
  color: var(--text-3);
  padding: 0 2px 0 7px;
  margin: 0 !important;
}
.chip-cat::before {
  content: '';
  width: 1px;
  height: 14px;
  background: var(--border-strong);
  opacity: .7;
}
.chip-cat:first-child::before { display: none; }

/* 「＋」新增类型：40×40 的玻璃按钮，hover 抬升，按下回弹
   注意：scoped 样式块里的 `.chips button[data-v-xxx]` 特异性更高，
   会把「＋」压回白底灰字小字号，所以这里的视觉属性必须 !important。 */
.chips .chip-add {
  margin-left: 2px !important;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  min-width: 40px;
  padding: 0 !important;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px !important;
  border: 1px solid var(--glass-border) !important;
  background: var(--glass-strong) !important;
  color: var(--accent) !important;
  font-size: 22px !important;
  font-weight: 500 !important;
  line-height: 1 !important;
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 4px 14px rgba(47, 127, 240, .18) !important;
  transition: transform .16s cubic-bezier(.2, .8, .2, 1), box-shadow .16s, background .16s, color .16s;
}
@media (hover: hover) {
  .chips .chip-add:hover {
    background: var(--accent) !important;
    color: #fff !important;
    border-color: var(--accent) !important;
    transform: translateY(-1px) scale(1.05);
    box-shadow: 0 10px 24px rgba(47, 127, 240, .32) !important;
  }
}
.chips .chip-add:active { transform: scale(.94); }

/* 自定义类型没有专属选中色：统一用强调蓝，避免浅底白字看不见 */
.chips .chip-type.chip-custom.on {
  background: var(--accent) !important;
  border-color: var(--accent) !important;
  color: #fff !important;
}

/* 工具栏按钮：玻璃小控件；主按钮保留深色对比 */
.toolbar-right button {
  border-radius: 11px;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  backdrop-filter: blur(14px) saturate(160%);
  box-shadow: inset 0 1px 0 var(--glass-hi), 0 1px 2px rgba(0, 0, 0, .05);
  padding: 7px 12px;
  transition: transform .15s, box-shadow .15s, background .15s;
}
@media (hover: hover) {
  .toolbar-right button:hover { transform: translateY(-1px); box-shadow: 0 7px 18px rgba(0, 0, 0, .10); }
}
.toolbar-right button.primary {
  background: linear-gradient(180deg, #2f2f33 0%, #141416 100%);
  color: #fff;
  border-color: rgba(255, 255, 255, .10);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .16), 0 4px 14px rgba(0, 0, 0, .20);
}
[data-theme='dark'] .toolbar-right button.primary {
  background: linear-gradient(180deg, #fafafa 0%, #d9d9de 100%);
  color: #111;
  border-color: rgba(0, 0, 0, .06);
}

/* 搜索框：内凹玻璃，聚焦有蓝色柔光 */
.search-box {
  border-radius: 12px;
}
.search-input {
  border-radius: 11px !important;
  border: 1px solid var(--glass-border) !important;
  background: var(--glass) !important;
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  backdrop-filter: blur(14px) saturate(160%);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .06);
  transition: border-color .15s, box-shadow .15s;
}
.search-input:focus {
  outline: none;
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px rgba(47, 127, 240, .16), inset 0 1px 3px rgba(0, 0, 0, .04);
}

/* 资产表格：整块玻璃面板，行 hover 用极淡蓝，表头轻磨砂 */
.tbl-scroll {
  margin-top: 10px;
  padding: 2px 6px 4px;
  border-radius: 16px;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-hi);
}
.tbl-scroll > table { margin-top: 0; }

/* ---- 资产清单表格：定宽列 + 单行摘要，行高一致才看得舒服 ---- */
.assets-tbl { table-layout: fixed; }
.assets-tbl thead th {
  color: var(--text-2);
  font-weight: 600;
  white-space: nowrap;
}
.assets-tbl tbody td { height: 46px; }
.assets-tbl td.meta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-2);
}
.assets-tbl td.no-cell { color: var(--text-3); }
.assets-tbl td.tags-cell { white-space: nowrap; overflow: hidden; }
.assets-tbl .ops { white-space: nowrap; }
.tbl-scroll thead th {
  background: var(--glass-strong);
  border-bottom: 1px solid var(--glass-border);
  font-size: 11.5px;
  letter-spacing: .02em;
}
.tbl-scroll th,
.tbl-scroll td { padding: 10px 12px; }
.tbl-scroll tbody tr { transition: background .12s; }
@media (hover: hover) {
  .tbl-scroll tbody tr:hover { background: rgba(47, 127, 240, .065); }
  [data-theme='dark'] .tbl-scroll tbody tr:hover { background: rgba(41, 151, 255, .10); }
}

/* 弹窗：遮罩轻模糊，面板大圆角玻璃 + 高光边 + 入场动画 */
.modal {
  background: rgba(12, 16, 22, .34);
  -webkit-backdrop-filter: blur(8px) saturate(120%);
  backdrop-filter: blur(8px) saturate(120%);
}
[data-theme='dark'] .modal { background: rgba(0, 0, 0, .50); }
.box {
  background: var(--glass-strong);
  -webkit-backdrop-filter: blur(40px) saturate(190%);
  backdrop-filter: blur(40px) saturate(190%);
  border: 1px solid var(--glass-border);
  border-radius: 22px;
  padding: 22px 24px;
  box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-hi);
  animation: mg-pop .22s cubic-bezier(.2, .9, .25, 1);
}
.box-wide,
.colcfg { border-radius: 22px; }
@keyframes mg-pop {
  from { opacity: 0; transform: translateY(10px) scale(.97); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .box { animation: none; }
  .chips button, .chips .chip-add, .toolbar-right button { transition: none; }
}
.box-head {
  border-bottom: 1px solid rgba(0, 0, 0, .07);
  padding-bottom: 13px;
  margin-bottom: 16px;
}
[data-theme='dark'] .box-head { border-bottom-color: rgba(255, 255, 255, .10); }
.box-head h3 { font-size: 17px; letter-spacing: -.015em; }

/* 关闭按钮：圆形玻璃，hover 变红 */
.colcfg-x {
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  box-shadow: inset 0 1px 0 var(--glass-hi);
  transition: background .15s, color .15s, transform .12s;
}
@media (hover: hover) {
  .colcfg-x:hover { background: rgba(255, 95, 86, .14); color: #cf222e; }
}
.colcfg-x:active { transform: scale(.94); }

/* 弹窗内表单：统一高度、圆角与聚焦环 */
.box input:not([type='checkbox']):not([type='color']),
.box select,
.box textarea {
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, .12);
  background: rgba(255, 255, 255, .74);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text);
  transition: border-color .15s, box-shadow .15s, background .15s;
}
[data-theme='dark'] .box input:not([type='checkbox']):not([type='color']),
[data-theme='dark'] .box select,
[data-theme='dark'] .box textarea {
  background: rgba(255, 255, 255, .06);
  border-color: rgba(255, 255, 255, .16);
  color: var(--text);
}
.box input:focus,
.box select:focus,
.box textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(47, 127, 240, .16);
}
.box input[type='color'] { border-radius: 10px; border: 1px solid rgba(0, 0, 0, .12); padding: 2px; background: transparent; }

/* 设置页卡片与备忘录卡片：同一套玻璃语言 */
.card,
.memo-card {
  border-radius: 18px;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-hi);
}
.page-head h2 { font-size: 22px; letter-spacing: -.02em; }
.page-head p { color: var(--text-3); }

/* 不支持 backdrop-filter 的环境：退回不透明面板，保证可读性 */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .side,
  .chips,
  .toolbar-right button,
  .search-input,
  .tbl-scroll,
  .box,
  .card,
  .memo-card { background: var(--surface); }
  .box { box-shadow: 0 18px 50px rgba(0, 0, 0, .22); }
}

/* ================= 弹窗性能修复 =================
 * 原因：.box 上的 backdrop-filter: blur(40px) + .modal 的 blur(8px) 是整屏实时采样，
 * 弹窗里表单元素一多、输入/滚动时每帧都要重算模糊，Chromium 会明显掉帧。
 * 处理：弹窗改成高不透明度雾面玻璃（静态渐变 + 高光边），不再实时折射；
 * 弹窗打开时把背景层（侧栏/类型栏/表格/卡片/按钮）的模糊全部停掉，关闭后恢复。 */
.modal {
  background: rgba(10, 14, 20, .46);
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
[data-theme='dark'] .modal { background: rgba(0, 0, 0, .58); }

.box {
  background: linear-gradient(180deg, rgba(255, 255, 255, .97) 0%, rgba(250, 250, 252, .95) 100%);
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  border: 1px solid rgba(255, 255, 255, .92);
  box-shadow:
    0 24px 70px rgba(15, 23, 42, .26),
    0 2px 6px rgba(15, 23, 42, .10),
    inset 0 1px 0 rgba(255, 255, 255, .96);
}
[data-theme='dark'] .box {
  background: linear-gradient(180deg, rgba(40, 40, 43, .97) 0%, rgba(32, 32, 35, .95) 100%);
  border-color: rgba(255, 255, 255, .14);
  box-shadow:
    0 24px 70px rgba(0, 0, 0, .62),
    inset 0 1px 0 rgba(255, 255, 255, .16);
}

/* 入场只做透明度 + 位移，避免阴影随缩放逐帧重绘 */
@keyframes mg-pop {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

/* 弹窗打开期间，背景层不再实时模糊（这是弹窗卡顿的主要来源） */
body:has(.modal) .side,
body:has(.modal) .chips,
body:has(.modal) .tbl-scroll,
body:has(.modal) .card,
body:has(.modal) .memo-card,
body:has(.modal) .toolbar-right button,
body:has(.modal) .search-input {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}

/* 表格与设置卡片：改成半透明纯色雾面，滚动时不再逐帧重算模糊 */
.tbl-scroll {
  background: rgba(255, 255, 255, .74);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
[data-theme='dark'] .tbl-scroll { background: rgba(28, 28, 31, .72); }

.card,
.memo-card {
  background: rgba(255, 255, 255, .78);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
[data-theme='dark'] .card,
[data-theme='dark'] .memo-card { background: rgba(30, 30, 33, .78); }

/* ===== Teleport 到 body 的弹窗（收支 / 任务 / 项目 / 资料 / 灵感等自有页面）=====
   这些页面的「添加」弹窗用 <Teleport to="body"> 渲染，元素只带子组件的 scope 标记；
   而弹窗的定位/卡片样式写在上面 scoped 块里（编译后带 App 的 scope 属性），对它们不生效。
   结果就是：点「添加」弹窗确实渲染了，但既没有 position:fixed 也没有底色，被排在页面最底部
   ——看着就是「点了没反应」。这里用 body > 只兜住这层弹窗，App 自己的弹窗（在 .app 内）不受影响。 */
body > .modal.mg-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal-top);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
  background: var(--scrim-bg, rgba(0, 0, 0, .5));
}
body > .modal.mg-modal > .box {
  width: min(560px, 94vw);
  max-width: none;
  max-height: 88vh;
  overflow: auto;
  box-sizing: border-box;
  padding: 18px 20px;
  background: var(--panel, #0c0e11);
  color: var(--text, #eceef0);
  border: 1px solid var(--line-2, rgba(255, 255, 255, .13));
  border-radius: var(--r-lg, 14px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, .45);
  animation: mg-modal-in .18s ease-out;
}
@keyframes mg-modal-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
</style>
