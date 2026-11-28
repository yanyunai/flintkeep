<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import FieldSchemaPanel from './FieldSchemaPanel.vue';
import { uiMode, uiTheme, uiTemplate } from './ui/appearance';
import { sideIcon } from './ui/icons';
import { openExternal } from './open-external';
import { lang, useT } from './ui/i18n';
import { typeLabel as schemaTypeLabel, fieldNameLabel } from '../core/schema';

const tr = useT();

/** 字段选项下拉的「类型 · 字段」展示名，跟着语言走 */
const CATALOG_FIELD_LABELS: Record<string, string> = {
  'login_account.provider': 'meta.catalog.loginProvider',
};
function catalogFieldLabel(f: { key: string; fieldLabel?: string }) {
  const [assetType, fieldKey] = String(f.key || '').split('.');
  const key = CATALOG_FIELD_LABELS[f.key];
  const label = key ? tr(key as any) : f.fieldLabel ? fieldNameLabel(fieldKey, { [fieldKey]: f.fieldLabel }) : fieldKey;
  return schemaTypeLabel(assetType) + ' · ' + (label || '—');
}

const emit = defineEmits<{ saved: []; imported: []; locked: [] }>();

/**
 * 设置页形态：左侧分区导航 + 右侧单分区内容。
 * 以前是 7 张卡片平铺，找一项要滚半天；现在一屏只看一件事。
 */
const setSection = ref<'appearance' | 'security' | 'data' | 'ai' | 'fields' | 'types' | 'about'>('appearance');
const SET_SECTIONS = computed(
  () =>
    [
      // 图标：icons.ts 现有 SVG 按最近义选用（外观→sun、安全→盾、数据→保险箱、AI→四角星、
      // 字段→列表行、类型→仪表盘），不再用 unicode 字符（docs/设置页 F10）
      { k: 'appearance', label: tr('set.nav.appearance'), desc: tr('set.nav.appearance.desc'), icon: 'sun' },
      { k: 'security', label: tr('set.nav.security'), desc: tr('set.nav.security.desc'), icon: 'whitelist' },
      { k: 'data', label: tr('set.nav.data'), desc: tr('set.nav.data.desc'), icon: 'assets' },
      { k: 'ai', label: tr('set.nav.ai'), desc: tr('set.nav.ai.desc'), icon: 'assistant' },
      { k: 'fields', label: tr('set.nav.fields'), desc: tr('set.nav.fields.desc'), icon: 'audit' },
      { k: 'types', label: tr('set.nav.types'), desc: tr('set.nav.types.desc'), icon: 'aiusage' },
      { k: 'about', label: tr('set.nav.about'), desc: tr('set.nav.about.desc'), icon: 'github' },
    ] as const
);

// ===== 双因子（Secret Key）=====
// 状态来自 /api/sk（只读 keystore）；启用后 SK 明文只在这一次响应里出现，
// 页面刷新后就只能从本机 secret_key.txt 重新下载应急包。
const sk = ref<any>(null);
const skPass = ref('');
const skSecret = ref('');
const skMsg = ref('');
const skErr = ref('');
const skBusy = ref(false);
const skNew = ref<{
  secretKey: string;
  hint: string;
  fingerprint: string;
  emergencyKit: string;
  emergencyKitFilename: string;
} | null>(null);

async function loadSk() {
  try {
    sk.value = await (await fetch('/api/sk')).json();
  } catch {
    /* 后端未就绪：保持 null，界面只显示「未知」 */
  }
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'flintkeep-emergency-kit.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function enableSk() {
  skMsg.value = '';
  skErr.value = '';
  if (!skPass.value) {
    skErr.value = tr('set.sk.needPass');
    return;
  }
  skBusy.value = true;
  try {
    const res = await fetch('/api/sk/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: skPass.value }),
    });
    const j = await res.json();
    if (!res.ok) {
      skErr.value = j.error || tr('set.err.request');
      return;
    }
    skNew.value = j;
    skPass.value = '';
    // 自动下载一次：用户最容易漏的就是这一步，漏了等于把自己锁在门外
    downloadText(j.emergencyKit, j.emergencyKitFilename);
    await loadSk();
  } catch (e: any) {
    skErr.value = e.message || tr('set.err.request');
  } finally {
    skBusy.value = false;
  }
}

async function downloadKit() {
  skMsg.value = '';
  skErr.value = '';
  try {
    const res = await fetch('/api/sk/emergency-kit');
    const j = await res.json();
    if (!res.ok) {
      skErr.value = j.error || tr('set.sk.kitFail');
      return;
    }
    downloadText(j.text, j.filename);
  } catch (e: any) {
    skErr.value = e.message || tr('set.sk.kitFail');
  }
}

async function disableSk() {
  skMsg.value = '';
  skErr.value = '';
  if (!skPass.value) {
    skErr.value = tr('set.sk.needPass');
    return;
  }
  skBusy.value = true;
  try {
    const res = await fetch('/api/sk/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: skPass.value, secretKey: skSecret.value || undefined }),
    });
    const j = await res.json();
    if (!res.ok) {
      skErr.value = j.needSecretKey
        ? tr('set.sk.errNeedSk', { hint: j.secretKeyHint || '????' })
        : j.error || tr('set.err.request');
      return;
    }
    skMsg.value = tr('set.sk.msgDisabled');
    skPass.value = '';
    skSecret.value = '';
    skNew.value = null;
    await loadSk();
  } catch (e: any) {
    skErr.value = e.message || tr('set.err.request');
  } finally {
    skBusy.value = false;
  }
}

function copySk() {
  if (!skNew.value) return;
  navigator.clipboard
    ?.writeText(skNew.value.secretKey)
    .then(() => {
      skMsg.value = tr('set.sk.copied');
    })
    .catch(() => {
      /* 剪贴板不可用：用户可直接从输入框选中复制 */
    });
}

/** 确认已保存：收起明文，避免长期挂在屏幕上 */
function dismissNewSk() {
  skNew.value = null;
  skMsg.value = tr('set.sk.msgEnabled');
}

// ===== 访问令牌（服务账号）=====
// 管理面必须带桌面会话（后端 /api/access-tokens 在解锁门之后校验），
// 明文令牌只在「创建」的响应里出现一次，之后列表只有前缀。
const tokens = ref<any[]>([]);
const tokAssets = ref<any[]>([]);
const tokName = ref('');
const tokQuery = ref('');
const tokSelected = ref<string[]>([]);
const tokCapProxy = ref(true);
const tokCapSsh = ref(true);
const tokDays = ref(30);
const tokNew = ref<{ token: string; prefix: string; name: string } | null>(null);
const tokMsg = ref('');
const tokErr = ref('');
const tokBusy = ref(false);

