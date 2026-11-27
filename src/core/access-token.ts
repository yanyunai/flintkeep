import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock } from './file-lock';
import { Vault } from './vault';
import { Asset } from './schema';
import { normalizeAssetType } from './mcp-meta';

/**
 * 访问令牌（服务账号语义的 S1）。
 *
 * 定位：给无人值守的 Agent/CI 一个「能换短期凭据、但解不开整库」的凭据。
 * - 令牌本身不含解密能力，换到的只是代理令牌 / 堡垒命令；
 * - 只存 SHA-256 哈希，明文仅在创建时返回一次；
 * - scope 必须非空（assets 或 types），不允许「一令牌全库」；
 * - 撤销/过期每次换发都查，不缓存。
 *
 * 存储是独立文件（0600），不随加密库走备份：scope 里只有资产 id，没有密钥。
 */

export type TokenCap = 'proxy' | 'ssh';
export const ACCESS_TOKEN_PREFIX = 'fksa_';
const FILE = 'access_tokens.json';

export interface TokenScope {
  assets: string[];
  types: string[];
}

export interface AccessTokenRecord {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  scope: TokenScope;
  caps: TokenCap[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedFrom: string | null;
}

/** 对外视图：绝不包含 hash */
export interface AccessTokenView {
  id: string;
  name: string;
  prefix: string;
  scope: TokenScope;
  caps: TokenCap[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedFrom: string | null;
  active: boolean;
  daysLeft: number | null;
}

interface StoreFile {
  v: number;
  tokens: AccessTokenRecord[];
}

const CAPS: TokenCap[] = ['proxy', 'ssh'];

function toView(r: AccessTokenRecord): AccessTokenView {
  const now = Date.now();
  const expires = r.expiresAt ? new Date(r.expiresAt).getTime() : 0;
  const active = !r.revokedAt && (!expires || expires > now);
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scope: { assets: [...r.scope.assets], types: [...r.scope.types] },
    caps: [...r.caps],
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    lastUsedAt: r.lastUsedAt,
    lastUsedFrom: r.lastUsedFrom,
    active,
    daysLeft: expires ? Math.max(0, Math.ceil((expires - now) / 86400000)) : null,
  };
}

export class AccessTokenStore {
  private file: string;
  private lockFile: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, FILE);
    this.lockFile = this.file + '.lock';
  }

  private readRaw(): StoreFile {
    try {
      if (!fs.existsSync(this.file)) return { v: 1, tokens: [] };
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { v: Number(j?.v) || 1, tokens: Array.isArray(j?.tokens) ? j.tokens : [] };
    } catch {
      // 文件坏掉时按空库处理：宁可让令牌失效，也不要崩掉整个换发路径
      return { v: 1, tokens: [] };
    }
  }

  private writeRaw(data: StoreFile): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows 等平台忽略 */
    }
  }

  private lock<T>(fn: () => T): T {
    return withFileLock(this.lockFile, fn, { timeoutMs: 3000, staleMs: 15000 });
  }

  create(input: { name: string; assets?: string[]; types?: string[]; caps?: TokenCap[]; days?: number }): {
    token: string;
    view: AccessTokenView;
  } {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('请给令牌起个名字（便于审计与撤销）');
    if (name.length > 40) throw new Error('令牌名字不超过 40 字符');
    const assets = [...new Set((input.assets || []).map((s) => String(s).trim()).filter(Boolean))];
    const types = [...new Set((input.types || []).map((s) => String(s).trim()).filter(Boolean))];
    if (!assets.length && !types.length) {
      throw new Error('scope 不能为空：至少用 --assets 或 --types 指定能访问哪些资产（不允许一令牌全库）');
    }
    const caps = [...new Set((input.caps || CAPS).map((c) => String(c).trim() as TokenCap))].filter(Boolean);
    if (!caps.length) throw new Error('能力不能为空：proxy / ssh');
    for (const c of caps) if (!CAPS.includes(c)) throw new Error(`未知能力「${c}」（只支持 proxy / ssh）`);
    const days = Number(input.days ?? 30);
    if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('有效期天数 1–365');

    const token = ACCESS_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const rec: AccessTokenRecord = {
      id: crypto.randomUUID(),
      name,
      hash: crypto.createHash('sha256').update(token).digest('hex'),
      prefix: token.slice(0, 12),
      scope: { assets, types },
      caps,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      lastUsedFrom: null,
    };
    this.lock(() => {
      const data = this.readRaw();
      data.tokens.push(rec);
      this.writeRaw(data);
    });
    return { token, view: toView(rec) };
  }

  list(): AccessTokenView[] {
    return this.readRaw()
      .tokens.map(toView)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** 撤销：支持完整 id 或唯一前缀；返回被撤销的记录视图 */
  revoke(idOrPrefix: string): AccessTokenView | null {
    const key = String(idOrPrefix || '').trim();
    if (!key) return null;
    return this.lock(() => {
      const data = this.readRaw();
      const hits = data.tokens.filter((t) => t.id === key || t.prefix === key || t.prefix.startsWith(key));
      if (hits.length !== 1) return null;
      const rec = hits[0];
      if (!rec.revokedAt) rec.revokedAt = new Date().toISOString();
      this.writeRaw(data);
      return toView(rec);
    });
  }

  /**
   * 校验令牌：哈希比对（防时序）+ 撤销 + 过期。
   * 返回 error code 而不是布尔，便于 REST 层给出可区分的响应。
   */
  verify(
    token: string
  ): { record: AccessTokenRecord } | { error: 'token.invalid' | 'token.expired' | 'token.revoked' } {
    const raw = String(token || '').trim();
    if (!raw || !raw.startsWith(ACCESS_TOKEN_PREFIX)) return { error: 'token.invalid' };
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const bufHash = Buffer.from(hash, 'hex');
    for (const rec of this.readRaw().tokens) {
      const recBuf = Buffer.from(String(rec.hash || ''), 'hex');
      if (recBuf.length !== bufHash.length) continue;
      if (!crypto.timingSafeEqual(recBuf, bufHash)) continue;
      if (rec.revokedAt) return { error: 'token.revoked' };
      if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= Date.now()) return { error: 'token.expired' };
      return { record: rec };
    }
    return { error: 'token.invalid' };
  }

  /** 记录一次使用（供审计与「长期不用就撤销」判断） */
  touch(id: string, from?: string): void {
    this.lock(() => {
      const data = this.readRaw();
      const rec = data.tokens.find((t) => t.id === id);
      if (!rec) return;
      rec.lastUsedAt = new Date().toISOString();
      if (from) rec.lastUsedFrom = from;
      this.writeRaw(data);
    });
  }

  /** scope 判定：资产 id 命中，或类型命中 */
  static scopeAllows(rec: AccessTokenRecord, asset: Asset): boolean {
    if (rec.scope.assets.includes(asset.id)) return true;
    return rec.scope.types.includes(String(asset.type));
  }

  static capAllows(rec: AccessTokenRecord, cap: TokenCap): boolean {
    return rec.caps.includes(cap);
  }
}

