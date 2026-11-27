/**
 * AI 模型用量 —— 适配器模式（学自 github.com/luw2007/llm-balance）
 *
 * 数据来源（均为账号级凭据，不依赖平台公开的"额度剩余"接口）：
 *   阿里云 · 余额       QueryAccountBalance        (BssOpenApi, business.aliyuncs.com)
 *   阿里云 · 消费流水   QueryAccountTransactions   (必须用 CreateTimeStart/End，BillingCycle 会漏数据)
 *   阿里云 · 资源包     QueryResourcePackageInstances
 *   阿里云 · 账单       QueryInstanceBill          (实例 ID 含模型名)
 *   百炼   · 模型清单   GET dashscope /api/v1/models (需 API Key)
 *   探测   · 可用性     实际调用模型发极小请求（学 dsh-our-free-model 的 probe 机制）
 *
 * 关键判定：探测成功 + 无账单 = 仍在免费额度内；探测成功 + 有账单 = 额度已耗尽开始计费。
 */
import { t } from '../shared/i18n';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { aliyunRpcCall } from './whitelist';
import { withFileLock } from './file-lock';
import {
  applyCatalogPrices,
  appendCatalogHistory,
  getCatalogSource,
  normalizePriceEntries,
  summarizePrices,
  priceFingerprint,
  type CatalogDiff,
  type PriceEntry,
  type ProviderCatalog,
} from './model-catalog';
import {
  thcliAvailable,
  thBinPath,
  listThProfiles,
  activeThProfile,
  thcliAuthStatus,
  thcliProfilesDetail,
  fetchTokenHubModels,
  fetchTokenHubQuotas,
  probeTokenHubModel,
  thcliErrorText,
  readThProfileCreds,
  setTokenHubPostpaid,
  claimTokenHubFree,
  type ThcliIdentity,
} from './tokenhub-cli';
import {
  arkcliAvailable,
  arkBinPath,
  listArkProfiles,
  activeArkProfile,
  arkcliAuthStatus,
  arkcliProfilesDetail,
  fetchArkModels,
  fetchArkFreeQuotas,
  probeArkModel,
  arkcliErrorText,
  arkcliHasConfigDir,
  type ArkcliIdentity,
} from './ark-cli';

export {
  thcliAvailable,
  thBinPath,
  listThProfiles,
  thcliProfilesDetail,
  readThProfileCreds,
  thcliErrorText,
  setTokenHubPostpaid,
  claimTokenHubFree,
  arkcliAvailable,
  arkBinPath,
  listArkProfiles,
  arkcliProfilesDetail,
  arkcliErrorText,
  arkcliHasConfigDir,
};

// ESM 里没有 __dirname，需从 import.meta.url 推导（项目 package.json 为 type: module）
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== 类型 ====================

export type ModelModality = '文本' | '图片' | '视频' | '语音' | '向量' | '全模态' | '实时' | '推理' | '其他';

export type ModelInfo = {
  id: string;
  name?: string;
  capabilities?: string[];
  modality: ModelModality;
  publishedAt?: string;
  /** 列上定价摘要（可由全局价目目录覆盖） */
  price?: string;
  /** 结构化价目：输入/输出/缓存/视频分辨率等，供悬停详情 */
  prices?: PriceEntry[];
  /**
   * 仅表示「标价为零」，用于挑选探测目标，**不等同于该模型能白用**。
   * 百炼真正的免费额度是账号级的（开通时每个模型各赠 100 万 tokens），
   * 不体现在模型清单里、也没有公开 API，只有控制台能看到。
   * 因此判断能否免费用必须靠 probe（探测成功 + 无账单），不能看这个字段。
   */
  free: boolean;
  /** TokenHub：online / pre-offline / discontinued */
  status?: string;
  /** TokenHub OfflineAt */
  offlineAt?: string;
  discontinuedAt?: string;
  freeTrial?: boolean;
};

export type { PriceEntry, ProviderCatalog, CatalogDiff };

export type PackageInfo = {
  name: string;
  total: number;
  remaining: number;
  unit: string;
  start?: string;
  expiry?: string;
  product?: string;
};

export type BillRow = {
  date?: string;
  product: string;
  instance: string; // 阿里云出账粒度：含模型名
  amount: number;
};

export type TxRow = {
  time?: string;
  amount: number;
  billingCycle?: string;
  account?: string;
};

export type ProbeStatus = 'available' | 'limited' | 'unknown' | 'unavailable';

export type ProbeResult = {
  modelId: string;
  status: ProbeStatus;
  httpStatus?: number;
  message?: string;
  ts: string;
};

export type UsageSnapshot = {
  accountId: string;
  provider: string;
  ts: string;
  balance?: { amount: number; currency: string } | null;
  spendTotal?: number | null; // 当月账单合计（账单口径，含未出账部分）
  /** 其中大模型/百炼部分：为 0 说明全在免费额度内 */
  aiSpend?: number | null;
  spendRows?: TxRow[]; // 实际扣款流水（交易口径，与账单口径不同）
  packages?: PackageInfo[];
  billRows?: BillRow[];
  /** 余额/账单/资源包是上次成功取到的旧值（本次取数失败，沿用未清，同 cli.quotaStale 的原则） */
  acctStale?: boolean;
  /** 最近一次**成功**取到余额/账单的时间（沿用旧值时保留旧时间戳，便于判断数据多老） */
  acctFetchedAt?: string;
  models?: ModelInfo[];
  modelTotal?: number;
  probes?: ProbeResult[];
  /** 与上次快照比对得出的模型增减 / 改价（账号可见清单） */
  changes?: { added: string[]; removed: string[]; priceChanged?: { id: string; before: string; after: string }[] };
  /**
   * 模型清单/探测所用的 API Key 来源。若与当前账号不匹配（借用了别的账号的 Key），
   * 则 models / probes 反映的是**那个 Key 所属账号**的额度，不可当作本账号的结果。
   */
  apiKeyFrom?: { assetId: string; name: string; shared: boolean };
  /** 百炼 CLI 返回的免费额度（含到期日与用完即停）—— 唯一可靠的额度来源 */
  freeQuotas?: FreeQuota[];
  /** CLI 状态与身份归属（额度只在「已绑定 Profile」时才可信） */
  cli?: {
    ok: boolean;
    reason?: string;
    identity?: CliIdentity | null;
    /** 是否已绑定 Profile */
    bound?: boolean;
    /** 绑定的 Profile 名 */
    boundProfile?: string;
    /** 该 Profile 对应的业务空间（用于核对归属） */
    boundWorkspace?: string;
    /** CLI 里可用的 Profile 列表，供页面选择 */
    profiles?: { name: string; active: boolean }[];
    /** 本次额度取自哪个 CLI Profile（未绑定时为「当前激活」的 Profile） */
    quotaFrom?: string;
    /** 额度是上次成功取到的旧值（本次取数失败，保留未清） */
    quotaStale?: boolean;
    /** 最近一次**成功**取到额度的时间 */
    quotaFetchedAt?: string;
    /** 本次取额度失败的原因（已转成人话 + 修复命令） */
    quotaError?: string;
  };
  error?: string;
};

export type AiUsageConfig = {
  version: 1;
  /**
   * **自动刷新间隔（小时）**：拉余额 / 账单 / 资源包 / 模型清单 / CLI 免费额度。
   * 这些全部是「只读查询」，**不消耗任何模型额度**（实测连续 5 次查额度，剩余数恒定）。
   */
  probeIntervalHours: number;
  /** 参与监控的账号：{ [accountAssetId]: { apiKeyAssetId?: string } } */
  accounts: Record<string, { apiKeyAssetId?: string }>;
  /** 默认探测的模型（留空则用内置常用清单） */
  probeModels?: string[];
  /**
   * 自动刷新时是否顺带「探测」——探测是**真实调用模型**，会消耗额度（约 10 tokens/次）
   * 且会触发限流（429）。默认 **false**：有 CLI 提供精确额度后，探测不再是必需项。
   * 需要时可用页面上的「手动探测」按需触发。
   */
  autoProbe?: boolean;
  /** 上次真实探测的时间（与 lastRunAt 分开记，便于「刷新勤、探测稀」） */
  lastProbeAt?: string;
  /**
   * 账号 → 百炼 CLI **Profile 名** 的绑定关系。
   * CLI 支持多 Profile（`bl auth login --console --config <name>` 分别登录不同阿里云账号），
   * 查询时用 `--config <name>` 即可取该账号的额度，无需切换全局状态。
   * 绑定后才知道某账号对应哪个 Profile，否则会把 A 账号的额度显示到 B 账号页上。
   */
  cliBindings?: Record<string, string>;
  /** Profile 名 → 业务空间（登录时记录，便于核对归属） */
  cliSpaces?: Record<string, string>;
  lastRunAt?: string;
};

