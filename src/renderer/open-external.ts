/**
 * 在系统浏览器里打开链接。
 *
 * 三种运行形态：
 * - **Electron（生产/桌面）**：窗口禁止新窗口与外部导航，必须走 preload 暴露的
 *   `window.flintkeep.openExternal`（主进程会再校验协议）。
 * - **浏览器直开（`npm run dev` 的 8790）**：没有 preload，用 window.open 新标签页。
 * - **都没有**（极端情况）：返回 false，调用方负责把地址显示出来让用户手动复制。
 */
type FkBridge = { openExternal?: (url: string) => Promise<boolean> | boolean };

export async function openExternal(url: string): Promise<boolean> {
  const target = String(url || '').trim();
  // 只放行 http/https：本地 file:// 或自定义协议一律拒绝，避免这条通道被当成执行入口
  if (!/^https?:\/\//i.test(target)) return false;

  const bridge = (globalThis as { flintkeep?: FkBridge }).flintkeep;
  if (bridge?.openExternal) {
    try {
      return Boolean(await bridge.openExternal(target));
    } catch {
      return false;
    }
  }

  try {
    const w = window.open(target, '_blank', 'noopener,noreferrer');
    return Boolean(w);
  } catch {
    return false;
  }
}
