<script setup lang="ts">
/**
 * 迭代任务（自有页面，替换 OPC 的 tasks 页）
 * 数据：collections.tasks
 */
import { computed, onMounted, ref } from 'vue';
import { uiTheme, uiTemplate } from '../ui/appearance';
import { useT } from '../ui/i18n';
import { loadBucket, saveBucket } from './collection-api';

const tr = useT();

type Task = {
  id: string;
  title: string;
  desc?: string;
  project?: string;
  status: '待办' | '进行中' | '已完成';
  priority?: '高' | '中' | '低';
  due?: string;
};

/** 存的是中文（历史数据），展示时按语言翻译 */
const STATUSES = ['待办', '进行中', '已完成'] as const;
const PRIORITIES = ['高', '中', '低'] as const;
const STATUS_KEY: Record<string, string> = { 待办: 'todo', 进行中: 'doing', 已完成: 'done' };
const PRIORITY_KEY: Record<string, string> = { 高: 'high', 中: 'mid', 低: 'low' };
function statusText(s: string): string {
  const k = STATUS_KEY[s];
  return k ? tr(('task.st.' + k) as any) : s;
}
function priorityText(p: string): string {
  const k = PRIORITY_KEY[p];
  return k ? tr(('task.pr.' + k) as any) : p;
}

const tasks = ref<Task[]>([]);
const err = ref('');
const filter = ref<string>('');
const editing = ref<Task | 'new' | null>(null);
const form = ref<Task>(blank());
const toast = ref('');

function blank(): Task {
  return { id: '', title: '', desc: '', project: '', status: '待办', priority: '中', due: '' };
}

async function load() {
  try {
    tasks.value = await loadBucket<Task>('tasks');
  } catch (e: any) {
    err.value = e?.message || tr('task.err.load');
  }
}

async function persist() {
  await saveBucket('tasks', tasks.value);
}

const counts = computed(() => {
  const c: Record<string, number> = { '': tasks.value.length };
  for (const s of STATUSES) c[s] = tasks.value.filter((t) => t.status === s).length;
  return c;
});

const filtered = computed(() => (filter.value ? tasks.value.filter((t) => t.status === filter.value) : tasks.value));

/** 按状态分组；未筛选时三组都显示，筛选时只显示那一组 */
const groups = computed(() =>
  STATUSES.filter((s) => !filter.value || filter.value === s).map((s) => ({
    status: s,
    items: filtered.value.filter((t) => t.status === s),
  }))
);

function openNew() {
  form.value = blank();
  editing.value = 'new';
}

function openEdit(t: Task) {
  form.value = { ...t };
  editing.value = t;
}

async function save() {
  const title = form.value.title.trim();
  if (!title) {
    toast.value = tr('task.needTitle');
    setTimeout(() => (toast.value = ''), 1800);
    return;
  }
  const f = { ...form.value, title };
  if (editing.value === 'new') {
    f.id = 't' + Math.random().toString(36).slice(2, 8);
    tasks.value = [...tasks.value, f];
  } else {
    tasks.value = tasks.value.map((t) => (t.id === f.id ? f : t));
  }
  await persist();
  editing.value = null;
}

async function setStatus(t: Task, s: Task['status']) {
  t.status = s;
  await persist();
}

