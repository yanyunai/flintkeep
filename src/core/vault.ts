import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  Asset,
  AssetType,
  looksLikeSshCredentialServer,
  resolveServerHost,
  resolveSshKeyId,
  serverHasInlineSshCreds,
  serverMatchesNameOrIp,
  stripSecrets,
  SECRET_FIELDS,
} from './schema';
import { ProxyManager } from './proxy';
import { mergeServerConnectionView, resolveSshTarget } from './ssh-resolve';
import { loadCustomSecretKeys } from './field-schema';
import { withFileLock } from './file-lock';
import {
  decodeSecretKey,
  formatSecretKey,
  generateSecretKey,
  isValidSecretKey,
  normalizeSecretKey,
  secretKeyHint,
} from './secret-key';

const ALGO = 'aes-256-gcm';
/** 审计脱敏与资产脱敏共用 schema 里的同一份清单，避免多处漂移 */
const AUDIT_SECRET_KEYS = new Set<string>(SECRET_FIELDS as string[]);
/** 新库 / 改口令使用的迭代次数（OWASP 对 PBKDF2-HMAC-SHA256 的建议值） */
const PBKDF2_ITER_CURRENT = 650000;
/** 旧库回退值：keystore 缺 iter 字段时，历史上就是用 210k 派的，提上去就解不开了 */
const PBKDF2_ITER_LEGACY = 210000;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const VERIFIER_PLAIN = 'mishiguanli:verifier:ok-v1'; // 兼容旧库：此值不可改名
/** Secret Key 回滚窗口：启用后多久内允许停用（超过就只能靠应急包） */
const SK_ROLLBACK_MS = 24 * 60 * 60 * 1000;

/**
 * 口令错误：用于与“文件不存在/其它错误”区分，便于上层给出精确提示。
 */
export class WrongPassphraseError extends Error {
  constructor() {
    super('主密钥口令错误，无法解锁保险库');
    this.name = 'WrongPassphraseError';
  }
}

/**
 * 这个库启用了 Secret Key，但本次解锁没提供。
 * 单独一个错误类型：否则上层只能报「口令错误」，用户会以为自己记错了口令。
 */
export class NeedSecretKeyError extends Error {
  constructor(public readonly hint: string) {
    super(hint ? `这个保险库还需要 Secret Key（末 4 位 ${hint}）` : '这个保险库还需要 Secret Key');
    this.name = 'NeedSecretKeyError';
  }
}

/** Secret Key 格式/校验位/末 4 位对不上——与「口令错」分开报 */
export class WrongSecretKeyError extends Error {
  constructor(message: string) {
    super(`Secret Key 不正确：${message}`);
    this.name = 'WrongSecretKeyError';
  }
}

/**
 * 本地加密保险库（v2 安全存储）：
 * - 主密钥不再直接来自环境变量明文，而是由「用户口令 + 随机 salt」经 PBKDF2 派生。
 * - keystore.json 存放 salt + verifier（一段用派生密钥加密的已知明文）。
 *   解锁时：派生密钥 → 解密 verifier → 校验。口令错则 GCM 校验失败 / 明文不符，直接抛错，
 *   绝不会用错误密钥去解密 vault，避免静默损坏。
 * - 派生出的密钥只存在内存里，进程退出即消失；重启需再次输入口令。
 * - 首次运行（无 keystore）传入口令即初始化；之后每次运行都需同一口令解锁。
 * - 兼容旧版（VAULT_MASTER_KEY + sha256 直接做密钥）的数据：检测到旧文件时自动迁移。
 */
/** 系统动作：不算人工、也不算 Agent */
const AUDIT_SYSTEM_ACTIONS = new Set([
  'vault_lock',
  'vault_unlock',
  'migrate_server_to_ssh_key',
  'migrate_inline_ssh_to_link',
]);

/**
 * Agent 自报审计允许携带的字段白名单。
 * 目的：防止 meta 覆盖 ts/actor/action 造成审计伪造，同时避免 Agent 顺手把密钥塞进审计。
 */
const AUDIT_META_KEYS = new Set([
  'tool', 'scope', 'key', 'id', 'assetId', 'name', 'type', 'provider', 'model',
  'accountId', 'profile', 'on', 'only', 'kind', 'reason', 'mode', 'requestId',
  'ttl', 'count', 'byType', 'ok', 'created', 'updated', 'deleted', 'permission', 'commands',
]);

/** 审计记录的操作方分类（与前端 auditCategory 保持一致） */
export function auditKindOf(e: any): 'user' | 'agent' | 'system' {
  if (e?.action === 'agent_action' || (e?.actor && e.actor !== 'unknown')) return 'agent';
  if (AUDIT_SYSTEM_ACTIONS.has(e?.action)) return 'system';
  return 'user';
}

export class Vault {
  private key: Buffer | null = null;
  private dataDir: string;
  private dataPath: string;
  private auditPath: string;
  private keystorePath: string;
  private legacyFlagPath: string;
  private keysDir: string;
  private assets: Map<string, Asset> = new Map();
  /** 通用加密集合（工作台业务数据等），键名 → 任意 JSON（数组或分键对象）；随整库一起加密落盘 */
  private collections: Map<string, any> = new Map();
  private actor = 'unknown'; // 当前调用方（Agent）身份，由 MCP 层设置
  private _locked = true;
  private proxyMgr: ProxyManager;
  private auditMaxBytes: number;
  /** 轮转保留代数（.1 … .N），超出即删；0 = 不留历史 */
  private auditGenerations = 3;
  /** 自定义敏感字段 key 缓存（按 field_schema.json 的 mtime 失效，跨进程写入也能感知） */
  private extraSecretCache: { mtime: number; keys: Set<string> } | null = null;

  /** 数据目录：项目档案（运行工作台）等附属存储与保险库同级 */
  get dir(): string { return this.dataDir; }

  /** 数据目录写锁：server / MCP / Electron 同开一个数据目录，写操作必须跨进程互斥 */
  private get writeLockPath(): string { return path.join(this.dataDir, 'vault.enc.json.lock'); }

  /**
   * 包住「reload → 改 → save」整个读改写区。
   * 只锁写不锁读：读本身走 reload 就是最新的，加锁只会拖慢列表；
   * 但两个人同时 read-modify-write 时，只 reload 不加锁仍会丢掉先写的那个。
   */
  private withWriteLock<T>(fn: () => T): T {
    return withFileLock(this.writeLockPath, fn, { timeoutMs: 3000, staleMs: 15000 });
  }

  constructor(
    dataDir: string,
    passphrase?: string,
    opts: {
      auditMaxBytes?: number;
      auditGenerations?: number;
      secretKey?: string;
      useStoredSecretKey?: boolean;
    } = {}
  ) {
    this.auditMaxBytes = opts.auditMaxBytes ?? 5 * 1024 * 1024;
    if (typeof opts.auditGenerations === 'number') this.auditGenerations = Math.max(0, Math.min(10, opts.auditGenerations));
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.dataPath = path.join(dataDir, 'vault.enc.json');
    this.auditPath = path.join(dataDir, 'audit.log.jsonl');
    this.keystorePath = path.join(dataDir, 'keystore.json');
    this.legacyFlagPath = path.join(dataDir, '.legacy-migrated');
    this.keysDir = path.join(dataDir, 'ssh_keys');
    fs.mkdirSync(this.keysDir, { recursive: true });
    this.proxyMgr = new ProxyManager(dataDir);

    // 兼容旧版遗留数据：存在旧加密文件但还没有 keystore，则用旧口令做一次迁移。
    if (!fs.existsSync(this.keystorePath) && fs.existsSync(this.dataPath)) {
      const legacy = process.env.VAULT_MASTER_KEY;
      if (legacy) this.migrateFromLegacy(legacy);
    }

    const pp = passphrase || process.env.VAULT_PASSPHRASE || process.env.VAULT_MASTER_KEY;
    if (pp) this.unlock(pp, { secretKey: opts.secretKey, useStoredSecretKey: opts.useStoredSecretKey });
  }

  get locked(): boolean {
    return this._locked;
  }

  private get keyBuf(): Buffer {
    if (!this.key) throw new Error('保险库尚未解锁，请先 unlock(passphrase)');
    return this.key;
  }

