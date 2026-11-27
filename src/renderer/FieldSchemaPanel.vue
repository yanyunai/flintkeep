<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useT } from './ui/i18n';

const tr = useT();
import { BUILTIN_FIELDS, FIELD_KINDS } from '../core/builtin-fields';
import { fieldKindLabel, typeLabel as schemaTypeLabel, categoryLabel } from '../core/schema';
import type { CustomField, FieldOverride, FieldSchema } from '../core/field-schema';

const emit = defineEmits<{ saved: [] }>();

type TypeDef = { key: string; label: string; category: string; color?: string; builtin: boolean };

const rootEl = ref<HTMLElement | null>(null);
const schema = ref<FieldSchema>({ version: 1, overrides: {}, custom: [] });
const typeDefs = ref<TypeDef[]>([]);
const scope = ref('server');
const msg = ref('');
const err = ref('');
const busy = ref(false);
const typeMsg = ref('');
const typeErr = ref('');
const typeEdit = ref({ label: '', category: '', color: '#e8eef5' });

const kinds = FIELD_KINDS;

/** 内置类型按 key 走字典，自定义类型用后端 label（用户自定义，不翻译） */
function typeDefLabel(t: TypeDef): string {
  return t.builtin ? schemaTypeLabel(t.key) : t.label;
}
const currentType = computed(() => typeDefs.value.find((t) => t.key === scope.value));
const typeCategories = computed(() => [...new Set(typeDefs.value.map((t) => t.category).filter(Boolean))]);

function syncTypeEdit() {
  const t = currentType.value;
  typeEdit.value = { label: t?.label || '', category: t?.category || '', color: t?.color || '#e8eef5' };
}
watch(scope, syncTypeEdit);

async function load() {
  try {
    const r = await fetch('/api/field-schema').then((x) => x.json());
    if (r && r.version === 1) schema.value = r;
  } catch {
    /* 旧服务端无此接口时保持空定义 */
  }
  try {
    const r = await fetch('/api/asset-types').then((x) => x.json());
    if (Array.isArray(r?.types)) typeDefs.value = r.types;
  } catch {
    /* 旧服务端无类型接口时只显示内置字段 */
  }
  syncTypeEdit();
  syncLabelDraft();
  syncOptDraft();
}

function ovOf(s: string, k: string): FieldOverride {
  return schema.value.overrides?.[s]?.[k] || {};
}

/**
 * 内置字段显示名的输入草稿：'scope:key' -> 显示名。
 * 用 v-model 绑草稿而不是「:value + @input 回写 overrides」——
 * 后者每次按键都把 DOM 值重新写一遍，中文输入法组字会被打断（两个字一停）。
 * 草稿在保存时才合并进 overrides。
 */
const labelDraft = ref<Record<string, string>>({});
function labelKey(s: string, k: string) {
  return s + ':' + k;
}
function syncLabelDraft() {
  const next: Record<string, string> = { ...labelDraft.value };
  for (const [s, m] of Object.entries(schema.value.overrides || {})) {
    for (const [k, ov] of Object.entries(m || {})) {
      if (ov && typeof ov.label === 'string' && ov.label) next[labelKey(s, k)] = ov.label;
    }
  }
  labelDraft.value = next;
}
function setOv(s: string, k: string, patch: FieldOverride) {
  if (!schema.value.overrides[s]) schema.value.overrides[s] = {};
  schema.value.overrides[s][k] = { ...ovOf(s, k), ...patch };
}

const builtinFields = computed(() => BUILTIN_FIELDS[scope.value] || []);
const customFields = computed(() => schema.value.custom.filter((f) => f.scope === scope.value || f.scope === '*'));

function addField() {
  msg.value = '';
  err.value = '';
  const f: any = {
    key: '',
    label: '',
    scope: scope.value,
    kind: 'text',
    list: true,
    form: true,
  };
  schema.value.custom.push(f);
  // 新增后直接聚焦到「显示名」，不用再点一下才能输入
  nextTick(() => {
    const uid = ensureUid(f);
    rootEl.value?.querySelector<HTMLInputElement>(`input[data-uid="${uid}"]`)?.focus();
  });
}

