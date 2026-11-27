import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import type { Vault } from './vault';
import { tc3RequestHeaders } from './tcloud';

/**
 * 代理访问令牌存储（Model B）：
 * 令牌由 Vault 签发，真实密钥由代理服务端注入，令牌本身不含任何密钥。
 * 采用文件级存储（proxy_tokens.jsonl），使 MCP 进程与 REST 代理进程共享校验，
 * 短 TTL（默认 1 小时）过期即失效；resolve 时顺带清理过期项。
 */
export class ProxyManager {
  private file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'proxy_tokens.jsonl');
  }
  private read(): { token: string; assetId: string; expiresAt: number }[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  private write(recs: { token: string; assetId: string; expiresAt: number }[]) {
    fs.writeFileSync(this.file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  issue(assetId: string, ttlSec = 3600): string {
    const token = crypto.randomBytes(24).toString('hex');
    const recs = this.read();
    recs.push({ token, assetId, expiresAt: Date.now() + ttlSec * 1000 });
    this.write(recs);
    return token;
  }
  resolve(token: string): string | null {
    const recs = this.read();
    const now = Date.now();
    let found: string | null = null;
    const kept: typeof recs = [];
    for (const r of recs) {
      if (now > r.expiresAt) continue; // 过期丢弃
      if (r.token === token) found = r.assetId;
      // 命中的那条也必须留在 kept 里：令牌在 TTL 内可重复使用，不是一次性的。
      // 之前写成 else kept.push 会把「刚验证通过的令牌」从文件里抹掉，
      // 结果同一个令牌第二次请求就被判无效（Agent 侧表现为「偶发 403」）。
      kept.push(r);
    }
    if (kept.length !== recs.length) this.write(kept); // 触发清理
    return found;
  }
  revoke(token: string) {
    this.write(this.read().filter((r) => r.token !== token));
  }
  /**
   * 吊销全部令牌：锁定 / 改口令时调用。
   * 不这样做的话，锁定前签发、已经泄露到 Agent 上下文的令牌会在下次解锁后复活。
   */
  revokeAll(): void {
    try {
      if (fs.existsSync(this.file)) fs.rmSync(this.file);
    } catch {
      /* 删不掉就覆盖成空文件，效果一致 */
      try { this.write([]); } catch { /* ignore */ }
    }
  }
}

/** 转发到上游时允许携带的请求头白名单（其余一律丢弃，避免把调用方身份/凭据带过去） */
const HEADER_ALLOWLIST = new Set([
  'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language',
  'user-agent', 'cache-control', 'pragma', 'range', 'if-none-match', 'if-modified-since',
]);
/** 代理请求体上限：云 API 一般远小于这个值，超过直接 413，避免无界 Buffer 吃内存 */
const PROXY_MAX_BODY = 16 * 1024 * 1024;

/** 取资产的主密钥字段（按类型） */
function primarySecret(a: any): string {
  switch (a.type) {
    case 'api_key': return a.secret || '';
    case 'baota': return a.baotaApiKey || a.baotaPassword || '';
    case 'cloud_account': return a.secretAccessKey || a.secretKey || '';
    case 'oss': return a.secretAccessKey || a.secretKey || '';
    default: return '';
  }
}

/** HTTP 代理目标基址：优先 baseUrl，否则 panelUrl；宝塔可单独填 baotaPort 补端口 */
export function resolveProxyBaseUrl(asset: any): string | null {
  const raw = (asset.baseUrl || asset.panelUrl || '').trim();
  if (!raw) return null;
  if (asset.type !== 'baota' || !asset.baotaPort) return raw;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!u.port) u.port = String(asset.baotaPort);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return u.origin + path;
  } catch {
    return raw;
  }
}