const tokFiltered = computed(() => {
  const q = tokQuery.value.trim().toLowerCase();
  const rest = tokAssets.value.filter((a) => !tokSelected.value.includes(a.id));
  const hit = q
    ? rest.filter((a) =>
        [a.name, a.publicIp, a.sshHost, a.note, a.type].some((v) =>
          String(v || '')
            .toLowerCase()
            .includes(q)
        )
      )
    : rest;
  return hit.slice(0, 20);
});
function tokNameOf(id: string) {
  return tokAssets.value.find((a) => a.id === id)?.name || id;
}
async function loadTokens() {
  try {
    const r = await fetch('/api/access-tokens');
    const j = await r.json();
    if (r.ok) tokens.value = j.items || [];
  } catch {
    /* 锁定态忽略 */
  }
}
async function loadTokenAssets() {
  try {
    const r = await fetch('/api/assets');
    const j = await r.json();
    if (Array.isArray(j)) tokAssets.value = j;
  } catch {
    /* ignore */
  }
}
async function createToken() {
  tokMsg.value = '';
  tokErr.value = '';
  if (!tokName.value.trim()) {
    tokErr.value = tr('set.tok.needName');
    return;
  }
  if (!tokSelected.value.length) {
    tokErr.value = tr('set.tok.needScope');
    return;
  }
  const caps: string[] = [];
  if (tokCapProxy.value) caps.push('proxy');
  if (tokCapSsh.value) caps.push('ssh');
  if (!caps.length) {
    tokErr.value = tr('set.tok.needCap');
    return;
  }
  tokBusy.value = true;
  try {
    const res = await fetch('/api/access-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tokName.value.trim(),
        assets: tokSelected.value,
        caps,
        days: Number(tokDays.value) || 30,
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      tokErr.value = j.error || tr('set.err.request');
      return;
    }
    tokNew.value = { token: j.token, prefix: j.prefix, name: j.name };
    tokName.value = '';
    tokSelected.value = [];
    await loadTokens();
  } catch (e: any) {
    tokErr.value = e.message || tr('set.err.request');
  } finally {
    tokBusy.value = false;
  }
}
async function revokeToken(id: string) {
  tokMsg.value = '';
  tokErr.value = '';
  if (!confirm(tr('set.tok.revoke') + ' ' + id.slice(0, 8) + '?')) return;
  try {
    const res = await fetch('/api/access-tokens/' + encodeURIComponent(id), { method: 'DELETE' });
    const j = await res.json();
    if (!res.ok) {
      tokErr.value = j.error || tr('set.err.request');
      return;
    }
    tokMsg.value = tr('set.tok.revokedOk');
    await loadTokens();
  } catch (e: any) {
    tokErr.value = e.message || tr('set.err.request');
  }
}
function copyToken() {
  if (!tokNew.value) return;
  navigator.clipboard
    ?.writeText(tokNew.value.token)
    .then(() => {
      tokMsg.value = tr('set.tok.copied');
    })
    .catch(() => {
      /* 剪贴板不可用：用户可直接选中复制 */
    });
}
function dismissNewToken() {
  tokNew.value = null;
}

// ===== 本地 SSH agent =====
// 开关本身随「安全开关」一起保存；这里只管展示状态与导出命令。
type AgentInfo = {
  enabled: boolean;
  running: boolean;
  socket: string;
  exportCommand: string;
  keys: { assetId: string; name: string; algo: string; fingerprint: string }[];
};
const sshAgentOn = ref(false);
const agentInfo = ref<AgentInfo | null>(null);
const agentErr = ref('');
const agentMsg = ref('');
async function loadAgent() {
  try {
    const r = await fetch('/api/ssh-agent');
    const j = await r.json();
    if (r.ok) agentInfo.value = j as AgentInfo;
    else agentInfo.value = null;
  } catch {
    agentInfo.value = null;
  }
}
function copyAgentEnv() {
  const cmd = agentInfo.value?.exportCommand;
  if (!cmd) return;
  agentMsg.value = '';
  agentErr.value = '';
  navigator.clipboard
    ?.writeText(cmd)
    .then(() => {
      agentMsg.value = tr('set.agent.copied');
    })
    .catch(() => {
      /* 剪贴板不可用：用户可直接选中复制 */
    });
}

// ===== AI 模型（资产管家）=====
const aiConf = ref<any>({ base: '', model: '', name: '自定义', hasKey: false });
const aiKeyInput = ref('');
const aiConfMsg = ref('');
const aiConfErr = ref('');
const AI_PRESETS = computed(() => [
  { name: 'DeepSeek', base: 'https://api.deepseek.com' },
  { name: tr('set.ai.preset.bailian'), base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: tr('set.ai.preset.volc'), base: 'https://ark.cn-beijing.volces.com/api/v3' },
  { name: tr('set.ai.preset.ollama'), base: 'http://127.0.0.1:11434/v1' },
]);
async function loadAiConf() {
  try {
    aiConf.value = await (await fetch('/api/assistant/config')).json();
  } catch {
    /* 锁定态忽略 */
  }
}
async function saveAiConf() {
  aiConfMsg.value = '';
  aiConfErr.value = '';
  try {
    const r = await (
      await fetch('/api/assistant/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: aiConf.value.base,
          model: aiConf.value.model,
          key: aiKeyInput.value || undefined,
          name: aiConf.value.name,
        }),
      })
    ).json();
    aiConf.value = r;
    aiKeyInput.value = '';
    aiConfMsg.value = r.keyCleared ? tr('set.msg.savedKeyCleared') : tr('set.msg.aiSaved');
  } catch (e: any) {
    aiConfErr.value = e?.message || String(e);
  }
}

// ===== 后台与锁定 =====
const closeAction = ref<'background' | 'quit'>('background');
const autoLockMinutes = ref(15);
const agentPermission = ref<'readonly' | 'normal' | 'full'>('normal');
// 以下四项是安全开关：默认关闭/开启见 core/settings.ts 的 DEFAULT_SETTINGS，这里只做界面回显
const allowLockedAccess = ref(false);
const allowAgentExec = ref(false);
const proxyAllowHttp = ref(false);
const dailyBackup = ref(true);
const mcpFullTools = ref(false);
const agentExposeSecrets = ref(false);
const auditMaxMB = ref(5);
const auditKeepGenerations = ref(3);
/** 当前密钥派生强度（老库用 210k，需要改一次口令升级到 650k） */
const kdf = ref<{ iter: number; recommended: number; upgradeRecommended: boolean } | null>(null);
const secMsg = ref('');
const secErr = ref('');
const secBusy = ref(false);

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const j = await res.json();
    if (j.settings) {
      closeAction.value = j.settings.closeAction;
      autoLockMinutes.value = j.settings.autoLockMinutes;
      agentPermission.value = j.settings.agentPermission || 'normal';
      allowLockedAccess.value = !!j.settings.allowLockedAccess;
      allowAgentExec.value = !!j.settings.allowAgentExec;
      proxyAllowHttp.value = !!j.settings.proxyAllowHttp;
      dailyBackup.value = j.settings.dailyBackup !== false;
      mcpFullTools.value = j.settings.mcpFullTools === true;
      agentExposeSecrets.value = j.settings.agentExposeSecrets === true;
      auditMaxMB.value = Number(j.settings.auditMaxMB) || 5;
      auditKeepGenerations.value = Number(j.settings.auditKeepGenerations ?? 3);
    }
    const kres = await fetch('/api/kdf');
    const kj = await kres.json();
    if (kres.ok) kdf.value = kj;
    await loadSk();
    await loadTokens();
    await loadTokenAssets();
    sshAgentOn.value = j.settings.sshAgent === true;
    await loadAgent();
  } catch {
    /* 后端未就绪时先显示默认值 */
  }
}

