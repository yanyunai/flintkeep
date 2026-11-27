/**
 * 资产类型定义：内置类型（schema.ts 的 TYPE_LABELS）+ 用户自定义类型。
 *
 * - 自定义类型只描述「叫什么、归哪个分类、什么颜色、排序」，字段由 field-schema 按 scope 挂上去；
 * - 资产本身仍存保险库，type 就是这里的 key，不存在第二份数据；
 * - 内置类型不可改名/删除（MCP、SSH、云签名等业务逻辑依赖它们的 key），但分类/颜色可展示。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TYPE_LABELS, typeLabel } from './schema';
import { DEFAULT_TYPE_COLORS } from './field-catalog';
import { BUILTIN_TYPE_META } from './asset-type-meta';

export type AssetTypeDef = {
  key: string;
  label: string;
  category: string;
  color?: string;
  order: number;
  builtin: boolean;
};

export type AssetTypeInput = {
  label?: string;
  category?: string;
  color?: string;
  order?: number;
};

type AssetTypeFile = {
  version: 1;
  types: { key: string; label: string; category: string; color?: string; order: number }[];
};

/**
 * 内置类型的默认分类与排序（决定顶部 tab 的分组与先后）。
 * 数据在 asset-type-meta.ts（前端也要用，不能带 node 依赖）；
 * category 存的是 key，展示时走 categoryLabel() 跟随语言，
 * 用户自定义类型仍存自由文本，categoryLabel() 找不到 key 会原样返回。
 */
const BUILTIN_META = BUILTIN_TYPE_META;

const MAX_CUSTOM_TYPES = 30;

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

export class AssetTypeStore {
  private file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'asset_types.json');
  }

  private readRaw(): AssetTypeFile {
    if (!fs.existsSync(this.file)) return { version: 1, types: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AssetTypeFile;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.types)) return { version: 1, types: [] };
      return raw;
    } catch {
      return { version: 1, types: [] };
    }
  }

  private writeRaw(data: AssetTypeFile) {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  /** 内置 + 自定义，按分类顺序 → order 排序 */
  list(): AssetTypeDef[] {
    const builtin: AssetTypeDef[] = Object.entries(TYPE_LABELS).map(([key]) => {
      const meta = BUILTIN_META[key] || { category: 'other', order: 900 };
      return {
        key,
        label: typeLabel(key),
        category: meta.category,
        color: DEFAULT_TYPE_COLORS[key],
        order: meta.order,
        builtin: true,
      };
    });
    const custom: AssetTypeDef[] = this.readRaw().types.map((t) => ({
      key: t.key,
      label: t.label,
      category: t.category || 'custom',
      color: t.color,
      order: t.order ?? 100,
      builtin: false,
    }));
    return [...builtin, ...custom].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }

  /** 类型 key → 中文名（兼容旧 /api/types 的 Record 形状） */
  labels(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of this.list()) out[t.key] = t.label;
    return out;
  }

  /** 中文名/别名 → key，供 Agent 传中文类型时归一化（含自定义类型） */
  aliases(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of this.list()) {
      out[t.key.toLowerCase()] = t.key;
      out[t.label.toLowerCase()] = t.key;
    }
    return out;
  }

  categories(): string[] {
    const seen = new Set<string>();
    for (const t of this.list()) if (t.category) seen.add(t.category);
    return [...seen];
  }

  /** 自定义类型可用的 scope 集合（内置 + 自定义），供字段定义校验 */
  scopes(): Set<string> {
    return new Set(this.list().map((t) => t.key));
  }

  create(input: AssetTypeInput): AssetTypeDef {
    const raw = this.readRaw();
    if (raw.types.length >= MAX_CUSTOM_TYPES) throw new Error(`自定义类型最多 ${MAX_CUSTOM_TYPES} 个`);
    const label = str(input.label, 20);
    if (!label) throw new Error('请填写类型名称');
    const allLabels = new Set(Object.values(TYPE_LABELS).map((s) => s.toLowerCase()));
    for (const t of raw.types) allLabels.add(t.label.toLowerCase());
    if (allLabels.has(label.toLowerCase())) throw new Error(`类型「${label}」已存在`);

    const category = str(input.category, 20) || 'custom';
    const color = this.normalizeColor(input.color);
    const maxOrder = Math.max(99, ...raw.types.map((t) => t.order ?? 100));
    const one = {
      key: 'ct_' + crypto.randomBytes(4).toString('hex'),
      label,
      category,
      color,
      order: Number.isFinite(Number(input.order)) ? Number(input.order) : maxOrder + 10,
    };
    raw.types.push(one);
    raw.version = 1;
    this.writeRaw(raw);
    return { ...one, builtin: false };
  }

  update(key: string, patch: AssetTypeInput): AssetTypeDef {
    const raw = this.readRaw();
    const idx = raw.types.findIndex((t) => t.key === key);
    if (idx < 0) throw new Error('内置类型不可修改，或类型不存在');
    const cur = raw.types[idx];
    if (patch.label !== undefined) {
      const label = str(patch.label, 20);
      if (!label) throw new Error('请填写类型名称');
      const dup = this.list().some((t) => t.key !== key && t.label.toLowerCase() === label.toLowerCase());
      if (dup) throw new Error(`类型「${label}」已存在`);
      cur.label = label;
    }
    if (patch.category !== undefined) cur.category = str(patch.category, 20) || 'custom';
    if (patch.color !== undefined) cur.color = this.normalizeColor(patch.color);
    if (patch.order !== undefined && Number.isFinite(Number(patch.order))) cur.order = Number(patch.order);
    raw.version = 1;
    this.writeRaw(raw);
    return { ...cur, builtin: false };
  }

  /** 只允许删除自定义类型；资产占用检查由调用方（server）负责 */
  remove(key: string): boolean {
    const raw = this.readRaw();
    const before = raw.types.length;
    raw.types = raw.types.filter((t) => t.key !== key);
    if (raw.types.length === before) return false;
    raw.version = 1;
    this.writeRaw(raw);
    return true;
  }

  private normalizeColor(v: unknown): string | undefined {
    const s = str(v, 9);
    if (!s) return undefined;
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new Error(`颜色需为 #rrggbb 格式：${s}`);
    return s.toLowerCase();
  }
}
