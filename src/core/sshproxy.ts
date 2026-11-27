/**
 * Model B SSH 会话代理（本地堡垒）：
 * Agent 用短期令牌连 127.0.0.1:SSH_PROXY_PORT（username=令牌），
 * 真实 sshPassword / 私钥由保险库在服务端注入，经 ssh2 拨目标机并双向透传。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import ssh2 from 'ssh2';
import type { AuthContext, Session, ServerChannel } from 'ssh2';
import { resolveSshTarget } from './ssh-resolve';
import type { Vault } from './vault';
import type { Asset } from './schema';
export { resolveSshTarget };

const { Server: SshServer, Client: SshClient } = ssh2;

export interface SshAccessInfo {
  proxyHost: string;
  proxyPort: number;
  token: string;
  ttl: number;
  targetHint: string;
  note: string;
}

function ensureHostKey(dataDir: string): Buffer {
  const keyPath = path.join(dataDir, 'ssh_host_key.pem');
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  return Buffer.from(privateKey);
}

/**
 * 本地 SSH 堡垒服务。监听 127.0.0.1，仅接受令牌作为 username。
 */
/**
 * 已知主机密钥库（TOFU：首次连接记录指纹，之后指纹不一致即拒绝）。
 * 用于防止「SSH 堡垒 → 目标服务器」这一段被中间人替换。
 * 记录落地在 dataDir/ssh_known_hosts.json，键为 `host:port`。
 */
export class SshKnownHosts {
  private file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'ssh_known_hosts.json');
  }
  private read(): Record<string, string> {
    try {
      if (!fs.existsSync(this.file)) return {};
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      return {};
    }
  }
  private write(m: Record<string, string>) {
    fs.writeFileSync(this.file, JSON.stringify(m, null, 2));
  }
  /** true=允许连接；首次连接记录指纹并放行，指纹变化返回 false（拒绝） */
  check(host: string, port: number, fp: string): boolean {
    const key = `${host}:${port}`;
    const m = this.read();
    if (m[key] === undefined) {
      m[key] = fp;
      this.write(m);
      return true;
    }
    return m[key] === fp;
  }
}

/**
 * 命令摘要：写审计前抹掉可能带密钥的片段，并截断过长命令。
 * 审计文件是明文 JSONL，命令里的 `-p<密码>`、`TOKEN=...`、URL 里的口令都不能原样落盘。
 */
export function redactCommand(raw: string, max = 200): string {
  const src = String(raw || '');
  let s = src;
  // mysql/ssh 风格的 -pXXX、--password XXX
  s = s.replace(/(--password[= ]|-p\s*)(\S+)/gi, '$1***');
  // 环境变量式赋值
  s = s.replace(/\b(PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY)\s*=\s*(\S+)/gi, '$1=***');
  // curl -H "Authorization: Bearer xxx"
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1***');
  // mysql://user:pass@host 之类的连接串
  s = s.replace(/(:\/\/[^/\s:]+:)([^@\s]+)(@)/g, '$1***$3');
  if (s.length > max) s = s.slice(0, max) + `…(${src.length})`;
  return s;
}

export class SshProxyServer {
  private server?: InstanceType<typeof SshServer>;
  private hostKey: Buffer;
  private knownHosts: SshKnownHosts;
  readonly port: number;
  readonly host = '127.0.0.1';

