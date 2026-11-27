import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  Vault,
  WrongPassphraseError,
  NeedSecretKeyError,
  WrongSecretKeyError,
  peekSecretKeyStatus,
} from './src/core/vault';
import { resolveSecretKeySource } from './src/core/secret-key';
import { ProxyServer } from './src/core/proxy';
import { WhitelistStore, runAll } from './src/core/whitelist';
import { ColumnConfigStore } from './src/core/column-config';
import { AiUsageStore, SUPPORTED_PROVIDERS, startProbeScheduler } from './src/core/ai-usage';

import { SshProxyServer } from './src/core/sshproxy';
import { MCP_TOOL_GUIDE, posixPath } from './src/core/mcp-meta';
import { FieldCatalogStore } from './src/core/field-catalog';
import { FieldSchemaStore } from './src/core/field-schema';
import { setLang, t } from './src/shared/i18n';
import { AssetTypeStore } from './src/core/asset-types';
import { SettingsStore } from './src/core/settings';
import { DailyBackup } from './src/core/backup';
import { handleMyProjectsApi } from './src/core/project-api';
import { startProbeLoop } from './src/core/project-probe';
import { getSystemStats } from './src/core/system-stats';
import { writeLockState, lockedBlockReason } from './src/core/lock-state';
import { resolveDataDir } from './src/core/data-dir';
import { SshAgent } from './src/core/ssh-agent';
import { send, readBody, serveStatic, HttpError } from './src/server/http-util';
import { handleAiUsageRoutes } from './src/server/ai-usage-routes';
import { handleAssetsRoutes } from './src/server/assets-routes';
import { handleSecurityRoutes } from './src/server/security-routes';
import { handleOpsRoutes } from './src/server/ops-routes';
import { handleAssistantRoutes } from './src/server/assistant-routes';
import { handleWhitelistRoutes } from './src/server/whitelist-routes';
import { AI_PROVIDER_MAP } from './src/server/ai-provider-map';
import { sessionCookie, clearSessionCookie, sessionOk, issueSession, revokeSession } from './src/server/session';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');
const DATA_DIR = resolveDataDir(path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 8787);
// 白名单绑定存储（只含资源 ID，不含任何密钥）
const whitelistStore = new WhitelistStore(DATA_DIR);
const PROXY_PORT = Number(process.env.PROXY_PORT || PORT + 1);
const SSH_PROXY_PORT = Number(process.env.SSH_PROXY_PORT || 8789);

let vault: Vault | null = null;
let httpServer: http.Server | null = null;
let proxySrv: ProxyServer | null = null;
let sshProxySrv: SshProxyServer | null = null;
let agentSrv: SshAgent | null = null;
let started = false;
const fieldCatalog = new FieldCatalogStore(DATA_DIR);
const fieldSchema = new FieldSchemaStore(DATA_DIR);
const assetTypes = new AssetTypeStore(DATA_DIR);
const columnConfig = new ColumnConfigStore(DATA_DIR);
const aiUsage = new AiUsageStore(DATA_DIR);
const settings = new SettingsStore(DATA_DIR);
// 后端返回的错误信息跟随界面语言（settings.json 里的 lang，默认中文）
setLang(settings.get().lang);
const dailyBackup = new DailyBackup(DATA_DIR, 7);
let projectProbeStop: (() => void) | null = null;

/** 资产上的中文厂商名 → ai-usage 适配器 id */
let agentStarting = false;
function startSshAgent() {
  if (!vault || vault.locked) return;
  if (!settings.get().sshAgent) return;
  if (agentSrv || agentStarting) return;
  agentStarting = true;
  const agent = new SshAgent(vault, {
    dataDir: DATA_DIR,
    guard: () => lockedBlockReason(DATA_DIR, settings.get().allowLockedAccess),
  });
  agent
    .listen()
    .then(() => {
      agentStarting = false;
      console.log(`[ssh-agent] 监听 ${agent.socketPath}（${agent.keys().length} 把密钥）`);
      agentSrv = agent;
    })
    .catch((e) => {
      agentStarting = false;
      console.error('[ssh-agent] 启动失败:', e.message);
      void agent.close();
    });
}

async function stopSshAgent() {
  const a = agentSrv;
  agentSrv = null;
  if (a) await a.close().catch(() => {});
}

