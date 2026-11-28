/**
 * 本地 SSH agent（ssh-agent 协议子集）。
 *
 * 目标：把保险库里的 SSH 私钥做成标准 agent，之后 `ssh` / `git` / `scp` / `rsync`
 * 就直接可用——私钥不出本进程，也不会被写进 ~/.ssh 或 Agent 的上下文。
 *
 * 接入方式按平台不同：
 * - macOS / Linux：export SSH_AUTH_SOCK=<dataDir>/agent.sock（Unix domain socket）
 * - Windows：命名管道 \\.\pipe\flintkeep-agent-<用户名>，在 ssh_config 里写
 *   `IdentityAgent //./pipe/flintkeep-agent-<用户名>`（Win32-OpenSSH 不读 SSH_AUTH_SOCK）
 *
 * 实现范围（够用且最小）：
 * - SSH_AGENTC_REQUEST_IDENTITIES → 列出 ssh_key 资产里的私钥（comment = 资产名）
 * - SSH_AGENTC_SIGN_REQUEST → 用匹配的私钥签名，支持 ed25519 / RSA(sha1|sha2-256|sha2-512) / ECDSA(p256/384/521)
 * - 增删密钥一律 SSH_AGENT_FAILURE：本 agent 是只读视图，密钥来源只有保险库
 *
 * 安全约束：
 * - socket 文件 0600、目录 0700，只允许本用户进程连接（与系统 ssh-agent 同级别）
 * - 每次签名前过 guard（锁屏策略）；拒绝也写审计，便于排查「谁在用我的密钥」
 * - 审计只记资产/算法/数据长度，不记被签名的内容
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import ssh2 from 'ssh2';
import type { Vault } from './vault';

// ===== 协议常量（draft-miller-ssh-agent）=====
const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const SSH2_AGENT_SIGN_RESPONSE = 14;
const SSH2_AGENT_FAILURE = 5;

/** RSA 签名算法标志位（RSA_SHA2_256 / RSA_SHA2_512） */
const RSA_SHA2_256 = 2;
const RSA_SHA2_512 = 4;

/** 单帧上限：密钥 blob 与待签数据都是小对象，超过就是异常输入 */
const MAX_FRAME = 256 * 1024;
/** Unix socket 路径上限（macOS 104 / Linux 108），留些余量 */
const MAX_SOCKET_PATH = 100;

// ===== Windows 命名管道 =====
/**
 * Windows 没有 Unix domain socket，同等的本地进程间通道是命名管道。
 * 本 agent 在 Windows 上监听 `\\.\pipe\flintkeep-agent-<用户名>`，
 * 客户端用 ssh_config 的 `IdentityAgent` 指过来（Win32-OpenSSH 不认 SSH_AUTH_SOCK）。
 */
const IS_WIN = process.platform === 'win32';
const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';
/** Win32-OpenSSH 自带的 agent 管道名；接管模式会占用它 */
export const WIN_SYSTEM_AGENT_PIPE = `${WIN_PIPE_PREFIX}openssh-ssh-agent`;

/** 管道名里放用户名：同一台机器多用户各用各的，不会互相抢 */
function userSlug(): string {
  try {
    return (os.userInfo().username || 'user').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 24) || 'user';
  } catch {
    return 'user';
  }
}

/**
 * 计算 agent 的监听端点。
 *
 * - POSIX：`<dataDir>/agent.sock`（可被 --socket 覆盖，走 path.resolve）
 * - Windows：命名管道；显式传入 `\\.\pipe\...` 才采用，传文件路径会忽略；
 *   takeoverSystemAgent=true 时占用系统管道 `\\.\pipe\openssh-ssh-agent`
 */
export function agentEndpoint(opts: {
  dataDir: string;
  socketPath?: string;
  takeoverSystemAgent?: boolean;
}): string {
  if (!IS_WIN) return path.resolve(opts.socketPath || path.join(opts.dataDir, 'agent.sock'));
  const custom = opts.socketPath && opts.socketPath.startsWith(WIN_PIPE_PREFIX) ? opts.socketPath : '';
  if (custom) return custom;
  if (opts.takeoverSystemAgent) return WIN_SYSTEM_AGENT_PIPE;
  return `${WIN_PIPE_PREFIX}flintkeep-agent-${userSlug()}`;
}

