/** 冒烟：备忘录 —— 备忘录页用 ?type=note 能取到，资产清单（不带 type）不含备忘录 */
process.env.PORT = '18897';
process.env.PROXY_PORT = '18898';
process.env.SSH_PROXY_PORT = '18899';
process.env.VAULT_PASSPHRASE = 'smoke-memo-pass';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.VAULT_DATA_DIR = path.join(base, 'data-smoke-memo-tmp');
// 每次跑清空临时数据目录，保证断言可重复（否则备忘会跨次累积）
fs.rmSync(process.env.VAULT_DATA_DIR, { recursive: true, force: true });

const { startAppServer, stopAppServer } = await import('../server.ts');

let ok = 0;
let fail = 0;
function assert(c, m) {
  if (c) { ok++; console.log('  ✓', m); }
  else { fail++; console.error('  ✗', m); }
}
const B = 'http://127.0.0.1:18897';
async function json(method, p, body) {
  const r = await fetch(B + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  await startAppServer();

  // 建一条备忘录 + 一条普通资产
  const note = await json('POST', '/api/assets', {
    type: 'note', name: 'smoke-备忘', content: '正文内容', tags: [],
  });
  assert(note.status === 200 && note.body.type === 'note', '创建备忘录成功');

  const srv = await json('POST', '/api/assets', {
    type: 'server', name: 'smoke-server', publicIp: '10.0.0.9', tags: [],
  });
  assert(srv.status === 200 && srv.body.type === 'server', '创建普通资产成功');

  // 资产清单（不带 type）不应含备忘录
  const all = await json('GET', '/api/assets');
  assert(all.status === 200 && Array.isArray(all.body), 'GET /api/assets 返回列表');
  assert(all.body.some((a) => a.type === 'server'), '资产清单含普通资产');
  assert(!all.body.some((a) => a.type === 'note'), '资产清单不含备忘录（type=note 已排除）');

  // 备忘录页显式 ?type=note 仍可取到
  const notes = await json('GET', '/api/assets?type=note');
  assert(notes.status === 200 && notes.body.length === 1, 'GET ?type=note 返回 1 条备忘录');
  assert(notes.body[0].content === '正文内容', '备忘录正文可读');

  // 模糊搜索：应命中普通资产，且结果不含备忘录
  const s1 = await json('GET', '/api/search?q=smoke-server');
  assert(s1.status === 200 && s1.body.some((a) => a.name === 'smoke-server'), '模糊搜索按名称命中');
  const s2 = await json('GET', '/api/search?q=smoke');
  assert(s2.body.some((a) => a.type === 'server'), '模糊搜索命中普通资产');
  assert(!s2.body.some((a) => a.type === 'note'), '搜索结果不含备忘录');
  const s3 = await json('GET', '/api/search?q=');
  assert(s3.status === 200 && Array.isArray(s3.body) && s3.body.length === 0, '空关键词返回空列表');

  await stopAppServer();
} catch (e) {
  fail++;
  console.error('  ✗ 冒烟失败:', e.message);
  try { await stopAppServer(); } catch {}
}

console.log(`\n结果：${ok} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
