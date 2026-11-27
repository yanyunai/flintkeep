<script setup lang="ts">
/**
 * 项目（自有页面，替换 OPC 的 projects 页）
 *
 * 数据源：**资产库里的 project 类型资产**（和「资产清单」「机房」是同一份数据）。
 * 以前这页读写 collections.projects，那是另一张空表 —— 所以资产库里明明有 4 个项目，
 * 这页却显示「还没有项目」，看起来就像项目丢了。
 *
 * 这页只负责渲染，新增/编辑/删除都回到 App 的资产表单（urls、关联服务器、自定义字段都在那边，
 * 自己再存一份必然丢字段）。
 */
import { computed } from 'vue';
import { useT } from '../ui/i18n';

const tr = useT();

type Project = {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  version?: string;
  progress?: number;
  desc?: string;
  stack?: string[];
  urls?: Record<string, string>;
  color?: string;
  no?: number;
  links?: { id: string; role?: string }[];
};

const props = defineProps<{ projects: Project[] }>();
const emit = defineEmits<{
  (e: 'new'): void;
  (e: 'edit', p: Project): void;
  (e: 'remove', p: Project): void;
}>();

/** 状态名跟语言走；自定义状态原样返回 */
const STATUS_KEYABLE = new Set(['live', 'test', 'dev', 'idea', 'paused', 'archived']);
const FILTERS = ['live', 'dev', 'test', 'idea', 'paused', 'archived'] as const;

const statusFilter = defineModel<string>('filter', { default: '' });
function stOf(p: Project): string {
  return p.status || 'dev';
}
function labelOf(s: string): string {
  return STATUS_KEYABLE.has(s) ? tr(('proj.st.' + s) as any) : s;
}
function countOf(s: string): number {
  return props.projects.filter((p) => stOf(p) === s).length;
}
const filtered = computed(() =>
  statusFilter.value ? props.projects.filter((p) => stOf(p) === statusFilter.value) : props.projects
);