/** 展示用的 ssh_config 写法：`//./pipe/xxx`（Windows 路径里的反斜杠在 config 中要转义，正斜杠更稳） */
export function pipeToSshConfig(endpoint: string): string {
  return endpoint.startsWith(WIN_PIPE_PREFIX)
    ? `//./pipe/${endpoint.slice(WIN_PIPE_PREFIX.length)}`
    : endpoint;
}

// ===== 线格式工具 =====
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
/** SSH string：4 字节长度 + 正文 */
function str(b: Buffer): Buffer {
  return Buffer.concat([u32(b.length), b]);
}
/** SSH mpint：去掉前导 0，最高位为 1 时补一个 0，零值编码为空 */
function mpint(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i += 1;
  let v = b.subarray(i);
  if (v.length && (v[0] & 0x80) !== 0) v = Buffer.concat([Buffer.from([0]), v]);
  if (!v.length) v = Buffer.alloc(0);
  return str(v);
}

class Reader {
  private off = 0;
  constructor(private buf: Buffer) {}
  get rest(): number {
    return this.buf.length - this.off;
  }
  u32(): number {
    if (this.rest < 4) throw new Error('帧长度不足');
    const n = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return n;
  }
  str(): Buffer {
    const n = this.u32();
    if (n > this.rest) throw new Error('帧内字符串越界');
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return Buffer.from(v);
  }
}

// ===== 密钥 =====
type CachedKey = {
  /** 资产更新时间，变化即重建 */
  sig: string;
  assetId: string;
  name: string;
  /** SSH 公钥线格式（identities 与匹配都用它） */
  blob: Buffer;
  /** 公钥算法名（ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256…） */
  algo: string;
  key: crypto.KeyObject;
};

/** 从公钥 blob 读算法名（首字段） */
function algoOf(blob: Buffer): string {
  if (blob.length < 4) return '';
  const n = blob.readUInt32BE(0);
  if (n > blob.length - 4) return '';
  return blob.subarray(4, 4 + n).toString('latin1');
}

export type AgentKeyView = { assetId: string; name: string; algo: string; fingerprint: string };

export class SshAgent {
  private server: net.Server | null = null;
  private cache = new Map<string, CachedKey>();
  private starting: Promise<void> | null = null;

  constructor(
    private vault: Vault,
    private opts: {
      dataDir: string;
      socketPath?: string;
      /** Windows：占用系统 agent 管道（\\.\pipe\openssh-ssh-agent），让 ssh 零配置直接用 */
      takeoverSystemAgent?: boolean;
      /** 返回拒绝原因则本次请求失败（锁屏策略）；null 放行 */
      guard?: () => string | null;
    }
  ) {}

  /** 监听端点：POSIX 是 socket 文件，Windows 是命名管道（见 agentEndpoint） */
  get socketPath(): string {
    return agentEndpoint(this.opts);
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 启动监听。已有一个可连的 socket 时抛错（避免两个 agent 抢同一个地址），
   * 只有「文件在但没人听」才允许清理，否则手工删文件后残留会永久卡住。
   */
  listen(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doListen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doListen(): Promise<void> {
    const sock = this.socketPath;

    // ---- Windows：命名管道 ----
    // 管道没有「文件」，不能 unlink 清理；能不能连上就是唯一的存活判据。
    if (IS_WIN) {
      if (await canConnect(sock)) throw new Error(`SSH agent 已在运行：${sock}`);
      await this.listenOn(sock);
      return;
    }

    // ---- POSIX：Unix domain socket（原逻辑保持不变）----
    if (sock.length > MAX_SOCKET_PATH) {
      throw new Error(`socket 路径过长（${sock.length} > ${MAX_SOCKET_PATH}）：请用 --socket 指定更短的路径`);
    }
    fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
    if (fs.existsSync(sock)) {
      if (await canConnect(sock)) throw new Error(`SSH agent 已在运行：${sock}`);
      fs.unlinkSync(sock);
    }

    await this.listenOn(sock);

    try {
      fs.chmodSync(sock, 0o600);
    } catch {
      /* 权限收紧失败不影响可用性，但下面的告警值得记录 */
      console.warn(`[ssh-agent] 无法把 ${sock} 权限设为 0600`);
    }
  }

  /** 在给定端点上开监听（socket 路径或命名管道都由 net.listen 处理） */
  private async listenOn(ep: string): Promise<void> {
    const srv = net.createServer((conn) => this.handle(conn));
    this.server = srv;
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => {
        srv.off('listening', onOk);
        reject(e);
      };
      const onOk = () => {
        srv.off('error', onErr);
        resolve();
      };
      srv.once('error', onErr);
      srv.once('listening', onOk);
      srv.listen(ep);
    });
    srv.on('error', (e) => console.warn(`[ssh-agent] ${e.message}`));
  }