/** 内置常用探测清单：prices=0 的模型往往只有一两个且未必可调用，
 *  真正有代表性的是这些日常在用的模型——探测成功且无账单即仍在免费额度内 */
export const DEFAULT_PROBE_MODELS = [
  'qwen-plus',
  'qwen-turbo',
  'qwen-max',
  'qwen-flash',
  'qwen-long',
];

// ==================== 百炼 CLI（免费额度的唯一可靠来源） ====================

/**
 * 免费额度、到期日、「用完即停」状态**只能通过百炼官方 CLI 拿到**：
 * 模型清单 API 不含额度字段，也不存在公开的额度 API（网传的 account/quota 是 404，
 * bailian/v2/usage 需另一种令牌）。CLI 命令 `bl usage free` 走控制台网关，是官方支持的方式。
 * CLI 以 devDependency 装在 node_modules，凭据存 ~/.bailian/config.json（首次需 `bl auth login --console`）。
 */
export type FreeQuota = {
  model: string;
  type: string; // Text / Vision / Multimodal / Audio / Embedding
  remaining: number | null; // 剩余额度
  total: number | null; // 总额度
  usagePercent: number | null;
  remainingPercent: number | null;
  expires: string | null; // 到期日 YYYY-MM-DD
  /** 到期时间戳（原始 quotaValidityPeriod）。2099 类哨兵值表示「长期有效，不设到期」 */
  expiresAt?: number | null;
  /** 额度单位：Token / 字符 / 秒 / 张 … 接口不返回，按模型名与额度数量级推断；推断不出为 null */
  unit?: string | null;
  /** 重置规则：接口不返回周期字段，按有效期形态推断（见 inferResetRule） */
  reset?: { kind: ResetRule; text: string; note: string } | null;
  /** 百炼：用完即停（开=额度耗尽不再扣费） */
  autoStop: boolean | 'unsupported' | null;
  /**
   * 腾讯云 TokenHub：启用按 Token 计费（PaymentEnabled）。
   * 开=免费额用尽后继续按量扣费；关=用尽即停服务（对标百炼「用完即停」的反面语义，UI 单独列名）。
   */
  postpaid?: boolean | null;
  /** TokenHub 接入点 ID，切换按 Token 计费时用 */
  endpointId?: string;
};

/**
 * 视为「长期有效」的到期年份阈值。
 * 百炼对无终点的额度使用 2099-01-01 这类哨兵时间戳（实测 quotaValidityPeriod=4070880000000）。
 * 阈值取 2090：既能覆盖 2099，又不会误判真实到期日（实测真实到期日最远到 2027）。
 */
export const LONG_TERM_YEAR = 2090;

/**
 * 推断额度单位。
 *
 * 额度接口（queryFreeTierQuota）**只返回数量，不返回单位**，但不同模态的计费口径不同，
 * 直接显示数字会让人看不懂（语音 30000 到底是字符还是秒？）。
 * 依据：官方文档「图像按张、视频按时长、语音识别/合成按音频时长或字符计费」+ 实测额度数量级：
 *   - sambert-* 语音合成：30000 → 字符
 *   - paraformer-* / 3.0-asr-flash 语音识别：36000 → 秒（=10 小时）
 *   - qwen-audio-3.1-* 等新架构：1000000 → Token（与文本模型同一口径）
 *   - 图片生成：几十张 → 张
 * 猜不出就返回 null，页面留空，**不硬编一个可能错的单位**。
 */
export function inferQuotaUnit(model: string, total?: number | null): string | null {
  const m = String(model || '').toLowerCase();
  if (/(^|-)sambert(-|$)/.test(m)) return '字符';
  if (/(^|-)paraformer(-|$)/.test(m)) return '秒';
  // 旧口径 asr（3.0）：36000 → 秒；新口径（3.1）是 100 万 → Token，靠数量级区分
  if (/asr|filetrans|livetranslate/.test(m) && typeof total === 'number' && total <= 100000) return '秒';
  if (/^qwen-image|image-|wan[0-9.]*-image/.test(m) && typeof total === 'number' && total <= 10000) return '张';
  if (/(tts|audio|omni|asr|translate|translat)/.test(m)) return 'Token';
  if (/text-embedding|text-rerank|embedding/.test(m)) return 'Token';
  return 'Token';
}

/** 到期日是否为「长期有效」（哨兵时间戳或极远未来） */
export function isLongTermExpiry(expiresAt?: number | null, expires?: string | null): boolean {
  if (expiresAt && expiresAt > 0) return new Date(expiresAt).getUTCFullYear() >= LONG_TERM_YEAR;
  if (expires) {
    const y = Number(String(expires).slice(0, 4));
    return Number.isFinite(y) && y >= LONG_TERM_YEAR;
  }
  return false;
}

export type ResetRule = 'monthly' | 'cyclic' | 'one-off' | 'unknown';

/**
 * 推断「额度如何重置」。
 *
 * ⚠️ 重要：额度接口（queryFreeTierQuota）**不返回任何周期/重置字段**，
 * 实测返回体只有 quotaInitTotal / quotaTotal / quotaValidityPeriod / model / quotaStatus 五项。
 * 所以这里只能依据「有效期形态」推断，不是平台下发的原始数据：
 *
 *  - 有效期 = 2099 这类哨兵值（长期有效）：额度没有终点，只可能是**周期性额度**。
 *    控制台在语音模型上将其展示为「每月1日额度重置」，故 Audio 类标注 monthly。
 *  - 有效期是具体日期（实测集中在开通后 90 天内）：对应官方「新人免费额度」规则
 *    —— 有效期 90 天，**过期自动失效，不支持补发、延期或重置**，即到期作废。
 *
 * 结论对外展示时必须说明是推断值，避免把推断当事实。
 */
export function inferResetRule(q: { type?: string; expires?: string | null; expiresAt?: number | null }): {
  kind: ResetRule;
  text: string;
  note: string;
} {
  if (isLongTermExpiry(q.expiresAt, q.expires)) {
    const isAudio = String(q.type || '').toLowerCase() === 'audio';
    return {
      kind: isAudio ? 'monthly' : 'cyclic',
      text: isAudio ? t('reset.monthly') : t('reset.cyclic'),
      note: t('reset.cyclicNote'),
    };
  }
  if (q.expires) {
    return {
      kind: 'one-off',
      text: t('reset.expired'),
      note: t('reset.expiredNote'),
    };
  }
  return { kind: 'unknown', text: '—', note: t('reset.unknownNote') };
}

function blBin(): string {
  const root = path.join(__dirname, '..', '..');
  const isWin = process.platform === 'win32';
  return path.join(root, 'node_modules', '.bin', isWin ? 'bl.cmd' : 'bl');
}

