import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * 旧接口收口：默认配置下，未在 tools/list 里的旧工具不得返回明文。
 * 覆盖：get_asset → show、get_server_connection → connect、reveal × 总开关、
 * 完整工具集仍受总开关约束、令牌模式不接受转接。
 *
 * 密钥字段用 api_key.secret 验证：server 上的 sshPassword 不落库（属于关联的 ssh_key），
 * 用它断言会得到「本来就没有」的假通过。
 */
const DATA_DIR = tmpDir('fk-mcp-legacy-');

let mcp: typeof import('../src/core/mcp');
let apiKeyId = '';

function body(res: any): any {
  const raw = res?.content?.[0]?.text || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function raw(res: any): string {
  return JSON.stringify(body(res));
}
function setSettings(patch: Record<string, unknown>) {
  const f = path.join(DATA_DIR, 'settings.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...patch }, null, 2), { mode: 0o600 });
}

beforeAll(async () => {
  const v = new Vault(DATA_DIR, PP);
  v.add({
    type: 'server',
    name: 'legacy-web-01',
    publicIp: '203.0.113.44',
    sshUser: 'root',
    tags: [],
  });
  const key = v.add({
    type: 'api_key',
    name: 'legacy-secret-01',
    username: 'svc',
    secret: 'FAKE_SECRET_LEGACY',
    tags: [],
  });
  apiKeyId = key.id;
  setSettings({ agentPermission: 'full', mcpFullTools: false, agentExposeSecrets: false });
  mcp = await import('../src/core/mcp');
  mcp.initMcp({ dataDir: DATA_DIR, passphrase: PP });
});

afterAll(() => cleanup(DATA_DIR));

describe('默认配置：旧工具不再给明文', () => {
  it('get_asset 被转到 show：没有密钥，且带 deprecated / next', async () => {
    const r = await mcp.handleCall('get_asset', { id: apiKeyId });
    const b = body(r);
    expect(raw(r).includes('FAKE_SECRET_LEGACY')).toBe(false);
    expect(b.deprecated).toBe('get_asset');
    expect(b.next?.tool).toBe('show');
    expect(String(b.hint)).toContain('show');
    expect(b.name).toBe('legacy-secret-01');
  });

  it('get_asset 按 type+no 取也脱敏（旧写法仍可用，只是不给密钥）', async () => {
    const r = await mcp.handleCall('get_asset', { type: 'api_key', no: 1 });
    expect(raw(r).includes('FAKE_SECRET_LEGACY')).toBe(false);
    expect(body(r).deprecated).toBe('get_asset');
  });

  it('get_server_connection 被转到 connect：行为与直连 connect 一致，不含口令', async () => {
    // 命中/失败取决于资产是否配了 SSH 登录；关键是「转接发生了」且「没回明文」
    const direct = await mcp.handleCall('connect', { target: 'legacy-web-01' });
    const r = await mcp.handleCall('get_server_connection', { target: 'legacy-web-01' });
    const b = body(r);
    expect(b.deprecated).toBe('get_server_connection');
    expect(b.next?.tool).toBe('connect');
    expect(raw(r).includes('FAKE_SECRET_LEGACY')).toBe(false);
    expect(Boolean(r.isError)).toBe(Boolean(direct.isError));
    if (!direct.isError) {
      expect(b.mode).toBe(body(direct).mode);
      expect(String(b.command || '')).toContain('ssh ');
    }
  });
});

describe('reveal 与总开关', () => {
  it('总开关关闭：show(reveal=true) 被拒，回脱敏资产与可执行提示', async () => {
    const r = await mcp.handleCall('show', { target: apiKeyId, reveal: true });
    const b = body(r);
    expect(r.isError).toBe(true);
    expect(b.code).toBe('secret.exposure_disabled');
    expect(raw(r).includes('FAKE_SECRET_LEGACY')).toBe(false);
    expect(String(b.hint)).toContain('fk show --reveal');
    expect(b.next?.tool).toBe('show');
    expect(b.asset?.name).toBe('legacy-secret-01');
  });

  it('总开关打开：show(reveal=true) 才给明文', async () => {
    setSettings({ agentExposeSecrets: true });
    const r = await mcp.handleCall('show', { target: apiKeyId, reveal: true });
    expect(raw(r).includes('FAKE_SECRET_LEGACY')).toBe(true);
    setSettings({ agentExposeSecrets: false });
  });

  it('打开完整工具集时总开关仍挡住明文（含 reveal）', async () => {
    setSettings({ mcpFullTools: true, agentExposeSecrets: false });
    const a = await mcp.handleCall('get_asset', { id: apiKeyId });
    expect(raw(a).includes('FAKE_SECRET_LEGACY')).toBe(false);
    const b = await mcp.handleCall('get_asset', { id: apiKeyId, reveal: true });
    expect(b.isError).toBe(true);
    expect(raw(b).includes('FAKE_SECRET_LEGACY')).toBe(false);
    const c = await mcp.handleCall('show', { target: apiKeyId, reveal: true });
    expect(c.isError).toBe(true);
    setSettings({ mcpFullTools: false });
  });

  it('旁路兜底：列表与版本历史也不带密钥字段', async () => {
    const list = await mcp.handleCall('list_assets', { type: 'api_key' });
    expect(raw(list).includes('FAKE_SECRET_LEGACY')).toBe(false);
    const hist = await mcp.handleCall('manage', { action: 'history', id: apiKeyId });
    expect(raw(hist).includes('FAKE_SECRET_LEGACY')).toBe(false);
  });
});

describe('令牌模式不受转接影响', () => {
  it('令牌模式下旧工具被拒绝，且不回落到本地明文路径', async () => {
    mcp.initMcp({ dataDir: DATA_DIR, token: 'fkt_invalid_for_test' });
    try {
      const r = await mcp.handleCall('get_asset', { id: apiKeyId });
      expect(raw(r).includes('FAKE_SECRET_LEGACY')).toBe(false);
      expect(body(r).code === 'token.tool_denied' || r.isError === true).toBe(true);
    } finally {
      mcp.initMcp({ dataDir: DATA_DIR, passphrase: PP });
    }
  });
});