/**
 * 行标识：不能用 label / key 当 v-for 的 key。
 * 新建字段时 key 为空、label 每敲一个字都会变，key 一变 Vue 就销毁重建这一行，
 * 输入框失焦、中文输入法组字被打断 → 只能两个字两个字地输入。
 * 这里给每个字段对象挂一个稳定的 uid（WeakMap，不写进提交的数据）。
 */
let uidSeq = 0;
const uidMap = new WeakMap<object, string>();
function ensureUid(f: any): string {
  let uid = uidMap.get(f);
  if (!uid) {
    uid = 'f' + ++uidSeq;
    uidMap.set(f, uid);
  }
  return uid;
}

function removeField(f: CustomField) {
  schema.value.custom = schema.value.custom.filter((x) => x !== f);
}

/** 下拉字段选项的输入草稿（uid -> 'a,b'），同样避免回写打断输入法 */
const optDraft = ref<Record<string, string>>({});
function syncOptDraft() {
  const next: Record<string, string> = { ...optDraft.value };
  for (const f of schema.value.custom) {
    const uid = ensureUid(f);
    if (!(uid in next)) next[uid] = (f.options || []).join(',');
  }
  optDraft.value = next;
}
function commitOptionsDraft() {
  for (const f of schema.value.custom) {
    const uid = ensureUid(f);
    const raw = optDraft.value[uid];
    if (raw === undefined) continue;
    f.options = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

async function save() {
  msg.value = '';
  err.value = '';
  busy.value = true;
  try {
    commitOptionsDraft();
    // 把显示名草稿合并进 overrides（留空 = 用默认名）
    const overrides: Record<string, Record<string, FieldOverride>> = JSON.parse(
      JSON.stringify(schema.value.overrides || {})
    );
    for (const [kk, raw] of Object.entries(labelDraft.value)) {
      const i = kk.indexOf(':');
      const s = kk.slice(0, i);
      const k = kk.slice(i + 1);
      const label = String(raw ?? '').trim();
      if (!overrides[s]) overrides[s] = {};
      const one = { ...(overrides[s][k] || {}) } as FieldOverride;
      if (label) one.label = label;
      else delete one.label;
      if (Object.keys(one).length) overrides[s][k] = one;
      else delete overrides[s][k];
    }

    const res = await fetch('/api/field-schema', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides, custom: schema.value.custom }),
    });
    const j = await res.json();
    if (!res.ok) {
      err.value = j.error || tr('fsp.err.save');
      return;
    }
    schema.value = j;
    syncLabelDraft();
    msg.value = tr('fsp.msg.saved');
    emit('saved');
  } catch (e: any) {
    err.value = e.message || tr('fsp.err.request');
  } finally {
    busy.value = false;
  }
}

