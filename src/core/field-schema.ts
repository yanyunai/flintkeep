/**
 * 字段定义存储：内置字段的「改名 / 显隐 / 顺序」覆盖 + 用户自定义字段。
 *
 * - 内置字段本身仍在 builtin-fields.ts 里声明（key 与 Asset 字段一一对应，业务逻辑依赖）；
 *   这里只存用户改动的覆盖项，key 不可改。
 * - 自定义字段值落在 Asset.extra[key]，不参与任何业务逻辑，只用于展示/搜索/导出。
 * - 文件：data/field_schema.json（加密库外，纯配置，不含密钥）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_FIELDS, FIELD_KINDS, isKnownBuiltin, type FieldKind } from './builtin-fields';

export type CustomField = {
  /** 自动生成，创建后不可改，如 cf_a1b2c3d4 */
  key: string;
  label: string;
  /** 资产类型（server/ssh_key/...）或 '*' 表示所有类型 */
  scope: string;
  kind: FieldKind;
  secret?: boolean;
  options?: string[];
  /** 是否出现在列配置候选中 */
  list: boolean;
  /** 是否出现在新增/编辑表单中 */
  form: boolean;
  width?: number;
  hint?: string;
  order?: number;
};

export type FieldOverride = {
  label?: string;
  list?: boolean;
  form?: boolean;
  width?: number;
  order?: number;
};

export type FieldSchema = {
  version: 1;
  /** scope -> 内置字段 key -> 覆盖项 */
  overrides: Record<string, Record<string, FieldOverride>>;
  custom: CustomField[];
  /** 曾声明为敏感的自定义字段 key：字段被删后仍继续脱敏，避免旧值明文暴露 */
  secretRetired?: string[];
};

export type FieldSchemaInput = {
  overrides?: Record<string, Record<string, FieldOverride>>;
  custom?: Partial<CustomField>[];
};

const MAX_CUSTOM = 100;

