import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * MCP 工具面（进程内调用 `handleCall`，不 spawn stdio 子进程）。
 * 关注点是「Agent 能拿到什么、拿不到什么」：默认脱敏、connect 只给命令、删除要二次确认。
 */
const DATA_DIR = tmpDir('fk-mcp-');

let handleCall: (name: string, args: any) => Promise<any>;
let serverAssetId = '';

function text(res: any): any {
  const raw = res?.content?.[0]?.text || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

beforeAll(async () => {
  // 先造库与资产，再让 MCP 打开同一个目录
  const v = new Vault(DATA_DIR, PP);
  const srv = v.add({
    type: 'server',
    name: 'mcp-web-01',
    publicIp: '198.51.100.21',
    sshUser: 'root',
    sshPassword: 'FAKE_PWD_MCP',
    tags: ['prod'],
  });
  serverAssetId = srv.id;
  v.add({ type: 'api_key', name: 'mcp-key', username: 'svc', secret: 'FAKE_KEY_MCP', tags: [] });
  v.add({ type: 'note', name: 'mcp-memo', content: '备忘', tags: [] });
  // manage 的写操作要求 full 档；其余用例不依赖
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ agentPermission: 'full' }), { mode: 0o600 });

  const mcp = await import('../src/core/mcp');
  mcp.initMcp({ dataDir: DATA_DIR, passphrase: PP });
  handleCall = mcp.handleCall;
});

afterAll(() => cleanup(DATA_DIR));

describe('find / show', () => {
  it('find 返回卡片，默认不混入备忘录', async () => {
    const r = text(await handleCall('find', {}));
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.total >= 2).toBe(true);
    expect(r.items.some((x: any) => x.name === 'mcp-memo')).toBe(false);
  });

  it('find 按类型过滤可命中备忘录', async () => {
    const r = text(await handleCall('find', { kind: 'note' }));
    expect(r.items.some((x: any) => x.name === 'mcp-memo')).toBe(true);
  });

  it('show 默认脱敏：不含密码/密钥明文', async () => {
    const r = await handleCall('show', { target: serverAssetId });
    const body = text(r);
    const raw = JSON.stringify(body);
    expect(raw.includes('FAKE_PWD_MCP')).toBe(false);
    expect(body.name === 'mcp-web-01' || body.asset?.name === 'mcp-web-01').toBe(true);
  });

  it('找不到目标时给出可操作错误码', async () => {
    const r = await handleCall('find', { q: '不存在的资产名-xyz' });
    const body = text(r);
    expect(body.total).toBe(0);
  });
});

describe('connect', () => {
  it('server → 直接可粘贴的 ssh 命令，且不含明文密码', async () => {
    const r = await handleCall('connect', { target: serverAssetId, mode: 'ssh' });
    const body = text(r);
    const raw = JSON.stringify(body);
    expect(raw.includes('FAKE_PWD_MCP')).toBe(false);
    expect(raw.includes('ssh ')).toBe(true);
  });
});

describe('manage', () => {
  it('delete 未带 confirm 只返回提示，不真删', async () => {
    const r = text(await handleCall('manage', { action: 'delete', id: serverAssetId }));
    expect(r.needsConfirm).toBe(true);
    const list = text(await handleCall('find', { kind: 'server' }));
    expect(list.items.some((x: any) => x.id === serverAssetId)).toBe(true);
  });

  it('update 改名后 find 能查到新名字', async () => {
    const r = await handleCall('manage', {
      action: 'update',
      id: serverAssetId,
      patch: { name: 'mcp-web-01-renamed' },
    });
    expect(r.isError).not.toBe(true);
    const list = text(await handleCall('find', { kind: 'server' }));
    expect(list.items.some((x: any) => x.name === 'mcp-web-01-renamed')).toBe(true);
  });

  it('delete 带 confirm 才真删', async () => {
    const r = await handleCall('manage', { action: 'delete', id: serverAssetId, confirm: true });
    expect(r.isError).not.toBe(true);
    const list = text(await handleCall('find', { kind: 'server' }));
    expect(list.items.some((x: any) => x.id === serverAssetId)).toBe(false);
  });
});

describe('未知工具', () => {
  it('返回 isError 与错误码，而不是抛异常', async () => {
    const r = await handleCall('no_such_tool', {});
    expect(r.isError).toBe(true);
    const body = text(r);
    expect(!!body.code || !!body.error).toBe(true);
  });
});

