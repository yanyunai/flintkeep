/**
 * 每日自动备份：把保险库加密文件与配套配置滚动复制到 data/backups/daily-YYYY-MM-DD/。
 * 全程只拷贝加密文件（vault.enc.json 本身就是密文），不需要解锁，也不产生明文。
 * 源文件均为原子写（tmp+rename），拷贝过程中不会读到半截内容。
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKUP_FILES = [
  'vault.enc.json',
  'keystore.json',
  'whitelist.json',
  'whitelist_schedule.json',
  'settings.json',
  'field_schema.json',
  'column_config.json',
  'field_catalog.json',
];

export class DailyBackup {
  private dir: string;

  constructor(private dataDir: string, private keep = 7) {
    this.dir = path.join(dataDir, 'backups');
  }

  private dayDir(now: Date): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return path.join(this.dir, `daily-${y}-${m}-${d}`);
  }

  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((n) => n.startsWith('daily-')).sort();
  }

  /**
   * 执行备份。返回备份目录与文件清单；返回 null 表示本次无需备份：
   * - 今天已备份且源 vault 文件没有比备份更新（无变动）
   * - 首次运行还没有 vault.enc.json 可备
   * 当天有变动时再次执行会刷新当天的备份目录（保留当日最终状态）。
   */
  run(now = new Date()): { dir: string; files: string[] } | null {
    const files = BACKUP_FILES.filter((f) => fs.existsSync(path.join(this.dataDir, f)));
    if (!files.includes('vault.enc.json')) return null;
    const srcVault = path.join(this.dataDir, 'vault.enc.json');
    const dest = this.dayDir(now);
    const destVault = path.join(dest, 'vault.enc.json');
    if (fs.existsSync(destVault) && fs.statSync(destVault).mtimeMs >= fs.statSync(srcVault).mtimeMs) {
      return null;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(this.dataDir, f), path.join(dest, f));
    this.prune();
    return { dir: dest, files };
  }

  /** 只保留最近 keep 天（按目录名排序，超出部分整目录删除） */
  private prune() {
    const days = this.list();
    for (const name of days.slice(0, Math.max(0, days.length - this.keep))) {
      fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
    }
  }
}