async function saveSettings() {
  secMsg.value = '';
  secErr.value = '';
  secBusy.value = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        closeAction: closeAction.value,
        autoLockMinutes: autoLockMinutes.value,
        agentPermission: agentPermission.value,
        allowLockedAccess: allowLockedAccess.value,
        allowAgentExec: allowAgentExec.value,
        proxyAllowHttp: proxyAllowHttp.value,
        dailyBackup: dailyBackup.value,
        mcpFullTools: mcpFullTools.value,
        agentExposeSecrets: agentExposeSecrets.value,
        sshAgent: sshAgentOn.value,
        auditMaxMB: auditMaxMB.value,
        auditKeepGenerations: auditKeepGenerations.value,
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      secErr.value = j.error || tr('set.err.save');
      return;
    }
    closeAction.value = j.settings.closeAction;
    autoLockMinutes.value = j.settings.autoLockMinutes;
    agentPermission.value = j.settings.agentPermission || 'normal';
    allowLockedAccess.value = !!j.settings.allowLockedAccess;
    allowAgentExec.value = !!j.settings.allowAgentExec;
    proxyAllowHttp.value = !!j.settings.proxyAllowHttp;
    dailyBackup.value = j.settings.dailyBackup !== false;
    mcpFullTools.value = j.settings.mcpFullTools === true;
    agentExposeSecrets.value = j.settings.agentExposeSecrets === true;
    sshAgentOn.value = j.settings.sshAgent === true;
    auditMaxMB.value = Number(j.settings.auditMaxMB) || 5;
    auditKeepGenerations.value = Number(j.settings.auditKeepGenerations ?? 3);
    secMsg.value = tr('set.msg.secSaved');
    await loadAgent();
  } catch (e: any) {
    secErr.value = e.message || tr('set.err.request');
  } finally {
    secBusy.value = false;
  }
}

async function lockNow() {
  secErr.value = '';
  secBusy.value = true;
  try {
    await fetch('/api/lock', { method: 'POST' });
    secMsg.value = '';
    emit('locked');
  } catch (e: any) {
    secErr.value = e.message || tr('set.err.lock');
  } finally {
    secBusy.value = false;
  }
}

const oldPass = ref('');
const newPass = ref('');
const confirmPass = ref('');
const msg = ref('');
const err = ref('');
const busy = ref(false);

const backupMsg = ref('');
const backupErr = ref('');
const backupBusy = ref(false);
/** 选中待导入的备份正文（Electron 不支持 window.prompt，口令改页面内输入） */
const importPendingText = ref('');
const importPendingName = ref('');
const importPass = ref('');

type CatalogField = {
  key: string;
  typeLabel: string;
  fieldLabel: string;
  options: string[];
  allowCustom: boolean;
};

const catalogFields = ref<CatalogField[]>([]);
const selectedKey = ref('');
const editOptions = ref<string[]>([]);
const newOption = ref('');
const catMsg = ref('');
const catErr = ref('');
const catBusy = ref(false);

const selectedMeta = computed(() => catalogFields.value.find((f) => f.key === selectedKey.value));

// ===== 类型颜色 =====
const typeLabels = ref<Record<string, string>>({});
const typeColors = ref<Record<string, string>>({});
/** 首次加载时的颜色快照，用于「恢复默认」 */
const initialColors = ref<Record<string, string>>({});
const colorMsg = ref('');
const colorErr = ref('');
const colorBusy = ref(false);

/** 内置类型 key：服务端返回的 label 是中文常量，这里按 key 走字典；自定义类型用服务端 label */
const BUILTIN_TYPES = new Set([
  'server',
  'ssh_key',
  'cloud_account',
  'oss',
  'baota',
  'mcp',
  'api_key',
  'login_account',
  'email_account',
  'note',
  'project',
]);
const typeList = computed(() =>
  Object.keys(typeLabels.value).map((k) => ({
    key: k,
    label: BUILTIN_TYPES.has(k) ? schemaTypeLabel(k) : typeLabels.value[k],
  }))
);

function colorOf(k: string): string {
  return typeColors.value[k] || '#f6f8fa';
}
function setColor(k: string, v: string) {
  typeColors.value = { ...typeColors.value, [k]: v };
}
function resetColor(k: string) {
  typeColors.value = { ...typeColors.value, [k]: initialColors.value[k] || '#f6f8fa' };
}

async function loadTypes() {
  try {
    const r = await fetch('/api/types');
    const j = await r.json();
    typeLabels.value = j.types || j || {};
  } catch {
    /* 旧服务端无此接口时忽略 */
  }
}

async function saveTypeColors() {
  colorMsg.value = '';
  colorErr.value = '';
  colorBusy.value = true;
  try {
    const res = await fetch('/api/field-catalog', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ typeColors: typeColors.value }),
    });
    const j = await res.json();
    if (!res.ok) {
      colorErr.value = j.error || tr('set.err.save');
      return;
    }
    typeColors.value = j.typeColors || typeColors.value;
    initialColors.value = { ...typeColors.value };
    colorMsg.value = tr('set.msg.colorSaved');
    emit('saved');
  } catch (e: any) {
    colorErr.value = e.message || tr('set.err.request');
  } finally {
    colorBusy.value = false;
  }
}

async function loadCatalog() {
  catErr.value = '';
  try {
    const res = await fetch('/api/field-catalog');
    const j = await res.json();
    if (!res.ok) {
      catErr.value = j.error || tr('set.err.loadFields');
      return;
    }
    catalogFields.value = j.fields || [];
    if (j.typeColors) {
      typeColors.value = { ...j.typeColors };
      if (!Object.keys(initialColors.value).length) initialColors.value = { ...j.typeColors };
    }
    if (!selectedKey.value && catalogFields.value.length) {
      selectedKey.value = catalogFields.value[0].key;
    }
    syncEditFromSelected();
    await loadTypes();
  } catch (e: any) {
    catErr.value = e.message || tr('set.err.load');
  }
}

function syncEditFromSelected() {
  const f = catalogFields.value.find((x) => x.key === selectedKey.value);
  editOptions.value = f ? [...f.options] : [];
}

watch(selectedKey, () => {
  catMsg.value = '';
  catErr.value = '';
  syncEditFromSelected();
});

function addOption() {
  const s = newOption.value.trim();
  if (!s) return;
  if (editOptions.value.includes(s)) {
    catErr.value = tr('set.err.exists');
    return;
  }
  editOptions.value = [...editOptions.value, s];
  newOption.value = '';
  catErr.value = '';
}

function removeOption(i: number) {
  editOptions.value = editOptions.value.filter((_, idx) => idx !== i);
}

function moveOption(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= editOptions.value.length) return;
  const next = [...editOptions.value];
  const t = next[i];
  next[i] = next[j];
  next[j] = t;
  editOptions.value = next;
}

