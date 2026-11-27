import * as zlib from 'zlib';
import type { Asset } from './schema';

/**
 * 从其它密码管理器导入。
 *
 * 支持：1Password（CSV / 1PUX）、Bitwarden CSV、Chrome/Edge CSV、KeePass CSV。
 * 设计原则：
 * - 只做「解析 + 映射」，不直接写库——写库由 vault.addMany 在单次写锁内完成；
 * - 不在日志/审计里出现明文密码（审计只记条数与来源）；
 * - 认不出来的列不猜：表头对不上就报错并给出实际表头，让用户改导出格式。
 */
export type ImportFormat = 'onepassword-csv' | 'onepassword-1pux' | 'bitwarden-csv' | 'chrome-csv' | 'keepass-csv';

export interface ImportItem {
  title: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  totp?: string;
  tags?: string[];
  folder?: string;
}

/** RFC4180 CSV：引号包裹、双引号转义、字段内换行、CRLF、BOM */
export function parseCsv(text: string): string[][] {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // 丢掉空行（导出文件常见尾部空行）
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/** 按表头猜格式；大小写与首尾空格无关 */
export function detectCsvFormat(header: string[]): ImportFormat | null {
  const h = header.map((x) => String(x || '').trim().toLowerCase());
  const has = (...keys: string[]) => keys.every((k) => h.includes(k));
  if (has('login_uri', 'login_username', 'login_password')) return 'bitwarden-csv';
  if (has('title', 'url', 'username', 'password')) return 'onepassword-csv';
  if (has('account', 'login name', 'password')) return 'keepass-csv';
  if (has('name', 'url', 'username', 'password')) return 'chrome-csv';
  return null;
}

/** 解析 CSV 导入文件 */
export function parseCsvImport(text: string): { format: ImportFormat; items: ImportItem[] } {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('文件是空的');
  const header = rows[0];
  const format = detectCsvFormat(header);
  if (!format) {
    throw new Error(`无法识别表头：${header.slice(0, 8).join(', ')}。支持 1Password / Bitwarden / Chrome / KeePass 导出的 CSV。`);
  }
  const col = (name: string) => header.findIndex((x) => String(x || '').trim().toLowerCase() === name);
  const body = rows.slice(1);

  const pick = (cells: string[], i: number) => (i >= 0 ? String(cells[i] ?? '').trim() : '');
  const items: ImportItem[] = [];

  for (const cells of body) {
    let item: ImportItem;
    switch (format) {
      case 'onepassword-csv':
        item = {
          title: pick(cells, col('title')),
          url: pick(cells, col('url')),
          username: pick(cells, col('username')),
          password: pick(cells, col('password')),
          notes: pick(cells, col('notes')),
          totp: pick(cells, col('otpauth')),
          tags: pick(cells, col('tags'))
            .split(/[,;]/)
            .map((t) => t.trim())
            .filter(Boolean),
        };
        break;
      case 'bitwarden-csv':
        item = {
          title: pick(cells, col('name')),
          url: pick(cells, col('login_uri')),
          username: pick(cells, col('login_username')),
          password: pick(cells, col('login_password')),
          notes: pick(cells, col('notes')),
          totp: pick(cells, col('login_totp')),
          folder: pick(cells, col('folder')),
        };
        break;
      case 'keepass-csv':
        item = {
          title: pick(cells, col('account')),
          url: pick(cells, col('web site')),
          username: pick(cells, col('login name')),
          password: pick(cells, col('password')),
          notes: pick(cells, col('comments')),
        };
        break;
      case 'chrome-csv':
      default:
        item = {
          title: pick(cells, col('name')),
          url: pick(cells, col('url')),
          username: pick(cells, col('username')),
          password: pick(cells, col('password')),
          notes: pick(cells, col('note')) || pick(cells, col('notes')),
        };
        break;
    }
    if (!item.title && !item.url && !item.username && !item.password && !item.notes) continue;
    items.push(item);
  }
  if (!items.length) throw new Error('表头认出来了，但没有可导入的行');
  return { format, items };
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 最小 ZIP 读取（1PUX 就是 ZIP）：只认 store / deflate，遇到 ZIP64 直接报错 */
export function unzip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / 1PUX 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0xffffffff || localOff === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的 1PUX');
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
  }
  return out;
}

