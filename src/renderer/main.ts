import { createApp } from 'vue';
import App from './App.vue';
// 黑曜模板：只作用于 #mgui 子树（脚本生成，选择器都带 #mgui 前缀），
// 不影响现有界面的类名与 token。
import './styles/ui/base.css';
import './styles/ui/tpl-obsidian.css';
import './styles/ui/tpl-atlas.css';

const app = createApp(App);

/**
 * 渲染异常兜底：Vue 组件里抛错会卸载整棵子树，用户看到的就是「整页白屏」。
 * 这里至少给一条可见提示 + 重载入口，而不是让人对着空白猜是数据丢了还是卡了。
 * 只出一次：连续抛错时不要把屏幕铺满。
 */
let fatalShown = false;
function showFatalOnce(): void {
  if (fatalShown) return;
  fatalShown = true;
  const zh = String(navigator.language || '')
    .toLowerCase()
    .startsWith('zh');
  const box = document.createElement('div');
  box.id = 'fk-fatal';
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:50%',
    'top:18px',
    'transform:translateX(-50%)',
    'max-width:min(560px,92vw)',
    'padding:14px 16px',
    'border-radius:12px',
    'background:#1d1d1f',
    'color:#f5f5f7',
    'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 12px 40px rgba(0,0,0,.45)',
    'display:flex',
    'gap:12px',
    'align-items:center',
  ].join(';');
  const text = document.createElement('p');
  text.style.cssText = 'margin:0;flex:1';
  text.textContent = zh
    ? '界面渲染出错，数据没有丢。请重新加载窗口。'
    : 'Interface error — your data is safe. Please reload the window.';
  const btn = document.createElement('button');
  btn.style.cssText =
    'flex:0 0 auto;padding:6px 12px;border-radius:8px;border:1px solid #48484a;background:#2c2c2e;color:#f5f5f7;cursor:pointer';
  btn.textContent = zh ? '重新加载' : 'Reload';
  btn.addEventListener('click', () => location.reload());
  box.appendChild(text);
  box.appendChild(btn);
  document.body.appendChild(box);
}

app.config.errorHandler = (err, _instance, info) => {
  console.error('[render]', info, err);
  showFatalOnce();
};

window.addEventListener('unhandledrejection', (ev) => {
  // 接口层的预期失败（ApiError）已在请求层处理完（切锁屏 / 顶部断线提示），
  // 这里只留日志，不再弹兜底层，避免把可恢复错误说成「界面坏了」。
  console.error('[promise]', ev.reason);
});

app.mount('#app');