async function saveCatalog() {
  catMsg.value = '';
  catErr.value = '';
  if (!selectedKey.value) return;
  const options = editOptions.value.map((s) => s.trim()).filter(Boolean);
  if (!options.length) {
    catErr.value = tr('set.err.keepOne');
    return;
  }
  catBusy.value = true;
  try {
    const res = await fetch('/api/field-catalog', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          [selectedKey.value]: { options },
        },
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      catErr.value = j.error || tr('set.err.save');
      return;
    }
    catalogFields.value = j.fields || [];
    syncEditFromSelected();
    catMsg.value = tr('set.msg.catSaved');
    emit('saved');
  } catch (e: any) {
    catErr.value = e.message || tr('set.err.request');
  } finally {
    catBusy.value = false;
  }
}

async function submit() {
  msg.value = '';
  err.value = '';
  if (!oldPass.value || !newPass.value) {
    err.value = tr('set.err.needPass2');
    return;
  }
  if (newPass.value !== confirmPass.value) {
    err.value = tr('set.err.passMismatch');
    return;
  }
  busy.value = true;
  try {
    const res = await fetch('/api/passphrase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldPassphrase: oldPass.value,
        newPassphrase: newPass.value,
        confirmPassphrase: confirmPass.value,
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      err.value = j.error || tr('set.err.changeFail');
      return;
    }
    msg.value = j.tip || tr('set.msg.passUpdated');
    oldPass.value = '';
    newPass.value = '';
    confirmPass.value = '';
  } catch (e: any) {
    err.value = e.message || tr('set.err.request');
  } finally {
    busy.value = false;
  }
}

async function exportBackup() {
  backupMsg.value = '';
  backupErr.value = '';
  backupBusy.value = true;
  try {
    const res = await fetch('/api/backup/export');
    const j = await res.json();
    if (!res.ok) {
      backupErr.value = j.error || tr('set.err.export');
      return;
    }
    const blob = new Blob([j.backup], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'flintkeep-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
    backupMsg.value = tr('set.msg.exported');
  } catch (e: any) {
    backupErr.value = e.message || tr('set.err.export');
  } finally {
    backupBusy.value = false;
  }
}

function clearImportPending() {
  importPendingText.value = '';
  importPendingName.value = '';
  importPass.value = '';
}

function pickBackupFile() {
  backupMsg.value = '';
  backupErr.value = '';
  clearImportPending();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) {
      backupErr.value = tr('set.err.noFile');
      return;
    }
    try {
      importPendingText.value = await file.text();
      importPendingName.value = file.name;
      importPass.value = '';
      backupMsg.value = tr('set.msg.picked', { name: file.name });
    } catch (e: any) {
      backupErr.value = e.message || tr('set.err.readBackup');
    }
  };
  input.click();
}

async function confirmImportBackup() {
  backupMsg.value = '';
  backupErr.value = '';
  if (!importPendingText.value) {
    backupErr.value = tr('set.err.pickFirst');
    return;
  }
  if (!importPass.value) {
    backupErr.value = tr('set.err.needPass');
    return;
  }
  backupBusy.value = true;
  try {
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup: importPendingText.value, passphrase: importPass.value }),
    });
    const j = await res.json();
    if (!res.ok) {
      backupErr.value = j.error || tr('set.err.import');
      return;
    }
    const wl = typeof j.whitelist === 'number' ? j.whitelist : 0;
    backupMsg.value =
      tr('set.msg.imported', { n: j.imported }) +
      (wl ? tr('set.msg.importedWl', { n: wl }) : tr('set.msg.importedNoWl'));
    clearImportPending();
    emit('imported');
  } catch (e: any) {
    backupErr.value = e.message || tr('set.err.import');
  } finally {
    backupBusy.value = false;
  }
}

// ===== 关于 / 更新 =====
/** 版本号从 /api/about 取（以 package.json 为准，前端不写死） */
const about = ref({
  name: '燧垒 FlintKeep',
  version: '',
  repo: 'https://github.com/yanyunai/flintkeep',
  site: 'https://flintkeep.pages.dev',
  license: 'AGPL-3.0-only',
  releases: 'https://github.com/yanyunai/flintkeep/releases',
  summary: '',
});
const updateState = ref<'idle' | 'checking' | 'latest' | 'available' | 'unknown'>('idle');
const updateMsg = ref('');
const updateUrl = ref('');
const openFailedUrl = ref('');

async function loadAbout() {
  try {
    const r = await fetch('/api/about');
    if (r.ok) about.value = { ...about.value, ...(await r.json()) };
  } catch {
    /* 展示信息拿不到不该阻断设置页，用默认值兜底 */
  }
}

async function checkUpdate() {
  updateState.value = 'checking';
  updateMsg.value = '';
  try {
    const r = await fetch('/api/update/check');
    const j = await r.json();
    if (!r.ok) {
      updateState.value = 'unknown';
      updateMsg.value = j.error || tr('set.update.failed');
      return;
    }
    if (j.hasUpdate) {
      updateState.value = 'available';
      updateUrl.value = j.url || about.value.releases;
      updateMsg.value = tr('set.update.available', {
        latest: j.latest || '?',
        current: j.current || about.value.version,
      });
    } else if (j.source === 'none' || !j.latest) {
      updateState.value = 'unknown';
      updateMsg.value = tr('set.update.unreachable');
    } else {
      updateState.value = 'latest';
      updateMsg.value = tr('set.update.latest');
    }
  } catch (e: any) {
    updateState.value = 'unknown';
    updateMsg.value = e?.message || tr('set.update.failed');
  }
}

/** 打开外部链接：Electron 走 preload IPC，浏览器走新标签页；都不行就把地址露出来让用户复制 */
async function openLink(url: string) {
  openFailedUrl.value = '';
  const ok = await openExternal(url);
  if (!ok) openFailedUrl.value = url;
}

onMounted(() => {
  loadCatalog();
  loadSettings();
  loadAiConf();
  loadAbout();
});
</script>

