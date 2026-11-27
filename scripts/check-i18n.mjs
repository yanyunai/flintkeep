#!/usr/bin/env node
/**
 * i18n 质量检查。
 *
 *   1. key 对齐：en 必须覆盖 zh 的每一个 key，且不能多出 zh 没有的 key
 *   2. 源码引用：扫描 t('…') / tr('…') 字面量，key 必须存在（防止删字典漏改代码）
 *   3. 占位符：同 key 两侧 {var} 集合一致（防止 {n} 写漏导致英文缺数字）
 *   4. 空值：不允许空字符串
 *
 * 用法：
 *   node scripts/check-i18n.mjs           # 只报错，退出码非 0 表示失败
 *   node scripts/check-i18n.mjs --stat    # 额外打印各域 key 数
 *
 * 挂到 package.json：npm run i18n:check
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src/shared/i18n';
const SCAN_DIRS = ['src'];
const stat = process.argv.includes('--stat');

/** 从 zh/en 的域文件里抓 `'key': 'value'` —— 字典是扁平 as const 对象，正则足够 */
function readDict(lang) {
  const dir = path.join(SRC, lang);
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f === 'index.ts') continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /'([a-zA-Z0-9_.]+)'\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g;
    let m;
    while ((m = re.exec(text))) {
      out[m[1]] = m[3];
    }
  }
  return out;
}

function placeholders(s) {
  return new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(vue|ts|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const zh = readDict('zh');
const en = readDict('en');
const errors = [];

// 1. key 对齐
const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);
for (const k of zhKeys) {
  if (!(k in en)) errors.push(`缺英文：${k}`);
  if (!String(zh[k]).trim()) errors.push(`中文为空：${k}`);
  if (k in en && !String(en[k]).trim()) errors.push(`英文为空：${k}`);
}
for (const k of enKeys) {
  if (!(k in zh)) errors.push(`en 多出（zh 没有）：${k}`);
}

// 2. 占位符
for (const k of zhKeys) {
  if (!(k in en)) continue;
  const a = placeholders(zh[k]);
  const b = placeholders(en[k]);
  for (const v of a) if (!b.has(v)) errors.push(`占位符缺失：${k} 少了 {${v}}`);
  for (const v of b) if (!a.has(v)) errors.push(`占位符多余：${k} 多了 {${v}}`);
}

// 3. 源码里引用的 key 必须存在
const used = new Map();
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    if (file.includes(`${path.sep}shared${path.sep}i18n`)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const re = /\b(?:tr|t)\(\s*'([a-zA-Z0-9_.]+)'/g;
    let m;
    while ((m = re.exec(text))) used.set(m[1], file);
  }
}
for (const [k, file] of used) {
  if (!(k in zh)) errors.push(`代码引用了不存在的 key：${k}（${file}）`);
}

// 4. 报告
if (stat) {
  const byDomain = {};
  for (const k of zhKeys) {
    const d = k.split('.')[0];
    byDomain[d] = (byDomain[d] || 0) + 1;
  }
  console.log('各域 key 数：');
  for (const [d, n] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d.padEnd(12)} ${String(n).padStart(4)}`);
  }
  console.log(`合计 ${zhKeys.length} 条，代码引用 ${used.size} 条`);
}

if (errors.length) {
  console.error(`\ni18n 检查失败（${errors.length} 项）：`);
  for (const e of errors.slice(0, 60)) console.error('  ✗ ' + e);
  if (errors.length > 60) console.error(`  … 还有 ${errors.length - 60} 项`);
  process.exit(1);
}
console.log(`i18n 检查通过：${zhKeys.length} 条文案，代码引用 ${used.size} 条`);
