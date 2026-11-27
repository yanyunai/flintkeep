<script setup lang="ts">
/**
 * 资产清单（新版 / 黑曜模板）
 *
 * 只负责渲染：数据、筛选、搜索全部由 App.vue 传进来，通过事件回调，
 * 这样迁移期可以「经典 / 新版」随时切换，数据层不动。
 * 样式一律用 base.css 的语义类（.page-head / .stats / .chips / .tbl / .drawer），
 * 页面级只写列宽这类结构属性，颜色字号全部来自模板 token。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { uiTheme } from '../ui/appearance';
import { typeUiColor } from '../ui/type-color';
import { useT } from '../ui/i18n';

/** 页面骨架文案：useT 内部读 lang，模板渲染时自动订阅语言变化 */
const tr = useT();

type Col = { key: string; label: string; get: (a: any) => any; mono?: boolean };
type TypeMeta = { label: string; color?: string };

const props = defineProps<{
  rows: any[];
  columns: Col[];
  counts: Record<string, number>;
  groups: { category: string; types: { key: string; label: string }[] }[];
  filter: string;
  total: number;
  dueCount: number;
  typeMeta: Record<string, TypeMeta>;
  isDue: (a: any) => boolean;
  fieldLabel: (k: string) => string;
  /** 该资产的敏感字段 key 清单（内置 + 自定义敏感 extra）；列表数据已脱敏，抽屉渲染占位行用 */
  secretKeysOf?: (a: any) => string[];
  query: string;
  /** 新增资产类型：直接传父级方法，避免事件名在组件边界上丢失 */
  openTypeEditor: () => void;
  /** 抽屉内基础编辑保存：父级负责 PUT + 刷新列表 */
  quickSave?: (a: any, patch: any) => Promise<any>;
  /** 高级面板保存成功后自增，抽屉收到后退出编辑态 */
  editVersion?: number;
}>();

const emit = defineEmits<{
  (e: 'filter', v: string): void;
  (e: 'query', v: string): void;
  (e: 'new'): void;
  (e: 'import'): void;
  (e: 'edit', a: any): void;
  (e: 'advanced', a: any): void;
  (e: 'remove', a: any): void;
  (e: 'colcfg'): void;
  (e: 'addtype'): void;
}>();

const selId = ref<string>('');
const sel = computed(() => props.rows.find((a) => a.id === selId.value) || null);

// 换筛选/换搜索后，选中的行可能不在列表里了
watch(
  () => props.rows,
  (list) => {
    if (selId.value && !list.some((a) => a.id === selId.value)) selId.value = '';
  }
);

function metaOf(k: string): TypeMeta {
  const hit = props.typeMeta[k];
  if (hit) return hit;
  // typeMeta 还没算好时不要把内部 key（如 ct_4e6b0e4f）直接暴露给用户，
  // groups 里带着后端/用户起的类型名，先拿它兜底。
  const fromGroups = props.groups.flatMap((g) => g.types).find((t) => t.key === k);
  return { label: fromGroups?.label || k, color: 'var(--text-3)' };
}

/** 新增资产类型：直接调父级方法（emit('addtype') 在某些构建下没传到父级） */
function onAddType() {
  props.openTypeEditor?.();
}

/** 列配置：只对具体类型有意义；「全部 / 待轮换」是混合视图，给一句提示 */
const colHint = ref('');
function onColcfg() {
  if (!props.filter || props.filter === 'due') {
    colHint.value = tr('assets.columns.hint');
    setTimeout(() => (colHint.value = ''), 2600);
    return;
  }
  emit('colcfg');
}

const isDark = computed(() => uiTheme.value === 'dark');
/**
 * 类型的界面色（灯 / 色点 / 类型列文字）。
 * 数据库里存的是浅底色，深色界面上直接当灯会全部发白，
 * 所以这里按主题换一套：深色用高饱和亮色，浅色用压暗版本。
 */
function colorOf(k: string): string {
  return typeUiColor(k, metaOf(k).color, isDark.value);
}

