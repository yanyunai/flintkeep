import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Vault, NeedSecretKeyError, WrongPassphraseError, WrongSecretKeyError, peekSecretKeyStatus } from './vault';
import { Asset, AssetType, TYPE_LABELS, SECRET_FIELDS, stripSecrets } from './schema';
import { AssetTypeStore } from './asset-types';
import { resolveSecretKeySource } from './secret-key';
import { normalizeAssetType } from './mcp-meta';
import { AccessTokenStore, findAssetTarget, type TokenCap } from './access-token';
import { SshAgent, queryAgent, agentEndpoint, pipeToSshConfig } from './ssh-agent';
import { SettingsStore } from './settings';
import { lockedBlockReason } from './lock-state';
import { resolveDataDir } from './data-dir';

/**
 * `fk` CLI —— 对标 1Password CLI 的最小骨架。
 *
 * 设计原则（与 MCP 一致）：
 * - 默认只给「能用的东西」：connect 打印堡垒命令/代理令牌，绝不给真实密钥；
 * - show 默认脱敏，`--reveal` 才出明文（走 vault.get，落审计）；
 * - env 是例外：它的用途就是给子进程注入明文，所以默认输出明文，并在 stderr 明确警告；
 * - 解锁凭据只从环境变量或 TTY 交互来，不走命令行参数（避免进 shell 历史/进程列表）。
 *
 * 退出码：0 成功 / 1 运行错误 / 2 用法错误 / 3 凭据缺失或错误 / 4 目标未找到或有歧义
 */

const CLI_VERSION = '0.1.0';
const EXIT = { ok: 0, error: 1, usage: 2, auth: 3, notFound: 4 } as const;

const HELP = `fk ${CLI_VERSION} — 燧垒保险库命令行

用法：
  fk status [--json]                     库状态（锁定/双因子/条目统计）
  fk list [--type <类型>] [--tag <标签>] [--json]
                                         列出资产（脱敏）
  fk show <目标> [--reveal] [--json]      查看单条（默认脱敏；--reveal 出明文并记审计）
  fk connect <目标> [--ttl <秒>] [--json]
                                         服务器/SSH 登录 → 堡垒命令；其它类型 → 代理地址+令牌
  fk env <目标> [--field <a,b>] [--json]  输出 export 行（明文），用于注入子进程
  fk token create --name <名字> [--assets <目标,目标>] [--types <类型>] \
                  [--caps proxy,ssh] [--days 30]
                                         签发访问令牌（服务账号语义；明文只显示一次）
  fk token list [--json]                 列出令牌（只显示前缀，不显示哈希/明文）
  fk token revoke <id|前缀>              撤销令牌（立即生效）
  fk inject [--in <文件>] [--out <文件>]  把模板里的 {{fk:目标.字段}} 换成真实值
                                         （不给 --in 时读 stdin；--out 写出时 0600）
  fk agent [run|env|status] [--socket <路径>] [--takeover]
                                         SSH agent：run 前台运行（Ctrl+C 停止）；
                                         env 打印 export SSH_AUTH_SOCK=…（Windows 打印 ssh_config 片段）；
                                         status 查询当前是否有 agent 在跑（免口令）
                                         --takeover（仅 Windows）：占用系统 agent 管道，ssh 零配置
  fk help                                显示本帮助

通用参数：
  --data-dir <路径>   数据目录（默认 $FK_DATA_DIR / $VAULT_DATA_DIR / ./data）
  --json              输出紧凑 JSON

解锁凭据（不要用命令行参数传，避免进 shell 历史）：
  FK_PASSPHRASE 或 VAULT_PASSPHRASE        主口令
  FK_SK 或 VAULT_SECRET_KEY                Secret Key，支持 @file:~/secret_key.txt
  都没设置时，终端里会提示输入。

目标写法：完整 id / 名称（忽略大小写）/ 「类型:序号」如 server:3 / 纯序号 / 唯一模糊关键词
`;

// ===== 参数解析 =====
interface Parsed {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** 手写解析：只支持 `--k v`、`--k=v`、布尔 `--flag`；CLI 不引第三方依赖 */
function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { cmd: '', positional: [], flags: {} };
  const boolFlags = new Set(['json', 'reveal', 'help', 'version', 'takeover']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).trim();
      if (eq > 0) out.flags[key] = a.slice(eq + 1);
      else if (boolFlags.has(key)) out.flags[key] = true;
      else out.flags[key] = argv[++i] ?? '';
    } else if (!out.cmd) out.cmd = a;
    else out.positional.push(a);
  }
  return out;
}