/** urls 里只挑有值的展示，避免一排空链接 */
const URL_KEYABLE = new Set(['web', 'api', 'admin', 'repo', 'deploy', 'stats', 'docs', 'design', 'db', 'pay']);
function urlLabel(k: string): string {
  return URL_KEYABLE.has(k) ? tr(('proj.url.' + k) as any) : k;
}
function urlList(p: Project): { k: string; label: string; url: string }[] {
  return Object.entries(p.urls || {})
    .filter(([, v]) => !!v)
    .map(([k, v]) => ({ k, label: urlLabel(k), url: v }));
}
function stackText(p: Project): string {
  return (p.stack || []).join(' · ');
}
function pct(p: Project): number {
  const n = Number(p.progress) || 0;
  return Math.max(0, Math.min(100, n));
}
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('proj.summary', { n: projects.length, live: countOf('live') }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('proj.kicker') }}</div>
          <div class="page-title">{{ tr('proj.title') }} <span class="cnt">[ {{ projects.length }} ]</span></div>
        </div>
        <span class="sp"></span>
        <button class="btn primary" @click="emit('new')">{{ tr('proj.new') }}</button>
      </div>

      <div class="chips-row">
        <div class="chips">
          <button class="chip" :class="{ on: statusFilter === '' }" @click="statusFilter = ''">
            {{ tr('proj.all') }} <span class="c">{{ projects.length }}</span>
          </button>
          <button
            v-for="s in FILTERS"
            :key="s"
            class="chip"
            :class="{ on: statusFilter === s }"
            @click="statusFilter = s"
          >
            <i :style="{ background: 'var(--' + (s === 'live' ? 'ok' : s === 'dev' ? 'info' : s === 'test' ? 'accent' : s === 'idea' ? 'text-2' : s === 'paused' ? 'warn' : 'text-3') + ')' }"></i>
            {{ labelOf(s) }} <span class="c">{{ countOf(s) }}</span>
          </button>
        </div>
      </div>

      <div v-if="filtered.length" class="proj-grid">
        <article v-for="p in filtered" :key="p.id" class="proj" @click="emit('edit', p)">
          <header>
            <i class="bar-color" :style="{ background: p.color || 'var(--accent)' }"></i>
            <h3 :title="p.name">{{ p.name }}</h3>
            <span class="st" :class="'st-' + stOf(p)">{{ labelOf(stOf(p)) }}</span>
          </header>
          <div class="p-meta">
            <span v-if="p.kind" class="tag">{{ p.kind }}</span>
            <span v-if="p.version" class="ver num">{{ p.version }}</span>
            <span v-if="p.no" class="ver num">NO.{{ String(p.no).padStart(2, '0') }}</span>
          </div>
          <p v-if="p.desc" class="p-desc">{{ p.desc }}</p>
          <div class="p-urls">
            <a
              v-for="u in urlList(p)"
              :key="u.k"
              :href="u.url"
              :title="u.url"
              target="_blank"
              rel="noreferrer"
              @click.stop
            >{{ u.label }}</a>
          </div>
          <div class="bar" :title="pct(p) + '%'">
            <i :style="{ width: pct(p) + '%' }"></i>
          </div>
          <footer>
            <span class="pct num">{{ pct(p) }}%</span>
            <span v-if="stackText(p)" class="stack" :title="stackText(p)">{{ stackText(p) }}</span>
            <span v-if="(p.links || []).length" class="links num" :title="tr('proj.links')">⇄ {{ (p.links || []).length }}</span>
            <button class="del" @click.stop="emit('remove', p)">{{ tr('assets.btn.delete') }}</button>
          </footer>
        </article>
      </div>

      <div v-else class="empty">
        <p>{{ statusFilter ? tr('proj.emptyStatus') : tr('proj.empty') }}</p>
        <button class="btn sm" @click="statusFilter ? (statusFilter = '') : emit('new')">
          {{ statusFilter ? tr('proj.seeAll') : tr('proj.new') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mg-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}
.proj-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  align-content: start;
  overflow: auto;
  padding-bottom: 24px;
}
.proj {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  padding: 14px 14px 10px;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.proj:hover {
  border-color: var(--line-2-strong);
}
.proj header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar-color {
  width: 3px;
  height: 16px;
  border-radius: 2px;
  flex: none;
}
.proj header h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj .st {
  margin-left: auto;
  flex: none;
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--line-2);
  color: var(--text-2);
}
.proj .st-live {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 40%, transparent);
}
.proj .st-dev {
  color: var(--info);
  border-color: color-mix(in srgb, var(--info) 40%, transparent);
}
.proj .st-paused {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 40%, transparent);
}
/* 测试/想法/归档：此前未定义，回退灰字灰框，与 chips 的点色对齐（docs/运行工作台 F8） */
.proj .st-test {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.proj .st-idea {
  color: var(--text-2);
  border-style: dashed;
  border-color: color-mix(in srgb, var(--text-2) 40%, transparent);
}
.proj .st-archived {
  color: var(--text-3);
  border-color: color-mix(in srgb, var(--text-3) 40%, transparent);
}
.p-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.p-meta .tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--text-2);
}
.p-meta .ver {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.p-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.p-urls {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.p-urls a {
  font-size: 11px;
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
}
.p-urls a:hover {
  filter: brightness(1.15);
}
.bar {
  height: 3px;
  border-radius: 2px;
  background: var(--hover);
  overflow: hidden;
}
.bar > i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
}
.proj footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
}
.proj footer .pct {
  font-family: var(--font-mono);
  color: var(--text-2);
}
.proj footer .stack {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj footer .del {
  flex: none;
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 5px;
  cursor: pointer;
}
.proj footer .del:hover {
  background: var(--hover);
  color: var(--danger);
}
.sp {
  flex: 1;
}
</style>
