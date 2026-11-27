/**
 * 模型用量路由（余额 / 消费 / 资源包 / 模型清单 / 探测 / CLI Profile 绑定）。
 *
 * 从 `server.ts` 整体搬出（约 860 行），行为与顺序不变：路由块内部仍然是
 * 「先判 sub 再判 method」的线性 if 链，不要为了"整齐"改成表驱动——
 * 这里的分支是判接口而不是判权限，改动只会带来回归风险。
 */
import type * as http from 'http';
import { send, readBody } from './http-util';
import {
  AiUsageStore,
  SUPPORTED_PROVIDERS,
  collectAccount,
  setFreeTierStop,
  setFreeTierStopAll,
  setTokenHubPostpaid,
  claimTokenHubFree,
  bailianCliAvailable,
  blBinPath,
  cliProfilesDetail,
  suggestProfileName,
  msUntilCliAllowed,
  cliErrorText,
  fetchFreeQuotaAuto,
  ensureBailianOpenApi,
  launchBailianConsoleLogin,
  isBailianConsoleSessionError,
  isBailianTeamAuthError,
  activeCliProfile,
  cliMatchReason,
  extractWorkspaceId,
  readCliProfileCreds,
  thcliAvailable,
  thBinPath,
  thcliProfilesDetail,
  thcliErrorText,
  readThProfileCreds,
  thIdentityToCli,
  arkIdentityToCli,
  arkcliAvailable,
  arkBinPath,
  arkcliProfilesDetail,
  arkcliErrorText,
  arkcliHasConfigDir,
  type Creds
} from '../core/ai-usage';
import {
  activeThProfile,
  thcliAuthStatus,
  fetchTokenHubQuotas,
  thcliHasCredentialFiles
} from '../core/tokenhub-cli';
import {
  activeArkProfile,
  arkcliAuthStatus,
  fetchArkFreeQuotas
} from '../core/ark-cli';
import {
  applyCatalogPrices,
  CATALOG_SOURCES
} from '../core/model-catalog';
import type { Vault } from '../core/vault';
import { AI_PROVIDER_MAP } from './ai-provider-map';
import { t } from '../shared/i18n';

export type AiUsageRouteCtx = {
  v: Vault;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
  aiUsage: AiUsageStore;
};

/**
 * 返回 true 表示本次请求已由模型用量路由处理（无论成功还是 4xx），
 * false 表示不是 /api/ai-usage/* —— 与其它路由块「先判断再处理」的口径一致。
 */
