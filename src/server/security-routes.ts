/**
 * 安全与元数据路由：访问令牌换发/管理、改口令、Secret Key、资产类型、字段目录与字段定义。
 *
 * 从 `server.ts` 整体搬出，判断顺序不变。注意两处「免会话」语义仍由外层负责：
 * - `POST /api/access-token/exchange` 不需要桌面会话（令牌本身就是凭据），但要求保险库已解锁；
 * - 其余端点都在解锁门之后，由外层的会话与跨站校验兜住。
 */
import type * as http from 'http';
import { send, readBody } from './http-util';
import { crossSite, sessionOk } from './session';
import { t } from '../shared/i18n';
import {
  type Vault,
  NeedSecretKeyError,
  WrongPassphraseError,
  WrongSecretKeyError,
} from '../core/vault';
import { AccessTokenStore, findAssetTarget } from '../core/access-token';
import { AssetTypeStore } from '../core/asset-types';
import type { FieldCatalogStore } from '../core/field-catalog';
import type { FieldSchemaStore } from '../core/field-schema';

export type SecurityRouteCtx = {
  v: Vault;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
  parts: string[];
  dataDir: string;
  assetTypes: AssetTypeStore;
  fieldCatalog: FieldCatalogStore;
  fieldSchema: FieldSchemaStore;
};

