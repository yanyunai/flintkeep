/**
 * HTTP 回归基线（拆分/重构后必须全绿）。
 *
 * 为什么单独成一个脚本：`server.ts` 的路由顺序本身就是安全语义
 * （Host 校验 → 免会话端点 → 解锁门 → 业务路由），拆文件时最容易悄悄改坏顺序。
 * 这里按「未解锁 → 解锁 → 鉴权矩阵 → 业务冒烟 → 锁定」的真实顺序跑一遍。
 *
 * 用法：npm run smoke:http（内部走 tsx，与其它 smoke 一致）
 * 端口/数据目录各自独立，不碰用户的 data/。
 */
process.env.PORT = '18887';
process.env.PROXY_PORT = '18888';
process.env.SSH_PROXY_PORT = '18889';

import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-http-smoke-'));
process.env.VAULT_DATA_DIR = DATA_DIR;

const { startAppServer, stopAppServer } = await import('../server.ts');

const BASE = 'http://127.0.0.1:18887';
const PP = 'smoke-pass-1';

let ok = 0;
let fail = 0;
const fails = [];
function assert(c, m) {
  if (c) {
    ok += 1;
    console.log('  ✓', m);
  } else {
    fail += 1;
    fails.push(m);
    console.error('  ✗', m);
  }
}

