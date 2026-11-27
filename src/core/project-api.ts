/** 「运行工作台」HTTP API：不经过保险库解锁门，锁屏时页面与菜单栏仍可用 */
import * as http from 'http';
import { readProjects, deleteProject, getProject, sharingMap, applySharedDuplicates } from './project-store';
import { getCachedStatuses, subscribe, probeOnce, clearStopMark } from './project-probe';
import { startProject, stopProject, readProjectLogs, planStop } from './project-runner';
import { discoverProject } from './project-discovery';
import { registerProject, registerBatch, projectTree } from './project-registrar';

function send(res: http.ServerResponse, code: number, obj: any) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 与 server.ts 同一套上限：工作台请求体都是小 JSON */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = '';
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限（${Math.floor(MAX_BODY_BYTES / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      d += c;
    });
    req.on('end', () => {
      if (!d.trim()) return resolve({});
      try {
        resolve(JSON.parse(d));
      } catch {
        // 以前非法 JSON 会被当成 {}，直接造出空档案；现在明确拒绝
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export interface MyProjectsApiOptions {
  /** 设置里的「锁屏后仍允许连接」：锁定态是否放行写操作 */
  allowLockedAccess: boolean;
  /** 本次请求是否已通过鉴权（解锁态 = 会话凭据有效；锁定态 = 上面那个开关） */
  authorized: boolean;
  /** 当前是否锁定：用来区分「要解锁」与「会话失效」两种拒绝语义 */
  locked: boolean;
}

export async function handleMyProjectsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parts: string[],
  dataDir: string,
  opts: MyProjectsApiOptions = { allowLockedAccess: false, authorized: false, locked: false },
): Promise<void> {
  const method = req.method || 'GET';

  // 读（列表/树/状态/日志）锁屏也能用；写（登记/启停/删除）必须过鉴权。
  // 这是 P0 收口点：以前 POST /api/myprojects 能登记任意命令、再 /start 执行。
  if (method !== 'GET' && !opts.authorized) {
    if (opts.locked && !opts.allowLockedAccess) {
      return send(res, 423, {
        error: '保险库已锁定：登记与启停项目需要先解锁（或打开设置里的「锁屏后仍允许连接」）',
        needUnlock: true,
      });
    }
    return send(res, 401, { error: '会话已失效，请重新解锁', needUnlock: true });
  }

  // 状态推送（SSE）：探测层状态变化时才推，页面/菜单栏不用反复轮询
  if (parts[0] === 'events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    const emit = (statuses: any) => {
      if (res.writableEnded || res.destroyed) return;
      try { res.write(`data: ${JSON.stringify({ type: 'status', statuses })}\n\n`); } catch { /* ignore */ }
    };
    emit(getCachedStatuses());
    const un = subscribe(emit);
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }
    }, 15000);
    res.on('close', () => { clearInterval(ping); un(); });
    return;
  }

  if (parts.length === 0 && method === 'GET') {
    const projects = readProjects(dataDir).projects;
    return send(res, 200, {
      projects,
      statuses: getCachedStatuses(),
      // 同一份资源被多个项目登记时，页面据此把重复依赖「亮灯」
      sharing: sharingMap(projects),
    });
  }

  // 一键整理：把重复登记的依赖双向标成 shared（页面「整理共享」按钮）
  if (parts[0] === 'shared-dedupe' && method === 'POST') {
    const r = applySharedDuplicates(dataDir);
    return send(res, 200, r);
  }

  // 折叠视图：主项目 + 它下面的子节点（页面和托盘按这个渲染）
  if (parts[0] === 'tree' && method === 'GET') {
    const tree = projectTree(dataDir);
    return send(res, 200, { tree, statuses: getCachedStatuses(), sharing: sharingMap(readProjects(dataDir).projects) });
  }

  // Agent / 页面写入档案：幂等 upsert；新增时自动扫目录派生子节点
  if (parts.length === 0 && method === 'POST') {
    const body = await readBody(req);
    const r = registerProject(dataDir, body?.project || body, { autoDiscover: body?.autoDiscover !== false });
    if (!r.ok) return send(res, 400, r);
    void probeOnce(dataDir).catch(() => {});
    return send(res, 200, r);
  }

  // 批量登记：体检后勾选若干建议节点，一次写完；自动多轮重试以兼容「主项目先于依赖提交」
  if (parts[0] === 'batch' && method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body?.projects) ? body.projects : [];
    if (!list.length) return send(res, 400, { error: 'projects 不能为空' });
    const results = registerBatch(dataDir, list);
    void probeOnce(dataDir).catch(() => {});
    return send(res, 200, { results, ok: results.every((r) => r.ok) });
  }

  const id = parts[0];
  if (!id) return send(res, 404, { error: '缺少项目 id' });

  if (parts.length === 1 && method === 'GET') {
    const p = getProject(dataDir, id);
    return p ? send(res, 200, { project: p, status: getCachedStatuses()[id] }) : send(res, 404, { error: '项目不存在' });
  }

  // 关闭预演：先告诉用户会停哪些、哪些会留着，确认后再真停
  if (parts[1] === 'stop-plan' && (method === 'GET' || method === 'POST')) {
    const body = method === 'POST' ? await readBody(req) : {};
    const planned = await planStop(dataDir, id, {
      cascade: (body as any)?.cascade,
      only: (body as any)?.only === 'deps' ? 'deps' : 'all',
    });
    if ('error' in planned) return send(res, 404, planned);
    return send(res, 200, planned);
  }

  // 体检：扫描目录，列出「有关但没登记」的节点；id 可以是尚未登记的占位名
  if (parts[1] === 'discover' && method === 'POST') {
    const body = await readBody(req);
    const existing = getProject(dataDir, id);
    const cwd = String(body?.cwd || existing?.cwd || '');
    if (!cwd) return send(res, 400, { error: '缺少 cwd' });
    return send(res, 200, discoverProject(dataDir, cwd, existing?.id || id));
  }

  if (parts.length === 1 && method === 'PUT') {
    const body = await readBody(req);
    // 编辑时不偷偷新增节点；用户显式勾了「重新体检」才派生
    const r = registerProject(dataDir, { ...body, id }, { autoDiscover: body?.autoDiscover === true });
    if (!r.ok) return send(res, 400, r);
    void probeOnce(dataDir).catch(() => {});
    return send(res, 200, r);
  }

  if (parts.length === 1 && method === 'DELETE') {
    clearStopMark(id);
    return send(res, 200, { ok: deleteProject(dataDir, id) });
  }

  if (parts[1] === 'start' && method === 'POST') {
    clearStopMark(id); // 重新启动，之前的残留标记作废
    // 后台执行：命令可能要跑几十秒，前端靠 SSE 看状态
    void startProject(dataDir, id).catch(() => {});
    return send(res, 202, { ok: true, message: '启动指令已发出' });
  }

  if (parts[1] === 'stop' && method === 'POST') {
    const body = await readBody(req);
    const only = body?.only === 'deps' ? 'deps' : 'all';
    void stopProject(dataDir, id, { cascade: body?.cascade !== false, only }).catch(() => {});
    return send(res, 202, {
      ok: true,
      message: only === 'deps' ? '关闭依赖指令已发出（主程序保留）' : '停止指令已发出',
    });
  }

  if (parts[1] === 'logs' && method === 'GET') {
    return send(res, 200, { logs: readProjectLogs(dataDir, id) });
  }

  return send(res, 404, { error: '未知接口' });
}
