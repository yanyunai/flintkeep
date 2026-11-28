<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useT } from './ui/i18n';

const tr = useT();

const projects = ref<any[]>([]);
const statuses = ref<Record<string, any>>({});
const busy = ref<Record<string, boolean>>({});
const toastText = ref('');
const showForm = ref(false);
const logFor = ref('');
const logs = ref<{ step: string; content: string }[]>([]);
const editing = ref<any | null>(null);
let es: EventSource | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const form = reactive({
  id: '',
  name: '',
  cwd: '',
  pathMac: '',
  notes: '',
  tags: '',
  url: '',
  healthUrl: '',
  fingerprint: '',
  mode: 'any' as 'any' | 'all',
  kind: 'process' as 'process' | 'compose' | 'docker',
  stopCommand: '',
  stopPolicy: 'cascade',
  shared: false,
  registeredBy: '',
  /** 挂在哪张卡片下（空 = 自己是主项目）。依赖节点编辑时必须能看到/改它 */
  parent: '',
});
const cmdText = ref('');
const portsText = ref('');
const depsText = ref('');

const STATUS_KEYS = ['stopped', 'starting', 'waiting', 'running', 'unhealthy', 'failed', 'unknown'];
/** 卡片排序权重：跑着的排最前，其次启动中，再次异常，已停止/未知垫后；同档保持登记顺序 */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  starting: 1,
  waiting: 1,
  unhealthy: 2,
  failed: 2,
  stopped: 3,
  unknown: 4,
};
/** 运行状态名跟语言走；未知状态原样返回 */
function statusName(k: string): string {
  return STATUS_KEYS.includes(k) ? tr(('mp.st.' + k) as any) : k;
}

/** 容器状态原文是 docker 的英文（running/unknown/missing…），行内显示跟语言走 */
const DOCKER_STATE_KEYS: Record<string, string> = {
  running: 'mp.docker.running',
  exited: 'mp.docker.exited',
  paused: 'mp.docker.paused',
  created: 'mp.docker.created',
  restarting: 'mp.docker.restarting',
  missing: 'mp.docker.missing',
  unknown: 'mp.docker.unknown',
};
function dockerStateName(v?: string): string {
  if (!v) return '';
  const k = DOCKER_STATE_KEYS[v];
  return k ? tr(k as any) : v;
}

const runningCount = computed(() => projects.value.filter((p) => statuses.value[p.id]?.status === 'running').length);

/* ---------------- 本机资源监控（后端按平台采集，3 秒刷新） ---------------- */
const sys = ref<any>(null);
let sysTimer: ReturnType<typeof setInterval> | null = null;

async function loadSys() {
  try {
    const r = await fetch('/api/system/stats');
    if (r.ok) sys.value = await r.json();
  } catch {
    /* 后端未就绪时保留上一帧 */
  }
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
function fmtRate(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : `${fmtBytes(n)}/s`;
}
function fmtUptime(sec: number | null | undefined): string {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? tr('mp.dur.dh', { d, h }) : h ? tr('mp.dur.hm', { h, m }) : tr('mp.dur.m', { m });
}
function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n)}%`;
}
function barStyle(n: number | null | undefined) {
  return { width: `${Math.max(0, Math.min(100, Number(n) || 0))}%` };
}

/**
 * 内存主口径用「App 内存」（匿名页）：关掉程序会立刻下降。
 * 拿不到 App 明细的平台（Windows）退回总已用，行为与以前一致。
 */
const memAppBytes = computed<number | null>(() => sys.value?.mem?.appBytes ?? sys.value?.mem?.usedBytes ?? null);
const memAppPct = computed<number | null>(() => sys.value?.mem?.appPct ?? sys.value?.mem?.usagePct ?? null);
/** 压缩内存 / Swap 只有 macOS、Linux 才有明细 */
const memDetail = computed(() => {
  const m = sys.value?.mem;
  if (!m) return '';
  const bits: string[] = [];
  if (m.compressedBytes != null) bits.push(tr('mp.mem.compressed', { v: fmtBytes(m.compressedBytes) }));
  if (m.swapUsedBytes != null && m.swapUsedBytes > 0) bits.push(`Swap ${fmtBytes(m.swapUsedBytes)}`);
  if (m.pressureFreePct != null) bits.push(tr('mp.mem.pressure', { v: m.pressureFreePct }));
  return bits.join(' · ');
});

/* ---------------- 采集权限提示：右上角小图标 + 悬浮卡片 + 一键复制 ---------------- */
const sudoUndoCmd = 'sudo rm /etc/sudoers.d/mishiguanli-gpu';
/** macOS 的 GPU 利用率 / 散热压力只能走 powermetrics，要 root，所以给一条一次性授权命令 */
const gpuSudoCmd = computed(() => {
  const user = sys.value?.user || '$USER';
  return `echo "${user} ALL=(root) NOPASSWD: /usr/bin/powermetrics" | sudo tee /etc/sudoers.d/mishiguanli-gpu >/dev/null && sudo chmod 440 /etc/sudoers.d/mishiguanli-gpu`;
});
/** Apple Silicon 的 powermetrics 没有 smc 采样器，温度得靠 smctemp 读 SMC */
const tempSudoCmd = computed(() => {
  const user = sys.value?.user || '$USER';
  return `brew install smctemp && echo "${user} ALL=(root) NOPASSWD: /usr/local/bin/smctemp /opt/homebrew/bin/smctemp" | sudo tee /etc/sudoers.d/mishiguanli-temp >/dev/null && sudo chmod 440 /etc/sudoers.d/mishiguanli-temp`;
});

async function copyText(text: string, label = tr('mp.copyCmd')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(tr('mp.toast.copied', { label }));
  } catch {
    // 剪贴板 API 不可用时的兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? tr('mp.toast.copied', { label }) : tr('mp.toast.copyFail'));
  }
}
const tipOpen = ref('');

/**
 * 一张卡 = 主项目 + 挂在它下面的子节点（parent）。
 * 子节点在数据里仍是独立记录（探测/日志/引用计数都要独立身份），只是不再单独占一张卡。
 */
const cards = computed(() => {
  const ids = new Set(projects.value.map((p) => p.id));
  const mains = projects.value.filter((p) => !p.parent || !ids.has(p.parent));
  return (
    mains
      .map((main) => ({
        main,
        children: projects.value.filter((c) => c.parent === main.id),
      }))
      // 按展示状态排：在跑的在最上面，随探测每 3 秒自动沉浮
      .sort((a, b) => (STATUS_RANK[dispStatus(a)] ?? 5) - (STATUS_RANK[dispStatus(b)] ?? 5))
  );
});

/** 编辑时可选的主项目：排除自己，避免 parent 自指；依赖节点也能改成独立卡片 */
const parentOptions = computed(() => projects.value.filter((p: any) => p.id !== form.id.trim()));
const parentLabel = computed(() => {
  const id = form.parent.trim();
  if (!id) return '';
  return projects.value.find((p: any) => p.id === id)?.name || id;
});

function toast(t: string) {
  toastText.value = t;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastText.value = '';
  }, 4000);
}

function statusOf(p: any): string {
  return statuses.value[p.id]?.status || 'stopped';
}
function statusText(p: any): string {
  return statusName(statusOf(p));
}

/** 主项目自己的探测目标（端口 / 容器）。两者都没有 → 这张卡是「聚合卡」，状态与端口按依赖汇总显示 */
function hasOwnProbe(p: any): boolean {
  return (p.probe?.ports || []).length > 0 || !!p.probe?.docker;
}
/** 是否由本应用托管启动过（runtime 里有登记的 pid，外部启动的没有） */
function isManaged(p: any): boolean {
  return (statuses.value[p.id]?.pids || []).length > 0;
}
/** 聚合卡：自己没配探测目标、也不是本应用启动的（如焱云Bot 客户端这种「壳」） */
function isAggregate(card: { main: any; children: any[] }): boolean {
  return card.children.length > 0 && !hasOwnProbe(card.main) && !isManaged(card.main);
}
/**
 * 展示状态：普通卡直接用探测结果；聚合卡按依赖推导，
 * 避免「依赖全在跑、主卡片却永远显示已停止」的矛盾观感。
 */
function dispStatus(card: { main: any; children: any[] }): string {
  if (!isAggregate(card)) return statusOf(card.main);
  const kids = card.children.map((c) => statusOf(c));
  if (kids.every((k) => k === 'running')) return 'running';
  if (kids.some((k) => k === 'running' || k === 'starting' || k === 'waiting')) return 'waiting';
  return statusOf(card.main);
}
function dispStatusText(card: { main: any; children: any[] }): string {
  return statusName(dispStatus(card));
}

async function load() {
  try {
    const r = await fetch('/api/myprojects');
    const j = await r.json();
    projects.value = j.projects || [];
    statuses.value = j.statuses || {};
    sharing.value = j.sharing || {};
  } catch (e) {
    toast(tr('mp.toast.loadFail', { msg: (e as Error).message }));
  }
}

/* ---------------- 共享依赖：重复登记的同资源节点「亮灯」+ 一键整理 ---------------- */
/** 节点 id → 与它同资源的其他项目名；有值说明这个依赖被多个项目共用 */
const sharing = ref<Record<string, { id: string; name: string }[]>>({});
function shareLabel(id: string): string {
  return (sharing.value[id] || []).map((o) => o.name).join('、');
}
const dupCount = computed(() => Object.keys(sharing.value).length);

async function shareFix() {
  if (!dupCount.value) {
    toast(tr('mp.toast.noDup'));
    return;
  }
  const names = projects.value
    .filter((p) => sharing.value[p.id])
    .map((p) => p.name)
    .join('、');
  if (!confirm(tr('mp.confirm.share', { names }))) return;
  try {
    const r = await fetch('/api/myprojects/shared-dedupe', { method: 'POST' });
    const j = await r.json();
    toast(
      j.changed?.length
        ? tr('mp.toast.shared', { v: j.changed.map((c: any) => c.name).join(', ') })
        : tr('mp.toast.noChange')
    );
    await load();
  } catch (e) {
    toast((e as Error).message);
  }
}

async function act(p: any, action: 'start' | 'stop', body: any = {}) {
  busy.value = { ...busy.value, [p.id]: true };
  try {
    const r = await fetch(`/api/myprojects/${encodeURIComponent(p.id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) toast(j.error || tr('mp.toast.fail'));
    else
      toast(action === 'start' ? tr('mp.toast.starting', { name: p.name }) : tr('mp.toast.stopping', { name: p.name }));
  } catch (e) {
    toast((e as Error).message);
  }
  setTimeout(() => {
    busy.value = { ...busy.value, [p.id]: false };
  }, 1200);
}

