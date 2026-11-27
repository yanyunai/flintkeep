import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

/**
 * Lint 目标是「别让新问题进来」，不是一次性把存量风格全部翻新。
 * 因此：
 * - 只启用 essential 级 Vue 规则（正确性），不启用排版类规则（会和 Prettier 打架）；
 * - `no-explicit-any` 关闭：存量 any 是已知技术债，先记录不阻断；
 * - 未使用变量降为 warn：存量里有历史遗留参数，阻断会让 CI 一上线就红。
 */
export default [
  {
    ignores: ['dist/**', 'build/**', 'node_modules/**', 'data/**', '.zwork-tmp/**', 'landing/**', 'design/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 类型与全局由 tsc 负责；eslint 的 no-undef 在 TS 上只会误报
      'no-undef': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      // v-html 仅用于 icons.ts 的静态 SVG 与本地生成的机房场景图（文本已走 esc() 转义）；
      // 这两处不接受外部 HTML，故不逐行加 disable 注释
      'vue/no-v-html': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // 冒烟脚本里 `catch {}` 表示「失败即忽略」，是有意为之
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 渲染层与 Electron 渲染进程：浏览器全局
    files: ['src/renderer/**/*.{ts,vue}', 'electron/**/*.mjs', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        HTMLElement: 'readonly',
        SVGElement: 'readonly',
        Node: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
];