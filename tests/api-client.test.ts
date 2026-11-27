import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/renderer/api-client';

/**
 * 前端请求层：把「HTTP 状态码 → 业务语义」的判定锁死。
 *
 * 这条链断了的历史后果是：资产列表拿到 401 的 `{ error, needUnlock }`，
 * 当成数组 `.filter()`，抛 TypeError，整页白屏。这里在 node 环境 stub fetch，
 * 不依赖浏览器。
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(fn: (url: string, init: any) => any) {
  globalThis.fetch = (async (url: any, init: any) => fn(String(url), init)) as typeof fetch;
}

function res(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

async function caught(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('请求层：状态码判定', () => {
  it('2xx 返回解析后的 JSON', async () => {
    stub(() => res(200, { ok: 1 }));
    const api = createApi();
    expect(await api('GET', '/assets')).toEqual({ ok: 1 });
  });

  it('请求带 no-store 与 JSON 头，路径拼在 base 后', async () => {
    let seen: { url: string; init: any } | null = null;
    stub((url, init) => {
      seen = { url, init };
      return res(200, {});
    });
    const api = createApi({ base: '/api' });
    await api('PUT', '/assets/1', { name: 'x' });
    expect(seen!.url).toBe('/api/assets/1');
    expect(seen!.init.method).toBe('PUT');
    expect(seen!.init.cache).toBe('no-store');
    expect(seen!.init.headers['Content-Type']).toBe('application/json');
    expect(seen!.init.body).toBe('{"name":"x"}');
  });

  it('401 抛 ApiError 并通知 onSessionLost，错误体不流进业务数据', async () => {
    const lost: number[] = [];
    stub(() => res(401, { error: '会话已失效，请重新解锁', needUnlock: true, locked: false }));
    const api = createApi({ hooks: { onSessionLost: (s) => lost.push(s) } });
    const err = await caught(() => api('GET', '/assets'));
    expect(err instanceof ApiError).toBe(true);
    expect(err.status).toBe(401);
    expect(err.isSessionLost).toBe(true);
    expect(err.message).toContain('会话已失效');
    expect(lost).toEqual([401]);
  });

  it('423（锁定态）同样按会话失效处理', async () => {
    const lost: number[] = [];
    stub(() => res(423, { error: '保险库已锁定', needUnlock: true }));
    const api = createApi({ hooks: { onSessionLost: (s) => lost.push(s) } });
    const err = await caught(() => api('GET', '/settings'));
    expect(err.status).toBe(423);
    expect(err.isSessionLost).toBe(true);
    expect(lost).toEqual([423]);
  });

  it('500 抛错，且调用方拿不到 body（不会把 error 当成功数据）', async () => {
    let okCalled = false;
    stub(() => res(500, { error: '内部错误' }));
    const api = createApi({ hooks: { onOk: () => (okCalled = true) } });
    let value: unknown = 'unset';
    const err = await caught(async () => {
      value = await api('GET', '/assets');
      return value;
    });
    expect(err.status).toBe(500);
    expect(err.isSessionLost).toBe(false);
    expect(value).toBe('unset');
    expect(okCalled).toBe(false);
  });

  it('错误体不是 JSON 也不影响判定', async () => {
    stub(() => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
      text: async () => '<html>502</html>',
    }));
    const api = createApi();
    const err = await caught(() => api('GET', '/x'));
    expect(err.status).toBe(502);
    expect(err.body).toBe(null);
  });

  it('网络错误：onNetworkError 触发并抛原错误（不当成 API 错误）', async () => {
    const offline: unknown[] = [];
    stub(() => {
      throw new Error('ECONNREFUSED');
    });
    const api = createApi({ hooks: { onNetworkError: (e) => offline.push(e) } });
    const err = await caught(() => api('GET', '/assets'));
    expect(err instanceof ApiError).toBe(false);
    expect(err.message).toBe('ECONNREFUSED');
    expect(offline.length).toBe(1);
  });

  it('204 返回 null', async () => {
    stub(() => ({ ok: true, status: 204, json: async () => null, text: async () => '' }));
    const api = createApi();
    expect(await api('DELETE', '/assets/1')).toBe(null);
  });

  it('2xx 但非 JSON：返回 null，不抛', async () => {
    stub(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad');
      },
      text: async () => '<html>ok</html>',
    }));
    const api = createApi();
    expect(await api('GET', '/x')).toBe(null);
  });

  it('成功时 onOk 触发（顶部断线提示据此消失）', async () => {
    let ok = 0;
    stub(() => res(200, {}));
    const api = createApi({ hooks: { onOk: () => (ok += 1) } });
    await api('GET', '/types');
    expect(ok).toBe(1);
  });
});
