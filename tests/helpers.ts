import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 测试用主口令（全部测试数据均为伪造值，不含任何真实凭据） */
export const PP = 'test-passphrase-123';

/** 每个用例独占的数据目录：互不干扰，失败后也方便直接看现场 */
export function tmpDir(prefix = 'flintkeep-test-'): string {
  const dir = path.join(os.tmpdir(), prefix + Math.random().toString(36).slice(2) + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 目录用完就删：CI 里跑几百个用例，不清会攒出上万个临时目录 */
export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 造一条"旧"时间戳，用于轮换提醒这类依赖时间的断言 */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

export { crypto };