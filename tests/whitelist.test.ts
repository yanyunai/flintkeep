import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import {
  WhitelistStore,
  aliyunListRegions,
  aliyunUpdatePrefixList,
  runAll,
  runBinding,
  tencentUpdateTemplate,
} from '../src/core/whitelist';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * 白名单：绑定存储、执行策略（停用/缺 AK/IP 未变都跳过）、云调用解析。
 * 一律注入 fetcher / 本地 echo，不打真实云 API——测试不能依赖外部账号。
 */
function fakeFetch(body: any) {
  return (async () => ({ text: async () => JSON.stringify(body) })) as unknown as (u: string, i?: any) => Promise<any>;
}
const fixedIp = (ip: string) => (async () => ({ text: async () => ip })) as unknown as (u: string, i?: any) => Promise<any>;

describe('绑定存储', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => cleanup(dir));

  it('增删改查，且文件里不含任何密钥', () => {
    const st = new WhitelistStore(dir);
    const b = st.add({ provider: 'aliyun', assetId: 'cloud-1', region: 'cn-hangzhou', prefixListId: 'pl-1', enabled: true });
    expect(st.list().length).toBe(1);
    expect(st.get(b.id)?.prefixListId).toBe('pl-1');

    st.update(b.id, { prefixListId: 'pl-2' });
    expect(st.get(b.id)?.prefixListId).toBe('pl-2');

    expect(st.remove(b.id)).toBe(true);
    expect(st.list().length).toBe(0);

    const raw = fs.readFileSync(path.join(dir, 'whitelist.json'), 'utf8');
    expect(/secret|password|accessKey/i.test(raw)).toBe(false);
  });

  it('定时配置：启用时排下一次，停用时清空', () => {
    const st = new WhitelistStore(dir);
    const on = st.setSchedule({ enabled: true, intervalMinutes: 30 });
    expect((on.nextRunAt || 0) > Date.now()).toBe(true);

    const off = st.setSchedule({ enabled: false });
    expect(off.nextRunAt).toBeUndefined();

    expect(new WhitelistStore(dir).getSchedule().intervalMinutes).toBe(30); // 非法值之外保持原值
    expect(st.setSchedule({ intervalMinutes: 0 }).intervalMinutes).toBe(1);
  });
});

describe('执行策略', () => {
  it('停用的绑定直接跳过；资产不存在报明确原因', async () => {
    const dir = tmpDir();
    const v = new Vault(dir, PP);
    const st = new WhitelistStore(dir);
    const b = st.add({ provider: 'aliyun', assetId: 'nope', region: 'cn-hangzhou', prefixListId: 'pl', enabled: false });
    const r = await runBinding(v, st, st.get(b.id)!, { detect: { fetcher: fixedIp('203.0.113.7') } });
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(false);

    st.update(b.id, { enabled: true });
    const r2 = await runBinding(v, st, st.get(b.id)!, { detect: { fetcher: fixedIp('203.0.113.7') } });
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('不存在');
    cleanup(dir);
  });

  it('缺 AccessKey 失败并说明；缺 prefixListId 也失败', async () => {
    const dir = tmpDir();
    const v = new Vault(dir, PP);
    const noAk = v.add({ type: 'cloud_account', name: 'no-ak', provider: 'aliyun', region: 'cn-hangzhou', tags: [] });
    const ak = v.add({ type: 'cloud_account', name: 'has-ak', provider: 'aliyun', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'cn-hangzhou', tags: [] });
    const st = new WhitelistStore(dir);
    const b1 = st.add({ provider: 'aliyun', assetId: noAk.id, region: 'cn-hangzhou', prefixListId: 'pl', enabled: true });
    const r1 = await runBinding(v, st, st.get(b1.id)!, { detect: { fetcher: fixedIp('203.0.113.7') } });
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain('AccessKey');

    const b2 = st.add({ provider: 'aliyun', assetId: ak.id, region: 'cn-hangzhou', enabled: true });
    const r2 = await runBinding(v, st, st.get(b2.id)!, { detect: { fetcher: fixedIp('203.0.113.7') } });
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('prefixListId');
    cleanup(dir);
  });

  it('IP 未变化时跳过云 API（避免打满 QPS）', async () => {
    const dir = tmpDir();
    const v = new Vault(dir, PP);
    const ak = v.add({ type: 'cloud_account', name: 'ak', provider: 'aliyun', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'cn-hangzhou', tags: [] });
    const st = new WhitelistStore(dir);
    const b = st.add({ provider: 'aliyun', assetId: ak.id, region: 'cn-hangzhou', prefixListId: 'pl', enabled: true, lastIp: '203.0.113.7' });
    const r = await runBinding(v, st, st.get(b.id)!, { detect: { fetcher: fixedIp('203.0.113.7') } });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.ip).toBe('203.0.113.7');
    expect(v.auditLog(20).some((e) => e.action === 'whitelist_update')).toBe(true);
    cleanup(dir);
  });

  it('runAll 只跑启用中的绑定', async () => {
    const dir = tmpDir();
    const v = new Vault(dir, PP);
    const ak = v.add({ type: 'cloud_account', name: 'ak', provider: 'aliyun', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'cn-hangzhou', tags: [] });
    const st = new WhitelistStore(dir);
    st.add({ provider: 'aliyun', assetId: ak.id, region: 'cn-hangzhou', prefixListId: 'p1', enabled: true, lastIp: '203.0.113.7' });
    st.add({ provider: 'aliyun', assetId: ak.id, region: 'cn-hangzhou', prefixListId: 'p2', enabled: false });
    const rs = await runAll(v, st, { detect: { fetcher: fixedIp('203.0.113.7') } });
    expect(rs.length).toBe(1);
    cleanup(dir);
  });
});