// ===== 云厂商请求签名（Model B）：让云/OSS 也走代理注入，真密钥不落 Agent 上下文 =====

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key as any).update(data, 'utf8').digest();
}
function sha256hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
export function hmacSha256Hex(key: Buffer | string, data: string): string {
  return hmacSha256(key, data).toString('hex');
}
function amzDate(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
/** SigV4 派生签名密钥：AWS4+secret → date → region → service → aws4_request */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  let k = hmacSha256('AWS4' + secret, date);
  k = hmacSha256(k, region);
  k = hmacSha256(k, service);
  k = hmacSha256(k, 'aws4_request');
  return k;
}
function awsCanonicalQuery(url: URL): string {
  const entries = [...url.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.length === 0) return '';
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return entries.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
}
/** 构造 SigV4 规范请求串（供测试/签名复用） */
export function awsCanonicalRequest(method: string, url: URL, headers: Record<string, string>, body: string | Buffer): string {
  const payloadHash = sha256hex(body);
  const signed = ['host', ...Object.keys(headers).filter((h) => h !== 'host').sort()];
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}`).join('\n') + '\n';
  return [method.toUpperCase(), url.pathname || '/', awsCanonicalQuery(url), canonicalHeaders, signed.join(';'), payloadHash].join('\n');
}
/** 给请求加 AWS SigV4 签名（写入 headers；mutate target 的 searchParams 之外的 header） */
export function applyAwsSignature(asset: any, method: string, target: URL, headers: Record<string, string>, body: string | Buffer) {
  const ak = asset.accessKeyId;
  const sk = asset.secretAccessKey;
  const region = asset.region || 'us-east-1';
  const service = asset.cloudService || 's3';
  const d = amzDate();
  const datestamp = d.slice(0, 8);
  headers['host'] = target.host;
  headers['x-amz-date'] = d;
  headers['x-amz-content-sha256'] = sha256hex(body);
  const cr = awsCanonicalRequest(method, target, headers, body);
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', d, scope, sha256hex(cr)].join('\n');
  const sig = hmacSha256(signingKey(sk, datestamp, region, service), stringToSign).toString('hex');
  headers['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${['host', 'x-amz-content-sha256', 'x-amz-date'].join(';')}, Signature=${sig}`;
}
/** 阿里云 RPC 规范百分号编码：仅 -_.~ 保留，其余（含 !'()*+ ）都要转 %XX 大写 */
export function aliyunEnc(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}
/**
 * 按阿里云/腾讯云 RPC 规范计算请求签名（HMAC-SHA1 + base64）。
 * 抽出为独立函数，供代理注入(proxy)与白名单模块(whitelist)共用，避免两处各写一遍。
 */
export function aliyunSignature(params: Record<string, string>, secret: string, method = 'GET'): string {
  const keys = Object.keys(params).filter((k) => k !== 'Signature').sort();
  const sorted = keys.map((k) => `${aliyunEnc(k)}=${aliyunEnc(params[k] ?? '')}`).join('&');
  const stringToSign = `${method.toUpperCase()}&${aliyunEnc('/')}&${aliyunEnc(sorted)}`;
  // 注意：阿里云 RPC 规范要求的 HMAC 密钥是「AccessKeySecret + &」，漏掉 & 会报 IncompleteSignature
  return crypto.createHmac('sha1', secret + '&').update(stringToSign).digest('base64');
}

