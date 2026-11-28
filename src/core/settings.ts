/**
 * 应用设置（非敏感，明文 JSON 存储）：关闭窗口行为、自动锁定时长等。
 * 桌面端在锁定状态下也要能读到「关闭行为」，因此独立于保险库。
 */
import * as fs from 'fs';
import * as path from 'path';

export type CloseAction = 'background' | 'quit';
/** Agent 通过 MCP 可调用的工具范围；默认 normal，执行类工具另由 allowAgentExec 控制 */
export type AgentPermission = 'readonly' | 'normal' | 'full';
/** 界面语言：默认中文，可切英文 */
export type UiLang = 'zh-CN' | 'en-US';

export interface AppSettings {
  /** 关闭主窗口时：background=最小化到托盘继续运行（默认），quit=退出程序 */
  closeAction: CloseAction;
  /** 无操作多少分钟后自动锁定；0=不自动锁定。锁定只作用于本机界面，不中断独立运行的 MCP 进程 */
  autoLockMinutes: number;
  /** Agent 权限档位：readonly 只读元数据 / normal 可读+代跑腿 / full 不限制（不含执行类工具） */
  agentPermission: AgentPermission;
  /**
   * 锁屏后仍允许连接：false（默认）= 锁定即断开本机 API 写操作与 Agent 工具；
   * true = 保持旧行为，锁屏时页面/菜单栏仍能启停项目、Agent 仍可取用凭证。
   */
  allowLockedAccess: boolean;
  /**
   * 允许 Agent 执行本机命令：false（默认）= project_upsert / project_start / project_stop /
   * whitelist_sync / import_backup 一律拒绝；true = 允许，等同把本机命令执行权交给 Agent。
   */
  allowAgentExec: boolean;
  /** 允许代理把真实密钥注入后转发到 http:// 上游（默认 false，避免密钥明文出网） */
  proxyAllowHttp: boolean;
  /** 每日自动备份（加密库 + keystore + 白名单），默认开启 */
  dailyBackup: boolean;
  /**
   * MCP 下发完整工具集：false（默认）= 只给 9 个任务入口；
   * true = 连字段/类型/集合/project_upsert 等 27 个老工具一起下发（FLINTKEEP_MCP_PROFILE=full 等效）。
   */
  mcpFullTools: boolean;
  /**
   * 允许 Agent 看到密钥明文：false（默认）= 任何 MCP 工具都不返回密码/私钥/密钥字段，
   * show(reveal=true) 会被拒绝并给出替代路径；true = 允许，且该次读取写审计。
   * 与 mcpFullTools 正交——打开完整工具集也必须受本开关约束。
   * 终端取明文不受影响：fk show --reveal / fk env / fk inject。
   */
  agentExposeSecrets: boolean;
  /**
   * 本地 SSH agent：false（默认）= 不启动；
   * true = 解锁后在本机监听 agent.sock，`export SSH_AUTH_SOCK` 后 ssh/git 直接用库里的私钥。
   * 锁定即停止监听——agent 签名等价于「把私钥交给调用方」，不能比界面活得更久。
   */
  sshAgent: boolean;
  /** 审计单文件上限（MB）：超过即轮转到 .1；1–100，默认 5 */
  auditMaxMB: number;
  /** 审计历史保留代数（0–10，默认 3；0 = 不留历史） */
  auditKeepGenerations: number;
  /** 界面与后端消息语言；默认中文 */
  lang: UiLang;
}

export const DEFAULT_SETTINGS: AppSettings = {
  closeAction: 'background',
  autoLockMinutes: 15,
  agentPermission: 'normal',
  allowLockedAccess: false,
  allowAgentExec: false,
  proxyAllowHttp: false,
  dailyBackup: true,
  mcpFullTools: false,
  agentExposeSecrets: false,
  sshAgent: false,
  auditMaxMB: 5,
  auditKeepGenerations: 3,
  lang: 'zh-CN',
};

/** 非法值一律回退中文，避免手写 settings.json 把语言写坏 */
export function normalizeLang(v: unknown, fallback: UiLang = DEFAULT_SETTINGS.lang): UiLang {
  return v === 'en-US' || v === 'zh-CN' ? v : fallback;
}

