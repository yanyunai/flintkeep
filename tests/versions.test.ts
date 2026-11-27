import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * 条目版本历史：改前快照、回滚、回滚本身可回滚、每资产上限。
 * 重点断言「摘要里不含密钥」——版本历史最容易变成明文泄露的旁路。
 */
describe('条目版本历史', () => {
  let dir: string;
  let v: Vault;
  beforeEach(() => {
    dir = tmpDir();
    v = new Vault(dir, PP);
  });
  afterEach(() => cleanup(dir));

  it('新增不产生版本；改一次留一版，摘要含字段名但不含密钥', () => {
    const a = v.add({ type: 'api_key', name: 'ver-a', secret: 'SECRET_V1', tags: [] });
    expect(v.listAssetVersions(a.id).length).toBe(0);

    v.update(a.id, { secret: 'SECRET_V2' });
    const list = v.listAssetVersions(a.id);
    expect(list.length).toBe(1);
    expect(list[0].changed.includes('secret')).toBe(true);
    expect(JSON.stringify(list).includes('SECRET_V1')).toBe(false);
  });

  it('回滚恢复旧值，且回滚本身留一版', () => {
    const a = v.add({ type: 'api_key', name: 'ver-b', secret: 'SECRET_V1', tags: [] });
    v.update(a.id, { secret: 'SECRET_V2' });
    const first = v.listAssetVersions(a.id)[0];
    v.restoreAssetVersion(a.id, first.vid);

    expect(v.get(a.id)?.secret).toBe('SECRET_V1');
    expect(v.listAssetVersions(a.id)[0].source).toBe('restore');
  });

  it('每资产最多保留 10 版', () => {
    const a = v.add({ type: 'api_key', name: 'ver-c', secret: 'S0', tags: [] });
    for (let i = 0; i < 12; i += 1) v.update(a.id, { username: 'u' + i });
    expect(v.listAssetVersions(a.id).length).toBe(10);
  });

  it('已删除的资产不可回滚版本', () => {
    const a = v.add({ type: 'note', name: 'ver-d', content: 'v1', tags: [] });
    v.update(a.id, { content: 'v2' });
    const vid = v.listAssetVersions(a.id)[0].vid;
    v.remove(a.id);
    expect(v.restoreAssetVersion(a.id, vid)).toBeFalsy();
  });
});