/** 给请求加阿里云/腾讯云 RPC HMAC-SHA1 请求签名（写入 target.searchParams） */
export function applyAliyunSignature(asset: any, method: string, target: URL) {
  const ak = asset.accessKeyId;
  const sk = asset.secretAccessKey;
  const sp = target.searchParams;
  if (!sp.get('Format')) sp.set('Format', 'JSON');
  if (!sp.get('Version')) sp.set('Version', asset.cloudVersion || '2014-05-26');
  if (!sp.get('SignatureVersion')) sp.set('SignatureVersion', '1.0');
  sp.set('AccessKeyId', ak);
  sp.set('SignatureMethod', 'HMAC-SHA1');
  sp.set('SignatureNonce', crypto.randomBytes(12).toString('hex'));
  sp.set('Timestamp', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const params: Record<string, string> = {};
  for (const [k, v] of sp.entries()) params[k] = v;
  sp.set('Signature', aliyunSignature(params, sk, method));
  target.search = sp.toString();
}

/**
 * 根据资产的 proxyInject 配置，算出要注入的请求头 / 查询参数。
 * - header：注入 Authorization: Bearer <secret>，或自定义请求头名
 * - basic ：注入 Authorization: Basic base64(user:secret)
 * - baota ：宝塔面板 API 签名（request_time + request_token = md5(md5(token)+time)）
 * 真实密钥只出现在这份注入结果里，由代理加到对外请求上，Agent 侧看不到。
 */
export function buildProxyInjection(asset: any): { headers: Record<string, string>; query: Record<string, string> } {
  const inj = asset.proxyInject;
  const out: { headers: Record<string, string>; query: Record<string, string> } = { headers: {}, query: {} };
  if (!inj) return out;
  const secret = primarySecret(asset);
  const user = asset.username || asset.baotaUser || '';
  if (inj.mode === 'header') {
    const name = inj.headerName || 'Authorization';
    out.headers[name] = inj.headerName ? secret : `Bearer ${secret}`;
  } else if (inj.mode === 'basic') {
    out.headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${secret}`).toString('base64');
  } else if (inj.mode === 'baota') {
    const time = Math.floor(Date.now() / 1000);
    const requestToken = crypto.createHash('md5').update(crypto.createHash('md5').update(secret + '').digest('hex') + time).digest('hex');
    out.query['request_time'] = String(time);
    out.query['request_token'] = requestToken;
  }
  return out;
}

/**
 * 本地代理服务（Model B 运行时）：监听独立端口，Agent 用「代理基址 + 令牌」发起真实 API 调用，
 * 本服务解析令牌→取出资产→注入真实凭证→转发到资产目标地址，回传响应；真实密钥不落 Agent 上下文。
 */
export class ProxyServer {
  private server?: http.Server;
  /**
   * allowHttp：是否允许把真实密钥注入后转发到 http:// 上游。
   * 默认 false —— 明文上游等于把密钥交给同网段任何抓包者；内网自建面板确实只有 http 时，
   * 由设置里的「允许代理转发到 http 上游」显式打开。
   */
  constructor(private vault: Vault, private port: number, private allowHttp: () => boolean = () => false) {}

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((e: any) => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
      });
      // 仅监听本机回环：Model B 代理只由本机 MCP / REST 调用，不暴露到局域网
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost');
    // 令牌优先从 Authorization 头读（不会进代理日志 / Referer / shell 历史）；
    // ?tok= 仅为兼容旧 Agent 配置保留，文档里已标注 deprecated。
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
    const tok = String(bearer || url.searchParams.get('tok') || '').trim();
    if (!tok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少令牌：请用 Authorization: Bearer <token>（?tok= 已不推荐）' }));
      return;
    }
    const asset = this.vault.resolveProxyAsset(tok);
    if (!asset) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效或已过期的代理令牌' }));
      return;
    }
    const base = resolveProxyBaseUrl(asset);
    if (!base) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '该资产未配置 baseUrl / panelUrl，无法代理转发' }));
      return;
    }
    // 明文上游会把注入的真实密钥暴露给同网段：默认拒绝，需在设置里显式允许
    let baseProto = '';
    try {
      baseProto = new URL(base.includes('://') ? base : `https://${base}`).protocol;
    } catch {
      baseProto = '';
    }
    if (baseProto === 'http:' && !this.allowHttp()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: '该资产是 http:// 上游，代理会以明文发送真实密钥。已在设置里关闭「允许代理转发到 http 上游」。',
          hint: '能换 https 就换；内网面板确实只有 http 时，去「设置 → 后台与锁定」显式打开。',
        })
      );
      return;
    }
    // 路径：去掉首个路径段（即资产 id 占位），其余作为目标子路径
    const segs = url.pathname.split('/').filter(Boolean);
    segs.shift();
    const sub = '/' + segs.join('/');
    const target = new URL(sub || '/', base.endsWith('/') ? base : base + '/');
    // 转发调用方 query（去掉 tok），否则阿里云 RPC Action 等参数到不了上游
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'tok') continue;
      target.searchParams.set(k, v);
    }
    const inj = buildProxyInjection(asset);
    for (const [k, v] of Object.entries(inj.query)) target.searchParams.set(k, v);

    let body: Buffer | null = null;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
      return;
    }

    const lib = target.protocol === 'https:' ? https : http;
    // 只转发必要头：调用方的 Cookie / Origin / Referer / Authorization 不该带到上游资产主机。
    // 先铺调用方白名单头，再让注入头覆盖（注入的 Authorization 才是这条链路要用的）。
    const headers: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (v !== undefined && (HEADER_ALLOWLIST.has(lk) || lk.startsWith('x-'))) headers[lk] = v;
    }
    delete headers['authorization'];
    Object.assign(headers, inj.headers);
    headers['host'] = target.host;

    // 云厂商请求签名：aws=SigV4（headers）、aliyun=HMAC-SHA1（query）、tencent=TC3（headers）。
    // 必须放在转发头定稿之后：调用方带来的 content-type 会进 headers，而腾讯云逐字节比对规范请求，
    // 若先签名再拼头，签名里的 content-type 与真实请求不一致，直接 AuthFailure.SignatureFailure。
    const mode = asset.proxyInject?.mode;
    const httpMethod = req.method || 'GET';
    if (mode === 'aws') applyAwsSignature(asset, httpMethod, target, headers as Record<string, string>, body || '');
    else if (mode === 'aliyun') applyAliyunSignature(asset, httpMethod, target);
    else if (mode === 'tencent') {
      const secretId = String(asset.accessKeyId || asset.secretId || '');
      const secretKey = String(asset.secretAccessKey || asset.secretKey || '');
      const service = String(asset.cloudService || '').trim();
      if (!secretId || !secretKey || !service) {
        const missing = [!secretId && 'SecretId', !secretKey && 'SecretKey', !service && 'cloudService'].filter(Boolean).join(' / ');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `腾讯云签名缺少：${missing}`,
            hint: '腾讯云模式需要资产填 SecretId / SecretKey（或 AccessKeyId / SecretAccessKey），并把「云服务」填成接口所属服务名，如 cvm / cdn / dnspod / vpc。',
          })
        );
        return;
      }
      Object.assign(
        headers,
        tc3RequestHeaders({
          secretId,
          secretKey,
          service,
          method: httpMethod,
          target,
          headers: headers as Record<string, string>,
          body: body || '',
        })
      );
    }
    const upstream = lib.request(
      target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers as any);
        up.pipe(res);
      }
    );
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上游转发失败: ' + e.message }));
    });
    if (body) upstream.write(body);
    upstream.end();
    this.vault.logProxyAccess(asset.id, sub);
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > PROXY_MAX_BODY) {
        reject(new Error(`请求体超过上限（${Math.floor(PROXY_MAX_BODY / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}
