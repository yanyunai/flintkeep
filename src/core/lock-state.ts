/**
 * 保险库锁定状态（跨进程共享）。
 *
 * 为什么需要这个文件：桌面端（REST）与 MCP 是两个进程，MCP 持有自己的口令，
 * 光靠内存里的 `vault.locked` 挡不住它。把锁定状态落成一个极小的状态文件后：
 * - 桌面端在启动 / 解锁 / 锁定时写；
 * - MCP 每次工具调用前读，配合设置里的 allowLockedAccess 决定是否放行。
 *
 * 只有布尔与时间戳，不含任何秘密；写入用 tmp + rename，读失败按「未锁定」处理
 * （MCP 可能在没有桌面端的情况下独立使用，不能因为缺文件就整体拒绝）。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface LockState {
  locked: boolean;
  /** 最近一次状态变更时间（ISO） */
  at: string;
}

export function lockStatePath(dataDir: string): string {
  return path.join(dataDir, 'lock_state.json');
}

export function writeLockState(dataDir: string, locked: boolean): void {
  try {
    const file = lockStatePath(dataDir);
    const tmp = file + '.tmp';
    const body: LockState = { locked, at: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* 状态文件写失败不应阻塞解锁/锁定主流程 */
  }
}

export function readLockState(dataDir: string): LockState | null {
  try {
    return JSON.parse(fs.readFileSync(lockStatePath(dataDir), 'utf8')) as LockState;
  } catch {
    return null;
  }
}

/**
 * 锁定态且未允许「锁屏后仍连接」时，返回给 Agent 看的拒绝原因；放行返回 null。
 * 单独抽出来是为了 REST / MCP 用同一套文案，不出现两处说法不一致。
 */
export function lockedBlockReason(dataDir: string, allowLockedAccess: boolean): string | null {
  if (allowLockedAccess) return null;
  const s = readLockState(dataDir);
  if (!s?.locked) return null;
  return `保险库已锁定（${s.at}）：当前「设置 → 后台与锁定 → 锁屏后仍允许连接」为关闭状态，Agent 工具暂不可用。请在桌面端解锁，或在设置里打开该开关。`;
}