// ===== 关闭预演：先看清「停哪些、留哪些」，再动手 =====
const stopPlan = ref<{ p: any; plan: any; cascade: boolean; only: 'all' | 'deps' } | null>(null);
const stopBusy = ref(false);

/**
 * 关闭预演。only='deps' 是「只关依赖、主程序留着」，
 * cascade=false 是「只停主程序、依赖留着」——两个方向都要能选。
 */
async function closeWithPlan(p: any, cascade: boolean, only: 'all' | 'deps' = 'all') {
  busy.value = { ...busy.value, [p.id]: true };
  try {
    const r = await fetch(`/api/myprojects/${encodeURIComponent(p.id)}/stop-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cascade, only }),
    });
    const j = await r.json();
    if (!r.ok) {
      toast(j.error || tr('mp.toast.noPlan'));
      return;
    }
    if (only === 'deps' && !(j.targets || []).length) {
      toast(tr('mp.toast.noDeps'));
      return;
    }
    stopPlan.value = { p, plan: j, cascade, only };
  } catch (e) {
    toast((e as Error).message);
  } finally {
    busy.value = { ...busy.value, [p.id]: false };
  }
}

async function confirmStop() {
  const s = stopPlan.value;
  if (!s) return;
  stopBusy.value = true;
  const names = (s.plan.targets || []).map((t: any) => t.name).join('、');
  try {
    const r = await fetch(`/api/myprojects/${encodeURIComponent(s.p.id)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cascade: s.cascade, only: s.only }),
    });
    const j = await r.json();
    toast(r.ok ? tr('mp.toast.closing', { v: names }) : j.error || tr('mp.toast.fail'));
    stopPlan.value = null;
  } catch (e) {
    toast((e as Error).message);
  } finally {
    stopBusy.value = false;
  }
}

// ===== 体检：扫目录，找出「有关但没登记」的节点 =====
const diag = ref<any | null>(null);
const diagBusy = ref(false);

