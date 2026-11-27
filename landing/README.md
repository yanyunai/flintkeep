# FlintKeep — 官网落地页

燧垒 FlintKeep 的官网静态页源码：单文件 `index.html`，零外部依赖（无字体 / CDN 请求），中英双语，桌面与移动端自适应。

**线上**

- Cloudflare Pages：https://flintkeep.pages.dev
- GitHub Pages：https://yanyunai.github.io/flintkeep-site/

**本地预览**

```bash
python3 -m http.server 8080 --directory landing
# 打开 http://localhost:8080
```

**结构**

- `index.html`：页面本体，样式与脚本内联
- `assets/`：产品截图（`app-<页面>-<zh|en>.jpg`，6 个页面 × 中英两套）与联系方式图
- `.nojekyll`：让 GitHub Pages 按静态目录直接托管，不走 Jekyll

**许可**：与主项目一致，AGPL-3.0-only。产品名称与 Logo 不在授权范围内。

**主项目**：https://github.com/yanyunai/flintkeep