<template>
  <!-- mg-token：旧令牌桥接类，两种模式都挂（新版在 App.vue [data-mgui].mg-token 下映射到模板令牌，
       经典模式在 .mg-page.mg-token:not([data-mgui]) 下反向补齐缺失令牌）-->
  <div class="mg-view mg-token">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('set.summary') }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('set.kicker') }}</div>
          <div class="page-title">{{ tr('set.title') }}</div>
        </div>
      </div>

      <div class="set-layout">
        <aside class="set-nav">
          <button
            v-for="s in SET_SECTIONS"
            :key="s.k"
            type="button"
            class="set-nav-item"
            :class="{ on: setSection === s.k }"
            @click="setSection = s.k"
          >
            <i class="ico" v-html="sideIcon(s.icon)"></i>
            <span class="lbl">{{ s.label }}</span>
            <em class="dsc">{{ s.desc }}</em>
          </button>
        </aside>

        <div class="set-body">
          <!-- 外观 -->
          <section v-show="setSection === 'appearance'" class="set-card">
            <header>
              <h3>{{ tr('set.appearance') }}</h3>
              <span class="tag">{{ tr('set.appearance.badge') }}</span>
            </header>
            <p class="hint">{{ tr('set.appearance.hint') }}</p>
            <label class="set-field">
              <span>{{ tr('set.field.language') }}</span>
              <select v-model="lang">
                <option value="zh-CN">{{ tr('set.lang.zh') }}</option>
                <option value="en-US">{{ tr('set.lang.en') }}</option>
              </select>
            </label>
            <label class="set-field">
              <span>{{ tr('set.field.template') }}</span>
              <select v-model="uiTemplate">
                <option value="obs">{{ tr('set.template.obs') }}</option>
                <option value="atlas">{{ tr('set.template.atlas') }}</option>
              </select>
            </label>
            <label class="set-field">
              <span>{{ tr('set.field.theme') }}</span>
              <select v-model="uiTheme">
                <option value="dark">{{ tr('set.theme.dark') }}</option>
                <option value="light">{{ tr('set.theme.light') }}</option>
              </select>
            </label>
            <label class="set-field">
              <span>{{ tr('set.field.assetsUi') }}</span>
              <select v-model="uiMode">
                <option value="new">{{ tr('set.assetsUi.new') }}</option>
                <option value="classic">{{ tr('set.assetsUi.classic') }}</option>
              </select>
            </label>
          </section>

          <!-- 后台与锁定 -->
          <section v-show="setSection === 'security'" class="set-card">
            <header>
              <h3>{{ tr('set.security') }}</h3>
            </header>
            <p class="hint">{{ tr('set.security.hint') }}</p>
            <label class="set-field">
              <span>{{ tr('set.field.closeAction') }}</span>
              <select v-model="closeAction">
                <option value="background">{{ tr('set.close.background') }}</option>
                <option value="quit">{{ tr('set.close.quit') }}</option>
              </select>
            </label>
            <label class="set-field">
              <span>{{ tr('set.field.autoLock') }}</span>
              <input v-model.number="autoLockMinutes" type="number" min="0" max="1440" />
            </label>
            <label class="set-field">
              <span>{{ tr('set.field.agentPerm') }}</span>
              <select v-model="agentPermission">
                <option value="readonly">{{ tr('set.agent.readonly') }}</option>
                <option value="normal">{{ tr('set.agent.normal') }}</option>
                <option value="full">{{ tr('set.agent.full') }}</option>
              </select>
            </label>

            <!-- 安全开关：默认值都在 core/settings.ts，改这里只影响界面回显 -->
            <label class="set-field check">
              <span>{{ tr('set.field.allowLockedAccess') }}</span>
              <input v-model="allowLockedAccess" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.allowLockedAccess') }}</p>

            <label class="set-field check">
              <span>{{ tr('set.field.allowAgentExec') }}</span>
              <input v-model="allowAgentExec" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.allowAgentExec') }}</p>

            <label class="set-field check">
              <span>{{ tr('set.field.proxyAllowHttp') }}</span>
              <input v-model="proxyAllowHttp" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.proxyAllowHttp') }}</p>

            <label class="set-field check">
              <span>{{ tr('set.field.dailyBackup') }}</span>
              <input v-model="dailyBackup" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.dailyBackup') }}</p>

            <label class="set-field check">
              <span>{{ tr('set.field.mcpFullTools') }}</span>
              <input v-model="mcpFullTools" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.mcpFullTools') }}</p>

            <label class="set-field check">
              <span>{{ tr('set.field.agentExposeSecrets') }}</span>
              <input v-model="agentExposeSecrets" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.agentExposeSecrets') }}</p>

            <label class="set-field">
              <span>{{ tr('set.field.auditMaxMB') }}</span>
              <input v-model.number="auditMaxMB" type="number" min="1" max="100" step="1" />
            </label>
            <label class="set-field">
              <span>{{ tr('set.field.auditGenerations') }}</span>
              <input v-model.number="auditKeepGenerations" type="number" min="0" max="10" step="1" />
            </label>
            <p class="hint sub">{{ tr('set.hint.auditRetention') }}</p>
            <p class="hint sub">
              <a href="/api/audit/export" download>{{ tr('set.audit.export') }}</a>
              —— {{ tr('set.audit.exportHint') }}
            </p>

            <label class="set-field check">
              <span>{{ tr('set.field.sshAgent') }}</span>
              <input v-model="sshAgentOn" type="checkbox" />
            </label>
            <p class="hint sub">{{ tr('set.hint.sshAgent') }}</p>

            <div class="set-actions">
              <button class="btn primary" type="button" :disabled="secBusy" @click="saveSettings">
                {{ secBusy ? tr('set.busy') : tr('common.btn.save') }}
              </button>
              <button class="btn" type="button" :disabled="secBusy" @click="lockNow">{{ tr('set.lockNow') }}</button>
            </div>
            <p v-if="secErr" class="msg err">{{ secErr }}</p>
            <p v-if="secMsg" class="msg ok">{{ secMsg }}</p>
          </section>

          <!-- 修改口令 -->
          <section v-show="setSection === 'security'" class="set-card">
            <header>
              <h3>{{ tr('set.pass.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.pass.hint') }}</p>
            <p v-if="kdf" class="hint sub">{{ tr('set.pass.kdf', { iter: kdf.iter }) }}</p>
            <p v-if="kdf && kdf.upgradeRecommended" class="hint sub warn">
              {{ tr('set.pass.kdfUpgrade', { cur: kdf.iter, rec: kdf.recommended }) }}
            </p>
            <label class="set-field">
              <span>{{ tr('set.pass.old') }}</span>
              <input v-model="oldPass" type="password" autocomplete="current-password" />
            </label>
            <label class="set-field">
              <span>{{ tr('set.pass.new') }}</span>
              <input v-model="newPass" type="password" autocomplete="new-password" />
            </label>
            <label class="set-field">
              <span>{{ tr('set.pass.confirm') }}</span>
              <input v-model="confirmPass" type="password" autocomplete="new-password" @keyup.enter="submit" />
            </label>
            <div class="set-actions">
              <button class="btn primary" :disabled="busy" @click="submit">
                {{ busy ? tr('set.pass.saveBusy') : tr('set.pass.save') }}
              </button>
            </div>
            <p v-if="err" class="msg err">{{ err }}</p>
            <p v-if="msg" class="msg ok">{{ msg }}</p>
          </section>

          <!-- 双因子（Secret Key） -->
          <section v-show="setSection === 'security'" class="set-card">
            <header>
              <h3>{{ tr('set.sk.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.sk.hint') }}</p>
            <p v-if="sk" class="hint sub">
              <b>{{ sk.enabled ? tr('set.sk.on') : tr('set.sk.off') }}</b>
              <template v-if="sk.enabled && sk.hint"> · {{ tr('set.sk.hintLabel') }} ••••-{{ sk.hint }}</template>
              <template v-if="sk.fingerprint"> · {{ tr('set.sk.fingerprint') }} {{ sk.fingerprint }}</template>
            </p>
            <p v-if="sk && sk.enabled && sk.rollbackUntil" class="hint sub">
              {{ tr('set.sk.rollback', { time: new Date(sk.rollbackUntil).toLocaleString() }) }}
            </p>
            <p v-if="sk && sk.enabled && !sk.rollbackAvailable" class="hint sub warn">{{ tr('set.sk.expired') }}</p>
            <p v-if="sk && sk.enabled" class="hint sub">
              {{ sk.storedOnDevice ? tr('set.sk.stored') : tr('set.sk.notStored') }}
            </p>

            <!-- 刚生成：明文只在这里出现一次 -->
            <div v-if="skNew" class="sk-new">
              <p class="hint sub warn">{{ tr('set.sk.newWarn') }}</p>
              <code class="sk-code">{{ skNew.secretKey }}</code>
              <div class="set-actions">
                <button class="btn" type="button" @click="copySk">{{ tr('set.sk.copy') }}</button>
                <button class="btn" type="button" @click="downloadKit">{{ tr('set.sk.kit') }}</button>
                <button class="btn primary" type="button" @click="dismissNewSk">{{ tr('set.sk.saved') }}</button>
              </div>
            </div>

            <template v-else-if="sk && !sk.enabled">
              <p class="hint sub">{{ tr('set.sk.enableHint') }}</p>
              <label class="set-field">
                <span>{{ tr('set.sk.pass') }}</span>
                <input v-model="skPass" type="password" autocomplete="current-password" />
              </label>
              <div class="set-actions">
                <button class="btn primary" type="button" :disabled="skBusy" @click="enableSk">
                  {{ skBusy ? tr('set.sk.enableBusy') : tr('set.sk.enable') }}
                </button>
              </div>
            </template>

            <template v-else-if="sk && sk.enabled">
              <p class="hint sub">{{ tr('set.sk.disableHint') }}</p>
              <div class="set-actions">
                <button class="btn" type="button" @click="downloadKit">{{ tr('set.sk.kit') }}</button>
              </div>
              <template v-if="sk.rollbackAvailable">
                <label class="set-field">
                  <span>{{ tr('set.sk.pass') }}</span>
                  <input v-model="skPass" type="password" autocomplete="current-password" />
                </label>
                <label class="set-field">
                  <span>{{ tr('set.sk.secret') }}</span>
                  <input v-model="skSecret" type="text" placeholder="••••-••••" autocomplete="off" spellcheck="false" />
                </label>
                <div class="set-actions">
                  <button class="btn" type="button" :disabled="skBusy" @click="disableSk">
                    {{ skBusy ? tr('set.sk.disableBusy') : tr('set.sk.disable') }}
                  </button>
                </div>
              </template>
            </template>

            <p v-if="skErr" class="msg err">{{ skErr }}</p>
            <p v-if="skMsg" class="msg ok">{{ skMsg }}</p>
          </section>

          <!-- 访问令牌（服务账号） -->
          <section v-show="setSection === 'security'" class="set-card">
            <header>
              <h3>{{ tr('set.tok.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.tok.hint') }}</p>

            <div v-if="tokNew" class="sk-new">
              <p class="hint sub warn">{{ tr('set.tok.warnOnce') }}</p>
              <code class="sk-code">{{ tokNew.token }}</code>
              <div class="set-actions">
                <button class="btn" type="button" @click="copyToken">{{ tr('set.tok.copy') }}</button>
                <button class="btn primary" type="button" @click="dismissNewToken">{{ tr('set.tok.done') }}</button>
              </div>
            </div>

            <template v-else>
              <label class="set-field">
                <span>{{ tr('set.tok.name') }}</span>
                <input v-model="tokName" type="text" maxlength="40" placeholder="ci-deploy" />
              </label>
              <label class="set-field">
                <span>{{ tr('set.tok.search') }}</span>
                <input v-model="tokQuery" type="text" />
              </label>
              <div v-if="tokSelected.length" class="tok-chips">
                <span class="hint sub">{{ tr('set.tok.selected', { n: tokSelected.length }) }}</span>
                <button
                  v-for="id in tokSelected"
                  :key="id"
                  type="button"
                  class="tok-chip"
                  @click="tokSelected = tokSelected.filter((x) => x !== id)"
                >
                  {{ tokNameOf(id) }} ×
                </button>
              </div>
              <div class="tok-picks">
                <label v-for="a in tokFiltered" :key="a.id" class="tok-pick">
                  <input v-model="tokSelected" type="checkbox" :value="a.id" />
                  <span>{{ a.name }}</span>
                  <em
                    >{{ a.type }}<template v-if="a.no"> #{{ a.no }}</template></em
                  >
                </label>
                <p v-if="!tokFiltered.length" class="hint sub">{{ tr('set.tok.empty') }}</p>
              </div>
              <label class="set-field">
                <span>{{ tr('set.tok.caps') }}</span>
                <span class="tok-caps">
                  <label><input v-model="tokCapProxy" type="checkbox" /> {{ tr('set.tok.capProxy') }}</label>
                  <label><input v-model="tokCapSsh" type="checkbox" /> {{ tr('set.tok.capSsh') }}</label>
                </span>
              </label>
              <label class="set-field">
                <span>{{ tr('set.tok.days') }}</span>
                <input v-model.number="tokDays" type="number" min="1" max="365" />
              </label>
              <div class="set-actions">
                <button class="btn primary" type="button" :disabled="tokBusy" @click="createToken">
                  {{ tokBusy ? tr('set.tok.creating') : tr('set.tok.create') }}
                </button>
              </div>
            </template>

            <p v-if="tokErr" class="msg err">{{ tokErr }}</p>
            <p v-if="tokMsg" class="msg ok">{{ tokMsg }}</p>

            <h4 class="tok-list-title">{{ tr('set.tok.list') }}</h4>
            <p v-if="!tokens.length" class="hint sub">{{ tr('set.tok.empty') }}</p>
            <div v-for="t in tokens" :key="t.id" class="tok-row">
              <code>{{ t.prefix }}</code>
              <b>{{ t.name }}</b>
              <span class="hint sub">
                {{ tr('set.tok.scopeSummary', { n: t.scope.assets.length }) }} · {{ t.caps.join(' + ') }} ·
                {{
                  t.active
                    ? tr('set.tok.active', { days: t.daysLeft })
                    : t.revokedAt
                      ? tr('set.tok.revoked')
                      : tr('set.tok.expired')
                }}
                ·
                {{
                  t.lastUsedAt
                    ? tr('set.tok.lastUsed', { when: new Date(t.lastUsedAt).toLocaleString() })
                    : tr('set.tok.never')
                }}
              </span>
              <button v-if="t.active" type="button" class="btn" @click="revokeToken(t.id)">
                {{ tr('set.tok.revoke') }}
              </button>
            </div>
          </section>

          <!-- 本地 SSH agent -->
          <section v-show="setSection === 'security'" class="set-card">
            <header>
              <h3>{{ tr('set.agent.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.agent.hint') }}</p>
            <p class="hint sub">
              {{ agentInfo?.running ? tr('set.agent.running', { n: agentInfo.keys.length }) : tr('set.agent.stopped') }}
              <template v-if="agentInfo && !agentInfo.enabled">· {{ tr('set.agent.disabled') }}</template>
            </p>
            <label class="set-field">
              <span>{{ tr('set.agent.socket') }}</span>
              <input :value="agentInfo?.socket || ''" readonly />
            </label>
            <label class="set-field">
              <span>{{ tr('set.agent.usage') }}</span>
              <code class="sk-code">{{ agentInfo?.exportCommand || '' }}</code>
            </label>
            <div class="set-actions">
              <button class="btn" type="button" @click="copyAgentEnv">{{ tr('set.agent.copy') }}</button>
              <button class="btn" type="button" @click="loadAgent">{{ tr('set.agent.refresh') }}</button>
            </div>
            <h4 class="tok-list-title">{{ tr('set.agent.keys') }}</h4>
            <p v-if="!agentInfo?.keys?.length" class="hint sub">{{ tr('set.agent.noKeys') }}</p>
            <div v-for="k in agentInfo?.keys || []" :key="k.assetId" class="tok-row">
              <code>{{ k.algo }}</code>
              <b>{{ k.name }}</b>
              <span class="hint sub">{{ k.fingerprint }}</span>
            </div>
            <p v-if="agentMsg" class="msg ok">{{ agentMsg }}</p>
            <p v-if="agentErr" class="msg err">{{ agentErr }}</p>
          </section>

          <!-- AI 模型 -->
          <section v-show="setSection === 'ai'" class="set-card">
            <header>
              <h3>{{ tr('set.ai.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.ai.hint') }}</p>
            <label class="set-field">
              <span>{{ tr('set.ai.preset') }}</span>
              <select v-model="aiConf.base">
                <option value="">{{ tr('form.catalogCustom') }}</option>
                <option v-for="p in AI_PRESETS" :key="p.base" :value="p.base">{{ p.name }}</option>
                <option v-if="aiConf.base && !AI_PRESETS.some((p) => p.base === aiConf.base)" :value="aiConf.base">
                  {{ tr('set.ai.custom') }}
                </option>
              </select>
            </label>
            <label class="set-field">
              <span>{{ tr('set.ai.endpoint') }}</span>
              <input v-model="aiConf.base" placeholder="https://api.deepseek.com" />
            </label>
            <label class="set-field">
              <span>{{ tr('set.ai.model') }}</span>
              <input v-model="aiConf.model" :placeholder="tr('set.ai.modelPh')" />
            </label>
            <label class="set-field">
              <span>API Key{{ aiConf.hasKey ? tr('set.ai.keySaved') : '' }}</span>
              <input v-model="aiKeyInput" type="password" placeholder="sk-..." autocomplete="off" />
            </label>
            <div class="set-actions">
              <button class="btn primary" @click="saveAiConf">{{ tr('set.ai.save') }}</button>
            </div>
            <p v-if="aiConfMsg" class="msg ok">{{ aiConfMsg }}</p>
            <p v-if="aiConfErr" class="msg err">{{ aiConfErr }}</p>
          </section>

          <!-- 数据备份 -->
          <section v-show="setSection === 'data'" class="set-card wide">
            <header>
              <h3>{{ tr('set.data.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.data.hint') }}</p>
            <div class="set-actions">
              <button class="btn primary" type="button" :disabled="backupBusy" @click="exportBackup">
                {{ backupBusy ? tr('set.busy') : tr('set.data.export') }}
              </button>
              <button class="btn" type="button" :disabled="backupBusy" @click="pickBackupFile">
                {{ tr('set.data.pick') }}
              </button>
            </div>
            <div v-if="importPendingName" class="set-import">
              <p class="hint">
                {{ tr('set.data.pending') }}<code>{{ importPendingName }}</code
                >{{ tr('set.data.pendingHint') }}
              </p>
              <label class="set-field">
                <span>{{ tr('set.data.pass') }}</span>
                <input v-model="importPass" type="password" autocomplete="off" @keyup.enter="confirmImportBackup" />
              </label>
              <div class="set-actions">
                <button class="btn primary" type="button" :disabled="backupBusy" @click="confirmImportBackup">
                  {{ backupBusy ? tr('set.data.importBusy') : tr('set.data.import') }}
                </button>
                <button class="btn" type="button" :disabled="backupBusy" @click="clearImportPending">
                  {{ tr('common.btn.cancel') }}
                </button>
              </div>
            </div>
            <p v-if="backupErr" class="msg err">{{ backupErr }}</p>
            <p v-if="backupMsg" class="msg ok">{{ backupMsg }}</p>
          </section>

          <!-- 字段选项 -->
          <section v-show="setSection === 'fields'" class="set-card wide">
            <header>
              <h3>{{ tr('set.fields.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.fields.hint') }}</p>
            <label class="set-field">
              <span>{{ tr('set.fields.pick') }}</span>
              <select v-model="selectedKey">
                <option v-for="f in catalogFields" :key="f.key" :value="f.key">
                  {{ catalogFieldLabel(f) }}
                </option>
              </select>
            </label>

            <div v-if="selectedMeta" class="opt-editor">
              <ul class="opt-list">
                <li v-for="(o, i) in editOptions" :key="o + i">
                  <span class="opt-text">{{ o }}</span>
                  <span class="opt-ops">
                    <button type="button" :disabled="i === 0" @click="moveOption(i, -1)">↑</button>
                    <button type="button" :disabled="i === editOptions.length - 1" @click="moveOption(i, 1)">↓</button>
                    <button type="button" class="del" @click="removeOption(i)">×</button>
                  </span>
                </li>
              </ul>
              <p v-if="!editOptions.length" class="empty-opts">{{ tr('set.fields.empty') }}</p>
              <div class="opt-add">
                <input
                  v-model="newOption"
                  type="text"
                  :placeholder="tr('set.fields.placeholder')"
                  @keyup.enter="addOption"
                />
                <button type="button" class="btn" @click="addOption">{{ tr('common.btn.add') }}</button>
              </div>
              <div class="set-actions">
                <button class="btn primary" :disabled="catBusy" @click="saveCatalog">
                  {{ catBusy ? tr('set.fields.saveBusy') : tr('set.fields.save') }}
                </button>
              </div>
              <p v-if="catErr" class="msg err">{{ catErr }}</p>
              <p v-if="catMsg" class="msg ok">{{ catMsg }}</p>
            </div>
          </section>

          <section v-show="setSection === 'fields'" class="set-card wide">
            <FieldSchemaPanel @saved="emit('saved')" />
          </section>

          <!-- 类型颜色 -->
          <section v-show="setSection === 'types'" class="set-card wide">
            <header>
              <h3>{{ tr('set.types.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.types.hint') }}</p>
            <ul class="color-list">
              <li v-for="t in typeList" :key="t.key">
                <span class="tag type-tag" :style="{ background: colorOf(t.key), borderColor: colorOf(t.key) }">
                  {{ t.label }}
                </span>
                <input
                  type="color"
                  :value="colorOf(t.key)"
                  @input="setColor(t.key, ($event.target as HTMLInputElement).value)"
                />
                <button type="button" class="btn sm" @click="resetColor(t.key)">{{ tr('set.types.default') }}</button>
              </li>
            </ul>
            <p v-if="!typeList.length" class="empty-opts">{{ tr('set.types.empty') }}</p>
            <div class="set-actions">
              <button class="btn primary" :disabled="colorBusy" @click="saveTypeColors">
                {{ colorBusy ? tr('set.fields.saveBusy') : tr('set.types.save') }}
              </button>
            </div>
            <p v-if="colorErr" class="msg err">{{ colorErr }}</p>
            <p v-if="colorMsg" class="msg ok">{{ colorMsg }}</p>
          </section>

          <!-- 关于：开源地址 / 介绍 / 检查更新 -->
          <section v-show="setSection === 'about'" class="set-card wide">
            <header>
              <h3>{{ tr('set.about.title') }}</h3>
            </header>

            <div class="about-head">
              <i class="about-gh" v-html="sideIcon('github')"></i>
              <div class="about-id">
                <div class="about-name">{{ about.name }}</div>
                <div class="about-meta">
                  {{ tr('set.about.version') }} {{ about.version || '—' }} · {{ tr('set.about.license') }}
                  {{ about.license }}
                </div>
              </div>
            </div>

            <p class="hint">{{ tr('set.about.intro') }}</p>

            <div class="about-links">
              <button type="button" class="btn sm" @click="openLink(about.repo)">
                <i class="ic" v-html="sideIcon('github')"></i> {{ tr('set.about.openRepo') }}
              </button>
              <button type="button" class="btn sm" @click="openLink(about.site)">{{ tr('set.about.openSite') }}</button>
              <button type="button" class="btn sm" @click="openLink(about.releases)">
                {{ tr('set.about.openReleases') }}
              </button>
            </div>
            <p class="about-repo">{{ about.repo }}</p>
            <p v-if="openFailedUrl" class="msg">{{ tr('set.about.openFailed') }} {{ openFailedUrl }}</p>

            <header class="sub-head">
              <h3>{{ tr('set.update.title') }}</h3>
            </header>
            <p class="hint">{{ tr('set.update.hint') }}</p>
            <div class="set-actions">
              <button type="button" class="btn primary" :disabled="updateState === 'checking'" @click="checkUpdate">
                {{ updateState === 'checking' ? tr('set.update.checking') : tr('set.update.check') }}
              </button>
              <button
                v-if="updateState === 'available'"
                type="button"
                class="btn"
                @click="openLink(updateUrl || about.releases)"
              >
                {{ tr('set.update.download') }}
              </button>
            </div>
            <p v-if="updateMsg" class="msg" :class="{ ok: updateState === 'latest' || updateState === 'available' }">
              {{ updateMsg }}
            </p>
            <p class="hint">{{ tr('set.update.manual') }}</p>
          </section>
        </div>
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

