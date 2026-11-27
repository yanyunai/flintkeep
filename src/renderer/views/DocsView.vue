<script setup lang="ts">
/**
 * 资料证书（自有页面，替换 OPC 的 docs 页）
 * 数据：collections.docs
 */
import { computed, onMounted, ref } from 'vue';
import { uiTheme, uiTemplate } from '../ui/appearance';
import { useT } from '../ui/i18n';
import { loadBucket, saveBucket } from './collection-api';

const tr = useT();

type Doc = {
  id: string;
  name: string;
  kind?: string;
  no?: string;
  expires?: string;
  owner?: string;
  note?: string;
  url?: string;
};

/** 存的是中文（历史数据），展示时按语言翻译 */
const KINDS = ['证书', '合同', '资质', '资料', '其他'] as const;
const KIND_KEY: Record<string, string> = { 证书: 'cert', 合同: 'contract', 资质: 'licence', 资料: 'doc', 其他: 'other' };
function kindLabel(k: string): string {
  const key = KIND_KEY[k];
  return key ? tr(('doc.kind.' + key) as any) : k;
}

const docs = ref<Doc[]>([]);
const err = ref('');
const filter = ref('');
const q = ref('');
const editing = ref<Doc | 'new' | null>(null);
const form = ref<Doc>(blank());

function blank(): Doc {
  return { id: '', name: '', kind: '证书', no: '', expires: '', owner: '', note: '', url: '' };
}

async function load() {
  try {
    docs.value = await loadBucket<Doc>('docs');
  } catch (e: any) {
    err.value = e?.message || tr('doc.err.load');
  }
}

async function persist() {
  await saveBucket('docs', docs.value);
}

function daysLeft(d?: string): number | null {
  if (!d) return null;
  const t = new Date(d + 'T00:00:00').getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

function expClass(d?: string): string {
  const n = daysLeft(d);
  if (n === null) return '';
  if (n < 0) return 'bad';
  if (n <= 30) return 'warn';
  return '';
}

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase();
  return docs.value.filter((d) => {
    if (filter.value && (d.kind || '证书') !== filter.value) return false;
    if (!k) return true;
    return [d.name, d.no, d.owner, d.note].some((v) => String(v || '').toLowerCase().includes(k));
  });
});

const expiring = computed(() => docs.value.filter((d) => {
  const n = daysLeft(d.expires);
  return n !== null && n >= 0 && n <= 30;
}).length);
const expired = computed(() => docs.value.filter((d) => {
  const n = daysLeft(d.expires);
  return n !== null && n < 0;
}).length);

function openUrl(url?: string) {
  if (url) window.open(url, '_blank');
}

function openNew() {
  form.value = blank();
  editing.value = 'new';
}
function openEdit(d: Doc) {
  form.value = { ...d };
  editing.value = d;
}

async function save() {
  const f = { ...form.value };
  if (!f.name.trim()) f.name = tr('doc.untitled');
  if (editing.value === 'new') {
    f.id = 'd' + Math.random().toString(36).slice(2, 8);
    docs.value = [...docs.value, f];
  } else {
    docs.value = docs.value.map((d) => (d.id === f.id ? f : d));
  }
  await persist();
  editing.value = null;
}

async function remove(d: Doc) {
  if (!confirm(tr('doc.confirmDelete', { name: d.name }))) return;
  docs.value = docs.value.filter((x) => x.id !== d.id);
  await persist();
  editing.value = null;
}