// ===== 输出 =====
function emit(text: string) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}
function emitJson(obj: unknown) {
  emit(JSON.stringify(obj));
}

/** 终端宽度对齐：中文按 2 格算，够用即可（不引 wcwidth） */
function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0) || 0) > 0x2e80 ? 2 : 1;
  return n;
}
function padEnd(s: string, w: number): string {
  const diff = w - visualLen(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

/** 明文长度截断：非 reveal 输出里不把长值铺满屏幕 */
function shorten(v: any, max = 60): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(${s.length})`;
}

// ===== 凭据 =====
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    const wasRaw = (stdin as any).isRaw;
    try {
      (stdin as any).setRawMode?.(true);
    } catch {
      /* 非 TTY 时忽略 */
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (v: string) => {
      try {
        (stdin as any).setRawMode?.(wasRaw ?? false);
      } catch {
        /* ignore */
      }
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(v);
    };
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') return done(buf);
      if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
        return;
      }
      buf += ch;
    };
    stdin.on('data', onData);
  });
}

function envPassphrase(): string | undefined {
  return process.env.FK_PASSPHRASE || process.env.VAULT_PASSPHRASE || undefined;
}
function envSecretKey(): string | undefined {
  return resolveSecretKeySource(process.env.FK_SK) || resolveSecretKeySource(process.env.VAULT_SECRET_KEY) || undefined;
}

class CliError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** 打开保险库：环境变量优先，TTY 下按需交互补口令/SK */
async function openVault(dataDir: string): Promise<Vault> {
  const v = new Vault(dataDir);
  if (!fs.existsSync(path.join(dataDir, 'keystore.json'))) {
    throw new CliError(
      EXIT.auth,
      `数据目录里没有 keystore.json：${dataDir}（先用桌面端创建保险库，或用 --data-dir 指对目录）`
    );
  }
  let pass = envPassphrase();
  if (!pass) {
    if (!process.stdin.isTTY) {
      throw new CliError(EXIT.auth, '未提供口令：设置 FK_PASSPHRASE（或 VAULT_PASSPHRASE），或在终端里交互输入');
    }
    pass = await promptHidden('主口令: ');
  }
  let sk = envSecretKey();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      v.unlock(pass, { secretKey: sk });
      return v;
    } catch (e) {
      if (e instanceof NeedSecretKeyError && process.stdin.isTTY && !sk) {
        sk = await promptHidden(`Secret Key（末 4 位 ${e.hint || '????'}）: `);
        continue;
      }
      if (e instanceof NeedSecretKeyError) {
        throw new CliError(
          EXIT.auth,
          `这个库还需要 Secret Key（末 4 位 ${e.hint || '????'}）：设置 FK_SK=@file:~/secret_key.txt，或在终端里重试`
        );
      }
      if (e instanceof WrongPassphraseError) throw new CliError(EXIT.auth, '口令错误');
      if (e instanceof WrongSecretKeyError) throw new CliError(EXIT.auth, e.message);
      throw new CliError(EXIT.error, (e as Error).message);
    }
  }
  throw new CliError(EXIT.auth, '解锁失败：凭据仍不完整');
}

// ===== 目标解析 =====
function resolveTarget(v: Vault, dataDir: string, target: string): Asset {
  const t = String(target || '').trim();
  if (!t) throw new CliError(EXIT.usage, '缺少目标：给一个 id / 名称 / 「类型:序号」');
  // 与 MCP 共用同一套解析（access-token 的 findAssetTarget）。
  // 以前这里是第二份拷贝：同一个 IP 在 CLI 里能找到、在 MCP 里却报「未找到」。
  const r = findAssetTarget(v, t, new AssetTypeStore(dataDir).aliases());
  if (r.asset) return r.asset;
  if (r.candidates.length) {
    const lines = r.candidates.map((a) => `  ${a.type}:${a.no ?? '-'}  ${a.name}  (id ${a.id})`).join('\n');
    throw new CliError(
      EXIT.notFound,
      `「${target}」有多个候选（匹配到 ${r.candidates.length} 条），请用 id 或「类型:序号」指定：\n${lines}`
    );
  }
  throw new CliError(EXIT.notFound, `未找到「${target}」：用 fk list 看看有哪些`);
}

/** 类型 key → 展示名：内置 + 用户自定义（自定义类型没有中文名时回落到 key） */
function typeLabels(dataDir: string): Record<string, string> {
  try {
    return { ...TYPE_LABELS, ...new AssetTypeStore(dataDir).labels() };
  } catch {
    return { ...TYPE_LABELS };
  }
}

/**
 * --type 解析：先认 type key 本身（自定义类型没有别名也能用），再走中文/别名归一。
 * 返回值是 string：自定义类型的 key 不在内置 AssetType 联合里。
 */
function parseTypeFlag(dataDir: string, raw: string): string {
  const store = new AssetTypeStore(dataDir);
  const key = String(raw || '').trim();
  if (store.list().some((t) => t.key === key)) return key;
  const ty = normalizeAssetType(key, store.aliases());
  if (ty) return ty;
  const types = store
    .list()
    .map((t) => `${t.key}(${t.label})`)
    .join(' / ');
  throw new CliError(EXIT.usage, `未知类型「${raw}」，可用：${types}`);
}

// ===== 命令实现 =====
function cmdStatus(v: Vault | null, dataDir: string, json: boolean) {
  // 未解锁也要能看「库在不在、是不是双因子」
  const sk = v ? v.secretKeyStatus() : peekSecretKeyStatus(dataDir);
  const kdf = v ? v.kdfInfo() : null;
  const counts: Record<string, number> = {};
  if (v) for (const a of v.list()) counts[a.type] = (counts[a.type] || 0) + 1;
  const payload = {
    version: CLI_VERSION,
    dataDir: path.resolve(dataDir),
    unlocked: !!v,
    skEnabled: sk.enabled,
    skHint: sk.hint,
    skStoredOnDevice: sk.storedOnDevice,
    kdfIter: kdf?.iter ?? null,
    kdfUpgradeRecommended: kdf?.upgradeRecommended ?? false,
    counts,
    total: v ? v.list().length : null,
  };
  if (json) return emitJson(payload);
  emit(`燧垒 fk ${CLI_VERSION}`);
  emit(`数据目录：${payload.dataDir}`);
  emit(`状态：${v ? '已解锁' : '未解锁'}`);
  if (sk.enabled) {
    emit(`双因子：已启用（末 4 位 ${sk.hint || '????'}，Secret Key ${sk.storedOnDevice ? '已存本机' : '未存本机'}）`);
  } else {
    emit('双因子：未启用');
  }
  if (kdf)
    emit(
      `密钥派生：PBKDF2 × ${kdf.iter}${kdf.upgradeRecommended ? `（建议升级到 ${kdf.recommended}：改一次口令即可）` : ''}`
    );
  if (v) {
    const parts = Object.entries(counts).map(([k, n]) => `${TYPE_LABELS[k as AssetType] || k} ${n}`);
    emit(`条目：${payload.total} 条${parts.length ? '（' + parts.join('，') + '）' : ''}`);
  } else {
    emit('提示：设置 FK_PASSPHRASE（双因子库再加 FK_SK）后重试，即可看到条目统计');
  }
}

function cmdList(v: Vault, dataDir: string, parsed: Parsed, json: boolean) {
  const ty = parsed.flags.type ? parseTypeFlag(dataDir, String(parsed.flags.type)) : undefined;
  const tag = parsed.flags.tag ? String(parsed.flags.tag) : undefined;
  const labels = typeLabels(dataDir);
  let rows = v.list(ty as AssetType | undefined, tag);
  // 与界面/MCP 一致：不带 --type 时不把备忘录混进清单
  if (!parsed.flags.type) rows = rows.filter((a) => a.type !== 'note');

  const items = rows.map((a) => ({
    id: a.id,
    type: a.type,
    typeLabel: labels[a.type] || a.type,
    no: a.no ?? null,
    name: a.name,
    tags: a.tags || [],
    summary: a.publicIp || a.ip || a.sshHost || a.baseUrl || a.panelUrl || a.loginUrl || a.endpoint || '',
  }));
  if (json) return emitJson({ total: items.length, items });

  if (!items.length) return emit('（没有匹配的条目）');
  const wType = Math.max(...items.map((i) => visualLen(i.typeLabel)));
  const wName = Math.max(...items.map((i) => visualLen(String(i.name))));
  emit(`${'#'.padStart(3)}  ${padEnd('类型', wType)}  ${padEnd('名称', wName)}  备注`);
  for (const i of items) {
    emit(
      `${String(i.no ?? '-').padStart(3)}  ${padEnd(i.typeLabel, wType)}  ${padEnd(String(i.name), wName)}  ${shorten(i.summary, 50)}`
    );
  }
}

function cmdShow(v: Vault, dataDir: string, parsed: Parsed, json: boolean) {
  const a = resolveTarget(v, dataDir, parsed.positional[0] || '');
  const reveal = !!parsed.flags.reveal;
  // 脱敏与明文都从同一入口取：vault.get 会写审计，所以 --reveal 天然留痕
  const shown = reveal ? v.get(a.id) || a : v.list().find((x) => x.id === a.id) || stripSecrets(a);
  if (json) return emitJson(shown);
  const labels = typeLabels(dataDir);
  emit(`${labels[shown.type] || shown.type} ${shown.no ? '#' + shown.no : ''}  ${shown.name}`);
  emit(`id：${shown.id}`);
  emit('');
  for (const [k, val] of Object.entries(shown)) {
    if (k === 'id' || k === 'type' || k === 'no' || k === 'name') continue;
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && !val.length)) continue;
    emit(`  ${k}: ${shorten(val)}`);
  }
  if (!reveal) emit('\n（密钥字段已脱敏；需要明文时加 --reveal，会记入审计日志）');
}

function cmdConnect(v: Vault, dataDir: string, parsed: Parsed, json: boolean) {
  const a = resolveTarget(v, dataDir, parsed.positional[0] || '');
  const ttl = Math.max(60, Number(parsed.flags.ttl) || 3600);
  if (a.type === 'server' || a.type === 'ssh_key') {
    let r: ReturnType<Vault['issueSshAccess']>;
    try {
      r = v.issueSshAccess(a.id, ttl);
    } catch (e) {
      throw new CliError(EXIT.error, (e as Error).message);
    }
    const command = `ssh -o StrictHostKeyChecking=no -p ${r.proxyPort} ${r.token}@${r.proxyHost}`;
    if (json)
      return emitJson({
        mode: 'ssh',
        target: r.targetHint,
        ttl: r.ttl,
        command,
        proxyHost: r.proxyHost,
        proxyPort: r.proxyPort,
        token: r.token,
      });
    emit(`目标：${r.targetHint}`);
    emit(`有效期：${r.ttl} 秒`);
    emit(`命令：${command}`);
    emit('（真实口令/私钥由本机 SSH 代理注入，命令里不含任何密钥）');
    return;
  }
  let token: string;
  try {
    token = v.issueProxyToken(a.id, ttl);
  } catch (e) {
    throw new CliError(EXIT.error, (e as Error).message);
  }
  const port = process.env.PROXY_PORT || Number(process.env.PORT || 8787) + 1;
  const base = process.env.PROXY_BASE || `http://127.0.0.1:${port}`;
  if (json) return emitJson({ mode: 'proxy', asset: a.name, ttl, proxyBase: base, token });
  emit(`资产：${a.name}（${typeLabels(dataDir)[a.type] || a.type}）`);
  emit(`有效期：${ttl} 秒`);
  emit(`代理基址：${base}`);
  emit(`令牌：${token}`);
  emit('（把令牌放进请求头，真实密钥由代理注入；令牌过期后重新签发）');
}

function cmdEnv(v: Vault, dataDir: string, parsed: Parsed, json: boolean) {
  const a = resolveTarget(v, dataDir, parsed.positional[0] || '');
  const full = v.get(a.id);
  if (!full) throw new CliError(EXIT.error, '资产已不存在');
  const wanted = parsed.flags.field
    ? String(parsed.flags.field)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : SECRET_FIELDS.filter((k) => {
        const val = (full as any)[k];
        return val !== undefined && val !== null && val !== '';
      });
  const pairs: Record<string, string> = {};
  // 除密钥字段外顺带把「连接类」字段一起导出：终端里通常一次就要这些
  const connective = ['sshHost', 'sshPort', 'sshUser', 'username', 'baseUrl', 'panelUrl', 'loginUrl', 'endpoint'];
  for (const k of [...wanted, ...connective]) {
    const val = (full as any)[k];
    if (typeof val === 'string' && val) pairs[k] = val;
    else if (typeof val === 'number' && Number.isFinite(val)) pairs[k] = String(val);
  }
  if (!Object.keys(pairs).length)
    throw new CliError(EXIT.notFound, `「${a.name}」没有可导出的密钥字段；用 --field 指定字段名`);
  if (json) return emitJson({ asset: a.name, fields: pairs });
  // 明文走 stdout（它的用途就是被 shell 取用）：警告只走 stderr，不污染管道
  process.stderr.write(
    '# 提示：以下为明文，注意 shell 历史与终端留存；建议用 fk env ... > /dev/null 2>&1 配合 eval $(fk env ...)\n'
  );
  for (const [k, val] of Object.entries(pairs)) {
    emit(`export ${k.toUpperCase()}=${JSON.stringify(val)}`);
  }
}

// ===== 模板注入（对标 op inject）=====
/** 占位符：{{fk:server:1.sshPassword}} / {{fk:api_key:2.secret}} */
const TPL_RE = /\{\{\s*fk:([^}]+?)\s*\}\}/g;

