import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { FileLockTimeoutError, withFileLock } from '../src/core/file-lock';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * 数据目录写锁：server / MCP / Electron 同开一个目录时的跨进程互斥。
 * 这里只测单进程可见的部分（重入、超时报错、不残留），真·跨进程抢写仍需两个进程实测。
 */
describe('数据目录写锁', () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = tmpDir();
    lockPath = path.join(dir, 'vault.enc.json.lock');
  });
  afterEach(() => cleanup(dir));

  it('add / update / setCollection / remove 后都不残留锁文件', () => {
    const v = new Vault(dir, PP);
    const a = v.add({ type: 'note', name: 'lock-a', content: 'x', tags: [] });
    expect(fs.existsSync(lockPath)).toBe(false);
    v.update(a.id, { name: 'lock-a2' });
    v.setCollection('workbench', { revenue: [] });
    v.remove(a.id);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('同进程重入不死锁且释放干净', () => {
    let n = 0;
    withFileLock(lockPath, () => {
      n += 1;
      withFileLock(lockPath, () => {
        n += 1;
      });
    });
    expect(n).toBe(2);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('外部进程持锁时写操作超时报错并指出持锁 pid，而不是覆盖别人的数据', () => {
    const v = new Vault(dir, PP);
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: 12345 }));
    let err: unknown = null;
    try {
      v.add({ type: 'note', name: 'blocked', content: 'x', tags: [] });
    } catch (e) {
      err = e;
    }
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);

    expect(err instanceof FileLockTimeoutError).toBe(true);
    expect(String((err as Error).message)).toContain('12345');
  });
});