const AGENT_PERMISSIONS: AgentPermission[] = ['readonly', 'normal', 'full'];
/** 非法值一律回退，避免手写 settings.json 或旧客户端把档位写成别的字符串 */
export function normalizeAgentPermission(
  v: unknown,
  fallback: AgentPermission = DEFAULT_SETTINGS.agentPermission
): AgentPermission {
  return AGENT_PERMISSIONS.includes(v as AgentPermission) ? (v as AgentPermission) : fallback;
}

/** 布尔开关：只接受 true/false；手写配置写坏时回落到默认值（安全项默认取 false） */
export function normalizeBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export class SettingsStore {
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  get(): AppSettings {
    if (!fs.existsSync(this.file)) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        closeAction: raw.closeAction === 'quit' ? 'quit' : 'background',
        autoLockMinutes: clampMinutes(raw.autoLockMinutes),
        agentPermission: normalizeAgentPermission(raw.agentPermission),
        allowLockedAccess: normalizeBool(raw.allowLockedAccess, DEFAULT_SETTINGS.allowLockedAccess),
        allowAgentExec: normalizeBool(raw.allowAgentExec, DEFAULT_SETTINGS.allowAgentExec),
        proxyAllowHttp: normalizeBool(raw.proxyAllowHttp, DEFAULT_SETTINGS.proxyAllowHttp),
        dailyBackup: normalizeBool(raw.dailyBackup, DEFAULT_SETTINGS.dailyBackup),
        mcpFullTools: normalizeBool(raw.mcpFullTools, DEFAULT_SETTINGS.mcpFullTools),
        agentExposeSecrets: normalizeBool(raw.agentExposeSecrets, DEFAULT_SETTINGS.agentExposeSecrets),
        sshAgent: normalizeBool(raw.sshAgent, DEFAULT_SETTINGS.sshAgent),
        auditMaxMB: clampRange(raw.auditMaxMB, 1, 100, DEFAULT_SETTINGS.auditMaxMB),
        auditKeepGenerations: clampRange(raw.auditKeepGenerations, 0, 10, DEFAULT_SETTINGS.auditKeepGenerations),
        lang: normalizeLang(raw.lang),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const cur = this.get();
    const next: AppSettings = {
      closeAction:
        patch.closeAction === 'quit' ? 'quit' : patch.closeAction === 'background' ? 'background' : cur.closeAction,
      autoLockMinutes: patch.autoLockMinutes === undefined ? cur.autoLockMinutes : clampMinutes(patch.autoLockMinutes),
      agentPermission: normalizeAgentPermission(patch.agentPermission, cur.agentPermission),
      allowLockedAccess: normalizeBool(patch.allowLockedAccess, cur.allowLockedAccess),
      allowAgentExec: normalizeBool(patch.allowAgentExec, cur.allowAgentExec),
      proxyAllowHttp: normalizeBool(patch.proxyAllowHttp, cur.proxyAllowHttp),
      dailyBackup: normalizeBool(patch.dailyBackup, cur.dailyBackup),
      mcpFullTools: normalizeBool(patch.mcpFullTools, cur.mcpFullTools),
      agentExposeSecrets: normalizeBool(patch.agentExposeSecrets, cur.agentExposeSecrets),
      sshAgent: normalizeBool(patch.sshAgent, cur.sshAgent),
      auditMaxMB:
        patch.auditMaxMB === undefined ? cur.auditMaxMB : clampRange(patch.auditMaxMB, 1, 100, cur.auditMaxMB),
      auditKeepGenerations:
        patch.auditKeepGenerations === undefined
          ? cur.auditKeepGenerations
          : clampRange(patch.auditKeepGenerations, 0, 10, cur.auditKeepGenerations),
      lang: normalizeLang(patch.lang, cur.lang),
    };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows 等平台忽略 */
    }
    return next;
  }
}

function clampRange(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function clampMinutes(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = 关闭自动锁定
  return Math.min(Math.floor(n), 24 * 60);
}
