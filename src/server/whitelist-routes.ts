/**
 * 白名单路由：公网 IP 探测、云上地域/目标下拉、绑定 CRUD、执行与执行记录、定时配置；
 * 外加资产清单的列配置（同属「界面元数据」这一层，跟白名单页面一起改，放一起更省上下文）。
 *
 * 从 `server.ts` 整体搬出，判断顺序与行为不变。
 */
import type * as http from 'http';
import { send, readBody } from './http-util';
import type { Vault } from '../core/vault';
import { type WhitelistStore, listWhitelistOptions, runAll } from '../core/whitelist';
import { detectPublicIp } from '../core/ipdetect';
import type { ColumnConfigStore } from '../core/column-config';
export type RouteCtx = {
  v: Vault;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
  parts: string[];
  whitelistStore: WhitelistStore;
  columnConfig: ColumnConfigStore;
};

export async function handleWhitelistRoutes(ctx: RouteCtx): Promise<boolean> {
  const { v, req, res, url, p, parts, whitelistStore, columnConfig } = ctx;
  /** 发完响应就返回 true：外层 if (await handle…) return; 保持原来的顺序与短路语义 */
  const reply = (code: number, obj: any, headers: Record<string, string> = {}): true => {
    send(res, code, obj, headers);
    return true;
  };

  // ===== 白名单模块：探测公网 IP / 管理绑定 / 执行更新 / 执行记录 =====
  if (p === '/api/whitelist/detect' && req.method === 'GET') {
    const ips = await detectPublicIp();
    return reply(200, { ips });
  }

  /**
   * 白名单绑定的下拉数据：地域 + 前缀列表/地址模板。
   * 这两项是云上生成的 ID，手填既不知道从哪复制又容易填错，
   * 所以用账号的 AK/SK **实时拉真实列表**（只读，AK/SK 不落盘）。
   * 不带 region 只拉地域；带 region 再拉该地域下的白名单目标。
   */
  if (p === '/api/whitelist/options' && req.method === 'GET') {
    const assetId = String(url.searchParams.get('assetId') || '');
    const provider = String(url.searchParams.get('provider') || 'aliyun');
    const region = String(url.searchParams.get('region') || '') || undefined;
    const acc = assetId ? v.get(assetId) : null;
    if (!acc) return reply(404, { error: '未找到该云账号资产' });
    if (!acc.accessKeyId || !acc.secretAccessKey) {
      return reply(400, { error: '该云账号资产缺少 AccessKey，无法拉取列表（请先补全 AK/SK）' });
    }
    try {
      const r = await listWhitelistOptions({
        provider: provider === 'tencent' ? 'tencent' : 'aliyun',
        accessKeyId: acc.accessKeyId,
        accessKeySecret: acc.secretAccessKey,
        region,
        // 账号上填的地域作兜底：腾讯云的 X-TC-Region 头不能为空
        fallbackRegion: acc.region || undefined,
      });
      return reply(200, { regions: r.regions, targets: r.targets });
    } catch (e) {
      // 失败不能静默：要让用户知道是权限/网络问题，而不是以为「没有可选资源」
      return reply(200, {
        regions: [],
        targets: [],
        error: (e as Error).message,
        hint:
          provider === 'tencent'
            ? '拉取失败多为子账号缺少 VPC 只读权限（QcloudVPCReadOnlyAccess），或该地域未开通。也可以直接手填地域/模板 ID。'
            : '拉取失败多为子账号缺少 ECS 只读权限（AliyunECSReadOnlyAccess），也可以直接手填地域/前缀列表 ID。',
      });
    }
  }
  if (p === '/api/whitelist/bindings') {
    if (req.method === 'GET') return reply(200, whitelistStore.list());
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.provider || !body.assetId || !body.region) {
        return reply(400, { error: '缺少 provider / assetId / region' });
      }
      return reply(200, whitelistStore.add({ ...body, enabled: body.enabled !== false }));
    }
  }
  if (parts[0] === 'api' && parts[1] === 'whitelist' && parts[2] === 'bindings' && parts.length === 4) {
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const b = whitelistStore.update(parts[3], body);
      return b ? reply(200, b) : reply(404, { error: '未找到' });
    }
    if (req.method === 'DELETE') return reply(200, { deleted: whitelistStore.remove(parts[3]) });
  }
  if (p === '/api/whitelist/run' && req.method === 'POST') {
    const body = await readBody(req);
    const results = await runAll(v, whitelistStore, { onlyId: body.id, force: !!body.force });
    return reply(200, { results });
  }
  if (p === '/api/whitelist/logs' && req.method === 'GET') {
    return reply(200, v.auditLog(200).filter((e: any) => e.action === 'whitelist_update'));
  }
  // ===== 资产清单列配置（每个资产类型独立） =====
  if (p === '/api/column-config' && req.method === 'GET') {
    return reply(200, { columns: columnConfig.list() });
  }
  if (p === '/api/column-config' && req.method === 'PUT') {
    const body = await readBody(req);
    const type = String(body?.type || '');
    if (!type) return reply(400, { error: '缺少 type' });
    return reply(200, { columns: columnConfig.set(type, body?.keys || []) });
  }

  if (p === '/api/whitelist/schedule') {
    if (req.method === 'GET') return reply(200, whitelistStore.getSchedule());
    if (req.method === 'PUT') return reply(200, whitelistStore.setSchedule((await readBody(req)) || {}));
  }

  return false;
}
