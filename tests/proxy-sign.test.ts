import { describe, expect, it } from 'vitest';
import {
  aliyunEnc,
  aliyunSignature,
  applyAliyunSignature,
  applyAwsSignature,
  awsCanonicalRequest,
  buildProxyInjection,
  signingKey,
} from '../src/core/proxy';

/**
 * 代理签名与注入：Agent 拿不到真实密钥，全靠这里的签名/注入正确。
 * 断言尽量落在「可独立复算」的性质上（同一输入同一结果、换密钥结果就变、规范串结构），
 * 不去硬编码一串连自己都不知道怎么来的 base64。
 */
describe('阿里云 RPC 签名', () => {
  it('百分号编码：空格、星号、感叹号都要转，波浪号保留', () => {
    expect(aliyunEnc('a b')).toBe('a%20b');
    expect(aliyunEnc('*')).toBe('%2A');
    expect(aliyunEnc('~')).toBe('~');
    expect(aliyunEnc('!')).toBe('%21');
    expect(aliyunEnc("'")).toBe('%27');
  });

  it('同一组参数结果稳定，与键顺序无关；换密钥/换方法结果就变', () => {
    const p1 = { Action: 'DescribeRegions', Timestamp: '2026-01-01T00:00:00Z', AccessKeyId: 'AK1' };
    const p2 = { AccessKeyId: 'AK1', Timestamp: '2026-01-01T00:00:00Z', Action: 'DescribeRegions' };
    const base = aliyunSignature(p1, 'SK1');
    expect(aliyunSignature(p2, 'SK1')).toBe(base);
    expect(aliyunSignature(p1, 'SK2') === base).toBe(false);
    expect(aliyunSignature(p1, 'SK1', 'POST') === base).toBe(false);
  });

  it('写回 URL 的 Signature 可由 URL 参数复算出来（签名与参数一致）', () => {
    const asset = { accessKeyId: 'AKx', secretAccessKey: 'SKx', cloudVersion: '2014-05-26' };
    const url = new URL('https://ecs.aliyuncs.com/?Action=DescribeRegions');
    applyAliyunSignature(asset, 'GET', url);

    expect(url.searchParams.get('AccessKeyId')).toBe('AKx');
    expect(url.searchParams.get('SignatureMethod')).toBe('HMAC-SHA1');
    expect(!!url.searchParams.get('SignatureNonce')).toBe(true);
    expect(!!url.searchParams.get('Timestamp')).toBe(true);

    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) if (k !== 'Signature') params[k] = v;
    expect(aliyunSignature(params, 'SKx', 'GET')).toBe(url.searchParams.get('Signature'));
  });
});

describe('AWS SigV4', () => {
  it('派生签名密钥对日期/区域/服务敏感', () => {
    const k1 = signingKey('secret', '20260101', 'us-east-1', 's3');
    const k2 = signingKey('secret', '20260102', 'us-east-1', 's3');
    const k3 = signingKey('secret', '20260101', 'ap-east-1', 's3');
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(false);
    expect(k1.equals(k3)).toBe(false);
  });

  it('规范请求串按「方法/路径/查询/头/签名头/载荷哈希」拼装，载荷参与哈希', () => {
    const url = new URL('https://bucket.s3.amazonaws.com/a/b?b=2&a=1');
    const headers = { host: url.host, 'x-amz-date': '20260101T000000Z' };
    const cr = awsCanonicalRequest('GET', url, headers, '');
    const parts = cr.split('\n');
    expect(parts[0]).toBe('GET');
    expect(parts[1]).toBe('/a/b');
    expect(parts[2]).toBe('a=1&b=2'); // 查询必须排序
    expect(parts.includes('a=1&b=2')).toBe(true);

    const cr2 = awsCanonicalRequest('GET', url, headers, 'body');
    expect(cr2 === cr).toBe(false);
  });

  it('注入后 Authorization 带凭据范围与签名头清单', () => {
    const asset = { accessKeyId: 'AK', secretAccessKey: 'SK', region: 'ap-shanghai', cloudService: 's3' };
    const url = new URL('https://bucket.s3.ap-shanghai.amazonaws.com/key');
    const headers: Record<string, string> = {};
    applyAwsSignature(asset, 'GET', url, headers, '');
    expect(headers['x-amz-date'].length > 0).toBe(true);
    expect(headers.Authorization.includes('AWS4-HMAC-SHA256 Credential=AK/')).toBe(true);
    expect(headers.Authorization.includes('SignedHeaders=host;x-amz-content-sha256;x-amz-date')).toBe(true);
    expect(headers.Authorization.includes('ap-shanghai/s3/aws4_request')).toBe(true);
  });
});

describe('代理注入', () => {
  it('header 模式：默认加 Bearer，自定义头名则原样放密钥', () => {
    // primarySecret 按资产类型取密钥：这里用 api_key，别用没有 type 的对象
    const bearer = buildProxyInjection({ type: 'api_key', secret: 'S', proxyInject: { mode: 'header' } });
    expect(bearer.headers.Authorization).toBe('Bearer S');

    const custom = buildProxyInjection({ type: 'api_key', secret: 'S', proxyInject: { mode: 'header', headerName: 'X-Api-Key' } });
    expect(custom.headers['X-Api-Key']).toBe('S');
  });

  it('basic 模式：base64(user:secret)', () => {
    const r = buildProxyInjection({ type: 'api_key', secret: 'S', username: 'u', proxyInject: { mode: 'basic' } });
    expect(r.headers.Authorization).toBe('Basic ' + Buffer.from('u:S').toString('base64'));
  });

  it('baota 模式：request_time + request_token（md5(md5(token)+time)）', () => {
    const r = buildProxyInjection({ type: 'baota', baotaApiKey: 'BT', proxyInject: { mode: 'baota' } });
    const time = Number(r.query.request_time);
    expect(Number.isFinite(time)).toBe(true);
    expect(r.query.request_token.length).toBe(32);
  });

  it('没有 proxyInject 配置时不注入任何东西', () => {
    const r = buildProxyInjection({ type: 'api_key', secret: 'S' });
    expect(Object.keys(r.headers).length).toBe(0);
    expect(Object.keys(r.query).length).toBe(0);
  });
});