async function openDiag(p?: any) {
  const id = p?.id || form.id.trim() || 'new';
  const cwd = p?.cwd || form.cwd.trim();
  if (!cwd) {
    toast(tr('mp.toast.needCwd'));
    return;
  }
  diag.value = { p, id, cwd, loading: true, result: null, selected: [] };
  try {
    const r = await fetch(`/api/myprojects/${encodeURIComponent(id)}/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    const j = await r.json();
    if (!r.ok) {
      toast(j.error || tr('mp.toast.diagFail'));
      diag.value = null;
      return;
    }
    diag.value = {
      p,
      id,
      cwd,
      loading: false,
      result: j,
      selected: (j.suggestions || []).filter((s: any) => !s.registered).map((s: any) => s.id),
    };
  } catch (e) {
    toast((e as Error).message);
    diag.value = null;
  }
}

function toggleDiag(id: string) {
  const d = diag.value;
  if (!d) return;
  d.selected = d.selected.includes(id) ? d.selected.filter((x: string) => x !== id) : [...d.selected, id];
}

async function applyDiag() {
  const d = diag.value;
  if (!d) return;
  const chosen = (d.result.suggestions || []).filter((s: any) => d.selected.includes(s.id));
  if (!chosen.length) {
    toast(tr('mp.toast.noSel'));
    return;
  }
  diagBusy.value = true;
  try {
    // 被依赖的节点先写，主项目后写，避免「依赖项目不存在」
    const ordered = [...chosen].sort((a: any, b: any) => (a.dependsOn?.length ? 1 : 0) - (b.dependsOn?.length ? 1 : 0));
    const r = await fetch('/api/myprojects/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: ordered }),
    });
    const j = await r.json();
    const fail = (j.results || []).filter((x: any) => !x.ok);
    if (fail.length) {
      toast(
        tr('mp.toast.regPartial', {
          ok: j.results.length - fail.length,
          bad: fail.length,
          err: fail.map((f: any) => (f.errors || []).join('; ')).join(' / '),
        })
      );
    } else toast(tr('mp.toast.regOk', { n: j.results.length }));
    diag.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message);
  } finally {
    diagBusy.value = false;
  }
}

async function viewLogs(p: any) {
  logFor.value = p.name;
  logs.value = [];
  try {
    const r = await fetch(`/api/myprojects/${encodeURIComponent(p.id)}/logs`);
    const j = await r.json();
    logs.value = j.logs || [];
    if (!logs.value.length) toast(tr('mp.toast.noLogs'));
  } catch (e) {
    toast((e as Error).message);
  }
}

function openNew() {
  editing.value = null;
  Object.assign(form, {
    id: '',
    name: '',
    cwd: '',
    pathMac: '',
    notes: '',
    tags: '',
    url: '',
    healthUrl: '',
    fingerprint: '',
    mode: 'any',
    kind: 'process',
    stopCommand: '',
    stopPolicy: 'cascade',
    shared: false,
    registeredBy: '',
    parent: '',
  });
  cmdText.value = '';
  portsText.value = '';
  depsText.value = '';
  showForm.value = true;
}

function edit(p: any) {
  editing.value = p;
  Object.assign(form, {
    id: p.id,
    name: p.name || '',
    cwd: p.cwd || '',
    pathMac: p.pathMac || '',
    notes: p.notes || '',
    tags: (p.tags || []).join(', '),
    url: p.probe?.url || '',
    healthUrl: p.probe?.healthUrl || '',
    fingerprint: p.probe?.fingerprint || '',
    mode: p.probe?.mode || 'any',
    kind: p.kind || 'process',
    stopCommand: p.stopCommand || '',
    stopPolicy: p.stopPolicy || 'cascade',
    shared: !!p.shared,
    registeredBy: p.registeredBy || '',
    parent: p.parent || '',
  });
  cmdText.value = (p.commands || []).map((c: any) => c.cmd).join('\n');
  portsText.value = (p.probe?.ports || []).join(', ');
  depsText.value = (p.dependsOn || []).join(', ');
  showForm.value = true;
}

function buildPayload() {
  const lines = cmdText.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const rebuilt = lines.map((cmd, i) => ({ cmd, kind: i === lines.length - 1 ? 'service' : 'setup' }));
  const old = (editing.value?.commands || []).map((c: any) => c.cmd);
  const commands =
    JSON.stringify(old) === JSON.stringify(lines) && editing.value?.commands?.length ? editing.value.commands : rebuilt;
  const ports = portsText.value
    .split(/[,，\s]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
  const dependsOn = depsText.value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    cwd: form.cwd.trim(),
    pathMac: form.pathMac.trim() || undefined,
    notes: form.notes.trim() || undefined,
    tags: form.tags
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    kind: form.kind,
    commands,
    stopCommand: form.stopCommand.trim() || undefined,
    stopPolicy: form.stopPolicy,
    shared: form.shared,
    registeredBy: form.registeredBy.trim() || undefined,
    // 空串 = 解绑（后端会把空 parent 归一成 undefined）
    parent: form.parent.trim(),
    dependsOn,
    probe: {
      ports,
      url: form.url.trim() || undefined,
      healthUrl: form.healthUrl.trim() || undefined,
      fingerprint: form.fingerprint.trim() || undefined,
      mode: form.mode,
    },
  };
}

async function save() {
  const payload = buildPayload();
  const isEdit = !!editing.value;
  const url = isEdit ? `/api/myprojects/${encodeURIComponent(payload.id)}` : '/api/myprojects';
  try {
    const r = await fetch(url, {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) {
      toast(tr('mp.toast.saveFail', { v: (j.errors || []).join('; ') }));
      return;
    }
    if (j.warnings?.length) toast(tr('mp.toast.savedWarn', { v: j.warnings.join('; ') }));
    else toast(tr('mp.toast.saved'));
    showForm.value = false;
    await load();
  } catch (e) {
    toast((e as Error).message);
  }
}

async function remove(p: any) {
  const kids = projects.value.filter((c) => c.parent === p.id);
  const extra = kids.length ? tr('mp.deleteExtra', { names: kids.map((k) => k.name).join(', ') }) : '';
  if (!confirm(tr('mp.confirm.delete', { name: p.name, extra }))) return;
  await fetch(`/api/myprojects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
  await load();
}

onMounted(() => {
  load();
  loadSys();
  sysTimer = setInterval(loadSys, 3000);
  try {
    es = new EventSource('/api/myprojects/events');
    es.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data);
        if (j.type === 'status') statuses.value = j.statuses || {};
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* 不支持 SSE 时退化为手动刷新 */
  }
});
onUnmounted(() => {
  es?.close();
  es = null;
  if (toastTimer) clearTimeout(toastTimer);
  if (sysTimer) {
    clearInterval(sysTimer);
    sysTimer = null;
  }
});
</script>

<template>
  <section class="mp-page">
    <div class="page-head">
      <div>
        <h2>{{ tr('mp.title') }}</h2>
        <p>{{ tr('mp.lead') }}</p>
      </div>
      <div class="head-actions">
        <button type="button" @click="load()">{{ tr('mp.refresh') }}</button>
        <button type="button" :class="{ warn: dupCount }" @click="shareFix()">
          {{ tr('mp.shareFix') }}<template v-if="dupCount"> · {{ dupCount }}</template>
        </button>
        <button type="button" class="primary" @click="openNew()">{{ tr('mp.new') }}</button>
      </div>
    </div>

    <!-- 本机资源监控：CPU / 内存 / 磁盘 / 网络 / GPU / 温度（按平台采集，拿不到的标「不可用」） -->
    <div v-if="sys" class="mp-sys">
      <div class="sys-cell">
        <span>CPU</span>
        <b>{{ pct(sys.cpu.usagePct) }}</b>
        <i>{{ tr('mp.cores', { n: sys.cpu.cores, load: sys.cpu.load1 != null ? sys.cpu.load1.toFixed(2) : '—' }) }}</i>
        <div class="sys-bar"><em :style="barStyle(sys.cpu.usagePct)" /></div>
      </div>
      <div class="sys-cell">
        <span>{{ tr('mp.mem.app') }}</span>
        <b>{{ pct(memAppPct) }}</b>
        <i>{{ fmtBytes(memAppBytes) }} / {{ fmtBytes(sys.mem.totalBytes) }}</i>
        <i v-if="memDetail">{{ memDetail }}</i>
        <div class="sys-bar"><em :style="barStyle(memAppPct)" /></div>
      </div>
      <div class="sys-cell">
        <span>{{ tr('mp.disk') }}</span>
        <b>{{ pct(sys.disk.usagePct) }}</b>
        <i>{{ tr('mp.free', { v: fmtBytes(sys.disk.freeBytes) }) }}</i>
        <div class="sys-bar"><em :style="barStyle(sys.disk.usagePct)" /></div>
      </div>
      <div class="sys-cell">
        <span>{{ tr('mp.net') }}</span>
        <b>↓ {{ fmtRate(sys.net.rxBps) }}</b>
        <i>↑ {{ fmtRate(sys.net.txBps) }}</i>
      </div>
      <div v-if="sys.gpu" class="sys-cell">
        <span>GPU</span>
        <b>{{ sys.gpu.usagePct == null ? '—' : sys.gpu.usagePct + '%' }}</b>
        <i
          >{{ sys.gpu.name
          }}<template v-if="sys.gpu.cores"> · {{ tr('mp.coresShort', { n: sys.gpu.cores }) }}</template></i
        >
        <i v-if="sys.gpu.memUsedBytes != null"
          >{{ tr('mp.vram', { v: fmtBytes(sys.gpu.memUsedBytes) })
          }}<template v-if="sys.gpu.powerW != null"> · {{ sys.gpu.powerW }}W</template></i
        >
        <i v-if="sys.gpu.usagePct == null && sys.gpu.usageNote">{{ sys.gpu.usageNote }}</i>
        <div class="sys-help" @mouseenter="tipOpen = 'gpu'" @mouseleave="tipOpen = ''">
          <button type="button" class="sys-help-btn" @click="tipOpen = 'gpu'">?</button>
          <div v-show="tipOpen === 'gpu'" class="sys-tip">
            <p>
              <b>{{ tr('mp.gpuTipTitle') }}</b
              >: {{ tr('mp.gpuTip') }}
            </p>
            <pre>{{ gpuSudoCmd }}</pre>
            <div class="sys-tip-actions">
              <button type="button" @click="copyText(gpuSudoCmd, tr('mp.label.auth'))">{{ tr('mp.copyCmd') }}</button>
              <button type="button" class="ghost" @click="copyText(sudoUndoCmd, tr('mp.label.revoke'))">
                {{ tr('mp.copyUndo') }}
              </button>
            </div>
            <p class="sys-tip-foot">
              {{ tr('mp.tipFootGpu') }} <code>{{ sudoUndoCmd }}</code>
            </p>
          </div>
        </div>
      </div>
      <div class="sys-cell">
        <span>{{ tr('mp.temp') }}</span>
        <b>{{ sys.temp && sys.temp.cpuC != null ? sys.temp.cpuC + '°C' : '—' }}</b>
        <i v-if="sys.temp && sys.temp.cpuC != null">{{ sys.temp.source }}</i>
        <i v-else-if="sys.temp && sys.temp.thermalPressure">{{ tr('mp.thermal', { v: sys.temp.thermalPressure }) }}</i>
        <i v-else>{{ tr('mp.unavailable') }}</i>
        <i v-if="sys.temp && sys.temp.cpuC == null && sys.temp.note">{{ sys.temp.note }}</i>
        <div class="sys-help" @mouseenter="tipOpen = 'temp'" @mouseleave="tipOpen = ''">
          <button type="button" class="sys-help-btn" @click="tipOpen = 'temp'">?</button>
          <div v-show="tipOpen === 'temp'" class="sys-tip">
            <p>
              <b>{{ tr('mp.tempTipTitle') }}</b
              >: {{ tr('mp.tempTip') }}
            </p>
            <pre>{{ tempSudoCmd }}</pre>
            <div class="sys-tip-actions">
              <button type="button" @click="copyText(tempSudoCmd, tr('mp.label.temp'))">{{ tr('mp.copyCmd') }}</button>
            </div>
            <p class="sys-tip-foot">{{ tr('mp.tipFootTemp') }}</p>
          </div>
        </div>
      </div>
      <div class="sys-cell">
        <span>{{ tr('mp.uptime') }}</span>
        <b>{{ fmtUptime(sys.uptimeSec) }}</b>
        <i>{{ sys.hostname }}</i>
      </div>
    </div>

    <div class="mp-summary">
      <span
        >{{ tr('mp.summary', { n: cards.length })
        }}<template v-if="projects.length > cards.length">{{
          tr('mp.summaryNodes', { n: projects.length })
        }}</template></span
      >
      <span class="ok">{{ tr('mp.running', { n: runningCount }) }}</span>
      <!-- 灯色图例：每盏灯对应什么状态，对号入座 -->
      <span class="mp-legend" :title="tr('mp.legendTitle')">
        <i class="dot st-running" /><b>{{ tr('mp.st.running') }}</b> <i class="dot st-starting" /><b>{{
          tr('mp.st.starting')
        }}</b>
        <i class="dot st-stopped" /><b>{{ tr('mp.st.stopped') }}</b> <i class="dot st-failed" /><b>{{
          tr('mp.st.unhealthy')
        }}</b>
        <i class="dot st-unknown" /><b>{{ tr('mp.st.unknown') }}</b>
      </span>
      <span class="grow" />
      <!-- 规则说明收进小图标：悬停/点击弹出，不再常占一行字 -->
      <span class="mp-info" @mouseenter="tipOpen = 'probe'" @mouseleave="tipOpen = ''">
        <button type="button" class="sys-help-btn" :aria-label="tr('mp.tipProbeTitle')" @click="tipOpen = 'probe'">
          ?
        </button>
        <div v-show="tipOpen === 'probe'" class="sys-tip">
          <p>
            <b>{{ tr('mp.tipProbeTitle') }}</b
            >: {{ tr('mp.tipProbe') }}
          </p>
        </div>
      </span>
      <span class="mp-info" @mouseenter="tipOpen = 'stop'" @mouseleave="tipOpen = ''">
        <button type="button" class="sys-help-btn" :aria-label="tr('mp.tipStopTitle')" @click="tipOpen = 'stop'">
          ?
        </button>
        <div v-show="tipOpen === 'stop'" class="sys-tip">
          <p>
            <b>{{ tr('mp.tipStopTitle') }}</b
            >: {{ tr('mp.tipStop') }}
          </p>
        </div>
      </span>
    </div>

    <div v-if="!projects.length" class="mp-empty">
      {{ tr('mp.empty1') }}<code>project_upsert</code>{{ tr('mp.empty2') }}
    </div>

    <div v-else class="mp-grid">
      <article v-for="card in cards" :key="card.main.id" class="mp-card">
        <header>
          <!-- 第一行只放状态灯 + 名称；标签统一在第二行，长名称不再和标签挤在一起顶串行 -->
          <div class="mp-head-name">
            <span class="dot" :class="'st-' + dispStatus(card)" :title="dispStatusText(card)" />
            <h3 :title="card.main.name">{{ card.main.name }}</h3>
          </div>
          <div class="mp-head-meta">
            <span class="mp-tag">{{ card.main.kind || 'process' }}</span>
            <span v-if="card.children.length" class="mp-tag count">{{
              tr('mp.depsCount', { n: card.children.length })
            }}</span>
            <!-- 聚合卡（自己没端口/容器探测，也不由本应用托管）：状态与端口都是按依赖汇总的，明示出来避免误读 -->
            <span v-if="isAggregate(card)" class="mp-tag tiny alt">{{ tr('mp.aggregate') }}</span>
          </div>
        </header>

        <!-- 状态紧跟标题：启动中/运行中一眼可见，不再固定在卡片中部 -->
        <div class="mp-status">
          <span class="badge" :class="'st-' + dispStatus(card)">{{ dispStatusText(card) }}</span>
          <span v-if="statuses[card.main.id]?.lastError" class="err">{{ statuses[card.main.id].lastError }}</span>
        </div>

        <div class="mp-line mono">{{ card.main.cwd }}</div>
        <div class="mp-line">
          <template v-if="(card.main.probe?.ports || []).length">
            {{ tr('mp.ports') }}
            <b
              v-for="q in card.main.probe.ports"
              :key="q"
              :class="{ open: (statuses[card.main.id]?.portsOpen || []).includes(q) }"
              >{{ q }}</b
            >
          </template>
          <!-- 主项目自己没配端口时，把各依赖的端口汇总到卡片上部：绿=在监听，灰=没起来；悬停看归属 -->
          <template v-else-if="card.children.some((c) => (c.probe?.ports || []).length)">
            {{ tr('mp.depPorts') }}
            <template v-for="c in card.children" :key="c.id">
              <b
                v-for="q in c.probe?.ports || []"
                :key="c.id + ':' + q"
                :class="{ open: (statuses[c.id]?.portsOpen || []).includes(q) }"
                :title="c.name"
                >{{ q }}</b
              >
            </template>
          </template>
          <a
            v-if="card.main.probe?.url && dispStatus(card) === 'running'"
            :href="card.main.probe.url"
            target="_blank"
            rel="noreferrer"
            >{{ tr('mp.openLink') }}</a
          >
        </div>

        <!-- 子节点：各自状态与独立开关，一眼看出是哪个挂了 -->
        <div v-if="card.children.length" class="mp-children">
          <div v-for="c in card.children" :key="c.id" class="mp-child" :class="'st-' + statusOf(c)">
            <span class="dot" :class="'st-' + statusOf(c)" :title="statusText(c)" />
            <b :title="c.name">{{ c.name }}</b>
            <code v-if="(c.probe?.ports || []).length">:{{ c.probe.ports.join(',') }}</code>
            <span class="mp-tag tiny">{{ statusText(c) }}</span>
            <!-- 被多个项目登记为同一份资源时亮灯，一眼看出「这个库是共用的」 -->
            <span v-if="shareLabel(c.id)" class="mp-share" :title="tr('mp.shareTitle', { v: shareLabel(c.id) })">
              <em class="lamp" />{{ tr('mp.shared') }} · {{ shareLabel(c.id) }}
            </span>
            <span v-else-if="c.shared" class="mp-tag tiny alt">{{ tr('mp.shared') }}</span>
            <span v-if="statuses[c.id]?.dockerState" class="muted small">{{
              tr('mp.container', { v: dockerStateName(statuses[c.id].dockerState) })
            }}</span>
            <span v-if="statuses[c.id]?.residual" class="err small">{{ tr('mp.residual') }}</span>
            <span class="grow" />
            <button type="button" class="tiny" :disabled="busy[c.id]" @click="act(c, 'start')">
              {{ tr('mp.start') }}
            </button>
            <button type="button" class="tiny" :disabled="busy[c.id]" @click="act(c, 'stop', { cascade: false })">
              {{ tr('mp.stop') }}
            </button>
            <!-- 依赖节点也要能改：容器/数据库的 stopCommand、端口、挂靠关系都在这里 -->
            <button type="button" class="tiny" @click="edit(c)">{{ tr('mp.edit') }}</button>
            <button type="button" class="tiny danger" @click="remove(c)">{{ tr('mp.delete') }}</button>
          </div>
        </div>

        <div v-if="statuses[card.main.id]?.residual" class="mp-residual">
          <b>{{ tr('mp.residual') }}</b>
          <span v-if="statuses[card.main.id].residual.ports?.length">{{
            tr('mp.residualPorts', { v: statuses[card.main.id].residual.ports.join(', ') })
          }}</span>
          <span v-if="statuses[card.main.id].residual.containers?.length">{{
            tr('mp.residualContainers', { v: statuses[card.main.id].residual.containers.join(', ') })
          }}</span>
          <span class="muted">{{ tr('mp.residualHint') }}</span>
        </div>

        <div class="mp-actions">
          <button type="button" class="primary" :disabled="busy[card.main.id]" @click="act(card.main, 'start')">
            {{ tr('mp.start') }}
          </button>
          <button type="button" :disabled="busy[card.main.id]" @click="closeWithPlan(card.main, true)">
            {{ card.children.length ? tr('mp.closeWithDeps') : tr('mp.close') }}
          </button>
          <button
            type="button"
            :disabled="busy[card.main.id] || !card.children.length"
            @click="closeWithPlan(card.main, true, 'deps')"
          >
            {{ tr('mp.closeDepsOnly') }}
          </button>
          <button type="button" :disabled="busy[card.main.id]" @click="closeWithPlan(card.main, false)">
            {{ tr('mp.stopMainOnly') }}
          </button>
          <button type="button" @click="openDiag(card.main)">{{ tr('mp.diag') }}</button>
          <button type="button" @click="viewLogs(card.main)">{{ tr('mp.logs') }}</button>
          <button type="button" @click="edit(card.main)">{{ tr('mp.edit') }}</button>
          <button type="button" class="danger" @click="remove(card.main)">{{ tr('mp.delete') }}</button>
        </div>

        <details v-if="card.main.notes || (card.main.commands || []).length">
          <summary>{{ tr('mp.steps') }}</summary>
          <ol class="mp-steps">
            <li v-for="(c, i) in card.main.commands" :key="i">
              <span class="mp-tag">{{ c.kind === 'service' ? tr('mp.stepService') : tr('mp.stepPrepare') }}</span>
              <code>{{ c.cmd }}</code>
            </li>
          </ol>
          <p v-if="card.main.stopCommand">
            {{ tr('mp.stopCmd') }}<code>{{ card.main.stopCommand }}</code>
          </p>
          <p v-if="card.main.notes" class="muted">{{ card.main.notes }}</p>
        </details>
      </article>
    </div>

    <div v-if="showForm" class="mp-mask" @click.self="showForm = false">
      <div class="mp-form">
        <h3>{{ editing ? tr('mp.formEdit') : tr('mp.formNew') }}</h3>
        <p v-if="form.parent" class="mp-hint">{{ tr('mp.parentHint', { name: parentLabel }) }}</p>
        <div class="fields">
          <label>{{ tr('mp.f.id') }} <input v-model="form.id" :disabled="!!editing" placeholder="flintkeep" /></label>
          <label>{{ tr('mp.f.name') }} <input v-model="form.name" :placeholder="tr('mp.f.namePh')" /></label>
          <label class="wide">{{ tr('mp.f.cwd') }} <input v-model="form.cwd" placeholder="~/Projects/my-app" /></label>
          <label>{{ tr('mp.f.pathMac') }} <input v-model="form.pathMac" /></label>
          <label
            >{{ tr('mp.f.kind') }}
            <select v-model="form.kind">
              <option value="process">{{ tr('mp.kind.process') }}</option>
              <option value="compose">Docker Compose</option>
              <option value="docker">{{ tr('mp.kind.docker') }}</option>
            </select>
          </label>
          <label
            >{{ tr('mp.f.parent') }}
            <select v-model="form.parent">
              <option value="">{{ tr('mp.standalone') }}</option>
              <option v-for="o in parentOptions" :key="o.id" :value="o.id">{{ o.name }} · {{ o.id }}</option>
            </select>
          </label>
          <label class="wide"
            >{{ tr('mp.f.cmds') }}
            <textarea v-model="cmdText" rows="4" placeholder="npm install&#10;npm run dev" />
          </label>
          <label>{{ tr('mp.f.ports') }} <input v-model="portsText" placeholder="8787, 8790" /></label>
          <label>{{ tr('mp.f.url') }} <input v-model="form.url" placeholder="http://127.0.0.1:8790" /></label>
          <label>{{ tr('mp.f.healthUrl') }} <input v-model="form.healthUrl" /></label>
          <label class="wide"
            >{{ tr('mp.f.fingerprint') }} <input v-model="form.fingerprint" :placeholder="tr('mp.ph.fingerprint')"
          /></label>
          <label
            >{{ tr('mp.f.mode') }}
            <select v-model="form.mode">
              <option value="any">{{ tr('mp.mode.any') }}</option>
              <option value="all">{{ tr('mp.mode.all') }}</option>
            </select>
          </label>
          <label class="wide"
            >{{ tr('mp.f.stopCommand') }}<input v-model="form.stopCommand" placeholder="docker compose stop postgres"
          /></label>
          <label>{{ tr('mp.f.deps') }} <input v-model="depsText" placeholder="pg-main" /></label>
          <label
            >{{ tr('mp.f.stopPolicy') }}
            <select v-model="form.stopPolicy">
              <option value="cascade">{{ tr('mp.stop.cascade') }}</option>
              <option value="self">{{ tr('mp.stop.self') }}</option>
              <option value="keep">{{ tr('mp.stop.keep') }}</option>
            </select>
          </label>
          <label>{{ tr('mp.f.tags') }} <input v-model="form.tags" /></label>
          <label>{{ tr('mp.f.registeredBy') }} <input v-model="form.registeredBy" /></label>
          <label class="wide">{{ tr('mp.f.notes') }} <textarea v-model="form.notes" rows="2" /></label>
          <label class="check"><input type="checkbox" v-model="form.shared" /> {{ tr('mp.f.shared') }}</label>
        </div>
        <div class="bar">
          <button type="button" class="primary" @click="save()">{{ tr('common.btn.save') }}</button>
          <button type="button" @click="showForm = false">{{ tr('common.btn.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="stopPlan" class="mp-mask" @click.self="stopPlan = null">
      <div class="mp-form narrow">
        <h3>
          {{
            stopPlan.only === 'deps'
              ? tr('mp.stopPlan.depsOnly', { name: stopPlan.p.name })
              : tr('mp.stopPlan.title', { name: stopPlan.p.name })
          }}
        </h3>
        <p class="mp-hint">
          {{
            stopPlan.only === 'deps'
              ? tr('mp.stopPlan.depsOnlyHint')
              : stopPlan.cascade
                ? tr('mp.stopPlan.cascadeHint')
                : tr('mp.stopPlan.selfHint')
          }}
        </p>

        <div class="mp-group">
          <div class="mp-group-head">{{ tr('mp.stopPlan.willStop', { n: stopPlan.plan.targets?.length || 0 }) }}</div>
          <ul class="mp-list">
            <li v-for="t in stopPlan.plan.targets" :key="t.id">
              <span class="mp-tag">{{
                t.reason === 'self' ? tr('mp.stopPlan.selfTag') : tr('mp.stopPlan.depTag')
              }}</span>
              <b>{{ t.name }}</b>
              <code v-if="t.ports?.length">{{ tr('mp.stopPlan.ports', { v: t.ports.join(', ') }) }}</code>
            </li>
          </ul>
        </div>

        <div v-if="stopPlan.plan.survivors?.length" class="mp-group">
          <div class="mp-group-head">{{ tr('mp.stopPlan.willKeep', { n: stopPlan.plan.survivors.length }) }}</div>
          <ul class="mp-list muted">
            <li v-for="s in stopPlan.plan.survivors" :key="s.id + s.reason">
              <b>{{ s.name }}</b><span>· {{ s.reason }}</span>
            </li>
          </ul>
        </div>

        <p class="mp-hint">{{ tr('mp.stopPlan.hint') }}</p>
        <div class="bar">
          <button type="button" class="primary" :disabled="stopBusy" @click="confirmStop()">
            {{ tr('mp.stopPlan.confirm') }}
          </button>
          <button type="button" :disabled="stopBusy" @click="stopPlan = null">{{ tr('common.btn.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="diag" class="mp-mask" @click.self="diag = null">
      <div class="mp-form">
        <h3>{{ tr('mp.diag.title', { cwd: diag.cwd }) }}</h3>
        <p class="mp-hint">
          {{ tr('mp.diag.scanned', { v: (diag.result?.scanned || []).join(', ') || tr('mp.diag.noFiles') }) }}
          <b>{{ diag.result?.missing || 0 }}</b> {{ tr('mp.diag.found') }}
        </p>

        <div v-if="diag.loading" class="mp-empty">{{ tr('mp.diag.scanning') }}</div>
        <template v-else>
          <ul v-if="diag.result?.warnings?.length" class="mp-list warn">
            <li v-for="(w, i) in diag.result.warnings" :key="i">{{ w }}</li>
          </ul>

          <div v-if="!(diag.result?.suggestions || []).length" class="mp-empty">{{ tr('mp.diag.noSug') }}</div>

          <ul v-else class="mp-list">
            <li v-for="s in diag.result.suggestions" :key="s.id" :class="{ done: s.registered }">
              <label class="mp-check">
                <input
                  type="checkbox"
                  :checked="diag.selected.includes(s.id)"
                  :disabled="s.registered"
                  @change="toggleDiag(s.id)"
                />
                <b>{{ s.name }}</b>
                <span class="mp-tag">{{ s.kind }}</span>
                <span v-if="s.registered" class="mp-tag alt">{{ tr('mp.diag.registered') }}</span>
              </label>
              <div class="mp-evidence">{{ (s.evidence || []).join(' · ') }}</div>
              <div class="mp-evidence mono">
                <div v-for="(c, i) in s.commands" :key="i">{{ tr('mp.diag.startLine', { v: c.cmd }) }}</div>
                <div v-if="s.stopCommand">{{ tr('mp.diag.stopLine', { v: s.stopCommand }) }}</div>
                <div v-if="s.dependsOn?.length">{{ tr('mp.diag.depsLine', { v: s.dependsOn.join(', ') }) }}</div>
              </div>
              <div v-if="s.notes" class="mp-evidence muted">{{ s.notes }}</div>
            </li>
          </ul>
        </template>

        <div class="bar">
          <button type="button" class="primary" :disabled="diagBusy || diag.loading" @click="applyDiag()">
            {{ tr('mp.diag.register', { n: diag.selected.length }) }}
          </button>
          <button type="button" :disabled="diagBusy" @click="diag = null">{{ tr('mp.close') }}</button>
        </div>
      </div>
    </div>

    <div v-if="logFor" class="mp-mask" @click.self="logFor = ''">
      <div class="mp-form">
        <h3>{{ tr('mp.logs.title', { name: logFor }) }}</h3>
        <div v-for="l in logs" :key="l.step" class="mp-log">
          <div class="mp-tag">{{ l.step }}</div>
          <pre>{{ l.content || tr('mp.logs.empty') }}</pre>
        </div>
        <div class="bar">
          <button type="button" @click="logFor = ''">{{ tr('mp.close') }}</button>
        </div>
      </div>
    </div>

    <div v-if="toastText" class="mp-toast">{{ toastText }}</div>
  </section>
</template>

<style scoped>
/* 新模式：桥接层 .mg-legacy 已给 24px 内边距，页面自身不再叠一层（双倍内边距二选一，docs/运行工作台 F6） */
[data-mgui] .mp-page {
  padding: 0;
}
.mp-page {
  padding: 24px 28px;
  color: var(--text, #171717);
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.page-head h2 {
  margin: 0 0 6px;
  font-size: 22px;
}
.page-head p {
  margin: 0;
  color: var(--text-2, #5c5c5a);
  font-size: 13px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
button {
  border: 1px solid var(--border-strong, #e2e2df);
  background: var(--surface, #fff);
  color: var(--text, #171717);
  border-radius: 8px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 13px;
}
button:hover:not(:disabled) {
  border-color: var(--accent, #2f7ff0);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button.primary {
  background: var(--accent, #2f7ff0);
  border-color: var(--accent, #2f7ff0);
  color: var(--accent-ink, #fff);
}
button.danger {
  color: var(--danger, #d0453b);
}
.mp-sys {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(124px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.sys-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px 11px;
  border: 1px solid var(--border, #ececea);
  border-radius: 10px;
  background: var(--surface, #fff);
}
.sys-cell span {
  font-size: 11px;
  color: var(--text-3, #9a9a97);
  letter-spacing: 0.04em;
}
.sys-cell b {
  font-size: 16px;
  font-weight: 600;
}
.sys-cell i {
  font-size: 11px;
  font-style: normal;
  color: var(--text-3, #9a9a97);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sys-bar {
  height: 3px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--chip-bg, #f0f0ee);
  overflow: hidden;
}
.sys-bar em {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent, #2f7ff0);
  transition: width 0.4s ease;
}
/* 右上角问号：悬浮出说明卡片，命令可一键复制 */
.sys-help {
  position: absolute;
  top: 7px;
  right: 7px;
}
.sys-help-btn {
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border-strong, #e2e2df);
  background: var(--surface, #fff);
  color: var(--text-3, #9a9a97);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sys-help-btn:hover {
  color: var(--accent, #2f7ff0);
  border-color: var(--accent, #2f7ff0);
}
.sys-tip {
  position: absolute;
  right: 0;
  top: 22px;
  width: 300px;
  max-width: 70vw;
  padding: 10px 12px;
  border: 1px solid var(--border, #ececea);
  border-radius: 10px;
  background: var(--surface, #fff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  font-size: 12px;
  line-height: 1.55;
  text-align: left;
  z-index: 30;
}
.sys-tip p {
  margin: 0 0 6px;
  color: var(--text-2, #5c5c5a);
}
.sys-tip b {
  font-size: 12px;
  font-weight: 600;
}
.sys-tip pre {
  margin: 0 0 8px;
  padding: 8px;
  border-radius: 6px;
  background: var(--chip-bg, #f0f0ee);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-1, #252527);
  white-space: pre-wrap;
  word-break: break-all;
}
.sys-tip-actions {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.sys-tip-actions button {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--accent, #2f7ff0);
  background: var(--accent, #2f7ff0);
  color: var(--accent-ink, #fff);
  cursor: pointer;
}
.sys-tip-actions button.ghost {
  background: transparent;
  color: var(--text-2, #5c5c5a);
  border-color: var(--border-strong, #e2e2df);
}
.sys-tip-foot {
  margin: 0;
  font-size: 11px;
  color: var(--text-3, #9a9a97);
}
.sys-tip-foot code {
  padding: 1px 4px;
  background: var(--chip-bg, #f0f0ee);
  border-radius: 4px;
  word-break: break-all;
}
.mp-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: center;
  font-size: 13px;
  padding: 10px 14px;
  border: 1px solid var(--border, #ececea);
  border-radius: 10px;
  background: var(--surface, #fff);
  margin-bottom: 16px;
}
.mp-summary .ok {
  color: var(--ok, #1f9d55);
  font-weight: 600;
}
.mp-summary .grow {
  flex: 1;
}
.mp-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3, #9a9a97);
  flex-wrap: wrap;
}
.mp-legend .dot {
  width: 8px;
  height: 8px;
}
.mp-legend b {
  font-weight: 400;
  margin-right: 4px;
}
.mp-info {
  position: relative;
  display: inline-flex;
  flex: none;
}
.mp-info .sys-tip {
  top: 24px;
}
.muted {
  color: var(--text-3, #9a9a97);
}
.mp-empty {
  padding: 48px;
  text-align: center;
  color: var(--text-2, #5c5c5a);
  border: 1px dashed var(--border-strong, #e2e2df);
  border-radius: 12px;
}
.mp-empty code,
.mp-steps code {
  padding: 1px 5px;
  background: var(--chip-bg, #f0f0ee);
  border-radius: 4px;
}
/* 瀑布流（CSS 多列）：卡片按内容自然高度排布，矮卡不再在底部留大片空白 */
.mp-grid {
  columns: 360px;
  column-gap: 14px;
}
.mp-card {
  border: 1px solid var(--border, #ececea);
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 16px;
  margin-bottom: 14px;
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
}
.mp-card header {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.mp-head-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mp-head-name h3 {
  margin: 0;
  font-size: 16px;
  flex: 1;
  min-width: 0;
  line-height: 1.35;
  word-break: break-word;
}
.mp-head-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.mp-head-meta .mp-tag {
  flex: none;
  white-space: nowrap;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-3, #9a9a97);
  flex: none;
}
.dot.st-running {
  background: var(--ok, #1f9d55);
  box-shadow: 0 0 0 3px rgba(31, 157, 85, 0.15);
}
.dot.st-starting,
.dot.st-waiting {
  background: #e6a23c;
}
.dot.st-failed,
.dot.st-unhealthy {
  background: var(--danger, #d0453b);
}
/* 未知 = 拿不到状态（多半 Docker 没起）：空心环，别让人误读成实心绿灯那种「在跑」 */
.dot.st-unknown {
  background: transparent;
  border: 2px solid var(--info, #8a6bd1);
  box-sizing: border-box;
}
.mp-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--chip-bg, #f0f0ee);
  color: var(--text-2, #5c5c5a);
}
.mp-tag.alt {
  background: rgba(138, 107, 209, 0.15);
  color: var(--info, #8a6bd1);
}
.mp-line {
  margin-top: 8px;
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  color: var(--text-2, #5c5c5a);
}
.mp-line.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.mp-line b {
  font-weight: 500;
  color: var(--text-3, #9a9a97);
}
.mp-line b.open {
  color: var(--ok, #1f9d55);
}
.mp-line a {
  color: var(--accent, #2f7ff0);
  text-decoration: none;
}
.mp-status {
  margin: 10px 0 2px;
  min-height: 22px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.badge {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 6px;
  background: var(--chip-bg, #f0f0ee);
}
.badge.st-running {
  background: rgba(31, 157, 85, 0.14);
  color: var(--ok, #1f9d55);
}
.badge.st-failed,
.badge.st-unhealthy {
  background: rgba(208, 69, 59, 0.13);
  color: var(--danger, #d0453b);
}
.badge.st-starting,
.badge.st-waiting {
  background: rgba(230, 162, 60, 0.15);
  color: var(--warn, #b8791d);
}
/* 已停用/未知状态：与圆点同色系（图钉紫、停用灰），不再回退灰底灰字 */
.badge.st-stopped {
  background: rgba(154, 154, 151, 0.16);
  color: var(--text-2, #5c5c5a);
}
.badge.st-unknown {
  background: rgba(138, 107, 209, 0.15);
  color: var(--info, #8a6bd1);
  border: 1px dashed rgba(138, 107, 209, 0.45);
}
.err {
  font-size: 12px;
  color: var(--danger, #d0453b);
  word-break: break-all;
}
.mp-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mp-actions button {
  padding: 5px 9px;
  font-size: 12px;
}
details {
  margin-top: 12px;
  border-top: 1px solid var(--border, #ececea);
  padding-top: 10px;
  font-size: 12px;
  color: var(--text-2, #5c5c5a);
}
summary {
  cursor: pointer;
}
.mp-steps {
  padding-left: 20px;
  margin: 8px 0;
}
.mp-steps li {
  margin: 4px 0;
  word-break: break-all;
}
.mp-steps code {
  margin-left: 6px;
}
.mp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 90;
  padding: 24px;
}
.mp-form {
  width: min(760px, 100%);
  max-height: 88vh;
  overflow: auto;
  background: var(--surface, #fff);
  border-radius: 14px;
  padding: 22px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
.mp-form h3 {
  margin: 0 0 16px;
}
.fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
/* 窄屏单列：两列时每列不足 200px，输入框挤到不可用 */
@media (max-width: 560px) {
  .fields {
    grid-template-columns: 1fr;
  }
}
.fields .wide,
.fields .check {
  grid-column: 1 / -1;
}
.fields label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2, #5c5c5a);
}
.fields label.check {
  flex-direction: row;
  align-items: center;
}
input,
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-strong, #e2e2df);
  background: var(--surface-3, #f9f9f8);
  color: var(--text, #171717);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
}
textarea {
  resize: vertical;
}
.bar {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 18px;
}
.mp-log {
  margin-bottom: 14px;
}
.mp-log pre {
  max-height: 220px;
  overflow: auto;
  background: var(--surface-2, #f3f3f2);
  padding: 10px;
  border-radius: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.mp-toast {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: #252527;
  color: #fff;
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 13px;
  z-index: 100;
}

/* 关闭后残留提示：这是「没关干净」的唯一信号，必须显眼 */
.mp-residual {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(208, 69, 59, 0.08);
  border: 1px solid rgba(208, 69, 59, 0.28);
  font-size: 12px;
  color: #b23a31;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.mp-residual b {
  color: var(--danger, #d0453b);
}
.mp-form.narrow {
  width: min(560px, 100%);
}
.mp-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-2, #5c5c5a);
  line-height: 1.6;
}
.mp-group {
  margin-bottom: 14px;
}
.mp-group-head {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.mp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12px;
}
.mp-list li {
  padding: 8px 10px;
  border: 1px solid var(--border, #ececea);
  border-radius: 8px;
  margin-bottom: 6px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.mp-list li.done {
  opacity: 0.55;
}
.mp-list li.warn {
  border-color: rgba(230, 162, 60, 0.4);
  background: rgba(230, 162, 60, 0.07);
  display: block;
}
.mp-list code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-3, #9a9a97);
}
.mp-check {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  cursor: pointer;
}
.mp-check input {
  width: auto;
}
.mp-evidence {
  width: 100%;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-2, #5c5c5a);
  word-break: break-all;
}
.mp-evidence.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 子节点：一张卡里的小行，各自带状态与开关 */
.mp-tag.count {
  background: rgba(47, 127, 240, 0.12);
  color: var(--accent, #2f7ff0);
}
.mp-children {
  margin: 10px 0 12px;
  border: 1px solid var(--border, #ececea);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-3, #f9f9f8);
}
.mp-child {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-2, #5c5c5a);
  border-bottom: 1px solid var(--border, #ececea);
  flex-wrap: wrap;
}
.mp-child button {
  flex: none;
  white-space: nowrap;
}
.mp-child:last-child {
  border-bottom: 0;
}
.mp-child b {
  font-size: 12px;
  color: var(--text, #171717);
  font-weight: 500;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-child code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-3, #9a9a97);
}
.mp-child .grow {
  flex: 1;
}
.mp-child .small,
.small {
  font-size: 11px;
}
.mp-tag.tiny {
  padding: 1px 6px;
  font-size: 10px;
}
button.tiny {
  padding: 3px 8px;
  font-size: 11px;
}
/* 共享依赖亮灯：同一份资源被多个项目登记时挂在依赖行上 */
.mp-share {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--warn, #8a6100);
  background: rgba(242, 183, 5, 0.14);
  border: 1px solid rgba(242, 183, 5, 0.45);
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-share .lamp {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f2b705;
  box-shadow: 0 0 0 2px rgba(242, 183, 5, 0.28);
  flex: none;
}
button.warn {
  color: var(--warn, #8a6100);
  border-color: rgba(242, 183, 5, 0.55);
  background: rgba(242, 183, 5, 0.1);
}
</style>
