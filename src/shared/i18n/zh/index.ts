import { common } from './common';
import { shell } from './shell';
import { meta } from './meta';
import { views } from './views';

/** 中文总表：新增域时在这里合并 */
export const zh = {
  ...common,
  ...shell,
  ...meta,
  ...views,
};