async function readStdin(): Promise<string> {
  return await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
}

/**
 * 把模板里的占位符替换成真实值。
 * - 目标用与别处同一套解析（id / 名称 / 类型:序号 / 唯一模糊）；
 * - 只替换、不解释：出错时只说「哪个目标/哪个字段」，绝不把已取到的值拼进错误消息；
 * - 取明文走 vault.get（会写 get_asset 审计），所以「谁在什么时候注入了什么」是可查的。
 */
function cmdInject(v: Vault, dataDir: string, parsed: Parsed, json: boolean, text: string) {
  const aliases = new AssetTypeStore(dataDir).aliases();
  const used: string[] = [];
  const out = text.replace(TPL_RE, (_m, rawExpr: string) => {
    const expr = String(rawExpr).trim();
    const dot = expr.lastIndexOf('.');
    if (dot <= 0) {
      throw new CliError(EXIT.usage, `占位符格式应为 {{fk:目标.字段}}，收到「${expr}」`);
    }
    const target = expr.slice(0, dot);
    const field = expr.slice(dot + 1);
    const found = findAssetTarget(v, target, aliases);
    if (!found.asset) {
      throw new CliError(EXIT.notFound, `占位符 {{fk:${expr}}} 的目标「${target}」找不到`);
    }
    const full = v.get(found.asset.id);
    const val = (full as any)?.[field];
    if (val === undefined || val === null || val === '') {
      throw new CliError(EXIT.error, `「${found.asset.name}」没有字段「${field}」（或值为空）`);
    }
    used.push(`${found.asset.name}.${field}`);
    return typeof val === 'string' ? val : JSON.stringify(val);
  });

  const outPath = parsed.flags.out ? String(parsed.flags.out) : '';
  if (outPath) {
    fs.writeFileSync(outPath, out, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(outPath, 0o600);
    } catch {
      /* Windows 等平台忽略 */
    }
    if (json) return emitJson({ out: outPath, fields: used });
    // 只报路径与字段名，不回显内容
    return process.stderr.write(`已写入 ${outPath}（${used.length} 个字段：${used.join('，') || '无'}）\n`);
  }
  if (json) return emitJson({ fields: used, out });
  process.stdout.write(out);
}

