/**
 * Electron preload：只暴露一个能力——用系统浏览器打开外部链接。
 *
 * 为什么需要：主进程明确禁止了新窗口（setWindowOpenHandler → deny）与非应用域导航
 * （will-navigate 拦截），这是安全设计，不能为了「点链接」就放开。渲染层要把
 * GitHub / 官网 / 下载页交给系统浏览器，只能走一条窄口径 IPC。
 *
 * 安全边界：主进程侧再校验一次协议（只允许 http/https），渲染层传入什么都不能让它
 * 打开 file:// 或任意可执行路径。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('flintkeep', {
  /** 打开外部链接；返回是否成功（失败不抛，界面自行提示） */
  openExternal: (url) => ipcRenderer.invoke('fk:openExternal', String(url)),
});
