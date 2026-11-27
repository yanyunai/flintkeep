// 端到端 HTTP 冒烟：server.ts 解锁 → 代理签发令牌 → 经代理转发（真实密钥被注入）
import http from 'http';

const PORT = 8787;
const PROXY_PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const NO_PROXY = 'localhost,127.0.0.1';

const wait = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/locked', { headers: { 'no-proxy': NO_PROXY } }); if (r.ok) return; } catch {}
    await new Promise(s => setTimeout(s, 300));
  }
  throw new Error('server not ready');
};
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

// 本地回显目标
const echoPort = 18999;
const echo = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, headers: req.headers, url: req.url }));
});
await new Promise(r => echo.listen(echoPort, r));

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

await wait();

// 新增一个 api_key 资产（带 baseUrl + proxyInject）
const addR = await j(await fetch(BASE + '/api/assets', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'no-proxy': NO_PROXY },
  body: JSON.stringify({ type: 'api_key', name: 'svc-e2e', username: 'u', secret: 'E2E_SECRET_9', baseUrl: `http://127.0.0.1:${echoPort}`, proxyInject: { mode: 'header', headerName: 'X-API-Key' } }),
}));
assert(addR.status === 200 && addR.body.id, '新增 api_key 资产成功');
const assetId = addR.body.id;

// 签发代理令牌
const issR = await j(await fetch(BASE + '/api/proxy/issue', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'no-proxy': NO_PROXY },
  body: JSON.stringify({ assetId }),
}));
assert(issR.status === 200 && issR.body.token && issR.body.proxyBase.includes(String(PROXY_PORT)), 'REST 签发代理令牌成功');
const token = issR.body.token;

// 经代理访问 → 回显目标应收到注入的 X-API-Key
const fwd = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PROXY_PORT}/${assetId}/v1/ping?tok=${token}`, { headers: { 'no-proxy': NO_PROXY } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d)));
  }).on('error', reject);
});
assert(fwd.headers['x-api-key'] === 'E2E_SECRET_9', '代理转发时真实密钥被注入 (X-API-Key)');
assert(fwd.url === '/v1/ping', '代理保留子路径');

// 无效令牌 → 403
const bad = await new Promise((resolve) => {
  http.get(`http://127.0.0.1:${PROXY_PORT}/${assetId}/x?tok=bogus`, { headers: { 'no-proxy': NO_PROXY } }, (r) => resolve(r.statusCode || 0)).on('error', () => resolve(0));
});
assert(bad === 403, '无效令牌经代理 → 403');

// 审计应包含 proxy_access
const auditR = await j(await fetch(BASE + '/api/audit', { headers: { 'no-proxy': NO_PROXY } }));
assert(auditR.body.some(e => e.action === 'proxy_access'), '审计含 proxy_access 记录');

echo.close();
console.log(`\n代理 HTTP 冒烟：${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
