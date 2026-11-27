import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDataDir } from '../src/core/data-dir';

const ENV_KEYS = ['VAULT_DATA_DIR', 'FK_DATA_DIR'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveDataDir：三个入口必须用同一套口径', () => {
  it('都没有时回落到调用方默认值', () => {
    expect(resolveDataDir('/desktop/data')).toBe('/desktop/data');
    expect(resolveDataDir('./data')).toBe('./data');
  });

  it('只设 FK_DATA_DIR 时也生效（CLI 文档里的名字）', () => {
    process.env.FK_DATA_DIR = '/cli-dir';
    expect(resolveDataDir('./data')).toBe('/cli-dir');
  });

  it('只设 VAULT_DATA_DIR 时生效（MCP / 桌面端文档里的名字）', () => {
    process.env.VAULT_DATA_DIR = '/vault-dir';
    expect(resolveDataDir('./data')).toBe('/vault-dir');
  });

  it('两个都设且不同时，VAULT_DATA_DIR 优先（避免同一台机器上两个进程走不同库）', () => {
    process.env.VAULT_DATA_DIR = '/vault-dir';
    process.env.FK_DATA_DIR = '/cli-dir';
    expect(resolveDataDir('./data')).toBe('/vault-dir');
  });

  it('显式参数压过两个环境变量', () => {
    process.env.VAULT_DATA_DIR = '/vault-dir';
    process.env.FK_DATA_DIR = '/cli-dir';
    expect(resolveDataDir('./data', '/explicit')).toBe('/explicit');
  });

  it('空字符串按未设置处理，不把数据目录变成当前工作目录', () => {
    process.env.VAULT_DATA_DIR = '';
    process.env.FK_DATA_DIR = '';
    expect(resolveDataDir('/fallback')).toBe('/fallback');
  });
});