  /**
   * 解锁 / 首次初始化。返回是否已首次创建 keystore。
   * opts.secretKey：库启用了 Secret Key（keystore.kdfVer = 2）时必须提供，否则抛 NeedSecretKeyError。
   */
  /**
   * 解锁 / 首次初始化。返回是否已首次创建 keystore。
   *
   * opts.secretKey：库启用了 Secret Key（keystore.kdfVer = 2）时必须提供；
   *   未显式提供时默认读本机 secret_key.txt（「记住此设备」），读不到才抛 NeedSecretKeyError。
   * opts.useStoredSecretKey=false：只认调用方传入的 SK（CLI 严格模式）。
   */
  unlock(
    passphrase: string,
    opts: { secretKey?: string; useStoredSecretKey?: boolean } = {}
  ): boolean {
    let created = false;
    /** 双因子库标记：决定解锁失败时该报「口令错」还是「SK 错」 */
    let kdfVer = 1;
    let sk: string | undefined;
    if (!fs.existsSync(this.keystorePath)) {
      // 关键防线：密文在、keystore 没了 —— 绝不能当「首次运行」重建。
      // 重建会生成新 salt，旧密文永久解不开；用户还会以为「重设口令就行」。
      const hasCipher = fs.existsSync(this.dataPath) && fs.statSync(this.dataPath).size > 0;
      if (hasCipher && process.env.FLINTKEEP_FORCE_REINIT !== '1') {
        throw new Error(
          'keystore.json 丢失，但加密库 vault.enc.json 还在：拒绝重新初始化（否则旧数据永久无法解密）。' +
            '请先从 data/backups/ 恢复同名 keystore.json；确认要放弃旧库时，设置环境变量 FLINTKEEP_FORCE_REINIT=1 再启动。'
        );
      }
      // 首次运行：创建 salt + verifier（新库直接用当前强度）
      const salt = crypto.randomBytes(SALT_LEN);
      const key = this.derive(passphrase, salt, PBKDF2_ITER_CURRENT);
      const verifier = this.sealWith(key, VERIFIER_PLAIN);
      // kdfVer：1 = 仅口令；2 = 口令 + Secret Key（enableSecretKey 时改 2）
      const ks = { v: 1, kdf: 'pbkdf2-sha256', kdfVer: 1, iter: PBKDF2_ITER_CURRENT, salt: salt.toString('base64'), verifier };
      this.writeKeystore(ks);
      this.key = key;
      created = true;
    } else {
      const ks = this.readKeystore();
      const salt = Buffer.from(ks.salt, 'base64');
      // 迭代次数以 keystore 为准：否则将来调高参数、或迁移别处的 keystore 都会解不开。
      // 缺 iter 的是老库，只能用历史值，不能用新默认值（提上去等于把老库锁死）。
      const iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
      kdfVer = Number(ks.kdfVer) === 2 ? 2 : 1;
      // 第一步只验证口令：verifier 始终由「纯口令派生」加密（启用 SK 时刻意不改它），
      // 这样「口令错」和「SK 错」能分开报，用户不会在两个未知量之间瞎试。
      const passKey = this.derive(passphrase, salt, iter);
      let passOk = false;
      try {
        passOk = this.unsealWith(passKey, ks.verifier) === VERIFIER_PLAIN;
      } catch {
        passOk = false;
      }
      if (!passOk) throw new WrongPassphraseError();
      // 第二步：双因子库必须拿到 Secret Key —— 缺 SK 要说「缺 SK」，不能报「口令错误」
      if (kdfVer === 2) sk = this.requireSecretKey(ks, opts.secretKey, opts.useStoredSecretKey);
      this.key = this.deriveWithSk(passphrase, salt, iter, sk);
    }
    this._locked = false;
    try {
      this.reload();
    } catch (e) {
      // 口令能解开 verifier，但密文解不开。三种成因要分开处理：
      // ① 启用/停用 SK 中途崩溃 → 用 pre-sk 复原点整体回滚；
      // ② 双因子库 SK 不对 → 明确报 SK 错（口令已经验证过是对的）；
      // ③ 改口令时两个文件没同时切换成功 → 用上一代 keystore 自愈。
      this._locked = true;
      this.key = null;
      if (this.recoverFromPreSk(passphrase, sk)) return created;
      if (kdfVer === 2) {
        const hint = String((JSON.parse(fs.readFileSync(this.keystorePath, 'utf8')) as any)?.sk?.hint || '');
        throw new WrongSecretKeyError(`与末 4 位 ${hint || '????'} 对不上（口令已验证正确）`);
      }
      if (this.recoverWithKeystoreBak(passphrase, sk)) return created;
      throw new Error(
        '保险库解密失败：口令校验通过，但密文与 keystore 不匹配（' +
          (e as Error).message +
          '）。如刚改过口令，请尝试恢复 data/keystore.json.bak；否则请用备份恢复。'
      );
    }
    try { fs.chmodSync(this.keystorePath, 0o600); } catch { /* Windows 等平台忽略 */ }
    return created;
  }