/** 表头/行共用的列宽（页面级结构，模板不管这个） */
const gridStyle = computed(() => {
  // minmax 下限 96px：动态列允许收缩但压不到 0，列多时由 .tbl 横向滚动兜底（docs/资产清单 P3-7）
  const dyn = props.columns.map((c) => (c.key === 'meta' ? 'minmax(96px,1.7fr)' : 'minmax(96px,1fr)'));
  // 标签列 118、类型列 118：中文类型名（如「云账号(API)」）不能被裁掉
  return { '--cols': `40px 22px minmax(0,1.1fr) ${dyn.join(' ')} 118px 118px` };
});

/** 抽屉里的字段：跳过结构字段与敏感字段（敏感字段单独渲染占位行），置顶关键信息、备注收尾 */
const secretKeys = computed(() => new Set(props.secretKeysOf?.(sel.value) ?? []));
const detailFields = computed(() => {
  const a = sel.value;
  if (!a) return [] as { k: string; v: string }[];
  const skip = new Set(['id', 'type', 'no', 'tags', 'extra', 'name']);
  const out: { k: string; v: string }[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (skip.has(k) || secretKeys.value.has(k) || v == null || v === '' || typeof v === 'object') continue;
    out.push({ k, v: String(v) });
  }
  for (const [k, v] of Object.entries((a as any).extra || {})) {
    if (secretKeys.value.has(k) || v == null || v === '' || typeof v === 'object') continue;
    out.push({ k, v: String(v) });
  }
  return out.sort((x, y) => (x.k === 'note' ? 1 : 0) - (y.k === 'note' ? 1 : 0));
});

// ===== 抽屉内基础编辑 =====
/** view = 只读；edit = 抽屉原地变表单，不再弹居中弹窗 */
const mode = ref<'view' | 'edit'>('view');
const draft = ref<Record<string, string>>({});
const tagsDraft = ref('');
const saving = ref(false);
const saveErr = ref('');
/** 时间戳等系统字段只读：抽屉编辑里不提供输入框，避免手改 createdAt */
const READONLY_KEYS = new Set(['createdAt', 'updatedAt', 'lastRotatedAt', 'no']);

/** 草稿与原值是否有差异：退出编辑/切换选中前据此确认，避免误触丢内容 */
const draftDirty = computed(() => {
  const a: any = sel.value;
  if (!a || mode.value !== 'edit') return false;
  if ((draft.value.name || '') !== (a.name || '')) return true;
  const tags = tagsDraft.value.split(',').map((s) => s.trim()).filter(Boolean).join(',');
  if (tags !== (a.tags || []).join(',')) return true;
  for (const f of detailFields.value) {
    if (READONLY_KEYS.has(f.k)) continue;
    if ((draft.value[f.k] ?? '') !== f.v) return true;
  }
  return false;
});

// 换选中资产后退出编辑，避免把草稿写到另一条记录上
watch(selId, () => {
  mode.value = 'view';
  saveErr.value = '';
});

// 高级面板保存成功 → 抽屉也回到只读态，避免还显示旧草稿
watch(
  () => props.editVersion,
  () => {
    if (mode.value === 'edit') mode.value = 'view';
  }
);

function startEdit() {
  const a: any = sel.value;
  if (!a) return;
  mode.value = 'edit';
  saveErr.value = '';
  const d: Record<string, string> = { name: a.name || '' };
  for (const f of detailFields.value) d[f.k] = f.v;
  draft.value = d;
  tagsDraft.value = (a.tags || []).join(', ');
}

function cancelEdit() {
  if (draftDirty.value && !confirm(tr('common.confirm.discardForm'))) return;
  mode.value = 'view';
  saveErr.value = '';
}

/** 关抽屉 / 切换选中：有未保存草稿先确认 */
function leaveEditIfDirty(): boolean {
  if (mode.value !== 'edit' || !draftDirty.value) return true;
  if (!confirm(tr('common.confirm.discardForm'))) return false;
  mode.value = 'view';
  saveErr.value = '';
  return true;
}

function closeDrawer() {
  if (!leaveEditIfDirty()) return;
  selId.value = '';
}

/** 点行：已选中则关闭；切换到别的行前先处理草稿 */
function pick(a: any) {
  if (a.id === selId.value) {
    closeDrawer();
    return;
  }
  if (!leaveEditIfDirty()) return;
  selId.value = a.id;
}

