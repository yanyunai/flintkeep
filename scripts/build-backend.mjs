/**
 * 打包前的后端编译：把 TypeScript 后端打成两个独立 ESM 文件。
 *
 * 为什么需要：
 * - 源码里 import 都是无扩展名的 TS 路径，tsc 编译出来 Node 解析不了；
 * - 安装包不能依赖用户机器上有 node / npx / tsx，所以必须预先编成 JS。
 *
 * 产物：
 * - build/server.mjs  桌面端后端（由 Electron 以 ELECTRON_RUN_AS_NODE 启动）
 * - build/mcp.mjs     MCP stdio 服务（由外部 Agent 客户端拉起）
 *
 * ssh2 等第三方依赖一律保持 external：交给 electron-builder 把生产依赖的
 * node_modules 一起带进安装包，避免把 CJS 依赖塞进 ESM bundle 后踩
 * 「Dynamic require of "path" is not supported」这类坑。
 */
import esbuild from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'build');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** 打包后源码里的 __dirname 失效，用 import.meta.url 补一个（换个名字注入，避免和 esbuild 自己的声明冲突） */
const banner = {
  js: "import { fileURLToPath as __fkUrl } from 'node:url'; import { dirname as __fkDir } from 'node:path'; const __fkDirName = __fkDir(__fkUrl(import.meta.url));",
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  banner,
  define: { __dirname: '__fkDirName' },
  packages: 'external',
  external: ['ssh2', 'cpu-features', 'electron'],
  logLevel: 'info',
};

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'server.ts')],
  outfile: path.join(outdir, 'server.mjs'),
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src', 'core', 'mcp.ts')],
  outfile: path.join(outdir, 'mcp.mjs'),
});

// 安装版也要能用 `fk` 命令行（SSH agent、模板注入、手动查资产），同样依赖 Electron 自带的 Node
await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src', 'core', 'cli.ts')],
  outfile: path.join(outdir, 'fk.mjs'),
});

console.log('[build-backend] 完成：build/server.mjs、build/mcp.mjs、build/fk.mjs');