onMounted(load);
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('doc.summary', { n: docs.length, soon: expiring }) }}{{ expired ? tr('doc.summaryExpired', { n: expired }) : '' }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('doc.kicker') }}</div>
          <div class="page-title">{{ tr('doc.title') }} <span class="cnt">[ {{ docs.length }} ]</span></div>
        </div>
        <span class="sp"></span>
        <button class="btn primary" @click="openNew">{{ tr('doc.new') }}</button>
      </div>

      <p v-if="err" class="err">{{ err }}</p>

      <div class="chips-row">
        <div class="chips">
          <button class="chip" :class="{ on: filter === '' }" @click="filter = ''">
            {{ tr('doc.all') }} <span class="c">{{ docs.length }}</span>
          </button>
          <button v-for="k in KINDS" :key="k" class="chip" :class="{ on: filter === k }" @click="filter = k">
            {{ kindLabel(k) }} <span class="c">{{ docs.filter((d) => (d.kind || '证书') === k).length }}</span>
          </button>
        </div>
        <input v-model="q" class="doc-search" :placeholder="tr('doc.searchPh')" />
      </div>

      <div v-if="filtered.length" class="tbl" style="--cols: minmax(0, 1.5fr) 90px 150px 130px minmax(0, 1fr) 96px">
        <div class="t-head">
          <span>{{ tr('doc.th.name') }}</span><span>{{ tr('doc.th.kind') }}</span><span>{{ tr('doc.th.no') }}</span><span>{{ tr('doc.th.expires') }}</span><span>{{ tr('doc.th.note') }}</span>
          <span style="text-align:right">{{ tr('doc.th.actions') }}</span>
        </div>
        <div v-for="d in filtered" :key="d.id" class="t-row">
          <span class="n" :title="d.name">{{ d.name }}</span>
          <span class="meta"><i class="tag">{{ kindLabel(d.kind || '证书') }}</i></span>
          <span class="meta mono">{{ d.no || '—' }}</span>
          <span class="meta mono" :class="expClass(d.expires)">
            {{ d.expires || '—' }}
            <em v-if="daysLeft(d.expires) !== null" class="dl">
              {{ daysLeft(d.expires)! < 0 ? tr('doc.expired') : tr('doc.days', { n: daysLeft(d.expires) }) }}
            </em>
          </span>
          <span class="meta" :title="d.note">{{ d.note || '—' }}</span>
          <span class="ops">
            <button v-if="d.url" @click="openUrl(d.url)">{{ tr('doc.open') }}</button>
            <button @click="openEdit(d)">{{ tr('assets.btn.edit') }}</button>
            <button class="del" @click="remove(d)">{{ tr('assets.btn.delete') }}</button>
          </span>
        </div>
      </div>

      <div v-else class="empty">
        <p>{{ docs.length ? tr('doc.emptyFilter') : tr('doc.empty') }}</p>
        <button class="btn sm" @click="openNew">{{ tr('doc.new') }}</button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="editing"
        class="modal mg-modal mg-center"
        data-mgui
        :data-template="uiTemplate"
        :data-theme="uiTheme"
        @click.self="editing = null"
      >
        <div class="box doc-form">
          <header class="if-head">
            <h3>{{ editing === 'new' ? tr('doc.new') : tr('doc.edit') }}</h3>
            <button class="if-x" @click="editing = null">×</button>
          </header>
          <label class="set-field"><span>{{ tr('doc.th.name') }}</span><input v-model="form.name" :placeholder="tr('doc.ph.name')" /></label>
          <label class="set-field"><span>{{ tr('doc.th.kind') }}</span>
            <select v-model="form.kind">
              <option v-for="k in KINDS" :key="k" :value="k">{{ kindLabel(k) }}</option>
            </select>
          </label>
          <label class="set-field"><span>{{ tr('doc.f.no') }}</span><input v-model="form.no" /></label>
          <label class="set-field"><span>{{ tr('doc.f.expires') }}</span><input v-model="form.expires" type="date" /></label>
          <label class="set-field"><span>{{ tr('doc.f.owner') }}</span><input v-model="form.owner" /></label>
          <label class="set-field"><span>{{ tr('doc.f.url') }}</span><input v-model="form.url" :placeholder="tr('doc.ph.url')" /></label>
          <label class="set-field"><span>{{ tr('doc.th.note') }}</span><input v-model="form.note" /></label>
          <footer class="if-foot">
            <span class="sp"></span>
            <button class="btn" @click="editing = null">{{ tr('common.btn.cancel') }}</button>
            <button class="btn primary" @click="save">{{ tr('common.btn.save') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
[data-mgui] .mg-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}
.err {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--danger);
}
.doc-search {
  flex: none;
  width: 220px;
  height: var(--chip-h);
  padding: 0 10px;
  border-radius: var(--chip-r);
  border: 1px solid var(--line-2);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
}
.t-head,
.t-row {
  grid-template-columns: var(--cols);
  gap: 12px;
}
.t-row {
  align-items: center;
}
.t-row .n {
  font-size: var(--f-sm);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-row .meta {
  font-size: var(--f-xs);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-row .mono {
  font-family: var(--font-mono);
  font-size: var(--f-xs);
}
.t-row .tag {
  font-style: normal;
  font-size: var(--f-xxs);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-2);
}
.t-row .warn {
  color: var(--warn);
}
.t-row .bad {
  color: var(--danger);
}
.dl {
  margin-left: 4px;
  font-style: normal;
  font-size: var(--f-xxs);
  opacity: 0.85;
}
.ops {
  display: flex;
  gap: 2px;
  justify-content: flex-end;
}
.ops button {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: var(--f-xs);
  padding: 2px 6px;
  border-radius: 5px;
}
.ops button:hover {
  background: var(--hover);
  color: var(--accent);
}
.ops .del:hover {
  color: var(--danger);
}
.sp {
  flex: 1;
}

.doc-form {
  width: min(480px, 94vw);
  padding: 18px 20px;
}
.if-head {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
}
.if-head h3 {
  margin: 0;
  font-size: var(--f-lg);
  color: var(--text);
}
.if-x {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 16px;
}
.set-field {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.set-field > span {
  font-size: 12px;
  color: var(--text-3);
}
.set-field input,
.set-field select {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text);
  font-size: var(--f-sm);
}
.if-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
</style>