// ===== 访问令牌（服务账号语义 S1）=====
function cmdToken(v: Vault, dataDir: string, parsed: Parsed, json: boolean) {
  const sub = parsed.positional[0] || '';
  const store = new AccessTokenStore(dataDir);
  const aliases = new AssetTypeStore(dataDir).aliases();

  if (sub === 'create') {
    const name = String(parsed.flags.name || '').trim();
    if (!name) {
      throw new CliError(
        EXIT.usage,
        'usage: fk token create --name <名字> --assets <目标,目标> [--caps proxy,ssh] [--days 30]'
      );
    }
    // --assets 允许写「server:3」这种人类说法，由统一解析器换成 id
    const rawAssets = parsed.flags.assets
      ? String(parsed.flags.assets)
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const assetIds: string[] = [];
    for (const t of rawAssets) {
      const found = findAssetTarget(v, t, aliases);
      if (!found.asset) throw new CliError(EXIT.notFound, `--assets 里的「${t}」找不到（用 fk list 看看）`);
      assetIds.push(found.asset.id);
    }
    const types = parsed.flags.types
      ? String(parsed.flags.types)
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    for (const ty of types) parseTypeFlag(dataDir, ty); // 提前校验类型存在，别等到换发时才失败
    const caps = parsed.flags.caps
      ? (String(parsed.flags.caps)
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean) as TokenCap[])
      : undefined;
    const days = parsed.flags.days ? Number(parsed.flags.days) : undefined;
    if (!assetIds.length && !types.length) {
      throw new CliError(EXIT.usage, 'scope 不能为空：用 --assets 或 --types 指定能访问哪些资产（不允许一令牌全库）');
    }

    const { token, view } = store.create({ name, assets: assetIds, types, caps, days });
    v.auditExternal('token_create', {
      token: view.name,
      prefix: view.prefix,
      assets: assetIds.length,
      types: types.length,
      caps: view.caps,
    });
    if (json) return emitJson({ token, ...view });
    emit(`令牌「${view.name}」已创建：${view.daysLeft} 天后过期`);
    emit(
      `scope：${view.scope.assets.length} 个资产 / ${view.scope.types.length} 个类型；能力：${view.caps.join(' + ')}`
    );
    emit('');
    emit(`  ${token}`);
    emit('');
    emit('这串只显示这一次。它不含解密能力，只能换短期代理/SSH 凭据：');
    emit(`  curl -s -X POST http://127.0.0.1:8787/api/access-token/exchange \\`);
    emit(`       -H 'Content-Type: application/json' \\`);
    emit(`       -d '{"token":"${token.slice(0, 12)}…","target":"server:1","action":"ssh"}'`);
    return;
  }

  if (sub === 'list') {
    const rows = store.list();
    if (json) return emitJson({ total: rows.length, items: rows });
    if (!rows.length) return emit('（还没有访问令牌）');
    for (const r of rows) {
      const state = r.active ? `${r.daysLeft ?? '-'} 天后过期` : r.revokedAt ? '已撤销' : '已过期';
      emit(`${r.active ? '●' : '○'} ${r.prefix}  ${r.name}`);
      emit(
        `    ${r.scope.assets.length} 资产 / ${r.scope.types.length} 类型 · ${r.caps.join('+')} · ${state} · 最近使用 ${r.lastUsedAt || '—'}`
      );
      emit(`    id ${r.id}`);
    }
    return;
  }

  if (sub === 'revoke') {
    const key = parsed.positional[1];
    if (!key) throw new CliError(EXIT.usage, 'fk token revoke <id 或前缀>');
    const r = store.revoke(key);
    if (!r) throw new CliError(EXIT.notFound, `没找到唯一的令牌「${key}」（用 fk token list 看 id）`);
    v.auditExternal('token_revoke', { token: r.name, prefix: r.prefix });
    if (json) return emitJson(r);
    return emit(`已撤销令牌「${r.name}」（${r.prefix}），立即生效`);
  }

  throw new CliError(EXIT.usage, 'fk token 支持 create / list / revoke');
}

