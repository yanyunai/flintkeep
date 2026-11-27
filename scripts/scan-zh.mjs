#!/usr/bin/env node
/**
 * 粗扫 renderer/core 中残留的中文字面量（用于 i18n 全覆盖排查）。
 * 忽略：注释行、i18n 字典目录。
 *
 *   node scripts/scan-zh.mjs            # 全量清单
 *   node scripts/scan-zh.mjs --count    # 只看文件计数
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'src';
const SKIP_DIRS = new Set(['node_modules', '.git', 'shared']);
const countOnly = process.argv.includes('--count');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, acc);
    } else if (/\.(vue|ts|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT).filter((f) => !f.includes('shared/i18n'));
const report = [];

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // 跳过纯注释行
    if (/^(\/\/|\*|\/\*|<!--)/.test(trimmed)) return;
    // 去掉行尾注释再判断
    const body = trimmed.replace(/\/\/.*$/, '').replace(/<!--[\s\S]*?-->/g, '');
    if (!/[\u4e00-\u9fff]/.test(body)) return;
    hits.push(`${i + 1}: ${trimmed.slice(0, 160)}`);
  });
  if (hits.length) report.push({ file: f, hits });
}

if (countOnly) {
  for (const r of report) console.log(String(r.hits.length).padStart(5), r.file);
  console.log('总计文件', report.length, '行', report.reduce((a, r) => a + r.hits.length, 0));
} else {
  for (const r of report) {
    console.log('\n### ' + r.file);
    for (const h of r.hits) console.log('  ' + h);
  }
  console.log('\n总计文件', report.length, '行', report.reduce((a, r) => a + r.hits.length, 0));
}
