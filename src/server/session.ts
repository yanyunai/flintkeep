/**
 * 本地会话凭据（解锁后签发，锁定即作废）。
 *
 * 为什么需要：Host 校验只挡 DNS rebinding，挡不住同机其它进程；
 * 而 REST 面能读全库明文、能导走加密备份，必须再有一道「只属于本次解锁会话」的凭据。
 *
 * 实现用 HttpOnly + SameSite=Strict 的 cookie（渲染层无需改任何 fetch 调用），
 * 同时接受 X-FK-Session 头给脚本/测试用。
 *
 * 状态集中在这一个模块里，路由只调 `sessionOk(req)`；不要让 token 散落到各处——
 * 散落之后「锁定有没有真的吊销」就没人能保证。
 */
import * as crypto from 'crypto';
import type * as http from 'http';

export const SESSION_COOKIE = 'fk_sid';

let sessionToken: string | null = null;

/** 解锁时调用：签发新会话（旧的一律失效） */
export function issueSession(): string {
  sessionToken = crypto.randomBytes(32).toString('base64url');
  return sessionToken;
}

/** 锁定时调用：会话立即作废 */
export function revokeSession(): void {
  sessionToken = null;
}

export function currentSession(): string | null {
  return sessionToken;
}

export function sessionCookie(): string {
  return `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function timingEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function cookieValue(req: http.IncomingMessage, name: string): string {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** 本次解锁会话是否有效；锁定时一律无效（锁定即断会话） */
export function sessionOk(req: http.IncomingMessage): boolean {
  if (!sessionToken) return false;
  const provided = String(req.headers['x-fk-session'] || '') || cookieValue(req, SESSION_COOKIE);
  return !!provided && timingEq(provided, sessionToken);
}

/** 浏览器带的 Sec-Fetch-Site 若不是同源/直接访问，拒绝（防 CSRF） */
export function crossSite(req: http.IncomingMessage): boolean {
  const s = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return !!s && s !== 'same-origin' && s !== 'none';
}