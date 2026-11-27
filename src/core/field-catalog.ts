import * as fs from 'fs';
import * as path from 'path';
import { FIELD_DEFS, type FieldDef } from './field-catalog-defs';

export type { FieldDef };
export { FIELD_DEFS };

export type CatalogFieldState = {
  kind: 'enum';
  options: string[];
  allowCustom: boolean;
};

export type FieldCatalogFile = {
  version: 1;
  fields: Record<string, CatalogFieldState>;
  /** 资产类型标签颜色，键为 AssetType，值为 #rrggbb */
  typeColors?: Record<string, string>;
};

/** API / 前端使用的合并视图 */
export type CatalogFieldView = FieldDef & {
  options: string[];
};

const DEF_BY_KEY = new Map(FIELD_DEFS.map((d) => [d.key, d]));

function normalizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function defaultFile(): FieldCatalogFile {
  const fields: Record<string, CatalogFieldState> = {};
  for (const d of FIELD_DEFS) {
    fields[d.key] = {
      kind: 'enum',
      options: [...d.defaultOptions],
      allowCustom: d.allowCustom,
    };
  }
  return { version: 1, fields, typeColors: { ...DEFAULT_TYPE_COLORS } };
}

/** 各资产类型标签的默认颜色（与前端 CSS 兜底一致） */
export const DEFAULT_TYPE_COLORS: Record<string, string> = {
  server: '#ddf4ff',
  ssh_key: '#dafbe1',
  cloud_account: '#fbefff',
  oss: '#ffeff7',
  baota: '#fff1e5',
  mcp: '#e0f7fa',
  api_key: '#fff8c5',
  login_account: '#ffebe9',
  note: '#f6f8fa',
};

export class FieldCatalogStore {
  private file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'field_catalog.json');
  }

  private readRaw(): FieldCatalogFile {
    if (!fs.existsSync(this.file)) {
      const init = defaultFile();
      this.writeRaw(init);
      return init;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as FieldCatalogFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.fields !== 'object') {
        return defaultFile();
      }
      return parsed;
    } catch {
      return defaultFile();
    }
  }

  private writeRaw(data: FieldCatalogFile) {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  /** 合并注册表元数据 + 用户 options */
  list(): CatalogFieldView[] {
    const raw = this.readRaw();
    return FIELD_DEFS.map((d) => {
      const saved = raw.fields[d.key];
      const options = saved?.options?.length
        ? normalizeOptions(saved.options)
        : [...d.defaultOptions];
      return {
        ...d,
        options,
        allowCustom: saved?.allowCustom ?? d.allowCustom,
      };
    });
  }

  getOptions(key: string): string[] {
    const row = this.list().find((f) => f.key === key);
    return row ? [...row.options] : [];
  }

  /** 类型标签颜色（缺省回落到内置默认色） */
  getTypeColors(): Record<string, string> {
    const raw = this.readRaw();
    return { ...DEFAULT_TYPE_COLORS, ...(raw.typeColors || {}) };
  }

  /** 更新类型颜色：值为 null/空 表示恢复默认 */
  updateTypeColors(patch: Record<string, string | null | undefined>): Record<string, string> {
    const raw = this.readRaw();
    const cur: Record<string, string> = { ...(raw.typeColors || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined || String(v).trim() === '') {
        delete cur[k];
        continue;
      }
      const s = String(v).trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new Error(`颜色需为 #rrggbb 格式：${s}`);
      cur[k] = s.toLowerCase();
    }
    raw.typeColors = cur;
    raw.version = 1;
    this.writeRaw(raw);
    return { ...DEFAULT_TYPE_COLORS, ...cur };
  }

  /**
   * 更新单个或若干字段的 options。
   * body: { fields: { [key]: { options: string[], allowCustom?: boolean } } }
   */
  update(patch: { fields?: Record<string, { options?: unknown; allowCustom?: boolean }> }): CatalogFieldView[] {
    const raw = this.readRaw();
    const incoming = patch.fields || {};
    for (const [key, val] of Object.entries(incoming)) {
      const def = DEF_BY_KEY.get(key);
      if (!def) throw new Error(`未知或不可配置字段：${key}`);
      const options = normalizeOptions(val?.options);
      if (!options.length) throw new Error(`${def.fieldLabel}：请至少保留一个选项`);
      raw.fields[key] = {
        kind: 'enum',
        options,
        allowCustom: typeof val?.allowCustom === 'boolean' ? val.allowCustom : def.allowCustom,
      };
    }
    // 确保注册表中的 key 都有条目
    for (const d of FIELD_DEFS) {
      if (!raw.fields[d.key]) {
        raw.fields[d.key] = {
          kind: 'enum',
          options: [...d.defaultOptions],
          allowCustom: d.allowCustom,
        };
      }
    }
    raw.version = 1;
    this.writeRaw(raw);
    return this.list();
  }
}
