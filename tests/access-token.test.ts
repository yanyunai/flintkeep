import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessTokenStore } from '../src/core/access-token';
import { cleanup, tmpDir } from './helpers';

/**
 * 访问令牌（服务账号）：只存哈希、scope 收敛、撤销立即生效。
 * 安全断言比功能断言更重要——令牌文件一旦被读走不该等价于拿到明文。
 */
describe('访问令牌存储', () => {
  let dir: string;
  let store: AccessTokenStore;
  beforeEach(() => {
    dir = tmpDir();
    store = new AccessTokenStore(dir);
  });
  afterEach(() => cleanup(dir));

  it('签发：明文只出现一次，落盘只有哈希与前缀', () => {
    const { token, view } = store.create({ name: 'ci', assets: ['a1'], caps: ['ssh'], days: 3 });
    expect(token.startsWith('fksa_')).toBe(true);

    const raw = fs.readFileSync(path.join(dir, 'access_tokens.json'), 'utf8');
    expect(raw.includes(token)).toBe(false);
    // 落盘只有前缀（12 字符）+ 哈希，足以展示与撤销，但拼不回明文
    expect(raw.includes(view.prefix)).toBe(true);
    expect(view.prefix.length >= 8).toBe(true);
  });

  it('校验：有效返回记录，篡改/未知返回 token.invalid', () => {
    const { token } = store.create({ name: 'ci', assets: ['a1'], caps: ['ssh'], days: 3 });
    const ok = store.verify(token);
    expect('record' in ok).toBe(true);

    const bad = store.verify(token.slice(0, -2) + 'xx');
    expect('error' in bad && bad.error).toBe('token.invalid');
  });

  it('撤销立即生效（前缀或 id 都能撤销）', () => {
    const { token, view } = store.create({ name: 'ci', assets: ['a1'], caps: ['ssh'], days: 3 });
    expect(store.revoke(view.prefix)?.id).toBe(view.id);

    const after = store.verify(token);
    expect('error' in after && after.error).toBe('token.revoked');
  });

  it('过期令牌返回 token.expired', () => {
    const { token } = store.create({ name: 'old', assets: ['a1'], caps: ['ssh'], days: 1 });
    // 直接改文件把过期时间挪到过去：等价于时间流逝，不必等一天
    const file = path.join(dir, 'access_tokens.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.tokens[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(data));

    const r = new AccessTokenStore(dir).verify(token);
    expect('error' in r && r.error).toBe('token.expired');
  });

  it('scope 为空直接拒绝签发（否则等于全库通行证）', () => {
    expect(() => store.create({ name: 'bad', assets: [], types: [], caps: ['ssh'], days: 3 })).toThrow();
  });

  it('scopeAllows 只放行清单内资产与类型', () => {
    const { token } = store.create({ name: 'one', assets: ['a1'], caps: ['proxy'], days: 1 });
    const checked = store.verify(token);
    expect('record' in checked).toBe(true);
    const rec = (checked as { record: Parameters<typeof AccessTokenStore.scopeAllows>[0] }).record;
    expect(AccessTokenStore.scopeAllows(rec, { id: 'a1', type: 'server', name: 'x' } as never)).toBe(true);
    expect(AccessTokenStore.scopeAllows(rec, { id: 'a2', type: 'server', name: 'y' } as never)).toBe(false);
  });
});