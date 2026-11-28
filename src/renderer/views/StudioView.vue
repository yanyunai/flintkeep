<script setup lang="ts">
/**
 * 机房页（自有实现，替代 vendor workstation-opc）
 * - 项目 = 资产库 type=project；服务器 = type=server；本机运行态 = /api/myprojects + SSE
 * - 场景：机房机柜 / 办公室工位，外观走 design/system 的 room/office 语义类
 * - 操作：打开入口 URL、服务器 TCP 检测、签发 SSH 代理、启停本机运行项目
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { uiScene } from '../ui/appearance';
import { auditActionLabel, roleLabel, statusLabel, typeLabel } from '../../core/schema';
import { lang, useT } from '../ui/i18n';

const tr = useT();
const emit = defineEmits<{ (e: 'edit-asset', asset: any): void; (e: 'new-asset', type: string): void }>();

type Check = { state: 'unknown' | 'checking' | 'ok' | 'fail'; ms?: number; error?: string };

const assets = ref<any[]>([]);
const myProjects = ref<any[]>([]);
const statuses = ref<Record<string, any>>({});
const sys = ref<any>(null);
const auditEvents = ref<any[]>([]);
const checks = ref<Record<string, Check>>({});
const offline = ref(false);
const locked = ref(false);
const filter = ref<'all' | 'live' | 'dev' | 'issue' | 'empty'>('all');
const q = ref('');
const sel = ref<any>(null);
const zoom = ref(1);
const toastMsg = ref('');
let toastTimer: any = null;
let es: EventSource | null = null;

const projects = computed(() => assets.value.filter((a) => a.type === 'project'));
const servers = computed(() => assets.value.filter((a) => a.type === 'server'));

/** 机位：3 行 × 4 列，按序号自动上架；archived 不上架 */
const COLS = 4;
const ROWS = 3;
const seats = computed(() => {
  const map: Record<string, any> = {};
  let i = 0;
  for (const p of projects.value) {
    if (p.status === 'archived') continue;
    if (i >= COLS * ROWS) break;
    const r = Math.floor(i / COLS), c = i % COLS;
    map[`${'ABC'[r]}-${String(c + 1).padStart(2, '0')}`] = p;
    i++;
  }
  return map;
});

function runtimeOf(p: any) {
  const name = String(p.name || '').toLowerCase();
  return myProjects.value.find((m) => {
    const mn = String(m.name || m.id || '').toLowerCase();
    return mn && (mn === name || name.includes(mn) || mn.includes(name));
  }) || null;
}
function runtimeState(p: any): 'running' | 'stopped' | '' {
  const m = runtimeOf(p);
  if (!m) return '';
  return statuses.value[m.id]?.running ? 'running' : 'stopped';
}
function nodeStatus(p: any): string {
  // 本机探活优先：进程真在跑就是 live，比手填状态可信
  if (runtimeState(p) === 'running') return 'live';
  if (p.status === 'live' || p.status === 'test') return 'live';
  if (p.status === 'idea') return 'idea';
  if (p.status === 'paused' || p.status === 'archived') return 'paused';
  return 'dev';
}
function serverHealth(s: any): 'ok' | 'warn' | '' {
  if (isDue(s)) return 'warn';
  const c = checks.value[s.id];
  if (c?.state === 'fail') return 'warn';
  return c?.state === 'ok' ? 'ok' : '';
}
function isDue(a: any) {
  if (!a?.rotateDays || !a?.lastRotatedAt) return false;
  return (Date.now() - new Date(a.lastRotatedAt).getTime()) / 86400000 >= a.rotateDays;
}
function statusColor(st: string) {
  return st === 'live' ? 'var(--ok)' : st === 'dev' ? 'var(--info)' : st === 'idea' ? 'var(--accent)' : 'var(--text-3)';
}
/** 机柜/工位屏幕上的状态字，跟随语言（statusLabel 来自 core/schema） */
const statusText = (st: string) => statusLabel(st);

function nodeVisible(p: any) {
  // 「空机位」只看空位，已上架的机柜压暗
  if (filter.value === 'empty') return false;
  if (q.value && !JSON.stringify(p).toLowerCase().includes(q.value.toLowerCase())) return false;
  const st = nodeStatus(p);
  if (filter.value === 'live') return st === 'live';
  if (filter.value === 'dev') return st === 'dev';
  if (filter.value === 'issue') return isDue(p) || st === 'paused';
  return true;
}

const counts = computed(() => {
  const list = Object.values(seats.value);
  return {
    total: COLS * ROWS,
    used: list.length,
    live: list.filter((p) => nodeStatus(p) === 'live').length,
    dev: list.filter((p) => nodeStatus(p) === 'dev').length,
    issue: list.filter((p) => isDue(p) || nodeStatus(p) === 'paused').length,
  };
});

const alerts = computed(() => {
  void lang.value;
  const out: { t: string; s: string; down?: boolean }[] = [];
  for (const s of servers.value) {
    if (isDue(s)) out.push({ t: tr('studio.alert.rotateDue', { name: s.name }), s: 'SSH KEY · ROTATION DUE', down: true });
  }
  for (const [id, c] of Object.entries(checks.value)) {
    if (c.state === 'fail') {
      const s = servers.value.find((x) => x.id === id);
      if (s) out.push({ t: tr('studio.alert.checkFail', { name: s.name }), s: `TCP · ${c.error || 'FAIL'}` });
    }
  }
  return out.slice(0, 4);
});