  /** 停止监听并清理 socket 文件（Windows 管道随进程关闭自动消失） */
  async close(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.cache.clear();
    if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
    if (IS_WIN) return;
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    } catch {
      /* 已被别人清掉就忽略 */
    }
  }

  /** 当前可用的密钥视图（用于界面/状态展示，不含私钥） */
  keys(): AgentKeyView[] {
    return this.loadKeys().map((k) => ({
      assetId: k.assetId,
      name: k.name,
      algo: k.algo,
      fingerprint: fingerprintOf(k.blob),
    }));
  }

  // ===== 请求处理 =====
  private handle(conn: net.Socket) {
    let buf: Buffer = Buffer.alloc(0);
    conn.on('error', () => conn.destroy());
    conn.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0 || len > MAX_FRAME) {
          conn.destroy();
          return;
        }
        if (buf.length < 4 + len) break;
        const msg = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let reply: Buffer | null;
        try {
          reply = this.dispatch(msg);
        } catch {
          reply = frame(SSH2_AGENT_FAILURE, Buffer.alloc(0));
        }
        if (reply) conn.write(reply);
      }
    });
  }

  private dispatch(msg: Buffer): Buffer {
    const type = msg[0];
    const body = msg.subarray(1);
    switch (type) {
      case SSH2_AGENTC_REQUEST_IDENTITIES:
        return this.identitiesAnswer();
      case SSH2_AGENTC_SIGN_REQUEST:
        return this.sign(body);
      default:
        // ADD/REMOVE/LOCK/EXTENSION：本 agent 只读，一律失败，不给调用方"能改密钥"的错觉
        return frame(SSH2_AGENT_FAILURE, Buffer.alloc(0));
    }
  }

  private identitiesAnswer(): Buffer {
    const keys = this.loadKeys();
    const parts: Buffer[] = [u32(keys.length)];
    for (const k of keys) {
      parts.push(str(k.blob));
      parts.push(str(Buffer.from(k.name, 'utf8')));
    }
    return frame(SSH2_AGENT_IDENTITIES_ANSWER, Buffer.concat(parts));
  }

  private sign(body: Buffer): Buffer {
    const r = new Reader(body);
    const wantBlob = r.str();
    const data = r.str();
    const flags = r.rest >= 4 ? r.u32() : 0;

    const key = this.loadKeys().find((k) => k.blob.equals(wantBlob));
    if (!key) return frame(SSH2_AGENT_FAILURE, Buffer.alloc(0));

    const deny = this.opts.guard?.() || null;
    if (deny) {
      this.vault.auditExternal('agent_sign_denied', {
        asset: key.name,
        assetId: key.assetId,
        reason: deny.slice(0, 120),
      });
      return frame(SSH2_AGENT_FAILURE, Buffer.alloc(0));
    }

    let algo: string;
    let sig: Buffer;
    try {
      ({ algo, sig } = signWith(key, data, flags));
    } catch (e) {
      this.vault.auditExternal('agent_sign_error', {
        asset: key.name,
        assetId: key.assetId,
        error: (e as Error).message.slice(0, 120),
      });
      return frame(SSH2_AGENT_FAILURE, Buffer.alloc(0));
    }

    this.vault.auditExternal('agent_sign', {
      asset: key.name,
      assetId: key.assetId,
      algo,
      bytes: data.length,
    });
    return frame(SSH2_AGENT_SIGN_RESPONSE, str(Buffer.concat([str(Buffer.from(algo, 'latin1')), str(sig)])));
  }

  // ===== 密钥装载 =====
  /**
   * 每次请求都从 vault 取一遍清单（reload 自带 mtime 判断，很便宜），
   * 再按 updatedAt 判断是否需要重新解密私钥——改密钥后立刻生效，没改就不重复解。
   */
  private loadKeys(): CachedKey[] {
    let rows;
    try {
      rows = this.vault.list('ssh_key');
    } catch {
      // 库被锁/无法 reload 时按「没有可用密钥」处理：调用方拿到 FAILURE，不会误签
      this.cache.clear();
      return [];
    }
    const alive = new Set<string>();
    for (const row of rows) {
      alive.add(row.id);
      const sig = `${row.updatedAt || ''}|${row.privateKeyEnc ? 'inline' : 'file'}`;
      const hit = this.cache.get(row.id);
      if (hit && hit.sig === sig && hit.name === (row.name || '')) continue;
      const built = this.parseKey(row.id, row.name, row.updatedAt);
      if (built) this.cache.set(row.id, built);
      else this.cache.delete(row.id);
    }
    for (const id of [...this.cache.keys()]) if (!alive.has(id)) this.cache.delete(id);
    // 稳定排序：按资产编号，ssh-add -l 的顺序才可预期
    return [...this.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private parseKey(assetId: string, name: string, updatedAt: string): CachedKey | null {
    const asset = this.vault.peek(assetId);
    const pem = asset?.privateKeyEnc;
    if (!asset || !pem) return null;
    try {
      const parsed = ssh2.utils.parseKey(pem, asset.keyPassphrase || undefined);
      if (parsed instanceof Error) throw parsed;
      if (!parsed.isPrivateKey()) return null;
      const blob = parsed.getPublicSSH();
      const key = crypto.createPrivateKey(parsed.getPrivatePEM());
      const algo = algoOf(blob);
      if (!algo) return null;
      return {
        sig: `${updatedAt || ''}|${asset.privateKeyEnc ? 'inline' : 'file'}`,
        assetId,
        name: asset.name || name || assetId,
        blob,
        algo,
        key,
      };
    } catch (e) {
      // 单个坏密钥不该让整个 agent 挂掉：跳过并把原因写审计，便于用户定位是哪一条
      this.vault.auditExternal('agent_key_invalid', {
        assetId,
        name: name || assetId,
        error: (e as Error).message.slice(0, 120),
      });
      return null;
    }
  }
}

/** 按公钥算法生成签名（签名值不含外层算法名，由调用方拼） */
function signWith(k: CachedKey, data: Buffer, flags: number): { algo: string; sig: Buffer } {
  switch (k.algo) {
    case 'ssh-ed25519':
      return { algo: 'ssh-ed25519', sig: crypto.sign(null, data, k.key) };
    case 'ssh-rsa': {
      if (flags & RSA_SHA2_512) return { algo: 'rsa-sha2-512', sig: crypto.sign('sha512', data, k.key) };
      if (flags & RSA_SHA2_256) return { algo: 'rsa-sha2-256', sig: crypto.sign('sha256', data, k.key) };
      // 老客户端只认 sha1；现代 OpenSSH 会带 SHA2 标志位，走不到这里
      return { algo: 'ssh-rsa', sig: crypto.sign('sha1', data, k.key) };
    }
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521': {
      const hash = k.algo.endsWith('nistp256') ? 'sha256' : k.algo.endsWith('nistp384') ? 'sha384' : 'sha512';
      const raw = crypto.sign(hash, data, { key: k.key, dsaEncoding: 'ieee-p1363' });
      const half = Math.floor(raw.length / 2);
      return { algo: k.algo, sig: Buffer.concat([mpint(raw.subarray(0, half)), mpint(raw.subarray(half))]) };
    }
    default:
      throw new Error(`不支持的密钥类型 ${k.algo}`);
  }
}

