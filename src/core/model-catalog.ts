/**
 * 模型价目目录（与账号无关）
 *
 * 设计目标：
 *   1. 结构化价格（输入/输出/缓存/按秒/按张/480P…），供清单列摘要 + 悬停详情；
 *   2. 定期拉取并 diff：上下架 + 改价，不能只缓存一次；
 *   3. 按厂商拆 CatalogSource —— 百炼 / TokenHub / Ark CLI 均已接入。
 *
 * 数据源约定：目录价是标价参考；促销以各控制台为准。
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { t } from '../shared/i18n';
import { cliAvailable, cliLaunch } from './cli-bin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type ModelModality = '文本' | '图片' | '视频' | '语音' | '向量' | '全模态' | '实时' | '推理' | '其他';

/** 归一化后的单条价目（厂商无关） */
export type PriceEntry = {
  /** 展示名，如「输入」「视频生成（480P）」 */
  name: string;
  /** 原始 type，如 input_token / video_ratio_720p */
  type: string;
  /** 单价字符串，保留官方精度 */
  price: string;
  /** 单位原文，如「每百万tokens」「每秒」 */
  unit: string;
  /** 折扣系数（如 0.5 = 5 折）；无则表示标准价 */
  discount?: number;
  timeBand?: string;
};

export type CatalogModel = {
  id: string;
  name?: string;
  capabilities?: string[];
  modality: ModelModality;
  prices: PriceEntry[];
  /** 列上摘要，如「入 0.8 / 出 2 · 百万tokens」 */
  price: string;
  free: boolean;
  provider?: string;
  /** 发布/上线时间（TokenHub: ReleaseAt） */
  publishedAt?: string;
  /** 生命周期：online | pre-offline | discontinued …（TokenHub Status） */
  status?: string;
  /** 计划下线时间（TokenHub: OfflineAt） */
  offlineAt?: string;
  /** 停售时间（TokenHub: DiscontinuedAt） */
  discontinuedAt?: string;
  /** 是否声明有可领免费试用（TokenHub FreeTrialInfo） */
  freeTrial?: boolean;
};

export type PriceChange = {
  id: string;
  name?: string;
  before: string;
  after: string;
};

export type CatalogDiff = {
  added: string[];
  removed: string[];
  priceChanged: PriceChange[];
};

export type CatalogChangeEvent = CatalogDiff & { ts: string };

export type ProviderCatalog = {
  /** 适配器 id：aliyun / tencent / volcengine */
  provider: string;
  /** 数据来源标记，如 bailian-cli */
  source: string;
  ts: string;
  models: CatalogModel[];
  total: number;
  lastDiff?: CatalogDiff;
  /** 最近若干次变更（监控用） */
  history?: CatalogChangeEvent[];
  error?: string;
};

export interface CatalogSource {
  id: string;
  label: string;
  /** 拉全局价目；失败抛错（由上层标 error / 保留旧缓存） */
  fetchCatalog(): Promise<{ models: CatalogModel[]; total: number; source: string } | null>;
}

// ==================== 价格归一化 / 摘要 / 指纹 ====================

const CAP_TO_MODALITY: Record<string, ModelModality> = {
  TG: '文本',
  Reasoning: '推理',
  VU: '全模态',
  IG: '图片',
  VG: '视频',
  TTS: '语音',
  ASR: '语音',
  Embedding: '向量',
  Rerank: '向量',
};

export function modalityOfCaps(caps: string[] = []): ModelModality {
  for (const c of caps) {
    if (CAP_TO_MODALITY[c]) return CAP_TO_MODALITY[c];
  }
  return '其他';
}

