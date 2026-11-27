<script setup lang="ts">
import { useT } from '../ui/i18n';

/** 备忘录（黑曜模板）：卡片网格，内容随燧垒加密存储 */
const tr = useT();

defineProps<{
  memos: any[];
  copiedId: string;
}>();

const emit = defineEmits<{
  (e: 'new'): void;
  (e: 'edit', m: any): void;
  (e: 'remove', m: any): void;
  (e: 'copy', m: any): void;
}>();

function when(m: any): string {
  const s = String(m.updatedAt || '').slice(0, 16).replace('T', ' ');
  return s || '';
}
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('memo.count', { n: memos.length }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('memo.kicker') }}</div>
          <div class="page-title">{{ tr('memo.title') }} <span class="cnt">[ {{ memos.length }} ]</span></div>
        </div>
        <span class="sp"></span>
        <button class="btn primary" @click="emit('new')">{{ tr('memo.new') }}</button>
      </div>

      <div v-if="memos.length" class="memo-grid">
        <article v-for="m in memos" :key="m.id" class="memo">
          <header>
            <h3 :title="m.name || ''">{{ m.name || tr('memo.untitled') }}</h3>
            <span class="ts num">{{ when(m) }}</span>
          </header>
          <pre class="body">{{ m.content || '—' }}</pre>
          <footer>
            <button @click="emit('copy', m)">{{ copiedId === m.id ? tr('assets.btn.copied') : tr('assets.btn.copy') }}</button>
            <button @click="emit('edit', m)">{{ tr('assets.btn.edit') }}</button>
            <span class="sp"></span>
            <button class="del" @click="emit('remove', m)">{{ tr('assets.btn.delete') }}</button>
          </footer>
        </article>
      </div>

      <div v-else class="empty">
        <p>{{ tr('memo.empty') }}</p>
        <button class="btn sm" @click="emit('new')">{{ tr('memo.new') }}</button>
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

[data-mgui] .memo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

[data-mgui] .memo {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 14px 16px;
  min-height: 150px;
  max-height: 260px;
  transition: border-color 0.15s;
}
[data-mgui] .memo:hover {
  border-color: var(--line-2-strong);
}

[data-mgui] .memo header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
[data-mgui] .memo h3 {
  margin: 0;
  font-size: var(--f-md);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-mgui] .memo .ts {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-3);
}

[data-mgui] .memo .body {
  flex: 1;
  margin: 0;
  overflow: hidden;
  font-family: var(--font-ui);
  font-size: var(--f-sm);
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  /* 内容多的卡片在内部滚，不撑高整格 */
  overflow-y: auto;
  scrollbar-width: none;
}
[data-mgui] .memo .body::-webkit-scrollbar {
  width: 0;
}

[data-mgui] .memo footer {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
[data-mgui] .memo footer button {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: var(--f-xs);
  padding: 2px 7px;
  border-radius: 5px;
}
[data-mgui] .memo footer button:hover {
  background: var(--hover);
  color: var(--accent);
}
[data-mgui] .memo footer button.del:hover {
  color: var(--danger);
}
[data-mgui] .sp {
  flex: 1;
}
</style>
