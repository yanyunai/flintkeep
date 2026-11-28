/**
 * 关于 / 更新检查路由。
 *
 * 两个端点：
 *   GET /api/about        产品名、版本、开源地址、许可证、官网、一句话介绍（锁态也可用）
 *   GET /api/update/check 问 GitHub 有没有新版本，返回「有没有 / 最新版本 / 下载页」
 *
 * 设计取舍：
 * - **不偷偷请求**：只在用户点「检查更新」时发一次；结果缓存 10 分钟，避免把 GitHub
 *   匿名配额（60 次/小时/IP）打光。
 * - **只查 release，不查提交**：判断「有没有新版本」用正式发布，不用分支提交——
 *   开发仓天天在提交，按提交提示升级会让用户永远看到「有新版本」。
 * - **没有 release 时回退 tags**：仓库刚开源、还没打 release 的早期阶段也能用。
 * - **不自动安装**：本项目尚未接 electron-builder 与签名公证，静默替换安装包在 macOS
 *   上会被系统拦住；这里只做「检查 + 给下载页」，把限制如实写进界面（见 docs/05）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as http from 'node:http';
import { send } from './http-util';
import { t } from '../shared/i18n';
import type { Vault } from '../core/vault';
import { isNewerVersion, tagToVersion } from '../core/version';

const REPO = 'yanyunai/flintkeep';
const SITE = 'https://flintkeep.pages.dev';
const RELEASES_URL = `https://github.com/${REPO}/releases`;

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export type UpdateInfo = {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  /** 有 release 时指向该 release，否则指向 releases 列表 */
  url: string;
  publishedAt: string | null;
  notes: string | null;
  source: 'release' | 'tag' | 'none';
};

/** 读 package.json 的版本号；读不到就用 0.0.0（宁可「已是最新」也不误报升级） */
export function readAppVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // 源码布局 src/server/ → ../../package.json；编译后按工作目录兜底
    for (const p of [path.join(here, '..', '..', 'package.json'), path.join(process.cwd(), 'package.json')]) {
      if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'))?.version;
        if (typeof v === 'string' && v) return v;
      }
    }
  } catch {
    /* 版本号读不到不应影响其它功能 */
  }
  return '0.0.0';
}

/** 关于信息（版本号每次现读，避免开发中改了 package.json 还显示旧号） */
export function aboutInfo() {
  return {
    name: '燧垒 FlintKeep',
    version: readAppVersion(),
    repo: `https://github.com/${REPO}`,
    site: SITE,
    license: 'AGPL-3.0-only',
    releases: RELEASES_URL,
    summary: '本地加密的基础设施凭证与资产保险库：Agent 通过 MCP 使用密钥，但永远看不到密钥。',
  };
}

type Json = (url: string, init?: RequestInit) => Promise<{ status: number; body: any }>;

/** 默认 fetcher：带超时，避免「检查更新」把请求挂住 */
const httpJson: Json = async (url, init = {}) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'flintkeep-update-check',
        ...(init.headers || {}),
      },
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 问 GitHub 有没有新版本。fetcher 可注入（单测用），默认走真实网络。
 * 任何失败都不抛：网络不通 / 404 / 解析不出 → hasUpdate=false，source='none'，
 * 让界面显示「暂时查不到」，而不是把升级当成错误弹给用户。
 */
export async function checkForUpdate(
  current: string,
  opts: { repo?: string; fetcher?: Json } = {}
): Promise<UpdateInfo> {
  const repo = opts.repo || REPO;
  const fetcher = opts.fetcher || httpJson;
  const base: UpdateInfo = {
    current,
    latest: null,
    hasUpdate: false,
    url: `https://github.com/${repo}/releases`,
    publishedAt: null,
    notes: null,
    source: 'none',
  };

  const rel = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, { method: 'GET' });
  if (rel.status === 200 && rel.body?.tag_name) {
    const latest = tagToVersion(rel.body.tag_name);
    return {
      ...base,
      latest,
      hasUpdate: isNewerVersion(latest, current),
      url: rel.body.html_url || base.url,
      publishedAt: rel.body.published_at ?? null,
      notes: typeof rel.body.body === 'string' ? rel.body.body.slice(0, 2000) : null,
      source: 'release',
    };
  }

  // 还没打 release 的早期阶段：退一步看 tag，至少能告诉用户「仓库里有更新的标签」
  const tags = await fetcher(`https://api.github.com/repos/${repo}/tags?per_page=1`, { method: 'GET' });
  if (tags.status === 200 && Array.isArray(tags.body) && tags.body[0]?.name) {
    const latest = tagToVersion(tags.body[0].name);
    return { ...base, latest, hasUpdate: isNewerVersion(latest, current), source: 'tag' };
  }

  return base;
}

let cache: { at: number; info: UpdateInfo } | null = null;

/** 测试与「立即重查」用：清掉缓存 */
export function clearUpdateCache(): void {
  cache = null;
}

export type UpdateRouteCtx = {
  vault: Vault | null;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  p: string;
  /** 单测注入 */
  fetcher?: Json;
  now?: () => number;
};

export async function handleUpdateRoutes(ctx: UpdateRouteCtx): Promise<boolean> {
  const { vault, req, res, p } = ctx;

  if (p === '/api/about' && req.method === 'GET') {
    send(res, 200, aboutInfo());
    return true;
  }

  if (p === '/api/update/check' && req.method === 'GET') {
    // 锁定时不做任何外部请求：与「锁定即断开」的整体策略一致
    if (!vault || vault.locked) {
      send(res, 423, { error: t('err.unlockNeeded'), needUnlock: true, locked: true });
      return true;
    }
    const now = ctx.now ? ctx.now() : Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      send(res, 200, { ...cache.info, cached: true });
      return true;
    }
    try {
      const info = await checkForUpdate(readAppVersion(), { fetcher: ctx.fetcher });
      cache = { at: now, info };
      send(res, 200, info);
    } catch (e: any) {
      // 检查更新失败不该挡住设置页，按「暂时查不到」返回
      send(res, 200, {
        current: readAppVersion(),
        latest: null,
        hasUpdate: false,
        url: RELEASES_URL,
        publishedAt: null,
        notes: null,
        source: 'none',
        error: e?.message || 'check failed',
      });
    }
    return true;
  }

  return false;
}
