/**
 * 腾讯云 TokenHub CLI（thcli）封装 —— 对标百炼 bailian-cli。
 *
 * 依赖：项目内 `tencent-tokenhub-cli` → `node_modules/.bin/thcli`
 * 凭据：`~/.thcli/{profile}.{site}.credential`、`{profile}.tokenhub.json`
 * 登录：由用户本机执行 `thcli auth login`（程序不代开浏览器）
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  normalizePriceEntries,
  summarizePrices,
  modalityOfCaps,
  type CatalogModel,
  type ModelModality,
  catalogModelFromRaw,
} from './model-catalog';

/** 与 ai-usage.FreeQuota 同构（避免循环依赖，不从 ai-usage 导入） */
export type ThFreeQuota = {
  model: string;
  type: string;
  remaining: number | null;
  total: number | null;
  usagePercent: number | null;
  remainingPercent: number | null;
  expires: string | null;
  expiresAt?: number | null;
  unit?: string | null;
  autoStop: boolean | 'unsupported' | null;
  /** 启用按 Token 计费（PaymentEnabled） */
  postpaid?: boolean | null;
  endpointId?: string;
  reset?: { kind: string; text: string; note: string } | null;
};

export type ThModelInfo = {
  id: string;
  name?: string;
  capabilities?: string[];
  modality: ModelModality;
  publishedAt?: string;
  price?: string;
  prices?: ReturnType<typeof normalizePriceEntries>;
  free: boolean;
  status?: string;
  offlineAt?: string;
  discontinuedAt?: string;
  freeTrial?: boolean;
};

/** 截成 YYYY-MM-DD（本地展示用） */
function dateOnly(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  const s = String(raw);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.slice(0, 10) || undefined;
}

export type ThProbeResult = {
  modelId: string;
  status: 'available' | 'limited' | 'unknown' | 'unavailable';
  httpStatus?: number;
  message?: string;
  ts: string;
};

