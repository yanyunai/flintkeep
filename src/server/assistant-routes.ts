/**
 * 资产管家路由：应用内口语指令智能体（配置 / 会话 / 对话 / SSE 流式 / 删除确认）。
 *
 * SSE 那段必须用 `res.on('close')` 而不是 `req`：请求体读完 req 就 close，
 * 会把刚开始的流掐断——这条注释随代码一起搬过来，别在重构时丢掉。
 */
import type * as http from 'http';
import { send, readBody } from './http-util';
import { t } from '../shared/i18n';
import type { Vault } from '../core/vault';
import { assistantChat, confirmDelete, getConf, setConf, listSessions } from '../core/assistant';
export type RouteCtx = {
  v: Vault;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
};

export async function handleAssistantRoutes(ctx: RouteCtx): Promise<boolean> {
  const { v, req, res, url, p } = ctx;
  /** 发完响应就返回 true：外层 if (await handle…) return; 保持原来的顺序与短路语义 */
  const reply = (code: number, obj: any, headers: Record<string, string> = {}): true => {
    send(res, code, obj, headers);
    return true;
  };

  // ===== 资产管家：应用内口语指令智能体 =====
  if (p === '/api/assistant/config') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    if (req.method === 'GET') return reply(200, getConf(v));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const keyCleared = setConf(v, body || {});
      return reply(200, { ...getConf(v), keyCleared });
    }
  }
  if (p === '/api/assistant/sessions' && req.method === 'GET') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    return reply(200, listSessions(v));
  }
  if (p === '/api/assistant/session' && req.method === 'GET') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const sid = url.searchParams.get('id') || '';
    const sess = (v.getCollection('ai_sessions') || [] as any[]).find((s: any) => s.id === sid);
    return reply(200, sess ? { id: sess.id, title: sess.title, msgs: sess.msgs } : { id: sid, title: '', msgs: [] });
  }
  if (p === '/api/assistant/session' && req.method === 'DELETE') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const sid = url.searchParams.get('id') || '';
    const list = (v.getCollection('ai_sessions') || []) as any[];
    v.setCollection('ai_sessions', list.filter((s: any) => s.id !== sid));
    return reply(200, { ok: true });
  }
  if (p === '/api/assistant/chat' && req.method === 'POST') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const body = await readBody(req);
    if (!body?.text) return reply(400, { error: '缺少 text' });
    try {
      const r = await assistantChat(v, String(body.sessionId || 'default'), String(body.text));
      return reply(200, r);
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }
  /** 流式对话：SSE 逐块输出，前端用 fetch + reader 消费 */
  if (p === '/api/assistant/chat/stream' && req.method === 'POST') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const body = await readBody(req);
    if (!body?.text) return reply(400, { error: '缺少 text' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const ac = new AbortController();
    // 必须用 res 的 close：req 的 close 在请求体读完时就触发，会把刚开始的流掐断
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const emit = (e: any) => {
      if (res.writableEnded || res.destroyed) return;
      try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* 连接已断开 */ }
    };
    try {
      await assistantChat(v, String(body.sessionId || 'default'), String(body.text), { emit, signal: ac.signal });
    } catch (e: any) {
      emit({ type: 'error', message: e?.message || String(e) });
    } finally {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    return true;
  }
  if (p === '/api/assistant/confirm' && req.method === 'POST') {
    if (v.locked) return reply(401, { error: t('err.locked') });
    const body = await readBody(req);
    if (!body?.cid) return reply(400, { error: '缺少 cid' });
    try {
      return reply(200, confirmDelete(v, String(body.cid), !!body.approve, body.sessionId ? String(body.sessionId) : undefined));
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  return false;
}
