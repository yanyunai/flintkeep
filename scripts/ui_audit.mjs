#!/usr/bin/env node
/**
 * 实机 UI 审查截图工具（可复用）
 * 用法：node scripts/ui_audit.mjs [--url http://127.0.0.1:8790] [--out .zwork/ui-audit] [--widths 1440,1024,800]
 * 前置：后端已跑在 <url host>（vite 代理 /api → 8787）；依赖 puppeteer-core + 系统 Chrome。
 * 产出：<out>/<模板-主题>/w<宽度>/<页面>.png + <out>/probes.json + <out>/console.log
 * 多视口：1440 截全部页面；其余宽度只截关键页（myprojects/assets/settings/settings-fields/studio/audit），
 *        各宽度写入独立子目录，避免互覆。
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const BASE = arg('--url', 'http://127.0.0.1:8790');
const OUT = arg('--out', '.zwork/ui-audit');
/** 视口宽度列表：第一个（1440）截全部页，其余只截关键页 */
const WIDTHS = arg('--widths', '1440,1024,800')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const KEY_PAGES = new Set(['myprojects', 'assets', 'settings', 'settings-fields', 'studio', 'audit']);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** 侧栏页面：文案（zh）→ 文件名 */
const PAGES = [
  ['运行工作台', 'myprojects'],
  ['AI 助手', 'aiassistant'],
  ['机房', 'studio'],
  ['项目', 'projects'],
  ['收支', 'finance'],
  ['迭代任务', 'tasks'],
  ['灵感池', 'ideas'],
  ['资料证书', 'docs'],
  ['资产清单', 'assets'],
  ['备忘录', 'memo'],
  ['IP 白名单', 'whitelist'],
  ['模型用量', 'aiusage'],
  ['MCP 接入', 'mcp'],
  ['审计日志', 'audit'],
  ['设置', 'settings'],
];
const COMBOS = [
  ['obs', 'dark'],
  ['obs', 'light'],
  ['atlas', 'dark'],
  ['atlas', 'light'],
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--disable-extensions'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle2' });
const consoleErrs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + e.message));

async function setCombo(tpl, theme) {
  await page.evaluate((t, th) => {
    localStorage.setItem('mgui.tpl', t);
    localStorage.setItem('mgui.theme', th);
    localStorage.setItem('mgui.mode', 'new');
  }, tpl, theme);
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 700));
}

async function gotoPage(label) {
  const ok = await page.evaluate((txt) => {
    const items = [...document.querySelectorAll('[data-mgui] .side-item .nm')];
    const el = items.find((n) => n.textContent.trim() === txt);
    if (!el) return false;
    el.closest('button').click();
    return true;
  }, label);
  if (!ok) return false;
  await new Promise((r) => setTimeout(r, 900));
  return true;
}

const probes = {};
let shotCount = 0;
for (const [tpl, theme] of COMBOS) {
  await setCombo(tpl, theme);
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
    await new Promise((r) => setTimeout(r, 400)); // 等重排完成再截图
    const dir = path.join(OUT, `${tpl}-${theme}`, `w${width}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [label, file] of PAGES) {
      if (width !== WIDTHS[0] && !KEY_PAGES.has(file)) continue;
      const ok = await gotoPage(label);
      if (!ok) { console.log(`  ! 找不到侧栏项「${label}」（w${width}）`); continue; }
      await page.screenshot({ path: path.join(dir, `${file}.png`), fullPage: false });
      shotCount++;
      // 设置页：进入「字段管理」分区单独截
      if (file === 'settings') {
        const ok2 = await page.evaluate(() => {
          const el = [...document.querySelectorAll('.set-nav-item')].find((n) => n.textContent.includes('字段'));
          if (!el) return false;
          el.click(); return true;
        });
        if (ok2) {
          await new Promise((r) => setTimeout(r, 700));
          await page.screenshot({ path: path.join(dir, 'settings-fields.png') });
          shotCount++;
        }
      }
    }
  }
}

// 计算样式探针：只对默认组合（obs-dark）取关键疑点元素，固定 1440 宽
await setCombo('obs', 'dark');
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await new Promise((r) => setTimeout(r, 400));
await gotoPage('运行工作台');
probes.myprojects = await page.evaluate(() => {
  const pick = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return { fontSize: c.fontSize, padding: c.padding, border: c.borderWidth + ' ' + c.borderStyle, background: c.backgroundColor };
  };
  const btns = [...document.querySelectorAll('.head-actions button')];
  return {
    headButtons: btns.map((b) => ({ text: b.textContent.trim().slice(0, 8), ...pick(b) })),
  };
});
await gotoPage('资产清单');
probes.assets = await page.evaluate(() => {
  const stats = document.querySelector('[data-mgui] .stats');
  const c = stats ? getComputedStyle(stats) : null;
  return { statsColumns: c ? c.gridTemplateColumns : null, statCount: document.querySelectorAll('.stat').length };
});
// 抽屉回归：点开第一行，检查 code 有 title、copy 按钮在截断流外可点、敏感占位行正常
await page.evaluate(() => {
  const row = document.querySelector('[data-mgui] .t-row');
  if (row) row.click();
});
await new Promise((r) => setTimeout(r, 500));
probes.drawer = await page.evaluate(() => {
  const drawer = document.querySelector('[data-mgui] .mg-view.open .drawer');
  if (!drawer) return { open: false };
  const code = drawer.querySelector('.field code');
  const copy = drawer.querySelector('.field .copy');
  let copyClickable = null;
  if (copy) {
    const r = copy.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    copyClickable = hit === copy || copy.contains(hit);
  }
  return {
    open: true,
    fields: drawer.querySelectorAll('.field').length,
    codeTitle: code ? code.getAttribute('title') : null,
    copyInTruncation: copy ? !!copy.closest('.v') : null,
    copyClickable,
    secretRows: drawer.querySelectorAll('.field.secret').length,
  };
});
await page.keyboard.press('Escape');
await gotoPage('设置');
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.set-nav-item')].find((n) => n.textContent.includes('字段'));
  if (el) el.click();
});
await new Promise((r) => setTimeout(r, 700));
probes.fieldSchema = await page.evaluate(() => {
  const pick = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return { background: c.backgroundColor, border: c.borderWidth + ' ' + c.borderStyle + ' ' + c.borderColor, color: c.color, fontSize: c.fontSize };
  };
  return {
    cards: [...document.querySelectorAll('.set-card')].slice(0, 4).map(pick),
    saveBtn: pick(document.querySelector('.fs-save')),
    checkboxAccent: (() => {
      const cb = document.querySelector('.set-card input[type=\'checkbox\']');
      return cb ? getComputedStyle(cb).accentColor : null;
    })(),
  };
});

fs.writeFileSync(path.join(OUT, 'probes.json'), JSON.stringify(probes, null, 2));
fs.writeFileSync(path.join(OUT, 'console.log'), consoleErrs.join('\n') || '(无 console 错误)');
console.log(`截图完成：${OUT}/（${COMBOS.length} 组合 × 宽度 [${WIDTHS.join(', ')}]，共 ${shotCount} 张；1440 全页，其余宽度只截关键页）`);
console.log('探针：', JSON.stringify(probes, null, 2).slice(0, 1200));
await browser.close();