/**
 * 目标解析（REST 与 CLI 共用）：id / 名称 / 「类型:序号」/ 纯序号 / 唯一模糊。
 * 与 MCP 的口径保持一致：让调用方直接说「server:3」「prod-web」。
 */
/** 从「URL / host:port / 纯主机」里取出主机名，用于按 IP 定位资产 */
function hostOf(v: string): string {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      return new URL(s).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  return s.split('/')[0].split(':')[0].toLowerCase();
}

export function findAssetTarget(
  vault: Vault,
  target: string,
  aliases: Record<string, string> = {}
): { asset?: Asset; candidates: Asset[] } {
  const t = String(target || '').trim();
  if (!t) return { candidates: [] };
  const rows = vault.list();
  const byId = rows.find((a) => a.id === t);
  if (byId) return { asset: byId, candidates: [] };

  const exact = rows.filter((a) => String(a.name || '').toLowerCase() === t.toLowerCase());
  if (exact.length === 1) return { asset: exact[0], candidates: [] };

  // 按主机地址定位：Agent 手里常常只有一个 IP（卡片摘要、上游日志、报错信息）。
  // 只支持名称的话，它会退化成「按默认 22 端口直连」——而真实 SSH 端口往往不是 22，
  // 于是在 65461 这种机器上永远连不上，还会被误判成对方防火墙拦截。
  const tHost = hostOf(t);
  if (tHost) {
    // 两级匹配：先只比「真正用来连的主机」（sshHost / publicIp / ip）。
    // 把 baseUrl / panelUrl 一起算的话，同一台机器上的宝塔面板会让「按 IP 找 SSH」
    // 永远命中多条 —— 明明库里只有一条 SSH，却报歧义。
    const strict = rows.filter((a) => [a.sshHost, a.publicIp, a.ip].some((v) => v && hostOf(String(v)) === tHost));
    if (strict.length === 1) return { asset: strict[0], candidates: [] };
    if (strict.length > 1) return { candidates: strict.slice(0, 8) };
    const loose = rows.filter((a) => [a.baseUrl, a.panelUrl].some((v) => v && hostOf(String(v)) === tHost));
    if (loose.length === 1) return { asset: loose[0], candidates: [] };
    if (loose.length > 1) return { candidates: loose.slice(0, 8) };
  }

  const typed = /^([^:：]+)[:：]\s*(\d+)$/.exec(t);
  if (typed) {
    const rawType = typed[1].trim();
    const no = Number(typed[2]);
    const direct = rows.find((a) => String(a.type) === rawType && Number(a.no) === no);
    if (direct) return { asset: direct, candidates: [] };
    const ty = normalizeAssetType(rawType, aliases);
    if (ty) {
      const hit = rows.find((a) => a.type === ty && Number(a.no) === no);
      if (hit) return { asset: hit, candidates: [] };
    }
  }
  if (/^\d+$/.test(t)) {
    const hits = rows.filter((a) => Number(a.no) === Number(t));
    if (hits.length === 1) return { asset: hits[0], candidates: [] };
  }
  const fuzzy = vault.search(t);
  if (fuzzy.length === 1) return { asset: fuzzy[0], candidates: [] };
  return { candidates: (exact.length ? exact : fuzzy).slice(0, 8) };
}