/** bl 不在用户 PATH 里（装在项目 node_modules/.bin）——给界面二进制完整路径，参数由界面拼（勿重复拼命令） */
export function blBinPath(): string {
  const bin = blBin();
  return /[\s"']/.test(bin) ? JSON.stringify(bin) : bin;
}

/** 百炼 CLI 是否可用（装了且已鉴权） */
export function bailianCliAvailable(): { ok: boolean; reason?: string } {
  const bin = blBin();
  if (!fs.existsSync(bin)) return { ok: false, reason: '未安装百炼 CLI（bailian-cli）' };
  const cfg = path.join(process.env.HOME || process.env.USERPROFILE || '', '.bailian', 'config.json');
  if (!fs.existsSync(cfg)) return { ok: false, reason: '百炼 CLI 未登录（需 bl auth login --console）' };
  return { ok: true };
}

/** CLI 当前登录身份（masked），用于判断额度数据属于哪个云账号 */
export type CliIdentity = {
  apiKey?: string; // 形如 sk-w...YS68（console 登录绑定，最能代表额度归属）
  akId?: string; // 形如 LTAI...Bc3W / 腾讯 SecretId 掩码（**不单独代表额度归属**）
  workspaceId?: string; // 业务空间 / TokenHub site 线索
  baseUrl?: string;
  region?: string;
};

/** TokenHub 身份 → 与百炼共用的 CliIdentity 形状（页面/匹配复用） */
export function thIdentityToCli(id: ThcliIdentity | null): CliIdentity | null {
  if (!id) return null;
  return {
    apiKey: id.apiKey,
    akId: id.secretId,
    region: id.region,
    baseUrl: id.baseUrl,
    workspaceId: id.site ? `th:${id.site}:${id.profile}` : undefined,
  };
}

/** Ark 身份 → CliIdentity */
export function arkIdentityToCli(id: ArkcliIdentity | null): CliIdentity | null {
  if (!id) return null;
  return {
    apiKey: id.apiKey,
    region: id.region,
    baseUrl: id.baseUrl,
    workspaceId: id.project ? `ark:${id.project}:${id.profile}` : `ark:${id.profile}`,
  };
}

export async function bailianIdentity(profile?: string): Promise<CliIdentity | null> {
  try {
    const args = ['auth', 'status', '--output', 'json'];
    if (profile) args.push('--config', profile);
    const s = await execBailian<any>(args, 30000);
    return {
      apiKey: s?.api_key?.masked,
      akId: s?.openapi?.access_key_id,
      region: s?.console?.region,
      baseUrl: s?.api_key?.base_url,
      // workspace 是额度归属的关键线索：不同阿里云账号的业务空间不同
      workspaceId: s?.api_key?.base_url ? /https?:\/\/([^.]+)\./.exec(s.api_key.base_url)?.[1] : await readCliWorkspace(),
    };
  } catch {
    return null;
  }
}

/** 列出 CLI 已存在的 Profile（含 active 标记，供页面选择绑定到账号） */
export async function listCliProfiles(): Promise<{ name: string; active: boolean }[]> {
  try {
    const { stdout } = await runBailian(['config', 'list'], 30000);
    const out = stdout
      .split('\n')
      .slice(1)
      .map((l) => {
        const parts = l.trim().split(/\s+/);
        return { name: parts[0], active: parts[1] === '*' };
      })
      .filter((p) => p.name && p.name !== 'NAME' && !p.name.startsWith('-'));
    return out.length ? out : [{ name: 'default', active: true }];
  } catch {
    return [{ name: 'default', active: true }];
  }
}

/** 当前激活的 Profile 名 */
export async function activeCliProfile(): Promise<string> {
  const ps = await listCliProfiles();
  return (ps.find((p) => p.active) || ps[0]).name;
}

/**
 * 列出全部 Profile 及其登录身份（apiKey 掩码 + 业务空间）。
 * 页面据此让用户把「哪个 Profile」绑到「哪个云账号」——掩码与业务空间是挑选依据。
 */
export async function cliProfilesDetail(): Promise<
  { name: string; active: boolean; identity: CliIdentity | null }[]
> {
  const ps = await listCliProfiles();
  return Promise.all(
    ps.map(async (p) => ({
      ...p,
      identity: await bailianIdentity(p.name).catch(() => null),
    }))
  );
}

/** 生成一个新的 Profile 名（多账号登录时用：profile-2、profile-3…） */
export function suggestProfileName(existing: string[] = []): string {
  for (let i = 2; i < 100; i++) {
    const n = `profile-${i}`;
    if (!existing.includes(n)) return n;
  }
  return `profile-${Date.now()}`;
}

/** 从 CLI 配置读 workspace_id（不读取任何密钥字段） */
function readCliWorkspace(): string | undefined {
  return readCliProfileCreds('default')?.workspaceId;
}

/**
 * 读某 Profile 在本机 `~/.bailian/config.json` 里的明文凭据。
 * `bl auth login --console` 会按需写入普通 API Key；`auth status` 只给掩码，明文只在此文件。
 * - `default`：顶层字段
 * - 其它名：嵌套对象 `config[profile]`
 * @param bailianDir 可注入目录便于单测（默认 `~/.bailian`）
 */
export function readCliProfileCreds(
  profile = 'default',
  bailianDir?: string
): { apiKey: string; baseUrl?: string; workspaceId?: string } | null {
  try {
    const dir =
      bailianDir || path.join(process.env.HOME || process.env.USERPROFILE || '', '.bailian');
    const cfg = path.join(dir, 'config.json');
    if (!fs.existsSync(cfg)) return null;
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    const block = profile === 'default' ? j : j?.[profile];
    const apiKey = typeof block?.api_key === 'string' ? block.api_key.trim() : '';
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl: typeof block?.base_url === 'string' ? block.base_url : undefined,
      workspaceId: typeof block?.workspace_id === 'string' ? block.workspace_id : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * masked 形如 "LTAI...Bc3W" 或 "sk-w...YS68" → 判断真实值是否首尾吻合。
 * 注意：masked 里可能含连字符（如 sk-w），正则必须允许 - 与 .
 */
function maskedMatch(masked: string | undefined, real?: string): boolean {
  if (!masked || !real) return false;
  // 前后缀**不能含点**：若允许 `[\w.-]`，`sk-w...YS68` 会被贪婪回溯成 head='sk-w.'，
  // 拿去和真值 `sk-w12345678YS68` 比对就永远 false（实测踩过）。
  const m = /^([\w-]{2,10})\.{2,}([\w-]{2,10})$/.exec(masked);
  if (!m) return false;
  const [, head, tail] = m;
  return real.startsWith(head) && real.endsWith(tail);
}

/**
 * 判断 CLI 当前身份是否属于给定账号。
 *
 * 重要：`usage free` 走 **console 网关**（access_token），不是 openapi 的 AK/SK。
 * 两者可以是不同阿里云账号（例如用 A 账号的 AK/SK 做过 open-api 登录，
 * 又用 B 账号浏览器登录过 console）。因此**不能用 AK 判断额度归属**，
 * 只能核对 api_key（console 登录时会绑定到该账号）或 workspace。
 */
export function cliOwnsAccount(
  identity: CliIdentity | null,
  hint?: { apiKey?: string; workspaceId?: string }
): boolean {
  return cliMatchReason(identity, hint) !== null;
}

/**
 * 判断某个 CLI Profile 是否属于给定账号，并给出**依据**。
 * 返回 `null` 表示对不上（或线索不足，无法判断）。
 * 页面用它把「属于本账号的那个 Profile」标出来，用户就不用靠猜。
 */
export function cliMatchReason(
  identity: CliIdentity | null,
  hint?: { apiKey?: string; workspaceId?: string }
): 'apiKey' | 'workspace' | null {
  if (!identity || !hint) return null;
  // API Key 掩码首尾吻合是最强的证据：同一个 Key 必然是同一个账号
  if (hint.apiKey && maskedMatch(identity.apiKey, hint.apiKey)) return 'apiKey';
  if (hint.workspaceId && identity.workspaceId && identity.workspaceId === hint.workspaceId) return 'workspace';
  return null;
}

/** 执行百炼 CLI 的原始结果（不解析输出） */
function runBailian(
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bin = blBin();
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
      try { p.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    p.stdout?.on('data', (d) => (stdout += String(d)));
    p.stderr?.on('data', (d) => (stderr += String(d)));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** 去掉 CLI 输出里 Node 自身的噪音（代理实验特性警告等），只留有用信息 */
function cleanCliText(s: string): string {
  return String(s || '')
    .split('\n')
    .filter((l) => !/UNDICI-EHPA|trace-warnings|ExperimentalWarning|trace-uncaught/i.test(l))
    .join('\n')
    .trim();
}

/**
 * 从 CLI 输出里取出真正的错误信息。
 * CLI 把结构化错误写在 **stderr**（stdout 往往是空的），且常混着 Node 的警告行，
 * 不清洗的话页面会显示一坨「UNDICI-EHPA Warning」而不是真正的失败原因。
 */
function cliErrorMessage(stdout: string, stderr: string): string {
  for (const raw of [stdout, stderr]) {
    const t = cleanCliText(raw);
    const i = t.indexOf('{');
    if (i < 0) continue;
    try {
      const j = JSON.parse(t.slice(i));
      if (j?.error) return String(j.error.message || JSON.stringify(j.error));
    } catch {
      /* 不是 JSON，看下一段 */
    }
  }
  return cleanCliText(stderr) || cleanCliText(stdout) || '百炼 CLI 无有效输出';
}

/** 执行百炼 CLI 并解析 JSON（自动跳过 Node 的代理警告等非 JSON 行） */
async function execBailian<T>(args: string[], timeoutMs = 120000): Promise<T> {
  const { stdout, stderr } = await runBailian(args, timeoutMs);
  const a = stdout.indexOf('[');
  const o = stdout.indexOf('{');
  const idx = a >= 0 ? a : o;
  if (idx < 0) throw new Error(cliErrorMessage(stdout, stderr));
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.slice(idx));
  } catch {
    throw new Error(cliErrorMessage(stdout, stderr));
  }
  if (parsed && parsed.error) throw new Error(String(parsed.error.message || JSON.stringify(parsed.error)));
  return parsed as T;
}

/**
 * 执行百炼 CLI 但不要求 JSON 输出。
 * 有些命令（如 usage freetier 的 --off 分支）只回一行纯文本，
 * 强制解析 JSON 会误判为失败 —— 这类命令只看退出码。
 */
async function execBailianRaw(args: string[], timeoutMs = 120000): Promise<string> {
  const { code, stdout, stderr } = await runBailian(args, timeoutMs);
  const text = cleanCliText(stdout) || cleanCliText(stderr);
  if (code !== 0) throw new Error(text || `百炼 CLI 退出码 ${code}`);
  return text;
}

/**
 * 查询全部模型的免费额度（含到期日与用完即停状态）。
 *
 * 注意：CLI 的 `--all` 与默认行为**不会过滤已失效额度**——实测两者都返回 83 条，
 * 因为当前账号的额度 status 均为 VALID。但源码里默认分支会过滤
 * `quotaStatus==='VALID' && quotaInitTotal>0`，所以保留 `--all`（要看到全貌，包括已作废的）。
 */
export async function fetchFreeQuota(profile?: string): Promise<FreeQuota[]> {
  const args = ['usage', 'free', '--all', '--output', 'json'];
  // --config 是全局参数，可直接指定 Profile 取该账号的额度，无需切换全局激活态
  if (profile) args.push('--config', profile);
  const list = await execBailian<any[]>(args);
  // CLI 只输出数量，单位与原始时间戳需在这里补齐，否则「30000」无从理解
  return (list || []).map((q) => {
    const expiresAt = expiryToTs(q?.expires);
    return {
      ...q,
      unit: inferQuotaUnit(q?.model, q?.total ?? null),
      expiresAt,
      reset: inferResetRule({ type: q?.type, expires: q?.expires, expiresAt }),
    } as FreeQuota;
  });
}

/** 控制台会话过期 / 未登录（可用 AK 换票或浏览器重登） */
export function isBailianConsoleSessionError(e: unknown): boolean {
  const raw = String((e as any)?.message || e || '');
  return /not logged in|has expired|No console access token|NotLogin|TokenExpired|尚未登录控制台|令牌已过期|登录态失效/i.test(
    raw
  );
}

/** 业务空间未授权（AK 换出的 token 常踩这个；需浏览器控制台登录一次） */
export function isBailianTeamAuthError(e: unknown): boolean {
  const raw = String((e as any)?.message || e || '');
  return /Team\.NotAuthorised|NotAuthorised|无权限/i.test(raw);
}

/**
 * 把云账号 AK/SK 写入百炼 CLI Profile（`bl auth login --open-api`）。
 * 官方会在控制台 token 过期（NotLogined）时用本地 AK/SK 静默换票；
 * 部分账号换出的 token 可能仍报 Team.NotAuthorised，那时还需浏览器登录一次。
 */
export async function ensureBailianOpenApi(
  profile: string,
  accessKeyId: string,
  accessKeySecret: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ak = String(accessKeyId || '').trim();
  const sk = String(accessKeySecret || '').trim();
  if (!ak || !sk) return { ok: false, reason: '云账号缺少 AccessKey' };
  try {
    await execBailianRaw(
      [
        'auth',
        'login',
        '--open-api',
        '--access-key-id',
        ak,
        '--access-key-secret',
        sk,
        '--config',
        profile,
      ],
      90000
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: cliErrorText(e) };
  }
}

/** 后台拉起浏览器控制台登录（用户不用手敲终端） */
export function launchBailianConsoleLogin(profile = 'default'): { ok: true; cmd: string } | { ok: false; reason: string } {
  const bin = blBin();
  if (!fs.existsSync(bin)) return { ok: false, reason: '未安装百炼 CLI' };
  const args = ['auth', 'login', '--console', '--config', profile];
  const cwd = path.join(__dirname, '..', '..');
  try {
    const child = spawn(bin, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, cmd: `${blBinPath()} auth login --console --config ${profile}` };
  } catch (e) {
    return { ok: false, reason: String((e as Error).message || e) };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 取免费额度，带自动续期。
 *
 * 顺序很重要（踩过坑）：
 * 1) **先直接拉**——已有浏览器登录态时绝不能先跑 open-api 换票
 *    （`bl auth login --open-api` 会覆盖 access_token；子账号 AK 换出的票常是 Team.NotAuthorised，
 *    会把刚登录成功的会话立刻弄坏，表现为「浏览器登了还说要续期」）
 * 2) 仅当错误是「未登录 / 令牌过期」时，才用 AK/SK 静默换票再试
 * 3) Team.NotAuthorised 不能靠 AK 修，只走浏览器登录（可选）
 */
export async function fetchFreeQuotaAuto(
  profile: string,
  opts: {
    accessKeyId?: string;
    accessKeySecret?: string;
    launchBrowser?: boolean;
    waitBrowserMs?: number;
  } = {}
): Promise<{
  quotas: FreeQuota[];
  renewed: boolean;
  browserLaunched: boolean;
  openApi?: { ok: boolean; reason?: string };
}> {
  let renewed = false;
  let browserLaunched = false;
  let openApi: { ok: boolean; reason?: string } | undefined;

  const tryFetch = () => fetchFreeQuota(profile);

  try {
    return { quotas: await tryFetch(), renewed, browserLaunched, openApi };
  } catch (firstErr) {
    let err: unknown = firstErr;

    // 只有「真过期 / 未登录」才 AK 换票；Team.NotAuthorised 换了更糟
    if (opts.accessKeyId && opts.accessKeySecret && isBailianConsoleSessionError(err)) {
      openApi = await ensureBailianOpenApi(profile, opts.accessKeyId, opts.accessKeySecret);
      renewed = openApi.ok;
      if (openApi.ok) {
        try {
          return { quotas: await tryFetch(), renewed, browserLaunched, openApi };
        } catch (e2) {
          err = e2;
        }
      }
    }

    const needBrowser =
      opts.launchBrowser && (isBailianConsoleSessionError(err) || isBailianTeamAuthError(err));
    if (!needBrowser) throw err;

    const launched = launchBailianConsoleLogin(profile);
    if (!launched.ok) {
      throw new Error(`${cliErrorText(err)}；且无法拉起浏览器登录：${launched.reason}`);
    }
    browserLaunched = true;

    const deadline = Date.now() + Math.max(15_000, opts.waitBrowserMs ?? 120_000);
    let lastErr: unknown = err;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        return { quotas: await tryFetch(), renewed, browserLaunched, openApi };
      } catch (e) {
        lastErr = e;
        // 仍未登录 / 仍无团队权限则继续等；其它错误直接抛
        if (!isBailianConsoleSessionError(e) && !isBailianTeamAuthError(e)) throw e;
      }
    }
    throw new Error(
      `${cliErrorText(lastErr)}（已打开浏览器登录，超时未完成。请在浏览器点完授权后点「刷新数据」；刷新不会再用 AK 覆盖你的登录态）`
    );
  }
}

