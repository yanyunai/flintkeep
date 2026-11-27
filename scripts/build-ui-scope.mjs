#!/usr/bin/env node
/**
 * 把 design/system/ 下的模板源文件，重写成 #mgui 作用域版本，输出到 src/renderer/styles/ui/。
 *
 * 为什么要作用域：
 *   base.css 里的 `.app`、`button{...}`、`:root{--bg}` 与现有 App.vue 的同名类/token 冲突，
 *   直接全局引入会把已经跑着的界面弄坏。新界面统一挂在 <div id="mgui" data-template data-theme>，
 *   CSS 全部限定在这个子树内，老页面零影响。
 *
 * 用法：node scripts/build-ui-scope.mjs
 * 注意：不要手改 src/renderer/styles/ui/*.css —— 改 design/system/ 的源文件后重跑本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const ROOT_ID = "[data-mgui]";
const SRC_DIR = 'design/system';
const OUT_DIR = 'src/renderer/styles/ui';
const FILES = [
  { src: 'base.css', out: 'base.css' },
  { src: 'tpl-obsidian.css', out: 'tpl-obsidian.css' },
  { src: 'tpl-atlas.css', out: 'tpl-atlas.css' },
];

/** 单个选择器加前缀 */
function scopeOne(sel) {
  const s = sel.trim();
  if (!s) return s;
  if (s === ':root' || s === 'html' || s === 'body') return ROOT_ID;
  if (s === '*') return `${ROOT_ID}, ${ROOT_ID} *`;
  if (/^\*(::?[a-z-]+)+$/.test(s)) return `${ROOT_ID} ${s}`;
  // 源里已自带作用域前缀的规则（如 :where([data-mgui]) button）不再重复加前缀
  if (s.includes('[data-mgui]')) return s;
  // .app 在新界面里就是 [data-mgui] 根元素自身：把 .app（含 .app.open 这类组合）
  // 映射为根选择器本身，而不是后代 [data-mgui] .app（根外层没有 .app，永不匹配）。
  // 根上还挂着 data-template / data-theme，所以祖先位置的属性选择器要并进根复合选择器。
  const compounds = s.split(/\s+/);
  const i = compounds.findIndex((c) => /(^|\.)app(?=\.|$)/.test(c));
  if (i > -1) {
    let head = '';
    let j = 0;
    for (; j < i; j++) {
      // 允许连写的属性选择器（如 [data-template="obs"][data-theme="light"]）
      if (/^(\[data-(template|theme)[^\]]*\])+$/.test(compounds[j])) head += compounds[j];
      else break;
    }
    const cls = compounds[i].replace(/(^|\.)app(?=\.|$)/g, '');
    return [head + ROOT_ID + cls, ...compounds.slice(i + 1)].filter(Boolean).join(' ');
  }
  // 皮肤文件以属性选择器开头：紧贴根元素，不加空格
  if (s.startsWith('[data-template') || s.startsWith('[data-theme')) return ROOT_ID + s;
  return `${ROOT_ID} ${s}`;
}

function scopeSelectorList(selector) {
  const parts = selector.split(',').map(scopeOne);
  return [...new Set(parts)].join(', ');
}

function transform(css) {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    // @keyframes 里的 0%/100% 不是选择器，不能加前缀
    for (let p = rule.parent; p; p = p.parent) {
      if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return;
    }
    rule.selector = scopeSelectorList(rule.selector);
  });
  return root.toString();
}

const banner = `/* 由 scripts/build-ui-scope.mjs 生成，请勿手改。
 * 源文件：design/system/%SRC%
 * 作用域：${ROOT_ID}（新界面根容器，携带 data-template / data-theme）
 */
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
let changed = 0;

for (const { src, out } of FILES) {
  const srcPath = path.join(SRC_DIR, src);
  if (!fs.existsSync(srcPath)) {
    console.warn(`跳过（源文件不存在）：${srcPath}`);
    continue;
  }
  const outPath = path.join(OUT_DIR, out);
  const css = fs.readFileSync(srcPath, 'utf8');
  const result = banner.replace('%SRC%', src) + transform(css);
  const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (prev === result) {
    console.log(`未变：${outPath}`);
    continue;
  }
  fs.writeFileSync(outPath, result, 'utf8');
  console.log(`已生成：${outPath}（${(result.length / 1024).toFixed(1)} KB）`);
  changed++;
}

fs.writeFileSync(
  path.join(OUT_DIR, 'README.md'),
  `# ui/ 生成产物

本目录的 CSS 由 \`scripts/build-ui-scope.mjs\` 从 \`design/system/\` 生成，
所有选择器都加了 \`#mgui\` 前缀，避免与现有 \`App.vue\` 的样式和 token 冲突。

- 要改样式：改 \`design/system/base.css\` 或 \`design/system/tpl-*.css\`，然后跑 \`node scripts/build-ui-scope.mjs\`
- 不要直接改这里的文件，下次生成会被覆盖
- 新界面必须渲染在 \`<div id="mgui" data-template="obs" data-theme="dark|light">\` 内
`,
  'utf8'
);

console.log(changed ? `完成，更新 ${changed} 个文件` : '完成，产物无变化');