export type ThCreds = {
  accessKeyId?: string;
  accessKeySecret?: string;
  apiKey?: string;
  baseUrl?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function thHome(): string {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.thcli');
}

export function thBin(): string {
  const root = path.join(__dirname, '..', '..');
  const isWin = process.platform === 'win32';
  return path.join(root, 'node_modules', '.bin', isWin ? 'thcli.cmd' : 'thcli');
}

/** 给界面用的可复制路径（勿重复拼命令） */
export function thBinPath(): string {
  const bin = thBin();
  return /[\s"']/.test(bin) ? JSON.stringify(bin) : bin;
}

/** 是否已安装 CLI（登录与否另查 auth status；未登录时页面给登录命令） */
export function thcliAvailable(): { ok: boolean; reason?: string } {
  const bin = thBin();
  if (!fs.existsSync(bin)) {
    return { ok: false, reason: '未安装 TokenHub CLI（tencent-tokenhub-cli）' };
  }
  return { ok: true };
}

/** 是否已有本地凭证文件（粗检；权威仍以 auth status.LoggedIn 为准） */
export function thcliHasCredentialFiles(): boolean {
  try {
    const home = thHome();
    if (!fs.existsSync(home)) return false;
    return fs.readdirSync(home).some((f) => f.endsWith('.credential'));
  } catch {
    return false;
  }
}

export type ThcliIdentity = {
  loggedIn: boolean;
  profile: string;
  site: string;
  region?: string;
  /** 掩码 SecretId（OAuth/永久密钥） */
  secretId?: string;
  type?: string;
  expiresAt?: string | null;
  /** 对话用 API Key 掩码（来自 chat-config / tokenhub.json，若有） */
  apiKey?: string;
  baseUrl?: string;
};

function runThcli(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bin = thBin();
  const cwd = path.join(__dirname, '..', '..');
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.stdout?.on('data', (d) => (stdout += String(d)));
    p.stderr?.on('data', (d) => (stderr += String(d)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function cleanText(s: string): string {
  return String(s || '')
    .split('\n')
    .filter((l) => !/UNDICI-EHPA|ExperimentalWarning|trace-warnings/i.test(l))
    .join('\n')
    .trim();
}

export async function execThcliJson<T>(args: string[], timeoutMs = 120000): Promise<T> {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  const { code, stdout, stderr } = await runThcli(withJson, timeoutMs);
  const text = cleanText(stdout);
  const a = text.indexOf('[');
  const o = text.indexOf('{');
  const idx = a >= 0 && (o < 0 || a < o) ? a : o;
  if (idx < 0) {
    const err = cleanText(stderr) || text || `thcli 退出码 ${code}`;
    throw new Error(err.slice(0, 300));
  }
  try {
    return JSON.parse(text.slice(idx)) as T;
  } catch {
    throw new Error((cleanText(stderr) || text || 'thcli JSON 解析失败').slice(0, 300));
  }
}

export function thcliErrorText(e: unknown): string {
  const raw = String((e as any)?.message || e || '').trim();
  if (!raw) return 'TokenHub CLI 调用失败（未返回原因）';
  if (/未找到腾讯云凭证|未登录|LoggedIn.: false/i.test(raw)) {
    return 'TokenHub CLI 未登录 —— 请在终端执行项目内 `thcli auth login`。';
  }
  if (/AuthFailure\.TokenFailure|Token.*过期|Expired/i.test(raw)) {
    return 'TokenHub 凭证失效 —— 请重新执行 `thcli auth login`。';
  }
  if (/ETIMEDOUT|timed out/i.test(raw)) return 'TokenHub CLI 请求超时，稍后重试。';
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

/** auth status --json */
export async function thcliAuthStatus(profile?: string): Promise<ThcliIdentity> {
  const args = ['auth', 'status'];
  if (profile) args.push('--profile', profile);
  const s = await execThcliJson<any>(args, 30000);
  const creds = readThProfileCreds(profile || String(s?.Profile || 'default'));
  return {
    loggedIn: s?.LoggedIn === true,
    profile: String(s?.Profile || profile || 'default'),
    site: String(s?.Site || 'cn'),
    region: s?.Region != null ? String(s.Region) : undefined,
    secretId: s?.SecretId ? String(s.SecretId) : undefined,
    type: s?.Type != null ? String(s.Type) : undefined,
    expiresAt: s?.ExpiresAt ?? null,
    apiKey: maskKey(creds?.apiKey) || undefined,
    baseUrl: creds?.baseUrl,
  };
}

function maskKey(key?: string): string | undefined {
  if (!key || key.length < 8) return undefined;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export async function listThProfiles(): Promise<{ name: string; active: boolean }[]> {
  try {
    const j = await execThcliJson<any>(['profile', 'list'], 30000);
    const current = String(j?.Current || 'default');
    const rows: any[] = Array.isArray(j?.Profiles) ? j.Profiles : [];
    if (!rows.length) {
      // 未 create 过 profile 时列表为空，但仍有 default
      return [{ name: 'default', active: true }];
    }
    return rows.map((r) => {
      const name = String(r?.Name || r?.name || r || 'default');
      return { name, active: name === current };
    });
  } catch {
    return [{ name: 'default', active: true }];
  }
}

export async function activeThProfile(): Promise<string> {
  const ps = await listThProfiles();
  return (ps.find((p) => p.active) || ps[0]).name;
}

export async function thcliProfilesDetail(): Promise<
  { name: string; active: boolean; identity: ThcliIdentity | null }[]
> {
  const ps = await listThProfiles();
  return Promise.all(
    ps.map(async (p) => ({
      ...p,
      identity: await thcliAuthStatus(p.name).catch(() => null),
    }))
  );
}

/**
 * 读本地已落盘的对话 API Key（不调用 key reveal）。
 * 文件：`~/.thcli/{profile}.tokenhub.json`
 */
export function readThProfileCreds(
  profile = 'default',
  thDir?: string
): { apiKey: string; baseUrl?: string; site?: string; area?: string } | null {
  try {
    const dir = thDir || thHome();
    const f = path.join(dir, `${profile}.tokenhub.json`);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    // 结构可能是 { cn: { gz: { default: "sk-..." } } } 或扁平 aliases
    const found = findSkInTokenhubJson(j);
    if (!found) return null;
    return found;
  } catch {
    return null;
  }
}

function findSkInTokenhubJson(j: any): { apiKey: string; baseUrl?: string; site?: string; area?: string } | null {
  if (!j || typeof j !== 'object') return null;
  // 常见：{ aliases: { default: "sk-..." } } 或 chat-config 导出
  if (typeof j.default === 'string' && j.default.startsWith('sk-')) {
    return { apiKey: j.default.trim(), site: j.site, area: j.area, baseUrl: inferTokenhubBaseUrl(j.site, j.area) };
  }
  if (typeof j.value === 'string' && j.value.startsWith('sk-')) {
    return { apiKey: j.value.trim(), site: j.site, area: j.area, baseUrl: inferTokenhubBaseUrl(j.site, j.area) };
  }
  for (const [site, block] of Object.entries(j)) {
    if (!block || typeof block !== 'object') continue;
    for (const [area, inner] of Object.entries(block as any)) {
      if (typeof inner === 'string' && inner.startsWith('sk-')) {
        return { apiKey: inner.trim(), site, area, baseUrl: inferTokenhubBaseUrl(site, area) };
      }
      if (inner && typeof inner === 'object') {
        for (const v of Object.values(inner as any)) {
          if (typeof v === 'string' && v.startsWith('sk-')) {
            return { apiKey: v.trim(), site, area, baseUrl: inferTokenhubBaseUrl(site, area) };
          }
        }
      }
    }
  }
  // 深搜任意 sk-
  const stack = [j];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const v of Object.values(cur)) {
      if (typeof v === 'string' && /^sk-[A-Za-z0-9]/.test(v)) {
        return { apiKey: v.trim() };
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

/** 对话服务地址随站点/地域变化（文档约定） */
export function inferTokenhubBaseUrl(site?: string, area?: string): string {
  const intlArea = area === 'sg' || area === 'singapore' || /intl|singapore/i.test(String(area || ''));
  const intlSite = site === 'intl';
  if (intlSite) {
    return intlArea
      ? 'https://tokenhub-intl.tencentcloudmaas.com'
      : 'https://tokenhub.tencentcloudmaas.com';
  }
  return intlArea ? 'https://tokenhub-intl.tencentmaas.com' : 'https://tokenhub.tencentmaas.com';
}

// ==================== 模型 / 价目 ====================

const TYPE_TO_MODALITY: Record<string, ModelModality> = {
  Text: '文本',
  Vision: '图片',
  Multimodal: '全模态',
  Speech: '语音',
  Embedding: '向量',
  Audio: '语音',
};

function modalityFromTokenhub(raw: any): ModelModality {
  const t = String(raw?.ModelType || raw?.Type || raw?.ModelCategory || '');
  if (TYPE_TO_MODALITY[t]) return TYPE_TO_MODALITY[t];
  const tags: string[] = [];
  if (Array.isArray(raw?.Tags)) tags.push(...raw.Tags.map(String));
  if (Array.isArray(raw?.ModelTags)) tags.push(...raw.ModelTags.map(String));
  const fromCaps = modalityOfCaps(tags);
  if (fromCaps !== '其他') return fromCaps;
  if (/vision|image|看图/i.test(tags.join(','))) return '图片';
  if (/speech|audio|语音|tts|asr/i.test(tags.join(','))) return '语音';
  if (/embed|向量/i.test(tags.join(','))) return '向量';
  if (/video|视频/i.test(tags.join(','))) return '视频';
  return '文本';
}

function guessUnit(model: string, total?: number | null): string | null {
  if (/tts|asr|speech|audio|语音/i.test(model)) return total != null && total < 1e5 ? '秒' : '字符';
  if (/image|图片|vision/i.test(model)) return '张';
  return 'Token';
}

/** 把 TokenHub ModelChargingInfo 转成通用 PriceEntry 列表 */
export function tokenhubPricesFromModel(raw: any) {
  const flat: any[] = [];
  for (const block of raw?.ModelChargingInfo || []) {
    for (const item of block?.ChargingItems || []) {
      const name = String(item.DisplayName || item.PriceName || item.Name || '');
      let type = String(item.PriceName || item.BillingItem || item.Type || 'price');
      // 便于 summarizePrices 认出入/出
      if (/^输入$|input/i.test(name) && !/cache|缓存/i.test(name)) type = 'input_token';
      if (/^输出$|output/i.test(name) && !/cache|缓存/i.test(name)) type = 'output_token';
      flat.push({
        priceName: name,
        type,
        price: item.Price != null ? String(item.Price) : '',
        priceUnit: item.PriceUnit || item.Unit || '',
      });
    }
  }
  // 个别模型可能扁平挂价
  if (!flat.length && (raw?.InputPrice != null || raw?.inputPrice != null)) {
    flat.push({
      priceName: '输入',
      type: 'input_token',
      price: String(raw.InputPrice ?? raw.inputPrice),
      priceUnit: '每百万tokens',
    });
  }
  return normalizePriceEntries(flat);
}

export function tokenhubModelToCatalog(raw: any): CatalogModel | null {
  const id = String(raw?.ModelId || raw?.model || raw?.id || '').trim();
  if (!id) return null;
  const prices = tokenhubPricesFromModel(raw);
  const price = summarizePrices(prices);
  const nums = prices.map((p) => Number(p.price)).filter((n) => Number.isFinite(n));
  const free = prices.length > 0 && nums.length > 0 && nums.every((n) => n === 0);
  const status = raw?.Status != null ? String(raw.Status) : undefined;
  const freeTrial = !!(raw?.FreeTrialInfo && typeof raw.FreeTrialInfo === 'object');
  return {
    id,
    name: raw?.ModelName != null ? String(raw.ModelName) : raw?.DisplayName != null ? String(raw.DisplayName) : undefined,
    capabilities: Array.isArray(raw?.Tags) ? raw.Tags.map(String) : undefined,
    modality: modalityFromTokenhub(raw),
    prices,
    price: price || (prices.length ? '按量' : ''),
    free,
    provider: 'tencent',
    publishedAt: dateOnly(raw?.ReleaseAt || raw?.PublishedAt),
    status,
    offlineAt: dateOnly(raw?.OfflineAt),
    discontinuedAt: dateOnly(raw?.DiscontinuedAt),
    freeTrial,
  };
}

export function tokenhubModelToInfo(raw: any): ThModelInfo {
  const cat = tokenhubModelToCatalog(raw);
  return {
    id: cat?.id || String(raw?.ModelId || ''),
    name: cat?.name,
    capabilities: cat?.capabilities,
    modality: cat?.modality || '其他',
    prices: cat?.prices?.length ? cat.prices : undefined,
    price: cat?.price || undefined,
    free: !!cat?.free,
    publishedAt: cat?.publishedAt,
    status: cat?.status,
    offlineAt: cat?.offlineAt,
    discontinuedAt: cat?.discontinuedAt,
    freeTrial: cat?.freeTrial,
  };
}

/** 分页拉全量模型（需已登录） */
export async function fetchTokenHubModels(
  profile?: string,
  opts: { limit?: number } = {}
): Promise<{ models: ThModelInfo[]; total: number; raw: any[] }> {
  const pageSize = Math.min(opts.limit || 100, 100);
  const models: ThModelInfo[] = [];
  const rawAll: any[] = [];
  let total = 0;
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const args = ['models', 'list', '--limit', String(pageSize), '--offset', String(offset)];
    if (profile) args.push('--profile', profile);
    const j = await execThcliJson<any>(args, 90000);
    const rows: any[] = j?.ModelSet || j?.Items || j?.models || (Array.isArray(j) ? j : []);
    total = Number(j?.TotalCount ?? j?.total ?? total);
    for (const r of rows) {
      rawAll.push(r);
      models.push(tokenhubModelToInfo(r));
    }
    if (rows.length === 0 || models.length >= (total || Infinity) || rows.length < pageSize) break;
  }
  return { models, total: total || models.length, raw: rawAll };
}

export async function fetchTokenHubCatalog(profile?: string): Promise<{
  models: CatalogModel[];
  total: number;
  source: string;
}> {
  const { raw, total } = await fetchTokenHubModels(profile);
  const models: CatalogModel[] = [];
  for (const r of raw) {
    const m = tokenhubModelToCatalog(r);
    if (m) models.push(m);
  }
  // 无登录时 fetch 会抛；有数据但无价也照样返回
  if (!models.length && raw.length) {
    for (const r of raw) {
      const fallback = catalogModelFromRaw({
        model: r.ModelId,
        name: r.ModelName,
        prices: tokenhubPricesFromModel(r),
        capabilities: r.Tags,
      });
      if (fallback) models.push(fallback);
    }
  }
  return { models, total: total || models.length, source: 'tokenhub-cli' };
}

// ==================== 额度（plan / endpoint FreeQuota） ====================

/**
 * 将 TokenHub plan / endpoint 结构尽量映射为 FreeQuota。
 * 未登录或结构不符时返回 []（由上层标 stale / 空态）。
 */
export function mapTokenHubQuotasFromPlanList(planJson: any): ThFreeQuota[] {
  const out: ThFreeQuota[] = [];
  const rows: any[] = planJson?.TokenPlanSet || planJson?.Items || planJson?.Plans || (Array.isArray(planJson) ? planJson : []);
  for (const row of rows) {
    const pkg = row?.PackageInfo || row?.Quota || row;
    const total = numOrNull(pkg?.TotalQuota ?? pkg?.TotalCredits ?? row?.TotalQuota);
    const used = numOrNull(pkg?.TotalUsed ?? row?.TotalUsed ?? pkg?.UsedQuota);
    const remaining = total != null && used != null ? Math.max(0, total - used) : numOrNull(pkg?.RemainQuota);
    const expiresRaw = pkg?.ExpireTime || pkg?.ExpiresAt || row?.ExpireTime || null;
    const expires = expiresRaw ? String(expiresRaw).slice(0, 10) : null;
    const expiresAt = expiresRaw ? Date.parse(String(expiresRaw)) : null;
    const model =
      String(row?.ModelName || row?.ModelId || row?.PlanName || row?.Name || row?.TokenPlanId || 'token-plan').trim() ||
      'token-plan';
    const remainingPercent =
      total && total > 0 && remaining != null ? Math.round((remaining / total) * 1000) / 10 : null;
    const usagePercent =
      total && total > 0 && used != null ? Math.round((used / total) * 1000) / 10 : null;
    const q: ThFreeQuota = {
      model,
      type: String(row?.ModelType || row?.Type || 'Text'),
      remaining,
      total,
      usagePercent,
      remainingPercent,
      expires,
      expiresAt: Number.isFinite(expiresAt as number) ? (expiresAt as number) : null,
      unit: guessUnit(model, total) || (pkg?.TotalCredits != null ? 'credit' : 'Token'),
      autoStop: null,
      postpaid: null, // 套餐行无接入点级 PaymentEnabled；开关在 endpoint 行
      reset: expires
        ? {
            kind: 'one-off',
            text: '到期作废',
            note: 'TokenHub 套餐到期日；规则以控制台为准。',
          }
        : {
            kind: 'unknown',
            text: '—',
            note: '接口未提供明确到期日。',
          },
    };
    if (Number(pkg?.CycleQuota || pkg?.CycleCredits || 0) > 0) {
      q.reset = {
        kind: 'monthly',
        text: '周期额度',
        note: `TokenHub 套餐周期额度（CycleUnit=${pkg?.CycleUnit || '—'}）。`,
      };
    }
    out.push(q);
  }
  return out;
}

/** 从 endpoint 行取出 FreeQuota 对象（直出 / JSON 字符串 / 嵌在 ChargeDetail 里） */
function freeQuotaFromEndpointRow(row: any): any | null {
  let fq: any = row?.FreeQuota ?? row?.freeQuota ?? null;
  if (typeof fq === 'string') {
    try {
      fq = JSON.parse(fq);
    } catch {
      fq = null;
    }
  }
  if (fq && typeof fq === 'object') return fq;

  let detail: any = row?.ChargeDetail ?? row?.chargeDetail ?? null;
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail);
    } catch {
      detail = null;
    }
  }
  if (!detail || typeof detail !== 'object') return null;
  fq = detail.FreeQuota ?? detail.freeQuota ?? null;
  if (typeof fq === 'string') {
    try {
      fq = JSON.parse(fq);
    } catch {
      fq = null;
    }
  }
  return fq && typeof fq === 'object' ? fq : null;
}

/**
 * endpoint 列表 → 额度行。
 * PaymentEnabled = 控制台「启用按 Token 计费」；写入 postpaid 供 UI 开关。
 * 现行 thcli 返回 ModelEndpointSet，额度在 ChargeDetail.FreeQuota（JSON 字符串）。
 */
export function mapTokenHubQuotasFromEndpoints(epJson: any): ThFreeQuota[] {
  const out: ThFreeQuota[] = [];
  const rows: any[] =
    epJson?.ModelEndpointSet ||
    epJson?.EndpointSet ||
    epJson?.Items ||
    (Array.isArray(epJson) ? epJson : []);
  for (const row of rows) {
    const fq = freeQuotaFromEndpointRow(row);
    const endpointId = String(row?.EndpointId || row?.Id || '').trim();
    const postpaid =
      row?.PaymentEnabled === true || row?.PaymentEnabled === 'on' || row?.paymentEnabled === true
        ? true
        : row?.PaymentEnabled === false || row?.PaymentEnabled === 'off' || row?.paymentEnabled === false
          ? false
          : null;

    const total = fq ? numOrNull(fq.Total ?? fq.total ?? fq.TotalQuota) : null;
    const used = fq ? numOrNull(fq.Used ?? fq.used ?? fq.UsedQuota ?? fq.TotalUsed) : null;
    const remaining =
      (fq ? numOrNull(fq.Remain ?? fq.remaining ?? fq.RemainQuota) : null) ??
      (total != null && used != null ? Math.max(0, total - used) : null);

    // 未领免费额的 VIRTUAL 接入点不要灌进「免费额度」列表；保留：有额度数字 / 已开后付费
    if (total == null && remaining == null && postpaid !== true) continue;

    const expiresRaw = fq?.ExpireTime || fq?.ExpiresAt || fq?.expireTime || null;
    const expires = expiresRaw ? String(expiresRaw).slice(0, 10) : null;
    const expiresAt = expiresRaw ? Date.parse(String(expiresRaw)) : null;
    const model = String(
      row?.ModelId || row?.ModelName || row?.EndpointName || endpointId || 'endpoint'
    );
    const remainingPercent =
      total && total > 0 && remaining != null ? Math.round((remaining / total) * 1000) / 10 : null;
    const usageFromApi = fq ? numOrNull(fq.UsagePercent ?? fq.usagePercent) : null;
    out.push({
      model,
      type: String(row?.ServiceType || row?.ModelType || 'Text'),
      remaining,
      total,
      usagePercent:
        usageFromApi ??
        (total && total > 0 && used != null ? Math.round((used / total) * 1000) / 10 : null),
      remainingPercent,
      expires,
      expiresAt: Number.isFinite(expiresAt as number) ? (expiresAt as number) : null,
      unit: guessUnit(model, total),
      // 语义对照：关「按 Token 计费」≈ 免费额用尽即停（接近百炼用完即停开）
      autoStop: postpaid === null ? null : !postpaid,
      postpaid,
      endpointId: endpointId || undefined,
      reset: expires
        ? {
            kind: 'one-off',
            text: '到期作废',
            note: '来自 TokenHub endpoint ChargeDetail.FreeQuota；「按 Token 计费」= PaymentEnabled。',
          }
        : {
            kind: 'unknown',
            text: '接入点免费额',
            note: '来自 TokenHub endpoint；「按 Token 计费」= PaymentEnabled。',
          },
    });
  }
  return out;
}

function numOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 拉取额度：优先 endpoint（含按 Token 计费开关），再补 plan；同 model 以 endpoint 为准。
 */
export async function fetchTokenHubQuotas(profile?: string): Promise<ThFreeQuota[]> {
  const argsEp = ['endpoint', 'list', '--limit', '100'];
  if (profile) argsEp.push('--profile', profile);
  let fromEp: ThFreeQuota[] = [];
  try {
    const j = await execThcliJson<any>(argsEp, 90000);
    fromEp = mapTokenHubQuotasFromEndpoints(j);
  } catch {
    fromEp = [];
  }

  const argsPlan = ['plan', 'list', '--limit', '100'];
  if (profile) argsPlan.push('--profile', profile);
  let fromPlan: ThFreeQuota[] = [];
  try {
    const j = await execThcliJson<any>(argsPlan, 90000);
    fromPlan = mapTokenHubQuotasFromPlanList(j);
  } catch {
    fromPlan = [];
  }

  const seen = new Set<string>();
  const out: ThFreeQuota[] = [];
  for (const q of [...fromEp, ...fromPlan]) {
    const k = q.endpointId || q.model;
    if (seen.has(k) || seen.has(q.model)) continue;
    seen.add(k);
    seen.add(q.model);
    out.push(q);
  }
  return out;
}

/**
 * 开/关「启用按 Token 计费」→ `thcli endpoint postpaid on|off`。
 * on=继续按量；off=免费额用尽即停服务。
 */
export async function setTokenHubPostpaid(
  on: boolean,
  opts: { endpointId?: string; all?: boolean; profile?: string } = {}
): Promise<string> {
  const args = ['endpoint', 'postpaid', on ? 'on' : 'off', '--yes'];
  if (opts.all) args.push('--all');
  else if (opts.endpointId) args.push('--endpoint', opts.endpointId);
  else throw new Error('缺少 endpointId，或指定 all:true');
  if (opts.profile) args.push('--profile', opts.profile);
  const { code, stdout, stderr } = await runThcli(args, 120000);
  const text = cleanText(stdout) || cleanText(stderr);
  if (code !== 0) throw new Error(text || `thcli endpoint postpaid 退出码 ${code}`);
  return text || (on ? '已开启按 Token 计费' : '已关闭按 Token 计费');
}

/**
 * 领取模型免费额度 → `thcli models free <ids|all>`。
 * 不代开浏览器；需已登录对应 profile。
 */
export async function claimTokenHubFree(
  models: string[] | 'all',
  opts: { profile?: string; dryRun?: boolean } = {}
): Promise<string> {
  const target =
    models === 'all'
      ? 'all'
      : Array.isArray(models)
        ? models.map((m) => String(m || '').trim()).filter(Boolean).join(',')
        : '';
  if (!target) throw new Error('缺少模型 ID，或指定 all');
  const args = ['models', 'free', target, '--yes'];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.profile) args.push('--profile', opts.profile);
  const { code, stdout, stderr } = await runThcli(args, 180000);
  const text = cleanText(stdout) || cleanText(stderr);
  if (code !== 0) throw new Error(text || `thcli models free 退出码 ${code}`);
  return text || (models === 'all' ? '已领取全部可领免费额度' : `已领取：${target}`);
}

// ==================== Handler 用：探测 ====================

const TOKENHUB_COMPAT = 'https://tokenhub.tencentmaas.com';

export async function probeTokenHubModel(creds: ThCreds, modelId: string): Promise<ThProbeResult> {
  const ts = new Date().toISOString();
  const apiKey = creds.apiKey;
  if (!apiKey) return { modelId, status: 'unknown', message: '缺少 API Key', ts };
  const base = creds.baseUrl || TOKENHUB_COMPAT;
  try {
    const res = await fetch(`${String(base).replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (res.status === 200) return { modelId, status: 'available', httpStatus: 200, ts };
    if (res.status === 429) return { modelId, status: 'limited', httpStatus: 429, message: '已达限额', ts };
    return {
      modelId,
      status: 'unavailable',
      httpStatus: res.status,
      message: text.replace(/\s+/g, ' ').slice(0, 160),
      ts,
    };
  } catch (e) {
    return { modelId, status: 'unknown', message: (e as Error).message.slice(0, 120), ts };
  }
}
