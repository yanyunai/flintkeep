#!/usr/bin/env node
/**
 * MCP 回归基线：用 5 个固定任务跑一遍，记录「调用次数 + 响应体积」。
 *
 * 为什么需要：工具面优化最容易退化成"感觉快了一点"。把 5 个典型任务固化成脚本后，
 * 每次改工具都能对比同一组数字，超标直接非零退出，CI 里也能跑。
 *
 * 用法：
 *   BASELINE_DATA_DIR=/path/to/copy VAULT_PASSPHRASE=... npm run mcp:baseline
 *
 * 注意：
 * - 请指向数据目录的**副本**：任务会签发短期令牌（ssh/proxy），并写审计与令牌文件。
 * - MCP_ENTRY 默认 `src/core/mcp.ts`（用 tsx 跑）；传 `.js` 则用 node 直跑编译产物，
 *   便于在没有 esbuild 的环境里验证。
 * - 预算：默认只允许 v2 的 9 个工具（tools/list ≤ 5KB）；若打开「完整工具集」，
 *   把 BASELINE_FULL=1 传进来，预算放宽到 20KB。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.BASELINE_DATA_DIR || '';
const pass = process.env.VAULT_PASSPHRASE || '';
const entry = process.env.MCP_ENTRY || path.join(root, 'src', 'core', 'mcp.ts');
const full = process.env.BASELINE_FULL === '1';
// 预算按 UTF-8 字节算（中文一个字 3 字节）；core 目标 ≤5KB，full 是显式开启的，放宽到 24KB
const listBudget = full ? 24000 : 5000;
const callBudget = 6;

if (!dataDir || !pass) {
  console.error('需要 BASELINE_DATA_DIR（数据目录副本）与 VAULT_PASSPHRASE（主口令）');
  process.exit(2);
}
if (!fs.existsSync(dataDir)) {
  console.error(`数据目录不存在：${dataDir}`);
  process.exit(2);
}

const isJs = entry.endsWith('.js');
// 传 realpath：MCP 入口用 import.meta.url 判断"是否直接运行"，
// /tmp → /private/tmp 这类软链会让字面路径对不上，进程静默退出。
const entryPath = isJs ? fs.realpathSync(entry) : entry;
// 关键：必须显式把数据目录与口令传进去，否则 MCP 会去读仓库默认的 ./data
const childEnv = {
  ...process.env,
  VAULT_DATA_DIR: dataDir,
  VAULT_PASSPHRASE: pass,
};
const child = isJs
  ? spawn(process.execPath, [entryPath], { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry], {
      cwd: root,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});

let seq = 1;
function rpc(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`超时：${method}`)), 20000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function parse(result) {
  const text = result?.result?.content?.[0]?.text || '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（老工具）保持 null */
  }
  return { text, json, isError: result?.result?.isError === true, bytes: Buffer.byteLength(text, 'utf8') };
}

const results = [];
async function task(name, fn) {
  let calls = 0;
  const call = async (tool, args) => {
    calls += 1;
    return parse(await rpc('tools/call', { name: tool, arguments: args || {} }));
  };
  try {
    const info = await fn(call);
    results.push({ task: name, calls, bytes: info?.bytes ?? 0, ok: !info?.isError, note: info?.note || '' });
  } catch (e) {
    results.push({ task: name, calls, bytes: 0, ok: false, note: e.message });
  }
}

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'baseline', version: '1' } });
  const list = await rpc('tools/list', {});
  const tools = list?.result?.tools || [];
  const listBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  const names = tools.map((t) => t.name);
  const has = (t) => names.includes(t);

  let first = null;
  let sshTarget = null;
  let proxyTarget = null;

  await task('find', async (call) => {
    const r = await call('find', {});
    first = r.json?.items?.[0] || null;
    const items = r.json?.items || [];
    // 优先服务器（有主机地址）；只有 ssh_key 时要确认它自带 sshHost，否则签发会失败
    sshTarget = items.find((x) => x.type === 'server')?.name
      || items.find((x) => x.type === 'ssh_key' && x.hint)?.name
      || null;
    proxyTarget = items.find((x) => ['cloud_account', 'oss', 'baota', 'api_key'].includes(x.type))?.name || null;
    return r;
  });

  await task('connect(ssh)', async (call) => {
    if (!has('connect') || !sshTarget) return { ok: true, bytes: 0, note: '跳过（无服务器类资产）' };
    const r = await call('connect', { target: sshTarget });
    return { ...r, note: r.json?.mode || '' };
  });

  await task('connect(proxy)', async (call) => {
    if (!has('connect') || !proxyTarget) return { ok: true, bytes: 0, note: '跳过（无代理类资产）' };
    const r = await call('connect', { target: proxyTarget });
    return { ...r, note: r.json?.mode || '' };
  });

  await task('show', async (call) => {
    if (!first) return { ok: true, bytes: 0, note: '跳过（库为空）' };
    const r = await call('show', { target: first.id, fields: ['id', 'type', 'name', 'no', 'tags'] });
    return r;
  });

  await task('run_project(status)', async (call) => {
    if (!has('run_project')) return { ok: true, bytes: 0, note: '只读档位/无此工具' };
    const r = await call('run_project', { action: 'status' });
    return r;
  });

  const totalCalls = results.reduce((s, r) => s + r.calls, 0);
  const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
  const violations = [];
  if (listBytes > listBudget) violations.push(`tools/list ${listBytes}B > ${listBudget}B`);
  if (totalCalls > callBudget) violations.push(`调用总数 ${totalCalls} > ${callBudget}`);
  for (const r of results) if (!r.ok) violations.push(`${r.task} 失败（${r.note}）`);

  const report = {
    at: new Date().toISOString(),
    profile: full ? 'full' : 'core',
    tools: { count: tools.length, listBytes, names },
    tasks: results,
    totalCalls,
    totalBytes,
    violations,
  };

  const out = process.env.BASELINE_OUT || path.join(root, 'data', 'mcp-baseline.json');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  } catch {
    /* 写不进就只打印 */
  }

  console.log(`\nMCP 基线（${report.profile}）  工具 ${tools.length} 个 / ${listBytes} B（UTF-8）`);
  console.log('任务                  调用  响应字节  结果');
  for (const r of results) {
    console.log(`${r.task.padEnd(22)}${String(r.calls).padEnd(6)}${String(r.bytes).padEnd(10)}${r.ok ? 'OK' : 'FAIL'}${r.note ? '  ' + r.note : ''}`);
  }
  console.log(`\n合计：${totalCalls} 次调用 / ${totalBytes} B；报告写入 ${out}`);
  if (violations.length) {
    console.log('\n超标：');
    for (const v of violations) console.log(' - ' + v);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('基线执行失败：', e.message);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 500).unref();
}