/**
 * 前端 i18n 桥：把 shared/i18n 的纯运行时接到 Vue 响应式上。
 *
 * - 默认中文；切换后写 localStorage（首屏不闪）+ PUT /api/settings（跨重启保持）
 * - 组件里用：const t = useT()，模板里 t('shell.nav.assets')
 */
import { ref, watch } from 'vue';
import { t as rawT, setLang as rawSetLang, type Lang, type MsgKey, type Vars } from '../../shared/i18n';

const KEY = 'mg.lang';

function readLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'zh-CN' || v === 'en-US') return v;
  } catch {
    /* 隐身模式等场景忽略 */
  }
  return 'zh-CN';
}

export const lang = ref<Lang>(readLang());

function applyDocumentLang(v: Lang) {
  try {
    document.documentElement.lang = v === 'en-US' ? 'en' : 'zh-CN';
  } catch {
    /* 非浏览器环境忽略 */
  }
}

// 模块加载即对齐运行时与 <html lang>，避免首屏文案与属性不一致
rawSetLang(lang.value);
applyDocumentLang(lang.value);

watch(lang, (v) => {
  rawSetLang(v);
  applyDocumentLang(v);
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 同上 */
  }
  // 后端（错误信息、审计动作、MCP 描述）要用同一个语言，失败不影响界面
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: v }),
  }).catch(() => {
    /* 后端没起来时保持本地切换即可 */
  });
});

/** 只读后端设置：换设备/清缓存后仍能恢复上次的语言 */
export async function syncLangFromServer(): Promise<void> {
  try {
    const r = await fetch('/api/settings', { cache: 'no-store' });
    const j = await r.json();
    const v = j?.settings?.lang;
    if ((v === 'zh-CN' || v === 'en-US') && v !== lang.value) {
      lang.value = v;
      rawSetLang(v);
      applyDocumentLang(v);
      try {
        localStorage.setItem(KEY, v);
      } catch {
        /* 同上 */
      }
    }
  } catch {
    /* 忽略：本地设置优先 */
  }
}

/**
 * 组件里拿翻译函数。
 * 函数内部读一次 lang.value，模板渲染时就会订阅语言变化。
 */
export function useT() {
  return (key: MsgKey, vars?: Vars) => {
    void lang.value;
    return rawT(key, vars);
  };
}