function emptySchema(): FieldSchema {
  return { version: 1, overrides: {}, custom: [] };
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

function num(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 所有内置 key（跨类型的并集）：自定义字段禁止同名，避免混淆 */
const ALL_BUILTIN_KEYS = new Set<string>();
for (const fields of Object.values(BUILTIN_FIELDS)) {
  for (const f of fields) ALL_BUILTIN_KEYS.add(f.key);
}

export function emptyFieldSchema(): FieldSchema {
  return emptySchema();
}

/** 从原始输入里读出自定义字段的敏感 key（供 vault 脱敏，不依赖 store 实例） */
export function loadCustomSecretKeys(dataDir: string): Set<string> {
  const out = new Set<string>();
  const file = path.join(dataDir, 'field_schema.json');
  try {
    if (!fs.existsSync(file)) return out;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const f of Array.isArray(raw?.custom) ? raw.custom : []) {
      if (f && f.secret && typeof f.key === 'string') out.add(f.key);
    }
    for (const k of Array.isArray(raw?.secretRetired) ? raw.secretRetired : []) {
      if (typeof k === 'string') out.add(k);
    }
  } catch {
    /* 配置损坏时按无敏感自定义字段处理 */
  }
  return out;
}

export class FieldSchemaStore {
  private file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'field_schema.json');
  }

  private readRaw(): FieldSchema {
    if (!fs.existsSync(this.file)) return emptySchema();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as FieldSchema;
      if (!raw || raw.version !== 1 || typeof raw.overrides !== 'object' || !Array.isArray(raw.custom)) {
        return emptySchema();
      }
      return {
        version: 1,
        overrides: raw.overrides || {},
        custom: raw.custom,
        secretRetired: Array.isArray(raw.secretRetired) ? raw.secretRetired : [],
      };
    } catch {
      return emptySchema();
    }
  }

  private writeRaw(data: FieldSchema) {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  get(): FieldSchema {
    const raw = this.readRaw();
    return {
      version: 1,
      overrides: { ...raw.overrides },
      custom: raw.custom.map((f) => ({ ...f })),
      secretRetired: [...(raw.secretRetired || [])],
    };
  }

  /** 全量保存：前端提交完整 schema；校验失败直接抛错，不落盘 */
  save(input: FieldSchemaInput, opts: { scopes?: Set<string> } = {}): FieldSchema {
    const raw = this.readRaw();
    const validScopes = new Set<string>(['*', ...Object.keys(BUILTIN_FIELDS)]);
    for (const s of opts.scopes || []) validScopes.add(s);
    const overrides = this.normalizeOverrides(input?.overrides);
    const custom = this.normalizeCustom(input?.custom, raw.custom, validScopes);
    // 曾经敏感的自定义字段即使被删除，也继续脱敏（旧数据可能还在 extra 里）
    const retired = new Set(raw.secretRetired || []);
    for (const f of raw.custom) if (f.secret) retired.add(f.key);
    for (const f of custom) if (f.secret) retired.add(f.key);
    const next: FieldSchema = { version: 1, overrides, custom, secretRetired: [...retired] };
    this.writeRaw(next);
    return next;
  }

  private normalizeOverrides(input: unknown): Record<string, Record<string, FieldOverride>> {
    const out: Record<string, Record<string, FieldOverride>> = {};
    if (!input || typeof input !== 'object') return out;
    for (const [scope, patch] of Object.entries(input as Record<string, any>)) {
      if (!BUILTIN_FIELDS[scope] || !patch || typeof patch !== 'object') continue;
      for (const [key, val] of Object.entries(patch as Record<string, any>)) {
        if (!isKnownBuiltin(scope, key) || !val || typeof val !== 'object') continue;
        const one: FieldOverride = {};
        const label = str((val as any).label, 30);
        if (label) one.label = label;
        if (typeof (val as any).list === 'boolean') one.list = (val as any).list;
        if (typeof (val as any).form === 'boolean') one.form = (val as any).form;
        const width = num((val as any).width, 4, 60);
        if (width !== undefined) one.width = width;
        const order = num((val as any).order, 0, 9999);
        if (order !== undefined) one.order = order;
        if (Object.keys(one).length) {
          out[scope] = out[scope] || {};
          out[scope][key] = one;
        }
      }
    }
    return out;
  }

  private normalizeCustom(input: unknown, existing: CustomField[], validScopes: Set<string>): CustomField[] {
    if (!Array.isArray(input)) return existing;
    if (input.length > MAX_CUSTOM) throw new Error(`自定义字段最多 ${MAX_CUSTOM} 个`);
    const seen = new Set<string>();
    const out: CustomField[] = [];
    for (const item of input as Partial<CustomField>[]) {
      if (!item || typeof item !== 'object') continue;
      const label = str(item.label, 30);
      if (!label) throw new Error('自定义字段需要名称');
      const scope = str(item.scope, 30) || '*';
      if (!validScopes.has(scope)) throw new Error(`未知的资产类型：${scope}`);
      const kind = str(item.kind, 20) as FieldKind;
      if (!FIELD_KINDS.includes(kind)) throw new Error(`未知的字段类型：${kind}`);

      let key = str(item.key, 40);
      if (!key) key = 'cf_' + crypto.randomBytes(4).toString('hex');
      if (!/^[a-z][a-z0-9_]{2,32}$/.test(key)) throw new Error(`字段标识不合法：${key}`);
      if (seen.has(key)) throw new Error(`字段标识重复：${key}`);
      if (ALL_BUILTIN_KEYS.has(key)) throw new Error(`字段标识与内置字段冲突：${key}`);
      seen.add(key);

      let options: string[] | undefined;
      if (kind === 'select') {
        const list = Array.isArray(item.options) ? item.options : [];
        const dedup: string[] = [];
        for (const o of list) {
          const s = str(o, 40);
          if (s && !dedup.includes(s)) dedup.push(s);
        }
        if (!dedup.length) throw new Error(`「${label}」是下拉字段，至少需要一个选项`);
        options = dedup.slice(0, 50);
      }

      const one: CustomField = {
        key,
        label,
        scope,
        kind,
        list: bool(item.list, true),
        form: bool(item.form, true),
      };
      if (item.secret) one.secret = true;
      if (options) one.options = options;
      const width = num(item.width, 4, 60);
      if (width !== undefined) one.width = width;
      const hint = str(item.hint, 120);
      if (hint) one.hint = hint;
      const order = num(item.order, 0, 9999);
      if (order !== undefined) one.order = order;
      out.push(one);
    }
    return out;
  }

  /** 删除某个资产类型时，一并清掉挂在它下面的字段定义与覆盖项 */
  removeScope(scope: string): FieldSchema {
    const raw = this.readRaw();
    const retired = new Set(raw.secretRetired || []);
    for (const f of raw.custom) {
      if (f.scope === scope && f.secret) retired.add(f.key);
    }
    const overrides = { ...raw.overrides };
    delete overrides[scope];
    const next: FieldSchema = {
      version: 1,
      overrides,
      custom: raw.custom.filter((f) => f.scope !== scope),
      secretRetired: [...retired],
    };
    this.writeRaw(next);
    return next;
  }

  /** 自定义敏感字段 key 集合（供列表脱敏） */
  customSecretKeys(): Set<string> {
    return new Set(this.readRaw().custom.filter((f) => f.secret).map((f) => f.key));
  }
}