function startProxy() {
  if (!vault) return;
  if (!proxySrv) {
    // allowHttp 是惰性读取：用户改设置后下一次请求即生效，不用重启代理
    proxySrv = new ProxyServer(vault, PROXY_PORT, () => settings.get().proxyAllowHttp);
    proxySrv.listen().then(() => console.log(`[proxy] 监听 http://localhost:${PROXY_PORT} (Model B 代理注入)`));
  }
  if (!sshProxySrv) {
    sshProxySrv = new SshProxyServer(vault, DATA_DIR, SSH_PROXY_PORT);
    sshProxySrv
      .listen()
      .then(() => console.log(`[ssh-proxy] 监听 ${sshProxySrv!.host}:${SSH_PROXY_PORT} (Model B SSH 堡垒)`))
      .catch((e) => console.error('[ssh-proxy] 启动失败:', e.message));
  }
  startWhitelistScheduler();
}

// ===== 白名单定时调度（应用内）：每 60s 检查一次，到点执行全部启用中的绑定 =====
// 说明：只在 flintkeep 运行时生效；关掉界面也要跑请用 scripts/whitelist_run.ts 挂系统任务计划。
const WL_TICK_MS = 60_000;
let wlTimer: NodeJS.Timeout | null = null;
function startWhitelistScheduler() {
  if (wlTimer || !vault) return;
  wlTimer = setInterval(async () => {
    try {
      const v = vault;
      if (!v) return;
      if (v.locked) return; // 锁定状态下不动用任何凭证，等解锁后到点再跑
      const s = whitelistStore.getSchedule();
      if (!s.enabled || !s.nextRunAt || Date.now() < s.nextRunAt) return;
      const results = await runAll(v, whitelistStore, {});
      const ok = results.filter((r) => r.ok && !r.skipped).length;
      const failed = results.filter((r) => !r.ok).length;
      const skipped = results.filter((r) => r.skipped).length;
      whitelistStore.setSchedule({
        lastRunAt: new Date().toISOString(),
        nextRunAt: Date.now() + (s.intervalMinutes || 30) * 60000,
        lastSummary: `成功 ${ok} / 跳过 ${skipped} / 失败 ${failed}`,
      });
      console.log(`[whitelist] 定时执行完成：成功 ${ok} / 跳过 ${skipped} / 失败 ${failed}`);
    } catch (e) {
      console.error('[whitelist] 定时执行失败:', (e as Error).message);
    }
  }, WL_TICK_MS);
  wlTimer.unref?.(); // 不阻止进程退出（CLI / 冒烟场景）
}

// ===== 锁定与自动锁定 =====
// 用户关掉窗口但程序留在托盘时，保险库不能一直敞着 —— 无操作超过设定时长即锁定，
// 锁定后：取密/代理/SSH 堡垒/白名单同步全部拒绝，直到重新输口令解锁。
let lastActivity = Date.now();

/**
 * 记一次活动，重置自动锁定计时。
 *
 * 只认「有副作用的请求」：以前任何请求都算活动，结果「我的项目」页每 3 秒拉一次
 * /api/system/stats，自动锁定被永久按下去。GET 一律不算，前端另有
 * POST /api/activity 心跳（点击/按键时 60 秒节流发一次）来表达“真的有人在用”。
 */
function touchActivity(method: string, p: string) {
  if (!vault || vault.locked) return;
  if (method === 'GET') return;
  if (p === '/api/locked' || p === '/api/settings') return;
  lastActivity = Date.now();
}

/** 把设置里的审计保留策略应用到当前 Vault（解锁后、改设置后各调一次） */
function applyAuditRetention(v: Vault) {
  const s = settings.get();
  v.setAuditRetention({ maxBytes: s.auditMaxMB * 1024 * 1024, generations: s.auditKeepGenerations });
}

async function lockVault(reason: string) {
  if (!vault || vault.locked) return;
  try {
    vault.auditExternal('vault_lock', { reason });
  } catch {
    /* 审计失败不阻塞锁定 */
  }
  vault.lock();
  // 锁定 = 会话结束：令牌吊销（vault.lock 内做）、内存会话作废、跨进程状态落盘
  revokeSession();
  writeLockState(DATA_DIR, true);
  await Promise.allSettled([proxySrv?.close(), sshProxySrv?.close(), stopSshAgent()]);
  proxySrv = null;
  sshProxySrv = null;
  console.log(`[server] 保险库已锁定：${reason}`);
}

