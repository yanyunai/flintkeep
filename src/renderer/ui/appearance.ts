import { ref, watch } from 'vue';

/**
 * 外观设置（全局单例）
 * - mode：迁移期开关，'new' 走黑曜模板的新版资产清单，'classic' 走旧表格
 * - theme：黑曜模板的深/浅色，挂在 #mgui 的 data-theme 上
 *
 * 先落 localStorage（首屏不闪），后续接 settings 集合做跨设备同步。
 */
export type UiMode = 'new' | 'classic';
export type UiTheme = 'dark' | 'light';
/** 界面模板：obs = 黑曜（终端风），atlas = 纸墨（米白纸张感） */
export type UiTemplate = 'obs' | 'atlas';

const MODE_KEY = 'mgui.mode';
const THEME_KEY = 'mgui.theme';
/** 旧键：经典壳（App.vue 的 classic 模板）历史上只认这个，仍要写回，避免老壳读不到 */
const LEGACY_THEME_KEY = 'mg-theme';
const TPL_KEY = 'mgui.tpl';

function read<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 首次运行没存过主题时按系统偏好，而不是硬写死深色 */
function prefersDark(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  } catch {
    return true;
  }
}

/**
 * 主题只有一个真源（`mgui.theme`）。
 * 老壳以前只写 `mg-theme`，所以这里做一次迁移：新键没有、旧键有时以旧键为准，
 * 并补写到新键——否则会出现「只设过 mg-theme，新模板仍按默认深色」的割裂。
 */
function readTheme(): UiTheme {
  try {
    const primary = localStorage.getItem(THEME_KEY);
    if (primary === 'dark' || primary === 'light') return primary;
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === 'dark' || legacy === 'light') {
      localStorage.setItem(THEME_KEY, legacy);
      return legacy;
    }
  } catch {
    /* 隐身模式等场景忽略 */
  }
  return prefersDark() ? 'dark' : 'light';
}

export const uiMode = ref<UiMode>(read<UiMode>(MODE_KEY, 'new', ['new', 'classic']));
export const uiTheme = ref<UiTheme>(readTheme());
export const uiTemplate = ref<UiTemplate>(read<UiTemplate>(TPL_KEY, 'obs', ['obs', 'atlas']));

watch(uiMode, (v) => {
  try {
    localStorage.setItem(MODE_KEY, v);
  } catch {
    /* 隐身模式等场景忽略 */
  }
});
watch(uiTheme, (v) => {
  try {
    // 两个键一起写：新模板读新键，经典壳仍读旧键，必须始终一致
    localStorage.setItem(THEME_KEY, v);
    localStorage.setItem(LEGACY_THEME_KEY, v);
  } catch {
    /* 同上 */
  }
});
watch(uiTemplate, (v) => {
  try {
    localStorage.setItem(TPL_KEY, v);
  } catch {
    /* 同上 */
  }
});

/**
 * 侧栏折叠：true = 展开（212px，带文字），false = 收起（62px，只留图标）。
 * 窄屏下内容区能多出 150px，表格不用横向挤。
 */
const SIDE_KEY = 'mgui.side.v2';
export const sideOpen = ref<boolean>(
  (() => {
    try {
      return localStorage.getItem(SIDE_KEY) !== '0';
    } catch {
      return true;
    }
  })()
);
watch(sideOpen, (v) => {
  try {
    localStorage.setItem(SIDE_KEY, v ? '1' : '0');
  } catch {
    /* 同上 */
  }
});

/**
 * 机房页场景：rack = 机房机柜视角，office = 办公室工位视角。
 * 跟主题一样落 localStorage，切走再回来保持上次的选择。
 */
export type UiScene = 'rack' | 'office';
const SCENE_KEY = 'mgui.scene';
export const uiScene = ref<UiScene>(read<UiScene>(SCENE_KEY, 'rack', ['rack', 'office']));
watch(uiScene, (v) => {
  try {
    localStorage.setItem(SCENE_KEY, v);
  } catch {
    /* 同上 */
  }
});
