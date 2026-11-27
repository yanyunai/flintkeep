import { describe, expect, it } from 'vitest';
import {
  CATALOG_SOURCES,
  appendCatalogHistory,
  applyCatalogPrices,
  catalogModelFromRaw,
  diffCatalog,
  lookupCatalogModel,
  normalizePriceEntries,
  summarizePrices,
} from '../src/core/model-catalog';

/**
 * 模型价目目录：去重、摘要、家族匹配、改价 diff。
 * 这些函数决定界面上「多少钱」怎么写，写错了用户看不出，只会被算错账。
 */
const rawDup = [
  { priceName: '输入', type: 'input_token', price: '0.8', priceUnit: '每百万tokens' },
  { priceName: '输出', type: 'output_token', price: '2', priceUnit: '每百万tokens' },
  { priceName: '输入', type: 'input_token', price: '0.8', priceUnit: '每百万tokens' }, // 官方重复档
  { priceName: '输入（缓存命中）', type: 'input_token_cache', price: '0.1', priceUnit: '每百万tokens' },
];

describe('价目去重与摘要', () => {
  it('同 type+price+unit 只留一条；文本价摘要为「入/出 + 单位」', () => {
    const prices = normalizePriceEntries(rawDup);
    expect(prices.length).toBe(3);
    expect(summarizePrices(prices)).toBe('入 0.8 / 出 2 · 百万tokens');
  });

  it('视频价摘要取标准档最低分辨率；全零价显示「标价免费」', () => {
    const video = normalizePriceEntries([
      { priceName: '视频生成（480P）', type: 'video_ratio_480p', price: '0.45', priceUnit: '每秒' },
      { priceName: '视频生成（720P）', type: 'video_ratio_720p', price: '0.9', priceUnit: '每秒' },
      { priceName: '视频生成（480P）', type: 'video_ratio_480p', price: '0.3', priceUnit: '每秒', discount: 0.7 },
    ]);
    expect(/480P 0\.45\/秒起/.test(summarizePrices(video))).toBe(true);

    const free = normalizePriceEntries([
      { priceName: '输入', type: 'input_token', price: '0', priceUnit: '每百万tokens' },
      { priceName: '输出', type: 'output_token', price: '0', priceUnit: '每百万tokens' },
    ]);
    expect(summarizePrices(free)).toBe('标价免费');
  });

  it('DashScope 嵌套 prices[] 可展平', () => {
    const nested = normalizePriceEntries([
      { prices: [{ price: '1', type: 'input_token', priceName: '输入', priceUnit: '每百万tokens' }] },
    ]);
    expect(nested.length).toBe(1);
    expect(nested[0].price).toBe('1');
  });
});

describe('家族匹配与挂价', () => {
  const fam = catalogModelFromRaw({ model: 'qwen-plus', name: 'Qwen-Plus', capabilities: ['TG'], prices: rawDup })!;

  it('从 CLI 原始项生成 CatalogModel', () => {
    expect(fam.id).toBe('qwen-plus');
    expect(fam.prices?.length).toBe(3);
  });

  it('版本号模型按最长家族前缀匹配', () => {
    expect(lookupCatalogModel([fam], 'qwen-plus-2025-07-14')?.id).toBe('qwen-plus');
    expect(lookupCatalogModel([fam], 'qwen-max')).toBeUndefined();
  });

  it('账号模型清单可挂上目录价', () => {
    const applied = applyCatalogPrices([{ id: 'qwen-plus-2025-07-14', price: '按量', free: false }], [fam]);
    expect(applied[0].price).toBe(fam.price);
    expect((applied[0] as unknown as { prices?: unknown[] }).prices?.length).toBe(3);
  });

  it('目录为空时原样返回（不把已有价格清空）', () => {
    const input = [{ id: 'x', price: '按量', free: false }];
    expect(applyCatalogPrices(input, [])).toEqual(input);
    expect(applyCatalogPrices(input, null)).toEqual(input);
  });
});

describe('目录 diff 与历史', () => {
  const fam = catalogModelFromRaw({ model: 'qwen-plus', name: 'Qwen-Plus', capabilities: ['TG'], prices: rawDup })!;
  const next = [
    {
      ...fam,
      prices: normalizePriceEntries([
        { priceName: '输入', type: 'input_token', price: '1.6', priceUnit: '每百万tokens' },
        { priceName: '输出', type: 'output_token', price: '4', priceUnit: '每百万tokens' },
      ]),
      price: '入 1.6 / 出 4 · 百万tokens',
    },
    catalogModelFromRaw({ model: 'new-model', name: 'New', capabilities: ['TG'], prices: [] })!,
  ];

  it('上新与改价可识别，未下架时 removed 为空', () => {
    const d = diffCatalog([fam], next);
    expect(d.added.includes('new-model')).toBe(true);
    expect(d.priceChanged.some((x) => x.id === 'qwen-plus')).toBe(true);
    expect(d.removed.length).toBe(0);
  });

  it('首次拉取不记「全量新增」噪音，二次才写改价历史', () => {
    const first = appendCatalogHistory(null, [fam], { provider: 'aliyun', source: 'bailian-cli', ts: '2026-01-01T00:00:00.000Z' });
    expect(first.history?.length).toBe(0);
    expect(first.lastDiff?.added.length).toBe(0);

    const second = appendCatalogHistory(first, next, { provider: 'aliyun', source: 'bailian-cli', ts: '2026-01-02T00:00:00.000Z' });
    expect(second.history?.length).toBe(1);
    expect((second.history?.[0]?.priceChanged?.length || 0) >= 1).toBe(true);
  });

  it('三家价目源都已注册', () => {
    expect(!!(CATALOG_SOURCES.aliyun && CATALOG_SOURCES.tencent && CATALOG_SOURCES.volcengine)).toBe(true);
  });
});