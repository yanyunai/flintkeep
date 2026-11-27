import { common } from './common';
import { shell } from './shell';
import { meta } from './meta';
import { views } from './views';
import type { Dict } from '../types';

/**
 * 英文总表：类型标注为 Dict，缺 key 或 key 拼错时 vue-tsc 会报错。
 * （vite build 不走类型检查，所以另有 scripts/check-i18n.mjs 兜底）
 */
export const en: Dict = {
  ...common,
  ...shell,
  ...meta,
  ...views,
};
