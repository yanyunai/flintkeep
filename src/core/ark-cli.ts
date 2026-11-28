/**
 * 火山引擎 Ark CLI（arkcli）封装 —— 对标百炼 / TokenHub。
 *
 * 依赖：项目内 `@volcengine/ark-cli` → `node_modules/.bin/arkcli`
 * 登录：用户本机 `arkcli auth login volc-sso`（程序不代开浏览器）
 * 额度：活动一「免费推理额度」→ `arkcli usage balance --type free-quota`
 * 价目/上下架：`arkcli models list` + `pricing models`（需已登录）
 */
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../shared/i18n';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { cliAvailable, cliDisplay, cliLaunch, quoteBin } from './cli-bin';
import {
  normalizePriceEntries,
  summarizePrices,
  modalityOfCaps,
  type CatalogModel,
  type ModelModality,
} from './model-catalog';

export type ArkFreeQuota = {
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
  reset?: { kind: string; text: string; note: string } | null;
};

export type ArkModelInfo = {
  id: string;
  name?: string;
  capabilities?: string[];
  modality: ModelModality;
  publishedAt?: string;
  price?: string;
  prices?: ReturnType<typeof normalizePriceEntries>;
  free: boolean;
  status?: string;
};

export type ArkProbeResult = {
  modelId: string;
  status: 'available' | 'limited' | 'unknown' | 'unavailable';
  httpStatus?: number;
  message?: string;
  ts: string;
};

export type ArkCreds = {
  accessKeyId?: string;
  accessKeySecret?: string;
  apiKey?: string;
  baseUrl?: string;
};

