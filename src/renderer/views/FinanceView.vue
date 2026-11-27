<script setup lang="ts">
/**
 * 收支（自有页面，替换 OPC 的 revenue / costs）
 * 数据：collections.revenue、collections.costs
 */
import { computed, onMounted, ref } from 'vue';
import { uiTheme, uiTemplate } from '../ui/appearance';
import { useT } from '../ui/i18n';
import { loadBucket, saveBucket } from './collection-api';

const tr = useT();

type Entry = { id: string; name: string; amount: number; date?: string; category?: string; note?: string };

const revenue = ref<Entry[]>([]);
const costs = ref<Entry[]>([]);
const err = ref('');
const tab = ref<'revenue' | 'costs'>('revenue');
const editing = ref<{ kind: 'revenue' | 'costs'; row: Entry | 'new' } | null>(null);
const form = ref<Entry>(blank());

function blank(): Entry {
  return { id: '', name: '', amount: 0, date: new Date().toISOString().slice(0, 10), category: '', note: '' };
}

async function loadOne(name: string): Promise<Entry[]> {
  return loadBucket<Entry>(name);
}

async function load() {
  try {
    [revenue.value, costs.value] = await Promise.all([loadOne('revenue'), loadOne('costs')]);
  } catch (e: any) {
    err.value = e?.message || tr('fin.err.load');
  }
}

async function persist(name: string, rows: Entry[]) {
  await saveBucket(name, rows);
}

const totalIn = computed(() => revenue.value.reduce((s, r) => s + (Number(r.amount) || 0), 0));
const totalOut = computed(() => costs.value.reduce((s, r) => s + (Number(r.amount) || 0), 0));
const net = computed(() => totalIn.value - totalOut.value);

const rows = computed(() => (tab.value === 'revenue' ? revenue.value : costs.value));