/** 'YYYY-MM-DD' → 当天 UTC 零点时间戳（与百炼 quotaValidityPeriod 对齐） */
function expiryToTs(expires?: string | null): number | null {
  if (!expires) return null;
  const t = Date.parse(String(expires).slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(t) ? t : null;
}

/**
 * 开/关「免费额度用完即停」。
 * 开启后额度耗尽会返回 403 而不再按量扣费（等于给探测上了保险）。
 * profile：指定 CLI Profile（多账号时必传，否则会改到当前激活账号上）。
 */
export async function setFreeTierStop(model: string, on: boolean, profile?: string): Promise<string> {
  // 输出格式不固定（--off 分支只回一行英文文本），故用 raw 模式只看退出码
  const args = ['usage', 'freetier', '--model', model];
  if (profile) args.push('--config', profile);
  if (!on) args.push('--off');
  return execBailianRaw(args, 60000);
}

/**
 * CLI 报错 → 人话。
 *
 * 之前失败只是 `.catch(() => undefined)`，页面直接空白，用户完全不知道发生了什么
 * （实测：控制台令牌失效后 84 条额度瞬间变成 0 条）。现在必须把原因说出来，
 * 并给出可复制的修复命令。
 */
export function cliErrorText(e: unknown): string {
  const raw = String((e as any)?.message || e || '').trim();
  if (!raw) return '百炼 CLI 取免费额度失败（未返回原因）';
  const gw = /Console gateway error:\s*([A-Za-z0-9_.]+)/.exec(raw);
  if (gw) {
    const code = gw[1];
    const known: Record<string, string> = {
      'BailianGateway.Team.NotAuthorised':
        '控制台令牌对该业务空间无权限（Team.NotAuthorised）。多半是 AccessKey 换票无权，需用浏览器登录主账号/有权限账号',
      'BailianGateway.NotLogin': '控制台未登录',
      'BailianGateway.TokenExpired': '控制台令牌已过期',
    };
    return `${known[code] || code} —— 点「一键续期」完成浏览器授权后直接看额度（勿反复用 AK 覆盖会话）。`;
  }
  if (/No console access token|not logged in|未登录/i.test(raw)) {
    return 'CLI 尚未登录控制台 —— 请在终端执行 `bl auth login --console`。';
  }
  if (/ETIMEDOUT|timed out/i.test(raw)) return '百炼 CLI 请求超时，稍后重试。';
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

/** 对全部免费额度模型开/关用完即停 */
export async function setFreeTierStopAll(on: boolean, profile?: string): Promise<string> {
  const args = ['usage', 'freetier', '--all'];
  if (profile) args.push('--config', profile);
  if (!on) args.push('--off');
  return execBailianRaw(args, 180000);
}

// ==================== 凭据 ====================

export type Creds = {
  accessKeyId?: string;
  accessKeySecret?: string;
  apiKey?: string; // 平台模型的 API Key（百炼 / TokenHub）
  /** TokenHub 等兼容网关 Base URL */
  baseUrl?: string;
};

// ==================== 适配器接口 ====================

export interface ProviderHandler {
  id: string;
  label: string;
  /** 拉取余额/消费/资源包/账单（用 AK/SK） */
  fetchAccount(
    creds: Creds
  ): Promise<Pick<UsageSnapshot, 'balance' | 'spendTotal' | 'aiSpend' | 'spendRows' | 'packages' | 'billRows' | 'error'>>;
  /** 拉取模型清单（用 API Key） */
  fetchModels(creds: Creds): Promise<{ models: ModelInfo[]; total: number } | null>;
  /** 探测单个模型可用性 */
  probe(creds: Creds, modelId: string): Promise<ProbeResult>;
}

// ==================== 工具 ====================

/** 成功判定：阿里云部分接口成功时 Code 为 "200" 而非 "Success" */
function aliyunOk(r: any): boolean {
  return !r?.Code || r.Code === 'Success' || r.Code === '200';
}

function isoRange(daysBack: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86400000);
  return { start: start.toISOString().slice(0, 19) + 'Z', end: end.toISOString().slice(0, 19) + 'Z' };
}

/** 百炼 capabilities 标签 → 中文模态 */
const CAP_TO_MODALITY: Record<string, ModelModality> = {
  TG: '文本',
  IG: '图片',
  VG: '视频',
  TTS: '语音',
  ASR: '语音',
  VU: '图片',
  ME: '向量',
  // TR：文本向量（text-embedding）与重排序（rerank）模型 —— 之前漏配全落进了「其他」
  TR: '向量',
  'Multimodal-Omni': '全模态',
  Reasoning: '推理',
};

export function modalityOf(caps: string[] = []): ModelModality {
  for (const c of caps) {
    if (c.startsWith('Realtime')) return '实时';
    if (CAP_TO_MODALITY[c]) return CAP_TO_MODALITY[c];
  }
  return '其他';
}

// ==================== 阿里云 / 百炼 ====================

const DASHSCOPE = 'https://dashscope.aliyuncs.com';

const AliyunHandler: ProviderHandler = {
  id: 'aliyun',
  label: t('cloud.aliyun'),

  async fetchAccount(creds: Creds) {
    const ak = creds.accessKeyId;
    const sk = creds.accessKeySecret;
    if (!ak || !sk) return { error: '缺少 AK/SK' };
    const out: Pick<
      UsageSnapshot,
      'balance' | 'spendTotal' | 'aiSpend' | 'spendRows' | 'packages' | 'billRows' | 'error'
    > = {};

    const call = (action: string, params: Record<string, string> = {}) =>
      aliyunRpcCall({
        accessKeyId: ak, accessKeySecret: sk, action,
        version: '2017-12-14', endpoint: 'business.aliyuncs.com', params,
      });

    // 余额
    try {
      const r = await call('QueryAccountBalance');
      if (aliyunOk(r)) {
        out.balance = {
          amount: Number(r?.Data?.AvailableAmount ?? 0),
          currency: r?.Data?.Currency || 'CNY',
        };
      } else out.error = `余额：${r?.Code}`;
    } catch (e) {
      out.error = `余额：${(e as Error).message}`;
    }

    // 消费流水（必须用 CreateTime 范围，BillingCycle 会漏数据）
    try {
      const { start, end } = isoRange(30);
      const r = await call('QueryAccountTransactions', {
        TransactionType: 'Consumption',
        CreateTimeStart: start,
        CreateTimeEnd: end,
        MaxResults: '300',
      });
      if (aliyunOk(r)) {
        const rows: any[] = r?.Data?.AccountTransactionsList?.AccountTransactionsList || [];
        out.spendRows = rows.slice(0, 200).map((x) => ({
          time: x.TransactionTime,
          amount: Math.abs(Number(x.Amount ?? 0)),
          billingCycle: x.BillingCycle,
          account: x.TransactionAccount,
        }));
        out.spendTotal = (out.spendRows || []).reduce((s, x) => s + x.amount, 0);
      }
    } catch {
      /* 单项失败不影响整体 */
    }

    // 资源包（含免费试用包，用名称区分）
    try {
      const r = await call('QueryResourcePackageInstances', { PageNum: '1', PageSize: '100' });
      if (aliyunOk(r)) {
        const rows: any[] = r?.Data?.Instances?.Instance || [];
        out.packages = rows.map((p) => ({
          name: p.Remark || p.PackageType || '资源包',
          total: Number(p.TotalAmount ?? 0),
          remaining: Number(p.RemainingAmount ?? 0),
          unit: p.TotalAmountUnit || p.RemainingAmountUnit || '',
          start: p.EffectiveTime,
          expiry: p.ExpiryTime,
          product: p.CommodityCode,
        }));
      }
    } catch {
      /* ignore */
    }

    // 账单（实例 ID 含模型名，用于判断哪个模型已产生费用）
    try {
      const now = new Date();
      const cycle = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const r = await call('QueryInstanceBill', { BillingCycle: cycle, MaxResults: '300' });
      if (aliyunOk(r)) {
        const rows: any[] = r?.Data?.Items?.Item || [];
        out.billRows = rows.map((x) => ({
          date: x.BillingDate || x.BillingCycle,
          product: x.ProductName || x.ProductCode || '',
          instance: x.InstanceID || '',
          amount: Number(x.PretaxAmount ?? 0),
        }));
        // 账单口径的消费：比交易流水更准（流水只含已扣款，会漏掉本月未出账部分）
        out.spendTotal = (out.billRows || []).reduce((s, x) => s + x.amount, 0);
        out.aiSpend = (out.billRows || [])
          .filter((x) => /百炼|大模型|dashscope|bailian/i.test(x.product))
          .reduce((s, x) => s + x.amount, 0);
      }
    } catch {
      /* ignore */
    }

    return out;
  },

  async fetchModels(creds: Creds) {
    const apiKey = creds.apiKey;
    if (!apiKey) return null;
    const models: ModelInfo[] = [];
    let total = 0;
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${DASHSCOPE}/api/v1/models?page_no=${page}&page_size=100`, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) break;
      const j: any = await res.json();
      total = Number(j?.output?.total || 0);
      const rows: any[] = j?.output?.models || [];
      for (const m of rows) {
        const prices = normalizePriceEntries(m.prices || []);
        const nums = prices.map((p) => Number(p.price)).filter((n) => Number.isFinite(n));
        const free = prices.length > 0 && nums.length > 0 && nums.every((n) => n === 0);
        const caps: string[] = m.capabilities || [];
        models.push({
          id: m.model || '',
          name: m.name,
          capabilities: caps,
          modality: modalityOf(caps),
          publishedAt: m.published_time,
          prices: prices.length ? prices : undefined,
          price: prices.length ? summarizePrices(prices) || (free ? '标价免费' : '按量') : undefined,
          free,
        });
      }
      if (models.length >= total || rows.length === 0) break;
    }
    return { models, total: total || models.length };
  },

  async probe(creds: Creds, modelId: string): Promise<ProbeResult> {
    const apiKey = creds.apiKey;
    const ts = new Date().toISOString();
    if (!apiKey) return { modelId, status: 'unknown', message: '缺少 API Key', ts };
    try {
      const res = await fetch(`${DASHSCOPE}/compatible-mode/v1/chat/completions`, {
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
      if (res.status === 429) return { modelId, status: 'limited', httpStatus: 429, message: '已达限额（非不可用）', ts };
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
  },
};

const TENCENT_DEFAULT_MODELS = ['hunyuan-turbos-latest', 'hunyuan-lite', 'deepseek-v3', 'deepseek-r1'];
const VOLC_DEFAULT_MODELS = ['doubao-seed-1-6', 'doubao-seed-1-6-flash', 'deepseek-v3-1', 'doubao-1-5-pro-32k'];

const TencentHandler: ProviderHandler = {
  id: 'tencent',
  label: t('cloud.tencent'),

  async fetchAccount(_creds: Creds) {
    // 账单/余额走云 API 可后续补；本迭代以 TokenHub CLI 模型与额度为主，不阻塞刷新
    return {};
  },

  async fetchModels(creds: Creds) {
    // 优先 CLI（登录态）；失败再返回 null 让上层沿用缓存
    try {
      const r = await fetchTokenHubModels();
      return { models: r.models as ModelInfo[], total: r.total };
    } catch {
      if (!creds.apiKey) return null;
      return null;
    }
  },

  async probe(creds: Creds, modelId: string) {
    return probeTokenHubModel(creds, modelId) as Promise<ProbeResult>;
  },
};

const VolcengineHandler: ProviderHandler = {
  id: 'volcengine',
  label: t('cloud.volcano'),

  async fetchAccount(_creds: Creds) {
    return {};
  },

  async fetchModels(creds: Creds) {
    try {
      const r = await fetchArkModels();
      return { models: r.models as ModelInfo[], total: r.total };
    } catch {
      if (!creds.apiKey) return null;
      return null;
    }
  },

  async probe(creds: Creds, modelId: string) {
    return probeArkModel(creds, modelId) as Promise<ProbeResult>;
  },
};

const HANDLERS: Record<string, ProviderHandler> = {
  aliyun: AliyunHandler,
  tencent: TencentHandler,
  volcengine: VolcengineHandler,
};

export function getHandler(provider: string): ProviderHandler | null {
  return HANDLERS[provider] || null;
}

export const SUPPORTED_PROVIDERS = Object.keys(HANDLERS);

// ==================== 存储 ====================

const DEFAULT_CONFIG: AiUsageConfig = {
  version: 1,
  probeIntervalHours: 6,
  accounts: {},
  // 自动刷新默认**不探测**：只读查询不花钱，探测花钱，没必要让定时任务替用户花额度
  autoProbe: false,
};

/** 配置的可写字段（updateConfig / setConfig 共用） */
type ConfigPatch = Partial<
  Pick<
    AiUsageConfig,
    | 'probeIntervalHours'
    | 'accounts'
    | 'probeModels'
    | 'autoProbe'
    | 'cliBindings'
    | 'cliSpaces'
    | 'lastRunAt'
    | 'lastProbeAt'
  >
>;

export class AiUsageStore {
  private dir: string;
  private cfgFile: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'ai_usage');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cfgFile = path.join(this.dir, 'config.json');
  }

  // ---- 配置 ----
  getConfig(): AiUsageConfig {
    if (!fs.existsSync(this.cfgFile)) return { ...DEFAULT_CONFIG, accounts: {} };
    try {
      const p = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8')) as AiUsageConfig;
      if (!p || p.version !== 1) return { ...DEFAULT_CONFIG, accounts: {} };
      return { ...DEFAULT_CONFIG, ...p, accounts: p.accounts || {} };
    } catch {
      return { ...DEFAULT_CONFIG, accounts: {} };
    }
  }

  /**
   * 锁内重读 + 合并 + 写。
   * 增量写（例如「哪个账号绑定哪个 CLI Profile」）必须走这里：多个账号并发刷新时，
   * 各自身上的 `getConfig()` 快照会让「后写的覆盖先写的」，锁内重读才是正确基线。
   */
  updateConfig(fn: (cur: AiUsageConfig) => ConfigPatch): AiUsageConfig {
    return withFileLock(this.cfgFile + '.lock', () => {
      const cur = this.getConfig();
      const patch = fn(cur);
      const next: AiUsageConfig = {
        version: 1,
        probeIntervalHours:
          patch.probeIntervalHours && patch.probeIntervalHours > 0
            ? Math.min(Math.max(Number(patch.probeIntervalHours), 1), 720)
            : cur.probeIntervalHours,
        accounts: patch.accounts ?? cur.accounts,
        probeModels: patch.probeModels ?? cur.probeModels,
        autoProbe: patch.autoProbe ?? cur.autoProbe,
        cliBindings: patch.cliBindings ?? cur.cliBindings,
        cliSpaces: patch.cliSpaces ?? cur.cliSpaces,
        lastRunAt: patch.lastRunAt ?? cur.lastRunAt,
        lastProbeAt: patch.lastProbeAt ?? cur.lastProbeAt,
      };
      fs.writeFileSync(this.cfgFile, JSON.stringify(next, null, 2), 'utf8');
      return next;
    });
  }

  /** 覆盖式写入（用户显式改设置）：等价于 updateConfig(() => patch) */
  setConfig(patch: ConfigPatch): AiUsageConfig {
    return this.updateConfig(() => patch);
  }

  private snapFile(accountId: string) {
    return path.join(this.dir, `snapshot-${String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  getSnapshot(accountId: string): UsageSnapshot | null {
    const f = this.snapFile(accountId);
    if (!fs.existsSync(f)) return null;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as UsageSnapshot;
    } catch {
      return null;
    }
  }

  saveSnapshot(s: UsageSnapshot) {
    const f = this.snapFile(s.accountId);
    withFileLock(f + '.lock', () => fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8'));
  }

  /** 与上次快照比对：新增 / 下架 / 改价（账号可见清单） */
  diffModels(
    prev: UsageSnapshot | null,
    next: UsageSnapshot
  ): { added: string[]; removed: string[]; priceChanged: { id: string; before: string; after: string }[] } {
    const prevMap = new Map((prev?.models || []).map((m) => [m.id, m]));
    const nextMap = new Map((next.models || []).map((m) => [m.id, m]));
    const added = [...nextMap.keys()].filter((id) => !prevMap.has(id));
    const removed = [...prevMap.keys()].filter((id) => !nextMap.has(id));
    const priceChanged: { id: string; before: string; after: string }[] = [];
    for (const [id, n] of nextMap) {
      const p = prevMap.get(id);
      if (!p) continue;
      const sameFp =
        (p.prices?.length || n.prices?.length)
          ? priceFingerprint(p.prices || []) === priceFingerprint(n.prices || [])
          : (p.price || '') === (n.price || '');
      if (sameFp) continue;
      if ((p.price || '') === (n.price || '') && !p.prices?.length && !n.prices?.length) continue;
      priceChanged.push({ id, before: p.price || '—', after: n.price || '—' });
    }
    return {
      added: added.slice(0, 50),
      removed: removed.slice(0, 50),
      priceChanged: priceChanged.slice(0, 50),
    };
  }

  private catalogFile(provider: string) {
    return path.join(this.dir, `catalog-${String(provider).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  getCatalog(provider: string): ProviderCatalog | null {
    const f = this.catalogFile(provider);
    if (!fs.existsSync(f)) return null;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as ProviderCatalog;
    } catch {
      return null;
    }
  }

  saveCatalog(c: ProviderCatalog) {
    const f = this.catalogFile(c.provider);
    withFileLock(f + '.lock', () => fs.writeFileSync(f, JSON.stringify(c, null, 2), 'utf8'));
  }

  /**
   * 刷新某厂商全局价目目录（与账号无关）。
   * force=false 时若未过期则直接返回缓存。
   */
  async refreshCatalog(
    provider: string,
    opts: { force?: boolean; maxAgeMs?: number } = {}
  ): Promise<ProviderCatalog | null> {
    const src = getCatalogSource(provider);
    if (!src) return null;
    const prev = this.getCatalog(provider);
    const maxAge = opts.maxAgeMs ?? 6 * 3600 * 1000;
    if (!opts.force && prev?.models?.length && prev.ts) {
      const age = Date.now() - Date.parse(prev.ts);
      if (Number.isFinite(age) && age >= 0 && age < maxAge) return prev;
    }
    try {
      const fetched = await src.fetchCatalog();
      if (!fetched) {
        // 源尚未实现（腾讯云/火山）：保留旧缓存并标注
        if (prev) {
          const stub = { ...prev, error: `${src.label} 价目源尚未接入` };
          this.saveCatalog(stub);
          return stub;
        }
        return {
          provider,
          source: 'none',
          ts: new Date().toISOString(),
          models: [],
          total: 0,
          error: `${src.label} 价目源尚未接入（预留接口，下一步可接 CLI/API）`,
        };
      }
      const next = appendCatalogHistory(prev, fetched.models, {
        provider,
        source: fetched.source,
        ts: new Date().toISOString(),
      });
      this.saveCatalog(next);
      return next;
    } catch (e) {
      const err = String((e as Error)?.message || e).slice(0, 200);
      if (prev?.models?.length) {
        const stale = { ...prev, error: err };
        this.saveCatalog(stale);
        return stale;
      }
      return {
        provider,
        source: 'error',
        ts: new Date().toISOString(),
        models: [],
        total: 0,
        error: err,
      };
    }
  }
}

// ==================== 定时探测调度 ====================

/**
 * 按配置的间隔自动探测。
 * 用「短周期轮询 + 到点才跑」而不是一次性 setInterval(hours)：
 * 这样改了探测间隔后无需重启即可生效。
 */
/** 有上限的并发执行：结果顺序与输入一致，单个失败由调用方处理 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export function startProbeScheduler(
  store: AiUsageStore,
  opts: {
    tickMs?: number;
    /** 保险库是否已解锁（未解锁时跳过） */
    isReady: () => boolean;
    /** 取某账号的厂商与凭据 */
    getCreds: (accountId: string) => Promise<{ provider: string; creds: Creds } | null>;
    onError?: (e: unknown) => void;
  }
): NodeJS.Timeout {
  const tick = opts.tickMs ?? 15 * 60 * 1000; // 默认 15 分钟检查一次
  const timer = setInterval(async () => {
    try {
      if (!opts.isReady()) return;
      const cfg = store.getConfig();
      const ids = Object.keys(cfg.accounts || {});
      if (!ids.length) return;
      const hours = cfg.probeIntervalHours || 6;
      const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
      if (Date.now() - last < hours * 3600 * 1000) return;

      // 刷新（免费）与探测（花钱）分开控制节奏：
      //   刷新按 probeIntervalHours 走；探测只在 autoProbe 打开、且距上次探测已够久时才做。
      const withProbe = cfg.autoProbe === true && msUntilNextProbe(cfg) <= 0;
      // 价目目录：每个厂商在 collectAccount 里按 probeIntervalHours 软刷新一次（全局缓存，不按账号重复打）
      // 免费刷新可以并发（3 路）；探测要真实调用模型、花额度，保持串行，避免同时打满多个账号
      await mapLimit(ids, withProbe ? 1 : 3, async (id) => {
        try {
          const c = await opts.getCreds(id);
          if (!c) return null;
          return await collectAccount(store, id, c.provider, c.creds, { probe: withProbe, probeLimit: 12 });
        } catch (e) {
          // 单个账号失败不该把其他账号的刷新一起带走
          opts.onError?.(e);
          return null;
        }
      });
      store.updateConfig(() => ({
        lastRunAt: new Date().toISOString(),
        ...(withProbe ? { lastProbeAt: new Date().toISOString() } : {}),
      }));
    } catch (e) {
      opts.onError?.(e);
    }
  }, tick);
  // 不阻止进程退出
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return timer;
}

/** 距下次**探测**的毫秒数（以 lastProbeAt 起算；已到期则 <=0） */
export function msUntilNextProbe(cfg: AiUsageConfig): number {
  const last = cfg.lastProbeAt ? Date.parse(cfg.lastProbeAt) : 0;
  if (!last) return 0; // 从未探测过 → 允许
  return last + (cfg.probeIntervalHours || 6) * 3600 * 1000 - Date.now();
}

/** 距下次**自动刷新**的毫秒数（以 lastRunAt 起算；已到期则 <=0） */
export function msUntilNextRefresh(cfg: AiUsageConfig): number {
  const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
  if (!last) return 0;
  return last + (cfg.probeIntervalHours || 6) * 3600 * 1000 - Date.now();
}

// ==================== CLI 限频 ====================

/**
 * 手动调用的最小间隔（毫秒）。
 * CLI 查询虽然不消耗模型额度，但走的是控制台网关——手抖连点会短时间内打出大量请求，
 * 属于无意义的压力。这里做一道硬限频，宁可提示用户稍等，也不要刷接口。
 */
export const CLI_MIN_INTERVAL_MS = 60_000;

/** 距上次运行是否还不到最小间隔；返回剩余毫秒（<=0 表示可以跑） */
export function msUntilCliAllowed(cfg: AiUsageConfig, now = Date.now()): number {
  const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
  if (!last) return 0;
  return last + CLI_MIN_INTERVAL_MS - now;
}

/**
 * 免费额度的取舍规则（纯函数，便于单测）。
 *
 * 背景：早期版本把「绑定 CLI Profile」当成取数的开关，结果用户一点绑定，
 * 取数失败就把 84 条额度静默清成 0 条 —— 页面一片空白且没有任何提示。
 *
 * 现在的原则（用户明确要求「选哪个账号就只显示哪个账号的数据」）：
 *   1. **未绑定 → 一律不显示额度**（`bound=false` 时直接返回空，页面给绑定入口）。
 *      宁可空着也不能显示来源不明的额度 —— 那会让人误以为是本账号的。
 *   2. 已绑定且取数成功 → 用新值；
 *   3. 已绑定但取数失败 → **沿用上次的值并标记 stale**（同一 Profile 才沿用），
 *      并把失败原因写出来；换绑 / 解绑则丢弃，防止 A 账号额度显示在 B 账号页上。
 */
export function decideFreeQuotas(opts: {
  /** 本次取到的额度；取数失败为 undefined */
  fresh?: FreeQuota[];
  prevQuotas?: FreeQuota[];
  /** 本次使用的 CLI Profile；未绑定为 undefined */
  profile?: string;
  /** 上次是从哪个 Profile 取的（老快照没有该字段时按 default 处理） */
  prevFrom?: string;
}): { quotas: FreeQuota[] | undefined; stale: boolean } {
  // 未绑定 → 不显示任何额度（避免把来源不明的数据当成本账号的）
  if (!opts.profile) return { quotas: undefined, stale: false };
  const prevFrom = opts.prevFrom ?? 'default';
  const canInherit =
    opts.fresh === undefined &&
    prevFrom === opts.profile &&
    (opts.prevQuotas?.length ?? 0) > 0;
  return {
    quotas: opts.fresh ?? (canInherit ? opts.prevQuotas : undefined),
    stale: canInherit,
  };
}

/**
 * 从百炼的 Base URL 里提取业务空间 ID。
 * 形如 `https://ws-abcdef1234567890.cn-beijing.maas.aliyuncs.com` → `ws-abcdef1234567890`。
 * 业务空间是判断「这个 CLI 身份属于哪个阿里云账号」的关键线索。
 */
export function extractWorkspaceId(url?: string | null): string | undefined {
  if (!url) return undefined;
  const m = /https?:\/\/([^./]+)\.[^/]*maas\.aliyuncs\.com/i.exec(String(url));
  return m?.[1];
}

// ==================== 汇总拉取 ====================

/** 拉取某账号的全量数据（含探测）；allProbes=true 探测全部模型，否则只探免费/近期模型 */
export async function collectAccount(
  store: AiUsageStore,
  accountId: string,
  provider: string,
  creds: Creds,
  opts: { probe?: boolean; probeLimit?: number; bindCli?: boolean } = {}
): Promise<UsageSnapshot> {
  const h = getHandler(provider);
  const prev = store.getSnapshot(accountId);
  if (!h) {
    return { accountId, provider, ts: new Date().toISOString(), error: `暂不支持的平台：${provider}` };
  }

  const acct = await h.fetchAccount(creds);
  const models = await h.fetchModels(creds).catch(() => null);

  // 全局价目目录（与账号无关）：过期则顺带刷新，把结构化价格挂到模型清单上
  const hours = store.getConfig().probeIntervalHours || 6;
  const catalog = await store
    .refreshCatalog(provider, { maxAgeMs: hours * 3600 * 1000 })
    .catch(() => store.getCatalog(provider));
  let enrichedModels = applyCatalogPrices(models?.models || prev?.models || [], catalog?.models);
  let modelTotal = models?.total ?? prev?.modelTotal ?? enrichedModels.length;

  // 免费额度：按厂商走对应 CLI（阿里=百炼，腾讯=TokenHub）。
  // 必须核对「是否已绑定到本账号」，否则会把别账号的额度显示出来。
  let freeQuotas: FreeQuota[] | undefined;
  let cliState: UsageSnapshot['cli'];
  /** 本账号绑定的 CLI Profile（未绑定/CLI 不可用则为 undefined） */
  let profile: string | undefined;

  if (provider === 'tencent') {
    const cli = thcliAvailable();
    if (!cli.ok) {
      cliState = { ok: false, reason: cli.reason };
    } else {
      if (opts.bindCli) {
        const active = await activeThProfile().catch(() => 'default');
        const ident = await thcliAuthStatus(active).catch(() => null);
        store.updateConfig((cur) => ({
          cliBindings: { ...(cur.cliBindings || {}), [accountId]: active },
          cliSpaces: { ...(cur.cliSpaces || {}), [active]: ident?.region || ident?.site || '' },
        }));
      }
      const cfg = store.getConfig();
      const boundProfile = cfg.cliBindings?.[accountId];
      const bound = !!boundProfile;
      profile = boundProfile || undefined;
      const identity = profile
        ? await thcliAuthStatus(profile)
            .then((id) => thIdentityToCli(id))
            .catch(() => null)
        : null;
      let quotaError: string | undefined;
      if (profile) {
        try {
          const m = await fetchTokenHubModels(profile).catch(() => null);
          if (m?.models?.length) {
            const cat2 = store.getCatalog(provider);
            enrichedModels = applyCatalogPrices(m.models as ModelInfo[], cat2?.models);
            modelTotal = m.total;
          }
          freeQuotas = (await fetchTokenHubQuotas(profile)) as FreeQuota[];
        } catch (e) {
          quotaError = thcliErrorText(e);
        }
      }
      cliState = {
        ok: true,
        identity: identity || undefined,
        bound,
        boundProfile,
        boundWorkspace: boundProfile ? cfg.cliSpaces?.[boundProfile] : undefined,
        profiles: await listThProfiles().catch(() => []),
        quotaFrom: profile,
        quotaError,
        quotaFetchedAt: quotaError ? prev?.cli?.quotaFetchedAt : new Date().toISOString(),
      };
    }
  } else if (provider === 'volcengine') {
    const cli = arkcliAvailable();
    if (!cli.ok) {
      cliState = { ok: false, reason: cli.reason };
    } else {
      if (opts.bindCli) {
        const active = await activeArkProfile().catch(() => 'default');
        const ident = await arkcliAuthStatus(active).catch(() => null);
        store.updateConfig((cur) => ({
          cliBindings: { ...(cur.cliBindings || {}), [accountId]: active },
          cliSpaces: { ...(cur.cliSpaces || {}), [active]: ident?.project || ident?.region || '' },
        }));
      }
      const cfg = store.getConfig();
      const boundProfile = cfg.cliBindings?.[accountId];
      const bound = !!boundProfile;
      profile = boundProfile || undefined;
      const identity = profile
        ? await arkcliAuthStatus(profile)
            .then((id) => arkIdentityToCli(id))
            .catch(() => null)
        : null;
      let quotaError: string | undefined;
      if (profile) {
        try {
          const m = await fetchArkModels(profile).catch(() => null);
          if (m?.models?.length) {
            const cat2 = store.getCatalog(provider);
            enrichedModels = applyCatalogPrices(m.models as ModelInfo[], cat2?.models);
            modelTotal = m.total;
          }
          freeQuotas = (await fetchArkFreeQuotas(profile)) as FreeQuota[];
        } catch (e) {
          quotaError = arkcliErrorText(e);
        }
      }
      cliState = {
        ok: true,
        identity: identity || undefined,
        bound,
        boundProfile,
        boundWorkspace: boundProfile ? cfg.cliSpaces?.[boundProfile] : undefined,
        profiles: await listArkProfiles().catch(() => []),
        quotaFrom: profile,
        quotaError,
        quotaFetchedAt: quotaError ? prev?.cli?.quotaFetchedAt : new Date().toISOString(),
      };
    }
  } else if (provider === 'aliyun') {
    const cli = bailianCliAvailable();
    if (!cli.ok) {
      cliState = { ok: false, reason: cli.reason };
    } else {
      if (opts.bindCli) {
        const active = await activeCliProfile().catch(() => 'default');
        const ident = await bailianIdentity(active).catch(() => null);
        store.updateConfig((cur) => ({
          cliBindings: { ...(cur.cliBindings || {}), [accountId]: active },
          cliSpaces: { ...(cur.cliSpaces || {}), [active]: ident?.workspaceId || '' },
        }));
      }

      const cfg = store.getConfig();
      const boundProfile = cfg.cliBindings?.[accountId];
      const bound = !!boundProfile;
      profile = boundProfile || undefined;
      const identity = profile ? await bailianIdentity(profile).catch(() => null) : null;
      let quotaError: string | undefined;
      if (profile) {
        try {
          // 先用现有控制台登录态拉额度；仅「未登录/过期」才用 AK 静默换票。
          // 刷新路径不弹浏览器；也不再无脑 open-api（会覆盖浏览器票 → Team.NotAuthorised）。
          const r = await fetchFreeQuotaAuto(profile, {
            accessKeyId: creds.accessKeyId,
            accessKeySecret: creds.accessKeySecret,
            launchBrowser: false,
          });
          freeQuotas = r.quotas;
        } catch (e) {
          quotaError = cliErrorText(e);
        }
      }
      cliState = {
        ok: true,
        identity,
        bound,
        boundProfile,
        boundWorkspace: boundProfile ? cfg.cliSpaces?.[boundProfile] : undefined,
        profiles: await listCliProfiles().catch(() => []),
        quotaFrom: profile,
        quotaError,
        quotaFetchedAt: quotaError ? prev?.cli?.quotaFetchedAt : new Date().toISOString(),
      };
    }
  } else {
    cliState = { ok: false, reason: `厂商 ${provider} 尚无 CLI 额度适配` };
  }

  const quotaDecision = decideFreeQuotas({
    fresh: freeQuotas,
    prevQuotas: prev?.freeQuotas,
    profile,
    prevFrom: prev?.cli?.quotaFrom ?? prev?.cli?.boundProfile,
  });
  if (cliState) {
    cliState.quotaStale = quotaDecision.stale;
    if (quotaDecision.stale) cliState.quotaFetchedAt = prev?.cli?.quotaFetchedAt;
  }

  const snap: UsageSnapshot = {
    accountId,
    provider,
    ts: new Date().toISOString(),
    ...acct,
    models: enrichedModels,
    modelTotal,
    freeQuotas: quotaDecision.quotas,
    cli: cliState,
    probes: prev?.probes || [],
  };

  // 余额/账单/资源包/流水：本次没取到的字段沿用上次快照，不因接口失败/CLI 掉线清零。
  // acct.error 只代表部分失败（可能只是余额没取到），逐字段沿用而不是整包丢弃 ——
  // 原则同 decideFreeQuotas：宁可标注旧值，也不能把用户的数据静默清掉。
  const ACCT_KEYS = ['balance', 'spendTotal', 'aiSpend', 'spendRows', 'packages', 'billRows'] as const;
  let acctInherited = false;
  for (const k of ACCT_KEYS) {
    if (snap[k] === undefined && prev && (prev as typeof snap)[k] !== undefined) {
      (snap as Record<string, unknown>)[k] = (prev as typeof snap)[k];
      acctInherited = true;
    }
  }
  if (acctInherited) {
    snap.acctStale = true;
    snap.acctFetchedAt = prev?.acctFetchedAt;
  } else {
    snap.acctFetchedAt = new Date().toISOString();
  }

  // 探测：用户可配置探测哪些模型；默认用常用清单，再补上账单里出现过与标价为 0 的模型。
  // 避免对 356 个模型逐个打一遍（会触发限流，且没必要）。
  if (opts.probe) {
    const cfg = store.getConfig();
    const billed = (snap.billRows || [])
      .filter((b) => /百炼|大模型|dashscope|bailian/i.test(b.product))
      .map((b) => (b.instance.split(';')[2] || b.instance).trim())
      .filter(Boolean);
    const freeIds = (snap.models || []).filter((m) => m.free).map((m) => m.id);
    const configured = cfg.probeModels?.length
      ? cfg.probeModels
      : provider === 'tencent'
        ? TENCENT_DEFAULT_MODELS
        : provider === 'volcengine'
          ? VOLC_DEFAULT_MODELS
          : DEFAULT_PROBE_MODELS;

    const seen = new Set<string>();
    const targets = [...configured, ...billed, ...freeIds].filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, opts.probeLimit ?? 12);

    const results: ProbeResult[] = [];
    for (const id of targets) {
      results.push(
        await h.probe(creds, id).catch((e) => ({
          modelId: id,
          status: 'unknown' as ProbeStatus,
          message: (e as Error).message.slice(0, 100),
          ts: new Date().toISOString(),
        }))
      );
    }
    snap.probes = results;
  }

  // 与上次快照比对，记录新增/下架（首次拉取 prev 为 null，此时 added 会等于全部模型，故跳过）
  if (prev?.models?.length && snap.models?.length) {
    snap.changes = store.diffModels(prev, snap);
  } else {
    snap.changes = { added: [], removed: [] };
  }

  store.saveSnapshot(snap);
  return snap;
}