let autoLockTimer: NodeJS.Timeout | null = null;
function startAutoLockTimer() {
  if (autoLockTimer) return;
  autoLockTimer = setInterval(async () => {
    try {
      if (!vault || vault.locked) return;
      const mins = settings.get().autoLockMinutes;
      if (mins > 0 && Date.now() - lastActivity > mins * 60000) {
        await lockVault(`无操作 ${mins} 分钟，自动锁定`);
      }
    } catch {
      /* 单次检查失败忽略，下个周期再试 */
    }
  }, 30_000);
  autoLockTimer.unref?.();
}

// ===== 解锁防爆破：连续失败指数退避（1s → 2s → 4s … 封顶 60s；内存计数，重启清零）=====
let unlockFails = 0;
let unlockWaitUntil = 0;
function unlockRetryAfterMs(): number {
  return Math.min(1000 * 2 ** Math.max(0, unlockFails - 1), 60_000);
}

// ===== 每日自动备份：启动 10s 后先跑一次，之后每小时检查（当天有变动则刷新当天备份）=====
let backupTimer: NodeJS.Timeout | null = null;
function runDailyBackup() {
  try {
    // 开关关闭时直接跳过；定时器仍每小时醒一次，改设置后无需重启
    if (!settings.get().dailyBackup) return;
    const r = dailyBackup.run();
    if (r)
      console.log(`[backup] 每日自动备份完成：${r.files.length} 个文件 → ${posixPath(path.relative(DATA_DIR, r.dir))}`);
  } catch (e) {
    console.error('[backup] 自动备份失败:', (e as Error).message);
  }
}
function startBackupTimer() {
  if (backupTimer) return;
  const initial = setTimeout(runDailyBackup, 10_000);
  initial.unref?.();
  backupTimer = setInterval(runDailyBackup, 60 * 60 * 1000);
  backupTimer.unref?.();
}

function tryBootUnlock() {
  const bootPass = process.env.VAULT_PASSPHRASE || process.env.VAULT_MASTER_KEY;
  if (!bootPass) return;
  try {
    const v = new Vault(DATA_DIR);
    // SK 可来自 VAULT_SECRET_KEY / FK_SK，支持 @file:~/secret_key.txt，避免明文贴进配置
    v.unlock(bootPass, {
      secretKey: resolveSecretKeySource(process.env.VAULT_SECRET_KEY || process.env.FK_SK) || undefined,
    });
    vault = v;
    applyAuditRetention(v);
    console.log('[server] 保险库已通过 VAULT_PASSPHRASE 自动解锁');
    startProxy();
  } catch (e) {
    console.error('[server] 启动自动解锁失败:', (e as Error).message);
  }
}

function createHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    // DNS rebinding 防护：Host 必须是回环地址。恶意网页把自己的域名"重绑定"到
    // 127.0.0.1 后会带着它的域名当 Host 来访问，对不上就拒绝（加密备份等响应因此读不走）
    const host = String(req.headers.host || '').toLowerCase();
    const hostOk =
      /^127\.0\.0\.1(:\d+)?$/.test(host) || /^localhost(:\d+)?$/.test(host) || /^\[::1\](:\d+)?$/.test(host);
    if (!hostOk) return send(res, 403, { error: '禁止访问' });
    touchActivity(req.method || 'GET', p);
    const parts = p.split('/').filter(Boolean);

    try {
      // 锁定查询必须在 guard 之前，否则 vault=null 时永远到不了
      if (p === '/api/locked' && req.method === 'GET') {
        return send(res, 200, { locked: !vault || vault.locked });
      }

      // 设置不敏感且锁定状态下 Electron 托盘也要读（决定关窗行为），放在解锁门之前
      if (p === '/api/kdf' && req.method === 'GET') {
        // 派生强度：老库（210k）提示用户改一次口令升级到 650k。
        // 放在解锁门之前——只读强度信息，锁定态也要能显示在设置页。
        if (!vault) {
          return send(res, 200, { kdf: 'pbkdf2-sha256', iter: 0, recommended: 650000, upgradeRecommended: false });
        }
        return send(res, 200, vault.kdfInfo());
      }
      // 双因子状态：只读 keystore，不含任何密钥。锁定态 / 从未解锁的进程也要能显示
      // 「本库需要 Secret Key」，否则锁屏界面只能等用户输错两次才发现。
      if (p === '/api/sk' && req.method === 'GET') {
        return send(res, 200, vault ? vault.secretKeyStatus() : peekSecretKeyStatus(DATA_DIR));
      }
      if (p === '/api/settings' && req.method === 'GET') {
        return send(res, 200, { settings: settings.get() });
      }
      if (p === '/api/ssh-agent' && req.method === 'GET') {
        // 只回元数据（名称/算法/指纹），私钥永不出接口；锁定态一律 423，避免锁屏时还能探到密钥清单
        if (!vault || vault.locked) {
          return send(res, 423, {
            error: t('err.unlockNeeded'),
            needUnlock: true,
            socket: path.join(DATA_DIR, 'agent.sock'),
          });
        }
        const socket = agentSrv?.socketPath || path.join(DATA_DIR, 'agent.sock');
        return send(res, 200, {
          enabled: settings.get().sshAgent,
          running: !!agentSrv?.listening,
          socket,
          exportCommand: `export SSH_AUTH_SOCK=${JSON.stringify(socket)}`,
          keys: agentSrv ? agentSrv.keys() : [],
        });
      }

      if (p === '/api/settings' && req.method === 'PUT') {
        // 设置在锁定状态下也能读（托盘要读关窗行为），但写入是改安全策略：
        // 已解锁时必须带本次会话凭据；锁定态只有在「锁屏后仍允许连接」已开启时才放行。
        const cur = settings.get();
        const lockedNow = !vault || vault.locked;
        if (!sessionOk(req) && !(lockedNow && cur.allowLockedAccess)) {
          return send(res, lockedNow ? 423 : 401, {
            error: lockedNow ? t('err.unlockNeeded') : '会话已失效，请重新解锁',
            needUnlock: true,
          });
        }
        const body = await readBody(req);
        const next = settings.set({
          closeAction: body?.closeAction,
          autoLockMinutes: body?.autoLockMinutes,
          agentPermission: body?.agentPermission,
          allowLockedAccess: body?.allowLockedAccess,
          allowAgentExec: body?.allowAgentExec,
          proxyAllowHttp: body?.proxyAllowHttp,
          dailyBackup: body?.dailyBackup,
          mcpFullTools: body?.mcpFullTools,
          sshAgent: body?.sshAgent,
          lang: body?.lang,
        });
        // 开关切换即时生效：开了立刻起 socket，关了立刻撤（不必等下一次解锁）
        if (next.sshAgent) startSshAgent();
        else void stopSshAgent();
        if (vault && !vault.locked) applyAuditRetention(vault);
        // 界面切换语言后，后端错误信息/MCP 立即跟着换
        setLang(next.lang);
        return send(res, 200, { settings: next });
      }

      if (p === '/api/lock' && req.method === 'POST') {
        // 锁定本身也要鉴权：否则同机任意进程都能把你的库踢下线（DoS）
        if (!sessionOk(req)) return send(res, 401, { error: '会话已失效，请重新解锁', needUnlock: true });
        await lockVault('用户手动锁定（界面/托盘）');
        return send(res, 200, { locked: true }, { 'Set-Cookie': clearSessionCookie() });
      }

      if (p === '/api/unlock' && req.method === 'POST') {
        // 防爆破：连续失败后强制等待（窗口期内连正确口令也拒绝，重启进程清零）
        const wait = unlockWaitUntil - Date.now();
        if (wait > 0) {
          return send(res, 429, { error: t('err.unlockBusy', { s: Math.ceil(wait / 1000) }), retryAfterMs: wait });
        }
        const body = await readBody(req);
        const pp = body.passphrase as string;
        if (!pp) return send(res, 400, { error: '缺少 passphrase' });
        try {
          if (!vault) vault = new Vault(DATA_DIR);
          const created = vault.unlock(pp, { secretKey: body.secretKey as string | undefined });
          // 「记住此设备」是显式勾选：只在本机落地，失败不阻塞解锁
          if (body.rememberSecretKey && body.secretKey) {
            try {
              vault.rememberSecretKey(String(body.secretKey));
            } catch {
              /* 记住失败不影响本次解锁 */
            }
          }
          applyAuditRetention(vault);
          unlockFails = 0;
          unlockWaitUntil = 0;
          lastActivity = Date.now(); // 解锁本身就是活动：否则 30s 内会被自动锁定重新锁上
          // 新会话：签发本地会话凭据 + 把「已解锁」写到跨进程状态文件（MCP 会读它）
          issueSession();
          writeLockState(DATA_DIR, false);
          startProxy();
          startSshAgent();
          return send(
            res,
            200,
            { ok: true, created, locked: false, sk: vault.secretKeyStatus() },
            { 'Set-Cookie': sessionCookie() }
          );
        } catch (e) {
          // 缺 SK 不是「口令错」：明确要 SK，并回 hint 让用户确认「是不是这一把」
          if (e instanceof NeedSecretKeyError) {
            return send(res, 401, { error: e.message, needSecretKey: true, secretKeyHint: e.hint });
          }
          // SK 错也不该提示「口令错误」——否则用户会反复改口令
          if (e instanceof WrongSecretKeyError) {
            unlockFails += 1;
            unlockWaitUntil = Date.now() + unlockRetryAfterMs();
            return send(res, 401, { error: e.message, needSecretKey: true, retryAfterMs: unlockRetryAfterMs() });
          }
          if (e instanceof WrongPassphraseError) {
            unlockFails += 1;
            unlockWaitUntil = Date.now() + unlockRetryAfterMs();
            return send(res, 401, { error: t('err.wrongPass'), retryAfterMs: unlockRetryAfterMs() });
          }
          return send(res, 500, { error: (e as Error).message });
        }
      }

      // 前端用户活动心跳：点击/按键时 60 秒节流发一次，重置自动锁定计时。
      // 必须带会话凭据，否则同机进程只要循环 POST 这个接口就能让库永不自动锁。
      if (p === '/api/activity' && req.method === 'POST') {
        if (!sessionOk(req)) return send(res, 401, { error: '会话已失效，请重新解锁', needUnlock: true });
        lastActivity = Date.now();
        return send(res, 200, { ok: true });
      }

      // MCP 教程元数据（无密钥）：解锁前后都可访问，避免旧进程/锁态误报 not found
      if (p === '/api/mcp-setup' && req.method === 'GET') {
        const projectRoot = posixPath(__dirname);
        // GUI 启动的 Agent 宿主（Dock/开始菜单拉起的各类桌面客户端）继承的是
        // 精简 PATH，往往找不到 npx —— 配置模板直接给绝对 node + tsx 入口，避免连不上
        const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
        return send(res, 200, {
          projectRoot,
          mcpScript: posixPath(path.join(__dirname, 'src', 'core', 'mcp.ts')),
          dataDir: posixPath(DATA_DIR),
          nodeBin: posixPath(process.execPath),
          tsxCli: fs.existsSync(tsxCli) ? posixPath(tsxCli) : null,
          tools: MCP_TOOL_GUIDE,
        });
      }

      // 「运行工作台」：读操作锁屏也能用（页面/菜单栏要看状态）；
      // 写操作（登记/启停/删除）按「锁屏后仍允许连接」决定：关闭时锁定即拒绝，解锁时还要带会话凭据。
      if (parts[0] === 'api' && parts[1] === 'myprojects') {
        const cfg = settings.get();
        const lockedNow = !vault || vault.locked;
        const isWrite = (req.method || 'GET') !== 'GET';
        const authorized = !isWrite ? true : lockedNow ? cfg.allowLockedAccess : sessionOk(req);
        return await handleMyProjectsApi(req, res, parts.slice(2), DATA_DIR, {
          allowLockedAccess: cfg.allowLockedAccess,
          authorized,
          locked: lockedNow,
        });
      }

      // 本机资源监控（CPU/内存/磁盘/网络/GPU/温度，跨平台，锁态也可看）
      if (p === '/api/system/stats' && req.method === 'GET') {
        return send(res, 200, await getSystemStats());
      }

      const v = vault;
      if (!v) {
        // 锁定态：只放行静态资源（锁屏界面本身），接口一律 423
        if (!p.startsWith('/api/')) {
          const served = serveStatic(DIST_DIR, res, p);
          if (served) return;
        }
        return send(res, 423, { error: t('err.unlockNeeded'), needUnlock: true, locked: true });
      }

      // ===== 安全与元数据（实现见 src/server/security-routes.ts）=====
      if (
        await handleSecurityRoutes({
          v,
          req,
          res,
          url,
          p,
          parts,
          dataDir: DATA_DIR,
          assetTypes,
          fieldCatalog,
          fieldSchema,
        })
      )
        return;

      // 人工操作恢复：应用审计条目附带的恢复点
      // ===== 撤销 / 审计 / 搜索 / 机房探测 / 凭据签发（src/server/ops-routes.ts）=====
      if (await handleOpsRoutes({ v, req, res, url, p, proxyPort: PROXY_PORT })) return;
      // ===== 资产管家（src/server/assistant-routes.ts）=====
      if (await handleAssistantRoutes({ v, req, res, url, p })) return;
      // ===== 白名单与列配置（src/server/whitelist-routes.ts）=====
      if (await handleWhitelistRoutes({ v, req, res, url, p, parts, whitelistStore, columnConfig })) return;

      // ===== 备份 / 集合 / 资产 / 导入（实现见 src/server/assets-routes.ts）=====
      if (await handleAssetsRoutes({ v, req, res, url, p, parts })) return;

      // ===== 模型用量（实现见 src/server/ai-usage-routes.ts）=====
      if (await handleAiUsageRoutes({ v, req, res, url, p, aiUsage })) return;

      // no-cache：桌面端重载永远拿到最新前端代码（否则修复后用户看到的仍是旧包）
      if (serveStatic(DIST_DIR, res, p)) return;
      send(res, 404, { error: 'not found' });
    } catch (e: any) {
      // 客户端错（请求体过大/非法 JSON）按 4xx 回，别一律 500
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      send(res, 500, { error: e.message });
    }
  });
}

