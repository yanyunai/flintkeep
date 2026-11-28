/**
 * Electron 主进程（纯 ESM，不引入任何 loader）。
 *
 * 重要：这里**不能**用 tsx 的 register()／ESM loader。
 * 一旦注册 loader，Node 会改用 npm 解析规则去解析 'electron'，
 * 命中 node_modules/electron/index.js（它只导出可执行文件路径），
 * 于是 `import { BrowserWindow } from 'electron'` 报
 * "does not provide an export named 'BrowserWindow'" —— 窗口永远起不来。
 *
 * 正确做法：主进程只负责窗口，后端 server.ts 用独立子进程启动。
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import { portOpen, cleanupStaleBackend } from './port-cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isDev = process.env.VITE_DEV === '1';
const PORT = Number(process.env.PORT || 8787);
const UI_PORT = Number(process.env.UI_PORT || 8790);
/** 设为 1 可保留端口上已有的后端（例如你自己在另一个终端跑着 npm run dev） */
const KEEP_EXISTING = process.env.KEEP_EXISTING_BACKEND === '1';

/**
 * 托盘/窗口标题的文案表。
 *
 * 为什么不用 src/shared/i18n：主进程是「纯 ESM、零 loader」的（见文件头注释），
 * 引不了 .ts。所以这里只保留托盘用到的十几条，语言读 data/settings.json 的 lang，
 * 每次重建菜单时读一次，切语言后下次重建即生效。
 */
const TRAY_TEXT = {
  'zh-CN': {
    noProjects: '（还没有登记项目）',
    external: ' · 外部启动',
    residual: ' ⚠ 未停干净',
    withDeps: '（含 {n} 个依赖）',
    start: '启动',
    stop: '关闭',
    stopWithDeps: '关闭（含依赖）',
    stopMainOnly: '仅停主程序',
    running: '运行中',
    stopped: '已停止',
    residualHint: '⚠ 还有端口/容器存活，去主界面「体检」',
    viewInApp: '在主界面查看',
    vaultLocked: '已锁定',
    vaultUnlocked: '已解锁',
    vaultTooltip: '燧垒（{s}）',
    vaultLine: '燧垒：{s}',
    runnerLine: '运行工作台 · 运行中 {a}/{b}',
    openMain: '打开主界面',
    lockNow: '立即锁定燧垒',
    quit: '退出',
    vault: '燧垒',
  },
  'en-US': {
    noProjects: '(no projects registered)',
    external: ' · external',
    residual: ' ⚠ not fully stopped',
    withDeps: ' (+{n} dependencies)',
    start: 'Start',
    stop: 'Stop',
    stopWithDeps: 'Stop (with dependencies)',
    stopMainOnly: 'Stop main only',
    running: 'running',
    stopped: 'stopped',
    residualHint: '⚠ Ports/containers still alive — check in the app',
    viewInApp: 'View in app',
    vaultLocked: 'locked',
    vaultUnlocked: 'unlocked',
    vaultTooltip: 'Vault ({s})',
    vaultLine: 'Vault: {s}',
    runnerLine: 'Project Runner · running {a}/{b}',
    openMain: 'Open main window',
    lockNow: 'Lock vault now',
    quit: 'Quit',
    vault: 'Vault',
  },
};