  /** 写 keystore：权限 0600 + 原子 rename，避免 0644 让同机其他账户读到 verifier */
  private writeKeystore(ks: unknown): void {
    const tmp = this.keystorePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ks), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.keystorePath);
    try { fs.chmodSync(this.keystorePath, 0o600); } catch { /* ignore */ }
  }

  /**
   * 改口令中途崩溃的自愈：keystore 已换、密文还是旧的（或反过来）时，
   * 用 keystore.json.bak 里的旧盐重新尝试；成功则把 bak 回滚为当前 keystore。
   */
  private recoverWithKeystoreBak(passphrase: string, secretKey?: string): boolean {
    const bak = this.keystorePath + '.bak';
    if (!fs.existsSync(bak)) return false;
    try {
      const ks = JSON.parse(fs.readFileSync(bak, 'utf8'));
      const salt = Buffer.from(ks.salt, 'base64');
      const iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
      // 双因子库的 .bak 也是双因子：缺 SK 回滚不了（这正是双因子该有的样子）
      let sk: string | undefined;
      if (Number(ks.kdfVer) === 2) {
        try { sk = this.requireSecretKey(ks, secretKey); } catch { return false; }
      }
      // verifier 只依赖口令：先用纯口令 key 验，再拿组合 key 去解密文
      if (this.unsealWith(this.derive(passphrase, salt, iter), ks.verifier) !== VERIFIER_PLAIN) return false;
      const key = this.deriveWithSk(passphrase, salt, iter, sk);
      const prevKey = this.key;
      this.key = key;
      this._locked = false;
      try {
        this.reload();
      } catch {
        this.key = prevKey;
        return false;
      }
      fs.copyFileSync(bak, this.keystorePath);
      this.auditExternal('vault_recover_keystore', { from: 'keystore.json.bak' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 修改主口令：校验旧口令 → 用新口令重新派生密钥 → 重写 keystore + 重加密保险库。
   * 须已处于解锁态；改完后 MCP 配置里的 VAULT_PASSPHRASE 也要同步改。
   */
  /**
   * 修改主口令：校验旧口令 → 用新口令重新派生密钥 → 重写 keystore + 重加密保险库。
   * 须已处于解锁态；改完后 MCP 配置里的 VAULT_PASSPHRASE 也要同步改。
   * 双因子库同时需要 Secret Key（SK 本身不变，只是换了 salt 与口令那一半）。
   */
  changePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
    opts: { secretKey?: string } = {}
  ): void {
    return this.withWriteLock(() => this.changePassphraseLocked(oldPassphrase, newPassphrase, opts));
  }

  private changePassphraseLocked(
    oldPassphrase: string,
    newPassphrase: string,
    opts: { secretKey?: string } = {}
  ): void {
    if (this._locked || !this.key) throw new Error('保险库尚未解锁');
    if (!oldPassphrase) throw new Error('请填写当前口令');
    if (!newPassphrase || newPassphrase.length < 4) throw new Error('新口令至少 4 个字符');
    if (oldPassphrase === newPassphrase) throw new Error('新口令不能与当前口令相同');
    if (!fs.existsSync(this.keystorePath)) throw new Error('keystore 不存在');

    const ks = this.readKeystore();
    const oldSalt = Buffer.from(ks.salt, 'base64');
    const oldIter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
    // 因子数量以 keystore 为准：双因子库改口令后仍必须双因子
    const kdfVer = Number(ks.kdfVer) === 2 ? 2 : 1;
    // 旧口令按「这个 keystore 当初用的迭代次数」校验；新口令一律升到当前强度。
    // verifier 始终由纯口令派生加密（与 unlock 的分步校验保持一致），
    // 所以这里先用 passKey 验口令，再单独验 SK —— 否则双因子库永远报「SK 错」。
    const passKey = this.derive(oldPassphrase, oldSalt, oldIter);
    let passOk = false;
    try {
      passOk = this.unsealWith(passKey, ks.verifier) === VERIFIER_PLAIN;
    } catch {
      passOk = false;
    }
    if (!passOk) throw new WrongPassphraseError();
    const sk = kdfVer === 2 ? this.requireSecretKey(ks, opts.secretKey) : undefined;
    if (sk) {
      // hint 只有末 4 位，理论上可能撞；再用组合密钥真解一次密文兜底，避免「口令对、SK 错」被放过
      try {
        this.decrypt(JSON.parse(fs.readFileSync(this.dataPath, 'utf8')), this.deriveWithSk(oldPassphrase, oldSalt, oldIter, sk));
      } catch {
        throw new WrongSecretKeyError(`与末 4 位 ${ks.sk?.hint || '????'} 对不上（口令已验证正确）`);
      }
    }

    this.reload();
    const assets = [...this.assets.values()];
    const newSalt = crypto.randomBytes(SALT_LEN);
    const newKey = this.deriveWithSk(newPassphrase, newSalt, PBKDF2_ITER_CURRENT, sk);
    // verifier 始终用「纯口令」的派生值加密：否则下次解锁无法单独判断口令对错
    const passOnlyNew = this.derive(newPassphrase, newSalt, PBKDF2_ITER_CURRENT);
    const verifier = this.sealWith(passOnlyNew, VERIFIER_PLAIN);
    const newKs = {
      v: 1,
      kdf: 'pbkdf2-sha256',
      kdfVer,
      iter: PBKDF2_ITER_CURRENT,
      salt: newSalt.toString('base64'),
      verifier,
      ...(kdfVer === 2 ? { sk: ks.sk } : {}),
    };

    this.key = newKey;
    this.assets = new Map(assets.map((a) => [a.id, a]));
    const vaultPayload = JSON.stringify(this.encrypt({ assets, collections: Object.fromEntries(this.collections) }));
    const ksPayload = JSON.stringify(newKs);
    const vaultTmp = this.dataPath + '.tmp';
    const ksTmp = this.keystorePath + '.tmp';
    // 两个文件不可能原子地一起切换：先留一份旧 keystore，
    // 万一在两次 rename 之间崩溃，unlock() 会用 .bak 自动回滚（见 recoverWithKeystoreBak）。
    try { fs.copyFileSync(this.keystorePath, this.keystorePath + '.bak'); } catch { /* ignore */ }
    fs.writeFileSync(vaultTmp, vaultPayload, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(ksTmp, ksPayload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(vaultTmp, this.dataPath);
    fs.renameSync(ksTmp, this.keystorePath);
    try { fs.chmodSync(this.dataPath, 0o600); fs.chmodSync(this.keystorePath, 0o600); } catch { /* ignore */ }
    // 独立密钥目录里的文件也要用新主密钥重加密
    for (const a of this.assets.values()) {
      if (a.type === 'ssh_key' && a.privateKeyEnc) this.writeSshKeyFile(a);
    }
    this.audit('change_passphrase', {});
  }
  // ===== Secret Key（双因子）=====

  /** Secret Key 独立文件：与密文、keystore 分离；不随备份走（备份只有「半把钥匙」） */
  private get secretKeyPath(): string { return path.join(this.dataDir, 'secret_key.txt'); }

  private readKeystore(): any {
    return JSON.parse(fs.readFileSync(this.keystorePath, 'utf8'));
  }

  /**
   * 读本机保存的 Secret Key。
   * 兼容两种情况：本程序写的 secret_key.txt（首行有效值 + 注释），
   * 或用户直接把应急包文本放进来的文件（逐行找第一个合法 SK）。
   */
  readStoredSecretKey(): string | null {
    try {
      if (!fs.existsSync(this.secretKeyPath)) return null;
      return firstValidSecretKey(fs.readFileSync(this.secretKeyPath, 'utf8'));
    } catch {
      return null;
    }
  }

  private writeSecretKeyFile(sk: string): void {
    const body = [
      '# FlintKeep Secret Key —— 与口令一起才能解锁保险库',
      '# 等同钥匙：不要放进同一个密码管理器，不要拍照存相册，不要提交到代码仓库',
      formatSecretKey(sk),
      '',
    ].join('\n');
    fs.writeFileSync(this.secretKeyPath, body, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.secretKeyPath, 0o600); } catch { /* Windows 等平台忽略 */ }
  }

  private deleteSecretKeyFile(): void {
    try {
      if (fs.existsSync(this.secretKeyPath)) fs.unlinkSync(this.secretKeyPath);
    } catch { /* ignore */ }
  }

  /** 库指纹：salt 的 SHA-256 前 8 位，写在应急包上用于确认「这把 SK 配这个库」 */
  private storeFingerprint(ks: any): string {
    return crypto.createHash('sha256').update(String(ks?.salt || '')).digest('hex').slice(0, 8).toUpperCase();
  }

  /**
   * 取并校验一把 SK：优先调用方传入，其次本机文件。
   * 缺 → NeedSecretKeyError（带 hint）；格式/校验位/末 4 位不符 → WrongSecretKeyError。
   */
  private requireSecretKey(ks: any, provided?: string, useStored = true): string {
    const hint = String(ks?.sk?.hint || '');
    const raw = provided || (useStored ? this.readStoredSecretKey() || undefined : undefined);
    if (!raw) throw new NeedSecretKeyError(hint);
    // 宽容一层：用户常把整段应急包文本粘进来（含说明行），逐行找第一把合法 SK
    const sk = firstValidSecretKey(String(raw)) || normalizeSecretKey(raw);
    if (!isValidSecretKey(sk)) throw new WrongSecretKeyError('格式或校验位不正确（应为 28 位，4 组 × 7）');
    if (hint && secretKeyHint(sk) !== hint) throw new WrongSecretKeyError(`末 4 位应是 ${hint}`);
    return sk;
  }

  /** 双因子状态：锁定态也要能查（只读 keystore，不需要主密钥） */
  secretKeyStatus(): SecretKeyStatus {
    return peekSecretKeyStatus(this.dataDir);
  }

  /**
   * 应急包文本（纯文本，可直接打印/另存）。
   * 只在本机已保存 SK 时可用 —— 这条路径正是「用户刚才启用完、还没下载就关了窗口」的救急。
   */
  emergencyKitText(): { filename: string; text: string; fingerprint: string; hint: string } {
    const st = this.secretKeyStatus();
    if (!st.enabled) throw new Error('这个库没有启用 Secret Key，无需应急包');
    const sk = this.readStoredSecretKey();
    if (!sk) throw new Error('本机没有保存 Secret Key（secret_key.txt），无法重新生成应急包；请用启用时已保存的那份');
    const hint = secretKeyHint(sk);
    const fp = st.fingerprint || '????????';
    const created = st.enabledAt || '未知';
    const text = [
      ' FlintKeep 应急包（Emergency Kit）',
      ' ============================================',
      '',
      ` 库指纹（salt 的 SHA-256 前 8 位）：${fp}`,
      ` 启用时间：${created}`,
      ` Secret Key 末 4 位：${hint}`,
      '',
      ' Secret Key（与口令一起才能解锁保险库）：',
      '',
      `   ${formatSecretKey(sk)}`,
      '',
      ' --------------------------------------------',
      ' 恢复步骤：',
      '   1. 新设备安装 FlintKeep（或直接运行本程序）；',
      '   2. 导入备份文件（vault.enc.json + keystore.json，或导出的备份包）；',
      '   3. 解锁时输入「主口令 + 本页 Secret Key」。',
      '',
      ' 警告：',
      '   - 本页等同于钥匙，请与口令分开存放（不要放进同一个密码管理器）；',
      '   - 不要拍照存相册、不要发到聊天工具、不要提交到代码仓库；',
      '   - 丢失 Secret Key 且无本页 = 数据永久无法恢复（本程序不提供后门）。',
      '',
      ` 生成时间：${new Date().toISOString()}`,
      '',
    ].join('\n');
    return { filename: `flintkeep-emergency-kit-${fp}.txt`, text, fingerprint: fp, hint };
  }

  /** 崩溃复原点：启用/停用 SK 前把 keystore 与密文各留一份 */
  private backupPreSk(): void {
    try {
      fs.copyFileSync(this.keystorePath, this.keystorePath + '.pre-sk');
      if (fs.existsSync(this.dataPath)) fs.copyFileSync(this.dataPath, this.dataPath + '.pre-sk');
    } catch {
      /* 备份失败不阻塞：任一 rename 失败时旧文件仍在 */
    }
  }

  private dropPreSk(): void {
    for (const f of [this.keystorePath + '.pre-sk', this.dataPath + '.pre-sk']) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }

  /**
   * 启用 Secret Key（单因子 → 双因子）。
   * 调用方必须先让用户下载/打印应急包；这里只负责落地与整库重加密。
   * 返回明文 SK —— **只此一次**，之后任何接口都只给末 4 位。
   */
  enableSecretKey(passphrase: string): {
    secretKey: string;
    hint: string;
    enabledAt: string;
    fingerprint: string;
  } {
    return this.withWriteLock(() => this.enableSecretKeyLocked(passphrase));
  }

  private enableSecretKeyLocked(passphrase: string): {
    secretKey: string;
    hint: string;
    enabledAt: string;
    fingerprint: string;
  } {
    if (this._locked || !this.key) throw new Error('保险库尚未解锁');
    if (!fs.existsSync(this.keystorePath)) throw new Error('keystore 不存在');
    const ks = this.readKeystore();
    if (Number(ks.kdfVer) === 2) throw new Error('这个库已经启用了 Secret Key');
    const salt = Buffer.from(ks.salt, 'base64');
    const iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
    const passKey = this.derive(passphrase, salt, iter);
    let ok = false;
    try { ok = this.unsealWith(passKey, ks.verifier) === VERIFIER_PLAIN; } catch { ok = false; }
    if (!ok) throw new WrongPassphraseError();

    const { secretKey, hint } = generateSecretKey();
    const sk = normalizeSecretKey(secretKey);
    const enabledAt = new Date().toISOString();
    const newKey = this.deriveWithSk(passphrase, salt, iter, sk);
    // verifier 不动：salt 没变，纯口令派生结果不变，保持「口令可单独验」的语义
    const newKs = { ...ks, kdfVer: 2, sk: { hint, enabledAt } };

    // 崩溃安全：先留复原点 → 写 SK 文件 → 换密文 → 换 keystore。
    // 顺序不能反：keystore 先切到双因子而 secret_key.txt 还没写，用户就再也进不去了。
    this.backupPreSk();
    this.writeSecretKeyFile(sk);
    this.key = newKey;
    this.save();
    fs.writeFileSync(this.keystorePath + '.tmp', JSON.stringify(newKs), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(this.keystorePath + '.tmp', this.keystorePath);
    try { fs.chmodSync(this.dataPath, 0o600); fs.chmodSync(this.keystorePath, 0o600); } catch { /* ignore */ }
    for (const a of this.assets.values()) {
      if (a.type === 'ssh_key' && a.privateKeyEnc) this.writeSshKeyFile(a);
    }
    this.dropPreSk();
    this.audit('enable_secret_key', { hint });
    return { secretKey: formatSecretKey(sk), hint, enabledAt, fingerprint: this.storeFingerprint(newKs) };
  }

  /**
   * 「记住此设备」：解锁成功后把已验证过的 SK 写到本机 secret_key.txt（0600）。
   * 这是显式动作（前端复选框），不是解锁的副作用 —— 否则「换机只用一次」也会被悄悄落地。
   */
  rememberSecretKey(secretKey: string): { ok: true; hint: string } {
    const st = peekSecretKeyStatus(this.dataDir);
    if (!st.enabled) throw new Error('这个库没有启用 Secret Key');
    const norm = normalizeSecretKey(secretKey);
    if (!isValidSecretKey(norm)) throw new WrongSecretKeyError('格式或校验位不正确');
    if (st.hint && secretKeyHint(norm) !== st.hint) throw new WrongSecretKeyError(`末 4 位应是 ${st.hint}`);
    this.writeSecretKeyFile(norm);
    this.audit('remember_secret_key', { hint: st.hint || secretKeyHint(norm) });
    return { ok: true, hint: st.hint || secretKeyHint(norm) };
  }

  /**
   * 停用 Secret Key —— 只在启用后 24 小时内开放。
   * 超过窗口就永久关闭这条路：长期保留「凭口令单开」的后门，双因子等于安慰剂。
   * 实现上不依赖 pre-sk 回滚，而是换新 salt 重新派生：数据全在内存里重加密，
   * 与「期间改过口令」也能正确衔接。
   */
  disableSecretKey(passphrase: string, opts: { secretKey?: string } = {}): { disabled: true } {
    return this.withWriteLock(() => this.disableSecretKeyLocked(passphrase, opts));
  }

  private disableSecretKeyLocked(passphrase: string, opts: { secretKey?: string } = {}): { disabled: true } {
    if (this._locked || !this.key) throw new Error('保险库尚未解锁');
    const ks = this.readKeystore();
    if (Number(ks.kdfVer) !== 2) throw new Error('这个库没有启用 Secret Key');
    const enabledAt = ks.sk?.enabledAt ? new Date(ks.sk.enabledAt).getTime() : 0;
    const until = enabledAt + SK_ROLLBACK_MS;
    if (!enabledAt || Date.now() >= until) {
      const when = enabledAt ? new Date(until).toLocaleString('zh-CN') : '未知';
      throw new Error(
        `已超过 24 小时回滚窗口（截止 ${when}），不再提供停用入口。` +
          'Secret Key 丢失时只能用应急包恢复（见设计文档「明确不做」一节）。'
      );
    }
    const salt = Buffer.from(ks.salt, 'base64');
    const iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
    const passKey = this.derive(passphrase, salt, iter);
    let passOk = false;
    try { passOk = this.unsealWith(passKey, ks.verifier) === VERIFIER_PLAIN; } catch { passOk = false; }
    if (!passOk) throw new WrongPassphraseError();
    // 停用只需要确认「用户确实持有当前这把 SK」；新库不再用它，所以不保存返回值
    this.requireSecretKey(ks, opts.secretKey);

    const newSalt = crypto.randomBytes(SALT_LEN);
    const newKey = this.derive(passphrase, newSalt, PBKDF2_ITER_CURRENT);
    const newKs = {
      v: 1,
      kdf: 'pbkdf2-sha256',
      kdfVer: 1,
      iter: PBKDF2_ITER_CURRENT,
      salt: newSalt.toString('base64'),
      verifier: this.sealWith(newKey, VERIFIER_PLAIN),
    };

    this.backupPreSk();
    this.key = newKey;
    this.save();
    fs.writeFileSync(this.keystorePath + '.tmp', JSON.stringify(newKs), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(this.keystorePath + '.tmp', this.keystorePath);
    try { fs.chmodSync(this.dataPath, 0o600); fs.chmodSync(this.keystorePath, 0o600); } catch { /* ignore */ }
    for (const a of this.assets.values()) {
      if (a.type === 'ssh_key' && a.privateKeyEnc) this.writeSshKeyFile(a);
    }
    this.deleteSecretKeyFile();
    this.dropPreSk();
    this.audit('disable_secret_key', {});
    return { disabled: true };
  }

  /**
   * 启用/停用 SK 中途崩溃的自愈：keystore 与密文可能一新一旧。
   * pre-sk 是操作前的完整复原点，成功后把两个文件一起回滚并清掉复原点。
   */
  private recoverFromPreSk(passphrase: string, secretKey?: string): boolean {
    const ksPre = this.keystorePath + '.pre-sk';
    const vaultPre = this.dataPath + '.pre-sk';
    if (!fs.existsSync(ksPre)) return false;
    let prevKey: Buffer | null = null;
    try {
      const ks = JSON.parse(fs.readFileSync(ksPre, 'utf8'));
      const kdfVer = Number(ks.kdfVer) === 2 ? 2 : 1;
      const sk = kdfVer === 2 ? this.requireSecretKey(ks, secretKey) : undefined;
      const salt = Buffer.from(ks.salt, 'base64');
      const iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
      // 复原点上的 verifier 同样只依赖口令
      if (this.unsealWith(this.derive(passphrase, salt, iter), ks.verifier) !== VERIFIER_PLAIN) return false;
      const key = this.deriveWithSk(passphrase, salt, iter, sk);
      prevKey = this.key;
      this.key = key;
      this._locked = false;
      if (fs.existsSync(vaultPre)) fs.copyFileSync(vaultPre, this.dataPath);
      this.reload();
      fs.copyFileSync(ksPre, this.keystorePath);
      if (kdfVer === 2) this.writeSecretKeyFile(sk as string);
      else this.deleteSecretKeyFile();
      this.dropPreSk();
      this.auditExternal('vault_recover_pre_sk', { kdfVer });
      return true;
    } catch {
      this.key = prevKey;
      return false;
    }
  }


  private sshKeyFilePath(id: string): string {
    return path.join(this.keysDir, `${id}.key.enc`);
  }

  /** 把私钥写入 data/ssh_keys/（AES 加密，非明文） */
  private writeSshKeyFile(asset: Asset): void {
    if (!asset.privateKeyEnc) return;
    const sealed = this.sealWith(this.keyBuf, asset.privateKeyEnc);
    const rel = path.join('ssh_keys', `${asset.id}.key.enc`).replace(/\\/g, '/');
    fs.writeFileSync(
      this.sshKeyFilePath(asset.id),
      JSON.stringify({
        v: 1,
        fileName: asset.keyFileName || null,
        ...sealed,
      }),
      { mode: 0o600 }
    );
    asset.keyFileRel = rel;
  }

  private deleteSshKeyFile(id: string): void {
    const p = this.sshKeyFilePath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  /** 若保险库条目缺私钥正文，尝试从独立加密文件恢复 */
  private hydrateSshKey(asset: Asset): Asset {
    if (asset.type !== 'ssh_key' || asset.privateKeyEnc) return asset;
    const p = this.sshKeyFilePath(asset.id);
    if (!fs.existsSync(p)) return asset;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const pem = this.unsealWith(this.keyBuf, raw);
      return {
        ...asset,
        privateKeyEnc: pem,
        keyFileName: asset.keyFileName || raw.fileName || undefined,
        keyFileRel: asset.keyFileRel || path.join('ssh_keys', `${asset.id}.key.enc`).replace(/\\/g, '/'),
      };
    } catch {
      return asset;
    }
  }

  /** 用派生密钥加密一段已知明文（用于 verifier / 迁移）。 */
  private sealWith(k: Buffer, plain: string): { iv: string; tag: string; data: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, k, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private unsealWith(k: Buffer, p: { iv: string; tag: string; data: string }): string {
    const iv = Buffer.from(p.iv, 'base64');
    const tag = Buffer.from(p.tag, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(Buffer.from(p.data, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  }

  /**
   * 派生主密钥。iter 必须显式传：新库与老库的迭代次数不同，
   * 给默认值会让人以为「不传就是最新的」，实际等于把老库静默锁死。
   */
  private derive(passphrase: string, salt: Buffer, iter: number): Buffer {
    return crypto.pbkdf2Sync(passphrase, salt, iter, KEY_LEN, 'sha256');
  }

  /**
   * 带 Secret Key 的主密钥派生（S1：只加能力，解锁路径仍走 derive）。
   *
   * masterKey = PBKDF2(passphrase, salt, iter) XOR HKDF-SHA256(secretKey, salt, "flintkeep-sk-v1")
   *
   * - 不带 secretKey 时直接返回 PBKDF2 结果，未启用 SK 的库行为完全不变；
   * - 用 XOR 而不是「拼接后再 KDF」：任一侧缺失都无法还原，计算量也最小；
   * - info 里带版本号，将来换算法只影响新库（靠 keystore.kdfVer 区分）。
   */
  deriveWithSk(passphrase: string, salt: Buffer, iter: number, secretKey?: string): Buffer {
    const keyFromPass = this.derive(passphrase, salt, iter);
    if (!secretKey) return keyFromPass;
    const ikm = decodeSecretKey(secretKey);
    const keyFromSk = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'flintkeep-sk-v1', KEY_LEN));
    return Buffer.from(keyFromPass.map((b, i) => b ^ keyFromSk[i]));
  }

  /**
   * 当前 keystore 的派生强度。界面用它提示「老库建议改一次口令升级到 650k」——
   * 升级要同时重写 keystore 与整库密文，只能由 changePassphrase 完成，不能静默做。
   */
  kdfInfo(): { kdf: string; kdfVer: number; iter: number; recommended: number; upgradeRecommended: boolean } {
    let iter = PBKDF2_ITER_CURRENT;
    let kdf = 'pbkdf2-sha256';
    let kdfVer = 1;
    try {
      const ks = JSON.parse(fs.readFileSync(this.keystorePath, 'utf8'));
      iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
      kdf = String(ks.kdf || kdf);
      kdfVer = Number(ks.kdfVer) === 2 ? 2 : 1;
    } catch {
      /* 首次运行前还没有 keystore：按当前默认值展示 */
    }
    return { kdf, kdfVer, iter, recommended: PBKDF2_ITER_CURRENT, upgradeRecommended: iter < PBKDF2_ITER_CURRENT };
  }

  /** 旧版（sha256(mk) 直接做密钥）数据迁移到新 keystore 方案。 */
  private migrateFromLegacy(masterKey: string): void {
    if (fs.existsSync(this.legacyFlagPath)) return;
    try {
      const oldKey = crypto.createHash('sha256').update(masterKey).digest();
      const payload = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
      const iv = Buffer.from(payload.iv, 'base64');
      const tag = Buffer.from(payload.tag, 'base64');
      const decipher = crypto.createDecipheriv(ALGO, oldKey, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
      const plain = JSON.parse(dec.toString('utf8'));
      // 用新口令派生密钥，重新加密
      const salt = crypto.randomBytes(SALT_LEN);
      const newKey = this.derive(masterKey, salt, PBKDF2_ITER_CURRENT);
      const verifier = this.sealWith(newKey, VERIFIER_PLAIN);
      fs.writeFileSync(
        this.keystorePath,
        JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', kdfVer: 1, iter: PBKDF2_ITER_CURRENT, salt: salt.toString('base64'), verifier })
      );
      this.key = newKey;
      this._locked = false;
      this.assets = new Map((plain.assets as Asset[]).map((a) => [a.id, a]));
      this.collections = new Map(Object.entries((plain as any).collections || {}));
      this.save();
      fs.writeFileSync(this.legacyFlagPath, '1');
      console.warn('[vault] 已自动将旧版（sha256 口令）数据迁移到 PBKDF2 方案');
    } catch (e) {
      throw new Error('旧版数据迁移失败：' + (e as Error).message + '；如需保留请备份 vault.enc.json 后删除 keystore 重试');
    }
  }

  reload(): void {
    if (!fs.existsSync(this.dataPath)) {
      this.assets = new Map();
      this.collections = new Map();
      return;
    }
    const payload = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
    const plain = this.decrypt(payload);
    this.assets = new Map((plain.assets as Asset[]).map((a) => [a.id, a]));
    this.collections = new Map(Object.entries((plain as any).collections || {}));
    this.migrateSshLayout();
    this.assignNumbers();
  }

  /** 列出所有加密集合名；MCP 是长驻独立进程，先重载磁盘避免读到启动时缓存的旧名单 */
  listCollectionNames(): string[] {
    this.reload();
    return [...this.collections.keys()];
  }

  /** 读集合内容（先重载磁盘，保证跨进程写入可见）；不存在返回 null */
  readCollection(name: string): any {
    this.reload();
    return this.collections.get(name) ?? null;
  }

  /** 读加密集合（工作台业务数据）；锁定状态下返回 null（调用方需先解锁） */
  getCollection(name: string): any {
    return this.collections.get(name) ?? null;
  }

  /** 整体覆盖写一个加密集合（数组或分键对象均可；随整库原子加密落盘 + 每日备份覆盖） */
  setCollection(name: string, data: any): void {
    this.withWriteLock(() => {
      // 写前重读：桌面端 / MCP / 工作台桥接共用同一个加密文件。
      // 不重读就会拿「进程启动时的旧快照」整库覆盖，把别处刚写进去的资产静默吃掉。
      if (!this._locked) this.reload();
      this.collections.set(name, data ?? []);
      this.save();
    });
  }

  /**
   * 补齐资产序号（每类独立 1,2,3…）。只在有缺号时写盘一次；
   * 已有编号永不改动、删除后不回收，保证编号可当稳定的口头引用。
   */
  private assignNumbers(): void {
    const used = new Map<string, number>();
    for (const a of this.assets.values()) {
      if (typeof a.no === 'number' && Number.isFinite(a.no) && a.no > 0) {
        used.set(a.type, Math.max(used.get(a.type) || 0, a.no));
      }
    }
    const pending = [...this.assets.values()]
      .filter((a) => !(typeof a.no === 'number' && Number.isFinite(a.no) && a.no > 0))
      .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
    if (!pending.length) return;
    for (const a of pending) {
      const next = (used.get(a.type) || 0) + 1;
      used.set(a.type, next);
      a.no = next;
    }
    this.save();
  }

  /** 按类型 + 序号取资产（如 server 3 号）；返回完整凭证并写审计。 */
  getByNo(type: AssetType, no: number): Asset | undefined {
    this.reload();
    const a = [...this.assets.values()].find((x) => x.type === type && x.no === no);
    if (!a) return undefined;
    return this.get(a.id);
  }

  /**
   * 布局迁移（幂等）：
   * - server.ip → publicIp
   * - 名称像「…服务器ssh」且无机器档案 → 整条转为 ssh_key
   * - 其余 server 上残留的 SSH 凭证 → 拆成关联的 ssh_key 并清空 server 凭证字段
   */
  private migrateSshLayout(): void {
    let changed = false;
    const now = new Date().toISOString();
    const servers = [...this.assets.values()].filter((a) => a.type === 'server');

    for (const raw of servers) {
      let a: Asset = { ...raw };
      let touched = false;

      if (a.ip && !a.publicIp) {
        a = { ...a, publicIp: a.ip };
        touched = true;
      }

      if (looksLikeSshCredentialServer(a)) {
        const converted: Asset = {
          id: a.id,
          type: 'ssh_key',
          name: a.name,
          tags: a.tags || [],
          group: a.group,
          note: a.note,
          createdAt: a.createdAt,
          updatedAt: now,
          links: (a.links || []).filter((l) => l.role !== 'ssh_key'),
          sshHost: a.sshHost || a.publicIp || a.ip,
          sshPort: a.sshPort || 22,
          sshUser: a.sshUser || 'root',
          sshPassword: a.sshPassword,
          authMethod: a.authMethod || (a.privateKeyEnc ? 'key' : a.sshPassword ? 'password' : undefined),
          publicKey: a.publicKey,
          privateKeyEnc: a.privateKeyEnc,
          keyPassphrase: a.keyPassphrase,
          keyFileName: a.keyFileName,
          keyFileRel: a.keyFileRel,
          rotationReminderDays: a.rotationReminderDays,
          lastRotatedAt: a.lastRotatedAt,
        };
        if (converted.privateKeyEnc) this.writeSshKeyFile(converted);
        this.assets.set(converted.id, converted);
        changed = true;
        this.audit('migrate_server_to_ssh_key', { id: converted.id, name: converted.name });
        continue;
      }

      if (serverHasInlineSshCreds(a) && !resolveSshKeyId(a)) {
        const keyId = crypto.randomUUID();
        const keyAsset: Asset = {
          id: keyId,
          type: 'ssh_key',
          name: `${a.name} · SSH登录`,
          tags: [],
          createdAt: now,
          updatedAt: now,
          sshPort: a.sshPort || 22,
          sshUser: a.sshUser || 'root',
          sshPassword: a.sshPassword,
          authMethod: a.authMethod || (a.privateKeyEnc ? 'key' : a.sshPassword ? 'password' : undefined),
          privateKeyEnc: a.privateKeyEnc,
          keyPassphrase: a.keyPassphrase,
          keyFileName: a.keyFileName,
        };
        if (keyAsset.privateKeyEnc) this.writeSshKeyFile(keyAsset);
        this.assets.set(keyId, keyAsset);
        a = {
          ...a,
          links: [...(a.links || []), { id: keyId, role: 'ssh_key' }],
          sshKeyId: keyId,
          sshPort: undefined,
          sshUser: undefined,
          sshPassword: undefined,
          authMethod: undefined,
          privateKeyEnc: undefined,
          keyPassphrase: undefined,
          keyFileName: undefined,
          updatedAt: now,
        };
        this.assets.set(a.id, a);
        changed = true;
        this.audit('migrate_inline_ssh_to_link', { serverId: a.id, sshKeyId: keyId });
        continue;
      }

      if (touched) {
        this.assets.set(a.id, { ...a, updatedAt: now });
        changed = true;
      }
    }

    if (changed) this.save();
  }

  private encrypt(obj: any) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.keyBuf, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
  }

  private decrypt(payload: any, key?: Buffer) {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key || this.keyBuf, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
  }

  private save(): void {
    const payload = this.encrypt({ assets: [...this.assets.values()], collections: Object.fromEntries(this.collections) });
    // 原子写：先写临时文件再 rename，写一半断电/崩溃也不会损坏整库文件
    const tmp = this.dataPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.dataPath);
    try { fs.chmodSync(this.dataPath, 0o600); } catch { /* Windows 等平台忽略 */ }
  }

  /**
   * 锁定：清除内存中的密钥与明文资产；读写都需要重新解锁。
   * 同时吊销已签发的代理令牌 —— 否则锁定前签发、已经泄露给 Agent 的令牌，
   * 会在下一次解锁后自动复活，等于把「新会话」和「旧会话」混在一起。
   */
  lock(): void {
    if (this.key) this.key.fill(0);
    this.key = null;
    this._locked = true;
    this.assets = new Map();
    this.collections = new Map();
    try {
      this.proxyMgr.revokeAll();
    } catch {
      /* 令牌文件删不掉不应阻塞锁定 */
    }
  }

  /**
   * 调整审计保留策略（设置页可改）。
   * 只影响**之后**的轮转，不改已有文件——历史是证据，不能因为调小阈值就被悄悄删掉。
   */
  setAuditRetention(opts: { maxBytes?: number; generations?: number }): void {
    if (typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes)) {
      this.auditMaxBytes = Math.max(64 * 1024, Math.min(100 * 1024 * 1024, Math.floor(opts.maxBytes)));
    }
    if (typeof opts.generations === 'number' && Number.isFinite(opts.generations)) {
      this.auditGenerations = Math.max(0, Math.min(10, Math.floor(opts.generations)));
    }
  }

  /** 审计文件（旧 → 新）：.N … .1 → 主文件，供导出与排查 */
  auditFiles(): string[] {
    const out: string[] = [];
    for (let i = this.auditGenerations; i >= 1; i--) {
      const f = `${this.auditPath}.${i}`;
      if (fs.existsSync(f)) out.push(f);
    }
    if (fs.existsSync(this.auditPath)) out.push(this.auditPath);
    return out;
  }

  /** 导出审计原文（JSONL 拼接，旧 → 新） */
  exportAuditText(): string {
    return this.auditFiles()
      .map((f) => {
        try {
          return fs.readFileSync(f, 'utf8');
        } catch {
          return '';
        }
      })
      .join('');
  }

  /**
   * 审计追加 + 轮转：主文件超过阈值时滚动到 .1，旧的依次后移；
   * 只保留最近 auditGenerations 代，多出来的直接删（否则改小代数等于没改）。
   */
  private appendAuditLine(line: string): void {
    try {
      if (fs.existsSync(this.auditPath) && fs.statSync(this.auditPath).size > this.auditMaxBytes) {
        for (let i = this.auditGenerations; i >= 1; i--) {
          const from = i > 1 ? `${this.auditPath}.${i - 1}` : this.auditPath;
          const to = `${this.auditPath}.${i}`;
          if (fs.existsSync(from)) fs.renameSync(from, to);
        }
      }
      // 清掉超出保留代数 / 或已关闭历史时遗留的旧文件
      for (const f of safeReaddir(path.dirname(this.auditPath))) {
        const m = /^audit\.log\.jsonl\.(\d+)$/.exec(f);
        if (!m) continue;
        if (Number(m[1]) > this.auditGenerations) {
          try {
            fs.unlinkSync(path.join(path.dirname(this.auditPath), f));
          } catch {
            /* 删不掉不影响本次追加 */
          }
        }
      }
    } catch {
      /* 轮转失败不影响追加 */
    }
    fs.appendFileSync(this.auditPath, line + '\n');
  }

  private audit(action: string, detail: Record<string, any>): void {
    const entry = { ts: new Date().toISOString(), actor: this.actor, action, ...detail };
    this.appendAuditLine(JSON.stringify(entry));
  }

  /** 供外部模块（如模型用量）写入审计：仅记录动作与资源标识，不含任何密钥 */
  auditExternal(action: string, detail: Record<string, any> = {}): void {
    this.audit(action, detail);
  }

  /** MCP 层在 initialize 时设置调用方（Agent）身份，使审计能区分“哪个 Agent 来取” */
  setActor(actor: string): void {
    this.actor = actor || 'unknown';
  }

  /** 列出资产（剥离敏感字段，只返回元数据） */
  list(type?: AssetType, tag?: string): Asset[] {
    this.reload();
    let arr = [...this.assets.values()];
    if (type) arr = arr.filter((a) => a.type === type);
    if (tag) arr = arr.filter((a) => (a.tags || []).includes(tag));
    const secrets = this.extraSecretKeys();
    return arr.map((a) => stripSecrets(a, secrets));
  }

  /** 完整获取（含敏感字段），写审计 */
  get(id: string): Asset | undefined {
    this.reload();
    let a = this.assets.get(id);
    if (!a) return undefined;
    a = this.hydrateSshKey(a);
    if (a.privateKeyEnc && a !== this.assets.get(id)) this.assets.set(id, a);
    this.audit('get_asset', { id, type: a.type, name: a.name });
    return a;
  }

  /** 内部读取（含敏感字段，不写审计），供 SSH/HTTP 代理解析关联密钥等 */
  peek(id: string): Asset | undefined {
    this.reload();
    const a = this.assets.get(id);
    if (!a) return undefined;
    const hydrated = this.hydrateSshKey(a);
    if (hydrated.privateKeyEnc) this.assets.set(id, hydrated);
    return hydrated;
  }

  search(q: string): Asset[] {
    this.reload();
    const ql = q.toLowerCase();
    const secrets = this.extraSecretKeys();
    return [...this.assets.values()]
      .filter((a) => JSON.stringify(stripSecrets(a, secrets)).toLowerCase().includes(ql))
      .map((a) => stripSecrets(a, secrets));
  }

  /** 自定义字段里的敏感 key；配置变化后按 mtime 自动刷新 */
  private extraSecretKeys(): Set<string> {
    const file = path.join(this.dataDir, 'field_schema.json');
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (this.extraSecretCache && this.extraSecretCache.mtime === mtime) return this.extraSecretCache.keys;
    const keys = loadCustomSecretKeys(this.dataDir);
    this.extraSecretCache = { mtime, keys };
    return keys;
  }

  /** 把 role=ssh_key 的 link 与 sshKeyId 双向对齐，供 SSH 代理兼容旧逻辑 */
  private syncSshKeyId(a: Asset): Asset {
    const links = a.links;
    const keyFromLinks = (links || []).find((l) => l.role === 'ssh_key')?.id;
    if (keyFromLinks) return { ...a, sshKeyId: keyFromLinks };
    if (Array.isArray(links)) {
      // 表单显式提交了 links 且没有 ssh_key → 清掉旧 sshKeyId
      return { ...a, sshKeyId: undefined };
    }
    if (a.sshKeyId) {
      return { ...a, links: [{ id: a.sshKeyId, role: 'ssh_key' }] };
    }
    return a;
  }

  /** 人工操作恢复点：加密集合 'undo' 存最近 50 条快照（含密钥，随整库加密），审计条目只带 uid */
  private pushUndo(entry: Record<string, any>): string {
    const uid = crypto.randomUUID();
    const list = (this.collections.get('undo') || []) as any[];
    list.unshift({ uid, ts: new Date().toISOString(), actor: this.actor, ...entry });
    this.collections.set('undo', list.slice(0, 50));
    this.save();
    return uid;
  }

  /** 每资产保留的版本数 */
  private static readonly VERSIONS_PER_ASSET = 10;
  /** 全库版本总上限，避免大量资产各改几次就把保险库撑大 */
  private static readonly VERSIONS_TOTAL = 300;

  /**
   * 记录一版资产快照（改 / 删之前调用）。存加密集合 'asset_versions'：{ [assetId]: Version[] }。
   * 快照含明文密钥，随整库加密落盘；审计只记 vid，不记内容。
   */
  private pushAssetVersion(asset: Asset, source: 'update' | 'delete' | 'restore', changed: string[] = []): string {
    const vid = crypto.randomUUID();
    const all = (this.collections.get('asset_versions') || {}) as Record<string, any[]>;
    const list = Array.isArray(all[asset.id]) ? all[asset.id] : [];
    list.unshift({
      vid,
      ts: new Date().toISOString(),
      actor: this.actor,
      source,
      changed,
      // 深拷贝：后续 update 会改对象引用，直接存会把「历史」变成「当前」
      asset: JSON.parse(JSON.stringify(asset)),
    });
    all[asset.id] = list.slice(0, Vault.VERSIONS_PER_ASSET);
    this.collections.set('asset_versions', all);
    this.trimAssetVersions();
    return vid;
  }

  /** 全局上限：超出按时间淘汰最旧（避免几百个资产各改十次把库撑大） */
  private trimAssetVersions(): void {
    const all = (this.collections.get('asset_versions') || {}) as Record<string, any[]>;
    const flat: { id: string; ts: string; vid: string }[] = [];
    for (const [id, arr] of Object.entries(all)) {
      for (const v of arr || []) flat.push({ id, ts: String(v.ts || ''), vid: String(v.vid || '') });
    }
    if (flat.length <= Vault.VERSIONS_TOTAL) return;
    flat.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const drop = new Set(flat.slice(0, flat.length - Vault.VERSIONS_TOTAL).map((x) => `${x.id}:${x.vid}`));
    for (const [id, arr] of Object.entries(all)) {
      const kept = (arr || []).filter((v) => !drop.has(`${id}:${String(v.vid)}`));
      if (kept.length) all[id] = kept;
      else delete all[id];
    }
    this.collections.set('asset_versions', all);
  }

  /** 某资产的版本列表（摘要，不含快照内容——别把密钥拉进界面/Agent 上下文） */
  listAssetVersions(assetId: string): Array<{
    vid: string;
    ts: string;
    actor: string;
    source: string;
    changed: string[];
    name?: string;
    type?: string;
    no?: number;
  }> {
    this.reload();
    const all = (this.collections.get('asset_versions') || {}) as Record<string, any[]>;
    return (all[assetId] || []).map((v) => ({
      vid: v.vid,
      ts: v.ts,
      actor: v.actor,
      source: v.source,
      changed: Array.isArray(v.changed) ? v.changed : [],
      name: v.asset?.name,
      type: v.asset?.type,
      no: v.asset?.no,
    }));
  }

  /** 取某一版快照（含敏感字段；调用方决定是否脱敏，读取写审计） */
  getAssetVersion(assetId: string, vid: string): Asset | undefined {
    this.reload();
    const all = (this.collections.get('asset_versions') || {}) as Record<string, any[]>;
    const v = (all[assetId] || []).find((x) => x.vid === vid);
    if (!v?.asset) return undefined;
    this.audit('get_asset_version', { id: assetId, vid });
    return JSON.parse(JSON.stringify(v.asset)) as Asset;
  }

  /** 回滚到某一版：当前状态也会记一版（回滚本身可回滚），再用快照覆盖 */
  restoreAssetVersion(assetId: string, vid: string): Asset | undefined {
    return this.withWriteLock(() => this.restoreAssetVersionLocked(assetId, vid));
  }

  private restoreAssetVersionLocked(assetId: string, vid: string): Asset | undefined {
    this.reload();
    const all = (this.collections.get('asset_versions') || {}) as Record<string, any[]>;
    const v = (all[assetId] || []).find((x) => x.vid === vid);
    if (!v?.asset) return undefined;
    if (!this.assets.get(assetId)) return undefined;
    const updated = this.updateLocked(assetId, { ...(v.asset as Asset), id: assetId }, 'restore');
    if (updated) this.audit('restore_asset_version', { id: assetId, vid, name: updated.name });
    return updated;
  }

  /** 应用一个恢复点：delete=找回资产并还原被清理的关联；update=回滚到改前快照；add=撤销新增 */
  undo(uid: string): any {
    this.reload();
    const list = (this.collections.get('undo') || []) as any[];
    const idx = list.findIndex((u) => u.uid === uid);
    if (idx < 0) throw new Error('恢复点不存在或已使用');
    const entry = list[idx];
    if (entry.kind === 'delete' && entry.asset) {
      this.assets.set(entry.asset.id, entry.asset);
      if (entry.asset.type === 'ssh_key' && entry.asset.privateKeyEnc) this.writeSshKeyFile(entry.asset);
      for (const ref of entry.refs || []) {
        const other = this.assets.get(ref.otherId);
        if (other) this.assets.set(ref.otherId, { ...other, links: ref.links, sshKeyId: ref.sshKeyId, updatedAt: new Date().toISOString() });
      }
      this.audit('undo', { uid, kind: 'delete', name: entry.asset.name });
    } else if (entry.kind === 'update' && entry.asset) {
      this.assets.set(entry.asset.id, entry.asset);
      if (entry.asset.type === 'ssh_key' && entry.asset.privateKeyEnc) this.writeSshKeyFile(entry.asset);
      this.audit('undo', { uid, kind: 'update', name: entry.asset.name });
    } else if (entry.kind === 'add' && entry.asset) {
      const a = this.assets.get(entry.asset.id);
      if (a) {
        this.assets.delete(entry.asset.id);
        if (a.type === 'ssh_key') this.deleteSshKeyFile(entry.asset.id);
        for (const [k, other] of this.assets) {
          const links = (other.links || []).filter((l) => l.id !== entry.asset.id);
          const sshKeyId = other.sshKeyId === entry.asset.id ? undefined : other.sshKeyId;
          if (links.length !== (other.links || []).length || sshKeyId !== other.sshKeyId) {
            this.assets.set(k, { ...other, links, sshKeyId, updatedAt: new Date().toISOString() });
          }
        }
      }
      this.audit('undo', { uid, kind: 'add', name: entry.asset.name });
    } else {
      throw new Error('恢复点数据不完整');
    }
    list.splice(idx, 1);
    this.collections.set('undo', list);
    this.save();
    return { ok: true, kind: entry.kind, name: entry.asset?.name };
  }

  add(input: Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>): Asset {
    return this.withWriteLock(() => this.addLocked(input));
  }

  private addLocked(input: Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>): Asset {
    // 桌面端与 MCP 是两个进程各持一份内存副本；写前先重读磁盘，
    // 避免本进程的旧快照把其它进程刚写入的资产覆盖掉（外层写锁再兜住并发读改写）
    this.reload();
    const asset = this.buildAsset(input);
    this.assets.set(asset.id, asset);
    this.save();
    const undoUid = this.pushUndo({ kind: 'add', asset });
    this.audit('add_asset', { id: asset.id, type: asset.type, name: asset.name, undo: undoUid });
    return asset;
  }

  /**
   * 批量新增（导入用）：单次写锁 + 单次重读 + 单次落盘。
   * 逐条 add 时每条都要 reload + 整库加密写盘，导入上千条会慢到不可用。
   */
  addMany(inputs: Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>[]): Asset[] {
    const list = Array.isArray(inputs) ? inputs : [];
    if (!list.length) return [];
    return this.withWriteLock(() => {
      this.reload();
      const now = new Date().toISOString();
      const out: Asset[] = [];
      for (const input of list) {
        const asset = this.buildAsset(input, now);
        this.assets.set(asset.id, asset);
        out.push(asset);
      }
      this.save();
      const byType: Record<string, number> = {};
      for (const a of out) byType[a.type] = (byType[a.type] || 0) + 1;
      this.audit('import_assets', { count: out.length, byType });
      return out;
    });
  }

  /** 构造资产（不落盘）：统一分配 id / 时间 / 稳定序号 / SSH 密钥文件 */
  private buildAsset(input: Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>, at?: string): Asset {
    const ts = at || new Date().toISOString();
    let asset: Asset = { ...(input as Asset), id: crypto.randomUUID(), createdAt: ts, updatedAt: ts };
    // 稳定序号：同类最大号 +1（删除不回收，故不取 count）
    const nextNo = Math.max(0, ...[...this.assets.values()].filter((x) => x.type === asset.type).map((x) => x.no || 0)) + 1;
    asset = { ...asset, no: nextNo };
    asset = this.syncSshKeyId(asset);
    if (asset.type === 'ssh_key' && asset.privateKeyEnc) this.writeSshKeyFile(asset);
    return asset;
  }

  /** 审计用值脱敏/截断：密钥类字段只显示占位，长文本截断（写入审计前先转成展示串） */
  private auditVal(k: string, v: any): string {
    if (v === undefined || v === null || v === '') return '（空）';
    if (AUDIT_SECRET_KEYS.has(k)) return '••••••（已加密）';
    if (k === 'extra' && v && typeof v === 'object') {
      const secrets = this.extraSecretKeys();
      const parts = Object.entries(v).map(([kk, vv]) => {
        if (secrets.has(kk)) return kk + '=••••••（已加密）';
        const s = String(vv ?? '');
        return kk + '=' + (s.length > 40 ? s.slice(0, 40) + '…' : s);
      });
      return parts.join('、') || '（空）';
    }
    if (k === 'links' && Array.isArray(v)) return v.map((l: any) => (l.role || '关联') + '#' + String(l.id).slice(0, 6)).join('、') || '（空）';
    if (k === 'urls' && v && typeof v === 'object') return Object.entries(v).map(([kk, vv]) => kk + '=' + vv).join('、') || '（空）';
    const s = Array.isArray(v) ? v.join('、') : String(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  update(id: string, patch: Partial<Asset>): Asset | undefined {
    return this.withWriteLock(() => this.updateLocked(id, patch));
  }

  private updateLocked(id: string, patch: Partial<Asset>, versionSource: 'update' | 'restore' = 'update'): Asset | undefined {
    this.reload(); // 同 add：写前重读，防止跨进程写互相覆盖（外层写锁兜住并发读改写）
    const a = this.assets.get(id);
    if (!a) return undefined;
    const before: Asset = { ...a, links: (a.links || []).map((l) => ({ ...l })) }; // 改前快照（供恢复）
    let updated: Asset = { ...a, ...patch, id, updatedAt: new Date().toISOString() };
    // 自定义字段按 key 合并：Agent 只改一个字段时，不能把 extra 里其它值抹掉
    if (patch.extra && typeof patch.extra === 'object' && !Array.isArray(patch.extra)) {
      const merged: Record<string, unknown> = { ...(a.extra || {}) };
      const secrets = this.extraSecretKeys();
      for (const [k, v] of Object.entries(patch.extra as Record<string, unknown>)) {
        // 敏感字段在读取时就被剥掉了，客户端回填不到值，保存时会提交空串。
        // 空串不能覆盖已存的密钥，否则「编辑一下资产，AppSecret 就没了」。
        // 真要清空，请显式传 null。
        if (v === '' && secrets.has(k) && merged[k] !== undefined && merged[k] !== '') continue;
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      updated.extra = merged;
    }
    if ((updated as any).sshKeyId === '') (updated as any).sshKeyId = undefined;
    // 空字符串表示清空（表单用来剥离 server 上旧 SSH 字段）
    for (const k of ['sshPort', 'sshUser', 'sshPassword', 'authMethod', 'sshHost'] as const) {
      if ((patch as any)[k] === '') delete (updated as any)[k];
    }
    if ('links' in patch || 'sshKeyId' in patch) updated = this.syncSshKeyId(updated);
    if (updated.type === 'ssh_key' && updated.privateKeyEnc) this.writeSshKeyFile(updated);
    // 版本历史：先把「改前」快照与变更字段名记进加密集合，再和资产一起落盘
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(updated)])].filter(
      (k) => k !== 'updatedAt' && JSON.stringify((before as any)[k] ?? null) !== JSON.stringify((updated as any)[k] ?? null)
    );
    this.pushAssetVersion(before, versionSource, changedKeys);
    this.assets.set(id, updated);
    this.save();
    const undoUid = this.pushUndo({ kind: 'update', asset: before });
    // 修改明细：哪些字段从什么改成什么（先脱敏再入审计）
    const changes: any[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(updated)]);
    for (const k of keys) {
      if (k === 'updatedAt') continue;
      if (JSON.stringify((before as any)[k] ?? null) === JSON.stringify((updated as any)[k] ?? null)) continue;
      const from = this.auditVal(k, (before as any)[k]);
      const to = this.auditVal(k, (updated as any)[k]);
      if (from === to) continue; // 脱敏后相同（如密钥类）不再展示
      changes.push({ k, from, to });
    }
    this.audit('update_asset', { id, type: updated.type, name: updated.name, undo: undoUid, changes: changes.slice(0, 30) });
    return updated;
  }

  remove(id: string): boolean {
    return this.withWriteLock(() => this.removeLocked(id));
  }

  private removeLocked(id: string): boolean {
    this.reload(); // 同 add：写前重读，防止跨进程写互相覆盖（外层写锁兜住并发读改写）
    const a = this.assets.get(id);
    const ok = this.assets.delete(id);
    if (ok) {
      if (a?.type === 'ssh_key') this.deleteSshKeyFile(id);
      // 清理其它资产上指向已删项的关联（先快照，供恢复点还原）
      const refs: any[] = [];
      for (const [k, other] of this.assets) {
        const links = (other.links || []).filter((l) => l.id !== id);
        const sshKeyId = other.sshKeyId === id ? undefined : other.sshKeyId;
        if (links.length !== (other.links || []).length || sshKeyId !== other.sshKeyId) {
          refs.push({ otherId: k, links: (other.links || []).map((l) => ({ ...l })), sshKeyId: other.sshKeyId });
          this.assets.set(k, {
            ...other,
            links,
            sshKeyId,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      if (a) this.pushAssetVersion(a, 'delete', []);
      this.save();
      const undoUid = this.pushUndo({ kind: 'delete', asset: a ? { ...a } : undefined, refs });
      // 删除明细：脱敏快照（备忘录正文等截断），让"删了什么内容"可查
      let preview: any = null;
      if (a) {
        preview = stripSecrets(a) as any;
        if (preview.content && preview.content.length > 150) preview.content = preview.content.slice(0, 150) + '…';
      }
      this.audit('delete_asset', { id, type: a?.type, name: a?.name, undo: undoUid, preview });
    }
    return ok;
  }

  /**
   * Agent 连接服务器：返回连接信息；若关联了 SSH 密钥，一并附上私钥正文（写审计）。
   * Model B 更推荐 request_ssh_access，真密钥不进 Agent 上下文。
   */
  getServerConnection(nameOrIp: string): Asset | undefined {
    this.reload();
    // 纯数字 = 稳定序号（"服务器 3 号"）；带点的才是 IP。列表可见 no，口头引用最方便
    const target = String(nameOrIp ?? '').trim();
    const byNo = /^\d+$/.test(target);
    const server = [...this.assets.values()].find(
      (a) => a.type === 'server' && (byNo ? a.no === Number(target) : serverMatchesNameOrIp(a, target))
    );
    if (!server) return undefined;
    const host = resolveServerHost(server);
    this.audit('get_server_connection', { id: server.id, name: server.name, ip: host });
    const keyId = resolveSshKeyId(server);
    const keyAsset = keyId ? this.peek(keyId) : undefined;
    return mergeServerConnectionView(server, keyAsset);
  }

  auditLog(limit = 100): any[] {
    if (!fs.existsSync(this.auditPath)) return [];
    // 单行损坏（半行写入、磁盘满、手工编辑）不应让整个审计页 500：坏行跳过即可
    const out: any[] = [];
    for (const l of this.readAuditLines()) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* 坏行跳过 */
      }
    }
    return out.slice(-limit);
  }

  /** 读审计行：整文件读一次，按 \n 切；调用方各自容错 */
  private readAuditLines(): string[] {
    try {
      return fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  /** 审计分页：按时间倒序（最新在前） */
  /**
   * 审计分页。
   * kind 必须在服务端过滤：只在前端过滤当前页的话，Agent 记录在别的页，
   * 切到「Agent」会永远空白。
   */
  auditPage(
    page = 1,
    pageSize = 20,
    kind = ''
  ): { total: number; page: number; pageSize: number; items: any[]; kind?: string } {
    const size = Math.min(200, Math.max(5, Math.floor(pageSize) || 20));
    if (!fs.existsSync(this.auditPath)) {
      return { total: 0, page: 1, pageSize: size, items: [] };
    }
    const all: any[] = [];
    for (const l of this.readAuditLines()) {
      try {
        all.push(JSON.parse(l));
      } catch {
        /* 坏行跳过，不拖垮整页 */
      }
    }
    all.reverse();
    const want = String(kind || '').trim();
    const filtered = want ? all.filter((e: any) => auditKindOf(e) === want) : all;
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const p = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
    const start = (p - 1) * size;
    return { total, page: p, pageSize: size, items: filtered.slice(start, start + size), kind: want };
  }

  /**
   * Agent 自报操作审计：取完凭证后上报“它做了什么”（如“已 SSH 登录 web-01 查看 nginx 日志”）。
   * 与 get / get_server_connection 等取密记录拼成完整审计链，回答“取完之后干了啥”。
   */
  logAgentAction(description: string, meta: Record<string, any> = {}): any {
    // meta 曾经是直接展开到条目顶层，Agent 传 { action:'get_asset', actor:'human' } 就能伪造审计。
    // 现在只接受白名单键，且 ts/actor/action/description 一律由服务端生成、不可覆盖。
    const entry: Record<string, any> = {
      ts: new Date().toISOString(),
      actor: this.actor,
      action: 'agent_action',
      description: String(description || '').slice(0, 200),
    };
    for (const [k, v] of Object.entries(meta || {})) {
      if (AUDIT_META_KEYS.has(k)) entry[k] = v;
    }
    this.appendAuditLine(JSON.stringify(entry));
    return entry;
  }

  /**
   * 白名单更新审计：记录哪次任务、哪个云账号、旧 IP → 新 IP、成功与否。
   * 与 logAgentAction 一样写进同一份审计日志，便于界面统一查看。
   */
  logWhitelistRun(detail: Record<string, any> = {}): any {
    const entry = { ts: new Date().toISOString(), actor: this.actor, action: 'whitelist_update', ...detail };
    this.appendAuditLine(JSON.stringify(entry));
    return entry;
  }

  /**
   * 导出自包含备份：加密保险库 + keystore + 白名单绑定/调度。
   * 内部资产仍是 AES-256-GCM 加密；白名单只含云资源 ID（无密钥）。
   * 不含模型用量配置、CLI 登录态、审计日志。恢复需同一主口令。
   */
  exportBackup(): string {
    const vaultRaw = fs.existsSync(this.dataPath) ? fs.readFileSync(this.dataPath, 'utf8') : null;
    const ksRaw = fs.existsSync(this.keystorePath) ? JSON.parse(fs.readFileSync(this.keystorePath, 'utf8')) : null;
    const wlPath = path.join(this.dataDir, 'whitelist.json');
    const wlSchedPath = path.join(this.dataDir, 'whitelist_schedule.json');
    let whitelist: unknown = null;
    let whitelistSchedule: unknown = null;
    if (fs.existsSync(wlPath)) {
      try {
        whitelist = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
      } catch {
        whitelist = null;
      }
    }
    if (fs.existsSync(wlSchedPath)) {
      try {
        whitelistSchedule = JSON.parse(fs.readFileSync(wlSchedPath, 'utf8'));
      } catch {
        whitelistSchedule = null;
      }
    }
    const kdfVer = Number(ksRaw?.kdfVer) === 2 ? 2 : 1;
    return JSON.stringify(
      {
        format: 'flintkeep-backup',
        version: 2,
        // 恢复侧据此提前警告「还需要一把 Secret Key」，而不是导入完才发现打不开
        needsSecretKey: kdfVer === 2,
        secretKeyHint: kdfVer === 2 ? String(ksRaw?.sk?.hint || '') || null : null,
        vault: vaultRaw,
        keystore: ksRaw,
        whitelist,
        whitelistSchedule,
      },
      null,
      2
    );
  }

  /**
   * 导入备份：先用备份内的 keystore.verifier 校验主口令（错则拒绝、不覆盖本地数据），
   * 校验通过再写回 vault / keystore；若备份含白名单字段则一并写回（v1 旧备份无此字段则不动本地白名单）。
   */
  importBackup(
    payload: string,
    passphrase: string,
    opts: { secretKey?: string } = {}
  ): { imported: number; whitelist: number } {
    return this.withWriteLock(() => this.importBackupLocked(payload, passphrase, opts));
  }

  private importBackupLocked(
    payload: string,
    passphrase: string,
    opts: { secretKey?: string } = {}
  ): { imported: number; whitelist: number } {
    let b: any;
    try {
      b = JSON.parse(payload);
    } catch {
      throw new Error('备份文件不是合法 JSON');
    }
    if (!['flintkeep-backup', 'mishiguanli-backup'].includes(b.format) || !b.keystore) throw new Error('备份格式不符或缺少 keystore');
    const ks = b.keystore;
    const salt = Buffer.from(ks.salt, 'base64');
    // 备份里的 keystore 自带迭代次数：按它的值派生，否则老备份会判成「口令错误」
    const iter = Number(ks.iter) || PBKDF2_ITER_LEGACY;
    // 备份可能来自双因子库：缺 SK 要报「缺 SK」而不是「口令错」；hint 不符直接拒绝
    const kdfVer = Number(ks.kdfVer) === 2 ? 2 : 1;
    const sk = kdfVer === 2 ? this.requireSecretKey(ks, opts.secretKey) : undefined;
    // verifier 只依赖口令：双因子备份也用纯口令 key 验；组合 key 留给真正的密文
    let ok = false;
    try {
      ok = this.unsealWith(this.derive(passphrase, salt, iter), ks.verifier) === VERIFIER_PLAIN;
    } catch {
      ok = false;
    }
    if (!ok) throw new WrongPassphraseError();
    const key = this.deriveWithSk(passphrase, salt, iter, sk);
    // 关键：先把「密文能用这把钥匙解开」验完，再动本地文件。
    // 只校验 verifier 是不够的：手工改过、截断、或来自另一套 keystore 的备份，
    // 会在覆盖本地库之后才抛 GCM 错误 —— 那时本地数据已经没了。
    if (b.vault) {
      let payload: any;
      try {
        payload = JSON.parse(b.vault);
      } catch {
        throw new Error('备份内 vault 不是合法 JSON');
      }
      let plain: any;
      try {
        plain = this.decrypt(payload, key);
      } catch {
        // 口令已验证通过，解不开密文就是 SK 那半边不对（双因子备份）
        if (kdfVer === 2) throw new WrongSecretKeyError(`与末 4 位 ${ks.sk?.hint || '????'} 对不上（口令已验证正确）`);
        throw new Error('备份内 vault 无法解密：口令与备份不匹配');
      }
      if (!Array.isArray(plain?.assets)) throw new Error('备份内 vault 缺少 assets，拒绝导入');
    }
    // 覆盖前留一份本地副本，导错了还能手工回滚
    try {
      if (fs.existsSync(this.dataPath)) fs.copyFileSync(this.dataPath, this.dataPath + '.pre-import');
    } catch { /* 备份失败不阻塞，真正的防线是上面的试解 */ }
    if (b.vault) {
      fs.writeFileSync(this.dataPath, b.vault, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.dataPath, 0o600); } catch { /* ignore */ }
    }
    this.writeKeystore(ks);
    let wlCount = 0;
    // 仅当备份显式带了 whitelist 字段才覆盖（v1 兼容：缺字段 → 保留本机白名单）
    if ('whitelist' in b && b.whitelist != null) {
      if (!Array.isArray(b.whitelist)) throw new Error('备份内 whitelist 格式错误（应为数组）');
      fs.writeFileSync(path.join(this.dataDir, 'whitelist.json'), JSON.stringify(b.whitelist, null, 2));
      wlCount = b.whitelist.length;
    }
    if ('whitelistSchedule' in b && b.whitelistSchedule != null) {
      if (typeof b.whitelistSchedule !== 'object' || Array.isArray(b.whitelistSchedule)) {
        throw new Error('备份内 whitelistSchedule 格式错误');
      }
      fs.writeFileSync(
        path.join(this.dataDir, 'whitelist_schedule.json'),
        JSON.stringify(b.whitelistSchedule, null, 2)
      );
    }
    // 导入的库启用了 Secret Key：必须把 SK 落到本机，否则下次启动就打不开
    if (kdfVer === 2 && sk) this.writeSecretKeyFile(sk);
    else if (kdfVer === 1) this.deleteSecretKeyFile();
    this.key = key;
    this._locked = false;
    this.reload();
    return { imported: this.list().length, whitelist: wlCount };
  }

  // ===== Model B：代理注入访问 =====

  /** 为某资产签发短期代理令牌（默认 1 小时），真实密钥不进令牌，Agent 只拿到令牌 + 代理基址 */
  issueProxyToken(assetId: string, ttlSec = 3600): string {
    if (!this.assets.has(assetId)) throw new Error('资产不存在');
    return this.proxyMgr.issue(assetId, ttlSec);
  }

  /**
   * Model B SSH：为 server 资产签发短期令牌。
   * Agent: ssh -p <proxyPort> <token>@127.0.0.1 ；真实密码/私钥由本地 SSH 代理注入。
   */
  issueSshAccess(assetId: string, ttlSec = 3600): {
    proxyHost: string;
    proxyPort: number;
    token: string;
    ttl: number;
    targetHint: string;
    note: string;
  } {
    this.reload();
    const a = this.assets.get(assetId);
    if (!a) throw new Error('资产不存在');
    // server = 机器档案；ssh_key = SSH 登录。自带来主机地址的独立登录也可直接签发（内部会以自身凭证拨号）
    if (a.type !== 'server' && a.type !== 'ssh_key') {
      throw new Error('仅 server（机器档案，或其关联的 SSH 登录）与自带主机地址的 ssh_key（SSH 登录）支持 SSH 代理');
    }
    const dial = resolveSshTarget(this, a);
    const token = this.proxyMgr.issue(assetId, ttlSec);
    const proxyPort = Number(process.env.SSH_PROXY_PORT || 8789);
    this.audit('issue_ssh_access', { id: assetId, type: a.type, name: a.name, ttl: ttlSec });
    return {
      proxyHost: '127.0.0.1',
      proxyPort,
      token,
      ttl: ttlSec,
      targetHint: `${dial.username}@${dial.host}:${dial.port}`,
      note: '真实密钥由本地 SSH 代理注入；Agent 执行: ssh -o StrictHostKeyChecking=no -p <proxyPort> <token>@127.0.0.1',
    };
  }

  /** 代理服务用：解析令牌→返回对应资产（含真实密钥，仅服务端可见）；无效/过期返回 null */
  resolveProxyAsset(token: string): Asset | null {
    if (this.locked) return null;
    const assetId = this.proxyMgr.resolve(token);
    if (!assetId) return null;
    return this.assets.get(assetId) || null;
  }

  /** 记录一次代理访问（审计 Model B 使用） */
  logProxyAccess(assetId: string, sub: string): void {
    const a = this.assets.get(assetId);
    this.audit('proxy_access', { id: assetId, type: a?.type, name: a?.name, path: sub, model: 'B' });
  }

  /** 返回已过轮换周期、需要换密的资产（元数据，不含敏感字段） */
  dueForRotation(): Asset[] {
    this.reload();
    const now = Date.now();
    return [...this.assets.values()]
      .filter((a) => {
        if (!a.rotationReminderDays || !a.lastRotatedAt) return false;
        const due = new Date(a.lastRotatedAt).getTime() + a.rotationReminderDays * 86400000;
        return now >= due;
      })
      .map((a) => stripSecrets(a));
  }
}

export interface SecretKeyStatus {
  enabled: boolean;
  hint: string | null;
  enabledAt: string | null;
  rollbackUntil: string | null;
  rollbackAvailable: boolean;
  storedOnDevice: boolean;
  fingerprint: string | null;
}

/** 从可能带注释、分组的文本里找第一把合法 Secret Key（应急包 .txt 也能直接放进来） */
function firstValidSecretKey(text: string): string | null {
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = normalizeSecretKey(line);
    if (s && isValidSecretKey(s)) return s;
  }
  return null;
}

/**
 * 只读 keystore 判断双因子状态：不构造实例、不解锁。
 * 锁屏界面与「从未解锁」的进程都要能显示「本库需要 Secret Key」。
 */
export function peekSecretKeyStatus(dataDir: string): SecretKeyStatus {
  const empty: SecretKeyStatus = {
    enabled: false,
    hint: null,
    enabledAt: null,
    rollbackUntil: null,
    rollbackAvailable: false,
    storedOnDevice: false,
    fingerprint: null,
  };
  let stored: string | null = null;
  try {
    const skPath = path.join(dataDir, 'secret_key.txt');
    if (fs.existsSync(skPath)) stored = firstValidSecretKey(fs.readFileSync(skPath, 'utf8'));
  } catch {
    /* ignore */
  }
  let ks: any = null;
  try {
    ks = JSON.parse(fs.readFileSync(path.join(dataDir, 'keystore.json'), 'utf8'));
  } catch {
    return { ...empty, storedOnDevice: !!stored };
  }
  const fingerprint = crypto.createHash('sha256').update(String(ks?.salt || '')).digest('hex').slice(0, 8).toUpperCase();
  if (Number(ks.kdfVer) !== 2) return { ...empty, fingerprint, storedOnDevice: !!stored };
  const enabledAt = ks.sk?.enabledAt ? String(ks.sk.enabledAt) : null;
  const until = enabledAt ? new Date(enabledAt).getTime() + SK_ROLLBACK_MS : 0;
  return {
    enabled: true,
    hint: String(ks.sk?.hint || '') || null,
    enabledAt,
    rollbackUntil: until ? new Date(until).toISOString() : null,
    rollbackAvailable: until > 0 && Date.now() < until,
    storedOnDevice: !!stored,
    fingerprint,
  };
}

/** readdir 的容错版：目录读不出来就当空（审计轮转不该因为目录权限炸掉） */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
