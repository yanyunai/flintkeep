import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { DailyBackup } from '../src/core/backup';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * 每日自动备份：只在「有变动」时跑、当日刷新、按天数裁剪。
 * 这一层的价值全在"误删/损坏还能救回来"，所以断言重点是"文件真的是副本"和"裁剪不裁掉今天的"。
 */
describe('每日自动备份', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => cleanup(dir));

  it('还没有库文件时直接跳过（返回 null）', () => {
    const bk = new DailyBackup(dir, 3);
    expect(bk.run()).toBeNull();
    expect(bk.list().length).toBe(0);
  });

  it('首次备份落到 daily-YYYY-MM-DD，内容是副本', () => {
    const bk = new DailyBackup(dir, 3);
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });

    const r = bk.run(new Date('2026-01-05T10:00:00'));
    expect(r).toBeTruthy();
    expect(r!.files).toContain('vault.enc.json');
    const copy = path.join(r!.dir, 'vault.enc.json');
    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.readFileSync(copy, 'utf8')).toBe(fs.readFileSync(path.join(dir, 'vault.enc.json'), 'utf8'));
    expect(bk.list()).toEqual(['daily-2026-01-05']);
  });

  it('当天无变动不重复备份；有变动则刷新当日目录', () => {
    const bk = new DailyBackup(dir, 3);
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });
    expect(bk.run(new Date('2026-01-05T10:00:00'))).toBeTruthy();

    expect(bk.run(new Date('2026-01-05T11:00:00'))).toBeNull();

    v.add({ type: 'note', name: 'n2', content: 'c2', tags: [] });
    expect(bk.run(new Date('2026-01-05T12:00:00'))).toBeTruthy();
    expect(bk.list().length).toBe(1);
  });

  it('只保留最近 keep 天（超出的整目录删除）', () => {
    const bk = new DailyBackup(dir, 3);
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });

    // 造 5 个历史目录，模拟长期使用
    for (let i = 1; i <= 5; i += 1) {
      const d = path.join(dir, 'backups', `daily-2020-01-0${i}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'vault.enc.json'), '{}');
    }
    expect(bk.list().length).toBe(5);

    const r = bk.run(new Date('2026-01-06T00:00:00'));
    expect(r).toBeTruthy();
    const kept = bk.list();
    expect(kept.length).toBe(3);
    expect(kept.includes('daily-2020-01-01')).toBe(false);
    expect(kept.includes('daily-2026-01-06')).toBe(true);
  });
});