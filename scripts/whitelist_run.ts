/**
 * 无界面执行白名单更新：供 Windows 任务计划程序 / cron 挂载（关掉界面也能跑）。
 *
 * 用法：
 *   set VAULT_PASSPHRASE=你的主口令
 *   npm run whitelist:run
 *
 * 说明：
 * - 密钥从保险库取，不写环境变量、不落盘；执行记录同样写入审计（action=whitelist_update）。
 * - IP 与上次相同则自动跳过云 API 调用，不会产生多余请求。
 * - 退出码：全部成功为 0，存在失败为 1（便于任务计划判断结果）。
 */
import { Vault } from '../src/core/vault';
import { WhitelistStore, runAll } from '../src/core/whitelist';

const DATA_DIR = process.env.VAULT_DATA_DIR || './data';
const pp = process.env.VAULT_PASSPHRASE || process.env.VAULT_MASTER_KEY;

if (!pp) {
  console.error('[whitelist:run] 缺少环境变量 VAULT_PASSPHRASE（用于解锁保险库）');
  process.exit(1);
}

let vault: Vault;
try {
  vault = new Vault(DATA_DIR, pp);
} catch (e) {
  console.error('[whitelist:run] 解锁失败:', (e as Error).message);
  process.exit(1);
}

const store = new WhitelistStore(DATA_DIR);
const results = await runAll(vault, store, {});

for (const r of results) {
  const mark = r.ok ? (r.skipped ? '⤼' : '✓') : '✗';
  console.log(`${mark} [${r.provider}] ${r.message}${r.ip ? `  (IP ${r.ip})` : ''}`);
}

const ok = results.filter((r) => r.ok && !r.skipped).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n完成：成功 ${ok} / 跳过 ${skipped} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