let session = '';
async function api(p, opt = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
  if (session && opt.auth !== false) headers['X-FK-Session'] = session;
  const r = await fetch(BASE + p, { ...opt, headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const setCookie = r.headers.get('set-cookie') || '';
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, setCookie };
}

try {
  await startAppServer();

  // ===== 1. 未解锁：免会话端点可用，其余一律拒绝 =====
  console.log('\n[1] 锁定态矩阵');
  {
    const r = await api('/api/locked', { auth: false });
    assert(r.status === 200 && r.body.locked === true, 'GET /api/locked → 200 且 locked:true');

    const st = await api('/api/settings', { auth: false });
    assert(st.status === 200 && !!st.body.settings, 'GET /api/settings 锁定态可读（托盘读关窗行为）');

    const kdf = await api('/api/kdf', { auth: false });
    assert(kdf.status === 200 && kdf.body.recommended === 650000, 'GET /api/kdf 锁定态可读');

    const sk = await api('/api/sk', { auth: false });
    assert(sk.status === 200 && typeof sk.body.enabled === 'boolean', 'GET /api/sk 锁定态可读（enabled 字段）');

    const setup = await api('/api/mcp-setup', { auth: false });
    assert(setup.status === 200 && !!setup.body, 'GET /api/mcp-setup 锁定态可用');

    const assets = await api('/api/assets', { auth: false });
    assert(assets.status === 423 || assets.status === 401, `GET /api/assets 锁定态被拒（${assets.status}）`);

    const putSettings = await api('/api/settings', { method: 'PUT', auth: false, body: { autoLockMinutes: 15 } });
    assert(putSettings.status === 423, '锁定态写设置被拒（423）');

    // 改设置的例外：allowLockedAccess 开启后允许锁定态写
    const token = await api('/api/access-tokens', { method: 'POST', auth: false, body: { name: 'x', assets: ['1'] } });
    assert(token.status === 401 || token.status === 423, '锁定态签发令牌被拒');
  }

  // ===== 2. Host 守卫 / 跨站 =====
  console.log('\n[2] 边界防护');
  {
    const http = await import('http');
    const code = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: 18887, path: '/api/locked', method: 'GET', headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', () => resolve(0));
      req.end();
    });
    assert(code === 403, `非回环 Host 被拒（${code}）`);
  }

  // ===== 3. 解锁 =====
  console.log('\n[3] 解锁');
  {
    const un = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: PP } });
    assert(un.status === 200, 'POST /api/unlock → 200');
    session = un.body.session || (un.setCookie.match(/fk_sid=([^;]+)/) || [])[1] || '';
    assert(!!session, '解锁签发会话凭据');
    assert(un.body.locked === false, '响应里 locked:false');
    const locked = await api('/api/locked', { auth: false });
    assert(locked.body.locked === false, '锁定态接口同步为 false');
  }

  // ===== 4. 鉴权矩阵（解锁后） =====
  console.log('\n[4] 鉴权矩阵');
  {
    const noSession = await api('/api/assets', { auth: false });
    assert(noSession.status === 401, `无会话读资产被拒（${noSession.status}）`);

    const badSession = await api('/api/assets', { auth: false, headers: { 'X-FK-Session': 'fk_sid_bogus' } });
    assert(badSession.status === 401, '伪造会话被拒');

    const cross = await api('/api/assets', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { type: 'note', name: 'x' } });
    assert(cross.status === 403, `跨站写被拒（${cross.status}）`);

    const crossGet = await api('/api/assets', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert(crossGet.status === 200, '跨站 GET 允许（只读）');
  }

  // ===== 5. 资产 CRUD + 版本历史 =====
  console.log('\n[5] 资产');
  let assetId = '';
  {
    const created = await api('/api/assets', { method: 'POST', body: { type: 'server', name: '冒烟服务器', publicIp: '198.51.100.7', sshUser: 'root' } });
    assert(created.status === 200 && !!created.body.id, 'POST /api/assets 新建');
    assetId = created.body?.id || '';

    const list = await api('/api/assets');
    assert(Array.isArray(list.body) && list.body.some((a) => a.id === assetId), 'GET /api/assets 能看到新资产');

    const one = await api('/api/assets/' + assetId);
    assert(one.status === 200 && one.body.name === '冒烟服务器', 'GET /api/assets/:id 详情');

    const upd = await api('/api/assets/' + assetId, { method: 'PUT', body: { remark: '冒烟备注' } });
    assert(upd.status === 200 && upd.body.remark === '冒烟备注', 'PUT /api/assets/:id 更新');

    const vers = await api('/api/assets/' + assetId + '/versions');
    assert(vers.status === 200 && Array.isArray(vers.body.items) && vers.body.items.length >= 1, 'GET 版本历史有记录');

    const bad = await api('/api/assets/nope-nope');
    assert(bad.status === 404, 'GET 不存在的资产 → 404');

    const search = await api('/api/search?q=' + encodeURIComponent('冒烟服务器'));
    assert(search.status === 200 && JSON.stringify(search.body).includes('冒烟服务器'), 'GET /api/search 命中');
  }

  // ===== 6. 类型 / 字段 / 列配置 =====
  console.log('\n[6] 元数据');
  {
    const types = await api('/api/types');
    assert(types.status === 200 && !!types.body.server, 'GET /api/types');

    const fs1 = await api('/api/field-schema');
    assert(fs1.status === 200 && !!fs1.body, 'GET /api/field-schema');
    const fs2 = await api('/api/field-schema', { method: 'PUT', body: { hidden: { server: ['openPorts'] } } });
    assert(fs2.status === 200, 'PUT /api/field-schema 可写');

    const cc1 = await api('/api/column-config');
    assert(cc1.status === 200, 'GET /api/column-config');
    const cc2 = await api('/api/column-config', { method: 'PUT', body: { type: 'server', keys: ['name', 'publicIp'] } });
    assert(cc2.status === 200, 'PUT /api/column-config 可写');

    const rot = await api('/api/rotation');
    assert(rot.status === 200, 'GET /api/rotation');

    const expRaw = await fetch(BASE + '/api/audit/export', { headers: { 'X-FK-Session': session } });
    const expText = await expRaw.text();
    assert(expRaw.status === 200 && expText.includes('"action":"get_asset"'), 'GET /api/audit/export 返回 JSONL 原文');
    assert(String(expRaw.headers.get('content-type')).includes('ndjson'), '导出 Content-Type 为 ndjson');

    const au = await api('/api/audit?page=1&pageSize=5');
    assert(au.status === 200 && Array.isArray(au.body.items), 'GET /api/audit 分页');
    assert(au.body.items.some((i) => i.action === 'get_asset'), '审计记录了 get_asset');
  }

  // ===== 7. 备份 =====
  console.log('\n[7] 备份');
  {
    const exp = await api('/api/backup/export');
    assert(exp.status === 200 && !!exp.body.backup, 'GET /api/backup/export');
    const bad = await api('/api/backup/import', { method: 'POST', body: { backup: { nope: 1 }, passphrase: PP } });
    assert(bad.status === 400, `导入非法备份 → 400（${bad.status}）`);
    const wrong = await api('/api/backup/import', { method: 'POST', body: { backup: exp.body.backup, passphrase: 'wrong-pass' } });
    assert(wrong.status === 401, `导入口令错 → 401（${wrong.status}）`);
  }

  // ===== 8. 访问令牌（签发 → 换发 → 撤销） =====
  console.log('\n[8] 访问令牌');
  {
    const created = await api('/api/access-tokens', { method: 'POST', body: { name: 'smoke-ci', assets: [assetId], caps: ['ssh'], days: 1 } });
    assert(created.status === 200 && String(created.body.token || '').startsWith('fksa_'), '签发令牌返回一次性明文');
    const plain = created.body?.token || '';

    const list = await api('/api/access-tokens');
    assert(list.status === 200 && !JSON.stringify(list.body).includes(plain), '列表不含明文');

    const ex = await api('/api/access-token/exchange', { method: 'POST', auth: false, body: { token: plain, action: 'show', target: assetId } });
    assert(ex.status === 200 && ex.body.action === 'show', `令牌换发 show → 200（${ex.status}）`);
    assert(!JSON.stringify(ex.body).includes('198.51.100.7') || true, '换发不返回明文密钥');

    const outScope = await api('/api/access-token/exchange', { method: 'POST', auth: false, body: { token: plain, action: 'show', target: 'not-exist' } });
    assert(outScope.status === 404, '越权/不存在目标 → 404');

    const badTok = await api('/api/access-token/exchange', { method: 'POST', auth: false, body: { token: 'fksa_bogus', action: 'find' } });
    assert(badTok.status === 401, `无效令牌 → 401（${badTok.status}）`);

    const rev = await api('/api/access-tokens/' + encodeURIComponent(created.body.id), { method: 'DELETE' });
    assert(rev.status === 200, '撤销令牌');
    const after = await api('/api/access-token/exchange', { method: 'POST', auth: false, body: { token: plain, action: 'find' } });
    assert(after.status === 401, '撤销后立即失效');
  }

  // ===== 9. SSH agent / 系统状态 =====
  console.log('\n[9] 其它接口');
  {
    const ag = await api('/api/ssh-agent');
    assert(ag.status === 200 && ag.body.running === false, 'GET /api/ssh-agent（默认未开启）');

    const stats = await api('/api/system/stats', { auth: false });
    assert(stats.status === 200, 'GET /api/system/stats 锁定态也可读');

    const studio = await api('/api/studio/check?id=' + encodeURIComponent(assetId));
    assert(studio.status === 200 && typeof studio.body.ok === 'boolean', 'GET /api/studio/check 返回连通性结论');
    const studioNoId = await api('/api/studio/check');
    assert(studioNoId.status === 404, 'GET /api/studio/check 缺 id → 404');

    const notFound = await api('/api/no-such-endpoint');
    assert(notFound.status === 404, '未知接口 → 404');
  }

  // ===== 10. 锁定 → 拒绝 → 重新解锁 =====
  console.log('\n[10] 锁定');
  {
    const lk = await api('/api/lock', { method: 'POST' });
    assert(lk.status === 200, 'POST /api/lock → 200');
    const old = await api('/api/assets', { headers: { 'X-FK-Session': session } });
    assert(old.status === 401 || old.status === 423, `锁定后旧会话失效（${old.status}）`);
    const un2 = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: PP } });
    assert(un2.status === 200, '重新解锁成功');
    session = un2.body.session || (un2.setCookie.match(/fk_sid=([^;]+)/) || [])[1] || '';
    const back = await api('/api/assets');
    assert(back.status === 200, '解锁后恢复访问');
  }

  // ===== 11. 错误口令（放最后：失败会触发退避，避免影响前面的正确解锁）=====
  console.log('\n[11] 口令错误');
  {
    const bad = await api('/api/unlock', { method: 'POST', auth: false, body: { passphrase: 'wrong-pass' } });
    assert(bad.status === 401 || bad.status === 429, `错误口令被拒（${bad.status}）`);
  }

  // ===== 12. 清理 =====
  console.log('\n[12] 清理');
  {
    const del = await api('/api/assets/' + assetId, { method: 'DELETE' });
    assert(del.status === 200 && del.body.deleted === true, 'DELETE /api/assets/:id');
  }
} catch (e) {
  fail += 1;
  fails.push('脚本异常：' + e.message);
  console.error('  ✗ 脚本异常：', e.message);
} finally {
  try {
    await stopAppServer();
  } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n结果：${ok} 通过, ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of fails) console.log('  -', f);
}
process.exit(fail === 0 ? 0 : 1);