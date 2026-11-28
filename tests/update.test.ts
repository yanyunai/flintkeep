import { describe, it, expect } from 'vitest';
import { compareVersions, isNewerVersion, isPreRelease, normalizeVersion, tagToVersion } from '../src/core/version';
import { checkForUpdate, aboutInfo } from '../src/server/update-routes';

describe('版本比较', () => {
  it('normalizeVersion 去掉 v 前缀、保留分段', () => {
    expect(normalizeVersion('v0.1.2')).toEqual([0, 1, 2]);
    expect(normalizeVersion('1.2')).toEqual([1, 2]);
    expect(normalizeVersion('不是版本')).toEqual([]);
  });

  it('compareVersions 逐位比较，缺位按 0 补齐', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v0.1.10', '0.1.9')).toBe(1);
  });

  it('预发布版比同号正式版旧', () => {
    expect(isPreRelease('1.2.3-beta.1')).toBe(true);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3-rc.2')).toBe(1);
  });

  it('无法解析时按「不比较」处理，绝不误报升级', () => {
    expect(compareVersions('', '1.0.0')).toBe(0);
    expect(isNewerVersion('谁知道', '0.1.0')).toBe(false);
  });

  it('tagToVersion 去掉 v 前缀', () => {
    expect(tagToVersion('v0.1.1')).toBe('0.1.1');
    expect(tagToVersion('0.1.1')).toBe('0.1.1');
  });
});

describe('更新检查', () => {
  const fakeFetch = (map: Record<string, { status: number; body: any }>) => async (url: string) => {
    for (const [k, v] of Object.entries(map)) if (url.includes(k)) return v;
    return { status: 404, body: null };
  };

  it('有 release 且比当前新 → hasUpdate', async () => {
    const info = await checkForUpdate('0.1.0', {
      fetcher: fakeFetch({
        'releases/latest': {
          status: 200,
          body: {
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/yanyunai/flintkeep/releases/tag/v0.2.0',
            published_at: '2026-11-27T00:00:00Z',
            body: '修了一堆东西',
          },
        },
      }),
    });
    expect(info.hasUpdate).toBe(true);
    expect(info.latest).toBe('0.2.0');
    expect(info.source).toBe('release');
    expect(info.url).toContain('/releases/tag/v0.2.0');
  });

  it('release 与当前同号 → 已是最新', async () => {
    const info = await checkForUpdate('0.1.0', {
      fetcher: fakeFetch({ 'releases/latest': { status: 200, body: { tag_name: 'v0.1.0', html_url: 'x' } } }),
    });
    expect(info.hasUpdate).toBe(false);
    expect(info.source).toBe('release');
  });

  it('没有 release 时回退 tags', async () => {
    const info = await checkForUpdate('0.1.0', {
      fetcher: fakeFetch({
        'releases/latest': { status: 404, body: null },
        'tags?per_page=1': { status: 200, body: [{ name: 'v0.1.3' }] },
      }),
    });
    expect(info.hasUpdate).toBe(true);
    expect(info.source).toBe('tag');
    expect(info.latest).toBe('0.1.3');
  });

  it('全查不到 → 不报错、不提示升级', async () => {
    const info = await checkForUpdate('0.1.0', { fetcher: fakeFetch({}) });
    expect(info.hasUpdate).toBe(false);
    expect(info.source).toBe('none');
    expect(info.latest).toBeNull();
  });
});

describe('关于信息', () => {
  it('字段齐全且指向公开仓', () => {
    const a = aboutInfo();
    expect(a.repo).toBe('https://github.com/yanyunai/flintkeep');
    expect(a.license).toBe('AGPL-3.0-only');
    expect(a.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(a.site).toContain('pages.dev');
  });
});