// ===== SSH agent =====
/**
 * `fk agent`：把保险库里的 ssh_key 私钥做成标准 agent，
 * 用户 export SSH_AUTH_SOCK 后，ssh/git/scp 直接可用，私钥不出本进程。
 * 锁屏策略与 MCP/REST 同一套（读 lock_state.json + allowLockedAccess），不另立规矩。
 */
function agentSocketPath(dataDir: string, parsed: Parsed): string {
  const custom = parsed.flags.socket ? String(parsed.flags.socket) : '';
  const takeover = parsed.flags.takeover === true || process.env.FK_AGENT_TAKEOVER === '1';
  return agentEndpoint({ dataDir, socketPath: custom || undefined, takeoverSystemAgent: takeover });
}

function agentGuard(dataDir: string): () => string | null {
  return () => {
    let allow = false;
    try {
      allow = new SettingsStore(dataDir).get().allowLockedAccess;
    } catch {
      allow = false; // 设置读不出来时按最严的来
    }
    return lockedBlockReason(dataDir, allow);
  };
}

async function cmdAgentRun(v: Vault, dataDir: string, parsed: Parsed, json: boolean): Promise<number> {
  const socketPath = agentSocketPath(dataDir, parsed);
  const takeover = parsed.flags.takeover === true || process.env.FK_AGENT_TAKEOVER === '1';
  const agent = new SshAgent(v, {
    dataDir,
    socketPath,
    takeoverSystemAgent: takeover,
    guard: agentGuard(dataDir),
  });
  try {
    await agent.listen();
  } catch (e) {
    throw new CliError(EXIT.error, (e as Error).message);
  }

  const keys = agent.keys();
  const isWin = process.platform === 'win32';
  if (json) {
    emitJson({
      socket: socketPath,
      ...(isWin ? { pipe: socketPath, sshConfig: `IdentityAgent ${pipeToSshConfig(socketPath)}` } : {}),
      pid: process.pid,
      keys: keys.map((k) => ({ name: k.name, algo: k.algo, fingerprint: k.fingerprint })),
    });
  } else {
    emit(`SSH agent 已启动（pid ${process.pid}）`);
    emit(isWin ? `管道：${socketPath}` : `socket：${socketPath}`);
    emit(
      `密钥：${keys.length} 把${keys.length ? '（' + keys.map((k) => `${k.name}/${k.algo}`).join('，') + '）' : ''}`
    );
    emit('');
    if (isWin) {
      // Win32-OpenSSH 不认 SSH_AUTH_SOCK，要靠 IdentityAgent 指到命名管道
      emit('用法：在 %USERPROFILE%\\.ssh\\config 里加一行（Host * 下即可）：');
      emit(`  IdentityAgent ${pipeToSshConfig(socketPath)}`);
    } else {
      emit(`用法：export SSH_AUTH_SOCK=${JSON.stringify(socketPath)}`);
      emit('（Ctrl+C 停止；也可写进 ~/.ssh/config：IdentityAgent ' + JSON.stringify(socketPath) + '）');
    }
    if (!keys.length) emit('提示：还没有带私钥的「SSH 登录」资产，add 后再 fk agent status 看效果');
  }
  process.stderr.write('# agent 只允许本用户进程连接；每次签名都会记入审计日志\n');

  // 前台常驻：收到信号后收尾（清 socket 文件），不留残骸
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
  });
  await agent.close();
  if (!json) emit('\nSSH agent 已停止');
  return EXIT.ok;
}

