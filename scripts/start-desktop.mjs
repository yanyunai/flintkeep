/**
 * 桌面客户端启动器。
 *
 * 关键：环境里若存在 ELECTRON_RUN_AS_NODE=1，electron 二进制会以「纯 Node」模式启动，
 * 不加载 Electron 运行时 → `import { BrowserWindow } from 'electron'` 报
 * "does not provide an export named 'BrowserWindow'"，窗口永远出不来。
 * Electron 只在**进程启动时**读这个变量，所以在 main.mjs 里删已经没用了，
 * 必须在 spawn 之前从子进程环境中去掉。
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { cleanupStaleBackend } from '../electron/port-cleanup.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const PORT = Number(process.env.PORT || 8787);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

/**
 * 直接调用 electron 二进制，不用 node_modules/.bin/electron.cmd。
 * 原因：.cmd 必须配 shell:true 才能执行，而 shell 会把参数拼成一条字符串，
 * 项目路径含中文/空格时 "--disable-gpu" 会被吃掉（GPU 一崩整个应用 FATAL 退出）。
 * 直接 spawn .exe 且 shell:false，参数以数组传递，两者都不会丢。
 *
 * 路径按平台区分：Windows 是 dist/electron.exe；macOS 是 Electron.app 内的 MacOS/Electron；
 * Linux 是 dist/electron。
 */
const exe = isWin
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron');

if (!fs.existsSync(exe)) {
  console.error('[desktop] 未找到 Electron，请先执行：npm install');
  process.exit(1);
}

/**
 * 启动前先清掉上一轮残留的后端。
 * 否则它会一直占着 8787，Electron 只能"复用现有后端"，改了后端代码永远不生效。
 * 只清**确认是本应用**的后端（判据：GET /api/locked 返回 {locked:boolean}），不会误杀别的软件。
 */
if (process.env.KEEP_EXISTING_BACKEND !== '1') {
  const r = await cleanupStaleBackend(PORT);
  if (r.cleaned) console.log(`[desktop] 已清理残留后端 (PID ${r.pid})，将启动全新后端。`);
  else if (r.pid && /非本应用/.test(r.reason)) {
    console.warn(`[desktop] ${r.reason}，不处理。`);
    console.warn(`[desktop] 可换端口启动：set PORT=8799 && npm run desktop`);
  }
}

console.log('[desktop] 启动 Electron（已清除 ELECTRON_RUN_AS_NODE）…');
// --disable-gpu：部分 Windows 机器上 GPU 进程会崩（0xC0000005）导致整个应用 FATAL 退出，
// 本应用是纯本地界面，不需要硬件加速；这样可保留 Chromium 沙箱，比 --no-sandbox 更安全。
const child = spawn(
  exe,
  [path.join(root, 'electron', 'main.mjs'), '--disable-gpu', ...process.argv.slice(2)],
  { cwd: root, env, stdio: 'inherit', shell: false }
);
child.on('exit', (code) => process.exit(code ?? 0));
