/**
 * 冒烟：项目启停闭环（体检 → 登记 → 启动 → 状态 → 预演 → 关闭 → 残留复检 → 关外部启动的进程）。
 * 全程在临时目录里跑，用两个高位端口，不碰真实 data/。
 */
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishi-smoke-data-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishi-smoke-proj-'));
const PORT = 18990;
const EXT_PORT = 18991;

let ok = 0;
let fail = 0;
function assert(c, m) {
  if (c) { ok++; console.log('  ✓', m); }
  else { fail++; console.error('  ✗', m); }
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一个「看起来有数据库依赖」的项目目录
fs.writeFileSync(path.join(projDir, 'docker-compose.yml'), [
  'name: smoketest',
  'services:',
  '    postgres:',
  '        image: pgvector/pgvector:pg14',
  '        ports:',
  '            - "18993:5432"',
  '    redis:',
  '        image: redis:8.2.2',
  '        ports:',
  '            - "127.0.0.1:18994:6379"',
  'volumes:',
  '    data:',
].join('\n'));
// 端口故意用不存在容器的号：.env 里写 5432 会命中真实 yanyun-pg，
// 冒烟时一旦触发停止会把开发用的数据库停掉（真实踩过一次）
fs.writeFileSync(path.join(projDir, '.env'), 'SERVER_PORT=18990\nDB_PORT=18997\n');
fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ scripts: { start: 'node x.js' } }));

// 启停测试用「干净目录」：没有 compose/.env，避免自动派生把真实容器拉起来
const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishi-smoke-plain-'));

const { initMcp, handleCall } = await import('../src/core/mcp.ts');
const { projectTree } = await import('../src/core/project-registrar.ts');
const { planStop } = await import('../src/core/project-runner.ts');
initMcp({ dataDir, passphrase: 'smoke-pass' });

async function call(name, args = {}) {
  const r = await handleCall(name, args);
  return { ok: !r.isError, j: JSON.parse(r.content[0].text) };
}

const children = [];
try {
  // 1) 体检
  const d = await call('project_discover', { cwd: projDir });
  const ids = d.j.suggestions.map((s) => s.id);
  assert(d.ok, 'project_discover 正常返回');
  assert(ids.some((x) => x.includes('postgres')), '扫出 compose 里的 postgres 服务');
  assert(ids.some((x) => x.includes('redis')), '扫出 compose 里的 redis 服务');
  const main = d.j.suggestions.find((s) => !s.id.includes('postgres') && !s.id.includes('redis'));
  assert(!!main?.dependsOn?.length, '主项目节点自动挂上依赖');

  // 2) 自动派生：只写主项目一条，程序应自己把 compose 里的 pg/redis 拆成子节点
  const auto = await call('project_upsert', {
    project: {
      id: 'smoke-auto',
      name: '自动派生验证',
      cwd: projDir,
      kind: 'process',
      commands: [{ cmd: 'node -e "0"', kind: 'service' }],
      probe: { ports: [18995], mode: 'any' },
    },
  });
  assert(auto.ok, '只写主项目即可登记成功（Agent 不用自己拆节点）');
  assert((auto.j.derived || []).length >= 2, `自动派生 ${auto.j.derived?.length || 0} 个子节点`);
  assert((auto.j.derived || []).some((d) => d.id.includes('postgres')), '派生结果含 postgres');
  assert((auto.j.children || []).length >= 2, '主项目回执里带 children');
  const tree = projectTree(dataDir);
  const card = tree.find((t) => t.project.id === 'smoke-auto');
  assert(!!card && card.children.length >= 2, '折叠树把子节点收在同一张卡下');

  // 只做关闭预演，绝不真执行：派生子节点里的容器名一旦撞上真实容器，执行就会误伤开发环境
  const planAuto = await planStop(dataDir, 'smoke-auto', { cascade: true });
  assert(!planAuto.error && planAuto.targets.length >= 3, '关闭主项目时自动把派生子节点一起纳入');

  // 3) 启停测试用干净目录，autoDiscover 关闭
  const up = await call('project_upsert', {
    autoDiscover: false,
    project: {
      id: 'smoke-app',
      name: '冒烟项目',
      cwd: plainDir,
      kind: 'process',
      commands: [{
        cmd: `node -e 'require("http").createServer((q,s)=>s.end("ok")).listen(${PORT})'`,
        kind: 'service',
      }],
      probe: { ports: [PORT], url: `http://127.0.0.1:${PORT}`, mode: 'any' },
      stopPolicy: 'cascade',
    },
  });
  assert(up.ok && up.j.saved, 'project_upsert 写入成功');

  // 3) 启动并等就绪
  const st = await call('project_start', { id: 'smoke-app', wait: true });
  assert(st.ok, 'project_start（wait=true）成功');
  assert(await portOpen(PORT), '启动后端口已监听');
  const s1 = await call('projects_status');
  const app = s1.j.statuses?.['smoke-app'];
  assert(app?.status === 'running', '状态为 running');
  assert(app?.source === 'managed', '标记为应用自身启动（managed）');

  // 4) 关闭预演
  const plan = await call('project_stop', { id: 'smoke-app' });
  assert(plan.ok && plan.j.stopped, 'project_stop 返回成功');
  assert(Array.isArray(plan.j.plan?.targets) && plan.j.plan.targets.length >= 1, '关闭回执里带将停清单');
  assert(Array.isArray(plan.j.residual), '关闭回执里带残留复检结果');
  assert((plan.j.residual || []).length === 0, '托管启动的项目能关干净（无残留）');
  assert(!(await portOpen(PORT)), '关闭后端口已释放');

  // 5) 外部启动的进程也能被关掉（模拟「不是你启动的，但我能关」）
  const ext = spawn('node', ['-e', `require("http").createServer((q,s)=>s.end("x")).listen(${EXT_PORT})`], {
    cwd: plainDir, detached: true, stdio: 'ignore',
  });
  children.push(ext);
  ext.unref();
  for (let i = 0; i < 20 && !(await portOpen(EXT_PORT)); i++) await sleep(150);
  assert(await portOpen(EXT_PORT), '外部进程已在监听 18991');

  await call('project_upsert', {
    autoDiscover: false,
    project: {
      id: 'smoke-ext',
      name: '外部启动项目',
      cwd: plainDir,
      kind: 'process',
      commands: [{ cmd: 'node -e "0"', kind: 'service' }],
      probe: { ports: [EXT_PORT], mode: 'any' },
      stopPolicy: 'self',
    },
  });
  const s2 = await call('projects_status');
  assert(s2.j.statuses?.['smoke-ext']?.status === 'running', '未登记运行方式的项目被自动识别为运行中');
  assert(s2.j.statuses?.['smoke-ext']?.source === 'external', '识别为外部启动（external）');

  const stopExt = await call('project_stop', { id: 'smoke-ext', cascade: false });
  assert(stopExt.ok, '外部启动的项目关闭成功');
  await sleep(500);
  assert(!(await portOpen(EXT_PORT)), '外部进程已被关闭（按端口反查 + 归属校验）');
} catch (e) {
  fail++;
  console.error('  ✗ 冒烟异常：', e?.message || e);
} finally {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* ignore */ } }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(plainDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n结果：${ok} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
