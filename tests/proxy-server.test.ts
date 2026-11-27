import * as http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { ProxyServer } from '../src/core/proxy';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * Model B 代理服务端到端：令牌鉴权 → 取资产 → 注入真实密钥 → 转发上游。
 * 上游用本地 echo，断言「上游到底收到了什么」——这是整条链路唯一能证伪的地方。
 */
const UPSTREAM_PORT = 18973;
const PROXY_PORT = 18974;
const DENY_PROXY_PORT = 18975;

type Seen = { method: string; url: string; headers: Record<string, any>; body: string };

let seen: Seen;
let upstream: http.Server;
let proxy: ProxyServer;
let denyProxy: ProxyServer;
let vault: Vault;
let dir: string;
let token = '';
let assetId = '';

const url = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;

beforeAll(async () => {
  dir = tmpDir('fk-proxy-');
  vault = new Vault(dir, PP);
  const asset = vault.add({
    type: 'api_key',
    name: 'proxy-target',
    secret: 'FAKE_PROXY_SECRET',
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
    proxyInject: { mode: 'header' },
    tags: [],
  });
  assetId = asset.id;
  token = vault.issueProxyToken(assetId, 3600);

  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method || '', url: req.url || '', headers: req.headers, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve()));

  proxy = new ProxyServer(vault, PROXY_PORT, () => true);
  await proxy.listen();
  // 第二个实例：模拟设置里「允许代理转发到 http 上游」关闭
  denyProxy = new ProxyServer(vault, DENY_PROXY_PORT, () => false);
  await denyProxy.listen();
});

afterAll(async () => {
  await proxy?.close();
  await denyProxy?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  cleanup(dir);
});

describe('令牌鉴权', () => {
  it('缺令牌 401，无效令牌 403', async () => {
    const none = await fetch(url(PROXY_PORT, `/${assetId}/ping`));
    expect(none.status).toBe(401);

    const bad = await fetch(url(PROXY_PORT, `/${assetId}/ping`), { headers: { Authorization: 'Bearer nope' } });
    expect(bad.status).toBe(403);
  });

  it('过期令牌 403', async () => {
    const short = vault.issueProxyToken(assetId, 1);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await fetch(url(PROXY_PORT, `/${assetId}/ping`), { headers: { Authorization: `Bearer ${short}` } });
    expect(r.status).toBe(403);
  });
});

describe('转发与注入', () => {
  it('注入真实密钥、丢弃调用方凭据、保留白名单头、透传路径与 query', async () => {
    const r = await fetch(url(PROXY_PORT, `/${assetId}/api/echo?q=1&tok=should-be-stripped`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, // 代理自己的令牌，不该被带到上游
        Cookie: 'sid=secret',
        'X-Trace': 'abc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(r.status).toBe(200);
    expect(seen.url.includes('/api/echo')).toBe(true);
    expect(seen.url.includes('q=1')).toBe(true);
    expect(seen.url.includes('tok=')).toBe(false);
    expect(seen.headers.authorization).toBe('Bearer FAKE_PROXY_SECRET'); // 注入头覆盖调用方
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-trace']).toBe('abc');
    expect(seen.body).toBe('{"hello":"world"}');
  });

  it('同一令牌在有效期内可重复使用（回归：曾被一次消费后失效）', async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = await fetch(url(PROXY_PORT, `/${assetId}/api/repeat?n=${i}`), { headers: { Authorization: `Bearer ${token}` } });
      expect(r.status).toBe(200);
    }
  });

  it('资产未配置 baseUrl 时 400', async () => {
    const bare = vault.add({ type: 'api_key', name: 'no-base', secret: 'S', tags: [] });
    const t = vault.issueProxyToken(bare.id, 600);
    const r = await fetch(url(PROXY_PORT, `/${bare.id}/x`), { headers: { Authorization: `Bearer ${t}` } });
    expect(r.status).toBe(400);
  });
});

describe('http 上游保险', () => {
  it('未允许明文上游时拒绝并给出可行提示', async () => {
    const r = await fetch(url(DENY_PROXY_PORT, `/${assetId}/ping`), { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(String(body.error).includes('http://')).toBe(true);
    expect(!!body.hint).toBe(true);
  });
});