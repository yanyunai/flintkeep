// 轻量 HTTP 冒烟：验证 /api/backup/export 与 /api/backup/import（含错误口令 401）
const BASE = 'http://127.0.0.1:8787';
const wait = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/locked'); if (r.ok) return; } catch {}
    await new Promise(s => setTimeout(s, 300));
  }
  throw new Error('server not ready');
};
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

await wait();
// 1) 导出备份
const exp = await fetch(BASE + '/api/backup/export');
const expR = await j(exp);
assert(expR.status === 200 && expR.body.backup.includes('flintkeep-backup'), '导出备份 200 且含格式标记');

// 2) 用错误口令导入 → 401
const impBad = await fetch(BASE + '/api/backup/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ backup: expR.body.backup, passphrase: 'wrong-pp' }),
});
const impBadR = await j(impBad);
assert(impBadR.status === 401, '错误口令导入 → 401');

// 3) 用正确口令导入 → 200
const impOk = await fetch(BASE + '/api/backup/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ backup: expR.body.backup, passphrase: 'pp1' }),
});
const impOkR = await j(impOk);
assert(impOkR.status === 200 && impOkR.body.imported >= 0, '正确口令导入 → 200');

console.log(`\n备份 HTTP 冒烟：${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