async function saveQuick() {
  const a: any = sel.value;
  if (!a || saving.value) return;
  const patch: any = {
    name: (draft.value.name || '').trim(),
    tags: tagsDraft.value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  // 只提交改动过的字段；extra 里的自定义字段单独合并，避免覆盖其它值
  const extra: Record<string, string> = {};
  for (const f of detailFields.value) {
    if (!(f.k in draft.value)) continue;
    const val = draft.value[f.k];
    if (val === f.v) continue;
    if (f.k in a) patch[f.k] = val;
    else extra[f.k] = val;
  }
  if (Object.keys(extra).length) patch.extra = extra;
  saving.value = true;
  try {
    if (!props.quickSave) return;
    const r = await props.quickSave(a, patch);
    if (r?.error) {
      saveErr.value = String(r.error);
      return;
    }
    mode.value = 'view';
  } catch (e: any) {
    saveErr.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}

function advanced() {
  // 编辑面板打开后抽屉会收起，草稿没保存的话先确认，避免悄悄丢掉
  if (draftDirty.value && !confirm(tr('common.confirm.discardForm'))) return;
  const a = sel.value;
  if (!a) return;
  // 同一时刻只有一个编辑面板：抽屉先收起，编辑在大面板里独立进行。
  // 不再出现「关了抽屉、中间面板还挂着」的孤儿态，
  // atlas（居中浮动抽屉）与 obs（贴边抽屉）宽度不同导致的两栏重叠也一并消除。
  closeDrawer();
  emit('advanced', a);
}

const copied = ref('');
async function copy(text: string, tag = '') {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = tag || text.slice(0, 12);
    setTimeout(() => (copied.value = ''), 1200);
  } catch {
    /* 剪贴板不可用时不打断操作 */
  }
}

const dueText = computed(() => {
  const a = sel.value as any;
  if (!a || !a.lastRotatedAt || !a.rotationReminderDays) return '';
  const days = Math.floor((Date.now() - new Date(a.lastRotatedAt).getTime()) / 86400000);
  // lastRotatedAt 非法日期时 days 会是 NaN，宁可不显示也不插「NaN 天」
  if (!Number.isFinite(days)) return '';
  return tr('assets.detail.rotationText', { date: a.lastRotatedAt, days, days2: a.rotationReminderDays });
});

/** ↑↓ 切行、Esc 关抽屉：列表页最常用的两个动作 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // 编辑态先退回只读，再按一次才关抽屉，避免误按把草稿丢掉
    if (mode.value === 'edit') cancelEdit();
    else selId.value = '';
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  const list = props.rows;
  if (!list.length) return;
  const i = list.findIndex((a) => a.id === selId.value);
  const next = e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
  const target = list[i < 0 ? 0 : next];
  if (target.id !== selId.value) {
    if (!leaveEditIfDirty()) return;
    selId.value = target.id;
  }
  e.preventDefault();
  requestAnimationFrame(() => {
    document.querySelector(`.mg-view .t-row.sel`)?.scrollIntoView({ block: 'nearest' });
  });
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

const allLabel = computed(() => tr('assets.title.all'));
/** 状态条上的类型数：按实际展示的分类 chip 算，别把已隐藏的项目类型算进去 */
const typeCount = computed(() => props.groups.reduce((n, g) => n + g.types.length, 0));
</script>

<template>
  <div class="mg-view" :class="{ open: !!sel }">
    <!-- 顶部状态条：模板自带的「金库感」来源，左侧呼吸灯 -->
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('assets.summary', { n: total, k: typeCount }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('assets.kicker') }}</div>
          <div class="page-title">
            {{ allLabel }} <span class="cnt">[ {{ rows.length }} / {{ total }} ]</span>
          </div>
        </div>
        <span class="sp"></span>
        <label class="search">
          <input
            :value="query"
            :placeholder="tr('assets.search.placeholder')"
            @input="emit('query', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <button class="btn" @click="emit('import')">{{ tr('assets.btn.import') }}</button>
        <button class="btn primary" @click="emit('new')">{{ tr('assets.btn.new') }}</button>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="k">{{ tr('assets.stat.total') }}</div>
          <div class="v num">{{ total }}<small>&nbsp;{{ tr('assets.unit.items') }}</small></div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('assets.stat.due') }}</div>
          <div class="v num" :style="dueCount ? 'color:var(--warn)' : ''">{{ dueCount }}<small>&nbsp;{{ tr('assets.unit.items') }}</small></div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('assets.stat.types') }}</div>
          <div class="v num">{{ typeCount }}<small>&nbsp;{{ tr('assets.unit.kinds') }}</small></div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('assets.stat.filter') }}</div>
          <div class="v num">{{ rows.length }}<small>&nbsp;{{ tr('assets.unit.items') }}</small></div>
        </div>
      </div>

      <p v-if="colHint" class="col-hint">{{ colHint }}</p>

      <div class="chips-row">
      <div class="chips">
        <button class="chip" :class="{ on: filter === '' }" @click="emit('filter', '')">
          <i></i>{{ tr('assets.chip.all') }} <span class="c">{{ total }}</span>
        </button>
        <template v-for="g in groups" :key="g.category">
          <span class="chip-cat">{{ g.category || tr('assets.chip.other') }}</span>
          <button
            v-for="t in g.types"
            :key="t.key"
            class="chip"
            :class="{ on: filter === t.key }"
            @click="emit('filter', t.key)"
          >
            <i :style="{ background: colorOf(t.key) }"></i>
            {{ metaOf(t.key).label }}
            <span class="c">{{ counts[t.key] || 0 }}</span>
          </button>
        </template>
        <button class="chip" :class="{ on: filter === 'due' }" @click="emit('filter', 'due')">
          <i style="background: var(--warn)"></i>{{ tr('assets.chip.due') }} <span class="c">{{ dueCount }}</span>
        </button>
      </div>
      <!-- 选完分类就在同一行右边点「列配置」，不用再跑到页头 -->
      <button
        class="col-btn"
        :title="tr('assets.columns.title', { name: filter === 'due' ? tr('assets.chip.due') : metaOf(filter).label || tr('assets.chip.all') })"
        @click="onColcfg"
      >
        {{ tr('assets.btn.columns') }}
      </button>
      <!-- 「＋ 新增资产类型」固定在右侧，不跟着 chips 一起横向滚走 -->
      <button class="chip-add" :title="tr('assets.btn.addType')" @click.stop="onAddType">＋</button>
      </div>

      <div class="tbl" :style="gridStyle">
        <div class="t-head">
          <span>#</span>
          <span>ST</span>
          <span>{{ tr('assets.th.name') }}</span>
          <span v-for="c in columns" :key="c.key">{{ c.label }}</span>
          <span>{{ tr('assets.th.tags') }}</span>
          <span style="text-align: right">{{ tr('assets.th.type') }}</span>
        </div>

        <div
          v-for="(a, i) in rows"
          :key="a.id"
          class="t-row"
          :class="{ sel: selId === a.id, due: isDue(a) }"
          @click="pick(a)"
        >
          <span class="idx num">{{ a.no ?? i + 1 }}</span>
          <!-- 灯就是 .led 自己（和模板一致）：带发光，待轮换时换成警示色并呼吸 -->
          <span
            class="led"
            :style="{
              background: isDue(a) ? 'var(--warn)' : colorOf(a.type),
              boxShadow: '0 0 8px ' + (isDue(a) ? 'var(--warn)' : colorOf(a.type)),
            }"
          ></span>
          <span class="n" :title="a.name || ''">{{ a.name || tr('assets.unnamed') }}</span>
          <span
            v-for="c in columns"
            :key="c.key"
            :class="['meta', { mono: (c as any).mono }]"
            :title="String(c.get(a) ?? '')"
          >{{ c.get(a) || '—' }}</span>
          <span class="tags">
            <i v-for="t in (a.tags || []).slice(0, 2)" :key="t" class="tag">{{ t }}</i>
            <!-- 超出 2 个收敛成「+N」徽章；悬停 title 看全量（docs/资产清单 P3-8） -->
            <i v-if="(a.tags || []).length > 2" class="tag more" :title="(a.tags || []).join(', ')">+{{ (a.tags || []).length - 2 }}</i>
          </span>
          <!-- 类型列和 demo 一致：用类型自己的色（深色高亮/浅色压暗），不是灰字 -->
          <span class="tps" :style="{ color: colorOf(a.type) }">{{ metaOf(a.type).label }}</span>
        </div>

        <div v-if="!rows.length" class="empty">
          <p>{{ tr('assets.empty') }}</p>
          <button class="btn sm" @click="emit('filter', ''); emit('query', '')">{{ tr('assets.empty.clear') }}</button>
        </div>
      </div>
    </div>

    <div class="scrim" @click="closeDrawer"></div>

    <aside v-if="sel" class="drawer">
      <div class="d-head">
        <div class="d-id">
          <i class="dot" :style="{ background: colorOf(sel.type), boxShadow: '0 0 8px ' + colorOf(sel.type) }"></i>
          {{ metaOf(sel.type).label }} — NO.{{ String(sel.no ?? '').padStart(2, '0') }}
        </div>
        <div class="d-title">{{ sel.name || tr('assets.unnamed') }}</div>
        <button class="d-x" :aria-label="tr('assets.btn.close')" @click="closeDrawer">×</button>
      </div>

      <div class="d-body">
        <div class="d-sec">
          <div class="h">{{ tr('assets.detail.fields') }}</div>
          <!-- 抽屉内基础编辑：名称/标签 + 当前展示的字段，改完直接保存 -->
          <div v-if="mode === 'edit'" class="field">
            <div class="k">{{ tr('assets.th.name') }}</div>
            <div class="v"><input v-model="draft.name" class="d-input" /></div>
          </div>
          <div v-if="mode === 'edit'" class="field">
            <div class="k">{{ tr('assets.th.tags') }}</div>
            <div class="v"><input v-model="tagsDraft" class="d-input" :placeholder="tr('assets.edit.tagsHint')" /></div>
          </div>
          <div v-for="f in detailFields" :key="f.k" class="field">
            <div class="k">{{ fieldLabel(f.k) }}</div>
            <!-- title 兜底：截断的长值悬停可见全文；copy 移出 .v 截断流，长值字段也点得到（docs/资产清单 P2-3） -->
            <div class="v">
              <input v-if="mode === 'edit' && !READONLY_KEYS.has(f.k)" v-model="draft[f.k]" class="d-input" />
              <code v-else :title="f.v">{{ f.v }}</code>
            </div>
            <button v-if="mode !== 'edit'" class="copy" @click="copy(f.v, f.k)">{{ tr('assets.btn.copy') }}</button>
          </div>
          <!-- 敏感字段：列表接口已剥离明文，渲染脱敏占位行；要改值走「编辑」（get_asset 全量） -->
          <div v-for="k in [...secretKeys]" :key="'sec-' + k" class="field secret">
            <div class="k">{{ fieldLabel(k) }}</div>
            <div class="v">{{ tr('assets.detail.secret') }}</div>
          </div>
          <div v-if="!detailFields.length && !secretKeys.size" class="field">
            <div class="k">—</div>
            <div class="v">{{ tr('assets.detail.noFields') }}</div>
          </div>
        </div>

        <div v-if="(sel as any).tags?.length" class="d-sec">
          <div class="h">{{ tr('assets.detail.tags') }}</div>
          <div class="tags">
            <i v-for="t in (sel as any).tags" :key="t" class="tag">{{ t }}</i>
          </div>
        </div>

        <div v-if="dueText" class="d-sec">
          <div class="h">{{ tr('assets.detail.rotation') }}</div>
          <div class="field">
            <div class="k">{{ tr('assets.detail.lastRotated') }}</div>
            <div class="v">{{ dueText }}</div>
          </div>
        </div>
      </div>

      <p v-if="saveErr" class="d-err">{{ saveErr }}</p>
      <div class="d-foot">
        <template v-if="mode === 'edit'">
          <button class="act" :disabled="saving" @click="saveQuick">
            {{ saving ? tr('assets.edit.saving') : tr('common.btn.save') }}
          </button>
          <button class="act" :disabled="saving" @click="cancelEdit">{{ tr('common.btn.cancel') }}</button>
          <span class="sp"></span>
          <button class="act" :disabled="saving" @click="advanced">{{ tr('assets.btn.advanced') }}</button>
        </template>
        <template v-else>
          <button class="act" @click="startEdit">{{ tr('assets.btn.edit') }}</button>
          <!-- 直达高级编辑：不用先「编辑」再「高级编辑」绕两道 -->
          <button class="act" @click="advanced">{{ tr('assets.btn.advanced') }}</button>
          <button
            class="act"
            @click="copy(detailFields.map((f) => `${fieldLabel(f.k)}: ${f.v}`).join('\n'), 'all')"
          >{{ copied === 'all' ? tr('assets.btn.copied') : tr('assets.btn.copyAll') }}</button>
          <span class="sp"></span>
          <button class="act danger" @click="emit('remove', sel)">{{ tr('assets.btn.delete') }}</button>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* 根容器自己铺底色：模板的 --bg/--text 只在 #mgui 上定义，
   不铺的话页面是透明的，浅色文字会落在旧的白底上，看起来像「字看不见」 */
