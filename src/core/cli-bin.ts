/**
 * 三个云厂商官方 CLI（bl / arkcli / thcli）的定位与启动方式。
 *
 * 为什么需要单独一层：
 * - 源码态：CLI 装在项目的 node_modules/.bin，直接调 shim 即可；
 * - 安装版：安装包里没有 .bin shim（electron-builder 只带包内容），
 *   而且用户机器上没有 Node —— 所以 bl/thcli 用「包内的 JS 入口 + Electron 自带的 Node」
 *   （ELECTRON_RUN_AS_NODE=1）跑；arkcli 自带各平台原生 exe，直接调它。
 *
 * 界面里要给用户「可复制的完整命令」，所以额外提供 cliDisplay()：
 * 安装版会在数据目录下生成 .cmd 包装脚本，粘到 cmd 里就能用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

/** 安装版：后端 bundle 跑在 resources/app/build 下，root 由主进程显式传入 */
const root = process.env.FK_APP_ROOT || path.join(__dirname, '..', '..');
const packaged = process.env.FK_PACKAGED === '1' || !fs.existsSync(path.join(root, 'server.ts'));

export type CliKind = 'bl' | 'ark' | 'th';

export interface CliLaunch {
  /** 可执行文件 */
  cmd: string;
  /** 拼在用户参数前面的固定参数 */
  prefixArgs: string[];
  /** 需要追加的环境变量 */
  env: Record<string, string>;
  /** 是否要经 shell（Windows 上的 .cmd 必须） */
  shell: boolean;
  /** 工作目录：安装版的程序目录只读，CLI 的自更新会写锁文件，必须换成可写目录 */
  cwd: string;
}

/** 包内路径（安装版带进 resources/app/node_modules） */
const blScript = path.join(root, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs');
const thScript = path.join(root, 'node_modules', 'tencent-tokenhub-cli', 'dist', 'main.cjs');

/** arkcli 是随包下载的原生二进制，按平台/架构挑 */
const arkExe = (() => {
  const platformMap: Record<string, string> = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
  const p = platformMap[process.platform] || process.platform;
  const a = archMap[process.arch] || process.arch;
  const ext = isWin ? '.exe' : '';
  return path.join(root, 'node_modules', '@volcengine', 'ark-cli', 'bin', `arkcli-${p}-${a}${ext}`);
})();

/** 安装版可写目录（CLI 的自更新/锁文件写这里，不写安装目录） */
function writableDir(): string {
  return process.env.VAULT_DATA_DIR || os.tmpdir();
}

/** 各 CLI 在 .bin 下的名字（源码态） */
function devShim(kind: CliKind): string {
  const name = kind === 'bl' ? 'bl' : kind === 'ark' ? 'arkcli' : 'thcli';
  return path.join(root, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);
}

export function cliLaunch(kind: CliKind): CliLaunch {
  if (!packaged) {
    return { cmd: devShim(kind), prefixArgs: [], env: {}, shell: isWin, cwd: root };
  }
  if (kind === 'ark') {
    // 原生 exe，不需要 Node，也不需要 shell
    return { cmd: arkExe, prefixArgs: [], env: {}, shell: false, cwd: writableDir() };
  }
  return {
    cmd: process.execPath,
    prefixArgs: [kind === 'bl' ? blScript : thScript],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
    cwd: writableDir(),
  };
}

/** CLI 本体是否随包存在（登录与否另查 auth status） */
export function cliAvailable(kind: CliKind): boolean {
  try {
    if (!packaged) return fs.existsSync(devShim(kind));
    return fs.existsSync(kind === 'ark' ? arkExe : kind === 'bl' ? blScript : thScript);
  } catch {
    return false;
  }
}

function wrapperName(kind: CliKind): string {
  return kind === 'bl' ? 'bl.cmd' : kind === 'ark' ? 'arkcli.cmd' : 'thcli.cmd';
}

/**
 * 界面展示/复制用的入口路径。
 * 安装版 bl/thcli 需要一层 .cmd：Electron 以纯 Node 模式跑包内脚本。
 */
export function cliDisplay(kind: CliKind): string {
  if (!packaged) return devShim(kind);
  if (kind === 'ark') return arkExe;
  const dir = path.join(writableDir(), 'cli');
  const file = path.join(dir, wrapperName(kind));
  const script = kind === 'bl' ? blScript : thScript;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = [
      '@echo off',
      'setlocal',
      `set "ELECTRON_RUN_AS_NODE=1"`,
      `"${process.execPath}" "${script}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
    fs.writeFileSync(file, body, 'utf8');
  } catch {
    /* 写不了就返回路径，界面照常显示 */
  }
  return file;
}

/** 给界面用：路径含空格/引号时加引号 */
export function quoteBin(bin: string): string {
  return /[\s"']/.test(bin) ? JSON.stringify(bin) : bin;
}