function cmdAgentEnv(dataDir: string, parsed: Parsed, json: boolean) {
  const socketPath = agentSocketPath(dataDir, parsed);
  const isWin = process.platform === 'win32';
  if (isWin) {
    const sshConfig = `IdentityAgent ${pipeToSshConfig(socketPath)}`;
    if (json) return emitJson({ pipe: socketPath, sshConfig });
    // Windows 没有可 eval 的 export，直接给 ssh_config 片段
    emit(`Host *`);
    emit(`  ${sshConfig}`);
    process.stderr.write('# 先 `fk agent run`；把上面两行写进 %USERPROFILE%\\.ssh\\config 即可让 ssh/git 使用燧垒的密钥\n');
    return;
  }
  if (json) return emitJson({ socket: socketPath, export: `export SSH_AUTH_SOCK=${JSON.stringify(socketPath)}` });
  // 只输出可直接 eval 的一行，提示走 stderr，避免污染 $(fk agent env)
  emit(`export SSH_AUTH_SOCK=${JSON.stringify(socketPath)}`);
  process.stderr.write('# 先 `fk agent` 起服务，再 eval "$(fk agent env)"；或在 ~/.ssh/config 写 IdentityAgent\n');
}

async function cmdAgentStatus(dataDir: string, parsed: Parsed, json: boolean): Promise<number> {
  const socketPath = agentSocketPath(dataDir, parsed);
  try {
    const r = await queryAgent(socketPath);
    if (json) {
      emitJson({ running: true, socket: socketPath, keys: r.keys });
      return EXIT.ok;
    }
    emit(`SSH agent：运行中（${socketPath}）`);
    if (!r.keys.length) emit('密钥：0 把');
    else {
      emit(`密钥：${r.keys.length} 把`);
      for (const k of r.keys) emit(`  ${k.type.padEnd(22)} ${k.comment}`);
    }
    return EXIT.ok;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (json) {
      emitJson({ running: false, socket: socketPath, error: msg });
      return EXIT.error;
    }
    process.stderr.write(`fk: 没有检测到运行中的 SSH agent（${socketPath}）：${msg}\n`);
    return EXIT.error;
  }
}

