/**
 * i18n 类型（只做类型，不产生运行时代码，避免 zh ↔ runtime 循环依赖）。
 */
import type { zh } from './zh';

export type Lang = 'zh-CN' | 'en-US';
export const LANGS: Lang[] = ['zh-CN', 'en-US'];

/** 所有文案 key 的联合类型：写错 key 编译期报错 */
export type MsgKey = keyof typeof zh;

/** 插值变量 */
export type Vars = Record<string, string | number>;

/** 完整字典：en 必须覆盖 zh 的每一个 key */
export type Dict = Record<MsgKey, string>;

export const LANG_LABEL: Record<Lang, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};
