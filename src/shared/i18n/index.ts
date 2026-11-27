/**
 * i18n 统一出口。
 *
 * 前端：import { t, setLang, getLang } from '../../shared/i18n'
 * 后端：import { t, setLang } from './src/shared/i18n'
 *
 * 前端要做响应式请用 src/renderer/ui/i18n.ts 里的 useT()。
 */
export { t, setLang, getLang, subscribeLang, hasKey, nf, df } from './runtime';
export { LANGS, LANG_LABEL } from './types';
export type { Lang, MsgKey, Vars, Dict } from './types';
