import * as fs from 'fs';
import * as path from 'path';

/**
 * 资产清单「列配置」：每个资产类型(tab)独立选择要显示的字段。
 * 只存字段 key 列表，不存任何数据；缺省时前端用内置默认列。
 */
export type ColumnConfigFile = {
  version: 1;
  /** key = AssetType，value = 该类型要显示的字段 key 列表（有序） */
  columns: Record<string, string[]>;
};

const MAX_COLS = 20; // 字段可自定义后列会变多；表格已支持横向滚动

export class ColumnConfigStore {
  private file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'column_config.json');
  }

  private read(): ColumnConfigFile {
    if (!fs.existsSync(this.file)) return { version: 1, columns: {} };
    try {
      const p = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ColumnConfigFile;
      if (!p || p.version !== 1 || typeof p.columns !== 'object' || !p.columns) {
        return { version: 1, columns: {} };
      }
      return p;
    } catch {
      return { version: 1, columns: {} };
    }
  }

  private write(data: ColumnConfigFile) {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  list(): Record<string, string[]> {
    return this.read().columns;
  }

  /** 设置某类型的列；空数组表示恢复默认 */
  set(type: string, keys: string[]): Record<string, string[]> {
    const raw = this.read();
    const clean = (Array.isArray(keys) ? keys : [])
      .map((k) => String(k ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_COLS);
    if (!clean.length) delete raw.columns[type];
    else raw.columns[type] = clean;
    raw.version = 1;
    this.write(raw);
    return raw.columns;
  }
}

export { MAX_COLS };