export type ArkcliIdentity = {
  loggedIn: boolean;
  profile: string;
  region?: string;
  project?: string;
  authMethod?: string;
  apiKey?: string;
  baseUrl?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arkHome(): string {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.arkcli');
}

export function arkBin(): string {
  return cliDisplay('ark');
}

export function arkBinPath(): string {
  return quoteBin(arkBin());
}

export function arkcliAvailable(): { ok: boolean; reason?: string } {
  if (!cliAvailable('ark')) {
    return { ok: false, reason: '未安装 Ark CLI（@volcengine/ark-cli）' };
  }
  return { ok: true };
}

export function arkcliHasConfigDir(): boolean {
  try {
    return fs.existsSync(arkHome());
  } catch {
    return false;
  }
}

function runArkcli(
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const l = cliLaunch('ark');
  return new Promise((resolve, reject) => {
    const p = spawn(l.cmd, [...l.prefixArgs, ...args], {
      cwd: l.cwd,
      windowsHide: true,
      shell: l.shell,
      env: { ...process.env, ...l.env },
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
    .filter((l) => !/ExperimentalWarning|trace-warnings|DeprecationWarning/i.test(l))
    .join('\n')
    .trim();
}

export async function execArkcliJson<T>(args: string[], timeoutMs = 120000): Promise<T> {
  const withFmt =
    args.includes('--format') || args.includes('--json') ? args : [...args, '--format', 'json'];
  const { code, stdout, stderr } = await runArkcli(withFmt, timeoutMs);
  const text = cleanText(stdout);
  const a = text.indexOf('[');
  const o = text.indexOf('{');
  const idx = a >= 0 && (o < 0 || a < o) ? a : o;
  if (idx < 0) {
    const err = cleanText(stderr) || text || `arkcli 退出码 ${code}`;
    throw new Error(err.slice(0, 300));
  }
  try {
    return JSON.parse(text.slice(idx)) as T;
  } catch {
    throw new Error((cleanText(stderr) || text || 'arkcli JSON 解析失败').slice(0, 300));
  }
}

export function arkcliErrorText(e: unknown): string {
  const raw = String((e as any)?.message || e || '').trim();
  if (!raw) return 'Ark CLI 调用失败（未返回原因）';
  // Profile 不存在 ≠ 未登录（SSO 可能已成功，只是没 create profile）
  const miss = raw.match(/profile\s+['"]?([^'"\s]+)['"]?\s+not found/i);
  if (miss || /profile .* not found|run `arkcli profile (list|create)`/i.test(raw)) {
    const name = miss?.[1] || '该';
    return `Ark Profile「${name}」不存在 —— SSO 登录成功后还需执行：arkcli profile create --name ${name === '该' ? '<名>' : name} --type platform --set-default --no-interactive`;
  }
  if (/not configured|logged_in.: false|auth_method.: .none./i.test(raw)) {
    return 'Ark CLI 未登录 —— 请在终端执行项目内 `arkcli auth login volc-sso`（不要先带不存在的 --profile）。';
  }
  if (/未登录|请.*auth login|run `arkcli auth login/i.test(raw) && !/profile/i.test(raw)) {
    return 'Ark CLI 未登录 —— 请在终端执行项目内 `arkcli auth login volc-sso`。';
  }
  if (/expired|凭证失效|token.*invalid/i.test(raw)) {
    return 'Ark 凭证失效 —— 请重新执行 `arkcli auth login volc-sso`。';
  }
  if (/ETIMEDOUT|timed out/i.test(raw)) return 'Ark CLI 请求超时，稍后重试。';
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

function maskKey(key?: string): string | undefined {
  if (!key || key.length < 8) return undefined;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * 是否给命令加 --profile。
 * 空 / 「default」且实际没有该 profile 时，不传 flag（走当前 SSO 全局身份）。
 */
function withProfileArgs(args: string[], profile?: string): string[] {
  const p = String(profile || '').trim();
  if (!p || p === '__global__') return args;
  return [...args, '--profile', p];
}

/** auth status --format json；profile 缺失时自动回退到不带 --profile */
export async function arkcliAuthStatus(profile?: string): Promise<ArkcliIdentity> {
  const tryOnce = async (prof?: string) => {
    const args = withProfileArgs(['auth', 'status'], prof);
    return execArkcliJson<any>(args, 30000);
  };
  let s: any;
  try {
    s = await tryOnce(profile);
    // 指定了不存在的 profile 时，CLI 常返回 logged_in:false + hint，而不是抛错
    if (
      profile &&
      s?.logged_in !== true &&
      s?.loggedIn !== true &&
      (/profile/i.test(String(s?.hint || '')) || s?.auth_method === 'none')
    ) {
      s = await tryOnce(undefined);
    }
  } catch (e) {
    if (profile && /profile .* not found/i.test(String((e as Error).message || e))) {
      s = await tryOnce(undefined);
    } else {
      throw e;
    }
  }
  const active = s?.active_profile || s?.ActiveProfile || {};
  const name = String(active?.name || s?.profile || profile || 'default');
  const loggedIn = s?.logged_in === true || s?.loggedIn === true;
  const apiKeyRaw =
    s?.ark_api_key?.key ||
    s?.ark_api_key?.api_key ||
    s?.api_key ||
    s?.apiKey ||
    undefined;
  return {
    loggedIn,
    profile: name,
    region: active?.region != null ? String(active.region) : s?.region != null ? String(s.region) : undefined,
    project:
      active?.project != null
        ? String(active.project)
        : s?.project_name != null
          ? String(s.project_name)
          : undefined,
    authMethod: s?.auth_method != null ? String(s.auth_method) : undefined,
    apiKey: maskKey(typeof apiKeyRaw === 'string' ? apiKeyRaw : undefined),
    baseUrl: s?.base_url || s?.baseUrl || undefined,
  };
}

export async function listArkProfiles(): Promise<{ name: string; active: boolean }[]> {
  try {
    const j = await execArkcliJson<any>(['profile', 'list'], 30000);
    const rows: any[] = Array.isArray(j)
      ? j
      : j?.profiles || j?.Profiles || j?.items || j?.Items || [];
    const activeName = String(
      j?.default_profile || j?.default || j?.active || j?.current || j?.Current || ''
    );
    if (!rows.length) {
      // SSO 可能已登录但尚未 profile create —— 用空名表示「不带 --profile」
      const st = await arkcliAuthStatus(undefined).catch(() => null);
      if (st?.loggedIn) return [{ name: st.profile && st.profile !== 'default' ? st.profile : '__global__', active: true }];
      return [];
    }
    return rows.map((r) => {
      const name = String(r?.name || r?.Name || r?.id || r || 'default');
      const active =
        r?.active === true ||
        r?.is_default === true ||
        r?.IsDefault === true ||
        name === activeName;
      return { name, active };
    });
  } catch {
    const st = await arkcliAuthStatus(undefined).catch(() => null);
    if (st?.loggedIn) return [{ name: '__global__', active: true }];
    return [];
  }
}

export async function activeArkProfile(): Promise<string> {
  const ps = await listArkProfiles();
  const name = ps.find((p) => p.active)?.name || ps[0]?.name || '';
  // __global__ = 有 SSO 无 profile，调用时不要带 --profile
  return name === '__global__' ? '' : name;
}

export async function arkcliProfilesDetail(): Promise<
  { name: string; active: boolean; identity: ArkcliIdentity | null }[]
> {
  const ps = await listArkProfiles();
  return Promise.all(
    ps.map(async (p) => ({
      name: p.name,
      active: p.active,
      identity: await arkcliAuthStatus(p.name).catch(() => null),
    }))
  );
}

/**
 * 从 Ark models list / pricing 原始行推断模态。
 * 关键字段在 foundation_model_tag.{filter_domains,domains,customized_tags,task_types}。
 */
export function modalityFromArk(raw: any): ModelModality {
  const tags: string[] = [];
  const push = (v: unknown) => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) {
      for (const x of v) push(x);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      push(o.filter_domains);
      push(o.domains);
      push(o.customized_tags);
      push(o.filter_task_types);
      push(o.task_types);
      return;
    }
    tags.push(String(v));
  };
  push(raw?.foundation_model_tag);
  push(raw?.FoundationModelTag);
  push(raw?.Tags);
  push(raw?.tags);
  push(raw?.capabilities);
  push(raw?.FoundationModelDomain);
  push(raw?.modality);
  push(raw?.Modality);

  const hit = (re: RegExp) => tags.some((t) => re.test(t));
  // 更具体的优先（视频/图片/语音/向量），避免 Multimodal 一把梭
  if (hit(/VideoGeneration|text_to_video|image_to_video|multimodal_to_video|视频/i)) return '视频';
  if (hit(/ImageGeneration|text_to_image|image_to_image|3DGeneration|Seedream|图片|视觉生成/i)) return '图片';
  if (hit(/Speech|TTS|ASR|Voice|Audio|RealtimeSpeech|Simultaneous|语音|同声/i)) return '语音';
  if (hit(/Embedding|Vector|Rerank|向量/i)) return '向量';
  if (hit(/VLM|Multimodal|VisualQA|GUIAgent|视觉问答|全模态/i)) return '全模态';
  if (hit(/Thinking|Reasoning|推理/i) && hit(/Text|LLM|文本/i)) return '推理';
  if (hit(/Text|LLM|TextGeneration|文本/i)) return '文本';
  // 兼容百炼能力码
  const mapped = modalityOfCaps(tags);
  if (mapped !== '其他') return mapped;
  return '其他';
}

/** 展开 foundation_model_tag 等到 capabilities 展示串 */
export function capsFromArk(raw: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const tag = raw?.foundation_model_tag || raw?.FoundationModelTag;
  if (tag && typeof tag === 'object') {
    for (const x of tag.customized_tags || tag.filter_domains || tag.domains || []) add(String(x));
  }
  if (Array.isArray(raw?.tags)) for (const x of raw.tags) add(String(x));
  if (Array.isArray(raw?.Tags)) for (const x of raw.Tags) add(String(x));
  if (raw?.VendorName) add(String(raw.VendorName));
  if (raw?.vendor_name) add(String(raw.vendor_name));
  return out;
}

function chargeTypeToPriceType(t: string): string {
  const s = String(t || '');
  if (/InferencePrompt|Prompt|输入/i.test(s)) return 'input_token';
  if (/InferenceCompletion|Completion|输出/i.test(s)) return 'output_token';
  if (/ContextSessionHit|Cache|缓存/i.test(s)) return 'cache_token';
  return s || 'price';
}

/** pricing models 的 ChargeItems → PriceEntry */
export function arkPricesFromChargeItems(raw: any) {
  const items: any[] = raw?.ChargeItems || raw?.charge_items || raw?.prices || [];
  const flat: any[] = [];
  for (const item of items) {
    const type = String(item.Type || item.type || '');
    // 目录摘要只保留在线推理相关，避开批量/精调噪音
    if (/Batch|Finetune|Lora|Storage/i.test(type) && !/ContextSessionHit/i.test(type)) continue;
    if (!/InferencePrompt|InferenceCompletion|ContextSessionHit|Prompt|Completion/i.test(type)) {
      continue;
    }
    const price = item.Price != null ? String(item.Price) : item.price != null ? String(item.price) : '';
    if (price === '') continue;
    flat.push({
      priceName: type,
      type: chargeTypeToPriceType(type),
      price,
      priceUnit: item.UnitCode || item.unit || '千tokens',
    });
  }
  return normalizePriceEntries(flat);
}

export function arkPricingRowToCatalog(raw: any): CatalogModel | null {
  const id = String(
    raw?.FoundationModelName || raw?.foundation_model_name || raw?.name || raw?.model || raw?.id || ''
  ).trim();
  if (!id) return null;
  const prices = arkPricesFromChargeItems(raw);
  const price = summarizePrices(prices);
  const nums = prices.map((p) => Number(p.price)).filter((n) => Number.isFinite(n));
  const free = prices.length > 0 && nums.length > 0 && nums.every((n) => n === 0);
  const freeUsage = raw?.InferenceFreeUsage || raw?.inference_free_usage;
  const freeTrial =
    !!(freeUsage && (freeUsage.Total != null || freeUsage.total != null)) ||
    (Array.isArray(raw?.ResourcePackItems) &&
      raw.ResourcePackItems.some((x: any) => /FreeInference/i.test(String(x?.Type || ''))));
  return {
    id,
    name: raw?.DisplayName != null ? String(raw.DisplayName) : undefined,
    capabilities: capsFromArk(raw),
    modality: modalityFromArk(raw),
    prices,
    price: price || (prices.length ? '按量' : ''),
    free,
    provider: 'volcengine',
    status: raw?.State != null ? String(raw.State) : undefined,
    freeTrial: !!freeTrial,
  };
}

export function arkModelListItemToCatalog(raw: any): CatalogModel | null {
  const id = String(raw?.name || raw?.Name || raw?.id || raw?.model || '').trim();
  if (!id) return null;
  return {
    id,
    name: raw?.display_name != null ? String(raw.display_name) : raw?.DisplayName != null ? String(raw.DisplayName) : undefined,
    capabilities: capsFromArk(raw),
    modality: modalityFromArk(raw),
    prices: [],
    price: '',
    free: false,
    provider: 'volcengine',
    publishedAt: raw?.primary_version != null ? String(raw.primary_version) : undefined,
    status: raw?.access_type != null ? String(raw.access_type) : undefined,
  };
}

export function arkModelToInfo(raw: any): ArkModelInfo {
  const cat = arkPricingRowToCatalog(raw) || arkModelListItemToCatalog(raw);
  return {
    id: cat?.id || '',
    name: cat?.name,
    capabilities: cat?.capabilities,
    modality: cat?.modality || '其他',
    prices: cat?.prices?.length ? cat.prices : undefined,
    price: cat?.price || undefined,
    free: !!cat?.free,
    publishedAt: cat?.publishedAt,
    status: cat?.status,
  };
}

/** 公共模型目录（上新/下架监控主源） */
export async function fetchArkModels(
  profile?: string
): Promise<{ models: ArkModelInfo[]; total: number; raw: any[] }> {
  const args = withProfileArgs(['models', 'list', '--page-all', '--page-size', '50'], profile);
  const j = await execArkcliJson<any>(args, 180000);
  const rows: any[] = j?.items || j?.Items || j?.ModelSet || (Array.isArray(j) ? j : []);
  const models = rows.map(arkModelToInfo).filter((m) => m.id);
  return { models, total: Number(j?.total_count ?? j?.TotalCount ?? models.length), raw: rows };
}

/** 账号价目（含 ChargeItems；用于价格摘要） */
export async function fetchArkPricing(
  profile?: string
): Promise<{ models: CatalogModel[]; total: number; raw: any[] }> {
  const args = withProfileArgs(['pricing', 'models', '--page-all', '--page-size', '50'], profile);
  const j = await execArkcliJson<any>(args, 180000);
  const rows: any[] = j?.items || j?.Items || (Array.isArray(j) ? j : []);
  const models: CatalogModel[] = [];
  for (const r of rows) {
    const m = arkPricingRowToCatalog(r);
    if (m) models.push(m);
  }
  return { models, total: Number(j?.total_count ?? j?.TotalCount ?? models.length), raw: rows };
}

/**
 * 价目目录：先 models list（上下架），再 pricing 覆盖价格。
 * 需已登录；未登录由上层抛错。
 */
export async function fetchArkCatalog(profile?: string): Promise<{
  models: CatalogModel[];
  total: number;
  source: string;
}> {
  let listModels: CatalogModel[] = [];
  let listTotal = 0;
  try {
    const listed = await fetchArkModels(profile);
    listModels = listed.raw.map(arkModelListItemToCatalog).filter(Boolean) as CatalogModel[];
    listTotal = listed.total;
  } catch {
    listModels = [];
  }

  let priced: CatalogModel[] = [];
  try {
    const p = await fetchArkPricing(profile);
    priced = p.models;
  } catch {
    priced = [];
  }

  if (!listModels.length && !priced.length) {
    throw new Error('Ark CLI 未返回模型目录（请确认已 `arkcli auth login volc-sso`）');
  }

  const byId = new Map<string, CatalogModel>();
  for (const m of listModels) byId.set(m.id, m);
  for (const m of priced) {
    const prev = byId.get(m.id);
    if (!prev) {
      byId.set(m.id, m);
      continue;
    }
    byId.set(m.id, {
      ...prev,
      ...m,
      // list 侧 modality/capabilities 更准；pricing 常缺 tag
      modality: prev.modality !== '其他' ? prev.modality : m.modality,
      capabilities:
        prev.capabilities?.length && prev.capabilities[0] !== m.name
          ? prev.capabilities
          : m.capabilities?.length
            ? m.capabilities
            : prev.capabilities,
      prices: m.prices?.length ? m.prices : prev.prices,
      price: m.price || prev.price,
      free: m.free || prev.free,
      freeTrial: m.freeTrial ?? prev.freeTrial,
      status: m.status || prev.status,
    });
  }
  const models = [...byId.values()];
  return { models, total: Math.max(listTotal, models.length), source: 'ark-cli' };
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** usage balance --type free-quota → FreeQuota[]（活动一免费推理额度） */
export function mapArkFreeQuotasFromBalance(json: any): ArkFreeQuota[] {
  const rows: any[] = json?.items || json?.Items || (Array.isArray(json) ? json : []);
  const out: ArkFreeQuota[] = [];
  for (const row of rows) {
    const model = String(row?.model || row?.FoundationModelName || row?.name || '').trim();
    if (!model) continue;
    const fu = row?.free_usage || row?.InferenceFreeUsage || row?.freeUsage || {};
    let total = numOrNull(fu?.total ?? fu?.Total);
    let consumed = numOrNull(fu?.consumed ?? fu?.Consumed);
    let remaining = numOrNull(fu?.remaining ?? fu?.Remaining);
    // 若 free_usage 空，叠加 FreeInference 资源包
    const packs: any[] = row?.resource_packs || row?.ResourcePackItems || [];
    if ((total == null || remaining == null) && packs.length) {
      let t = 0;
      let c = 0;
      let has = false;
      for (const p of packs) {
        if (!/FreeInference/i.test(String(p?.type || p?.Type || ''))) continue;
        const pt = numOrNull(p?.total ?? p?.Total);
        const pc = numOrNull(p?.consumed ?? p?.Consumed);
        if (pt != null) {
          t += pt;
          has = true;
        }
        if (pc != null) c += pc;
      }
      if (has) {
        total = total ?? t;
        consumed = consumed ?? c;
        remaining = remaining ?? (total != null && consumed != null ? total - consumed : null);
      }
    }
    if (total == null && remaining == null && consumed == null) continue;
    if (remaining == null && total != null && consumed != null) remaining = total - consumed;
    const remainingPercent =
      total && total > 0 && remaining != null ? Math.round((remaining / total) * 1000) / 10 : null;
    const usagePercent =
      total && total > 0 && consumed != null ? Math.round((consumed / total) * 1000) / 10 : null;
    out.push({
      model,
      type: String(row?.modality || row?.FoundationModelDomain || 'Text'),
      remaining,
      total,
      usagePercent,
      remainingPercent,
      expires: null,
      expiresAt: null,
      unit: 'Token',
      autoStop: null, // 安心体验是账号级，非百炼式 per-model 开关
      reset: {
        kind: 'unknown',
        text: t('ark.reset.freeQuota'),
        note: t('ark.reset.freeQuotaNote'),
      },
    });
  }
  return out;
}

const ARK_FREE_QUOTA_MODALITIES = ['LLM', 'ComputerVision', 'Audio', 'Embedding', 'Router'] as const;

function modalityLabelForDomain(domain: string): string {
  if (domain === 'ComputerVision') return 'Vision';
  if (domain === 'Audio') return 'Voice';
  if (domain === 'Embedding') return 'Embedding';
  if (domain === 'Router') return 'Router';
  return 'Text';
}

export async function fetchArkFreeQuotas(profile?: string): Promise<ArkFreeQuota[]> {
  const run = (prof: string | undefined, modality?: string) => {
    const base = ['usage', 'balance', '--type', 'free-quota', '--page-all', '--page-size', '50'];
    if (modality) base.push('--modality', modality);
    return execArkcliJson<any>(withProfileArgs(base, prof), 180000);
  };

  const collect = async (prof?: string) => {
    const byModel = new Map<string, ArkFreeQuota>();
    // 不分模态先拉一页（兼容旧行为）
    try {
      for (const q of mapArkFreeQuotasFromBalance(await run(prof))) {
        byModel.set(q.model, q);
      }
    } catch (e) {
      if (prof && /profile .* not found/i.test(String((e as Error).message || e))) {
        return collect(undefined);
      }
      // 继续按模态拆拉
    }
    // 按 FoundationModelDomain 补齐视觉 / 向量等（默认合并结果常偏 LLM）
    for (const mod of ARK_FREE_QUOTA_MODALITIES) {
      try {
        const rows = mapArkFreeQuotasFromBalance(await run(prof, mod));
        for (const q of rows) {
          const typed = { ...q, type: q.type && q.type !== 'Text' ? q.type : modalityLabelForDomain(mod) };
          const prev = byModel.get(q.model);
          if (!prev) byModel.set(q.model, typed);
          else if ((prev.remaining ?? -1) < (typed.remaining ?? -1)) byModel.set(q.model, typed);
        }
      } catch {
        /* 某模态无权限/空结果时跳过 */
      }
    }
    return [...byModel.values()];
  };

  return collect(profile);
}

const ARK_COMPAT = 'https://ark.cn-beijing.volces.com/api/v3';

export async function probeArkModel(creds: ArkCreds, modelId: string): Promise<ArkProbeResult> {
  const ts = new Date().toISOString();
  const apiKey = creds.apiKey;
  if (!apiKey) return { modelId, status: 'unknown', message: '缺少 API Key', ts };
  const base = creds.baseUrl || ARK_COMPAT;
  try {
    const res = await fetch(`${String(base).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    await res.text();
    if (res.status === 200) return { modelId, status: 'available', httpStatus: 200, ts };
    if (res.status === 429) return { modelId, status: 'limited', httpStatus: 429, message: '已达限额', ts };
    return {
      modelId,
      status: 'unavailable',
      httpStatus: res.status,
      message: `HTTP ${res.status}`,
      ts,
    };
  } catch (e) {
    return { modelId, status: 'unknown', message: String((e as Error).message || e).slice(0, 120), ts };
  }
}