/* 左分区导航 + 右单分区内容：一屏只看一件事，不再 7 张卡平铺滚动 */
.set-layout {
  display: grid;
  grid-template-columns: 204px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.set-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: sticky;
  top: 0;
}
.set-nav-item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 9px;
  text-align: left;
  padding: 9px 10px;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-2);
}
.set-nav-item:hover {
  background: var(--hover);
  color: var(--text);
}
.set-nav-item.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.set-nav-item .ico {
  grid-row: 1 / span 2;
  align-self: center;
  font-style: normal;
}
.set-nav-item .ico :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}
.set-nav-item .lbl {
  font-size: var(--f-md);
  font-weight: 600;
  line-height: 1.4;
}
.set-nav-item .dsc {
  font-size: var(--f-xs);
  font-style: normal;
  color: var(--text-3);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.set-nav-item.on .dsc {
  color: var(--accent);
  opacity: 0.85;
}
.set-body {
  min-width: 0;
}
/* 子组件自带的旧卡片外壳：去掉边框底色，融进 set-card */
.set-card :deep(.card) {
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
}
.set-card.wide {
  grid-column: auto;
}
@media (max-width: 980px) {
  .set-layout {
    grid-template-columns: 1fr;
  }
  .set-nav {
    flex-direction: row;
    flex-wrap: wrap;
    position: static;
  }
}

.set-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 16px 18px;
}
.set-card > header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.set-card h3,
.set-card :deep(h3) {
  margin: 0;
  font-size: var(--f-md);
  font-weight: 600;
  color: var(--text);
}
.set-card header .tag {
  margin-left: auto;
  font-size: var(--f-xxs);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}