/* ================= SVG 场景 ================= */
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
/**
 * 按像素宽度裁剪（中文字宽≈字号，英文≈0.56 字号）。
 * 机柜面板就这么宽，按字数裁会把 "BuildingAI" 砍成 "Buildin…"，按像素才不会浪费空间。
 */
function fit(s: any, maxPx: number, fontPx: number) {
  let w = 0, out = '';
  for (const ch of String(s ?? '')) {
    const cw = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontPx : fontPx * 0.56;
    if (w + cw > maxPx) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

function rackNode(p: any, x: number, y: number, seat: string) {
  const w = 148, h = 156, d = 12;
  const st = nodeStatus(p), col = statusColor(st);
  const units = st === 'idea' ? 0 : st === 'dev' ? Math.max(1, Math.round((p.progress || 40) / 100 * 6)) : st === 'paused' ? 2 : 6;
  let s = `<g class="room-node ${st} ${sel.value?.id === p.id ? 'sel' : ''} ${nodeVisible(p) ? '' : 'filtered-out'}" data-node="${p.id}" tabindex="0" role="button" style="--node-color:${p.color || 'var(--info)'}">`;
  s += `<ellipse class="room-shadow" cx="${x + w / 2}" cy="${y + h + 5}" rx="${w * 0.58}" ry="10"/>`;
  s += `<polygon class="rack-top" points="${x},${y} ${x + d},${y - d} ${x + w + d},${y - d} ${x + w},${y}"/>`;
  s += `<polygon class="rack-side" points="${x + w},${y} ${x + w + d},${y - d} ${x + w + d},${y + h - d} ${x + w},${y + h}"/>`;
  s += `<rect class="rack-front" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`;
  s += `<rect class="node-stripe" x="${x + 8}" y="${y + 8}" width="${w - 16}" height="3" rx="1.5"/>`;
  // 项目名是机柜上唯一要"读"的信息：单独占一行、16px，版本号让到下面屏幕行，免得挤成一条缝
  s += `<text class="node-name" x="${x + 9}" y="${y + 30}" font-size="16">${esc(fit(p.name || tr('assets.unnamed'), w - 20, 16))}</text>`;
  s += `<rect class="rack-screen" x="${x + 9}" y="${y + 37}" width="${w - 18}" height="28" rx="2"/>`;
  s += `<circle class="status-led" cx="${x + 17}" cy="${y + 46}" r="2.6" fill="${col}" style="color:${col}"/>`;
  s += `<text class="screen-text" x="${x + 25}" y="${y + 49}" font-size="10">${statusText(st)}</text>`;
  const tail = runtimeState(p) === 'running' ? 'RUNNING' : runtimeState(p) === 'stopped' ? 'STOPPED' : p.kind || '';
  s += `<text class="screen-text" x="${x + w - 15}" y="${y + 60}" font-size="9" text-anchor="end">${esc(clip([p.version, tail].filter(Boolean).join(' · '), 16))}</text>`;
  for (let i = 0; i < 6; i++) {
    const uy = y + 74 + i * 12.2, on = i < units;
    s += `<rect class="rack-unit ${on ? 'rack-unit-on' : ''}" x="${x + 9}" y="${uy}" width="${w - 18}" height="9" rx="1.5"/>`;
    s += `<circle class="status-led" cx="${x + w - 18}" cy="${uy + 4.5}" r="1.7" fill="${on ? col : 'var(--room-unit)'}" style="color:${col}"/>`;
  }
  const links = [['web', 'W'], ['api', 'A'], ['db', 'D']] as const;
  links.forEach(([k, l], i) => {
    const u = p.urls?.[k];
    s += `<g data-link="${esc(u || '')}" data-node="${p.id}"><rect class="link-box" x="${x + i * 44}" y="${y + h + 12}" width="38" height="22" rx="4" opacity="${u ? 1 : 0.35}"/><text class="link-text" x="${x + i * 44 + 19}" y="${y + h + 27}" font-size="11" text-anchor="middle">${l}</text></g>`;
  });
  // 机位号放左侧：上一排的 W/A/D 入口盒就在下方 12px，放头顶会叠在一起
  s += `<text class="node-sub" x="${x - 8}" y="${y + 14}" font-size="10" text-anchor="end">${seat}</text></g>`;
  return s;
}
function rackEmpty(x: number, y: number, seat: string) {
  const w = 148, h = 156, d = 12;
  const dim = (filter.value !== 'all' && filter.value !== 'empty') || !!q.value;
  return `<g class="room-node empty ${dim ? 'filtered-out' : ''}" data-empty="${seat}" tabindex="0" role="button">
    <polygon class="rack-top" points="${x},${y} ${x + d},${y - d} ${x + w + d},${y - d} ${x + w},${y}"/>
    <polygon class="rack-side" points="${x + w},${y} ${x + w + d},${y - d} ${x + w + d},${y + h - d} ${x + w},${y + h}"/>
    <rect class="rack-front" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>
    <text class="node-name" x="${x + w / 2}" y="${y + h / 2}" font-size="13.5" text-anchor="middle">${esc(tr('studio.seat.empty'))}</text>
    <text class="node-sub" x="${x - 8}" y="${y + 14}" font-size="10" text-anchor="end">${seat}</text></g>`;
}
function powerSpine() {
  const list = servers.value.slice(0, 3);
  let s = `<g><rect class="room-spine" x="38" y="145" width="112" height="560" rx="4"/><text class="room-label" x="94" y="166" font-size="10" text-anchor="middle">POWER / SERVER</text>`;
  list.forEach((srv, i) => {
    const y = 184 + i * 150, hl = serverHealth(srv);
    const col = hl === 'warn' ? 'var(--warn)' : hl === 'ok' ? 'var(--ok)' : 'var(--text-3)';
    s += `<g data-server="${srv.id}" role="button" tabindex="0" style="cursor:pointer"><rect class="room-spine-unit" x="49" y="${y}" width="90" height="94" rx="3"/>
      <text class="room-spine-text" x="58" y="${y + 18}" font-size="10">${esc(fit(srv.name || 'server', 66, 10))}</text>
      <circle class="status-led" cx="129" cy="${y + 14}" r="2.5" fill="${col}" style="color:${col}"/>
      <rect class="rack-screen" x="59" y="${y + 31}" width="70" height="20" rx="2"/>
      <text class="screen-text" x="94" y="${y + 44}" font-size="9.5" text-anchor="middle">${checks.value[srv.id]?.state === 'checking' ? '…' : checks.value[srv.id]?.ms != null ? checks.value[srv.id].ms + 'ms' : 'TAP'}</text></g>`;
  });
  return s + '</g>';
}
/** 内存占用率：/api/system/stats 给的是 usagePct（没有 freeBytes），老字段才用 free 兜底 */
const memPct = computed<number | null>(() => {
  const m = sys.value?.mem;
  if (!m) return null;
  if (typeof m.usagePct === 'number') return Math.round(m.usagePct);
  if (m.totalBytes && typeof m.freeBytes === 'number') return Math.round(100 * (1 - m.freeBytes / m.totalBytes));
  if (m.totalBytes && typeof m.usedBytes === 'number') return Math.round(100 * (m.usedBytes / m.totalBytes));
  return null;
});

function localConsoleBox() {
  const cpu = sys.value?.cpu?.usagePct, mem = memPct.value;
  let s = `<g><rect class="room-spine" x="956" y="154" width="112" height="520" rx="4"/>
    <text class="room-label" x="1012" y="175" font-size="10" text-anchor="middle">LOCAL HOST</text>
    <rect class="rack-screen" x="967" y="187" width="90" height="68" rx="3"/>
    <text class="screen-text" x="976" y="206" font-size="9.5">CPU ${cpu != null ? Math.round(cpu) + '%' : '—'}</text>
    <text class="screen-text" x="976" y="223" font-size="9.5">MEM ${mem != null ? mem + '%' : '—'}</text>
    <text class="screen-text" x="976" y="240" font-size="9">${esc(clip(sys.value?.hostname || tr('studio.localHost'), 14))}</text>`;
  const ports = ['API :8787', 'UI :8790', 'PROXY :8788', 'SSH :8789'];
  for (let i = 0; i < 4; i++) {
    const y = 272 + i * 31;
    s += `<rect class="room-spine-unit" x="967" y="${y}" width="90" height="24" rx="2"/><circle class="status-led" cx="977" cy="${y + 12}" r="2.5" fill="var(--ok)" style="color:var(--ok)"/><text class="room-spine-text" x="987" y="${y + 16}" font-size="9">${ports[i]}</text>`;
  }
  return s + '</g>';
}
function personSvg(x: number, y: number, i: number) {
  const shirt = i % 2 ? 'var(--office-person)' : 'var(--accent)';
  return `<g class="office-person typing" transform="translate(${x} ${y})"><ellipse class="office-shadow" cx="0" cy="38" rx="25" ry="8"/><rect class="chair" x="-22" y="10" width="44" height="38" rx="12"/><circle class="head" cx="0" cy="-6" r="12"/><path class="hair" d="M-11-10a12 12 0 0 1 22 0v-3a12 12 0 0 0-22 0z"/><path class="body" d="M-17 11Q0 1 17 11L14 35H-14Z" style="fill:${shirt}"/><path class="arm left" d="M-13 14-27-2-19-14"/><path class="arm right" d="M13 14 27-2 19-14"/><path class="legs" d="M-8 34-13 46M8 34 13 46"/></g>`;
}
function deskNode(p: any, x: number, y: number, i: number) {
  // 紧凑工位（150 宽 / 约 150 高）：4 列 × 3 排刚好铺满 12 个机位
  const w = 150, h = 40, st = nodeStatus(p), col = statusColor(st), cx = x + w / 2;
  let s = `<g class="office-node ${st} ${sel.value?.id === p.id ? 'sel' : ''} ${nodeVisible(p) ? '' : 'filtered-out'}" data-node="${p.id}" tabindex="0" role="button" style="--node-color:${p.color || 'var(--info)'}">`;
  s += `<ellipse class="office-rug" cx="${cx}" cy="${y + 48}" rx="100" ry="42"/><ellipse class="office-shadow" cx="${cx + 8}" cy="${y + 74}" rx="88" ry="14"/>`;
  s += `<text class="node-name" x="${cx}" y="${y - 64}" font-size="15" text-anchor="middle">${esc(fit(p.name || tr('assets.unnamed'), w - 8, 15))}</text><text class="node-sub" x="${cx}" y="${y - 50}" font-size="9.5" text-anchor="middle">${esc(fit([p.version, p.kind].filter(Boolean).join(' · '), w + 30, 9.5))}</text>`;
  s += `<rect class="monitor-stand" x="${cx - 4}" y="${y - 9}" width="8" height="13" rx="2"/><rect class="monitor" x="${cx - 37}" y="${y - 46}" width="74" height="40" rx="4"/><circle class="status-led" cx="${cx + 28}" cy="${y - 39}" r="2.2" fill="${col}" style="color:${col}"/>`;
  for (let j = 0; j < 3; j++) { const len = [30, 44, 22][j]; s += `<line class="screen-line" x1="${cx - 28}" y1="${y - 33 + j * 8.5}" x2="${cx - 28 + len}" y2="${y - 33 + j * 8.5}"/>`; }
  s += `<text class="screen-text" x="${cx}" y="${y - 12}" font-size="8" text-anchor="middle">${statusText(st)}</text>`;
  s += `<polygon class="desk-top" points="${x},${y} ${x + w},${y} ${x + w + 14},${y + 13} ${x + 14},${y + 13}"/><rect class="desk-front" x="${x + 14}" y="${y + 13}" width="${w}" height="${h - 13}" rx="2"/><rect class="desk-stripe" x="${x + 24}" y="${y + 21}" width="52" height="3" rx="1.5"/><rect class="keyboard" x="${cx - 24}" y="${y + 2}" width="48" height="8" rx="2"/>`;
  s += st === 'idea'
    ? `<g class="office-person" transform="translate(${cx + 10} ${y + 50})"><circle class="head" cx="0" cy="4" r="16" fill="none" stroke="var(--accent)" stroke-dasharray="3 4"/><text class="screen-text" x="0" y="8" font-size="12" text-anchor="middle">?</text></g>`
    : personSvg(cx + 10, y + 50, i);
  return s + '</g>';
}

const sceneSvg = computed(() => {
  // v-html 拼出来的 SVG 不会自动跟着 tr() 重绘，这里显式依赖语言
  void lang.value;
  const list = seats.value;
  if (uiScene.value === 'office') {
    const xs = [95, 345, 595, 845], ys = [215, 385, 555];
    let s = `<svg class="office-svg" viewBox="0 0 1100 700" style="transform:scale(${zoom.value})"><rect class="office-wall" width="1100" height="250"/><rect class="office-floor" y="250" width="1100" height="450"/><line class="office-grid" x1="0" y1="250" x2="1100" y2="250"/>`;
    for (let i = 0; i < 10; i++) s += `<line class="office-grid" x1="0" y1="${280 + i * 43}" x2="1100" y2="${280 + i * 43}"/>`;
    for (let i = -4; i < 15; i++) { const x = i * 110; s += `<line class="office-grid" x1="${550 + (x - 550) * 0.55}" y1="250" x2="${x}" y2="700"/>`; }
    s += `<rect class="office-whiteboard" x="380" y="28" width="340" height="116" rx="3"/><text class="office-board-text" x="400" y="51" font-size="9">PROJECT OPERATIONS</text><text class="screen-text" x="400" y="91" font-size="25">${counts.value.live}/${counts.value.used}</text><text class="office-board-text" x="400" y="116" font-size="8">LIVE / TOTAL</text><polyline points="555,108 580,96 605,100 630,77 655,83 690,59" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    Object.entries(list).forEach(([, p], i) => { s += deskNode(p, xs[i % 4], ys[Math.floor(i / 4)], i); });
    s += `<g class="office-walker"><animateMotion path="M150 675H980H150" dur="18s" repeatCount="indefinite"/><circle class="scan-ring" cx="0" cy="0" r="23"/><circle class="head" cx="0" cy="-18" r="8"/><path class="body" d="M-9-8H9L7 14H-7Z"/><path class="limb" d="M-7-3-17 8M7-3 17 8M-4 14-9 29M4 14 9 29"/></g></svg>`;
    return s;
  }
  // 间距 210 = 机柜 156 + 入口盒 34 + 上下留白；再紧一排就会和下一排的机柜顶面叠住
  const xs = [190, 370, 550, 730], ys = [145, 355, 565];
  let s = `<svg class="room-svg" viewBox="0 0 1100 760" style="transform:scale(${zoom.value})"><rect class="room-wall" width="1100" height="300"/><rect class="room-floor" y="300" width="1100" height="460"/><rect class="room-wall-2" width="1100" height="112"/><line class="room-grid" x1="0" y1="300" x2="1100" y2="300"/>`;
  for (let i = 0; i < 10; i++) s += `<line class="room-grid" x1="0" y1="${320 + i * 42}" x2="1100" y2="${320 + i * 42}"/>`;
  for (let i = -4; i < 15; i++) { const x = i * 110; s += `<line class="room-grid" x1="${550 + (x - 550) * 0.55}" y1="300" x2="${x}" y2="760"/>`; }
  s += `<rect class="room-board" x="350" y="24" width="400" height="70" rx="4"/><text class="room-board-text" x="370" y="45" font-size="9">FLINTKEEP / NOC</text><text class="screen-text" x="370" y="73" font-size="17">${counts.value.live}/${counts.value.used}</text><text class="room-board-text" x="455" y="72" font-size="8">LIVE / TOTAL</text><polyline points="585,73 610,66 635,68 660,55 685,59 710,43 730,47" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  s += `<path class="room-cable" d="M130 116H930"/>`;
  Object.entries(list).forEach(([seat, p]) => {
    const r = 'ABC'.indexOf(seat[0]), c = parseInt(seat.slice(2)) - 1;
    s += `<path class="room-cable ${nodeStatus(p) === 'live' ? 'live' : ''}" d="M${xs[c] + 74} 116V${ys[r] - 16}"/>`;
  });
  s += powerSpine() + localConsoleBox();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const seat = `${'ABC'[r]}-${String(c + 1).padStart(2, '0')}`;
    const p = list[seat];
    s += p ? rackNode(p, xs[c], ys[r], seat) : rackEmpty(xs[c], ys[r], seat);
  }
  return s + '</svg>';
});

/* ================= 数据与操作 ================= */
async function load() {
  const get = (u: string) => fetch(u, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  try {
    const [a, m, st, au] = await Promise.all([
      get('/api/assets'),
      get('/api/myprojects'),
      get('/api/system/stats'),
      get('/api/audit?size=6'),
    ]);
    // 锁态下 /api/assets 返回 423 对象而不是数组：不能当资产列表用，否则 .filter 直接炸
    if (a?.needUnlock || a?.locked) {
      locked.value = true;
      offline.value = false;
      assets.value = [];
    } else if (a) {
      locked.value = false;
      offline.value = false;
      assets.value = Array.isArray(a) ? a : Array.isArray(a.assets) ? a.assets : [];
    } else {
      offline.value = true;
    }
    if (m) { myProjects.value = m.projects || []; statuses.value = m.statuses || {}; }
    if (st) sys.value = st;
    if (au) auditEvents.value = (Array.isArray(au) ? au : au.items || []).slice(0, 6);
  } catch { offline.value = true; }
}
async function checkOne(s: any) {
  checks.value = { ...checks.value, [s.id]: { state: 'checking' } };
  try {
    const j = await fetch('/api/studio/check?id=' + encodeURIComponent(s.id)).then((r) => r.json());
    checks.value = { ...checks.value, [s.id]: j.ok ? { state: 'ok', ms: j.ms } : { state: 'fail', ms: j.ms, error: j.error } };
  } catch (e: any) {
    checks.value = { ...checks.value, [s.id]: { state: 'fail', error: e.message } };
  }
}
/** 一台服务器的连通性文案（抽屉 / 巡检共用） */
function checkText(s: any) {
  void lang.value;
  const c = checks.value[s.id];
  if (!c) return tr('studio.check.none');
  if (c.state === 'checking') return tr('studio.check.running');
  if (c.state === 'ok') return tr('studio.check.ok', { ms: c.ms ?? '—' });
  return tr('studio.check.fail', { err: c.error || tr('studio.check.noResponse') });
}
/** 运行动态里的一条审计事件：动作 key 走字典，名字按语言加引号 */
function activityText(ev: any): string {
  void lang.value;
  const key = ev?.action ? auditActionLabel(ev.action) : '';
  if (!key) return ev?.action || ev?.what || ev?.description || ev?.type || '';
  const name = ev?.name ? (lang.value === 'en-US' ? `"${ev.name}"` : `「${ev.name}」`) : '';
  return tr(key as any, { type: ev?.type ? typeLabel(ev.type) : '', name });
}
async function checkAll() {
  for (const s of servers.value) await checkOne(s);
  toast(tr('studio.toast.checked'));
}
async function sshTo(srv: any) {
  try {
    const r = await fetch('/api/ssh/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: srv.id, ttl: 3600 }) }).then((x) => x.json());
    if (r?.token) {
      const cmd = `ssh -o StrictHostKeyChecking=no -p ${r.proxyPort} ${r.token}@${r.proxyHost}`;
      try { await navigator.clipboard.writeText(cmd); } catch { /* 剪贴板不可用时忽略 */ }
      toast(tr('studio.toast.sshIssued', { hint: r.targetHint }));
    } else toast(r?.error || tr('studio.toast.sshFail'));
  } catch (e: any) { toast(tr('studio.toast.sshFailMsg', { msg: e.message || String(e) })); }
}
async function runtimeAct(p: any, act: 'start' | 'stop') {
  const m = runtimeOf(p);
  if (!m) return;
  try {
    await fetch(`/api/myprojects/${encodeURIComponent(m.id)}/${act}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(tr(act === 'start' ? 'studio.toast.startSent' : 'studio.toast.stopSent'));
  } catch (e: any) { toast(tr('studio.toast.actFail', { msg: e.message || String(e) })); }
}
function toast(msg: string) {
  toastMsg.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastMsg.value = ''), 2000);
}
function onCanvasClick(e: MouseEvent) {
  const link = (e.target as HTMLElement).closest('[data-link]') as HTMLElement | null;
  if (link) {
    const u = link.dataset.link;
    if (u) openUrl(u);
    return;
  }
  const srv = (e.target as HTMLElement).closest('[data-server]') as HTMLElement | null;
  if (srv) {
    const s = servers.value.find((x) => x.id === srv.dataset.server);
    if (s) { sel.value = s; return; }
  }
  const node = (e.target as HTMLElement).closest('[data-node]') as HTMLElement | null;
  if (node) {
    const p = projects.value.find((x) => x.id === node.dataset.node);
    if (p) sel.value = p;
    return;
  }
  if ((e.target as HTMLElement).closest('[data-empty]')) emit('new-asset', 'project');
}
function linkedServer(p: any) {
  const id = (p.links || []).find((l: any) => l.role === 'server' || l.role === 'ssh')?.id;
  return id ? servers.value.find((s) => s.id === id) || null : null;
}
/**
 * 抽屉里的「关联资产」：服务器、账号、模型、密钥都在 links 里。
 * 两个方向都算：项目主动挂的（out）+ 账号反过来挂在项目上的（back，标 ↩）。
 */
function linkedAssets(p: any) {
  const seen = new Set<string>(p?.id ? [p.id] : []);
  const out: { id: string; label: string; name: string; back?: boolean }[] = [];
  const push = (id: string, label: string, name: string, back?: boolean) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, name, back });
  };
  for (const l of p?.links || []) {
    const a = assets.value.find((x) => x.id === l.id);
    push(l.id, roleLabel(l.role || 'related'), a?.name || l.id);
  }
  for (const a of assets.value) {
    if (!(a.links || []).some((l: any) => l.id === p?.id)) continue;
    push(a.id, a.type ? typeLabel(a.type) : '—', a.name, true);
  }
  return out;
}

/** 已完成里程碑数（抽屉标题用） */
const msDone = (p: any) => (p?.milestones || []).filter((m: any) => m.done).length;

function openUrl(u: string) {
  if (!u) return;
  window.open(/^https?:\/\//i.test(u) ? u : 'https://' + u, '_blank');
}
onMounted(() => {
  load();
  es = new EventSource('/api/myprojects/events');
  es.onmessage = (ev) => {
    try { const d = JSON.parse(ev.data); if (d.type === 'status') statuses.value = d.statuses || {}; } catch { /* 忽略心跳 */ }
  };
});
onUnmounted(() => es?.close());
defineExpose({ reload: load });
</script>

<template>
  <div class="mg-view room-page" :class="{ open: !!sel }">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ locked ? tr('shell.status.locked') : offline ? tr('shell.status.offline') : tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('studio.summary', { n: counts.used, r: ROWS, c: COLS }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('studio.kicker') }}</div>
          <div class="page-title">{{ tr('studio.title') }} <span class="cnt">[ {{ counts.used }} / {{ counts.total }} ]</span></div>
        </div>
        <label class="search"><input v-model="q" :placeholder="tr('studio.search')" /></label>
        <button class="btn" :class="{ primary: uiScene === 'rack' }" @click="uiScene = 'rack'">{{ tr('studio.scene.rack') }}</button>
        <button class="btn" :class="{ primary: uiScene === 'office' }" @click="uiScene = 'office'">{{ tr('studio.scene.office') }}</button>
        <button class="btn" @click="checkAll">{{ tr('studio.btn.checkAll') }}</button>
        <button class="btn primary" @click="emit('new-asset', 'project')">{{ tr('studio.btn.newProject') }}</button>
      </div>

      <div class="room-workspace">
        <section class="room-stage">
          <div class="room-toolbar">
            <div class="chips">
              <button class="chip" :class="{ on: filter === 'all' }" @click="filter = 'all'">{{ tr('studio.chip.all') }} <span class="c">{{ counts.total }}</span></button>
              <button class="chip" :class="{ on: filter === 'live' }" @click="filter = 'live'"><i style="background: var(--ok)"></i>{{ tr('studio.chip.live') }} <span class="c">{{ counts.live }}</span></button>
              <button class="chip" :class="{ on: filter === 'dev' }" @click="filter = 'dev'"><i style="background: var(--info)"></i>{{ tr('studio.chip.dev') }} <span class="c">{{ counts.dev }}</span></button>
              <button class="chip" :class="{ on: filter === 'issue' }" @click="filter = 'issue'"><i style="background: var(--warn)"></i>{{ tr('studio.chip.issue') }} <span class="c">{{ counts.issue }}</span></button>
              <button class="chip" :class="{ on: filter === 'empty' }" @click="filter = 'empty'"><i style="background: var(--text-3)"></i>{{ tr('studio.chip.empty') }} <span class="c">{{ counts.total - counts.used }}</span></button>
            </div>
            <span class="sp"></span>
            <div class="room-kpis">
              <span class="room-kpi"><span class="v num">{{ counts.used }}</span><span class="k">{{ tr('studio.kpi.nodes') }}</span></span>
              <span class="room-kpi"><span class="v num">{{ counts.live }}</span><span class="k">{{ tr('studio.chip.live') }}</span></span>
              <span class="room-kpi warn"><span class="v num">{{ counts.issue }}</span><span class="k">{{ tr('studio.chip.issue') }}</span></span>
            </div>
          </div>
          <div class="room-canvas" v-html="sceneSvg" @click="onCanvasClick"></div>
          <div class="room-foot">
            <div class="room-legend">
              <span><i style="background: var(--ok)"></i>{{ tr('studio.legend.ok') }}</span>
              <span><i style="background: var(--info)"></i>{{ tr('studio.chip.dev') }}</span>
              <span><i style="background: var(--warn)"></i>{{ tr('studio.chip.issue') }}</span>
            </div>
            <span class="sp"></span>
            <span>{{ tr('studio.foot.hint') }}</span>
          </div>
          <div class="room-zoom">
            <button @click="zoom = Math.max(0.85, +(zoom - 0.1).toFixed(2))">−</button>
            <button @click="zoom = 1">⌂</button>
            <button @click="zoom = Math.min(1.2, +(zoom + 0.1).toFixed(2))">＋</button>
          </div>
        </section>

        <aside class="room-rail">
          <section class="room-card">
            <div class="h"><span>{{ tr('studio.card.alerts') }}</span><span class="num">{{ String(alerts.length).padStart(2, '0') }}</span></div>
            <div v-for="(a, i) in alerts" :key="i" class="room-alert" :class="{ down: a.down }">
              <i></i>
              <div><div class="t">{{ a.t }}</div><div class="s">{{ a.s }}</div></div>
            </div>
            <div v-if="!alerts.length" class="room-event"><span>{{ tr('studio.alerts.none') }}</span></div>
          </section>
          <section class="room-card">
            <div class="h"><span>{{ tr('studio.card.console') }}</span><span class="st-live"><i></i>ONLINE</span></div>
            <template v-if="sys">
              <div class="room-meter"><div class="row"><span>CPU</span><b>{{ sys.cpu?.usagePct != null ? Math.round(sys.cpu.usagePct) + '%' : '—' }}</b></div><div class="bar"><i :style="{ width: (sys.cpu?.usagePct || 0) + '%' }"></i></div></div>
              <div class="room-meter" v-if="memPct != null"><div class="row"><span>{{ tr('studio.meter.mem') }}</span><b>{{ memPct }}%</b></div><div class="bar"><i :style="{ width: memPct + '%' }"></i></div></div>
              <div class="room-meter" v-if="sys.disk"><div class="row"><span>{{ tr('studio.meter.disk') }}</span><b>{{ sys.disk.usagePct != null ? Math.round(sys.disk.usagePct) + '%' : '—' }}</b></div><div class="bar"><i :style="{ width: (sys.disk.usagePct || 0) + '%' }"></i></div></div>
            </template>
            <div v-else class="room-event"><span>{{ tr('studio.console.loading') }}</span></div>
          </section>
          <section class="room-card">
            <div class="h"><span>{{ tr('studio.card.activity') }}</span><span>LIVE</span></div>
            <div v-for="(ev, i) in auditEvents" :key="i" class="room-event">
              <span class="t">{{ String(ev.ts || ev.time || '').slice(5, 16) }}</span>
              <span>{{ activityText(ev) }}</span>
            </div>
            <div v-if="!auditEvents.length" class="room-event"><span>{{ tr('studio.activity.none') }}</span></div>
          </section>
        </aside>
      </div>
    </div>

    <div class="scrim" @click="sel = null"></div>
    <aside v-if="sel" class="drawer">
      <div class="d-head">
        <div class="d-id">{{ sel.type === 'server' ? 'SERVER' : (sel.kind || 'PROJECT') }} — {{ sel.no != null ? 'NO.' + String(sel.no).padStart(2, '0') : '' }}</div>
        <div class="d-title">{{ sel.name }}</div>
        <button class="d-x" :aria-label="tr('assets.btn.close')" @click="sel = null">×</button>
      </div>
      <div class="d-body">
        <div class="d-sec">
          <div class="h">{{ tr('studio.drawer.archives') }}</div>
          <div class="field"><span class="k">{{ tr('meta.field.type') }}</span><span class="v">{{ sel.type === 'server' ? typeLabel('server') : sel.kind || typeLabel('project') }}</span></div>
          <div class="field" v-if="sel.type !== 'server'"><span class="k">{{ tr('meta.field.status') }}</span><span class="v">{{ statusText(nodeStatus(sel)) }}</span></div>
          <div class="field" v-if="sel.version"><span class="k">{{ tr('meta.field.version') }}</span><span class="v">{{ sel.version }}</span></div>
          <div class="field" v-if="sel.publicIp || sel.ip"><span class="k">{{ tr('studio.field.addr') }}</span><span class="v">{{ sel.publicIp || sel.ip }}</span></div>
          <div class="field" v-if="sel.sshPort"><span class="k">{{ tr('meta.field.sshPort') }}</span><span class="v">{{ sel.sshPort }}</span></div>
          <div class="field" v-if="runtimeOf(sel)"><span class="k">{{ tr('studio.field.local') }}</span><span class="v">{{ runtimeOf(sel).id }} · {{ tr(runtimeState(sel) === 'running' ? 'studio.state.running' : 'studio.state.stopped') }}</span></div>

          <div class="field" v-if="sel.lastRotatedAt">
            <span class="k">{{ tr('meta.field.lastRotatedAt') }}</span>
            <span class="v">{{ String(sel.lastRotatedAt).slice(0, 10) }}{{ isDue(sel) ? ' · ' + tr('studio.field.due') : '' }}</span>
          </div>
          <div class="field" v-if="sel.type === 'server'"><span class="k">{{ tr('studio.field.check') }}</span><span class="v">{{ checkText(sel) }}</span></div>
          <div class="field" v-if="sel.note || sel.notes || sel.desc"><span class="k">{{ tr('meta.field.note') }}</span><span class="v">{{ sel.note || sel.notes || sel.desc }}</span></div>
        </div>
        <div class="d-sec" v-if="sel.urls?.web || sel.urls?.api || sel.urls?.db">
          <div class="h">{{ tr('studio.urls') }}</div>
          <div class="field" v-if="sel.urls?.web"><span class="k">{{ tr('studio.url.web') }}</span><span class="v">{{ sel.urls.web }}</span></div>
          <div class="field" v-if="sel.urls?.api"><span class="k">{{ tr('studio.url.api') }}</span><span class="v">{{ sel.urls.api }}</span></div>
          <div class="field" v-if="sel.urls?.db"><span class="k">{{ tr('studio.url.db') }}</span><span class="v">{{ sel.urls.db }}</span></div>
        </div>
        <div class="d-sec" v-if="sel.milestones?.length">
          <div class="h"><span>{{ tr('studio.milestones') }}</span><span class="num">{{ msDone(sel) }} / {{ sel.milestones.length }}</span></div>
          <div v-for="m in sel.milestones" :key="m.id" class="ms-item" :class="{ done: m.done }">
            <i>{{ m.done ? '✓' : '○' }}</i>
            <span class="n">{{ m.name }}</span>
            <span class="d">{{ m.date || '' }}</span>
          </div>
        </div>
        <div class="d-sec" v-if="linkedAssets(sel).length">
          <div class="h">{{ tr('studio.linked') }}</div>
          <div class="field" v-for="l in linkedAssets(sel)" :key="l.id">
            <span class="k">{{ l.label }}<span v-if="l.back" class="back" :title="tr('studio.linked.back')">↩</span></span>
            <span class="v linkish" @click="sel = assets.find((a) => a.id === l.id) || sel">{{ l.name }}</span>
          </div>
          <p class="d-tip">{{ tr('studio.linked.tip') }}</p>
        </div>
      </div>
      <div class="d-foot">
        <template v-if="sel.type !== 'server'">
          <button v-if="sel.urls?.web" class="act" @click="openUrl(sel.urls.web)">{{ tr('studio.btn.openWeb') }}</button>
          <button v-if="sel.urls?.api" class="act" @click="openUrl(sel.urls.api)">{{ tr('studio.btn.openApi') }}</button>
          <button v-if="sel.urls?.db" class="act" @click="openUrl(sel.urls.db)">{{ tr('studio.btn.openDb') }}</button>
          <button v-if="linkedServer(sel)" class="act" @click="sshTo(linkedServer(sel))">{{ tr('studio.btn.sshProxy') }}</button>
          <button v-if="runtimeOf(sel)" class="act" @click="runtimeAct(sel, runtimeState(sel) === 'running' ? 'stop' : 'start')">{{ tr(runtimeState(sel) === 'running' ? 'studio.btn.stop' : 'studio.btn.start') }}</button>
          <button class="act" @click="emit('edit-asset', sel); sel = null">{{ tr('assets.btn.edit') }}</button>
        </template>
        <template v-else>
          <button class="act" @click="checkOne(sel)">{{ tr('studio.btn.check') }}</button>
          <button class="act" @click="sshTo(sel)">{{ tr('studio.btn.issueSsh') }}</button>
          <button class="act" @click="emit('edit-asset', sel); sel = null">{{ tr('assets.btn.edit') }}</button>
        </template>
      </div>
    </aside>
    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  </div>
</template>

<style scoped>
[data-mgui] .mg-view { height: 100%; display: flex; flex-direction: column; position: relative; overflow: hidden; background: var(--bg); color: var(--text); }
[data-mgui] .mg-view.open .drawer { transform: none; opacity: 1; pointer-events: auto; }
[data-mgui] .mg-view.open .scrim { opacity: 1; pointer-events: auto; }
[data-mgui] .linkish { cursor: pointer; color: var(--accent); }
[data-mgui] .linkish:hover { text-decoration: underline; }
[data-mgui] .d-tip { margin: 8px 0 0; font-size: var(--f-xxs); color: var(--text-3); line-height: 1.5; }
[data-mgui] .drawer .field .k .back { margin-left: 3px; color: var(--text-3); }
[data-mgui] .ms-item { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; padding: 6px 0; border-top: 1px dashed var(--line); font-size: var(--f-xs); color: var(--text-2); }
[data-mgui] .ms-item:first-of-type { border-top: 0; }
[data-mgui] .ms-item i { color: var(--text-3); font-style: normal; }
[data-mgui] .ms-item .d { font-family: var(--font-mono); color: var(--text-3); }
[data-mgui] .ms-item.done .n { color: var(--text-3); text-decoration: line-through; }
[data-mgui] .ms-item.done i { color: var(--ok); }
[data-mgui] .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 80; padding: 9px 14px; border-radius: var(--r-md); background: var(--text); color: var(--bg); font-size: var(--f-sm); box-shadow: var(--sh-pop, 0 8px 24px rgba(0, 0, 0, .2)); }
</style>
