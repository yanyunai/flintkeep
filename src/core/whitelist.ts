import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Vault } from './vault';
import { detectPublicIp, type DetectOptions } from './ipdetect';
import { aliyunSignature, aliyunEnc } from './proxy';
import { tcloudCall } from './tcloud';

/**
 * 白名单模块（整合 easy_whitelist 的能力，Node 原生实现）：
 * 探测本机公网 IP → 更新云安全组白名单。
 * 凭据直接从保险库取，**不写 env、不落盘、不进命令行**。
 *
 * - 阿里云：ECS 前缀列表（Prefix List）—— 先 DescribePrefixListAttributes 取现有条目，
 *   再 ModifyPrefixList 做「移除旧条目 + 加入当前 IP」的**替换**语义（避免旧 IP 长期滞留白名单）。
 * - 腾讯云：VPC 地址模板（Address Template）—— ModifyAddressTemplateAttribute 的
 *   AddressesExtra 本身就是整体替换，直接传当前 IP 即可。
 */

export type WhitelistProvider = 'aliyun' | 'tencent';

export interface WhitelistBinding {
  id: string;
  name?: string;
  provider: WhitelistProvider;
  /** 云账号资产 id（AK/SK 从保险库取，本表不存任何密钥） */
  assetId: string;
  region: string;
  securityGroupId?: string;
  /** 阿里云：前缀列表 ID */
  prefixListId?: string;
  /** 腾讯云：地址模板 ID */
  addressTemplateId?: string;
  enabled: boolean;
  lastIp?: string;
  lastRunAt?: string;
  lastResult?: 'ok' | 'fail' | 'skipped';
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/** 绑定存储：只含资源 ID，不含任何密钥 → 普通 JSON 即可 */
export class WhitelistStore {
  private file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'whitelist.json');
  }
  private read(): WhitelistBinding[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || [];
    } catch {
      return [];
    }
  }
  private write(list: WhitelistBinding[]) {
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
  }
  list(): WhitelistBinding[] {
    return this.read();
  }
  get(id: string): WhitelistBinding | undefined {
    return this.read().find((b) => b.id === id);
  }
  add(input: Omit<WhitelistBinding, 'id' | 'createdAt' | 'updatedAt'>): WhitelistBinding {
    const now = new Date().toISOString();
    const b: WhitelistBinding = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    const list = this.read();
    list.push(b);
    this.write(list);
    return b;
  }
  update(id: string, patch: Partial<WhitelistBinding>): WhitelistBinding | undefined {
    const list = this.read();
    const i = list.findIndex((b) => b.id === id);
    if (i < 0) return undefined;
    list[i] = { ...list[i], ...patch, id, updatedAt: new Date().toISOString() };
    this.write(list);
    return list[i];
  }
  remove(id: string): boolean {
    const list = this.read();
    const kept = list.filter((b) => b.id !== id);
    if (kept.length === list.length) return false;
    this.write(kept);
    return true;
  }

  // ===== 定时调度配置（应用内；系统级定时见 scripts/whitelist_run.ts） =====

  private schedFile(): string {
    return path.join(path.dirname(this.file), 'whitelist_schedule.json');
  }
  getSchedule(): WhitelistSchedule {
    const f = this.schedFile();
    if (!fs.existsSync(f)) return { enabled: false, intervalMinutes: 30 };
    try {
      return { enabled: false, intervalMinutes: 30, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch {
      return { enabled: false, intervalMinutes: 30 };
    }
  }
  setSchedule(patch: Partial<WhitelistSchedule>): WhitelistSchedule {
    const cur = this.getSchedule();
    const next: WhitelistSchedule = { ...cur, ...patch };
    if (next.intervalMinutes < 1) next.intervalMinutes = 1;
    // 启用时若没有下次运行时间，立即排一次；停用时清空
    if (next.enabled && !next.nextRunAt) next.nextRunAt = Date.now() + next.intervalMinutes * 60000;
    if (!next.enabled) next.nextRunAt = undefined;
    fs.writeFileSync(this.schedFile(), JSON.stringify(next, null, 2));
    return next;
  }
}

export interface WhitelistSchedule {
  enabled: boolean;
  intervalMinutes: number;
  /** 下次运行时间戳（ms）；停用为 undefined */
  nextRunAt?: number;
  lastRunAt?: string;
  lastSummary?: string;
}

// ===== 阿里云 ECS RPC 调用 =====

export interface AliyunRpcOptions {
  accessKeyId: string;
  accessKeySecret: string;
  action: string;
  params?: Record<string, string>;
  version?: string; // 默认 2014-05-26（ECS）
  endpoint?: string; // 默认 ecs.aliyuncs.com；测试可指向本地 echo
  fetcher?: (url: string, init?: any) => Promise<any>;
}

/** 组装阿里云 RPC 公共参数并签名，返回完整 query 串 */
export function buildAliyunRpcQuery(opts: AliyunRpcOptions): string {
  const params: Record<string, string> = {
    Action: opts.action,
    Format: 'JSON',
    Version: opts.version || '2014-05-26',
    AccessKeyId: opts.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(12).toString('hex'),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(opts.params || {}),
  };
  const sig = aliyunSignature(params, opts.accessKeySecret, 'GET');
  params['Signature'] = sig;
  return Object.keys(params)
    .sort()
    .map((k) => `${aliyunEnc(k)}=${aliyunEnc(params[k])}`)
    .join('&');
}

export async function aliyunRpcCall(opts: AliyunRpcOptions): Promise<any> {
  const host = opts.endpoint || 'ecs.aliyuncs.com';
  const protocol = host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https';
  const query = buildAliyunRpcQuery(opts);
  const url = `${protocol}://${host}/?${query}`;
  const fetcher = opts.fetcher || ((globalThis as any).fetch as (u: string, i?: any) => Promise<any>);
  const res = await fetcher(url, { method: 'GET' });
  const text = typeof res?.text === 'function' ? await res.text() : String(res ?? '');
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export interface AliyunUpdateResult {
  ok: boolean;
  message: string;
  added?: string[];
  removed?: string[];
}

/** 把前缀列表内容替换为当前 IP 列表（移除旧条目，加入新条目） */
export async function aliyunUpdatePrefixList(opts: {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  prefixListId: string;
  ips: string[];
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
}): Promise<AliyunUpdateResult> {
  if (!opts.ips.length) return { ok: false, message: '拒绝以空 IP 列表更新前缀列表' };

  // 1) 取现有条目
  const cur = await aliyunRpcCall({
    accessKeyId: opts.accessKeyId,
    accessKeySecret: opts.accessKeySecret,
    action: 'DescribePrefixListAttributes',
    params: { RegionId: opts.region, PrefixListId: opts.prefixListId },
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
  });
  const entries: any[] = cur?.Entries?.Entry || [];
  const oldCidrs: string[] = entries.map((e) => e?.Cidr).filter(Boolean);

  const toRemove = oldCidrs.filter((c) => !opts.ips.includes(c));
  const toAdd = opts.ips.filter((ip) => !oldCidrs.includes(ip));

  if (!toRemove.length && !toAdd.length) {
    return { ok: true, message: '前缀列表内容已是最新，无需变更', added: [], removed: [] };
  }

  // 2) 移除旧 + 加入新
  const params: Record<string, string> = { RegionId: opts.region, PrefixListId: opts.prefixListId };
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  toRemove.forEach((c, i) => {
    params[`RemoveEntry.${i + 1}.Cidr`] = c;
  });
  toAdd.forEach((ip, i) => {
    params[`AddEntry.${i + 1}.Cidr`] = ip;
    params[`AddEntry.${i + 1}.Description`] = `flintkeep@${stamp}`;
  });

  const res = await aliyunRpcCall({
    accessKeyId: opts.accessKeyId,
    accessKeySecret: opts.accessKeySecret,
    action: 'ModifyPrefixList',
    params,
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
  });
  if (res?.Code && res.Code !== 'Success') {
    return { ok: false, message: `阿里云返回错误 ${res.Code}: ${res.Message || ''}`, added: toAdd, removed: toRemove };
  }
  return { ok: true, message: `已更新为 ${opts.ips.join(', ')}`, added: toAdd, removed: toRemove };
}

// ===== 腾讯云 VPC 调用 =====

export async function tencentUpdateTemplate(opts: {
  secretId: string;
  secretKey: string;
  region: string;
  addressTemplateId: string;
  ips: string[];
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
}): Promise<{ ok: boolean; message: string }> {
  if (!opts.ips.length) return { ok: false, message: '拒绝以空 IP 列表更新地址模板' };
  const r = await tcloudCall({
    secretId: opts.secretId,
    secretKey: opts.secretKey,
    region: opts.region,
    action: 'ModifyAddressTemplateAttribute',
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
    payload: {
      AddressTemplateId: opts.addressTemplateId,
      // AddressesExtra 为整体替换语义
      AddressesExtra: opts.ips.map((ip) => ({ Address: ip, Description: 'flintkeep' })),
    },
  });
  if (!r.ok) return { ok: false, message: r.error || '腾讯云调用失败' };
  return { ok: true, message: `已更新为 ${opts.ips.join(', ')}` };
}

// ===== 云资源下拉数据（地域 / 白名单目标） =====

/**
 * 地域 ID 与地址模板 ID 都是云上生成的字符串，让用户手填既不知道从哪复制、又极易填错
 * （填错了执行时才报「找不到资源」）。所以这两项一律**下拉选择**：先用账号的 AK/SK
 * 拉取真实列表，用户点一下即可。AK/SK 只在本次请求内使用，不落盘。
 */
export interface CloudOption {
  id: string;
  name: string;
  /** 副标题：如地址模板里现有的 IP，便于确认选的是不是那个模板 */
  desc?: string;
}

/**
 * 腾讯云的地域兜底值。
 * `X-TC-Region` 头为空会被网关拒（`MissingParameter: Region`），
 * 所以任何腾讯云调用都必须带一个合法地域；这里用广州。
 */
export const TC_DEFAULT_REGION = 'ap-guangzhou';

/** 腾讯云地域列表（DescribeRegions） */
export async function tencentListRegions(opts: {
  secretId: string;
  secretKey: string;
  /**
   * 兜底地域。DescribeRegions 本身是全局接口，但腾讯云网关要求 X-TC-Region 头**非空**，
   * 传空串会直接报 `MissingParameter: The request is missing the required parameter Region`（实测）。
   * 传任意合法地域即可，返回的仍是全部地域列表。
   */
  region?: string;
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
}): Promise<CloudOption[]> {
  const r = await tcloudCall({
    secretId: opts.secretId,
    secretKey: opts.secretKey,
    region: opts.region || TC_DEFAULT_REGION,
    action: 'DescribeRegions',
    payload: {},
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
  });
  if (!r.ok) throw new Error(r.error || '腾讯云 DescribeRegions 失败');
  const set = r.data?.Response?.RegionSet || [];
  return set.map((x: any) => ({
    id: String(x.Region),
    name: x.RegionName ? `${x.RegionName}（${x.Region}）` : String(x.Region),
  }));
}

/** 腾讯云 VPC 地址模板列表（地域相关，DescribeAddressTemplates） */
export async function tencentListAddressTemplates(opts: {
  secretId: string;
  secretKey: string;
  region: string;
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
}): Promise<CloudOption[]> {
  const r = await tcloudCall({
    secretId: opts.secretId,
    secretKey: opts.secretKey,
    region: opts.region,
    action: 'DescribeAddressTemplates',
    payload: { Limit: '100' },
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
  });
  if (!r.ok) throw new Error(r.error || '腾讯云 DescribeAddressTemplates 失败');
  const set = r.data?.Response?.AddressTemplateSet || [];
  return set.map((x: any) => {
    const addrs: string[] = x.AddressSet || [];
    return {
      id: String(x.AddressTemplateId),
      name: x.AddressTemplateName ? `${x.AddressTemplateName}（${x.AddressTemplateId}）` : String(x.AddressTemplateId),
      desc: addrs.length ? `现有 ${addrs.length} 条：${addrs.slice(0, 3).join(', ')}${addrs.length > 3 ? ' …' : ''}` : '（暂无条目）',
    };
  });
}

/** 阿里云地域列表（ECS DescribeRegions） */
export async function aliyunListRegions(opts: {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
}): Promise<CloudOption[]> {
  const r = await aliyunRpcCall({
    accessKeyId: opts.accessKeyId,
    accessKeySecret: opts.accessKeySecret,
    action: 'DescribeRegions',
    params: {},
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
  });
  const set = r?.Regions?.Region || [];
  return (Array.isArray(set) ? set : []).map((x: any) => ({
    id: String(x.RegionId),
    name: x.LocalName ? `${x.LocalName}（${x.RegionId}）` : String(x.RegionId),
  }));
}

/** 阿里云前缀列表（地域相关，DescribePrefixLists） */
export async function aliyunListPrefixLists(opts: {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  endpoint?: string;
  fetcher?: (url: string, init?: any) => Promise<any>;
}): Promise<CloudOption[]> {
  const r = await aliyunRpcCall({
    accessKeyId: opts.accessKeyId,
    accessKeySecret: opts.accessKeySecret,
    action: 'DescribePrefixLists',
    params: { RegionId: opts.region },
    endpoint: opts.endpoint,
    fetcher: opts.fetcher,
  });
  const set = r?.PrefixLists?.PrefixList || [];
  return (Array.isArray(set) ? set : []).map((x: any) => ({
    id: String(x.PrefixListId),
    name: x.PrefixListName ? `${x.PrefixListName}（${x.PrefixListId}）` : String(x.PrefixListId),
    desc: x.MaxEntries != null ? `最多 ${x.MaxEntries} 条` : undefined,
  }));
}

/** 统一入口：按厂商拉「地域 + 白名单目标」下拉数据；region 为空则只拉地域 */
export async function listWhitelistOptions(opts: {
  provider: WhitelistProvider;
  accessKeyId: string;
  accessKeySecret: string;
  region?: string;
  /** 账号资产上填的地域，用作拉取地域列表时的兜底 */
  fallbackRegion?: string;
}): Promise<{ regions: CloudOption[]; targets: CloudOption[] }> {
  if (opts.provider === 'tencent') {
    const regions = await tencentListRegions({
      secretId: opts.accessKeyId,
      secretKey: opts.accessKeySecret,
      region: opts.region || opts.fallbackRegion || TC_DEFAULT_REGION,
    });
    const targets = opts.region
      ? await tencentListAddressTemplates({
          secretId: opts.accessKeyId,
          secretKey: opts.accessKeySecret,
          region: opts.region,
        })
      : [];
    return { regions, targets };
  }
  const regions = await aliyunListRegions({
    accessKeyId: opts.accessKeyId,
    accessKeySecret: opts.accessKeySecret,
  });
  const targets = opts.region
    ? await aliyunListPrefixLists({
        accessKeyId: opts.accessKeyId,
        accessKeySecret: opts.accessKeySecret,
        region: opts.region,
      })
    : [];
  return { regions, targets };
}

// ===== 执行一个绑定 =====

export interface RunResult {
  bindingId: string;
  provider: WhitelistProvider;
  ok: boolean;
  skipped?: boolean;
  ip?: string;
  ips?: string[];
  message: string;
}

/** 执行单个白名单绑定：探测 IP → 与上次比对（相同则跳过，避免打满 API）→ 调云 API → 审计 */
export async function runBinding(
  vault: Vault,
  store: WhitelistStore,
  binding: WhitelistBinding,
  opts: { detect?: DetectOptions; force?: boolean } = {}
): Promise<RunResult> {
  const finish = (r: RunResult) => {
    store.update(binding.id, {
      lastRunAt: new Date().toISOString(),
      lastResult: r.skipped ? 'skipped' : r.ok ? 'ok' : 'fail',
      lastMessage: r.message,
      lastIp: r.ip,
    });
    vault.logWhitelistRun({
      bindingId: binding.id,
      provider: binding.provider,
      assetId: binding.assetId,
      region: binding.region,
      target: binding.prefixListId || binding.addressTemplateId,
      ok: r.ok,
      skipped: !!r.skipped,
      ips: r.ips || [],
      message: r.message,
    });
    return r;
  };

  if (!binding.enabled) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, skipped: true, message: '该绑定已停用' });
  }

  // 凭据从保险库取（含审计）；不写 env、不落盘
  const asset = vault.get(binding.assetId);
  if (!asset) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '云账号资产不存在' });
  }

  let ips: string[] = [];
  try {
    ips = await detectPublicIp(opts.detect);
  } catch (e) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '探测公网 IP 失败: ' + (e as Error).message });
  }
  if (!ips.length) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '未探测到公网 IP' });
  }

  // IP 未变化则不调 API（云 API 有 QPS 限制）
  if (!opts.force && binding.lastIp && binding.lastIp === ips[0]) {
    return finish({
      bindingId: binding.id,
      provider: binding.provider,
      ok: true,
      skipped: true,
      ip: ips[0],
      ips,
      message: `IP 未变化（${ips[0]}），跳过调用`,
    });
  }

  const ak = asset.accessKeyId || '';
  const sk = asset.secretAccessKey || '';
  if (!ak || !sk) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '该云账号资产缺少 AccessKey' });
  }

  // 单个绑定的网络/API 异常不应中断整批执行，统一收敛为失败结果
  if (binding.provider === 'aliyun') {
    if (!binding.prefixListId) {
      return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '缺少前缀列表 ID (prefixListId)' });
    }
    try {
      const r = await aliyunUpdatePrefixList({
        accessKeyId: ak,
        accessKeySecret: sk,
        region: binding.region,
        prefixListId: binding.prefixListId,
        ips,
      });
      return finish({ bindingId: binding.id, provider: binding.provider, ok: r.ok, ip: ips[0], ips, message: r.message });
    } catch (e) {
      return finish({ bindingId: binding.id, provider: binding.provider, ok: false, ips, message: '调用阿里云失败: ' + (e as Error).message });
    }
  }

  // tencent
  if (!binding.addressTemplateId) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '缺少地址模板 ID (addressTemplateId)' });
  }
  // 腾讯云网关要求 X-TC-Region 非空，空地域会被拒（MissingParameter: Region）——
  // 与其抛一个看不懂的云错误，不如在这里直接说清楚缺什么
  if (!binding.region) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, message: '缺少地域（region），腾讯云调用必须指定地域' });
  }
  try {
    const r = await tencentUpdateTemplate({
      secretId: ak,
      secretKey: sk,
      region: binding.region,
      addressTemplateId: binding.addressTemplateId,
      ips,
    });
    return finish({ bindingId: binding.id, provider: binding.provider, ok: r.ok, ip: ips[0], ips, message: r.message });
  } catch (e) {
    return finish({ bindingId: binding.id, provider: binding.provider, ok: false, ips, message: '调用腾讯云失败: ' + (e as Error).message });
  }
}

/** 执行全部启用中的绑定 */
export async function runAll(
  vault: Vault,
  store: WhitelistStore,
  opts: { detect?: DetectOptions; force?: boolean; onlyId?: string } = {}
): Promise<RunResult[]> {
  const list = store.list().filter((b) => (opts.onlyId ? b.id === opts.onlyId : b.enabled));
  const out: RunResult[] = [];
  for (const b of list) {
    try {
      out.push(await runBinding(vault, store, b, opts));
    } catch (e) {
      // 兜底：任何未预期异常也只让该条失败，不影响其余绑定
      out.push({ bindingId: b.id, provider: b.provider, ok: false, message: '执行异常: ' + (e as Error).message });
    }
  }
  return out;
}