.hint {
  margin: 0 0 12px;
  font-size: var(--f-sm);
  line-height: 1.6;
  color: var(--text-3);
}
.hint code {
  font-family: var(--font-mono);
  color: var(--text-2);
}
/* 开关说明：跟在开关行后面，与标签列对齐，避免和下一个开关挤在一起 */
.hint.sub {
  margin: -4px 0 14px 144px;
  font-size: var(--f-xxs);
  line-height: 1.5;
}
.set-field.check > input[type='checkbox'] {
  justify-self: start;
  width: 18px;
  height: 18px;
  padding: 0;
  accent-color: var(--accent);
}

.set-field {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.set-field > span {
  font-size: var(--f-sm);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.set-field input,
.set-field select {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text);
  font-size: var(--f-sm);
}
.set-field input:focus,
.set-field select:focus {
  outline: none;
  border-color: var(--accent);
}

.set-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.set-import {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.msg {
  margin: 10px 0 0;
  font-size: var(--f-sm);
}
.msg.ok {
  color: var(--accent);
}
.msg.err {
  color: var(--danger);
}

/* 字段选项 */
.opt-editor {
  margin-top: 12px;
}
.opt-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
}
.opt-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line);
  font-size: var(--f-sm);
  color: var(--text-2);
}
.opt-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.opt-ops {
  display: flex;
  gap: 2px;
}
.opt-ops button {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: var(--f-xs);
}
.opt-ops button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}
.opt-ops button:disabled {
  opacity: 0.3;
}
.opt-ops .del:hover {
  color: var(--danger);
}
.opt-add {
  display: flex;
  gap: 8px;
}
.opt-add input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--bg);
  color: var(--text);
  font-size: var(--f-sm);
}
.empty-opts {
  margin: 8px 0;
  font-size: var(--f-sm);
  color: var(--text-3);
}

