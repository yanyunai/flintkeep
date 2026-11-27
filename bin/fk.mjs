#!/usr/bin/env node
/**
 * 开发期 `fk` 入口：用仓库内的 tsx 直接跑 TS 源码。
 * 打包分发时应改为编译后的 JS（或单文件产物），这里只服务源码仓库。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!fs.existsSync(tsx)) {
  console.error('fk: 找不到 tsx，先在仓库根目录执行 npm install');
  process.exit(1);
}
const entry = path.join(root, 'src', 'core', 'cli.ts');
const r = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);