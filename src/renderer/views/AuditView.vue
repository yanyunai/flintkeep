<script setup lang="ts">
/** 审计日志（黑曜模板）：筛选 + 分页 + 时间线表格 */
import { useT } from '../ui/i18n';

defineProps<{
  rows: any[];
  total: number;
  filter: string;
  page: number;
  pageCount: number;
  pageSize: number;
  tsText: (ts: string) => string;
  kindLabel: (e: any) => string;
  category: (e: any) => 'agent' | 'user';
  actionText: (e: any) => string;
  fieldCn: (k: string) => string;
  previewText: (p: any) => string;
}>();

const emit = defineEmits<{
  (e: 'filter', v: string): void;
  (e: 'page', n: number): void;
  (e: 'page-size', n: number): void;
  (e: 'restore', e: any): void;
}>();

const cols = '150px 96px 1fr 1.6fr';

/** 页面骨架文案：useT 内部读 lang，模板渲染时自动订阅语言变化 */
const tr = useT();
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('audit.total', { n: total }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('audit.kicker') }}</div>
          <div class="page-title">{{ tr('audit.title') }} <span class="cnt">[ {{ total }} ]</span></div>
        </div>
        <span class="sp"></span>
        <div class="seg">
          <button :class="{ on: filter === 'all' }" @click="emit('filter', 'all')">{{ tr('audit.filter.all') }}</button>
          <button :class="{ on: filter === 'user' }" @click="emit('filter', 'user')">{{ tr('audit.filter.user') }}</button>
          <button :class="{ on: filter === 'agent' }" @click="emit('filter', 'agent')">{{ tr('audit.filter.agent') }}</button>
        </div>
        <select class="page-size" :value="pageSize" @change="emit('page-size', Number(($event.target as HTMLSelectElement).value))">
          <option v-for="n in [10, 20, 50, 100]" :key="n" :value="n">{{ tr('audit.pageSize', { n }) }}</option>
        </select>
      </div>

      <div class="tbl" :style="{ '--cols': cols }">
        <div class="t-head">
          <span>{{ tr('audit.th.time') }}</span>
          <span>{{ tr('audit.th.actor') }}</span>
          <span>{{ tr('audit.th.action') }}</span>
          <span>{{ tr('audit.th.detail') }}</span>
        </div>

        <div v-for="(e, i) in rows" :key="i" class="t-row">
          <span class="meta mono">{{ tsText(e.ts) }}</span>
          <span>
            <i class="tag" :class="{ agent: category(e) === 'agent' }">{{ kindLabel(e) }}</i>
          </span>
          <span class="act-cell">
            {{ actionText(e) }}
            <button v-if="e.undo" class="undo" @click="emit('restore', e)">{{ tr('audit.btn.undo') }}</button>
          </span>
          <span class="detail">
            <template v-if="e.changes && e.changes.length">
              <div v-for="c in e.changes" :key="c.k">{{ tr('audit.change', { k: fieldCn(c.k), from: c.from, to: c.to }) }}</div>
            </template>
            <template v-else-if="e.preview">{{ previewText(e.preview) }}</template>
            <template v-else>—</template>
          </span>
        </div>

        <div v-if="!rows.length" class="empty"><p>{{ tr('audit.empty') }}</p></div>
      </div>

      <div class="pager">
        <button :disabled="page <= 1" @click="emit('page', page - 1)">{{ tr('audit.pager.prev') }}</button>
        <span class="num">{{ page }} / {{ pageCount }}</span>
        <button :disabled="page >= pageCount" @click="emit('page', page + 1)">{{ tr('audit.pager.next') }}</button>
      </div>
    </div>
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
[data-mgui] .t-head,
[data-mgui] .t-row {
  grid-template-columns: var(--cols);
}
[data-mgui] .t-row {
  align-items: start;
  padding-top: 10px;
  padding-bottom: 10px;
  height: auto;
  min-height: var(--row-h);
}
[data-mgui] .t-row .mono {
  font-family: var(--font-mono);
  font-size: var(--f-xs);
  color: var(--text-3);
}
[data-mgui] .t-row .act-cell {
  color: var(--text);
  font-size: var(--f-sm);
  white-space: normal;
}
[data-mgui] .t-row .detail {
  color: var(--text-2);
  font-size: var(--f-xs);
  line-height: 1.5;
  white-space: normal;
  word-break: break-word;
}
[data-mgui] .tag {
  display: inline-block;
  font-style: normal;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--hover);
  color: var(--text-2);
}
[data-mgui] .tag.agent {
  background: var(--accent-soft);
  color: var(--accent);
}
[data-mgui] .undo {
  margin-left: 6px;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
}
[data-mgui] .undo:hover {
  background: var(--accent-soft);
}
/* 分段筛选 */
[data-mgui] .seg {
  display: flex;
  background: var(--hover);
  border-radius: var(--r-sm);
  padding: 2px;
}
[data-mgui] .seg button {
  border: 0;
  background: none;
  color: var(--text-2);
  font-size: var(--f-xs);
  padding: 4px 10px;
  border-radius: 4px;
}
[data-mgui] .seg button.on {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
[data-mgui] .page-size {
  height: 28px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  color: var(--text-2);
  border-radius: var(--r-sm);
  font-size: var(--f-xs);
  padding: 0 6px;
}
[data-mgui] .pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: var(--s-4);
  font-size: 12px;
  color: var(--text-3);
}
[data-mgui] .pager button {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  font-size: var(--f-xs);
}
[data-mgui] .pager button:disabled {
  opacity: 0.4;
}
</style>