export async function handleAiUsageRoutes(ctx: AiUsageRouteCtx): Promise<boolean> {
  const { v, req, res, url, p, aiUsage } = ctx;
  /** 路由内部统一用它：发完响应就返回 true，让外层直接 return */
  const reply = (code: number, obj: any, headers: Record<string, string> = {}): true => {
    send(res, code, obj, headers);
    return true;
  };
          const sub = p.slice('/api/ai-usage'.length) || '';

          if (sub === '/config' && req.method === 'GET') {
            return reply( 200, {
              config: aiUsage.getConfig(),
              providers: SUPPORTED_PROVIDERS,
            });
          }

          /**
           * CLI Profile 列表。阿里云→百炼 bl；腾讯云→thcli；火山→arkcli。
           * ?provider= 可显式指定；否则从 accountId 对应资产推断。
           */
          if (sub === '/profiles' && req.method === 'GET') {
            const cfg = aiUsage.getConfig();
            const accountId = String(url.searchParams.get('accountId') || '');
            const providerId = resolveAiProvider(v, accountId, url.searchParams.get('provider'));
            const hint = accountId ? accountOwnershipHint(v, cfg, accountId) : undefined;

            if (providerId === 'volcengine') {
              const cli = arkcliAvailable();
              if (!cli.ok) {
                return reply( 200, {
                  ok: false,
                  provider: 'volcengine',
                  reason: cli.reason,
                  arkCmd: arkBinPath(),
                  blCmd: blBinPath(),
                  thCmd: thBinPath(),
                  profiles: [],
                  bindings: cfg.cliBindings || {},
                  loggedIn: false,
                });
              }
              const raw = await arkcliProfilesDetail().catch(() => []);
              const profiles = raw.map((p) => {
                const identity = arkIdentityToCli(p.identity);
                const by = cliMatchReason(identity, hint);
                return {
                  name: p.name,
                  active: p.active,
                  identity,
                  loggedIn: p.identity?.loggedIn === true,
                  match: by !== null,
                  matchBy: by,
                  boundTo:
                    Object.keys(cfg.cliBindings || {}).find(
                      (aid) => cfg.cliBindings![aid] === p.name && aid !== accountId
                    ) || null,
                };
              });
              const anyLoggedIn =
                profiles.some((p) => p.loggedIn) || arkcliHasConfigDir();
              return reply( 200, {
                ok: true,
                provider: 'volcengine',
                profiles,
                arkCmd: arkBinPath(),
                blCmd: blBinPath(),
                thCmd: thBinPath(),
                loggedIn: anyLoggedIn,
                loginCmd: `${arkBinPath()} auth login volc-sso`,
                suggest:
                  profiles.find((p) => p.match)?.name ||
                  (accountId ? cfg.cliBindings?.[accountId] : '') ||
                  suggestProfileName(profiles.map((x) => x.name)),
                matchHint: hint ? { hasApiKey: !!hint.apiKey, workspaceId: hint.workspaceId || null } : null,
                bindings: cfg.cliBindings || {},
                spaces: cfg.cliSpaces || {},
              });
            }

            if (providerId === 'tencent') {
              const cli = thcliAvailable();
              if (!cli.ok) {
                return reply( 200, {
                  ok: false,
                  provider: 'tencent',
                  reason: cli.reason,
                  thCmd: thBinPath(),
                  blCmd: blBinPath(),
                  profiles: [],
                  bindings: cfg.cliBindings || {},
                  loggedIn: false,
                });
              }
              const raw = await thcliProfilesDetail().catch(() => []);
              const profiles = raw.map((p) => {
                const identity = thIdentityToCli(p.identity);
                const by = cliMatchReason(identity, hint);
                return {
                  name: p.name,
                  active: p.active,
                  identity,
                  loggedIn: p.identity?.loggedIn === true,
                  match: by !== null,
                  matchBy: by,
                  boundTo:
                    Object.keys(cfg.cliBindings || {}).find(
                      (aid) => cfg.cliBindings![aid] === p.name && aid !== accountId
                    ) || null,
                };
              });
              const anyLoggedIn =
                profiles.some((p) => p.loggedIn) || thcliHasCredentialFiles();
              return reply( 200, {
                ok: true,
                provider: 'tencent',
                profiles,
                thCmd: thBinPath(),
                blCmd: blBinPath(),
                loggedIn: anyLoggedIn,
                loginCmd: `${thBinPath()} auth login`,
                suggest:
                  profiles.find((p) => p.match)?.name ||
                  (accountId ? cfg.cliBindings?.[accountId] : '') ||
                  suggestProfileName(profiles.map((x) => x.name)),
                matchHint: hint ? { hasApiKey: !!hint.apiKey, workspaceId: hint.workspaceId || null } : null,
                bindings: cfg.cliBindings || {},
                spaces: cfg.cliSpaces || {},
              });
            }

            // 默认：阿里云百炼
            const cli = bailianCliAvailable();
            if (!cli.ok) {
              return reply( 200, {
                ok: false,
                provider: 'aliyun',
                reason: cli.reason,
                blCmd: blBinPath(),
                thCmd: thBinPath(),
                profiles: [],
                bindings: cfg.cliBindings || {},
              });
            }
            const raw = await cliProfilesDetail().catch(() => []);
            const profiles = raw.map((p) => {
              const by = cliMatchReason(p.identity, hint);
              return {
                ...p,
                match: by !== null,
                matchBy: by,
                boundTo:
                  Object.keys(cfg.cliBindings || {}).find(
                    (aid) => cfg.cliBindings![aid] === p.name && aid !== accountId
                  ) || null,
              };
            });
            return reply( 200, {
              ok: true,
              provider: 'aliyun',
              profiles,
              blCmd: blBinPath(),
              thCmd: thBinPath(),
              suggest:
                profiles.find((p) => p.match)?.name ||
                (accountId ? cfg.cliBindings?.[accountId] : '') ||
                suggestProfileName(profiles.map((x) => x.name)),
              matchHint: hint ? { hasApiKey: !!hint.apiKey, workspaceId: hint.workspaceId || null } : null,
              bindings: cfg.cliBindings || {},
              spaces: cfg.cliSpaces || {},
            });
          }

          // 绑定 CLI Profile → 云账号（阿里用 --config，腾讯用 --profile）
          if (sub === '/bind' && req.method === 'POST') {
            const body = await readBody(req);
            const accountId = String(body?.accountId || '');
            const profile = String(body?.profile || '');
            if (!accountId) return reply( 400, { error: '缺少 accountId' });
            const cfg = aiUsage.getConfig();
            const providerId = resolveAiProvider(v, accountId, body?.provider);
            if (!profile) {
              const b = { ...(cfg.cliBindings || {}) };
              delete b[accountId];
              aiUsage.setConfig({ cliBindings: b });
              v.auditExternal('ai_usage_cli_unbind', { accountId, provider: providerId });
              return reply( 200, { config: aiUsage.getConfig() });
            }

            if (providerId === 'volcengine') {
              const detail = (await arkcliProfilesDetail().catch(() => [])).find((x) => x.name === profile);
              const ident = arkIdentityToCli(detail?.identity || null);
              const next = aiUsage.setConfig({
                cliBindings: { ...(cfg.cliBindings || {}), [accountId]: profile },
                cliSpaces: {
                  ...(cfg.cliSpaces || {}),
                  [profile]: detail?.identity?.project || detail?.identity?.region || '',
                },
              });
              v.auditExternal('ai_usage_cli_bind', {
                accountId,
                profile,
                provider: 'volcengine',
                project: detail?.identity?.project || null,
                hasApiKey: !!ident?.apiKey,
              });
              return reply( 200, {
                config: next,
                identity: ident,
                keySync: { skipped: '火山 API Key 请在资产里手动绑定（或 arkcli auth apikey 后自行录入）' },
                provider: 'volcengine',
              });
            }

            if (providerId === 'tencent') {
              const detail = (await thcliProfilesDetail().catch(() => [])).find((x) => x.name === profile);
              const ident = thIdentityToCli(detail?.identity || null);
              let next = aiUsage.setConfig({
                cliBindings: { ...(cfg.cliBindings || {}), [accountId]: profile },
                cliSpaces: {
                  ...(cfg.cliSpaces || {}),
                  [profile]: detail?.identity?.region || detail?.identity?.site || '',
                },
              });
              const keySync = syncThCliApiKeyToVault(v, accountId, profile);
              if (keySync.ok && keySync.assetId) {
                next = aiUsage.setConfig({
                  accounts: {
                    ...(next.accounts || {}),
                    [accountId]: { ...(next.accounts?.[accountId] || {}), apiKeyAssetId: keySync.assetId },
                  },
                });
              }
              v.auditExternal('ai_usage_cli_bind', {
                accountId,
                profile,
                provider: 'tencent',
                hasApiKey: !!ident?.apiKey,
                keySync: keySync.ok
                  ? { assetId: keySync.assetId, created: !!keySync.created, name: keySync.name }
                  : { skipped: keySync.reason },
              });
              return reply( 200, { config: next, identity: ident, keySync, provider: 'tencent' });
            }

            const detail = (await cliProfilesDetail().catch(() => [])).find((x) => x.name === profile);
            let next = aiUsage.setConfig({
              cliBindings: { ...(cfg.cliBindings || {}), [accountId]: profile },
              cliSpaces: { ...(cfg.cliSpaces || {}), [profile]: detail?.identity?.workspaceId || '' },
            });
            const keySync = syncCliApiKeyToVault(v, accountId, profile);
            if (keySync.ok && keySync.assetId) {
              next = aiUsage.setConfig({
                accounts: {
                  ...(next.accounts || {}),
                  [accountId]: { ...(next.accounts?.[accountId] || {}), apiKeyAssetId: keySync.assetId },
                },
              });
            }
            // 绑定同时把云账号 AK/SK 写入该 Profile 的 open-api，便于控制台 token 过期后自动换票
            const acc = v.get(accountId);
            let openApiSync: { ok: boolean; reason?: string } | undefined;
            if (acc?.accessKeyId && acc?.secretAccessKey) {
              openApiSync = await ensureBailianOpenApi(profile, acc.accessKeyId, acc.secretAccessKey);
            }
            v.auditExternal('ai_usage_cli_bind', {
              accountId,
              profile,
              provider: 'aliyun',
              workspace: detail?.identity?.workspaceId || null,
              hasApiKey: !!detail?.identity?.apiKey,
              keySync: keySync.ok
                ? { assetId: keySync.assetId, created: !!keySync.created, name: keySync.name }
                : { skipped: keySync.reason },
              openApiSync: openApiSync || null,
            });
            return reply( 200, {
              config: next,
              identity: detail?.identity || null,
              keySync,
              openApiSync,
              provider: 'aliyun',
            });
          }

          /**
           * 百炼控制台会话一键续期：先试拉额度；仅会话过期才 AK 换票；
           * Team.NotAuthorised 则打开浏览器登录并短等（绝不用 AK 覆盖刚登好的票）。
           */
          if (sub === '/cli-renew' && req.method === 'POST') {
            const body = await readBody(req);
            const accountId = String(body?.accountId || '');
            if (!accountId) return reply( 400, { error: '缺少 accountId' });
            const providerId = resolveAiProvider(v, accountId, body?.provider);
            if (providerId !== 'aliyun') {
              return reply( 400, { error: '一键续期目前仅支持阿里云百炼控制台会话' });
            }
            const cfg = aiUsage.getConfig();
            const profile =
              String(body?.profile || cfg.cliBindings?.[accountId] || '') ||
              (await activeCliProfile().catch(() => 'default'));
            const acc = v.get(accountId);
            if (!acc || acc.type !== 'cloud_account') return reply( 404, { error: '未找到云账号' });
            const launchBrowser = body?.launchBrowser !== false;
            const waitBrowserMs = Math.min(180_000, Math.max(0, Number(body?.waitBrowserMs) || 90_000));
            try {
              const r = await fetchFreeQuotaAuto(profile, {
                accessKeyId: acc.accessKeyId,
                accessKeySecret: acc.secretAccessKey,
                launchBrowser,
                waitBrowserMs,
              });
              // 续期成功立刻写入快照并清掉旧 quotaError（勿再依赖随后的 refresh，曾被 AK 覆盖搞坏）
              const prev = aiUsage.getSnapshot(accountId);
              const now = new Date().toISOString();
              if (prev) {
                aiUsage.saveSnapshot({
                  ...prev,
                  ts: now,
                  freeQuotas: r.quotas,
                  cli: {
                    ...(prev.cli || { ok: true }),
                    ok: true,
                    bound: true,
                    boundProfile: profile,
                    quotaFrom: profile,
                    quotaError: undefined,
                    quotaStale: false,
                    quotaFetchedAt: now,
                  },
                });
              }
              v.auditExternal('ai_usage_cli_renew', {
                accountId,
                profile,
                renewed: r.renewed,
                browserLaunched: r.browserLaunched,
                quotaCount: r.quotas.length,
                openApiOk: r.openApi?.ok ?? null,
              });
              return reply( 200, {
                ok: true,
                profile,
                renewed: r.renewed,
                browserLaunched: r.browserLaunched,
                openApi: r.openApi,
                quotaCount: r.quotas.length,
                message: r.browserLaunched
                  ? `已打开浏览器登录 Profile「${profile}」，并已取到 ${r.quotas.length} 条免费额度`
                  : `控制台可用，取到 ${r.quotas.length} 条免费额度`,
              });
            } catch (e) {
              const err = cliErrorText(e);
              // 超时/仍失败时尽量把浏览器拉起来，方便用户手动点完
              let browserLaunched = false;
              if (launchBrowser && (isBailianConsoleSessionError(e) || isBailianTeamAuthError(e))) {
                const launched = launchBailianConsoleLogin(profile);
                browserLaunched = launched.ok;
              }
              v.auditExternal('ai_usage_cli_renew', {
                accountId,
                profile,
                error: err,
                browserLaunched,
              });
              return reply( 200, {
                ok: false,
                profile,
                error: err,
                browserLaunched,
                message: browserLaunched
                  ? `已打开浏览器，请用有百炼权限的账号完成授权；完成后会自动取额度，也可再点一次「一键续期」（Profile「${profile}」）`
                  : err,
              });
            }
          }

          /**
           * CLI 自检。?provider=tencent|aliyun；默认阿里云。
           * `?check=1` 才真打一次只读查询。
           */
          if (sub === '/cli-status' && req.method === 'GET') {
            const cfg = aiUsage.getConfig();
            const accountId = String(url.searchParams.get('accountId') || '');
            const providerId = resolveAiProvider(v, accountId, url.searchParams.get('provider'));

            if (providerId === 'volcengine') {
              const cli = arkcliAvailable();
              if (!cli.ok) {
                return reply( 200, {
                  ok: false,
                  provider: 'volcengine',
                  reason: cli.reason,
                  arkCmd: arkBinPath(),
                  fix: 'npm i -D @volcengine/ark-cli && ./node_modules/.bin/arkcli auth login volc-sso',
                  profiles: [],
                  bindings: cfg.cliBindings || {},
                });
              }
              const profiles = await arkcliProfilesDetail().catch(() => []);
              const active = await activeArkProfile().catch(() => 'default');
              const auth = await arkcliAuthStatus(active).catch(() => null);
              let gateway: { ok: boolean; error?: string; count?: number; loggedIn?: boolean } = {
                ok: !!auth?.loggedIn,
                loggedIn: !!auth?.loggedIn,
              };
              if (url.searchParams.get('check') === '1') {
                try {
                  const list = await fetchArkFreeQuotas(active);
                  gateway = { ok: true, count: list.length, loggedIn: true };
                } catch (e) {
                  gateway = { ok: false, error: arkcliErrorText(e), loggedIn: !!auth?.loggedIn };
                }
              }
              return reply( 200, {
                ok: true,
                provider: 'volcengine',
                profiles: profiles.map((p) => ({
                  ...p,
                  identity: arkIdentityToCli(p.identity),
                })),
                active,
                auth,
                gateway,
                arkCmd: arkBinPath(),
                loginCmd: `${arkBinPath()} auth login volc-sso`,
                bindings: cfg.cliBindings || {},
                spaces: cfg.cliSpaces || {},
              });
            }

            if (providerId === 'tencent') {
              const cli = thcliAvailable();
              if (!cli.ok) {
                return reply( 200, {
                  ok: false,
                  provider: 'tencent',
                  reason: cli.reason,
                  thCmd: thBinPath(),
                  fix: 'npm i -D tencent-tokenhub-cli && ./node_modules/.bin/thcli auth login',
                  profiles: [],
                  bindings: cfg.cliBindings || {},
                });
              }
              const profiles = await thcliProfilesDetail().catch(() => []);
              const active = await activeThProfile().catch(() => 'default');
              const auth = await thcliAuthStatus(active).catch(() => null);
              let gateway: { ok: boolean; error?: string; count?: number; loggedIn?: boolean } = {
                ok: !!auth?.loggedIn,
                loggedIn: !!auth?.loggedIn,
              };
              if (url.searchParams.get('check') === '1') {
                try {
                  const list = await fetchTokenHubQuotas(active);
                  gateway = { ok: true, count: list.length, loggedIn: true };
                } catch (e) {
                  gateway = { ok: false, error: thcliErrorText(e), loggedIn: !!auth?.loggedIn };
                }
              }
              return reply( 200, {
                ok: true,
                provider: 'tencent',
                profiles: profiles.map((p) => ({
                  ...p,
                  identity: thIdentityToCli(p.identity),
                })),
                active,
                auth,
                gateway,
                thCmd: thBinPath(),
                loginCmd: `${thBinPath()} auth login`,
                bindings: cfg.cliBindings || {},
                spaces: cfg.cliSpaces || {},
              });
            }

            const cli = bailianCliAvailable();
            if (!cli.ok) {
              return reply( 200, {
                ok: false,
                provider: 'aliyun',
                reason: cli.reason,
                blCmd: blBinPath(),
                fix: 'npm i -D bailian-cli && bl auth login --console',
                profiles: [],
                bindings: cfg.cliBindings || {},
                canRenew: true,
              });
            }
            const profiles = await cliProfilesDetail().catch(() => []);
            const active = await activeCliProfile().catch(() => 'default');
            // 自检优先用「本账号已绑定」的 Profile，避免看错成当前激活的其它账号
            const checkProfile = (accountId && cfg.cliBindings?.[accountId]) || active;
            let gateway: { ok: boolean; error?: string; count?: number; profile?: string } = { ok: true };
            if (url.searchParams.get('check') === '1') {
              try {
                const acc = accountId ? v.get(accountId) : null;
                const r = await fetchFreeQuotaAuto(checkProfile, {
                  accessKeyId: acc?.accessKeyId,
                  accessKeySecret: acc?.secretAccessKey,
                  launchBrowser: false,
                });
                gateway = { ok: true, count: r.quotas.length, profile: checkProfile };
              } catch (e) {
                gateway = { ok: false, error: cliErrorText(e), profile: checkProfile };
              }
            }
            return reply( 200, {
              ok: true,
              provider: 'aliyun',
              profiles,
              active,
              checkProfile,
              gateway,
              blCmd: blBinPath(),
              thCmd: thBinPath(),
              bindings: cfg.cliBindings || {},
              spaces: cfg.cliSpaces || {},
              canRenew: true,
              renewHint: '点「一键续期」：优先用现有登录态；过期才换票；无权限则打开浏览器授权（不会用 AK 覆盖已登录会话）',
            });
          }

          if (sub === '/config' && req.method === 'PUT') {
            const body = await readBody(req);
            const cfg = aiUsage.setConfig({
              probeIntervalHours: body?.probeIntervalHours,
              accounts: body?.accounts,
              autoProbe: typeof body?.autoProbe === 'boolean' ? body.autoProbe : undefined,
            });
            v.auditExternal('ai_usage_config', {
              probeIntervalHours: cfg.probeIntervalHours,
              autoProbe: cfg.autoProbe !== false,
              accountCount: Object.keys(cfg.accounts || {}).length,
            });
            return reply( 200, { config: cfg });
          }

          if (sub === '/snapshot' && req.method === 'GET') {
            const id = url.searchParams.get('accountId') || '';
            const cfg = aiUsage.getConfig();
            let snapshot = id ? aiUsage.getSnapshot(id) : null;
            // apiKeyFrom.name 是刷新时落盘的展示名；资产改名后以现活资产名为准，避免 MCP/编排读到旧字符串
            if (snapshot?.apiKeyFrom?.assetId) {
              const ka = v.get(snapshot.apiKeyFrom.assetId);
              if (ka?.name && ka.name !== snapshot.apiKeyFrom.name) {
                snapshot = {
                  ...snapshot,
                  apiKeyFrom: { ...snapshot.apiKeyFrom, name: String(ka.name) },
                };
              }
            }
            // 用全局价目缓存 enrich（旧快照只有「按量」时，打开页面也能看到结构化价格）
            if (snapshot?.models?.length) {
              const cat = aiUsage.getCatalog(snapshot.provider || 'aliyun');
              if (cat?.models?.length) {
                snapshot = { ...snapshot, models: applyCatalogPrices(snapshot.models, cat.models) };
              }
            }
            return reply( 200, {
              snapshot,
              config: cfg,
              providers: SUPPORTED_PROVIDERS,
              providerMap: AI_PROVIDER_MAP,
              catalog: snapshot ? aiUsage.getCatalog(snapshot.provider || 'aliyun') : null,
            });
          }

          // 全局价目目录（与账号无关）：上下架 / 改价监控数据源
          if (sub === '/catalog' && req.method === 'GET') {
            const provider = String(url.searchParams.get('provider') || 'aliyun');
            return reply( 200, {
              catalog: aiUsage.getCatalog(provider),
              sources: Object.keys(CATALOG_SOURCES).map((id) => ({
                id,
                label: CATALOG_SOURCES[id].label,
                implemented: id === 'aliyun',
              })),
            });
          }

          if (sub === '/catalog/refresh' && req.method === 'POST') {
            const body = await readBody(req);
            const provider = String(body?.provider || 'aliyun');
            if (!CATALOG_SOURCES[provider]) {
              return reply( 400, { error: `未知厂商：${provider}` });
            }
            const catalog = await aiUsage.refreshCatalog(provider, { force: true });
            v.auditExternal('ai_usage_catalog_refresh', {
              provider,
              total: catalog?.total ?? 0,
              added: catalog?.lastDiff?.added?.length ?? 0,
              removed: catalog?.lastDiff?.removed?.length ?? 0,
              priceChanged: catalog?.lastDiff?.priceChanged?.length ?? 0,
              error: catalog?.error || null,
            });
            return reply( 200, { catalog });
          }

          // 拉取全量（可选探测）
          if (sub === '/refresh' && req.method === 'POST') {
            const body = await readBody(req);
            const accountId = String(body?.accountId || '');
            if (!accountId) return reply( 400, { error: '缺少 accountId' });

            const accAsset = v.get(accountId);
            if (!accAsset) return reply( 404, { error: '未找到该云账号资产' });
            const providerId = AI_PROVIDER_MAP[String(accAsset.provider || '')] || String(accAsset.provider || '').toLowerCase();
            if (!SUPPORTED_PROVIDERS.includes(providerId)) {
              return reply( 400, { error: `暂不支持该平台：${accAsset.provider || providerId}（当前支持：${SUPPORTED_PROVIDERS.join('、')}）` });
            }

            let cfg = aiUsage.getConfig();
            // 已绑 CLI → 刷新时按厂商同步对应平台的 Key（绝不能串厂商：
            // 以前对腾讯/火山也走百炼 sync，会把「示例用户-…-阿里云百炼」挂到别家账号上）
            const boundProfile = cfg.cliBindings?.[accountId];
            if (boundProfile && (providerId === 'aliyun' || providerId === 'tencent')) {
              const curKeyId = String(cfg.accounts?.[accountId]?.apiKeyAssetId || '');
              const curKey = curKeyId ? v.get(curKeyId) : null;
              const cliCreds =
                providerId === 'tencent'
                  ? readThProfileCreds(boundProfile)
                  : readCliProfileCreds(boundProfile);
              const shared = !!(curKeyId && apiKeySharedByOthers(cfg, accountId, curKeyId));
              const wrongProvider =
                !!curKey &&
                ((providerId === 'aliyun' && !String(curKey.provider || '').includes('百炼') && !String(curKey.provider || '').includes('阿里')) ||
                  (providerId === 'tencent' &&
                    !/腾讯|混元|tokenhub/i.test(String(curKey.provider || '') + (curKey.tags || []).join(','))));
              const secretMismatch = !!(
                cliCreds?.apiKey && curKey?.secret && curKey.secret !== cliCreds.apiKey
              );
              // 无绑定 / 无明文 / 多账号共用同一资产 / 厂商不对 / 与 CLI 明文不一致 → 都要同步
              const needSync = !curKeyId || !curKey?.secret || shared || wrongProvider || secretMismatch;
              if (needSync) {
                const keySync =
                  providerId === 'tencent'
                    ? syncThCliApiKeyToVault(v, accountId, boundProfile)
                    : syncCliApiKeyToVault(v, accountId, boundProfile);
                if (keySync.ok && keySync.assetId) {
                  cfg = aiUsage.setConfig({
                    accounts: {
                      ...(cfg.accounts || {}),
                      [accountId]: { ...(cfg.accounts?.[accountId] || {}), apiKeyAssetId: keySync.assetId },
                    },
                  });
                }
              }
            }
            // 平台 API Key：优先用请求指定，其次用配置里绑定的
            const keyId = String(body?.apiKeyAssetId || cfg.accounts?.[accountId]?.apiKeyAssetId || '');
            const keyAsset = keyId ? v.get(keyId) : null;

            const creds: Creds = {
              accessKeyId: accAsset.accessKeyId || accAsset.secretId,
              accessKeySecret: accAsset.secretAccessKey || accAsset.secretKey,
              apiKey: keyAsset?.secret,
              baseUrl: keyAsset?.baseUrl || accAsset?.baseUrl,
            };
            // 记录 Key 来源：借用的 Key 会让模型/探测结果属于「Key 所属账号」而非本账号
            let apiKeyFrom: { assetId: string; name: string; shared: boolean } | undefined;
            if (keyAsset) {
              apiKeyFrom = { assetId: keyAsset.id, name: String(keyAsset.name || 'API Key'), shared: false };
            }
            if (!creds.apiKey && providerId === 'aliyun') {
              // 回退：找 provider 含「百炼」的 API Key。必须标记为 shared，避免把别账号的额度当成本账号的。
              const fallback = v.list('api_key').find((k: any) => String(k.provider || '').includes('百炼'));
              if (fallback) {
                const fb = v.get(fallback.id);
                creds.apiKey = fb?.secret;
                if (fb) {
                  apiKeyFrom = {
                    assetId: fb.id,
                    name: String(fb.name || 'API Key'),
                    shared: true,
                  };
                  aiUsage.setConfig({ accounts: { ...cfg.accounts, [accountId]: { apiKeyAssetId: fb.id } } });
                }
              }
            }

            // 限频：控制台网关不应被连点冲击（force:true 可绕过，用于刚绑定后必须立刻取数的情况）
            if (!body?.force) {
              const wait = msUntilCliAllowed(aiUsage.getConfig());
              if (wait > 0) {
                return reply( 429, {
                  error: t('err.refreshBusy', { s: Math.ceil(wait / 1000), h: aiUsage.getConfig().probeIntervalHours }),
                  retryAfterMs: wait,
                });
              }
            }

            const withProbe = body?.probe === true;
            const bindCli = Boolean(body?.bindCli);
            const snap = await collectAccount(aiUsage, accountId, providerId, creds, {
              probe: withProbe,
              probeLimit: Number(body?.probeLimit) || 12,
              bindCli,
            });
            // 降级绑定路径也同步 CLI Key → 资产（按厂商，避免串号）
            if (bindCli) {
              const cfg2 = aiUsage.getConfig();
              const profile = cfg2.cliBindings?.[accountId];
              if (profile && (providerId === 'aliyun' || providerId === 'tencent')) {
                const keySync =
                  providerId === 'tencent'
                    ? syncThCliApiKeyToVault(v, accountId, profile)
                    : syncCliApiKeyToVault(v, accountId, profile);
                if (keySync.ok && keySync.assetId) {
                  aiUsage.setConfig({
                    accounts: {
                      ...(cfg2.accounts || {}),
                      [accountId]: { ...(cfg2.accounts?.[accountId] || {}), apiKeyAssetId: keySync.assetId },
                    },
                  });
                  const ka = v.get(keySync.assetId);
                  if (ka?.secret) {
                    creds.apiKey = ka.secret;
                    snap.apiKeyFrom = { assetId: ka.id, name: String(ka.name || 'API Key'), shared: false };
                  }
                }
              }
            }
            snap.apiKeyFrom = snap.apiKeyFrom || apiKeyFrom;
            aiUsage.saveSnapshot(snap);
            // 探测单独记时间，这样「刷新勤、探测稀」两个节奏互不干扰
            aiUsage.setConfig({
              lastRunAt: snap.ts,
              ...(withProbe ? { lastProbeAt: snap.ts } : {}),
            });
            v.auditExternal('ai_usage_refresh', {
              accountId,
              provider: providerId,
              probe: withProbe,
              force: Boolean(body?.force),
              modelTotal: snap.modelTotal ?? 0,
              error: snap.error || null,
            });
            return reply( 200, { snapshot: snap });
          }

          // 手动探测：只探指定模型（不传则沿用上次的目标集）
          if (sub === '/probe' && req.method === 'POST') {
            const body = await readBody(req);
            const accountId = String(body?.accountId || '');
            if (!accountId) return reply( 400, { error: '缺少 accountId' });
            const accAsset = v.get(accountId);
            if (!accAsset) return reply( 404, { error: '未找到该云账号资产' });
            const providerId = AI_PROVIDER_MAP[String(accAsset.provider || '')] || String(accAsset.provider || '').toLowerCase();
            const cfg = aiUsage.getConfig();
            const keyId = String(body?.apiKeyAssetId || cfg.accounts?.[accountId]?.apiKeyAssetId || '');
            const keyAsset = keyId ? v.get(keyId) : null;
            const creds: Creds = {
              accessKeyId: accAsset.accessKeyId || accAsset.secretId,
              accessKeySecret: accAsset.secretAccessKey || accAsset.secretKey,
              apiKey: keyAsset?.secret,
              baseUrl: keyAsset?.baseUrl || accAsset?.baseUrl,
            };
            const snap = await collectAccount(aiUsage, accountId, providerId, creds, {
              probe: true,
              probeLimit: Number(body?.probeLimit) || 12,
            });
            v.auditExternal('ai_usage_probe', { accountId, provider: providerId, count: snap.probes?.length ?? 0 });
            return reply( 200, { snapshot: snap });
          }

          // 腾讯云 TokenHub：领取模型免费额度（thcli models free）
          if (sub === '/claim-free' && req.method === 'POST') {
            const body = await readBody(req);
            const accountId = String(body?.accountId || '');
            const providerId = resolveAiProvider(v, accountId, body?.provider);
            if (providerId !== 'tencent') {
              return reply( 400, {
                error:
                  providerId === 'volcengine'
                    ? '火山免费推理额度（活动一）注册即有，无需领取；协作奖励请在控制台授权。'
                    : '领取免费额仅支持腾讯云 TokenHub（thcli models free）',
              });
            }
            const cfg = aiUsage.getConfig();
            const profile = String(body?.profile || cfg.cliBindings?.[accountId] || '') || undefined;
            if (!profile) {
              return reply( 400, {
                error: '本账号尚未绑定 TokenHub Profile，无法确定领到哪个账号。请先在页面「CLI 身份」里绑定。',
              });
            }
            const modelsRaw = body?.models;
            const target: string[] | 'all' =
              body?.all === true || modelsRaw === 'all' || modelsRaw === true
                ? 'all'
                : Array.isArray(modelsRaw)
                  ? modelsRaw.map((x: any) => String(x || '').trim()).filter(Boolean)
                  : String(body?.model || '').trim()
                    ? [String(body.model).trim()]
                    : [];
            if (target !== 'all' && !(Array.isArray(target) && target.length)) {
              return reply( 400, { error: '缺少 model / models，或指定 all:true' });
            }
            try {
              const message = await claimTokenHubFree(target, {
                profile,
                dryRun: body?.dryRun === true,
              });
              v.auditExternal('ai_usage_tokenhub_claim_free', {
                models: target === 'all' ? '__all__' : target,
                accountId: accountId || null,
                profile,
                dryRun: body?.dryRun === true,
              });
              return reply( 200, { ok: true, profile, message, kind: 'claim-free' });
            } catch (e) {
              return reply( 400, { error: (e as Error).message });
            }
          }

          // 百炼：用完即停；腾讯云 TokenHub：启用按 Token 计费（endpoint postpaid）
          if (sub === '/freetier' && req.method === 'POST') {
            const body = await readBody(req);
            const model = String(body?.model || '');
            const on = body?.on !== false;
            if (!model && !body?.all) return reply( 400, { error: '缺少 model，或指定 all:true' });
            const accountId = String(body?.accountId || '');
            const providerId = resolveAiProvider(v, accountId, body?.provider);
            const cfg = aiUsage.getConfig();
            const profile = String(body?.profile || cfg.cliBindings?.[accountId] || '') || undefined;
            if (!profile) {
              return reply( 400, {
                error:
                  providerId === 'tencent'
                    ? '本账号尚未绑定 TokenHub Profile，无法确定要改哪个腾讯云账号。请先在页面「CLI 身份」里绑定。'
                    : '本账号尚未绑定 CLI Profile，无法确定要改哪个阿里云账号。请先在页面「CLI 身份」里绑定。',
              });
            }
            try {
              if (providerId === 'tencent') {
                // on = 启用按 Token 计费（PaymentEnabled / thcli endpoint postpaid on）
                const endpointId = String(body?.endpointId || '').trim();
                if (body?.all) await setTokenHubPostpaid(on, { all: true, profile });
                else if (!endpointId) {
                  return reply( 400, {
                    error: '缺少 endpointId（接入点 ID）。请刷新额度后从带接入点的行切换。',
                  });
                } else {
                  await setTokenHubPostpaid(on, { endpointId, profile });
                }
                v.auditExternal('ai_usage_tokenhub_postpaid', {
                  model: body?.all ? '__all__' : model,
                  endpointId: body?.all ? '__all__' : endpointId,
                  on,
                  accountId: accountId || null,
                  profile: profile || null,
                });
                return reply( 200, { ok: true, profile, kind: 'postpaid' });
              }
              if (body?.all) await setFreeTierStopAll(on, profile);
              else await setFreeTierStop(model, on, profile);
              v.auditExternal('ai_usage_freetier', {
                model: body?.all ? '__all__' : model,
                on,
                accountId: accountId || null,
                profile: profile || null,
              });
              return reply( 200, { ok: true, profile: profile || null, kind: 'autostop' });
            } catch (e) {
              return reply( 400, { error: (e as Error).message });
            }
          }

          return reply( 404, { error: '未知的模型用量接口' });
      

  function resolveAiProvider(
    v: Vault,
    accountId: string,
    explicit?: string | null
  ): string {
    const e = String(explicit || '').toLowerCase();
    if (e === 'tencent' || e === 'aliyun' || e === 'volcengine') return e;
    if (accountId) {
      const acc = v.get(accountId);
      const mapped = AI_PROVIDER_MAP[String(acc?.provider || '')] || String(acc?.provider || '').toLowerCase();
      if (mapped) return mapped;
    }
    return 'aliyun';
  }

  /**
   * 推断某个云账号的「归属线索」，用于和 CLI Profile 的登录身份比对。
   * 依据优先级：账号绑定的百炼 API Key（同一个 Key 必然同一个账号）> Base URL 里的业务空间。
   * 有了它才能在 Profile 下拉里标出「哪个才是本账号的」，用户不用靠猜。
   */
  function accountOwnershipHint(
    v: Vault,
    cfg: { accounts?: Record<string, { apiKeyAssetId?: string }> },
    accountId: string
  ): { apiKey?: string; workspaceId?: string } {
    const acc = v.get(accountId);
    const keyId = String(cfg.accounts?.[accountId]?.apiKeyAssetId || '');
    const keyAsset = keyId ? v.get(keyId) : null;
    return {
      apiKey: keyAsset?.secret || undefined,
      workspaceId: extractWorkspaceId(acc?.baseUrl || keyAsset?.baseUrl),
    };
  }

  /** 该 Key 资产是否还被其它云账号共用（共用时绝不能就地改写 secret，否则会串号） */
  function apiKeySharedByOthers(
    cfg: { accounts?: Record<string, { apiKeyAssetId?: string }> },
    accountId: string,
    keyAssetId: string
  ): boolean {
    return Object.entries(cfg.accounts || {}).some(
      ([aid, a]) => aid !== accountId && a?.apiKeyAssetId === keyAssetId
    );
  }

  /**
   * 把 CLI Profile 里的明文 API Key 写入/更新为「API/模型密钥」资产，并挂到该云账号。
   * 绑定 CLI 时调用：以后加账号不用再手填 Key，模型清单也能按账号分开。
   *
   * 规则（踩过坑）：多账号曾共用同一把资产时，若直接 update secret，会把别人的 Key 覆盖掉
   * 且看起来像「没往资产里写」。因此——密钥明文已存在则复用；本账号独占才可就地更新；
   * 否则一律新建。
   */
  function syncCliApiKeyToVault(
    v: Vault,
    accountId: string,
    profile: string
  ): { ok: true; assetId: string; created: boolean; name: string } | { ok: false; reason: string } {
    const creds = readCliProfileCreds(profile);
    if (!creds?.apiKey) {
      return { ok: false, reason: `CLI Profile「${profile}」本地没有 api_key（可能尚未完成控制台登录）` };
    }
    const acc = v.get(accountId);
    if (!acc || acc.type !== 'cloud_account') {
      return { ok: false, reason: '云账号不存在' };
    }
    const cfg = aiUsage.getConfig();
    const name = `${acc.name || '云账号'}-阿里云百炼`;

    // 1) 资产里已有相同明文 Key → 复用（不新建、不改别人的其它 Key）
    for (const meta of v.list('api_key')) {
      const full = v.get(meta.id);
      if (full?.secret && full.secret === creds.apiKey) {
        const shared = apiKeySharedByOthers(cfg, accountId, full.id);
        const updated = v.update(full.id, {
          baseUrl: creds.baseUrl || full.baseUrl,
          provider: full.provider || '阿里云百炼',
          // 独占时同步 name + username（旧手工资产常把展示名写在 username 里）
          ...(shared ? {} : { name, username: name }),
        });
        linkCloudToApiKey(v, accountId, updated!.id);
        return { ok: true, assetId: updated!.id, created: false, name: updated!.name };
      }
    }

    // 2) 本账号已绑一把「独占」Key 资产 → 就地更新 secret / 名称
    const existingId = String(cfg.accounts?.[accountId]?.apiKeyAssetId || '');
    const existing = existingId ? v.get(existingId) : undefined;
    if (existing?.type === 'api_key' && !apiKeySharedByOthers(cfg, accountId, existing.id)) {
      const updated = v.update(existing.id, {
        secret: creds.apiKey,
        baseUrl: creds.baseUrl || existing.baseUrl,
        provider: existing.provider || '阿里云百炼',
        name,
        username: name,
        note: existing.note || `由 CLI Profile「${profile}」同步`,
      });
      linkCloudToApiKey(v, accountId, updated!.id);
      return { ok: true, assetId: updated!.id, created: false, name: updated!.name };
    }

    // 3) 无可用资产，或当前绑的是共用资产 → 新建（绝不改写共用那一把）
    const created = v.add({
      type: 'api_key',
      name,
      username: name,
      provider: '阿里云百炼',
      secret: creds.apiKey,
      baseUrl: creds.baseUrl,
      tags: ['cli-sync'],
      note: `由 CLI Profile「${profile}」绑定时自动同步`,
      links: [{ id: accountId, role: 'cloud' }],
    });
    linkCloudToApiKey(v, accountId, created.id);
    return { ok: true, assetId: created.id, created: true, name: created.name };
  }

  /** 云账号 links 里挂上 api_key（已有则跳过）；顺带卸掉其它 api_key 角色上指向「别把密钥」的旧挂载 */
  function linkCloudToApiKey(v: Vault, accountId: string, keyAssetId: string) {
    const acc = v.get(accountId);
    if (!acc) return;
    const prev = Array.isArray(acc.links) ? acc.links : [];
    const links = prev.filter((l) => !(l.role === 'api_key' && l.id !== keyAssetId));
    if (!links.some((l) => l.id === keyAssetId)) {
      links.push({ id: keyAssetId, role: 'api_key' });
    }
    if (
      links.length !== prev.length ||
      links.some((l, i) => l.id !== prev[i]?.id || l.role !== prev[i]?.role)
    ) {
      v.update(accountId, { links });
    }
  }

  /**
   * TokenHub：把本地已落盘的对话 API Key（*.tokenhub.json）同步进资产。
   * 不代跑 key reveal；本地没有明文则提示用户本机执行 reveal / chat-config set。
   */
  function syncThCliApiKeyToVault(
    v: Vault,
    accountId: string,
    profile: string
  ): { ok: true; assetId: string; created: boolean; name: string } | { ok: false; reason: string } {
    const creds = readThProfileCreds(profile);
    if (!creds?.apiKey) {
      return {
        ok: false,
        reason: `TokenHub Profile「${profile}」本地没有对话 API Key。请本机执行：${thBinPath()} chat-config get；若无则 thcli key reveal / chat-config set（程序不代跑）`,
      };
    }
    const acc = v.get(accountId);
    if (!acc || acc.type !== 'cloud_account') {
      return { ok: false, reason: '云账号不存在' };
    }
    const cfg = aiUsage.getConfig();
    const name = `${acc.name || '云账号'}-腾讯云TokenHub`;

    for (const meta of v.list('api_key')) {
      const full = v.get(meta.id);
      if (full?.secret && full.secret === creds.apiKey) {
        const shared = apiKeySharedByOthers(cfg, accountId, full.id);
        const updated = v.update(full.id, {
          baseUrl: creds.baseUrl || full.baseUrl,
          provider: full.provider || '腾讯混元',
          ...(shared ? {} : { name, username: name }),
        });
        linkCloudToApiKey(v, accountId, updated!.id);
        return { ok: true, assetId: updated!.id, created: false, name: updated!.name };
      }
    }

    const existingId = String(cfg.accounts?.[accountId]?.apiKeyAssetId || '');
    const existing = existingId ? v.get(existingId) : undefined;
    if (existing?.type === 'api_key' && !apiKeySharedByOthers(cfg, accountId, existing.id)) {
      const updated = v.update(existing.id, {
        secret: creds.apiKey,
        baseUrl: creds.baseUrl || existing.baseUrl,
        provider: existing.provider || '腾讯混元',
        name,
        username: name,
        note: existing.note || `由 TokenHub Profile「${profile}」同步`,
      });
      linkCloudToApiKey(v, accountId, updated!.id);
      return { ok: true, assetId: updated!.id, created: false, name: updated!.name };
    }

    const created = v.add({
      type: 'api_key',
      name,
      username: name,
      provider: '腾讯混元',
      secret: creds.apiKey,
      baseUrl: creds.baseUrl,
      tags: ['cli-sync', 'tokenhub'],
      note: `由 TokenHub Profile「${profile}」绑定时自动同步`,
      links: [{ id: accountId, role: 'cloud' }],
    });
    linkCloudToApiKey(v, accountId, created.id);
    return { ok: true, assetId: created.id, created: true, name: created.name };
  }


  return false;
}
