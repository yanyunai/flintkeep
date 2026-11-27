/**
 * 运维类路由：撤销、审计（含导出）、轮换清单、搜索、机房连通性探测、
 * 代理与 SSH 短期凭据签发、Agent 自报操作。
 *
 * 从 `server.ts` 整体搬出，路径互不重叠，判断顺序与行为不变。
 */
import * as net from 'net';
import type * as http from 'http';
import { send, readBody } from './http-util';
import { t } from '../shared/i18n';
import type { Vault } from '../core/vault';
import { resolveServerHost, resolveSshKeyId } from '../core/schema';
export type RouteCtx = {
  v: Vault;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
  proxyPort: number;
};

export async function handleOpsRoutes(ctx: RouteCtx): Promise<boolean> {
  const { v, req, res, url, p, proxyPort } = ctx;
  /** 发完响应就返回 true：外层 if (await handle…) return; 保持原来的顺序与短路语义 */
  const reply = (code: number, obj: any, headers: Record<string, string> = {}): true => {
    send(res, code, obj, headers);
    return true;
  };

  if (p === '/api/undo' && req.method === 'POST') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const body = await readBody(req);
    if (!body?.uid) return reply(400, { error: '缺少 uid' });
    try {
      return reply(200, v.undo(body.uid));
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  if (p === '/api/audit') {
    const page = Number(url.searchParams.get('page') || 1);
    const pageSize = Number(url.searchParams.get('pageSize') || 20);
    // 兼容：无分页参数且未显式要 page 时仍可用旧数组；有 page/pageSize 则返回分页对象
    if (url.searchParams.has('page') || url.searchParams.has('pageSize')) {
      const kind = (url.searchParams.get('kind') || '').trim();
      return reply(200, v.auditPage(page, pageSize, kind));
    }
    // limit 是调用方最直觉的写法（?limit=5）。以前这里只认 page/pageSize，
    // 传 limit 会被静默忽略并返回 200 条 —— 调用方以为自己限了量，实际多拿了 40 倍数据。
    // 这里按「最近 N 条」处理，上限仍是 200，返回形状与默认一致（数组），不改变老调用方。
    const limitRaw = url.searchParams.get('limit');
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      return reply(200, v.auditLog(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 200));
    }
    return reply(200, v.auditLog(200));
  }
  if (p === '/api/audit/export' && req.method === 'GET') {
    // 导出是「把证据带走」：原文 JSONL（含历史代），不裁剪、不脱敏——
    // 审计本身不含密钥（meta 白名单在写入侧已做），脱敏反而会毁掉可追溯性。
    const text = v.exportAuditText();
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="flintkeep-audit-${stamp}.jsonl"`,
      'Cache-Control': 'no-store',
    });
    res.end(text);
    return true;
  }
  if (p === '/api/rotation') return reply(200, v.dueForRotation());
  if (p === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return reply(200, []);
    // 模糊搜索（名称 / IP / 备注等）；备忘录不进资产清单与搜索结果
    return reply(
      200,
      v.search(q).filter((a: any) => a.type !== 'note')
    );
  }

  // ===== 机房主页：设备连通性检测（TCP 握手，3 秒超时；只读不改任何数据） =====
  if (p === '/api/studio/check' && req.method === 'GET') {
    const a = v.get(url.searchParams.get('id') || '');
    if (!a) return reply(404, { error: '资产不存在' });
    if (a.type !== 'server') return reply(400, { error: '仅支持 server 类型' });
    // 主机/端口与 SSH 代理同一套解析：SSH 布局迁移后端口在关联的 ssh_key 上，server 本体可能是空的
    const keyId = resolveSshKeyId(a);
    const key = keyId ? v.peek(keyId) : undefined;
    const host = String(key?.sshHost || resolveServerHost(a) || '').trim();
    const port = Number(key?.sshPort || a.sshPort || (a.openPorts || [])[0] || 22) || 22;
    if (!host) return reply(200, { ok: false, host, port, error: '未配置地址' });
    const t0 = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ host, port });
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error('超时（3 秒无响应）'));
        }, 3000);
        sock.once('connect', () => {
          clearTimeout(timer);
          sock.destroy();
          resolve();
        });
        sock.once('error', (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      return reply(200, { ok: true, ms: Date.now() - t0, host, port });
    } catch (e) {
      return reply(200, { ok: false, ms: Date.now() - t0, host, port, error: (e as Error).message });
    }
  }

  if (p === '/api/proxy/issue' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.assetId) return reply(400, { error: '缺少 assetId' });
    try {
      const token = v.issueProxyToken(body.assetId, body.ttl || 3600);
      return reply(200, { proxyBase: `http://127.0.0.1:${proxyPort}`, token, ttl: body.ttl || 3600 });
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  if (p === '/api/ssh/issue' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.assetId) return reply(400, { error: '缺少 assetId' });
    try {
      return reply(200, v.issueSshAccess(body.assetId, body.ttl || 3600));
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  if (p === '/api/agent-action' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.description) return reply(400, { error: '缺少 description' });
    return reply(200, v.logAgentAction(body.description, body.meta || {}));
  }

  return false;
}
