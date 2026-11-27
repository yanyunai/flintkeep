import type { Vault } from './vault';
import { resolveServerHost, resolveSshKeyId, type Asset } from './schema';

export type SshDialTarget = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
};

/**
 * 从 server + 关联 ssh_key 解析拨号参数。
 * 主机默认服务器公网 IP；用户/端口/密码/私钥取自 SSH 登录资产（兼容旧数据写在 server 上）。
 * 也接受**自带主机地址的独立 ssh_key**（Agent 常直接把登录建成独立资产）——以自身凭证拨号。
 */
export function resolveSshTarget(vault: Vault, server: Asset): SshDialTarget {
  if (server.type === 'ssh_key') return buildTarget(server, server);
  if (server.type !== 'server') throw new Error('仅 server 类型支持 SSH 代理');

  const keyId = resolveSshKeyId(server);
  const key = keyId ? vault.peek(keyId) : undefined;
  if (keyId && (!key || key.type !== 'ssh_key')) {
    throw new Error('关联的 SSH 登录资产不存在');
  }
  return buildTarget(server, key, keyId);
}

function buildTarget(server: Asset, key: Asset | undefined, keyId?: string | null): SshDialTarget {
  const host = String(key?.sshHost || resolveServerHost(server) || '').trim();
  if (!host) throw new Error('缺少主机地址：请在服务器填写公网 IP，或在 SSH 登录填写主机');

  const port = Number(key?.sshPort || server.sshPort || 22) || 22;
  const username = String(key?.sshUser || server.sshUser || 'root').trim() || 'root';
  const authMethod = key?.authMethod || server.authMethod;
  const privateKey = key?.privateKeyEnc || (server as any).privateKeyEnc;
  const password = key?.sshPassword || server.sshPassword;
  const passphrase = key?.keyPassphrase || server.keyPassphrase;

  const out: SshDialTarget = { host, port, username };

  const preferKey = authMethod === 'key' || !!privateKey || !!keyId;
  if (preferKey && privateKey) {
    out.privateKey = privateKey;
    if (passphrase) out.passphrase = passphrase;
    return out;
  }
  if (password) {
    out.password = password;
    return out;
  }
  if (preferKey && !privateKey) {
    throw new Error('密钥认证需在 SSH 登录资产中配置私钥');
  }
  throw new Error('请在关联的 SSH 登录中配置密码或私钥');
}

/** 把关联 SSH 登录上的字段合并进 server 视图（供 Agent get_server_connection） */
export function mergeServerConnectionView(server: Asset, key?: Asset | null): Asset {
  const host = resolveServerHost(server);
  if (!key) {
    return {
      ...server,
      ip: host || server.ip,
      publicIp: server.publicIp || server.ip,
    };
  }
  return {
    ...server,
    ip: host || server.ip,
    publicIp: server.publicIp || server.ip,
    sshPort: key.sshPort ?? server.sshPort,
    sshUser: key.sshUser || server.sshUser,
    sshPassword: key.sshPassword || server.sshPassword,
    authMethod: key.authMethod || server.authMethod,
    sshKeyId: key.id,
    privateKeyEnc: key.privateKeyEnc,
    keyPassphrase: key.keyPassphrase,
    keyFileName: key.keyFileName,
  } as Asset;
}