/** 读 settings.json 里的语言；读不到按中文（与产品默认一致） */
function appLang() {
  try {
    const dir = process.env.DATA_DIR || path.join(root, 'data');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    return j && j.lang === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

/** 取一条托盘文案，支持 {name} 插值 */
function tt(key, vars) {
  const dict = TRAY_TEXT[appLang()] || TRAY_TEXT['zh-CN'];
  const s = dict[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
}

/**
 * 关闭硬件加速。
 * 部分 Windows 机器上 GPU 进程会崩（0xC0000005）导致整个应用 FATAL 退出。
 * 用 API 而不是命令行参数：启动器以 shell 拼接参数时，若项目路径含中文/空格，
 * "--disable-gpu" 会被吃掉（这条路径上踩过一次），API 方式不受影响。
 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');

let serverProc = null;
let win = null;
let tray = null;
/** 真正退出中（托盘退出 / 设置为退出后关窗 / Cmd+Q）；此时不再拦截窗口关闭 */
let quitting = false;
/** 关窗行为由后端 settings.json 决定，轮询刷新（默认后台常驻） */
let appSettings = { closeAction: 'background', autoLockMinutes: 15 };
let vaultLocked = true;
/** 「运行工作台」托盘菜单快照：只在状态变化时重建菜单，避免菜单正打开时闪烁/被关掉 */
let projectItems = [];
let projectSnapshot = '';

/**
 * 单实例锁：重复启动只唤醒已有窗口，不再开第二套窗口。
 * 之前重启时旧的主进程没被一起杀掉，就会出现「两个窗口、只有一个后端」的怪状态。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // 旧实例的后端可能已经被杀掉了（开发时改了后端代码后重启），
    // 这时窗口还在但接口全断，看上去就像「数据全没了」。这里顺手把它拉起来。
    try {
      if (!(await portOpen(PORT))) {
        console.log('[electron] 后端不在，重新拉起…');
        startServer();
        await waitPort(PORT);
        win.reload();
      }
    } catch (e) {
      console.warn('[electron] 重新拉起后端失败：', e?.message || String(e));
    }
  });
}

const api = (p, opts) => fetch(`http://127.0.0.1:${PORT}${p}`, opts).then((r) => r.json());

async function refreshSettings() {
  try {
    const j = await api('/api/settings');
    if (j && j.settings) appSettings = { ...appSettings, ...j.settings };
  } catch { /* 后端未就绪时沿用上次值 */ }
}

async function refreshLockState() {
  try {
    const j = await api('/api/locked');
    const next = !!(j && j.locked);
    if (next !== vaultLocked || !tray) {
      vaultLocked = next;
      rebuildTrayMenu();
    }
  } catch { /* 忽略 */ }
}

/** 轮询等待端口就绪 */
function waitPort(port, host = '127.0.0.1', timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`等待端口 ${port} 超时`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

/**
 * 启动后端：独立 tsx 子进程，避免污染主进程的模块解析。
 *
 * 不再用 shell:true：那会让参数经过一次 shell 解释，路径里有空格/特殊字符时容易被二次解析。
 * POSIX 直接 spawn npx；Windows 没有可执行的 npx（只有 npx.cmd），所以显式交给 cmd.exe，
 * 但仍然传 argv 数组，不做字符串拼接。
 */
function startServer() {
  const isWin = process.platform === 'win32';
  const child = isWin
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx', 'tsx', 'server.ts'], {
        cwd: root,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawn('npx', ['tsx', 'server.ts'], {
        cwd: root,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
  serverProc = child;
  const tag = (buf) => String(buf).replace(/\s+$/, '');
  serverProc.stdout?.on('data', (d) => console.log(`[api] ${tag(d)}`));
  serverProc.stderr?.on('data', (d) => console.error(`[api] ${tag(d)}`));
  serverProc.on('exit', (code) => console.log(`[api] 后端退出 code=${code}`));
}

function stopServer() {
  if (!serverProc || serverProc.killed) return;
  try {
    if (process.platform === 'win32') {
      // Windows：杀整棵进程树（npx 会包一层）
      spawn('taskkill', ['/pid', String(serverProc.pid), '/f', '/t'], { windowsHide: true });
    } else {
      serverProc.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }
  serverProc = null;
}

function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  win.show();
  win.focus();
}

async function projectAction(id, action, body = {}) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/myprojects/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await refreshProjects(true);
  } catch { /* 后端不在就算了 */ }
}

function projectMenuItems() {
  if (!projectItems.length) return [{ label: tt('noProjects'), enabled: false }];
  return projectItems.map((p) => {
    const kids = p.children || [];
    return {
      label: `${p.running ? '●' : '○'} ${p.name}${p.ports.length ? '  :' + p.ports.join(',') : ''}${p.external ? tt('external') : ''}${p.residual ? tt('residual') : ''}${kids.length ? tt('withDeps', { n: kids.length }) : ''}`,
      submenu: [
        { label: tt('start'), enabled: !p.running && p.status !== 'starting', click: () => projectAction(p.id, 'start') },
        { label: kids.length ? tt('stopWithDeps') : tt('stop'), enabled: p.running || p.residual, click: () => projectAction(p.id, 'stop') },
        { label: tt('stopMainOnly'), enabled: p.running || p.residual, click: () => projectAction(p.id, 'stop', { cascade: false }) },
        ...(kids.length
          ? [
            { type: 'separator' },
            // 依赖各自的状态也列出来，避免「主机停了但库还在跑」看不见
            ...kids.map((c) => ({
              label: `${c.running ? '●' : '○'} ${c.name}  ${c.running ? tt('running') : tt('stopped')}`,
              enabled: false,
            })),
          ]
          : []),
        { type: 'separator' },
        { label: p.residual ? tt('residualHint') : tt('viewInApp'), click: () => showMainWindow() },
      ],
    };
  });
}

async function refreshProjects(force = false) {
  try {
    // 优先取折叠树（主项目 + 子节点）；旧后端没有该接口时回落扁平列表
    let tree = null;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/myprojects/tree`);
      if (r.ok) tree = await r.json();
    } catch { /* ignore */ }
    const j = tree || await api('/api/myprojects');

    const entries = tree
      ? (tree.tree || []).map((t) => ({ p: t.project, kids: t.children || [] }))
      : (j.projects || []).map((p) => ({ p, kids: [] }));

    const items = entries.map(({ p, kids }) => {
      const s = j.statuses?.[p.id] || {};
      return {
        id: p.id, name: p.name, ports: p.probe?.ports || [],
        running: s.status === 'running', status: s.status || 'stopped',
        external: s.source === 'external',
        // 关过但还有端口/容器活着：托盘上必须能看见，否则用户以为已经关干净
        residual: !!s.residual && (((s.residual.ports || []).length) || ((s.residual.containers || []).length)),
        children: kids.map((c) => {
          const cs = j.statuses?.[c.id] || {};
          return { id: c.id, name: c.name, running: cs.status === 'running', status: cs.status || 'stopped' };
        }),
      };
    });
    const sig = JSON.stringify(items);
    if (force || sig !== projectSnapshot) {
      projectSnapshot = sig;
      projectItems = items;
      rebuildTrayMenu();
    }
    if (process.platform === 'darwin' && tray) {
      const n = items.filter((x) => x.running).length;
      tray.setTitle(n ? String(n) : '');
    }
  } catch { /* 后端未就绪时沿用上次快照 */ }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(tt('vaultTooltip', { s: vaultLocked ? tt('vaultLocked') : tt('vaultUnlocked') }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: tt('vaultLine', { s: vaultLocked ? tt('vaultLocked') : tt('vaultUnlocked') }), enabled: false },
      { type: 'separator' },
      { label: tt('runnerLine', { a: projectItems.filter((p) => p.running).length, b: projectItems.length }), enabled: false },
      ...projectMenuItems(),
      { type: 'separator' },
      { label: tt('openMain'), click: () => showMainWindow() },
      {
        label: tt('lockNow'),
        enabled: !vaultLocked,
        click: async () => {
          try {
            await fetch(`http://127.0.0.1:${PORT}/api/lock`, { method: 'POST' });
          } catch { /* 后端不在就算了 */ }
          await refreshLockState();
        },
      },
      { type: 'separator' },
      {
        label: tt('quit'),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  const icon2x = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate@2x.png'));
  icon.addRepresentation({ scaleFactor: 2, image: icon2x });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  // macOS 上 setContextMenu 会自动在点击时弹出菜单（项目状态/启停都在里面）；
  // 其它平台左键仍回主界面、右键出菜单
  tray.on('click', () => { if (process.platform !== 'darwin') showMainWindow(); });
  rebuildTrayMenu();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: tt('vault'),
    icon: path.join(__dirname, 'app-icon.png'),
    backgroundColor: '#1d1d1f',
    show: false,
    autoHideMenuBar: true, // 更像独立软件：隐藏菜单栏
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 只暴露 openExternal 一个能力（见 electron/preload.mjs）
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });
  win.once('ready-to-show', () => win.show()); // 就绪后再显示，避免白屏闪烁
  // 只允许留在本机应用页面：窗口被导航到外部站点后，仍带着对 127.0.0.1 的同源能力
  const appOrigin = isDev ? `http://127.0.0.1:${UI_PORT}` : `http://127.0.0.1:${PORT}`;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!String(url).startsWith(appOrigin)) e.preventDefault();
  });
  // 外部链接：只允许 http/https，交给系统浏览器打开（渲染层走 preload 的 openExternal）
  ipcMain.handle('fk:openExternal', async (_e, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return false;
    try {
      await shell.openExternal(target);
      return true;
    } catch {
      return false;
    }
  });
  // 这个应用不需要摄像头/麦克风/通知等任何浏览器权限，一律拒绝
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  } catch { /* 旧版本 Electron 忽略 */ }
  win.loadURL(appOrigin);
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  // 关窗行为：后台常驻（藏窗口留托盘）或退出程序，由设置页决定
  win.on('close', (e) => {
    if (quitting) return;
    if (appSettings.closeAction === 'background') {
      e.preventDefault();
      win.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });
}