describe('目标参数：target / id 双名兼容', () => {
  it('show 传 id 也能用（不必记 target）', async () => {
    // 用本用例自建的资产，避免依赖前面用例可能删掉的对象
    const added = text(
      await handleCall('manage', { action: 'add', asset: { type: 'api_key', name: 'show-id-test', secret: 's0' } })
    );
    const id = added.id || added.asset?.id;
    const r = text(await handleCall('show', { id }));
    const name = r.name || r.asset?.name;
    expect(name).toBe('show-id-test');
  });

  it('manage history 传 target 也能用（真实使用里最容易踩的一处）', async () => {
    const added = text(
      await handleCall('manage', { action: 'add', asset: { type: 'api_key', name: 'hist-target-test', secret: 's1' } })
    );
    const id = added.id || added.asset?.id;
    await handleCall('manage', { action: 'update', id, patch: { secret: 's2' } });
    const h = text(await handleCall('manage', { action: 'history', target: id }));
    expect(Array.isArray(h.items)).toBe(true);
    expect(h.items.length >= 1).toBe(true);
  });

  it('run_project 只给目标不给 action：明确报错，不静默返回列表', async () => {
    const r = text(await handleCall('run_project', { target: 'whatever' }));
    expect(r.code).toBe('args.invalid');
  });
});

describe('端口与目标定位（真实环境里最容易踩的两处）', () => {
  it('非 22 端口写进卡片摘要；22 端口不啰嗦', async () => {
    await handleCall('manage', {
      action: 'add',
      asset: { type: 'ssh_key', name: 'port-65461-test', sshHost: '203.0.113.10', sshPort: 65461, sshUser: 'root' },
    });
    await handleCall('manage', {
      action: 'add',
      asset: { type: 'ssh_key', name: 'port-22-test', sshHost: '203.0.113.11', sshPort: 22, sshUser: 'root' },
    });
    const r = text(await handleCall('find', { kind: 'ssh_key', limit: 50 }));
    const c1 = r.items.find((x: any) => x.name === 'port-65461-test');
    const c2 = r.items.find((x: any) => x.name === 'port-22-test');
    expect(!!c1 && c1.hint.includes(':65461')).toBe(true);
    expect(!!c2 && !c2.hint.includes(':22')).toBe(true);

    // 按 IP 唯一命中，明细里带得出真实端口（直连时才知道该用哪个 -p）
    const s = text(await handleCall('show', { target: '203.0.113.10' }));
    expect(s.name).toBe('port-65461-test');
    expect(Number(s.sshPort)).toBe(65461);
  });

  it('按 IP 命中多条时回「歧义」并给候选，不再报「未找到」', async () => {
    // 同 IP 两条：机器档案 + 它的 SSH 登录。真实库里就是这种形状
    await handleCall('manage', {
      action: 'add',
      asset: { type: 'server', name: 'dup-ip-server', publicIp: '203.0.113.20' },
    });
    await handleCall('manage', {
      action: 'add',
      asset: { type: 'ssh_key', name: 'dup-ip-ssh', sshHost: '203.0.113.20', sshPort: 65461 },
    });
    const b = text(await handleCall('show', { target: '203.0.113.20' }));
    expect(b.code).toBe('asset.ambiguous');
    expect(Array.isArray(b.candidates)).toBe(true);
    expect(b.candidates.length >= 2).toBe(true);
  });

  it('同 IP 的面板 URL 不干扰按 IP 找 SSH', async () => {
    // 真实场景：一台机器既有 SSH 登录，又有宝塔面板（panelUrl 里是同一个 IP）
    await handleCall('manage', {
      action: 'add',
      asset: { type: 'ssh_key', name: 'strict-ip-ssh', sshHost: '203.0.113.30', sshPort: 65461 },
    });
    await handleCall('manage', {
      action: 'add',
      asset: { type: 'baota', name: 'strict-ip-baota', panelUrl: 'https://203.0.113.30:8888/abc' },
    });
    const s = text(await handleCall('show', { target: '203.0.113.30' }));
    expect(s.name).toBe('strict-ip-ssh');
    expect(Number(s.sshPort)).toBe(65461);
  });

  it('同名资产也给候选，并且「类型:序号」仍能唯一命中', async () => {
    await handleCall('manage', { action: 'add', asset: { type: 'api_key', name: 'same-name-test', secret: 'x' } });
    await handleCall('manage', { action: 'add', asset: { type: 'login_account', name: 'same-name-test' } });
    const b = text(await handleCall('show', { target: 'same-name-test' }));
    expect(b.code).toBe('asset.ambiguous');
    expect(b.candidates.length >= 2).toBe(true);

    const one = b.candidates[0];
    const s = text(await handleCall('show', { target: `${one.type}:${one.no}` }));
    expect(s.id).toBe(one.id);
  });
});