function fingerprintOf(blob: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

function frame(type: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([type]), payload]);
  return Buffer.concat([u32(body.length), body]);
}

function canConnect(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    const done = (v: boolean) => {
      c.destroy();
      resolve(v);
    };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
}

/**
 * 通过 socket 查询当前密钥列表（不需要口令，也不需要 vault 实例）。
 * `fk agent status` 用它确认 agent 真的在跑。
 */
export function queryAgent(
  socketPath: string,
  timeoutMs = 1500
): Promise<{ assetless: true; keys: { type: string; comment: string; blob: string }[] }> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error('连接超时'));
    }, timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      c.destroy();
      reject(e);
    };
    c.once('error', fail);
    c.once('connect', () => c.write(frame(SSH2_AGENTC_REQUEST_IDENTITIES, Buffer.alloc(0))));
    c.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const msg = buf.subarray(4, 4 + len);
      clearTimeout(timer);
      c.destroy();
      if (msg[0] !== SSH2_AGENT_IDENTITIES_ANSWER) return reject(new Error('agent 拒绝了请求'));
      try {
        const r = new Reader(msg.subarray(1));
        const n = r.u32();
        const keys: { type: string; comment: string; blob: string }[] = [];
        for (let i = 0; i < n; i += 1) {
          const blob = r.str();
          const comment = r.str().toString('utf8');
          keys.push({ type: algoOf(blob), comment, blob: blob.toString('base64') });
        }
        resolve({ assetless: true, keys });
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}