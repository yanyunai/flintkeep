# ui/ 生成产物

本目录的 CSS 由 `scripts/build-ui-scope.mjs` 从 `design/system/` 生成，
所有选择器都加了 `#mgui` 前缀，避免与现有 `App.vue` 的样式和 token 冲突。

- 要改样式：改 `design/system/base.css` 或 `design/system/tpl-*.css`，然后跑 `node scripts/build-ui-scope.mjs`
- 不要直接改这里的文件，下次生成会被覆盖
- 新界面必须渲染在 `<div id="mgui" data-template="obs" data-theme="dark|light">` 内
