import * as crypto from 'crypto';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { SshProxyServer, redactCommand } from '../src/core/sshproxy';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * SSH 堡垒（Model B）端到端：本地起一台「目标机」，经堡垒用令牌连过去。
 *
 * 关注点：
 * - 透传不改行为（exec 输出原样回来）；
 * - 会话收尾写一条审计：命令摘要（脱敏）+ 时长 + 成败；
 * - 上游连不上时如实记失败，不假装成功。
 */
const DATA_DIR = tmpDir('fk-sshproxy-');
const TARGET_PORT = 20000 + Math.floor(Math.random() * 10000);
const PROXY_PORT = 30000 + Math.floor(Math.random() * 10000);

const { Server: SshServer, Client: SshClient } = ssh2;

let target: InstanceType<typeof SshServer>;
let proxy: SshProxyServer;
let vault: Vault;
let token = '';
let badToken = '';
let targetId = '';

function hostKey(): Buffer {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return Buffer.from(privateKey);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function execViaProxy(cmd: string): Promise<{ out: string; errText: string }> {
  return new Promise((resolve, reject) => {
    const c = new SshClient();
    let out = '';
    let errText = '';
    c.on('ready', () => {
      c.exec(cmd, (e, stream) => {
        if (e) return reject(e);
        stream.on('data', (d: Buffer) => (out += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (errText += d.toString()));
        stream.on('close', () => {
          c.end();
          resolve({ out, errText });
        });
      });
    });
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port: PROXY_PORT, username: token, password: 'x', readyTimeout: 8000 } as any);
  });
}

beforeAll(async () => {
  // 目标机：任意用户/密码放行，exec 回显一条固定输出
  target = new SshServer({ hostKeys: [hostKey()] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('exec', (acceptExec, _rejectExec, info: { command: string }) => {
          const ch = acceptExec();
          ch.write(`ran:${info.command}\n`);
          ch.exit(0);
          ch.end();
        });
        // 交互 shell 会先请求 pty；目标机不接就会得到「Unable to request a pseudo-terminal」
        s.on('pty', (acceptPty) => acceptPty());
        s.on('shell', (acceptShell) => {
          const ch = acceptShell();
          ch.write('shell-ready\n');
          ch.exit(0);
          ch.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => target.listen(TARGET_PORT, '127.0.0.1', () => resolve()));

  vault = new Vault(DATA_DIR, PP);
  const a = vault.add({
    type: 'server',
    name: 'proxy-target',
    ip: '127.0.0.1',
    sshPort: TARGET_PORT,
    sshUser: 'test',
    sshPassword: 'FAKE_TARGET_PW',
    tags: [],
  });
  targetId = a.id;
  token = vault.issueSshAccess(targetId, 600).token;

  // 一台指向未监听端口的资产：用来验证失败路径也留审计
  const bad = vault.add({
    type: 'server',
    name: 'proxy-dead',
    ip: '127.0.0.1',
    sshPort: 1,
    sshUser: 'test',
    sshPassword: 'FAKE_TARGET_PW',
    tags: [],
  });
  badToken = vault.issueSshAccess(bad.id, 600).token;

  proxy = new SshProxyServer(vault, DATA_DIR, PROXY_PORT);
  await proxy.listen();
});

afterAll(async () => {
  await proxy?.close();
  await new Promise<void>((resolve) => target?.close(() => resolve()));
  cleanup(DATA_DIR);
});

describe('命令摘要脱敏', () => {
  it('-pXXX / TOKEN= / Bearer / 连接串里的口令都被抹掉', () => {
    const out = redactCommand('mysql -pSUPERSECRET -u root; curl -H "Authorization: Bearer abc123" x; export TOKEN=t0ken; mysql://u:pw@h/db');
    expect(out).not.toContain('SUPERSECRET');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('t0ken');
    expect(out).not.toContain('pw@h');
    expect(out).toContain('mysql -p***');
    expect(out).toContain('Bearer ***');
  });

  it('超长命令截断但标注原长', () => {
    const raw = 'echo ' + 'a'.repeat(300);
    const out = redactCommand(raw, 50);
    expect(out.length < raw.length).toBe(true);
    expect(out).toContain('(305)');
  });
});

describe('透传与会话审计', () => {
  it('exec 输出原样回来，并写一条 ssh_exec（命令 + 时长 + 成功）', async () => {
    const r = await execViaProxy('echo hi');
    expect(r.out).toContain('ran:echo hi');
    await wait(120);

    const row = vault.auditLog(200).find((e: any) => e.action === 'ssh_exec');
    expect(row).toBeTruthy();
    expect(row.command).toBe('echo hi');
    expect(row.ok).toBe(true);
    expect(typeof row.ms).toBe('number');
    expect(row.ms >= 0).toBe(true);
    expect(String(row.target)).toContain(`127.0.0.1:${TARGET_PORT}`);
  }, 15000);

  it('命令里的密码进审计前已被脱敏', async () => {
    const r = await execViaProxy('mysql -pSUPERSECRET -u root');
    expect(r.out).toContain('ran:');
    await wait(120);

    const rows = vault.auditLog(200).filter((e: any) => e.action === 'ssh_exec');
    const hit = rows.find((e: any) => String(e.command).includes('mysql'));
    expect(hit).toBeTruthy();
    expect(hit.command).toContain('-p***');
    expect(hit.command).not.toContain('SUPERSECRET');
  }, 15000);

  it('交互 shell 记 ssh_session（无 command 字段）', async () => {
    await new Promise<void>((resolve, reject) => {
      const c = new SshClient();
      c.on('ready', () => {
        c.shell((e, stream) => {
          if (e) return reject(e);
          stream.on('data', () => undefined);
          stream.on('close', () => {
            c.end();
            resolve();
          });
        });
      });
      c.on('error', reject);
      c.connect({ host: '127.0.0.1', port: PROXY_PORT, username: token, password: 'x', readyTimeout: 8000 } as any);
    });
    await wait(150);

    const row = vault.auditLog(200).find((e: any) => e.action === 'ssh_session');
    expect(row).toBeTruthy();
    expect(row.command).toBeUndefined();
    expect(row.ok).toBe(true);
  }, 15000);

  it('上游连不上时审计记失败并带错误原因', async () => {
    await new Promise<void>((resolve) => {
      const c = new SshClient();
      c.on('ready', () => {
        c.exec('echo x', (e, stream) => {
          if (e) return resolve();
          stream.on('data', () => undefined);
          stream.on('close', () => {
            c.end();
            resolve();
          });
          stream.on('error', () => resolve());
        });
      });
      const done = () => {
        try { c.end(); } catch { /* ignore */ }
        resolve();
      };
      c.on('error', done);
      c.connect({ host: '127.0.0.1', port: PROXY_PORT, username: badToken, password: 'x', readyTimeout: 8000 } as any);
    });
    await wait(150);

    const rows = vault.auditLog(200).filter((e: any) => e.action === 'ssh_exec' && e.ok === false);
    expect(rows.length >= 1).toBe(true);
    expect(String(rows[0].error || '').length > 0).toBe(true);
  }, 20000);
});