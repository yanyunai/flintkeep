import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { SshAgent, queryAgent } from '../src/core/ssh-agent';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * 本地 SSH agent（真 socket + 真 ed25519 密钥）。
 *
 * 关注点：
 * - 身份列表与签名走标准 agent 协议，签名能用公钥验过；
 * - 只读：ADD/REMOVE 一律失败；
 * - 锁屏策略在**签名**前生效，拒绝也写审计；
 * - socket 生命周期（0600、重复启动报错、close 清理）。
 */
const DATA_DIR = tmpDir('fk-agent-');
const KEY_DIR = tmpDir('fk-agent-key-');
const SOCKET = path.join(DATA_DIR, 'agent.sock');

let agent: SshAgent;
let pubKey: crypto.KeyObject;
let pubBlob: Buffer;

// ===== 协议工具：与 agent 端 frame 一致 =====
const MSG = {
  REQUEST_IDENTITIES: 11,
  IDENTITIES_ANSWER: 12,
  SIGN_REQUEST: 13,
  SIGN_RESPONSE: 14,
  FAILURE: 5,
  ADD_IDENTITY: 17,
} as const;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function str(b: Buffer): Buffer {
  return Buffer.concat([u32(b.length), b]);
}
function frame(type: number, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([type]), payload]);
  return Buffer.concat([u32(body.length), body]);
}
function readStr(buf: Buffer, off: number): { value: Buffer; next: number } {
  const len = buf.readUInt32BE(off);
  return { value: buf.subarray(off + 4, off + 4 + len), next: off + 4 + len };
}

/** 连一次 socket、发一条请求、读一条响应 */
function call(sock: string, msg: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error('协议超时'));
    }, 3000);
    c.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.once('connect', () => c.write(msg));
    c.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      clearTimeout(timer);
      const body = buf.subarray(4, 4 + len);
      c.destroy();
      resolve(body);
    });
  });
}

function signRequest(blob: Buffer, data: Buffer, flags = 0): Buffer {
  return frame(MSG.SIGN_REQUEST, Buffer.concat([str(blob), str(data), u32(flags)]));
}


/** 兼容层没有 expect().rejects：手写断言，真实 vitest 与本地兼容层都能跑 */
async function expectReject(fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(re.test((e as Error).message)).toBe(true);
    return;
  }
  throw new Error('预期失败，但调用成功了');
}

beforeAll(() => {
  // 真密钥：ssh-keygen 生成 OpenSSH 格式（ssh2 不认 PKCS#8 的 ed25519）
  const keyPath = path.join(KEY_DIR, 'id');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const privatePem = fs.readFileSync(keyPath, 'utf8');
  const parsed = ssh2.utils.parseKey(privatePem);
  if (parsed instanceof Error) throw parsed;
  pubBlob = Buffer.from(parsed.getPublicSSH());
  pubKey = crypto.createPublicKey(parsed.getPublicPEM());

  const v = new Vault(DATA_DIR, PP);
  v.add({ type: 'ssh_key', name: 'agent-ed25519', publicKey: '', privateKeyEnc: privatePem, tags: [] });

  agent = new SshAgent(v, { dataDir: DATA_DIR, socketPath: SOCKET });
});

afterAll(async () => {
  await agent?.close();
  cleanup(DATA_DIR);
  cleanup(KEY_DIR);
});

describe('密钥视图', () => {
  it('listen 后 socket 存在且权限为 0600', async () => {
    await agent.listen();
    expect(agent.listening).toBe(true);
    expect(fs.existsSync(SOCKET)).toBe(true);
    expect(fs.statSync(SOCKET).mode & 0o777).toBe(0o600);
  });

  it('keys() 给出名称、算法与 SHA256 指纹（不含私钥）', () => {
    const keys = agent.keys();
    expect(keys.length).toBe(1);
    expect(keys[0].name).toBe('agent-ed25519');
    expect(keys[0].algo).toBe('ssh-ed25519');
    expect(keys[0].fingerprint.startsWith('SHA256:')).toBe(true);
    expect(JSON.stringify(keys)).not.toContain('PRIVATE KEY');
  });
});