describe('云调用解析', () => {
  it('阿里云更新：先读现有条目再改，只增删差异项', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      if (url.includes('DescribePrefixListAttributes')) {
        return { text: async () => JSON.stringify({ Entries: { Entry: [{ Cidr: '198.51.100.1' }] } }) };
      }
      return { text: async () => JSON.stringify({ Code: 'Success' }) };
    }) as unknown as (u: string, i?: any) => Promise<any>;

    const r = await aliyunUpdatePrefixList({
      accessKeyId: 'AK',
      accessKeySecret: 'SK',
      region: 'cn-hangzhou',
      prefixListId: 'pl-1',
      ips: ['203.0.113.7'],
      endpoint: 'ecs.aliyuncs.com',
      fetcher,
    });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual(['203.0.113.7']);
    expect(r.removed).toEqual(['198.51.100.1']);
    expect(calls.length).toBe(2);
    expect(calls[0].includes('DescribePrefixListAttributes')).toBe(true);
    expect(calls[1].includes('RemoveEntry.1.Cidr') || calls[1].includes('Signature')).toBe(true);
  });

  it('阿里云返回非 Success 时按失败处理并带错误码', async () => {
    const fetcher = (async (url: string) => {
      if (url.includes('DescribePrefixListAttributes')) return { text: async () => JSON.stringify({ Entries: { Entry: [] } }) };
      return { text: async () => JSON.stringify({ Code: 'InvalidPrefixListId.NotFound', Message: '不存在' }) };
    }) as unknown as (u: string, i?: any) => Promise<any>;
    const r = await aliyunUpdatePrefixList({
      accessKeyId: 'AK',
      accessKeySecret: 'SK',
      region: 'cn-hangzhou',
      prefixListId: 'pl-1',
      ips: ['203.0.113.7'],
      endpoint: 'ecs.aliyuncs.com',
      fetcher,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('InvalidPrefixListId');
  });

  it('阿里云地域列表按 Response 层解析', async () => {
    const r = await aliyunListRegions({
      accessKeyId: 'AK',
      accessKeySecret: 'SK',
      fetcher: fakeFetch({ Regions: { Region: [{ RegionId: 'cn-hangzhou' }, { RegionId: 'cn-beijing' }] } }),
    });
    expect(r.length).toBe(2);
    expect(r[0].id).toBe('cn-hangzhou');
  });

  it('腾讯云更新经本地 echo：请求体带 AddressesExtra（整体替换语义）', async () => {
    const port = 18971;
    let got = '';
    const echo = http.createServer((req, res) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        got = d;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Response: { RequestId: 'rid' } }));
      });
    });
    await new Promise<void>((resolve) => echo.listen(port, () => resolve()));
    try {
      const r = await tencentUpdateTemplate({
        secretId: 'SID',
        secretKey: 'SKEY',
        region: 'ap-shanghai',
        addressTemplateId: 'atm-1',
        ips: ['203.0.113.7'],
        endpoint: `127.0.0.1:${port}`,
      });
      expect(r.ok).toBe(true);
      expect(JSON.parse(got).AddressesExtra[0].Address).toBe('203.0.113.7');
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });
});