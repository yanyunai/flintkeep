<script setup lang="ts">
/**
 * 灵感池（模板版）
 * 规格见 docs/opc-spec/01-ideas.md；评分算法在 ./idea/score.ts，与旧版逐字一致。
 * 数据走 collections.ideas，不再依赖 iframe 里的 workbench 状态。
 */
import { computed, onMounted, ref } from 'vue';
import { uiTheme, uiTemplate } from '../ui/appearance';
import { useT } from '../ui/i18n';
import { loadBucket, saveBucket } from './collection-api';
import { ideaScore, scoreColor } from './idea/score';

const tr = useT();

type Idea = {
  id: string;
  title: string;
  desc?: string;
  demand: number;
  monetize: number;
  competition: number;
  effort: number;
  status: '待评估' | '验证中' | '已立项' | '已放弃';
  date?: string;
  pid?: string;
};

/** 状态与维度名存的是中文（历史数据），展示时按语言翻译 */
const STATUSES = ['待评估', '验证中', '已立项', '已放弃'] as const;
const STATUS_KEY: Record<string, string> = { 待评估: 'review', 验证中: 'testing', 已立项: 'approved', 已放弃: 'dropped' };
function statusText(s: string): string {
  const k = STATUS_KEY[s];
  return k ? tr(('idea.st.' + k) as any) : s;
}
const DIMS = [
  { k: 'demand', rev: false },
  { k: 'monetize', rev: false },
  { k: 'competition', rev: true },
  { k: 'effort', rev: true },
] as const;
function dimLabel(k: string): string {
  return tr(('idea.dim.' + k) as any);
}

const ideas = ref<Idea[]>([]);
const loading = ref(true);
const err = ref('');
const filter = ref<string>('');
const editing = ref<Idea | 'new' | null>(null);
const form = ref<Idea>(blank());
const toast = ref('');

function blank(): Idea {
  return {
    id: '',
    title: '',
    desc: '',
    demand: 3,
    monetize: 3,
    competition: 3,
    effort: 3,
    status: '待评估',
    date: new Date().toISOString().slice(0, 10),
  };
}

async function load() {
  loading.value = true;
  err.value = '';
  try {
    ideas.value = await loadBucket<Idea>('ideas');
  } catch (e: any) {
    err.value = e?.message || tr('idea.err.load');
  } finally {
    loading.value = false;
  }
}

async function persist() {
  await saveBucket('ideas', ideas.value);
}

const sorted = computed(() => [...ideas.value].sort((a, b) => ideaScore(b) - ideaScore(a)));

const counts = computed(() => {
  const c: Record<string, number> = { '': ideas.value.length };
  for (const s of STATUSES) c[s] = ideas.value.filter((i) => i.status === s).length;
  return c;
});

const filtered = computed(() => (filter.value ? sorted.value.filter((i) => i.status === filter.value) : sorted.value));

function openNew() {
  form.value = blank();
  editing.value = 'new';
}

function openEdit(i: Idea) {
  form.value = { ...i };
  editing.value = i;
}

function closeForm() {
  editing.value = null;
}

async function save() {
  const title = form.value.title.trim();
  if (!title) {
    toast.value = tr('idea.needTitle');
    setTimeout(() => (toast.value = ''), 2000);
    return;
  }
  const f = { ...form.value, title };
  if (editing.value === 'new') {
    f.id = 'i' + Math.random().toString(36).slice(2, 8);
    ideas.value = [...ideas.value, f];
  } else {
    ideas.value = ideas.value.map((i) => (i.id === f.id ? f : i));
  }
  await persist();
  editing.value = null;
  const s = ideaScore(f);
  toast.value = tr('idea.saved', { s });
  setTimeout(() => (toast.value = ''), 2200);
}

async function remove(i: Idea) {
  if (!confirm(tr('idea.confirmDelete', { title: i.title }))) return;
  ideas.value = ideas.value.filter((x) => x.id !== i.id);
  await persist();
  editing.value = null;
}

function ringDash(score: number): string {
  const c = 2 * Math.PI * 16;
  const on = (c * Math.max(0, Math.min(100, score))) / 100;
  return `${on} ${c}`;
}

function dots(_k: string, _n: number): number[] {
  return Array.from({ length: 5 }, (_, i) => i + 1);
}