/** 从 CLI / DashScope 等原始价目抽成 PriceEntry，并去重（官方常重复同档） */
export function normalizePriceEntries(raw: any): PriceEntry[] {
  const flat: any[] = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    // DashScope：{ prices: [ { price, ... } ] }
    if (Array.isArray(p.prices)) {
      for (const x of p.prices) flat.push({ ...p, ...x, prices: undefined });
    } else {
      flat.push(p);
    }
  }
  const seen = new Set<string>();
  const out: PriceEntry[] = [];
  for (const p of flat) {
    const price = p.price == null || p.price === '' ? '' : String(p.price);
    if (price === '' && !p.priceName && !p.type) continue;
    const entry: PriceEntry = {
      name: String(p.priceName || p.name || p.type || ''),
      type: String(p.type || p.ntmAmountType || ''),
      price,
      unit: String(p.priceUnit || p.unit || ''),
      discount: p.discount != null && p.discount !== '' ? Number(p.discount) : undefined,
      timeBand: p.timeBand != null ? String(p.timeBand) : undefined,
    };
    if (entry.discount != null && !Number.isFinite(entry.discount)) delete entry.discount;
    const key = [entry.type, entry.price, entry.unit, entry.discount ?? '', entry.name].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** 价目单位按语言展示（原值是厂商给的中文单位） */
function shortUnit(unit: string): string {
  return unitLabel(unit);
}

export function unitLabel(unit: string): string {
  const u = String(unit || '');
  if (/百万\s*tokens?/i.test(u)) return t('price.unit.million');
  if (/千\s*tokens?/i.test(u)) return t('price.unit.thousand');
  if (/万字符/.test(u)) return t('price.unit.tenKChars');
  if (/每秒|\/秒/.test(u) || u === '秒') return t('price.unit.second');
  if (/每张|\/张/.test(u) || u === '张') return t('price.unit.image');
  return u.replace(/^每/, '') || u;
}

function isStandard(p: PriceEntry): boolean {
  return p.discount == null;
}

function findType(prices: PriceEntry[], type: string): PriceEntry | undefined {
  return prices.find((p) => p.type === type && isStandard(p)) || prices.find((p) => p.type === type);
}

/**
 * 列上摘要：优先「入/出」；视频按分辨率；图片按张；否则取前几条价目名。
 */
export function summarizePrices(prices: PriceEntry[]): string {
  if (!prices.length) return '';
  const nums = prices.map((p) => Number(p.price)).filter((n) => Number.isFinite(n));
  if (nums.length > 0 && nums.every((n) => n === 0)) return t('price.free');

  const input = findType(prices, 'input_token');
  const output = findType(prices, 'output_token');
  if (input && output) {
    return `${t('price.in')} ${input.price} / ${t('price.out')} ${output.price} · ${shortUnit(input.unit || output.unit)}`;
  }

  const video = prices.filter((p) => /^video_ratio_/i.test(p.type) && isStandard(p));
  if (video.length) {
    const sorted = [...video].sort((a, b) => Number(a.price) - Number(b.price));
    const cheap = sorted[0];
    let tag = String(cheap.name || '');
    tag = tag.replace(/^视频生成[（(]?/, '').replace(/[）)]$/, '');
    if (!tag) tag = cheap.type.replace(/^video_ratio_/i, '').toUpperCase();
    return `${tag} ${t('price.startFrom', { p: cheap.price, u: shortUnit(cheap.unit) })}`;
  }

  const perImage = prices.filter((p) => /每张/.test(p.unit) && isStandard(p));
  if (perImage.length) {
    const sorted = [...perImage].sort((a, b) => Number(a.price) - Number(b.price));
    const cheap = sorted[0];
    return `${cheap.name || t('price.unit.image')} ${t('price.startFrom', { p: cheap.price, u: t('price.unit.image') })}`;
  }

  const perSec = prices.filter((p) => /每秒/.test(p.unit) && isStandard(p));
  if (perSec.length) {
    const sorted = [...perSec].sort((a, b) => Number(a.price) - Number(b.price));
    const cheap = sorted[0];
    return `${cheap.name || t('price.unit.second')} ${t('price.startFrom', { p: cheap.price, u: t('price.unit.second') })}`;
  }

  const std = prices.filter(isStandard);
  const pick = (std.length ? std : prices).slice(0, 2);
  return pick.map((p) => `${p.name || p.type} ${p.price}${p.unit ? '/' + shortUnit(p.unit) : ''}`).join(' · ');
}

/** 改价比对用指纹：忽略展示名细微差别，按 type+unit+price+discount */
export function priceFingerprint(prices: PriceEntry[]): string {
  return [...prices]
    .map((p) => `${p.type}|${p.unit}|${p.price}|${p.discount ?? ''}`)
    .sort()
    .join(';');
}

export function catalogModelFromRaw(raw: any): CatalogModel | null {
  const id = String(raw?.model || raw?.id || '').trim();
  if (!id) return null;
  const caps: string[] = Array.isArray(raw?.capabilities) ? raw.capabilities.map(String) : [];
  const prices = normalizePriceEntries(raw?.prices);
  const price = summarizePrices(prices);
  const nums = prices.map((p) => Number(p.price)).filter((n) => Number.isFinite(n));
  const free = prices.length > 0 && nums.length > 0 && nums.every((n) => n === 0);
  return {
    id,
    name: raw?.name != null ? String(raw.name) : undefined,
    capabilities: caps,
    modality: modalityOfCaps(caps),
    prices,
    price: price || (prices.length ? '按量' : ''),
    free,
    provider: raw?.provider != null ? String(raw.provider) : undefined,
  };
}

export function diffCatalog(prev: CatalogModel[] | null | undefined, next: CatalogModel[]): CatalogDiff {
  const prevMap = new Map((prev || []).map((m) => [m.id, m]));
  const nextMap = new Map(next.map((m) => [m.id, m]));
  const added = [...nextMap.keys()].filter((id) => !prevMap.has(id));
  const removed = [...prevMap.keys()].filter((id) => !nextMap.has(id));
  const priceChanged: PriceChange[] = [];
  for (const [id, n] of nextMap) {
    const p = prevMap.get(id);
    if (!p) continue;
    if (priceFingerprint(p.prices || []) === priceFingerprint(n.prices || [])) continue;
    priceChanged.push({
      id,
      name: n.name || p.name,
      before: p.price || '—',
      after: n.price || '—',
    });
  }
  return {
    added: added.slice(0, 100),
    removed: removed.slice(0, 100),
    priceChanged: priceChanged.slice(0, 100),
  };
}

/**
 * 把目录价挂到账号模型清单上。
 * 匹配：精确 id → 最长前缀家族（qwen-plus-2025-07-14 ← qwen-plus）。
 */
export function lookupCatalogModel(catalog: CatalogModel[], modelId: string): CatalogModel | undefined {
  if (!modelId || !catalog.length) return undefined;
  const map = new Map(catalog.map((m) => [m.id, m]));
  if (map.has(modelId)) return map.get(modelId);
  let best: CatalogModel | undefined;
  let bestLen = -1;
  for (const m of catalog) {
    const id = m.id;
    if (!id) continue;
    if (modelId.startsWith(id + '-') || modelId.startsWith(id + '_') || modelId.startsWith(id + '.')) {
      if (id.length > bestLen) {
        best = m;
        bestLen = id.length;
      }
    }
  }
  return best;
}

export function applyCatalogPrices<
  T extends {
    id: string;
    price?: string;
    prices?: PriceEntry[];
    free?: boolean;
    publishedAt?: string;
    status?: string;
    offlineAt?: string;
    discontinuedAt?: string;
    freeTrial?: boolean;
  }
>(models: T[], catalog: CatalogModel[] | null | undefined): T[] {
  if (!catalog?.length) return models;
  return models.map((m) => {
    const hit = lookupCatalogModel(catalog, m.id);
    if (!hit) return m;
    return {
      ...m,
      ...(hit.prices?.length
        ? { prices: hit.prices, price: hit.price || m.price, free: hit.free }
        : {}),
      publishedAt: m.publishedAt || hit.publishedAt,
      status: m.status || hit.status,
      offlineAt: m.offlineAt || hit.offlineAt,
      discontinuedAt: m.discontinuedAt || hit.discontinuedAt,
      freeTrial: m.freeTrial ?? hit.freeTrial,
    };
  });
}

// ==================== 百炼 CLI 目录 ====================

function runBl(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const l = cliLaunch('bl');
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

async function execBlJson<T>(args: string[], timeoutMs = 120000): Promise<T> {
  const { stdout, stderr } = await runBl(args, timeoutMs);
  const a = stdout.indexOf('[');
  const o = stdout.indexOf('{');
  const idx = a >= 0 && (o < 0 || a < o) ? a : o;
  if (idx < 0) throw new Error((stderr || stdout || '百炼 CLI 无输出').trim().slice(0, 200));
  return JSON.parse(stdout.slice(idx)) as T;
}

/** 分页拉全量家族价目（No Auth；page-size 过大时 CLI 会空结果，固定 50） */
export async function fetchBailianCatalog(): Promise<{ models: CatalogModel[]; total: number; source: string }> {
  if (!cliAvailable('bl')) {
    throw new Error('未安装百炼 CLI（bailian-cli）');
  }
  const pageSize = 50;
  const models: CatalogModel[] = [];
  let total = 0;
  for (let page = 1; page <= 40; page++) {
    const j = await execBlJson<{ items?: any[]; total?: number }>(
      ['model', 'list', '--page', String(page), '--page-size', String(pageSize), '--output', 'json'],
      90000
    );
    total = Number(j?.total || 0);
    const rows = j?.items || [];
    for (const raw of rows) {
      const m = catalogModelFromRaw(raw);
      if (m) models.push(m);
    }
    if (rows.length === 0 || models.length >= total) break;
  }
  return { models, total: total || models.length, source: 'bailian-cli' };
}

const BailianCatalogSource: CatalogSource = {
  id: 'aliyun',
  label: '阿里云 · 百炼',
  async fetchCatalog() {
    return fetchBailianCatalog();
  },
};

/** 腾讯云 TokenHub：thcli models list（需本机已 auth login） */
const TencentCatalogSource: CatalogSource = {
  id: 'tencent',
  label: '腾讯云 · TokenHub',
  async fetchCatalog() {
    const { fetchTokenHubCatalog, thcliAvailable } = await import('./tokenhub-cli');
    const avail = thcliAvailable();
    if (!avail.ok) {
      throw new Error(avail.reason || 'TokenHub CLI 不可用');
    }
    return fetchTokenHubCatalog();
  },
};

/** 火山引擎 Ark：models list（上下架）+ pricing models（价目） */
const VolcengineCatalogSource: CatalogSource = {
  id: 'volcengine',
  label: '火山引擎 · 方舟',
  async fetchCatalog() {
    const { fetchArkCatalog, arkcliAvailable } = await import('./ark-cli');
    const avail = arkcliAvailable();
    if (!avail.ok) {
      throw new Error(avail.reason || 'Ark CLI 不可用');
    }
    return fetchArkCatalog();
  },
};

export const CATALOG_SOURCES: Record<string, CatalogSource> = {
  aliyun: BailianCatalogSource,
  tencent: TencentCatalogSource,
  volcengine: VolcengineCatalogSource,
};

export function getCatalogSource(provider: string): CatalogSource | null {
  return CATALOG_SOURCES[provider] || null;
}

export const CATALOG_HISTORY_LIMIT = 30;

/** 合并一次 diff 进历史；首次全量拉取不记入「新增」噪音 */
export function appendCatalogHistory(
  prev: ProviderCatalog | null,
  nextModels: CatalogModel[],
  meta: { provider: string; source: string; ts: string; error?: string }
): ProviderCatalog {
  const isFirst = !prev?.models?.length;
  const lastDiff = isFirst
    ? { added: [] as string[], removed: [] as string[], priceChanged: [] as PriceChange[] }
    : diffCatalog(prev!.models, nextModels);
  const event: CatalogChangeEvent | null =
    !isFirst && (lastDiff.added.length || lastDiff.removed.length || lastDiff.priceChanged.length)
      ? { ts: meta.ts, ...lastDiff }
      : null;
  const history = [...(prev?.history || [])];
  if (event) history.unshift(event);
  return {
    provider: meta.provider,
    source: meta.source,
    ts: meta.ts,
    models: nextModels,
    total: nextModels.length,
    lastDiff,
    history: history.slice(0, CATALOG_HISTORY_LIMIT),
    error: meta.error,
  };
}