/** 解析 1PUX（1Password 原生导出）：只取登录项与笔记 */
export function parse1pux(buffer: Buffer): { format: ImportFormat; items: ImportItem[] } {
  const entries = unzip(buffer);
  const data = entries.find((e) => e.name === 'export.data') || entries.find((e) => e.name.endsWith('export.data'));
  if (!data) throw new Error('1PUX 里没有 export.data，可能不是 1Password 导出的文件');
  let json: any;
  try {
    json = JSON.parse(data.data.toString('utf8'));
  } catch {
    throw new Error('export.data 不是合法 JSON');
  }
  const items: ImportItem[] = [];
  for (const account of json?.accounts || []) {
    for (const vault of account?.vaults || []) {
      for (const raw of vault?.items || []) {
        const o = raw?.overview || {};
        const d = raw?.details || {};
        const fields: any[] = Array.isArray(d.loginFields) ? d.loginFields : [];
        const byDesignation = (name: string) =>
          fields.find((f) => String(f?.designation || '').toLowerCase() === name)?.value || '';
        const sectionFields: any[] = (Array.isArray(d.sections) ? d.sections : []).flatMap((s: any) =>
          Array.isArray(s?.fields) ? s.fields : []
        );
        const totpField =
          fields.find((f) => String(f?.designation || '').toLowerCase() === 'otp') ||
          sectionFields.find((f) => String(f?.type || '').toUpperCase() === 'TOTP');
        const item: ImportItem = {
          title: String(o.title || ''),
          url: String(o.url || (Array.isArray(o.urls) ? o.urls[0]?.url : '') || ''),
          username: String(byDesignation('username') || ''),
          password: String(byDesignation('password') || ''),
          notes: String(d.notesPlain || ''),
          totp: String(totpField?.value || ''),
          tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
          folder: String(vault?.name || ''),
        };
        if (!item.title && !item.url && !item.username && !item.password && !item.notes) continue;
        items.push(item);
      }
    }
  }
  if (!items.length) throw new Error('1PUX 里没有可导入的条目');
  return { format: 'onepassword-1pux', items };
}

/** 统一入口：CSV 文本或 1PUX（base64） */
export function parseImportPayload(input: { format?: string; content?: string; base64?: string }): {
  format: ImportFormat;
  items: ImportItem[];
} {
  const fmt = String(input?.format || '');
  if (fmt === 'onepassword-1pux' || input?.base64) {
    const buf = Buffer.from(String(input?.base64 || ''), 'base64');
    if (!buf.length) throw new Error('1PUX 内容为空');
    return parse1pux(buf);
  }
  const text = String(input?.content || '');
  if (!text.trim()) throw new Error('导入内容为空');
  return parseCsvImport(text);
}

export function normalizeUrl(raw?: string): string | undefined {
  const v = String(raw || '').trim();
  if (!v) return undefined;
  // 1Password/Bitwarden 的 URL 可能多值或带说明，取第一个像 URL 的串
  const first = v.split(/[\s,]+/).find((x) => /^[a-z][a-z0-9+.-]*:\/\//i.test(x) || /^[\w.-]+\.[a-z]{2,}/i.test(x));
  if (!first) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : 'https://' + first;
  try {
    const u = new URL(withScheme);
    return u.toString();
  } catch {
    return undefined;
  }
}

export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 去重键：同站点同用户名视为同一条；没有站点就退回「标题」 */
export function dedupeKey(item: ImportItem): string {
  const url = normalizeUrl(item.url);
  const host = hostOf(url).toLowerCase();
  const user = String(item.username || '').trim().toLowerCase();
  if (host) return `${host}|${user}`;
  return `title|${String(item.title || '').trim().toLowerCase()}`;
}

/**
 * 映射到本项目的资产：
 * - 有站点 / 用户名 / 密码 → login_account（provider 用站点域名，登录地址进 loginUrl）
 * - 只有备注 → note（备注就是正文）
 * - 备注与 TOTP 不丢：写进 extra（import_notes / import_totp / import_folder），随整库加密
 */
export function itemToAsset(item: ImportItem): Omit<Asset, 'id' | 'createdAt' | 'updatedAt'> | null {
  const url = normalizeUrl(item.url);
  const host = hostOf(url);
  const title = String(item.title || '').trim();
  const name = title || host || '导入条目';
  const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
  const extra: Record<string, unknown> = {};
  if (item.notes) extra.import_notes = item.notes;
  if (item.totp) extra.import_totp = item.totp;
  if (item.folder) extra.import_folder = item.folder;
  const hasLogin = !!item.username || !!item.password || !!url;
  if (!hasLogin) {
    if (!item.notes) return null;
    return { type: 'note', name, content: item.notes, tags } as Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>;
  }
  return {
    type: 'login_account',
    name,
    provider: host || title || '导入',
    username: item.username || undefined,
    loginUrl: url,
    secret: item.password || undefined,
    tags,
    ...(Object.keys(extra).length ? { extra } : {}),
  } as Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>;
}