function dimText(k: string, i: Idea): string {
  const v = (i as any)[k] ?? 3;
  const rev = DIMS.find((d) => d.k === k)?.rev;
  return rev ? String(v) + tr('idea.revInline') : String(v);
}

onMounted(load);
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('idea.summary', { n: ideas.length }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('idea.kicker') }}</div>
          <div class="page-title">{{ tr('idea.title') }} <span class="cnt">[ {{ ideas.length }} ]</span></div>
        </div>
        <span class="sp"></span>
        <button class="btn primary" @click="openNew">{{ tr('idea.new') }}</button>
      </div>

      <p class="lead">{{ tr('idea.lead') }}</p>

      <p v-if="toast" class="toast">{{ toast }}</p>
      <p v-if="err" class="err">{{ err }}</p>

      <div class="chips-row">
        <div class="chips">
          <button class="chip" :class="{ on: filter === '' }" @click="filter = ''">
            {{ tr('idea.all') }} <span class="c">{{ counts[''] }}</span>
          </button>
          <button
            v-for="s in STATUSES"
            :key="s"
            class="chip"
            :class="{ on: filter === s }"
            @click="filter = s"
          >
            <i :style="{ background: s === '待评估' ? 'var(--text-3)' : s === '验证中' ? 'var(--info)' : s === '已立项' ? 'var(--ok)' : 'var(--danger)' }"></i>
            {{ statusText(s) }} <span class="c">{{ counts[s] }}</span>
          </button>
        </div>
      </div>

      <div v-if="filtered.length" class="idea-grid">
        <article v-for="i in filtered" :key="i.id" class="idea">
          <header>
            <svg class="ring" viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="16" class="ring-bg" />
              <circle
                cx="20"
                cy="20"
                r="16"
                class="ring-fg"
                :style="{ stroke: scoreColor(ideaScore(i)), strokeDasharray: ringDash(ideaScore(i)) }"
              />
            </svg>
            <div class="score" :style="{ color: scoreColor(ideaScore(i)) }">{{ ideaScore(i) }}</div>
            <div class="head-main">
              <h3 :title="i.title">{{ i.title }}</h3>
              <span class="st" :class="'st-' + i.status">{{ statusText(i.status) }}</span>
            </div>
          </header>

          <p v-if="i.desc" class="desc">{{ i.desc }}</p>

          <div class="dims">
            <div v-for="d in DIMS" :key="d.k" class="dim">
              <span class="dk">{{ dimLabel(d.k) }}</span>
              <span class="dv">
                <i
                  v-for="n in dots(d.k, 5)"
                  :key="n"
                  class="dot"
                  :class="{ on: n <= ((i as any)[d.k] ?? 3) }"
                ></i>
              </span>
              <em class="dn">{{ dimText(d.k, i) }}</em>
            </div>
          </div>

          <footer>
            <button class="act" @click="openEdit(i)">{{ tr('assets.btn.edit') }}</button>
            <button v-if="i.status !== '已立项'" class="act" @click="openEdit(i)">{{ tr('idea.approve') }}</button>
            <span class="sp"></span>
            <span class="date num">{{ i.date || '' }}</span>
          </footer>
        </article>
      </div>

      <div v-else class="empty">
        <p v-if="!ideas.length">{{ tr('idea.emptyNew') }}</p>
        <p v-else>{{ tr('idea.emptyFilter') }}</p>
        <button v-if="!ideas.length" class="btn sm" @click="openNew">{{ tr('idea.new') }}</button>
      </div>
    </div>

    <!-- 新增 / 编辑：Teleport 到 body，避免被 .app 的 transform 影响定位 -->
    <Teleport to="body">
    <div
      v-if="editing"
      class="modal"
      :class="{ 'mg-modal mg-center': true }"
      data-mgui
      :data-template="uiTemplate"
      :data-theme="uiTheme"
      @click.self="closeForm"
    >
      <div class="box idea-form">
        <header class="if-head">
          <h3>{{ editing === 'new' ? tr('idea.new') : tr('idea.edit') }}</h3>
          <button class="if-x" @click="closeForm">×</button>
        </header>

        <label class="set-field">
          <span>{{ tr('idea.f.title') }}</span>
          <input v-model="form.title" :placeholder="tr('idea.ph.title')" @keyup.enter="save" />
        </label>
        <label class="set-field">
          <span>{{ tr('idea.f.desc') }}</span>
          <textarea v-model="form.desc" rows="2" :placeholder="tr('task.f.optionalPh')"></textarea>
        </label>

        <div v-for="d in DIMS" :key="d.k" class="dim-row">
          <span class="dk">{{ dimLabel(d.k) }}</span>
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            :value="(form as any)[d.k]"
            @input="(form as any)[d.k] = Number(($event.target as HTMLInputElement).value)"
          />
          <em>{{ (form as any)[d.k] }}</em>
          <span v-if="d.rev" class="rev">{{ tr('idea.rev') }}</span>
        </div>

        <div class="st-row">
          <span class="dk">{{ tr('idea.f.status') }}</span>
          <button
            v-for="s in STATUSES"
            :key="s"
            class="st-chip"
            :class="{ on: form.status === s }"
            @click="form.status = s"
          >{{ statusText(s) }}</button>
        </div>

        <div class="score-preview">
          {{ tr('idea.scoreLabel') }} <b :style="{ color: scoreColor(ideaScore(form)) }">{{ ideaScore(form) }}</b>
        </div>

        <footer class="if-foot">
          <button v-if="editing !== 'new'" class="if-del" @click="remove(form)">{{ tr('assets.btn.delete') }}</button>
          <span class="sp"></span>
          <button class="btn" @click="closeForm">{{ tr('common.btn.cancel') }}</button>
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

