<script setup lang="ts">
import { useT } from './ui/i18n';

const tr = useT();
/**
 * 机房：服务器单元（box3 立体画法，对齐工作台美术）。
 * 每台服务器一个立体单元：金属机身 + 绿色 LCD（服务器名/链路状态）+ LED 条 + 散热格栅。
 * 点机身 = 签发 SSH 令牌真连；↻ = 重新探测。无轮询——状态只在你点检测时更新。
 */
import { computed } from 'vue';

const props = defineProps<{
  servers: any[];
  checks: Record<string, { state: 'unknown' | 'checking' | 'ok' | 'fail'; ms?: number; error?: string }>;
  busyAll?: boolean;
  msg?: string;
}>();
const emit = defineEmits<{
  check: [s: any];
  checkall: [];
  connect: [s: any];
  open: [s: any];
  add: [];
}>();

const stText = (s: any) => {
  const st = props.checks[s.id]?.state || 'unknown';
  return st === 'ok' ? `LINK ${props.checks[s.id]?.ms || 0}MS` : st === 'fail' ? 'LINK DOWN' : st === 'checking' ? 'PING ...' : 'STANDBY';
};
const stColor = (s: any) => {
  const st = props.checks[s.id]?.state || 'unknown';
  return st === 'ok' ? '#62e08c' : st === 'fail' ? '#ff8177' : st === 'checking' ? '#e8c268' : '#5c6a78';
};
const esc = (v: any) => String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
const online = computed(() => props.servers.filter((s: any) => props.checks[s.id]?.state === 'ok').length);
</script>

<template>
  <div class="room-page">
    <div class="room-bar">
      <div class="rb-l">
        <span class="rb-title">{{ tr('hud.title') }}</span>
        <span class="rb-kpi"><b>{{ servers.length }}</b> {{ tr('hud.units') }}</span>
        <span class="rb-kpi"><b :class="{ on: online }">{{ online }}</b> {{ tr('hud.online') }}</span>
        <span v-if="msg" class="rb-msg">{{ msg }}</span>
      </div>
      <div class="rb-r">
        <button class="rbtn prim" :disabled="busyAll || !servers.length" @click="emit('checkall')">
          {{ busyAll ? tr('hud.checking') : tr('hud.checkAll') }}
        </button>
        <button class="rbtn" @click="emit('add')">{{ tr('hud.add') }}</button>
      </div>
    </div>

    <div class="floor" :class="{ empty: !servers.length }">
      <div class="unit-col">
        <div v-for="s in servers" :key="s.id" class="unit-wrap">
          <svg class="unit-svg" viewBox="0 0 220 168" aria-hidden="true">
            <defs>
              <linearGradient :id="'uf' + s.id" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#3a4048" />
                <stop offset=".5" stop-color="#262b31" />
                <stop offset="1" stop-color="#1b1f24" />
              </linearGradient>
            </defs>
            <!-- 投影 -->
            <path :d="`M${190} ${40} L${190} ${158} L${14} ${158} L${-16} ${180} L${174} ${180} L${178} ${52} Z`" fill="#000" fill-opacity=".1" />
            <!-- 顶面 + 正面（box3 立体） -->
            <rect x="10" y="6" width="200" height="26" rx="3" fill="url(#gRackTop2)" stroke="#e0e0de" stroke-width=".8" />
            <rect x="10" y="30" width="200" height="128" rx="2.5" :fill="`url(#uf${s.id})`" stroke="#1c2026" stroke-width=".8" />
            <!-- LCD：服务器名 + 链路状态 -->
            <rect x="22" y="40" width="176" height="44" rx="2" fill="#0e1712" />
            <text x="110" y="60" text-anchor="middle" fill="#62e08c" font-size="13" font-weight="700" font-family="ui-monospace,monospace">{{ esc(s.name).slice(0, 12) }}</text>
            <text x="110" y="76" text-anchor="middle" :fill="stColor(s)" font-size="10" font-family="ui-monospace,monospace">{{ stText(s) }}</text>
            <!-- LED 条 ×4 -->
            <rect v-for="k in 4" :key="k" :x="26 + (k - 1) * 13" y="96" width="7.4" height="13" rx="1" fill="#3ea35c" :opacity="checks[s.id]?.state === 'ok' ? (k === 4 ? '.35' : '.9') : '.5'" />
            <!-- 散热格栅 ×5 -->
            <rect v-for="j in 5" :key="'v' + j" x="24" :y="118 + j * 6.4" width="172" height="2.4" rx="1" fill="#3b424d" />
            <!-- 状态灯 -->
            <circle cx="196" cy="44" r="3.4" :fill="stColor(s)" />
            <rect x="0" y="0" width="220" height="168" fill="transparent" style="cursor:pointer" @click="emit('connect', s)" />
            <title>{{ tr('hud.unitTitle', { name: s.name }) }}</title>
          </svg>
          <div class="unit-ops">
            <button class="ubtn" @click="emit('check', s)">{{ tr('hud.check') }}</button>
            <button class="ubtn" @click="emit('connect', s)">{{ tr('hud.ssh') }}</button>
            <button class="ubtn ghost" @click="emit('open', s)">{{ tr('hud.detail') }}</button>
          </div>
        </div>
        <p v-if="!servers.length" class="empty-hint">{{ tr('hud.empty') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.room-page { padding: 4px 2px; }
.room-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.rb-l { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.rb-title { font-size: 13px; font-weight: 700; letter-spacing: .1em; color: var(--text-2); }
.rb-kpi { font-size: 12.5px; color: var(--text-2); }
.rb-kpi b { font-size: 17px; color: var(--text); margin-right: 3px; }
.rb-kpi b.on { color: #1d9a57; }
.rb-msg { font-size: 12.5px; color: var(--accent); }
.rb-r { display: flex; gap: 8px; }
.rbtn { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); border-radius: 8px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
.rbtn:hover { border-color: var(--accent); color: var(--accent); }
.rbtn:disabled { opacity: .5; cursor: default; }
.rbtn.prim { background: var(--text); color: var(--surface, #fff); font-weight: 600; }
.rbtn.prim:hover { opacity: .85; }

/* 地板网格（对齐工作台暖灰） */
.floor {
  min-height: 420px; border-radius: 14px; padding: 26px;
  background-color: #efefec;
  background-image: linear-gradient(rgba(23,23,23,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(23,23,23,.05) 1px, transparent 1px);
  background-size: 26px 26px;
}
.floor.empty { display: flex; align-items: center; justify-content: center; }
.unit-col { display: flex; flex-direction: column; gap: 26px; width: 264px; }
.unit-wrap { position: relative; }
.unit-svg { display: block; width: 100%; height: auto; }
.unit-ops { display: flex; gap: 6px; padding: 6px 2px 0; }
.ubtn { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); border-radius: 6px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; }
.ubtn:hover { border-color: var(--accent); color: var(--accent); }
.ubtn.ghost { border-style: dashed; }
.empty-hint { margin: 0; font-size: 12.5px; color: var(--text-3); }
</style>