[data-mgui] .mg-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}

/* 列宽由父级变量给，表头与行共用一套 */
[data-mgui] .t-head,
[data-mgui] .t-row {
  grid-template-columns: var(--cols);
}

/* 灯在行内要垂直居中（模板只给了 justify-self:center，没有 align-self） */
[data-mgui] .t-row .led {
  align-self: center;
}
/* 待轮换的行：灯呼吸，扫一眼就能找到 */
[data-mgui] .t-row.due .led {
  animation: v-blink 2.4s infinite;
}

[data-mgui] .t-row .n {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-mgui] .d-head .d-id .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 6px;
}

/* 抽屉开合：base.css 的 [data-template] 规则特异性更高，这里必须带上 #mgui */
[data-mgui] .mg-view.open .drawer {
  transform: none;
}
[data-mgui] .mg-view.open .scrim {
  opacity: 1;
  pointer-events: auto;
}

[data-mgui] .copy {
  flex: none;
  opacity: 0;
  transition: opacity 0.12s;
}[data-mgui] .field:hover .copy {
  opacity: 1;
}
/* 脱敏占位行：与 .field .v 同高但弱化，明确告诉用户「这里有个被隐藏的敏感字段」 */
[data-mgui] .field.secret .v {
  color: var(--text-3);
  letter-spacing: 0.08em;
}
/* 筛选行：左边类型横向滚动，右边「＋」固定可见。
   之前把「＋」也塞进滚动区，滚出视野后用户就找不到新增类型的入口了。 */