/** 模型用量：按配置间隔自动探测（未解锁 / 未配置账号时自动跳过） */
let aiProbeTimer: NodeJS.Timeout | null = null;
function startAiProbeTimer() {
  if (aiProbeTimer) return;
  aiProbeTimer = startProbeScheduler(aiUsage, {
    isReady: () => !!vault && !vault.locked,
    getCreds: async (accountId: string) => {
      const v = vault;
      if (!v) return null;
      const acc = v.get(accountId);
      if (!acc) return null;
      const providerId = AI_PROVIDER_MAP[String(acc.provider || '')];
      if (!SUPPORTED_PROVIDERS.includes(providerId)) return null;
      const cfg = aiUsage.getConfig();
      const keyId = String(cfg.accounts?.[accountId]?.apiKeyAssetId || '');
      const keyAsset = keyId ? v.get(keyId) : null;
      return {
        provider: providerId,
        creds: {
          accessKeyId: acc.accessKeyId,
          accessKeySecret: acc.secretAccessKey,
          apiKey: keyAsset?.secret,
        },
      };
    },
    onError: (e) => console.error('[ai-usage] 自动探测失败:', (e as Error)?.message),
  });
}

/** 从资产 / 查询参数解析 ai-usage provider id */
/** 启动 REST + 静态服务（及已解锁时的代理）。可被 Electron 同进程调用；重复调用直接返回。 */
export function startAppServer(): Promise<{ port: number }> {
  if (started && httpServer) return Promise.resolve({ port: PORT });
  tryBootUnlock();
  httpServer = createHttpServer();
  return new Promise((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.listen(PORT, '127.0.0.1', () => {
      started = true;
      console.log(`[server] 监听 http://127.0.0.1:${PORT}  (数据目录=${DATA_DIR})`);
      // 把当前锁定状态落盘：MCP 是独立进程，靠这个文件判断「锁屏后 Agent 还能不能连」
      writeLockState(DATA_DIR, !vault || vault.locked);
      if (!vault) console.log('[server] 保险库处于锁定状态，请通过桌面端或 POST /api/unlock 解锁');
      startAiProbeTimer();
      startAutoLockTimer();
      startBackupTimer();
      if (!projectProbeStop) projectProbeStop = startProbeLoop(DATA_DIR);
      resolve({ port: PORT });
    });
  });
}