.lead {
  margin: 0 0 14px;
  font-size: var(--f-sm);
  color: var(--text-3);
}
.toast {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--accent);
}
.err {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--danger);
}

.idea-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}

.idea {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.idea:hover {
  border-color: var(--line-2-strong);
}

.idea header {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
}
.ring {
  width: 38px;
  height: 38px;
  flex: none;
  transform: rotate(-90deg);
}
.ring-bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 3;
}
.ring-fg {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
  transition: stroke-dasharray 0.3s;
}
.score {
  position: absolute;
  left: 0;
  top: 0;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
}
.head-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.head-main h3 {
  margin: 0;
  font-size: var(--f-md);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st {
  flex: none;
  font-size: var(--f-xxs);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-3);
}
.st-验证中 {
  background: var(--accent-soft);
  color: var(--info);
}
.st-已立项 {
  background: var(--accent-soft);
  color: var(--ok);
}
.st-已放弃 {
  background: var(--accent-soft);
  color: var(--danger);
}

.desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dims {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 14px;
}
.dim {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--text-3);
}
.dk {
  flex: none;
  width: 56px;
}
.dv {
  display: flex;
  gap: 2px;
}
.dot {
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: var(--line-2);
}
.dot.on {
  background: var(--accent);
}
.dn {
  margin-left: auto;
  font-style: normal;
  font-family: var(--font-mono);
  font-size: var(--f-xxs);
  color: var(--text-3);
}

.idea footer {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.idea footer .act {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: var(--f-xs);
  padding: 2px 7px;
  border-radius: 5px;
}
.idea footer .act:hover {
  background: var(--hover);
  color: var(--accent);
}
.idea footer .date {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
}
.sp {
  flex: 1;
}

/* 表单 */
.idea-form {
  width: min(520px, 94vw);
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
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.set-field > span {
  font-size: 12px;
  color: var(--text-3);
}
.set-field input,
.set-field textarea {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text);
  font-size: var(--f-sm);
  resize: vertical;
}
.dim-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) 26px 62px;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.dim-row input[type='range'] {
  accent-color: var(--accent);
}
.dim-row em {
  font-style: normal;
  font-family: var(--font-mono);
  color: var(--text-2);
  text-align: right;
}
.rev {
  font-size: var(--f-xxs);
  color: var(--text-3);
}
.st-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0;
  font-size: 12px;
  color: var(--text-3);
}
.st-chip {
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-3);
  font-size: var(--f-xs);
  padding: 3px 9px;
  border-radius: 999px;
}
.st-chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.score-preview {
  font-size: 12px;
  color: var(--text-3);
}
.score-preview b {
  font-family: var(--font-mono);
  font-size: var(--f-lg);
}
.if-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.if-del {
  border: 0;
  background: none;
  color: var(--danger);
  font-size: 12px;
}
</style>