async function remove(t: Task) {
  if (!confirm(tr('task.confirmDelete', { title: t.title }))) return;
  tasks.value = tasks.value.filter((x) => x.id !== t.id);
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
      <span>{{ tr('task.summary', { n: counts[''], doing: counts['进行中'] || 0 }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('task.kicker') }}</div>
          <div class="page-title">{{ tr('task.title') }} <span class="cnt">[ {{ tasks.length }} ]</span></div>
        </div>
        <span class="sp"></span>
        <button class="btn primary" @click="openNew">{{ tr('task.new') }}</button>
      </div>

      <p v-if="toast" class="toast">{{ toast }}</p>
      <p v-if="err" class="err">{{ err }}</p>

      <div class="chips-row">
        <div class="chips">
          <button class="chip" :class="{ on: filter === '' }" @click="filter = ''">
            {{ tr('task.all') }} <span class="c">{{ counts[''] }}</span>
          </button>
          <button
            v-for="s in STATUSES"
            :key="s"
            class="chip"
            :class="{ on: filter === s }"
            @click="filter = s"
          >
            <i :style="{ background: s === '待办' ? 'var(--text-3)' : s === '进行中' ? 'var(--info)' : 'var(--ok)' }"></i>
            {{ statusText(s) }} <span class="c">{{ counts[s] || 0 }}</span>
          </button>
        </div>
      </div>

      <div v-if="tasks.length" class="task-grid">
        <section v-for="g in groups" :key="g.status" class="task-col">
          <header>
            <i :style="{ background: g.status === '待办' ? 'var(--text-3)' : g.status === '进行中' ? 'var(--info)' : 'var(--ok)' }"></i>
            <span>{{ statusText(g.status) }}</span>
            <em>{{ g.items.length }}</em>
          </header>
          <div v-if="g.items.length" class="task-list">
            <article v-for="t in g.items" :key="t.id" class="task">
              <div class="t-main" @click="openEdit(t)">
                <h4 :title="t.title">{{ t.title }}</h4>
                <p v-if="t.desc" class="t-desc">{{ t.desc }}</p>
                <div class="t-meta">
                  <span v-if="t.project" class="tag">{{ t.project }}</span>
                  <span v-if="t.priority" class="pri" :class="'p-' + t.priority">{{ priorityText(t.priority) }}</span>
                  <span v-if="t.due" class="due num">{{ t.due }}</span>
                </div>
              </div>
              <footer>
                <select :value="t.status" @change="setStatus(t, ($event.target as HTMLSelectElement).value as any)">
                  <option v-for="s in STATUSES" :key="s" :value="s">{{ statusText(s) }}</option>
                </select>
                <button class="del" @click="remove(t)">{{ tr('assets.btn.delete') }}</button>
              </footer>
            </article>
          </div>
          <p v-else class="col-empty">{{ tr('task.emptyCol') }}</p>
        </section>
      </div>

      <div v-else class="empty">
        <p>{{ tr('task.empty') }}</p>
        <button class="btn sm" @click="openNew">{{ tr('task.new') }}</button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="editing"
        class="modal"
        :class="['mg-modal', 'mg-center']"
        data-mgui
        :data-template="uiTemplate"
        :data-theme="uiTheme"
        @click.self="editing = null"
      >
        <div class="box task-form">
          <header class="if-head">
            <h3>{{ editing === 'new' ? tr('task.new') : tr('task.edit') }}</h3>
            <button class="if-x" @click="editing = null">×</button>
          </header>
          <label class="set-field"><span>{{ tr('task.f.title') }}</span><input v-model="form.title" :placeholder="tr('task.f.titlePh')" @keyup.enter="save" /></label>
          <label class="set-field"><span>{{ tr('task.f.desc') }}</span><textarea v-model="form.desc" rows="2" :placeholder="tr('task.f.optionalPh')"></textarea></label>
          <label class="set-field"><span>{{ tr('task.f.project') }}</span><input v-model="form.project" :placeholder="tr('task.f.optionalPh')" /></label>
          <label class="set-field"><span>{{ tr('task.f.priority') }}</span>
            <select v-model="form.priority">
              <option v-for="p in PRIORITIES" :key="p" :value="p">{{ priorityText(p) }}</option>
            </select>
          </label>
          <label class="set-field"><span>{{ tr('task.f.due') }}</span><input v-model="form.due" type="date" /></label>
          <label class="set-field"><span>{{ tr('task.f.status') }}</span>
            <select v-model="form.status">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ statusText(s) }}</option>
            </select>
          </label>
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
.toast {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--accent);
}
.err {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--danger);
}

.task-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
@media (max-width: 1100px) {
  .task-grid {
    grid-template-columns: 1fr;
  }
}
.task-col > header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 2px 8px;
  font-size: 12px;
  color: var(--text-2);
}
.task-col > header i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.task-col > header em {
  margin-left: auto;
  font-style: normal;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}
.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 10px 12px;
}
.task:hover {
  border-color: var(--line-2-strong);
}
.t-main {
  cursor: pointer;
}
.task h4 {
  margin: 0 0 4px;
  font-size: var(--f-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-desc {
  margin: 0 0 6px;
  font-size: var(--f-xs);
  line-height: 1.55;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.t-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.t-meta .tag {
  font-size: var(--f-xxs);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-2);
}
.pri {
  font-size: var(--f-xxs);
  padding: 1px 6px;
  border-radius: 4px;
}
.p-高 {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}
.p-中 {
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
}
.p-低 {
  background: var(--hover);
  color: var(--text-3);
}
.due {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
}
.task footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.task footer select {
  height: 24px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text-2);
  font-size: 11px;
}
.task footer .del {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: 11px;
}
.task footer .del:hover {
  color: var(--danger);
}
.col-empty {
  margin: 0;
  padding: 14px 12px;
  border: 1px dashed var(--line-2);
  border-radius: var(--r-md);
  font-size: var(--f-xs);
  color: var(--text-3);
  text-align: center;
}
.sp {
  flex: 1;
}

/* 表单 */
.task-form {
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
.if-x:hover {
  background: var(--hover);
  color: var(--text);
}
.set-field {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.set-field > span {
  font-size: 12px;
  color: var(--text-3);
}
.set-field input,
.set-field select,
.set-field textarea {
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text);
  font-size: var(--f-sm);
  resize: vertical;
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