async function saveTypeMeta() {
  const t = currentType.value;
  if (!t || t.builtin) return;
  typeMsg.value = '';
  typeErr.value = '';
  const res = await fetch(`/api/asset-types/${encodeURIComponent(t.key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: typeEdit.value.label,
      category: typeEdit.value.category,
      color: typeEdit.value.color,
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    typeErr.value = j.error || tr('fsp.err.save');
    return;
  }
  typeMsg.value = tr('fsp.msg.typeSaved');
  await load();
  emit('saved');
}

async function removeType() {
  const t = currentType.value;
  if (!t || t.builtin) return;
  if (!confirm(tr('fsp.confirm.removeType', { name: t.label }))) return;
  typeMsg.value = '';
  typeErr.value = '';
  const res = await fetch(`/api/asset-types/${encodeURIComponent(t.key)}`, { method: 'DELETE' });
  const j = await res.json();
  if (!res.ok) {
    typeErr.value = j.error || tr('fsp.err.remove');
    return;
  }
  scope.value = 'server';
  await load();
  emit('saved');
}

onMounted(load);
</script>

<template>
  <article ref="rootEl" class="card">
    <h3>{{ tr('fsp.title') }}</h3>
    <p class="sub">{{ tr('fsp.hint') }}</p>

    <div class="fs-bar">
      <label>{{ tr('fsp.pickType') }}
        <select v-model="scope">
          <option v-for="t in typeDefs" :key="t.key" :value="t.key">{{ typeDefLabel(t) }}</option>
          <option value="*">{{ tr('fsp.allTypes') }}</option>
        </select>
      </label>
      <button class="btn primary" :disabled="busy" @click="save">{{ busy ? tr('fsp.saving') : tr('fsp.save') }}</button>
    </div>
    <p v-if="msg" class="fs-ok">{{ msg }}</p>
    <p v-if="err" class="fs-err">{{ err }}</p>

    <div v-if="currentType" class="fs-type-meta">
      <template v-if="!currentType.builtin">
        <span class="fs-type-tag">{{ tr('fsp.customType') }}</span>
        <input v-model="typeEdit.label" :placeholder="tr('fsp.ph.displayName')" />
        <input v-model="typeEdit.category" list="fs-type-cats" :placeholder="tr('fsp.ph.category')" />
        <input v-model="typeEdit.color" type="color" class="fs-color" />
        <button class="fs-add" @click="saveTypeMeta">{{ tr('fsp.saveType') }}</button>
        <button class="fs-del" @click="removeType">{{ tr('fsp.removeType') }}</button>
      </template>
      <template v-else>
        <span class="fs-type-tag">{{ tr('fsp.builtinType') }}</span>
        <span class="fs-none">{{ tr('fsp.builtinNote', { category: categoryLabel(currentType.category) }) }}</span>
      </template>
    </div>
    <p v-if="typeMsg" class="fs-ok">{{ typeMsg }}</p>
    <p v-if="typeErr" class="fs-err">{{ typeErr }}</p>
    <datalist id="fs-type-cats">
      <option v-for="c in typeCategories" :key="c" :value="c" />
    </datalist>

    <template v-if="scope !== '*'">
      <h4 class="fs-h4">{{ tr('fsp.builtinFields') }}</h4>
      <table v-if="builtinFields.length" class="fs-tbl builtin">
        <thead>
          <tr><th>{{ tr('fsp.th.label') }}</th><th>{{ tr('fsp.th.asColumn') }}</th><th>{{ tr('fsp.th.inForm') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="f in builtinFields" :key="f.key">
            <td>
              <input
                v-model="labelDraft[labelKey(scope, f.key)]"
                :placeholder="f.label"
              />
            </td>
            <td class="fs-center">
              <input
                type="checkbox"
                :checked="ovOf(scope, f.key).list !== false"
                @change="setOv(scope, f.key, { list: ($event.target as HTMLInputElement).checked })"
              />
            </td>
            <td class="fs-center">
              <input
                type="checkbox"
                :checked="ovOf(scope, f.key).form !== false"
                @change="setOv(scope, f.key, { form: ($event.target as HTMLInputElement).checked })"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="fs-none">{{ tr('fsp.noBuiltin') }}</p>
    </template>

    <h4 class="fs-h4">
      {{ tr('fsp.customFields') }}
      <button class="fs-add" type="button" @click="addField">{{ tr('fsp.addField') }}</button>
    </h4>
    <table v-if="customFields.length" class="fs-tbl custom">
      <thead>
        <tr><th>{{ tr('fsp.th.labelShort') }}</th><th>{{ tr('fsp.th.kind') }}</th><th>{{ tr('fsp.th.options') }}</th><th>{{ tr('fsp.th.secret') }}</th><th>{{ tr('fsp.th.asColumn') }}</th><th>{{ tr('fsp.th.inForm') }}</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="f in customFields" :key="ensureUid(f)">
          <td>
            <input v-model="f.label" :data-uid="ensureUid(f)" :placeholder="tr('fsp.ph.fieldLabel')" />
          </td>
          <td>
            <select v-model="f.kind">
              <option v-for="k in kinds" :key="k" :value="k">{{ fieldKindLabel(k) }}</option>
            </select>
          </td>
          <td>
            <input
              v-if="f.kind === 'select'"
              v-model="optDraft[ensureUid(f)]"
              :placeholder="tr('fsp.ph.options')"
            />
            <span v-else class="fs-none">—</span>
          </td>
          <td class="fs-center"><input v-model="f.secret" type="checkbox" /></td>
          <td class="fs-center"><input v-model="f.list" type="checkbox" /></td>
          <td class="fs-center"><input v-model="f.form" type="checkbox" /></td>
          <td><button class="fs-del" type="button" @click="removeField(f)">{{ tr('assets.btn.delete') }}</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="fs-none">{{ tr('fsp.noCustom') }}</p>

    <p class="fs-tip">{{ tr('fsp.tip') }}</p>
  </article>
</template>

<style scoped>
.fs-bar { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.fs-bar label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-2); }
.fs-bar select { padding: 7px 9px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface); color: var(--text); }
/* 扁平化：本面板嵌在 SettingsPanel 的 .set-card 内，App.vue 全局 .card（玻璃底 + 边框 +
 * 18px 圆角 + 外阴影 + 内圈高光）会在这里形成白卡套白卡。全部去掉，只保留内容排版与分组间距。
 * 编译后为 article.card[data-v-xxx]，比 [data-theme='dark'] .card 高一级，不依赖样式注入顺序。 */
article.card {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  padding: 0;
  margin: 0;
}
/* 保存按钮改走 base.css 的语义 .btn.primary（obs/atlas 模板覆盖同款，颜色跟随模板令牌），仅补禁用态 */
.fs-bar .btn.primary:disabled { opacity: .6; cursor: default; }
.fs-ok { color: var(--ok); font-size: 12.5px; margin: 6px 0; }
.fs-err { color: var(--danger); font-size: 12.5px; margin: 6px 0; }
.fs-type-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0 4px; padding: 8px 10px; border: 1px dashed var(--border-strong); border-radius: 8px; }
.fs-type-tag { font-size: 11px; color: var(--text-3); }
.fs-type-meta input:not([type='checkbox']) { padding: 5px 7px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 12.5px; width: 130px; }
.fs-type-meta .fs-color { width: 48px; padding: 2px; }
.fs-h4 { display: flex; align-items: center; gap: 10px; margin: 18px 0 8px; font-size: 13px; color: var(--text); }
.fs-add { padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 12px; cursor: pointer; }
.fs-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fs-tbl th, .fs-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.fs-tbl th { color: var(--text-3); font-weight: 600; font-size: 11.5px; background: var(--surface-2); }
.fs-tbl input:not([type='checkbox']), .fs-tbl select {
  width: 100%; padding: 5px 7px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface); color: var(--text); font-size: 12.5px;
}
/* 勾选框跟随主题强调色（docs/设置页 F9）：面板两种模式下都挂 mg-token，但经典分支没有 checkbox 规则，这里自兜底 */
input[type='checkbox'] { accent-color: var(--accent, #2f7ff0); }
.fs-center { text-align: center; }
.fs-defname { color: var(--text-3); font-size: 12px; white-space: nowrap; }
/* 列宽：勾选列固定窄，输入列吃掉剩余宽度 */
.fs-tbl.builtin { table-layout: fixed; }
.fs-tbl.builtin th:nth-child(2), .fs-tbl.builtin td:nth-child(2),
.fs-tbl.builtin th:nth-child(3), .fs-tbl.builtin td:nth-child(3) { width: 88px; }
.fs-tbl.custom { table-layout: fixed; }
.fs-tbl.custom th:nth-child(2), .fs-tbl.custom td:nth-child(2) { width: 108px; }
.fs-tbl.custom th:nth-child(3), .fs-tbl.custom td:nth-child(3) { width: 170px; }
.fs-tbl.custom th:nth-child(4), .fs-tbl.custom td:nth-child(4),
.fs-tbl.custom th:nth-child(5), .fs-tbl.custom td:nth-child(5),
.fs-tbl.custom th:nth-child(6), .fs-tbl.custom td:nth-child(6) { width: 72px; }
.fs-tbl.custom th:nth-child(7), .fs-tbl.custom td:nth-child(7) { width: 66px; }
.fs-none { color: var(--text-3); font-size: 12px; margin: 4px 0; }
.fs-del { border: 1px solid var(--line-2); background: var(--surface); color: var(--danger); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
.fs-tip { margin: 12px 0 0; font-size: 12px; color: var(--text-3); }
</style>