  constructor(private vault: Vault, dataDir: string, port: number) {
    this.port = port;
    this.hostKey = ensureHostKey(dataDir);
    this.knownHosts = new SshKnownHosts(dataDir);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = new SshServer({ hostKeys: [this.hostKey] }, (client) => {
        this.handleClient(client);
      });
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server?.removeListener('error', reject);
        this.server?.on('error', (e: Error) => console.error('[ssh-proxy] server error:', e.message));
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private handleClient(client: any) {
    let asset: Asset | null = null;
    let token = '';

    client.on('authentication', (ctx: AuthContext) => {
      token = ctx.username || '';
      const a = this.vault.resolveProxyAsset(token);
      // server（机器档案）或自带主机地址的 ssh_key（独立登录）都可经堡垒拨号
      if (!a || (a.type !== 'server' && a.type !== 'ssh_key')) {
        ctx.reject();
        return;
      }
      // 令牌已校验；接受任意认证方法（密码/无密码均可），真实认证在上游完成
      asset = a;
      ctx.accept();
    });

    client.on('ready', () => {
      if (!asset) {
        client.end();
        return;
      }
      const serverAsset = asset;
      this.vault.logProxyAccess(serverAsset.id, 'ssh-session');

      client.on('session', (accept: () => Session, _reject: () => void) => {
        const session = accept();
        let ptyInfo: any = null;

        session.on('pty', (acceptPty: () => void, _rejectPty: () => void, info: any) => {
          ptyInfo = info;
          acceptPty();
        });

        session.on('shell', (acceptShell: () => ServerChannel, rejectShell: () => void) => {
          this.pipeUpstream(serverAsset, acceptShell, rejectShell, null, ptyInfo, client);
        });

        session.on('exec', (acceptExec: () => ServerChannel, rejectExec: () => void, info: { command: string }) => {
          this.pipeUpstream(serverAsset, acceptExec, rejectExec, info.command, ptyInfo, client);
        });
      });
    });

    client.on('error', () => {
      /* 客户端断开 */
    });
  }

  private pipeUpstream(
    serverAsset: Asset,
    accept: () => ServerChannel,
    reject: () => void,
    command: string | null,
    ptyInfo: any,
    client: any
  ) {
    let target;
    try {
      target = resolveSshTarget(this.vault, serverAsset);
    } catch {
      reject();
      return;
    }

    const stream = accept();
    const upstream = new SshClient();
    const started = Date.now();
    let audited = false;
    /** 一次会话只记一条：命令摘要（已脱敏）+ 时长 + 成败；审计失败不影响会话本身 */
    const auditEnd = (ok: boolean, err?: string) => {
      if (audited) return;
      audited = true;
      try {
        this.vault.auditExternal(command ? 'ssh_exec' : 'ssh_session', {
          asset: serverAsset.name,
          assetId: serverAsset.id,
          target: `${target.host}:${target.port}`,
          ...(command ? { command: redactCommand(command) } : {}),
          ms: Date.now() - started,
          ok,
          ...(err ? { error: err.slice(0, 160) } : {}),
        });
      } catch {
        /* 审计写入失败不该掐断用户的会话 */
      }
    };

    const finish = (msg?: string) => {
      auditEnd(!msg, msg);
      try {
        if (msg) stream.write(msg);
        stream.exit(msg ? 1 : 0);
        stream.close();
      } catch {
        /* ignore */
      }
      try {
        upstream.end();
      } catch {
        /* ignore */
      }
    };

    upstream
      .on('ready', () => {
        const open = (err: Error | undefined, upStream: any) => {
          if (err) {
            finish('上游 SSH 会话失败: ' + err.message + '\n');
            return;
          }
          stream.pipe(upStream).pipe(stream);
          upStream.on('close', () => finish());
          stream.on('close', () => {
            try {
              upStream.close();
            } catch {
              /* ignore */
            }
            try {
              upstream.end();
            } catch {
              /* ignore */
            }
          });
        };

        if (command) {
          upstream.exec(command, open);
        } else if (ptyInfo) {
          upstream.shell(
            {
              term: ptyInfo.term,
              cols: ptyInfo.cols,
              rows: ptyInfo.rows,
              width: ptyInfo.width,
              height: ptyInfo.height,
            },
            open
          );
        } else {
          upstream.shell(open);
        }
      })
      .on('error', (e: Error) => {
        finish('连接目标失败: ' + e.message + '\n');
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKey: target.privateKey,
        passphrase: target.passphrase,
        readyTimeout: 15000,
        // 校验目标主机密钥：sha256 指纹 + TOFU（首次记录，变更即拒绝），防中间人
        hostHash: 'sha256',
        hostVerifier: (fp: string) => this.knownHosts.check(target.host, target.port, fp),
      } as any);

    client.on('end', () => {
      auditEnd(true);
      try {
        upstream.end();
      } catch {
        /* ignore */
      }
    });
  }
}