/* 类型颜色 */
.color-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 6px;
}
.color-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 6px;
  border-radius: var(--r-sm);
}
.color-list li:hover {
  background: var(--hover);
}
.color-list .type-tag {
  flex: 1;
  min-width: 0;
  justify-content: center;
}
.color-list input[type='color'] {
  width: 26px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  background: transparent;
}
.sk-code {
  display: block;
  margin: 8px 0 4px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 15px;
  letter-spacing: 1px;
  line-height: 1.6;
  word-break: break-all;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--hover);
  user-select: all;
}
.sk-new {
  margin: 10px 0;
}
.tok-picks {
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  padding: 6px;
  margin: 6px 0;
}
.tok-pick {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 4px;
  cursor: pointer;
}
.tok-pick em {
  font-style: normal;
  opacity: 0.6;
  font-size: 12px;
}
.tok-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 6px 0;
}
.tok-chip {
  border: 1px solid var(--line-2);
  background: var(--hover);
  border-radius: 999px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
}
.tok-caps {
  display: flex;
  gap: 12px;
  align-items: center;
}
.tok-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px 0;
  border-top: 1px solid var(--line-2);
}
.tok-row code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  opacity: 0.8;
}
.tok-list-title {
  margin: 14px 0 6px;
  font-size: 13px;
  opacity: 0.8;
}
/* 关于页：品牌标 + 版本行 + 链接按钮 */
.about-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 10px;
}
.about-gh {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.92;
}
.about-gh :deep(svg) {
  width: 34px;
  height: 34px;
}
.about-id {
  min-width: 0;
}
.about-name {
  font-size: 16px;
  font-weight: 600;
}
.about-meta {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.72;
}
.about-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 6px;
}
.about-repo {
  margin: 2px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  opacity: 0.62;
  word-break: break-all;
}
.sub-head {
  margin-top: 22px;
}
</style>
