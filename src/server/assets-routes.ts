/**
 * 资产与备份路由：备份导出/导入、加密集合、资产 CRUD 与版本历史、导入器预览/提交。
 *
 * 从 `server.ts` 整体搬出，判断顺序与行为不变；`reply()` 返回值让外层可以
 * 「顺序 + 短路」，等价于原来的 `return send(...)`。
 *
 * 放在解锁门之后调用之前——这些接口都能读写明文，鉴权由外层的会话与跨站校验负责。
 */
import type * as http from 'http';
import { send, readBody } from './http-util';
import { t } from '../shared/i18n';
import { type Vault, NeedSecretKeyError, WrongPassphraseError, WrongSecretKeyError } from '../core/vault';
import type { AssetType } from '../core/schema';
import { parseImportPayload, itemToAsset, dedupeKey, normalizeUrl, hostOf } from '../core/importer';

export type AssetsRouteCtx = {
  v: Vault;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
  parts: string[];
};

export async function handleAssetsRoutes(ctx: AssetsRouteCtx): Promise<boolean> {
  const { v, req, res, url, p, parts } = ctx;
  /** 发完响应就返回 true：外层 if (await handle…) return; 才能保持原来的顺序与短路语义 */
  const reply = (code: number, obj: any, headers: Record<string, string> = {}): true => {
    send(res, code, obj, headers);
    return true;
  };

  if (p === '/api/backup/export' && req.method === 'GET') {
    return reply(200, { backup: v.exportBackup() });
  }
  if (p === '/api/backup/import' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.backup || !body.passphrase) return reply(400, { error: '缺少 backup 或 passphrase' });
    try {
      const stats = v.importBackup(body.backup, body.passphrase, { secretKey: body.secretKey });
      return reply(200, { ok: true, imported: stats.imported, whitelist: stats.whitelist });
    } catch (e) {
      if (e instanceof WrongPassphraseError) return reply(401, { error: t('err.wrongMasterPass') });
      // 备份来自双因子库：要明确告诉用户「还需要那把 SK」，而不是笼统报导入失败
      if (e instanceof NeedSecretKeyError) {
        return reply(400, { error: e.message, needSecretKey: true, secretKeyHint: e.hint });
      }
      if (e instanceof WrongSecretKeyError) return reply(400, { error: e.message, needSecretKey: true });
      return reply(400, { error: (e as Error).message });
    }
  }

  // ===== 加密集合：工作台业务数据（收支/成本/任务/资料证书/灵感池）随整库加密落盘 =====
  if (parts[0] === 'api' && parts[1] === 'collections' && parts.length === 3) {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const cname = parts[2];
    if (req.method === 'GET') {
      return reply(200, { name: cname, data: v.getCollection(cname) });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      v.setCollection(cname, body?.data ?? body);
      return reply(200, { ok: true });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'assets') {
    if (req.method === 'GET' && parts.length === 2) {
      const type = url.searchParams.get('type') as AssetType | null;
      const tag = url.searchParams.get('tag') || undefined;
      const list = v.list(type || undefined, tag);
      // 备忘录(type=note)不进资产清单；仅显式 ?type=note（备忘录页）时才返回
      return reply(200, type ? list : list.filter((a: any) => a.type !== 'note'));
    }
    if (req.method === 'GET' && parts.length === 3) {
      const a = v.get(parts[2]);
      return a ? reply(200, a) : reply(404, { error: '未找到' });
    }
    if (req.method === 'POST' && parts.length === 2) {
      const body = await readBody(req);
      return reply(200, v.add(body));
    }
    if (req.method === 'PUT' && parts.length === 3) {
      const body = await readBody(req);
      const u = v.update(parts[2], body);
      return u ? reply(200, u) : reply(404, { error: '未找到' });
    }
    if (req.method === 'DELETE' && parts.length === 3) {
      return reply(200, { deleted: v.remove(parts[2]) });
    }
    // 版本历史：GET /api/assets/:id/versions（摘要）、POST /api/assets/:id/versions/:vid/restore
    if (parts[3] === 'versions') {
      if (req.method === 'GET' && parts.length === 4) {
        return reply(200, { items: v.listAssetVersions(parts[2]) });
      }
      if (req.method === 'POST' && parts.length === 6 && parts[5] === 'restore') {
        const u = v.restoreAssetVersion(parts[2], parts[4]);
        return u ? reply(200, u) : reply(404, { error: '版本不存在或资产已删除' });
      }
    }
  }

  // ===== 导入（1Password CSV/1PUX、Bitwarden、Chrome、KeePass）=====
  if ((p === '/api/import/preview' || p === '/api/import/commit') && req.method === 'POST') {
    const body = await readBody(req);
    const { format, items } = parseImportPayload(body);
    // 已存在判定：同站点 + 同用户名（没有站点退回标题）；只对登录项与笔记去重
    const existing = new Map<string, any>();
    for (const a of v.list()) {
      if (a.type === 'login_account') existing.set(dedupeKey({ title: a.name, username: a.username, url: a.loginUrl }), a);
      else if (a.type === 'note') existing.set(dedupeKey({ title: a.name }), a);
    }
    const plan = items.map((it) => {
      const key = dedupeKey(it);
      const hit = existing.get(key);
      return { item: it, duplicateOf: hit ? { id: hit.id, name: hit.name } : null };
    });

    if (p === '/api/import/preview') {
      return reply(200, {
        format,
        total: plan.length,
        duplicates: plan.filter((x) => x.duplicateOf).length,
        items: plan.slice(0, 100).map((x) => ({
          title: x.item.title || '',
          site: hostOf(normalizeUrl(x.item.url)),
          username: x.item.username || '',
          hasPassword: !!x.item.password,
          hasNotes: !!x.item.notes,
          hasTotp: !!x.item.totp,
          duplicateOf: x.duplicateOf ? x.duplicateOf.name : null,
        })),
      });
    }

    const mode = String(body?.mode || 'skip');
    if (!['skip', 'update', 'append'].includes(mode)) {
      return reply(400, { error: `mode 不支持：${mode}（可选 skip / update / append）` });
    }
    const toAdd: any[] = [];
    let skipped = 0;
    let updated = 0;
    for (const x of plan) {
      const asset = itemToAsset(x.item);
      if (!asset) {
        skipped += 1;
        continue;
      }
      if (x.duplicateOf) {
        if (mode === 'skip') {
          skipped += 1;
          continue;
        }
        if (mode === 'update') {
          v.update(x.duplicateOf.id, asset);
          updated += 1;
          continue;
        }
      }
      toAdd.push(asset);
    }
    const added = v.addMany(toAdd);
    return reply(200, { format, total: plan.length, imported: added.length, updated, skipped });
  }

  return false;
}
