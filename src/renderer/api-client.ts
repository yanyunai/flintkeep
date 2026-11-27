/**
 * 前端请求层：唯一负责把「HTTP 状态码」翻译成业务语义的地方。
 *
 * 原来 `App.vue` 里的 `api()` 直接 `return await res.json()`，于是 401 的
 * `{ error, needUnlock, locked }` 会被当成正常数据流进业务代码——资产列表把它
 * 当数组 `.filter()`，抛 TypeError，整页白屏。判定集中到这里之后，非 2xx 一律
 * 抛 `ApiError`，调用方不可能再把错误响应当数据用。
 *
 * 401 / 423 是「会话失效 / 保险库已锁」，不是普通业务错误：额外触发
 * `onSessionLost`，让界面切回锁屏页，而不是停在半残的数据页上。
 */

/** 服务端返回了非 2xx：调用方要么处理，要么让它冒泡，绝不能当成功数据 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '';
    super(msg || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** 会话失效或保险库已锁：调用方应切回锁屏页 */
  get isSessionLost(): boolean {
    return this.status === 401 || this.status === 423;
  }
}

export interface ApiHooks {
  /** 401 / 423：会话失效或已锁定 */
  onSessionLost?: (status: number, body: unknown) => void;
  /** fetch 本身失败（服务端不可达）：不是业务错误 */
  onNetworkError?: (err: unknown) => void;
  /** 拿到 2xx 响应 */
  onOk?: () => void;
}

export interface ApiClientOptions {
  hooks?: ApiHooks;
  /** 默认 `/api`；测试里可指向带端口的地址 */
  base?: string;
}

interface ApiInit {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * 造一个 `api(method, path, body?)`。
 * 返回 `Promise<T>`；失败一律 reject（`ApiError` 或网络原始错误）。
 */
export function createApi(options: ApiClientOptions = {}) {
  const base = options.base ?? '/api';
  const hooks = options.hooks ?? {};

  return async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const init: ApiInit = { method, path, body };
    let res: Response;
    try {
      res = await fetch(base + init.path, {
        method: init.method,
        // 接口绝不走 HTTP 缓存：否则保存后再查列表可能拿回旧响应
        cache: 'no-store',
        // 与迁移前保持一致：只有真给了 body 才带 Content-Type 与请求体
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      hooks.onNetworkError?.(e);
      throw e;
    }

    if (!res.ok) {
      // 错误体可能是 JSON，也可能是一段 HTML（代理/网关），都别让它炸掉错误处理
      const payload = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 423) hooks.onSessionLost?.(res.status, payload);
      throw new ApiError(res.status, payload);
    }

    hooks.onOk?.();

    // 204 / 空体：返回 null，调用方按「无内容」处理
    if (res.status === 204) return null as T;
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // 2xx 但不是 JSON：同样不能当成功数据，交给调用方按 null 处理
      return null as T;
    }
  };
}