describe('协议：身份与签名', () => {
  it('REQUEST_IDENTITIES 返回带注释的公钥列表', async () => {
    const resp = await call(SOCKET, frame(MSG.REQUEST_IDENTITIES, Buffer.alloc(0)));
    expect(resp[0]).toBe(MSG.IDENTITIES_ANSWER);
    const n = resp.readUInt32BE(1);
    expect(n).toBe(1);
    const blob = readStr(resp, 5);
    expect(blob.value.equals(pubBlob)).toBe(true);
    const comment = readStr(resp, blob.next);
    expect(comment.value.toString('utf8')).toBe('agent-ed25519');
  });

  it('SIGN_REQUEST 的签名能用公钥验过（ed25519）', async () => {
    const data = Buffer.from('flintkeep agent test payload');
    const resp = await call(SOCKET, signRequest(pubBlob, data));
    expect(resp[0]).toBe(MSG.SIGN_RESPONSE);
    const inner = readStr(resp, 1).value;
    const algo = readStr(inner, 0);
    const sig = readStr(inner, algo.next);
    expect(algo.value.toString()).toBe('ssh-ed25519');
    expect(crypto.verify(null, data, pubKey, sig.value)).toBe(true);
  });

  it('未知公钥的签名请求被拒（FAILURE）', async () => {
    const other = crypto.generateKeyPairSync('ed25519').publicKey;
    const otherBlob = Buffer.from(other.export({ type: 'spki', format: 'der' }));
    const resp = await call(SOCKET, signRequest(otherBlob, Buffer.from('x')));
    expect(resp[0]).toBe(MSG.FAILURE);
  });

  it('只读视图：ADD_IDENTITY 一律失败', async () => {
    const payload = Buffer.concat([str(pubBlob), str(Buffer.from('agent-ed25519')), str(Buffer.alloc(32, 1))]);
    const resp = await call(SOCKET, frame(MSG.ADD_IDENTITY, payload));
    expect(resp[0]).toBe(MSG.FAILURE);
  });

  it('queryAgent 免口令拿到密钥列表（fk agent status 用）', async () => {
    const r = await queryAgent(SOCKET);
    expect(r.keys.length).toBe(1);
    expect(r.keys[0].type).toBe('ssh-ed25519');
    expect(r.keys[0].comment).toBe('agent-ed25519');
  });
});

describe('锁屏策略', () => {
  it('guard 拒绝时签名失败、身份列表仍可用，并写 agent_sign_denied', async () => {
    const v = new Vault(DATA_DIR, PP);
    const denied = new SshAgent(v, { dataDir: DATA_DIR, socketPath: path.join(DATA_DIR, 'denied.sock'), guard: () => '保险库已锁定' });
    await denied.listen();
    try {
      const ids = await call(denied.socketPath, frame(MSG.REQUEST_IDENTITIES, Buffer.alloc(0)));
      expect(ids[0]).toBe(MSG.IDENTITIES_ANSWER);

      const resp = await call(denied.socketPath, signRequest(pubBlob, Buffer.from('blocked')));
      expect(resp[0]).toBe(MSG.FAILURE);
      const actions = v.auditLog(200).map((e: any) => e.action);
      expect(actions).toContain('agent_sign_denied');
    } finally {
      await denied.close();
    }
  });
});

describe('生命周期', () => {
  it('同一 socket 重复启动报错（避免两个 agent 抢地址）', async () => {
    const second = new SshAgent(new Vault(DATA_DIR, PP), { dataDir: DATA_DIR, socketPath: SOCKET });
    await expectReject(() => second.listen(), /已在运行/);
  });

  it('socket 路径过长时明确报错', async () => {
    const long = path.join(DATA_DIR, 'x'.repeat(120) + '.sock');
    const a = new SshAgent(new Vault(DATA_DIR, PP), { dataDir: DATA_DIR, socketPath: long });
    await expectReject(() => a.listen(), /路径过长/);
  });

  it('close 后停止监听并清理 socket 文件', async () => {
    await agent.close();
    expect(agent.listening).toBe(false);
    expect(fs.existsSync(SOCKET)).toBe(false);
  });
});