async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.version || parsed.cmd === 'version' || parsed.cmd === '--version') {
    emit(`fk ${CLI_VERSION}`);
    return EXIT.ok;
  }
  if (!parsed.cmd || parsed.cmd === 'help' || parsed.flags.help) {
    process.stdout.write(HELP);
    return EXIT.ok;
  }
  const json = !!parsed.flags.json;
  const dataDir = resolveDataDir('./data', parsed.flags['data-dir'] ? String(parsed.flags['data-dir']) : undefined);

  try {
    if (parsed.cmd === 'status') {
      let v: Vault | null = null;
      try {
        v = await openVault(dataDir);
      } catch (e) {
        // status 是只读体检：没凭据不算失败，继续展示外部可见状态
        if (!(e instanceof CliError && e.code === EXIT.auth)) throw e;
        v = null;
      }
      cmdStatus(v, dataDir, json);
      return EXIT.ok;
    }

    if (parsed.cmd === 'token') {
      if (!parsed.positional.length) throw new CliError(EXIT.usage, 'fk token 需要子命令：create / list / revoke');
      const v = await openVault(dataDir);
      cmdToken(v, dataDir, parsed, json);
      return EXIT.ok;
    }

    if (parsed.cmd === 'agent') {
      const sub = parsed.positional[0] || 'run';
      if (sub === 'env') {
        cmdAgentEnv(dataDir, parsed, json);
        return EXIT.ok;
      }
      if (sub === 'status') return await cmdAgentStatus(dataDir, parsed, json);
      if (sub !== 'run' && sub !== 'start') {
        throw new CliError(EXIT.usage, 'fk agent 支持 run / env / status');
      }
      const v = await openVault(dataDir);
      return await cmdAgentRun(v, dataDir, parsed, json);
    }

    if (parsed.cmd === 'inject') {
      const inPath = parsed.flags.in ? String(parsed.flags.in) : '';
      if (!inPath && process.stdin.isTTY) {
        throw new CliError(EXIT.usage, 'inject 需要模板：用 --in <文件> 或把模板管道进来（cat tpl | fk inject）');
      }
      let text = '';
      try {
        text = inPath ? fs.readFileSync(inPath, 'utf8') : await readStdin();
      } catch (e) {
        throw new CliError(EXIT.error, `读模板失败：${(e as Error).message}`);
      }
      const v = await openVault(dataDir);
      cmdInject(v, dataDir, parsed, json, text);
      return EXIT.ok;
    }

    const needArg = ['list', 'show', 'connect', 'env'];
    if (!needArg.includes(parsed.cmd)) {
      throw new CliError(EXIT.usage, `未知命令「${parsed.cmd}」；fk help 看用法`);
    }
    if (parsed.cmd !== 'list' && !parsed.positional.length) {
      throw new CliError(EXIT.usage, `${parsed.cmd} 需要一个目标：fk ${parsed.cmd} <目标>`);
    }

    const v = await openVault(dataDir);
    if (parsed.cmd === 'list') cmdList(v, dataDir, parsed, json);
    else if (parsed.cmd === 'show') cmdShow(v, dataDir, parsed, json);
    else if (parsed.cmd === 'connect') cmdConnect(v, dataDir, parsed, json);
    else cmdEnv(v, dataDir, parsed, json);
    return EXIT.ok;
  } catch (e) {
    const err = e as CliError;
    const code = typeof err.code === 'number' && err.message ? err.code : EXIT.error;
    process.stderr.write(`fk: ${err.message || String(e)}\n`);
    return code;
  }
}

function main() {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

// 只有被直接运行时才启动；被测试 import 时不执行。
// 用 realpath 兜软链（/tmp → /private/tmp），否则会出现「跑了但一句话没有」。
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    if (pathToFileURL(process.argv[1]).href === import.meta.url) return true;
    return (
      pathToFileURL(fs.realpathSync(process.argv[1])).href ===
      pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
})();
if (isMain) main();

export { runCli, parseArgs, CLI_VERSION, EXIT };
