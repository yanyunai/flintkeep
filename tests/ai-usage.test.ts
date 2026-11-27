import { afterEach, describe, expect, it } from 'vitest';
import { AiUsageStore, SUPPORTED_PROVIDERS, getHandler, mapLimit } from '../src/core/ai-usage';
import { cleanup, tmpDir } from './helpers';

/**
 * 模型用量适配器：注册表与解析（网络一律 stub，不打真实 API）。
 * 断言重点是「失败别假装成功」：拿不到数据要返回空/ null，而不是塞一个看起来正常的空账单。
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: any) => any) {
  globalThis.fetch = (async (url: any, init?: any) => handler(String(url), init)) as typeof fetch;
}

const okJson = (body: any) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('适配器注册表', () => {
  it('三家 provider 都已注册，且 handler 具备三个方法', () => {
    expect(SUPPORTED_PROVIDERS.sort()).toEqual(['aliyun', 'tencent', 'volcengine']);
    for (const id of SUPPORTED_PROVIDERS) {
      const h = getHandler(id)!;
      expect(typeof h.fetchAccount).toBe('function');
      expect(typeof h.fetchModels).toBe('function');
      expect(typeof h.probe).toBe('function');
    }
    expect(getHandler('nope')).toBeNull();
  });
});

describe('阿里云适配器', () => {
  it('没有 API Key 时 fetchModels 返回 null（不编造空清单）', async () => {
    const h = getHandler('aliyun')!;
    expect(await h.fetchModels({} as any)).toBeNull();
  });

  it('解析模型分页：价格摘要、免费判定、能力映射', async () => {
    stubFetch(() =>
      okJson({
        output: {
          total: 2,
          models: [
            {
              model: 'qwen-plus',
              name: 'Qwen-Plus',
              capabilities: ['TG'],
              published_time: '2026-01-01',
              prices: [
                { priceName: '输入', type: 'input_token', price: '0.8', priceUnit: '每百万tokens' },
                { priceName: '输出', type: 'output_token', price: '2', priceUnit: '每百万tokens' },
              ],
            },
            {
              model: 'qwen-free',
              name: 'Qwen-Free',
              capabilities: ['TG'],
              prices: [{ priceName: '输入', type: 'input_token', price: '0', priceUnit: '每百万tokens' }],
            },
          ],
        },
      })
    );

    const r = await getHandler('aliyun')!.fetchModels({ apiKey: 'FAKE_KEY' } as any)!;
    expect(r?.total).toBe(2);
    expect(r?.models.length).toBe(2);
    expect(r?.models[0].id).toBe('qwen-plus');
    expect(String(r?.models[0].price)).toContain('入 0.8');
    expect(r?.models[1].free).toBe(true);
  });

  it('上游非 2xx 时返回空清单，不抛也不伪造', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const r = await getHandler('aliyun')!.fetchModels({ apiKey: 'K' } as any);
    expect(r?.models.length).toBe(0);
  });

  it('probe 缺 Key 时状态为 unknown', async () => {
    const p = await getHandler('aliyun')!.probe({} as any, 'qwen-plus');
    expect(p.status).toBe('unknown');
  });
});

describe('配置并发安全与限流', () => {
  it('updateConfig 在锁内重读：不覆盖另一个实例刚写入的字段', () => {
    const dir = tmpDir('fk-usage-');
    try {
      const a = new AiUsageStore(dir);
      const b = new AiUsageStore(dir);
      b.setConfig({ autoProbe: true });
      a.updateConfig((cur) => ({ cliBindings: { ...(cur.cliBindings || {}), acc1: 'p1' } }));
      const cfg = a.getConfig();
      expect(cfg.autoProbe).toBe(true);
      expect(cfg.cliBindings?.acc1).toBe('p1');
    } finally {
      cleanup(dir);
    }
  });

  it('两次增量写 binding 不会互相覆盖（并发刷新同一目录的情形）', () => {
    const dir = tmpDir('fk-usage-');
    try {
      const store = new AiUsageStore(dir);
      store.updateConfig((cur) => ({ cliBindings: { ...(cur.cliBindings || {}), acc1: 'p1' } }));
      store.updateConfig((cur) => ({ cliBindings: { ...(cur.cliBindings || {}), acc2: 'p2' } }));
      const bindings = store.getConfig().cliBindings || {};
      expect(bindings.acc1).toBe('p1');
      expect(bindings.acc2).toBe('p2');
    } finally {
      cleanup(dir);
    }
  });

  it('mapLimit 并发不超过上限，结果顺序与输入一致', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  it('mapLimit 处理空数组与超过长度的上限', async () => {
    expect(await mapLimit([], 3, async (n: number) => n)).toEqual([]);
    const out = await mapLimit([1, 2], 10, async (n) => n + 1);
    expect(out).toEqual([2, 3]);
  });
});
