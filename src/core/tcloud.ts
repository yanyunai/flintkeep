import * as crypto from 'crypto';

/**
 * 腾讯云 API 3.0（TC3-HMAC-SHA256）签名与调用。
 * 与 AWS SigV4 同构，区别：
 *  - 算法名 TC3-HMAC-SHA256
 *  - 凭据作用域 date/{service}/tc3_request（末段固定 tc3_request）
 *  - 请求走 POST，签名头固定 content-type;host，业务参数放 JSON body，
 *    动作/版本/区域通过 X-TC-Action / X-TC-Version / X-TC-Region 头传递。
 */

function sha256hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key as any).update(data, 'utf8').digest();
}

/** TC3 派生签名密钥：TC3+secret → date → service → tc3_request */
export function tc3SigningKey(secretKey: string, date: string, service: string): Buffer {
  const kDate = hmacSha256('TC3' + secretKey, date);
  const kService = hmacSha256(kDate, service);
  return hmacSha256(kService, 'tc3_request');
}

/** 规范请求：POST + 空 query，签名头固定 content-type;host */
export function tc3CanonicalRequest(host: string, payload: string, contentType = 'application/json'): string {
  return [
    'POST',
    '/',
    '',
    `content-type:${contentType}`,
    `host:${host}`,
    '',
    'content-type;host',
    sha256hex(payload),
  ].join('\n');
}

export function tc3StringToSign(timestamp: number, date: string, service: string, canonicalRequest: string): string {
  return ['TC3-HMAC-SHA256', String(timestamp), `${date}/${service}/tc3_request`, sha256hex(canonicalRequest)].join('\n');
}

/** 计算 TC3 签名（hex） */
export function tc3Signature(secretKey: string, date: string, service: string, stringToSign: string): string {
  return hmacSha256(tc3SigningKey(secretKey, date, service), stringToSign).toString('hex');
}

export interface TcloudCallOptions {
  secretId: string;
  secretKey: string;
  action: string;
  payload?: Record<string, any>;
  service?: string; // 默认 vpc
  version?: string; // 默认 2017-03-12
  region?: string;
  endpoint?: string; // 默认 vpc.tencentcloudapi.com；测试可指向本地 echo
  timestamp?: number; // 便于单测固定时间
  fetcher?: (url: string, init?: any) => Promise<any>;
}

export interface TcloudCallResult {
  ok: boolean;
  data?: any;
  error?: string;
  /** 实际发出的 Authorization 头（便于测试断言） */
  authorization?: string;
}

function utcDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function buildTc3Headers(opts: Required<Pick<TcloudCallOptions, 'secretId' | 'secretKey' | 'action'>> & {
  host: string;
  payload: string;
  service: string;
  version: string;
  region: string;
  timestamp: number;
}): Record<string, string> {
  const date = utcDate(opts.timestamp);
  const canonical = tc3CanonicalRequest(opts.host, opts.payload);
  const sts = tc3StringToSign(opts.timestamp, date, opts.service, canonical);
  const sig = tc3Signature(opts.secretKey, date, opts.service, sts);
  return {
    'content-type': 'application/json',
    host: opts.host,
    'X-TC-Action': opts.action,
    'X-TC-Version': opts.version,
    'X-TC-Timestamp': String(opts.timestamp),
    'X-TC-Region': opts.region,
    Authorization:
      `TC3-HMAC-SHA256 Credential=${opts.secretId}/${date}/${opts.service}/tc3_request, ` +
      `SignedHeaders=content-type;host, Signature=${sig}`,
  };
}

/** RFC3986 编码：腾讯云规范要求 !'()* 也转义（encodeURIComponent 不处理这几个） */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 规范查询串：key 字典序排序，key/value 逐项 RFC3986 编码 */
export function tc3CanonicalQuery(url: URL): string {
  const entries = [...url.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
}

/**
 * 通用 TC3 签名：给「实际要发出去的那条 HTTP 请求」签名，供 Model B 代理注入使用。
 *
 * 与上面的 buildTc3Headers 区别：那个是我们自己构造一次腾讯云 POST 调用（固定 POST、空 query、
 * 固定 content-type）；这里 method / path / query / content-type 全部取真实请求值——代理只加签名，
 * 不改调用方语义。
 *
 * 为什么必须最后一步签名：腾讯云逐字节比对规范请求，path / query / content-type 任一与真实请求
 * 不一致就返回 AuthFailure.SignatureFailure。调用方经代理带来的 content-type 会进转发头，
 * 必须先定稿再加签名。
 */
export function tc3RequestHeaders(opts: {
  secretId: string;
  secretKey: string;
  service: string;
  method: string;
  target: URL;
  headers: Record<string, string>;
  body: string | Buffer;
  timestamp?: number;
}): Record<string, string> {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const date = utcDate(ts);
  const contentType = String(opts.headers['content-type'] || 'application/json; charset=utf-8').trim();
  const host = opts.target.host;
  const canonical = [
    opts.method.toUpperCase(),
    opts.target.pathname || '/',
    tc3CanonicalQuery(opts.target),
    `content-type:${contentType}`,
    `host:${host}`,
    '',
    'content-type;host',
    sha256hex(opts.body),
  ].join('\n');
  const sts = ['TC3-HMAC-SHA256', String(ts), `${date}/${opts.service}/tc3_request`, sha256hex(canonical)].join('\n');
  const sig = hmacSha256(tc3SigningKey(opts.secretKey, date, opts.service), sts).toString('hex');
  return {
    'content-type': contentType,
    host,
    'X-TC-Timestamp': String(ts),
    Authorization:
      `TC3-HMAC-SHA256 Credential=${opts.secretId}/${date}/${opts.service}/tc3_request, ` +
      `SignedHeaders=content-type;host, Signature=${sig}`,
  };
}

/** 调用腾讯云 API（JSON 接口） */
export async function tcloudCall(opts: TcloudCallOptions): Promise<TcloudCallResult> {
  const service = opts.service || 'vpc';
  const version = opts.version || '2017-03-12';
  const host = opts.endpoint || 'vpc.tencentcloudapi.com';
  const region = opts.region || '';
  const payload = JSON.stringify(opts.payload || {});
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const protocol = host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https';

  const headers = buildTc3Headers({
    secretId: opts.secretId,
    secretKey: opts.secretKey,
    action: opts.action,
    host,
    payload,
    service,
    version,
    region,
    timestamp,
  });

  const fetcher = opts.fetcher || ((globalThis as any).fetch as (u: string, i?: any) => Promise<any>);
  try {
    const res = await fetcher(`${protocol}://${host}/`, { method: 'POST', headers, body: payload });
    const text = typeof res?.text === 'function' ? await res.text() : String(res ?? '');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    const resp = json?.Response ?? json;
    if (resp && resp.Error) {
      return { ok: false, error: `${resp.Error.Code}: ${resp.Error.Message}`, data: json, authorization: headers.Authorization };
    }
    return { ok: true, data: json, authorization: headers.Authorization };
  } catch (e) {
    return { ok: false, error: (e as Error).message, authorization: headers.Authorization };
  }
}
