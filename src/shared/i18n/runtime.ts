/**
 * 极简 i18n 运行时 —— 前端、后端（server.ts）、MCP 进程共用同一份。
 *
 * 为什么不用 vue-i18n：
 *   1. 只有 Electron 单机，无 SSR、无按路由懒加载语言包；
 *   2. 需要的能力只有「查表 + 插值 + 简单复数」，vue-i18n 其余能力用不上；
 *   3. 后端要复用同一份字典，前端框架的包后端引不了。
 *
 * 约定：
 *   - 字典 key 形如 `assets.field.publicIp`，绝不用中文当 key；
 *   - 复数写成 `"{n} item | {n} items"`，中文一般不写复数形式；
 *   - 插值写 `{name}`，运行时按 vars 替换，缺变量保留原样（便于排查）。
 */
import { zh } from './zh';
import { en } from './en';
import type { Dict, Lang, MsgKey, Vars } from './types';

const DICTS: Record<Lang, Dict> = {
  'zh-CN': zh as Dict,
  'en-US': en as Dict,
};

let current: Lang = 'zh-CN';
const subscribers = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return current;
}

/** 切换语言：只改运行时状态并通知订阅者，不做持久化（持久化由调用方负责） */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  for (const fn of subscribers) {
    try {
      fn(lang);
    } catch {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  }
}

/** 订阅语言变化（后端用来重载提示词等），返回取消订阅函数 */
export function subscribeLang(fn: (lang: Lang) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 复数：`"{n} file | {n} files"`，按当前语言的 PluralRules 选段 */
function pickPlural(text: string, vars?: Vars): string {
  const parts = text.split(' | ');
  if (parts.length < 2) return text;
  const raw = vars?.n ?? vars?.count ?? 0;
  const n = Number(raw);
  let index = 0;
  try {
    index = new Intl.PluralRules(current).select(Number.isFinite(n) ? n : 0) === 'one' ? 0 : 1;
  } catch {
    index = n === 1 ? 0 : 1;
  }
  return parts[Math.min(index, parts.length - 1)];
}

/** 字典里没有的 key 直接回显 key，方便一眼看出漏翻 */
export function t(key: MsgKey, vars?: Vars): string {
  const table = DICTS[current] || DICTS['zh-CN'];
  let text = table[key] ?? DICTS['zh-CN'][key] ?? key;
  if (text.includes(' | ')) text = pickPlural(text, vars);
  if (vars) text = text.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
  return text;
}

/** 是否有某个 key（脚本/后端宽松场景用） */
export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DICTS['zh-CN'], key);
}

/** 数字按当前语言格式化（千分位、小数位） */
export function nf(n: number, opts?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(current, opts).format(n);
  } catch {
    return String(n);
  }
}

/** 日期按当前语言格式化 */
export function df(value: Date | number | string, opts?: Intl.DateTimeFormatOptions): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(current, opts).format(d);
  } catch {
    return d.toLocaleString();
  }
}
