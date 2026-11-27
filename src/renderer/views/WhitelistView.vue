<script setup lang="ts">
/**
 * IP 白名单（黑曜模板）
 * 只做列表渲染 + 事件上抛；探测、执行、保存等业务逻辑仍在 App.vue。
 * 弹窗（新增/编辑绑定）暂留在 App.vue，已套用弹窗模板样式。
 */
import { useT } from '../ui/i18n';

const tr = useT();

defineProps<{
  ips: string[];
  detecting: boolean;
  bindings: any[];
  logs: any[];
  sched: any;
  nextText: string;
  msg: string;
  busy: boolean;
  providerLabel: (p: string) => string;
  accountLabel: (id: string) => string;
  targetText: (b: any) => string;
  resultText: (b: any) => string;
}>();

const emit = defineEmits<{
  (e: 'detect'): void;
  (e: 'run', id?: string): void;
  (e: 'new'): void;
  (e: 'edit', b: any): void;
  (e: 'toggle', b: any): void;
  (e: 'remove', b: any): void;
  (e: 'sched-change', payload: { enabled: boolean; intervalMinutes: number }): void;
}>();

const bindCols = '1.25fr 76px 1.5fr 104px 1.3fr 112px 92px 168px';
const logCols = '150px 76px 1.2fr 1fr 72px 1.6fr';
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('wl.summary', { n: bindings.length, m: logs.length }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('wl.kicker') }}</div>
          <div class="page-title">{{ tr('wl.title') }} <span class="cnt">[ {{ bindings.length }} ]</span></div>
        </div>
        <span class="sp"></span>
        <button class="btn" :disabled="detecting" @click="emit('detect')">
          {{ detecting ? tr('wl.detecting') : tr('wl.redetect') }}
        </button>
        <button class="btn" :disabled="busy" @click="emit('run')">
          {{ busy ? tr('wl.running') : tr('wl.runNow') }}
        </button>
        <button class="btn primary" @click="emit('new')">{{ tr('wl.new') }}</button>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="k">{{ tr('wl.curIp') }}</div>
          <div class="v num">{{ ips.length ? ips.join(' / ') : tr('wl.noIp') }}</div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('wl.active') }}</div>
          <div class="v num">{{ bindings.filter((b) => b.enabled).length }}<small> / {{ bindings.length }}</small></div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('wl.sched') }}</div>
          <div class="v num">{{ sched.enabled ? tr('wl.on') : tr('wl.off') }}<small> {{ sched.enabled ? tr('wl.everyMin', { n: sched.intervalMinutes }) : '' }}</small></div>
        </div>
        <div class="stat">
          <div class="k">{{ tr('wl.next') }}</div>
          <div class="v num" style="font-size: var(--f-lg)">{{ nextText || '—' }}</div>
        </div>
      </div>

      <div class="sched-row">
        <label class="mini-check">
          <input
            type="checkbox"
            :checked="sched.enabled"
            @change="
              emit('sched-change', {
                enabled: ($event.target as HTMLInputElement).checked,
                intervalMinutes: sched.intervalMinutes,
              })
            "
          />
          {{ tr('wl.sync') }}
        </label>
        <select
          :value="sched.intervalMinutes"
          @change="
            emit('sched-change', {
              enabled: sched.enabled,
              intervalMinutes: Number(($event.target as HTMLSelectElement).value),
            })
          "
        >
          <option :value="5">{{ tr('wl.every5') }}</option>
          <option :value="15">{{ tr('wl.every15') }}</option>
          <option :value="30">{{ tr('wl.every30') }}</option>
          <option :value="60">{{ tr('wl.every60') }}</option>
          <option :value="120">{{ tr('wl.every120') }}</option>
        </select>
        <span v-if="sched.lastSummary" class="muted">{{ tr('wl.last', { v: sched.lastSummary }) }}</span>
        <span class="sp"></span>
        <span class="muted">{{ tr('wl.cronHint') }} <code>npm run whitelist:run</code></span>
      </div>

      <p v-if="msg" class="flash">{{ msg }}</p>

      <div class="tbl" :style="{ '--cols': bindCols }">
        <div class="t-head">
          <span>{{ tr('wl.th.name') }}</span><span>{{ tr('wl.th.vendor') }}</span><span>{{ tr('wl.th.account') }}</span><span>{{ tr('wl.th.region') }}</span>
          <span>{{ tr('wl.th.target') }}</span><span>{{ tr('wl.th.lastIp') }}</span><span>{{ tr('wl.th.result') }}</span><span style="text-align: right">{{ tr('wl.th.actions') }}</span>
        </div>
        <div v-for="b in bindings" :key="b.id" class="t-row" :class="{ due: !b.enabled }">
          <span class="n">
            {{ b.name || '—' }}
            <i v-if="!b.enabled" class="off">{{ tr('wl.disabled') }}</i>
          </span>
          <span class="meta">{{ providerLabel(b.provider) }}</span>
          <span class="meta">{{ accountLabel(b.assetId) }}</span>
          <span class="meta">{{ b.region || '—' }}</span>
          <span class="meta mono">{{ targetText(b) || '—' }}</span>
          <span class="meta mono">{{ b.lastIp || '—' }}</span>
          <span class="meta" :class="{ ok: b.lastResult === 'ok', fail: b.lastResult === 'fail' }">
            {{ resultText(b) }}
          </span>
          <span class="ops">
            <button @click="emit('run', b.id)">{{ tr('wl.run') }}</button>
            <button @click="emit('edit', b)">{{ tr('assets.btn.edit') }}</button>
            <button @click="emit('toggle', b)">{{ b.enabled ? tr('wl.disable') : tr('wl.enable') }}</button>
            <button class="del" @click="emit('remove', b)">{{ tr('assets.btn.delete') }}</button>
          </span>
        </div>
        <div v-if="!bindings.length" class="empty">
          <p>{{ tr('wl.empty') }}</p>
          <button class="btn sm" @click="emit('new')">{{ tr('wl.new') }}</button>
        </div>
      </div>

      <div class="sec-head">
        <span>{{ tr('wl.logs') }}</span>
        <span class="muted">{{ tr('wl.recent', { n: Math.min(logs.length, 20) }) }}</span>
      </div>

      <div class="tbl" :style="{ '--cols': logCols }">
        <div class="t-head">
          <span>{{ tr('wl.th.time') }}</span><span>{{ tr('wl.th.vendor') }}</span><span>{{ tr('wl.th.target') }}</span><span>IP</span><span>{{ tr('wl.th.result') }}</span><span>{{ tr('wl.th.note') }}</span>
        </div>
        <div v-for="(e, i) in logs.slice(-20).reverse()" :key="i" class="t-row">
          <span class="meta mono">{{ e.ts }}</span>
          <span class="meta">{{ providerLabel(e.provider) }}</span>
          <span class="meta mono">{{ e.target || '—' }}</span>
          <span class="meta mono">{{ (e.ips || []).join(', ') || '—' }}</span>
          <span class="meta">{{ e.skipped ? tr('wl.skipped') : e.ok ? tr('wl.ok') : tr('wl.fail') }}</span>
          <span class="meta">{{ e.message || '—' }}</span>
        </div>
        <div v-if="!logs.length" class="empty"><p>{{ tr('wl.noLogs') }}</p></div>
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
  align-items: center;
}
[data-mgui] .t-row .n {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-mgui] .t-row .off {
  font-size: var(--f-xxs);
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text-3);
  font-style: normal;
}
[data-mgui] .t-row .ok {
  color: var(--accent);
}
[data-mgui] .t-row .fail {
  color: var(--danger);
}
[data-mgui] .t-row .mono {
  font-family: var(--font-mono);
  font-size: var(--f-xs);
}
[data-mgui] .ops {
  display: flex;
  gap: 2px;
  justify-content: flex-end;
}
[data-mgui] .ops button {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: var(--f-xs);
  padding: 2px 6px;
  border-radius: 5px;
}
[data-mgui] .ops button:hover {
  background: var(--hover);
  color: var(--accent);
}
[data-mgui] .ops button.del:hover {
  color: var(--danger);
}

/* 调度条：一行紧凑摆放 */
[data-mgui] .sched-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: var(--s-4);
  font-size: var(--f-sm);
  color: var(--text-2);
  flex-wrap: wrap;
}
[data-mgui] .sched-row select {
  background: var(--panel);
  border: 1px solid var(--line-2);
  color: var(--text);
  border-radius: var(--r-sm);
  height: 30px;
  padding: 0 8px;
  font-size: var(--f-sm);
}
[data-mgui] .mini-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
[data-mgui] .mini-check input {
  accent-color: var(--accent);
}
[data-mgui] .muted {
  color: var(--text-3);
  font-size: var(--f-xs);
}
[data-mgui] .muted code {
  font-family: var(--font-mono);
  color: var(--text-2);
}
[data-mgui] .flash {
  margin: 0 0 var(--s-3);
  font-size: var(--f-sm);
  color: var(--accent);
}
[data-mgui] .sec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: var(--s-5) 0 var(--s-3);
  font-size: var(--f-sm);
  font-weight: 600;
  color: var(--text-2);
}
[data-mgui] .tbl {
  margin-bottom: 0;
}
</style>