[data-mgui] .chips-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--s-4);
}
/* 类型全部平铺换行，不再横向滚动：滚出去的类型用户根本找不到 */
[data-mgui] .chips {
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  row-gap: 6px;
  margin-bottom: 0;
}
[data-mgui] .chips::-webkit-scrollbar {
  display: none;
}
[data-mgui] .chips .chip {
  flex: none;
}
/* 分类标题：告诉用户这些类型属于哪一组（要能看清，不能只是装饰） */
[data-mgui] .chip-cat {
  flex: none;
  align-self: center;
  font-size: var(--f-xxs);
  letter-spacing: 0.08em;
  color: var(--text-2);
  padding: 0 4px 0 10px;
  white-space: nowrap;
  border-left: 1px solid var(--line-2);
  margin-right: 2px;
}
[data-mgui] .chip-cat:first-of-type {
  border-left: 0;
  padding-left: 2px;
}
[data-mgui] .chip-add {
  flex: none;
  width: 28px;
  height: var(--chip-h);
  border: 1px solid var(--line-2);
  border-radius: var(--chip-r);
  color: var(--accent);
  font-size: 15px;
  line-height: 1;
  display: grid;
  place-items: center;
}
[data-mgui] .chip-add:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}
[data-mgui] .col-hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--warn);
}
/* 列配置入口：和分类 chips 同一行，选完类型顺手就能点 */
[data-mgui] .col-btn {
  flex: none;
  height: var(--chip-h);
  padding: 0 12px;
  border-radius: var(--chip-r);
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  font-size: var(--f-xs);
  letter-spacing: 0.02em;
}
[data-mgui] .col-btn:hover {
  color: var(--text);
  border-color: var(--line-2-strong);
}

/* 抽屉内基础编辑：输入框铺满值列；错误提示贴在按钮上方 */
[data-mgui] .field .d-input {
  width: 100%;
  min-width: 0;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  padding: 5px 8px;
}
[data-mgui] .field .d-input:focus {
  outline: none;
  border-color: var(--accent);
}
[data-mgui] .d-err {
  flex: none;
  margin: 0;
  padding: 0 var(--s-6) var(--s-3);
  color: var(--warn);
  font-size: var(--f-xs);
}
</style>