function fmt(n: number): string {
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function openNew() {
  form.value = blank();
  editing.value = { kind: tab.value, row: 'new' };
}

function openEdit(row: Entry) {
  form.value = { ...row };
  editing.value = { kind: tab.value, row };
}

async function save() {
  if (!editing.value) return;
  const { kind } = editing.value;
  const f = { ...form.value, amount: Number(form.value.amount) || 0 };
  if (!f.name.trim()) {
    f.name = tab.value === 'revenue' ? tr('fin.untitledIncome') : tr('fin.untitledExpense');
  }
  const list = kind === 'revenue' ? revenue.value : costs.value;
  let next: Entry[];
  if (editing.value.row === 'new') {
    f.id = kind[0] + Math.random().toString(36).slice(2, 8);
    next = [...list, f];
  } else {
    next = list.map((x) => (x.id === f.id ? f : x));
  }
  if (kind === 'revenue') revenue.value = next;
  else costs.value = next;
  await persist(kind, next);
  editing.value = null;
}

async function remove(row: Entry) {
  const kind = tab.value;
  if (!confirm(tr('fin.confirmDelete', { name: row.name }))) return;
  const list = kind === 'revenue' ? revenue.value : costs.value;
  const next = list.filter((x) => x.id !== row.id);
  if (kind === 'revenue') revenue.value = next;
  else costs.value = next;
  await persist(kind, next);
}

onMounted(load);
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('fin.count', { n: revenue.length + costs.length }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('fin.kicker') }}</div>
          <div class="page-title">{{ tr('fin.title') }}</div>
        </div>
        <span class="sp"></span>
        <button class="btn primary" @click="openNew">{{ tab === 'revenue' ? tr('fin.newIncome') : tr('fin.newExpense') }}</button>
      </div>

      <p v-if="err" class="err">{{ err }}</p>

      <div class="stats">
        <div class="stat">
          <div class="k">{{ tr('fin.totalIn') }}</div>
          <div class="v num" style="color: var(--ok)">{{ fmt(totalIn) }}</div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('fin.totalOut') }}</div>
          <div class="v num" style="color: var(--danger)">{{ fmt(totalOut) }}</div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('fin.balance') }}</div>
          <div class="v num" :style="{ color: net >= 0 ? 'var(--accent)' : 'var(--danger)' }">{{ fmt(net) }}</div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('fin.records') }}</div>
          <div class="v num">{{ tr('fin.recordsSplit', { n: revenue.length, k: costs.length }) }}</div>
        </div>
      </div>

      <div class="chips-row">
        <div class="chips">
          <button class="chip" :class="{ on: tab === 'revenue' }" @click="tab = 'revenue'">
            <i style="background: var(--ok)"></i>{{ tr('fin.income') }} <span class="c">{{ revenue.length }}</span>
          </button>
          <button class="chip" :class="{ on: tab === 'costs' }" @click="tab = 'costs'">
            <i style="background: var(--danger)"></i>{{ tr('fin.expense') }} <span class="c">{{ costs.length }}</span>
          </button>
        </div>
      </div>

      <div v-if="rows.length" class="tbl" style="--cols: 150px minmax(0, 1.4fr) 140px 120px minmax(0, 1fr) 96px">
        <div class="t-head">
          <span>{{ tr('fin.th.date') }}</span>
          <span>{{ tr('fin.th.name') }}</span>
          <span>{{ tr('fin.th.amount') }}</span>
          <span>{{ tr('fin.th.category') }}</span>
          <span>{{ tr('fin.th.note') }}</span>
          <span style="text-align:right">{{ tr('fin.th.actions') }}</span>
        </div>
        <div v-for="r in rows" :key="r.id" class="t-row">
          <span class="meta mono">{{ r.date || '—' }}</span>
          <span class="n">{{ r.name }}</span>
          <span class="amount num" :style="{ color: tab === 'revenue' ? 'var(--ok)' : 'var(--danger)' }">
            {{ tab === 'revenue' ? '+' : '−' }}{{ fmt(Number(r.amount) || 0).slice(1) }}
          </span>
          <span class="meta">{{ r.category || '—' }}</span>
          <span class="meta" :title="r.note">{{ r.note || '—' }}</span>
          <span class="ops">
            <button @click="openEdit(r)">{{ tr('assets.btn.edit') }}</button>
            <button class="del" @click="remove(r)">{{ tr('assets.btn.delete') }}</button>
          </span>
        </div>
      </div>

      <div v-else class="empty">
        <p>{{ tab === 'revenue' ? tr('fin.emptyIncome') : tr('fin.emptyExpense') }}</p>
        <button class="btn sm" @click="openNew">{{ tr('fin.newShort') }}</button>
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
        <div class="box fin-form">
          <header class="if-head">
            <h3>{{ editing.row === 'new' ? tr('fin.recordNew') : tr('fin.recordEdit') }}</h3>
            <button class="if-x" @click="editing = null">×</button>
          </header>
          <label class="set-field"><span>{{ tr('fin.th.name') }}</span><input v-model="form.name" :placeholder="tr('fin.ph.name')" /></label>
          <label class="set-field"><span>{{ tr('fin.th.amount') }}</span><input v-model.number="form.amount" type="number" step="0.01" /></label>
          <label class="set-field"><span>{{ tr('fin.th.date') }}</span><input v-model="form.date" type="date" /></label>
          <label class="set-field"><span>{{ tr('fin.th.category') }}</span><input v-model="form.category" :placeholder="tr('fin.ph.category')" /></label>
          <label class="set-field"><span>{{ tr('fin.th.note') }}</span><input v-model="form.note" /></label>
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
.t-row .mono {
  font-family: var(--font-mono);
  font-size: var(--f-xs);
  color: var(--text-3);
}
.t-row .meta {
  font-size: var(--f-xs);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.amount {
  font-family: var(--font-mono);
  font-size: var(--f-sm);
  font-weight: 600;
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

.fin-form {
  width: min(460px, 94vw);
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
.if-x:hover {
  background: var(--hover);
  color: var(--text);
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
.set-field input {
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
