/**
 * 前端字段注册表：把「内置字段默认定义 + 用户覆盖 + 自定义字段」合成
 * 列配置与新增/编辑表单需要的形状。App.vue 只消费这里的结果，不再写死列/表单。
 */
import { BUILTIN_FIELDS, defaultColumns, type BuiltinField } from '../core/builtin-fields';
import { fieldNameLabel } from '../core/schema';
import { t, hasKey, type MsgKey } from '../shared/i18n';
import type { CustomField, FieldOverride, FieldSchema } from '../core/field-schema';

/** 内置字段的提示存的是 i18n key，这里翻成当前语言 */
function hintOf(f: BuiltinField): string | undefined {
  if (!f.hint) return undefined;
  return hasKey(f.hint) ? t(f.hint as MsgKey) : f.hint;
}

export type UiColumn = {
  key: string;
  label: string;
  get: (a: any) => any;
  mono?: boolean;
};

export type UiFormField = {
  /** 表单里 v-model 的 key；自定义字段带 extra: 前缀 */
  k: string;
  label: string;
  hint?: string;
  secret?: boolean;
  select?: string[];
  textarea?: boolean;
  num?: boolean;
  /** 日期（input[type=date]），值统一 YYYY-MM-DD */
  date?: boolean;
  ports?: boolean;
  args?: boolean;
  json?: boolean;
  full?: boolean;
  span2?: boolean;
  narrow?: boolean;
  catalogKey?: string;
  /** 非空表示该字段要写进 asset.extra[extraKey] */
  extraKey?: string;
};

function overrideOf(schema: FieldSchema | null | undefined, scope: string, key: string): FieldOverride {
  return schema?.overrides?.[scope]?.[key] || {};
}

function sortCustom(fields: CustomField[]): CustomField[] {
  return [...fields].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
}

/** 某个类型可选的列（内置在前，自定义在后） */
export function columnPool(scope: string, schema: FieldSchema | null | undefined): UiColumn[] {
  const builtin: UiColumn[] = (BUILTIN_FIELDS[scope] || [])
    .filter((f) => overrideOf(schema, scope, f.key).list !== false)
    .map((f) => {
      const ov = overrideOf(schema, scope, f.key);
      return {
        key: f.key,
        // 用户改过名就用用户的；否则跟界面语言走（f.label 只作兜底）
        label: ov.label || fieldNameLabel(f.key, { [f.key]: f.label }),
        get: f.get || ((a: any) => a?.[f.key]),
        mono: f.mono,
      };
    });

  const custom: UiColumn[] = sortCustom(
    (schema?.custom || []).filter((f) => (f.scope === scope || f.scope === '*') && f.list)
  ).map((f) => ({
    key: f.key,
    label: f.label,
    get: (a: any) => {
      const v = a?.extra?.[f.key];
      return Array.isArray(v) ? v.join(',') : v;
    },
  }));

  return [...builtin, ...custom];
}

/** 用户没配置列时的默认列：内置默认 + 自定义字段（list=true） */
export function defaultColumnKeys(scope: string, schema: FieldSchema | null | undefined): string[] {
  const ovs = schema?.overrides?.[scope] || {};
  const builtin = defaultColumns(scope).filter((k) => ovs[k]?.list !== false);
  const custom = sortCustom(
    (schema?.custom || []).filter((f) => (f.scope === scope || f.scope === '*') && f.list)
  ).map((f) => f.key);
  return [...builtin, ...custom];
}

function toUiForm(f: BuiltinField, label: string): UiFormField {
  return {
    k: f.key,
    label,
    hint: hintOf(f),
    secret: !!f.secret || f.kind === 'password',
    select: f.kind === 'select' ? f.options || [] : undefined,
    textarea: f.kind === 'textarea',
    num: f.kind === 'number',
    date: f.kind === 'date',
    ports: f.kind === 'ports',
    // tags 用逗号分隔的输入，提交时按数组处理（与 args 同一套转换）
    args: f.transform === 'args' || f.kind === 'tags',
    json: f.transform === 'json',
    full: f.full,
    span2: f.span2,
    narrow: f.narrow,
    catalogKey: f.catalogKey,
  };
}

function toCustomForm(f: CustomField): UiFormField {
  return {
    k: 'extra:' + f.key,
    extraKey: f.key,
    label: f.label,
    hint: f.hint,
    secret: !!f.secret || f.kind === 'password',
    select: f.kind === 'select' ? f.options || [] : undefined,
    textarea: f.kind === 'textarea',
    num: f.kind === 'number',
    date: f.kind === 'date',
    ports: f.kind === 'ports',
    full: f.kind === 'textarea',
  };
}

/** 某个类型的新增/编辑表单字段（不含 PROXY_FIELDS，由 App.vue 追加） */
export function formFieldsFor(scope: string, schema: FieldSchema | null | undefined): UiFormField[] {
  const builtin = (BUILTIN_FIELDS[scope] || [])
    .filter((f) => {
      if (f.formDefault === false) return false;
      return overrideOf(schema, scope, f.key).form !== false;
    })
    .map((f) => toUiForm(f, overrideOf(schema, scope, f.key).label || fieldNameLabel(f.key, { [f.key]: f.label })));

  const custom = sortCustom(
    (schema?.custom || []).filter((f) => (f.scope === scope || f.scope === '*') && f.form)
  ).map((f) => toCustomForm(f));

  return [...builtin, ...custom];
}

/** 从资产对象里取自定义字段值（编辑回填用） */
export function customFormValue(asset: any, extraKey: string): any {
  const v = asset?.extra?.[extraKey];
  return Array.isArray(v) ? v.join(',') : v ?? '';
}

/** 自定义字段 label（详情页/审计文案用） */
export function customFieldLabel(schema: FieldSchema | null | undefined, key: string): string | undefined {
  return (schema?.custom || []).find((f) => f.key === key)?.label;
}

export function isCustomSecret(schema: FieldSchema | null | undefined, key: string): boolean {
  return !!(schema?.custom || []).find((f) => f.key === key)?.secret;
}