export async function stopAppServer(): Promise<void> {
  if (wlTimer) {
    clearInterval(wlTimer);
    wlTimer = null;
  }
  if (aiProbeTimer) {
    clearInterval(aiProbeTimer);
    aiProbeTimer = null;
  }
  if (autoLockTimer) {
    clearInterval(autoLockTimer);
    autoLockTimer = null;
  }
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  if (projectProbeStop) {
    projectProbeStop();
    projectProbeStop = null;
  }
  await Promise.all([proxySrv?.close().catch(() => {}), sshProxySrv?.close().catch(() => {}), stopSshAgent()]);
  proxySrv = null;
  sshProxySrv = null;
  await new Promise<void>((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
  });
  httpServer = null;
  started = false;
}

const isDirectRun = (() => {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  const self = path.resolve(fileURLToPath(import.meta.url));
  if (!entry) return false;
  if (entry === self || entry === self.replace(/\.ts$/, '.js')) return true;
  // 字面路径不同但指向同一文件：macOS 的 /tmp → /private/tmp，项目目录被软链时也会这样。
  // 只比字符串会让「看起来启动了、实际静默退出」，排查起来很费时间。
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  startAppServer().catch((e) => {
    console.error('[server] 启动失败:', e);
    process.exit(1);
  });
}