app.whenReady().then(async () => {
  // macOS Dock 图标：开发模式下 Electron 默认显示自己的原子图标，运行时换成「密」
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'app-icon.png')); }
    catch (e) { console.warn('[electron] 设置 Dock 图标失败:', e?.message || String(e)); }
  }
  // 每次启动清一次 HTTP 缓存：保证桌面端永远加载最新前端代码（修复改版后看到的仍是旧界面）
  try { await session.defaultSession.clearCache(); } catch { /* 忽略 */ }
  // 先清掉上一轮残留的后端，再拉自己的 —— 这样改了后端代码重启就一定能生效
  if (!KEEP_EXISTING) {
    const r = await cleanupStaleBackend(PORT);
    if (r.cleaned) console.log(`[electron] 已清理残留后端 (PID ${r.pid})，将启动全新后端。`);
    else if (r.pid && r.reason.includes('非本应用')) {
      console.warn(`[electron] ${r.reason}，不处理。`);
      console.warn(`[electron] 如需保留它，请用其它端口：set PORT=8799 && npm run desktop`);
    }
  }

  if (await portOpen(PORT)) {
    // 走到这里说明端口仍被占：要么是被别的软件占，要么是旧进程没杀掉
    console.warn(`[electron] 端口 ${PORT} 仍被占用，将复用现有后端。`);
    console.warn('[electron] 若刚改过后端代码，新代码可能不会生效。');
    console.warn('[electron] 可手动清理：netstat -ano | findstr :8787  →  taskkill /PID <PID> /F /T');
  } else {
    startServer();
    try {
      await waitPort(PORT);
    } catch (e) {
      console.error('[electron] 后端未就绪：', e.message);
    }
  }
  createWindow();
  createTray();
  // 托盘状态与设置的轮询：状态变了重建菜单，设置变了改变关窗行为
  setInterval(() => {
    refreshLockState().catch(() => {});
    refreshSettings().catch(() => {});
  }, 10_000);
  refreshLockState().catch(() => {});
  refreshSettings().catch(() => {});
  refreshProjects().catch(() => {});
  setInterval(() => { refreshProjects().catch(() => {}); }, 5000);
  app.on('activate', () => showMainWindow());
}).catch((e) => {
  console.error('[electron] 启动失败:', e);
  app.quit();
});

// 多挂几个退出钩子：强退 / 崩溃时 before-quit 不一定触发，
// 残留的后端会一直占着端口，导致下次启动"复用旧后端"。
app.on('before-quit', () => {
  quitting = true;
  stopServer();
});
app.on('quit', () => stopServer());
app.on('window-all-closed', () => {
  // 正常路径下关窗被 close 拦截（后台）或已置 quitting（退出），
  // 走到这里说明窗口被外部销毁：跟随退出，避免留一个没有窗口的进程
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});
process.on('exit', () => stopServer());
process.on('SIGINT', () => { stopServer(); process.exit(0); });
process.on('SIGTERM', () => { stopServer(); process.exit(0); });
process.on('uncaughtException', (e) => {
  console.error('[electron] 未捕获异常:', e);
  stopServer();
});
