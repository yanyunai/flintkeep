/** 冒烟：白名单模块 REST（绑定增删改查 / 执行不崩溃 / 审计留痕） */
process.env.PORT = '18797';
process.env.PROXY_PORT = '18798';
process.env.SSH_PROXY_PORT = '18799';
process.env.VAULT_PASSPHRASE = 'smoke-wl-passphrase';

import path from 'path';
import { fileURLToPath } from 'url';
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.VAULT_DATA_DIR = path.join(base, 'data-smoke-wl-tmp');

const { startAppServer, stopAppServer } = await import('../server.ts');

let ok = 0;
let fail = 0;
function assert(c, m) {
  if (c) { ok++; console.log('  ✓', m); }
  else { fail++; console.error('  ✗', m); }
}
const B = 'http://127.0.0.1:18797';
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

  // 0) 解锁（VAULT_PASSPHRASE 已自动解锁，这里显式确认一次）
  const un = await json('POST', '/api/unlock', { passphrase: 'smoke-wl-passphrase' });
  assert(un.status === 200, 'POST /api/unlock → 200');

  // 1) 初始为空
  const l0 = await json('GET', '/api/whitelist/bindings');
  assert(l0.status === 200 && Array.isArray(l0.body) && l0.body.length === 0, 'GET /api/whitelist/bindings 初始为空');

  // 2) 缺字段 → 400
  const bad = await json('POST', '/api/whitelist/bindings', { provider: 'aliyun' });
  assert(bad.status === 400, '缺少 provider/assetId/region → 400');

  // 3) 先建一个云账号资产
  const asset = await json('POST', '/api/assets', {
    type: 'cloud_account',
    name: 'smoke-aliyun',
    provider: 'aliyun',
    accessKeyId: 'SMOKE_AK',
    secretAccessKey: 'SMOKE_SK',
    region: 'cn-hangzhou',
    tags: [],
  });
  assert(asset.status === 200 && !!asset.body.id, '创建云账号资产成功');

  // 4) 新增绑定
  const cr = await json('POST', '/api/whitelist/bindings', {
    provider: 'aliyun',
    assetId: asset.body.id,
    region: 'cn-hangzhou',
    prefixListId: 'pl-smoke',
  });
  assert(cr.status === 200 && cr.body.provider === 'aliyun' && !!cr.body.id, 'POST 新增白名单绑定成功');
  assert(!JSON.stringify(cr.body).includes('SMOKE_SK'), '绑定响应不含任何密钥');

  // 5) 列表有 1 条
  const l1 = await json('GET', '/api/whitelist/bindings');
  assert(l1.body.length === 1, 'GET 列表返回 1 条绑定');

  // 6) 停用
  const off = await json('PUT', '/api/whitelist/bindings/' + cr.body.id, { enabled: false });
  assert(off.status === 200 && off.body.enabled === false, 'PUT 停用绑定生效');

  // 7) 执行：无网络时应返回失败结果而不是 500 崩溃
  const run = await json('POST', '/api/whitelist/run', { id: cr.body.id });
  assert(run.status === 200, 'POST /api/whitelist/run → 200（未因网络失败而崩溃）');
  assert(Array.isArray(run.body.results) && run.body.results.length === 1, '返回 1 条执行结果');
  assert(run.body.results[0].ok === false && !!run.body.results[0].message, '离线环境下结果标记为失败并给出原因');

  // 8) 审计留痕
  const logs = await json('GET', '/api/whitelist/logs');
  assert(logs.status === 200 && Array.isArray(logs.body) && logs.body.length >= 1, 'GET /api/whitelist/logs 有执行记录');
  assert(logs.body.every((e) => e.action === 'whitelist_update'), '执行记录均为 whitelist_update');

  // 8.5) 定时调度
  const s0 = await json('GET', '/api/whitelist/schedule');
  assert(s0.status === 200 && s0.body.enabled === false, 'GET /api/whitelist/schedule 默认未启用');
  const s1 = await json('PUT', '/api/whitelist/schedule', { enabled: true, intervalMinutes: 15 });
  assert(s1.status === 200 && s1.body.enabled === true && s1.body.intervalMinutes === 15, 'PUT 启用定时（15 分钟）');
  assert(typeof s1.body.nextRunAt === 'number' && s1.body.nextRunAt > Date.now(), '启用后自动排定下次运行时间');
  const s2 = await json('PUT', '/api/whitelist/schedule', { enabled: false });
  assert(s2.body.enabled === false && !s2.body.nextRunAt, '停用后清除下次运行时间');

  // 9) 删除
  const del = await json('DELETE', '/api/whitelist/bindings/' + cr.body.id);
  assert(del.status === 200 && del.body.deleted === true, 'DELETE 删除绑定成功');
  const l2 = await json('GET', '/api/whitelist/bindings');
  assert(l2.body.length === 0, '删除后列表为空');

  await stopAppServer();
} catch (e) {
  fail++;
  console.error('  ✗ 冒烟失败:', e.message);
  try { await stopAppServer(); } catch {}
}

console.log(`\n结果：${ok} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
