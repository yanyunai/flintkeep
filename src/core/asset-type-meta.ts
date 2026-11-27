/**
 * 内置资产类型的默认分类与排序。
 *
 * 只放纯数据，不 import 任何 node 模块：后端（asset-types.ts）拿它生成类型定义，
 * 前端（App.vue）拿它算分组标题，两边看到的分组必须一致。
 *
 * category 存的是 key（project/cloud/account/other），展示走 categoryLabel() 跟随语言。
 */
export type BuiltinTypeMeta = { category: string; order: number };

export const BUILTIN_TYPE_META: Record<string, BuiltinTypeMeta> = {
  project: { category: 'project', order: 10 },
  server: { category: 'cloud', order: 20 },
  ssh_key: { category: 'cloud', order: 21 },
  cloud_account: { category: 'cloud', order: 22 },
  oss: { category: 'cloud', order: 23 },
  baota: { category: 'cloud', order: 24 },
  mcp: { category: 'cloud', order: 25 },
  api_key: { category: 'account', order: 40 },
  login_account: { category: 'account', order: 41 },
  email_account: { category: 'account', order: 42 },
  note: { category: 'other', order: 90 },
};