export async function handleSecurityRoutes(ctx: SecurityRouteCtx): Promise<boolean> {
  const { v, req, res, p, parts, dataDir, assetTypes, fieldCatalog, fieldSchema } = ctx;
  const reply = (code: number, obj: any, headers: Record<string, string> = {}): true => {
    send(res, code, obj, headers);
    return true;
  };

  // ===== 访问令牌换发（服务账号语义 S1）=====
  // 令牌本身就是凭据，不要求桌面会话；但仍受跨站防护与本机回环限制，
  // 且必须保险库已解锁（锁屏即断 Agent，这条边界不因令牌而破例）。
  if (p === '/api/access-token/exchange' && req.method === 'POST') {
    if (crossSite(req)) return reply(403, { error: '拒绝跨站请求', code: 'cross_site' });
    if (v.locked) {
      return reply(423, { error: '保险库已锁定：先在桌面端解锁（锁屏即断 Agent）', code: 'vault.locked' });
    }
    const body = await readBody(req);
    const store = new AccessTokenStore(dataDir);
    const checked = store.verify(String(body.token || ''));
    if ('error' in checked) {
      const msg =
        checked.error === 'token.revoked' ? '令牌已撤销' : checked.error === 'token.expired' ? '令牌已过期' : '令牌无效';
      return reply(401, { error: msg, code: checked.error });
    }
    const rec = checked.record;
    const rawAction = String(body.action || 'proxy');
    const ttl = Math.min(Math.max(Number(body.ttl) || 3600, 60), 86400);
    const from = String(req.socket.remoteAddress || '');
    const aliases = new AssetTypeStore(dataDir).aliases();

    // find：令牌模式的「眼睛」—— 只在 scope 内返回脱敏卡片
    if (rawAction === 'find') {
      const q = String(body.q || '').trim();
      const kind = body.kind ? String(body.kind) : '';
      const tag = body.tag ? String(body.tag) : undefined;
      const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
      const offset = Math.max(Number(body.offset) || 0, 0);
      let rows = q ? v.search(q) : v.list(undefined, tag);
      if (kind) {
        const ty = aliases[kind] || kind;
        rows = rows.filter((a) => String(a.type) === String(ty));
      } else {
        // 与界面/MCP 一致：不显式指定类型时不混入备忘录
        rows = rows.filter((a) => a.type !== 'note');
      }
      rows = rows.filter((a) => AccessTokenStore.scopeAllows(rec, a));
      const total = rows.length;
      const items = rows.slice(offset, offset + limit).map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        no: a.no ?? null,
        tags: a.tags || [],
        hint: a.publicIp || a.sshHost || a.baseUrl || a.loginUrl || '',
      }));
      store.touch(rec.id, from);
      v.auditExternal('token_exchange', { token: rec.name, tokenId: rec.id, cap: 'find', q, kind, total });
      return reply(200, {
        action: 'find',
        total,
        offset,
        limit,
        nextOffset: offset + items.length < total ? offset + items.length : null,
        items,
      });
    }

    const target = String(body.target || '');
    const found = findAssetTarget(v, target, aliases);
    if (!found.asset) {
      const hint = found.candidates.map((a) => `${a.type}:${a.no ?? '-'} ${a.name}`).join('；');
      return reply(404, { error: `未找到「${target}」${hint ? '，候选：' + hint : ''}`, code: 'asset.not_found' });
    }
    const asset = found.asset;
    if (!AccessTokenStore.scopeAllows(rec, asset)) {
      return reply(403, { error: `令牌「${rec.name}」未授权访问「${asset.name}」`, code: 'token.scope' });
    }

    // show：单条脱敏详情。明文永远不经令牌，要看明文回桌面端/CLI 加 --reveal
    if (rawAction === 'show') {
      const masked = v.list().find((a) => a.id === asset.id) || null;
      store.touch(rec.id, from);
      v.auditExternal('token_exchange', { token: rec.name, tokenId: rec.id, cap: 'show', target: asset.name });
      return reply(200, { action: 'show', asset: masked });
    }

    // auto：server/ssh_key 走 ssh，其余走代理
    const action =
      rawAction === 'auto'
        ? asset.type === 'server' || asset.type === 'ssh_key'
          ? 'ssh'
          : 'proxy'
        : rawAction;
    if (action === 'ssh') {
      if (!AccessTokenStore.capAllows(rec, 'ssh')) return reply(403, { error: '令牌没有 ssh 能力', code: 'token.cap' });
      try {
        const r = v.issueSshAccess(asset.id, ttl);
        store.touch(rec.id, from);
        // 注意：auditExternal 的 detail 会展开覆盖顶层字段，
        // 所以这里不能用 detail.action（会盖掉审计动作名 token_exchange）
        v.auditExternal('token_exchange', {
          token: rec.name,
          tokenId: rec.id,
          target: asset.name,
          assetType: asset.type,
          cap: action,
          ttl,
        });
        return reply(200, {
          mode: 'ssh',
          asset: { id: asset.id, name: asset.name, type: asset.type },
          target: r.targetHint,
          ttl: r.ttl,
          command: `ssh -o StrictHostKeyChecking=no -p ${r.proxyPort} ${r.token}@${r.proxyHost}`,
        });
      } catch (e) {
        return reply(400, { error: (e as Error).message, code: 'ssh.unavailable' });
      }
    }
    if (action !== 'proxy') return reply(400, { error: 'action 只支持 proxy / ssh', code: 'usage' });
    if (!AccessTokenStore.capAllows(rec, 'proxy')) return reply(403, { error: '令牌没有 proxy 能力', code: 'token.cap' });
    try {
      const token = v.issueProxyToken(asset.id, ttl);
      const port = process.env.PROXY_PORT || (Number(process.env.PORT || 8787) + 1);
      const base = process.env.PROXY_BASE || `http://127.0.0.1:${port}`;
      store.touch(rec.id, from);
      v.auditExternal('token_exchange', {
        token: rec.name,
        tokenId: rec.id,
        target: asset.name,
        assetType: asset.type,
        cap: action,
        ttl,
      });
      return reply(200, {
        mode: 'proxy',
        asset: { id: asset.id, name: asset.name, type: asset.type },
        proxyBase: base,
        token,
        ttl,
      });
    } catch (e) {
      return reply(400, { error: (e as Error).message, code: 'proxy.unavailable' });
    }
  }

  // 走到这里的接口都能读明文 / 改状态：必须持有本次解锁会话的凭据。
  // 位置很关键：必须在「解锁门」之后，锁定时根本到不了这里。
  if (p.startsWith('/api/') && !sessionOk(req)) {
    return reply(401, { error: '会话已失效，请重新解锁', needUnlock: true, locked: false });
  }
  if (p.startsWith('/api/') && req.method !== 'GET' && crossSite(req)) {
    return reply(403, { error: '拒绝跨站请求' });
  }

  // ===== 访问令牌管理（桌面会话）=====
  // 换发端点不需要会话（令牌即凭据），但「签发/查看/撤销令牌」必须要有会话：
  // 否则任何本机进程都能给自己发一把。
  if (p === '/api/access-tokens' && req.method === 'GET') {
    return reply(200, { items: new AccessTokenStore(dataDir).list() });
  }
  if (p === '/api/access-tokens' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const aliases = new AssetTypeStore(dataDir).aliases();
      const rawAssets = Array.isArray(body.assets) ? body.assets.map((x: any) => String(x)) : [];
      const ids: string[] = [];
      for (const t of rawAssets) {
        const found = findAssetTarget(v, t, aliases);
        if (!found.asset) return reply(400, { error: `找不到资产「${t}」`, code: 'asset.not_found' });
        ids.push(found.asset.id);
      }
      const types = Array.isArray(body.types) ? body.types.map((x: any) => String(x)) : [];
      const created = new AccessTokenStore(dataDir).create({
        name: body.name,
        assets: ids,
        types,
        caps: Array.isArray(body.caps) ? body.caps : undefined,
        days: body.days,
      });
      v.auditExternal('token_create', {
        token: created.view.name,
        prefix: created.view.prefix,
        assets: ids.length,
        types: types.length,
        caps: created.view.caps,
      });
      // 明文只在这一个响应里出现一次，之后任何接口都只有前缀
      return reply(200, { ok: true, token: created.token, ...created.view });
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'access-tokens' && parts.length === 3 && req.method === 'DELETE') {
    const r = new AccessTokenStore(dataDir).revoke(parts[2]);
    if (!r) return reply(404, { error: '没找到唯一的令牌（可用 id 或前缀）' });
    v.auditExternal('token_revoke', { token: r.name, prefix: r.prefix });
    return reply(200, { ok: true, item: r });
  }

  if (p === '/api/passphrase' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.oldPassphrase || !body.newPassphrase) {
      return reply(400, { error: t('err.passRequired') });
    }
    if (body.newPassphrase !== body.confirmPassphrase) {
      return reply(400, { error: t('err.passMismatch') });
    }
    try {
      v.changePassphrase(body.oldPassphrase, body.newPassphrase, { secretKey: body.secretKey });
      return reply(200, { ok: true, tip: t('err.passChanged') });
    } catch (e) {
      if (e instanceof WrongPassphraseError) return reply(401, { error: t('err.wrongMasterPass') });
      if (e instanceof NeedSecretKeyError) {
        return reply(401, { error: e.message, needSecretKey: true, secretKeyHint: e.hint });
      }
      if (e instanceof WrongSecretKeyError) return reply(401, { error: e.message, needSecretKey: true });
      return reply(400, { error: (e as Error).message });
    }
  }

  // ===== Secret Key（双因子）=====
  // 启用：返回明文 SK 与应急包文本 —— 只此一次，之后接口只给末 4 位
  if (p === '/api/sk/enable' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.passphrase) return reply(400, { error: '缺少 passphrase' });
    try {
      const r = v.enableSecretKey(String(body.passphrase));
      const kit = v.emergencyKitText();
      return reply(200, {
        ok: true,
        ...r,
        emergencyKit: kit.text,
        emergencyKitFilename: kit.filename,
      });
    } catch (e) {
      if (e instanceof WrongPassphraseError) return reply(401, { error: t('err.wrongMasterPass') });
      return reply(400, { error: (e as Error).message });
    }
  }
  // 停用：仅启用后 24 小时内可回滚
  if (p === '/api/sk/disable' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.passphrase) return reply(400, { error: '缺少 passphrase' });
    try {
      v.disableSecretKey(String(body.passphrase), { secretKey: body.secretKey });
      return reply(200, { ok: true, sk: v.secretKeyStatus() });
    } catch (e) {
      if (e instanceof WrongPassphraseError) return reply(401, { error: t('err.wrongMasterPass') });
      if (e instanceof NeedSecretKeyError) {
        return reply(401, { error: e.message, needSecretKey: true, secretKeyHint: e.hint });
      }
      if (e instanceof WrongSecretKeyError) return reply(401, { error: e.message, needSecretKey: true });
      return reply(400, { error: (e as Error).message });
    }
  }
  // 应急包（重新下载）：从本机 secret_key.txt 生成，明文不落 HTTP 缓存
  if (p === '/api/sk/emergency-kit' && req.method === 'GET') {
    try {
      return reply(200, v.emergencyKitText());
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  if (p === '/api/types') return reply(200, assetTypes.labels());

  // ===== 资产类型：内置 + 自定义（自定义类型由用户新增，key 形如 ct_xxx） =====
  if (p === '/api/asset-types' && req.method === 'GET') {
    return reply(200, { types: assetTypes.list(), categories: assetTypes.categories() });
  }
  if (p === '/api/asset-types' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return reply(200, assetTypes.create(body || {}));
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'asset-types' && parts.length === 3) {
    const key = parts[2];
    if (req.method === 'PUT') {
      const body = await readBody(req);
      try {
        return reply(200, assetTypes.update(key, body || {}));
      } catch (e) {
        return reply(400, { error: (e as Error).message });
      }
    }
    if (req.method === 'DELETE') {
      const used = v.list(key as any).length;
      if (used) return reply(400, { error: `该类型下还有 ${used} 条资产，请先删除或改类型` });
      const ok = assetTypes.remove(key);
      if (!ok) return reply(400, { error: '内置类型不可删除，或类型不存在' });
      fieldSchema.removeScope(key);
      return reply(200, { ok: true });
    }
  }

  if (p === '/api/field-catalog' && req.method === 'GET') {
    return reply(200, { fields: fieldCatalog.list(), typeColors: fieldCatalog.getTypeColors() });
  }
  if (p === '/api/field-catalog' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      const fields = body?.fields ? fieldCatalog.update(body) : fieldCatalog.list();
      const typeColors = body?.typeColors ? fieldCatalog.updateTypeColors(body.typeColors) : fieldCatalog.getTypeColors();
      return reply(200, { fields, typeColors });
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  // ===== 字段定义：内置字段改名/显隐 + 自定义字段 =====
  if (p === '/api/field-schema' && req.method === 'GET') {
    return reply(200, fieldSchema.get());
  }
  if (p === '/api/field-schema' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      return reply(200, fieldSchema.save(body || {}, { scopes: assetTypes.scopes() }));
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  return false;
}
