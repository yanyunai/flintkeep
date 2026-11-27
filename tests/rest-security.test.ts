import * as http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { PP, cleanup, tmpDir } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * REST 鉴权矩阵（进程内起服务，不 spawn 子进程）。
 *
 * 这里的顺序就是安全语义：Host 校验 → 免会话端点 → 解锁门（跨站 + 会话）→ 业务路由。
 * 任何重构只要打乱一处，这个文件必须红。
 */
const PORT = 18990;
const DATA_DIR = tmpDir('fk-rest-');

let startAppServer: () => Promise<{ port: number }>;
let stopAppServer: () => Promise<void>;
let session = '';

async function api(
  p: string,
  opt: { method?: string; body?: any; auth?: boolean; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
  if (opt.auth !== false && session) headers['X-FK-Session'] = session;
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: opt.method || 'GET',
    headers,
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, setCookie };
}

/** 用裸 http 请求伪造 Host（fetch 不允许改 host 头） */
function rawHostRequest(host: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/locked', method: 'GET', headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

beforeAll(async () => {
  process.env.PORT = String(PORT);
  process.env.PROXY_PORT = String(PORT + 1);
  process.env.SSH_PROXY_PORT = String(PORT + 2);
  process.env.VAULT_DATA_DIR = DATA_DIR;
  // 先把库「建出来」但不解锁服务：这样锁定态用例才有意义，错误口令也才有 401 可谈
  new Vault(DATA_DIR, PP);
  // DATA_DIR 在模块加载时读取，所以必须动态 import
  const mod = await import('../server');
  startAppServer = mod.startAppServer;
  stopAppServer = mod.stopAppServer;
  await startAppServer();
});

afterAll(async () => {
  await stopAppServer?.();
  cleanup(DATA_DIR);
});

describe('锁定态矩阵', () => {
  it('免会话端点可用，其余接口 423', async () => {
    const locked = await api('/api/locked', { auth: false });
    expect(locked.status).toBe(200);
    expect(locked.body.locked).toBe(true);

    const settings = await api('/api/settings', { auth: false });
    expect(settings.status).toBe(200); // 托盘要读关窗行为

    const assets = await api('/api/assets', { auth: false });
    expect(assets.status).toBe(423);

    const writeSettings = await api('/api/settings', { method: 'PUT', auth: false, body: { autoLockMinutes: 10 } });
    expect(writeSettings.status).toBe(423);
  });

  it('非回环 Host 被拒（DNS rebinding 防护）', async () => {
    expect(await rawHostRequest('evil.example')).toBe(403);
    expect(await rawHostRequest(`127.0.0.1:${PORT}`)).toBe(200);
  });
});

describe('解锁与会话', () => {
  it('库已存在时错误口令 401；正确口令解锁并签发会话', async () => {
    const bad = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: 'wrong-pass' } });
    expect(bad.status).toBe(401);
    // 一次失败就会进入退避窗口（1s 起）：不等窗口结束，正确口令同样吃 429
    await sleep(Number(bad.body.retryAfterMs || 1000) + 150);

    const ok = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: PP } });
    expect(ok.status).toBe(200);
    session = ok.body.session || (ok.setCookie.match(/fk_sid=([^;]+)/) || [])[1] || '';
    expect(!!session).toBe(true);

    const locked = await api('/api/locked', { auth: false });
    expect(locked.body.locked).toBe(false);
  });

  it('无会话 / 伪造会话一律 401', async () => {
    expect((await api('/api/assets', { auth: false })).status).toBe(401);
    expect((await api('/api/assets', { auth: false, headers: { 'X-FK-Session': 'fk_sid_bogus' } })).status).toBe(401);
  });

  it('跨站写被 403，跨站读放行', async () => {
    const cross = await api('/api/assets', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: { type: 'note', name: 'x', tags: [] },
    });
    expect(cross.status).toBe(403);
    const crossGet = await api('/api/assets', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossGet.status).toBe(200);
  });

  it('解锁后可正常读写资产', async () => {
    const created = await api('/api/assets', {
      method: 'POST',
      body: { type: 'server', name: 'rest-01', publicIp: '198.51.100.11', tags: [] },
    });
    expect(created.status).toBe(200);
    const list = await api('/api/assets');
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((a: any) => a.id === created.body.id)).toBe(true);
  });

  it('活动心跳不挂会话时被拒（否则同机进程能让库永不自动锁）', async () => {
    expect((await api('/api/activity', { method: 'POST', auth: false })).status).toBe(401);
    expect((await api('/api/activity', { method: 'POST' })).status).toBe(200);
  });

  it('审计 ?limit=N 真的只返回 N 条（以前静默忽略、一律 200 条）', async () => {
    const five = await api('/api/audit?limit=5');
    expect(five.status).toBe(200);
    expect(Array.isArray(five.body)).toBe(true);
    expect(five.body.length <= 5).toBe(true);

    // 不传时保持旧行为（数组、最多 200 条）
    const all = await api('/api/audit');
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.length >= five.body.length).toBe(true);

    // 非法值回落默认，不报错、不返回空
    const bad = await api('/api/audit?limit=abc');
    expect(bad.status).toBe(200);
    expect(Array.isArray(bad.body)).toBe(true);
    expect(bad.body.length >= five.body.length).toBe(true);
  });
});

describe('锁定与退避', () => {
  it('手动锁定后旧会话立即失效', async () => {
    const old = session;
    const lk = await api('/api/lock', { method: 'POST' });
    expect(lk.status).toBe(200);

    const after = await api('/api/assets', { headers: { 'X-FK-Session': old } });
    expect(after.status === 401 || after.status === 423).toBe(true);
  });

  it('连续错误口令触发退避（返回 429 + retryAfterMs）', async () => {
    let got429 = false;
    for (let i = 0; i < 4; i += 1) {
      const r = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: 'wrong-pass-' + i } });
      if (r.status === 429) {
        got429 = true;
        expect(Number(r.body.retryAfterMs) > 0).toBe(true);
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('退避期内即使口令正确也拒绝（窗口期内不放行）', async () => {
    const r = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: PP } });
    expect(r.status).toBe(429);
  });
});
