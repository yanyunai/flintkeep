/**
 * HTTP 基础设施：响应/请求体/静态资源。
 *
 * 抽出来的目的不是"好看"，是让路由模块（`src/server/routes/*`）不再 import `server.ts`——
 * 路由一旦反向依赖启动文件，循环引用和状态耦合就没法拆了。
 *
 * 这里保持零业务状态：静态根目录由调用方传入（`server.ts` 知道自己的 `__dirname`）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as http from 'http';

export const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 静态资源的统一响应头。
 * CSP 是最后一道 XSS 防线：渲染层若能执行注入脚本，就能在没有 CORS 阻挡的同源下读全库。
 * 样式允许 inline（Vue 的 :style 与模板里大量 inline style），脚本只允许同源文件。
 */
export const STATIC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/**
 * 静态文件服务：把路径解析到 root 内并做边界校验。
 * `new URL` 会归一化 `..`，但仍不应依赖上游归一化 —— 一次 resolve + startsWith 成本极低。
 */
export function serveStatic(root: string, res: http.ServerResponse, p: string): boolean {
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(abs);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...STATIC_HEADERS,
  });
  fs.createReadStream(abs).pipe(res);
  return true;
}

export function send(
  res: http.ServerResponse,
  code: number,
  obj: any,
  headers: Record<string, string> = {}
): void {
  // 接口响应一律不缓存：否则「保存后再查询」可能拿回旧响应，
  // 用户看到的就是「刚存的东西不见了，刷新一下又回来了」。
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    ...headers,
  });
  res.end(JSON.stringify(obj));
}

/** 请求体上限：本地接口都是小块 JSON，8MB 足够；无上限会让一个坏请求吃满内存 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 带 HTTP 状态码的错误：路由层用它区分「客户端错」与「服务端错」 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = '';
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `请求体超过上限（${Math.floor(MAX_BODY_BYTES / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      d += c;
    });
    req.on('end', () => {
      if (!d.trim()) return resolve({}); // 空体（DELETE/POST 无参）按 {} 处理
      try {
        resolve(JSON.parse(d));
      } catch {
        // 以前非法 JSON 会被当成 {} 进入业务，造出脏资产；现在明确回 400
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}