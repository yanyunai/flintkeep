/** 冒烟：startAppServer + /api/locked 在未解锁时应返回 locked:true */
process.env.PORT = '18787';
process.env.PROXY_PORT = '18788';
process.env.SSH_PROXY_PORT = '18789';
import path from 'path';
import { fileURLToPath } from 'url';
process.env.VAULT_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-smoke-tmp');

const { startAppServer, stopAppServer } = await import('../server.ts');

let ok = 0;
let fail = 0;
function assert(c, m) {
  if (c) { ok++; console.log('  ✓', m); }
  else { fail++; console.error('  ✗', m); }
}

try {
  const { port } = await startAppServer();
  assert(port === 18787, '监听端口为 18787');
  const r = await fetch('http://127.0.0.1:18787/api/locked');
  const j = await r.json();
  assert(r.status === 200, 'GET /api/locked → 200');
  assert(j.locked === true, '未解锁时 locked === true');
  await stopAppServer();
} catch (e) {
  fail++;
  console.error('  ✗ 冒烟失败:', e.message);
  try { await stopAppServer(); } catch {}
}

console.log(`\n结果：${ok} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
