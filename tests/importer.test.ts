import { describe, expect, it } from 'vitest';
import {
  dedupeKey,
  detectCsvFormat,
  hostOf,
  itemToAsset,
  normalizeUrl,
  parseCsv,
  parseCsvImport,
} from '../src/core/importer';

/**
 * 导入器：CSV 解析、格式识别、去重键、资产映射。
 * 全部是纯函数，最适合进 Vitest——也最容易被"顺手改一下"改坏。
 */
describe('CSV 解析', () => {
  it('处理引号包裹、字段内逗号与换行、CRLF 与 BOM', () => {
    const csv = '\uFEFFname,url,username,password\r\n"a,b","https://x.test","u","p""q"\r\n"多行","https://y.test","u2","line1\nline2"\r\n';
    const rows = parseCsv(csv);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual(['name', 'url', 'username', 'password']);
    expect(rows[1][0]).toBe('a,b');
    expect(rows[1][3]).toBe('p"q');
    expect(rows[2][3]).toBe('line1\nline2');
  });
});

describe('格式识别', () => {
  it('认得 1Password / Bitwarden / Chrome / KeePass 的表头', () => {
    expect(detectCsvFormat(['login_uri', 'login_username', 'login_password'])).toBe('bitwarden-csv');
    expect(detectCsvFormat(['Title', 'Url', 'Username', 'Password'])).toBe('onepassword-csv');
    expect(detectCsvFormat(['Account', 'Login Name', 'Password'])).toBe('keepass-csv');
    expect(detectCsvFormat(['name', 'url', 'username', 'password'])).toBe('chrome-csv');
    expect(detectCsvFormat(['foo', 'bar'])).toBeNull();
  });

  it('表头认不出时报错并回显实际表头，不猜列', () => {
    expect(() => parseCsvImport('foo,bar\n1,2')).toThrow(/无法识别表头/);
  });

  it('Bitwarden CSV 解析出条目', () => {
    const csv = 'login_uri,login_username,login_password,name,notes\nhttps://a.test,u,p,站点A,备注\n';
    const r = parseCsvImport(csv);
    expect(r.format).toBe('bitwarden-csv');
    expect(r.items.length).toBe(1);
    expect(r.items[0].title).toBe('站点A');
    expect(r.items[0].username).toBe('u');
    expect(r.items[0].password).toBe('p');
  });
});

describe('URL 与去重键', () => {
  it('normalizeUrl 补 https、取第一个像 URL 的串', () => {
    expect(normalizeUrl('example.com/login')).toBe('https://example.com/login');
    expect(normalizeUrl('https://a.test 备注文本 https://b.test')).toBe('https://a.test/');
    expect(normalizeUrl('')).toBeUndefined();
    expect(normalizeUrl('随便写的备注')).toBeUndefined();
  });

  it('hostOf 去掉 www 前缀', () => {
    expect(hostOf('https://www.example.com/a')).toBe('example.com');
    expect(hostOf('')).toBe('');
  });

  it('同站点同用户名视为重复；没有站点退回标题', () => {
    const a = dedupeKey({ title: 'A', url: 'https://www.example.com/', username: 'U' });
    const b = dedupeKey({ title: 'B', url: 'https://example.com/x', username: 'u' });
    expect(a).toBe(b);

    const c = dedupeKey({ title: 'A', url: 'https://example.com', username: 'other' });
    expect(c === a).toBe(false);

    expect(dedupeKey({ title: '只有标题' })).toBe('title|只有标题');
  });
});

describe('资产映射', () => {
  it('有站点/账号/密码 → login_account，备注与 TOTP 落 extra', () => {
    const a = itemToAsset({ title: '站点A', url: 'https://www.example.com/login', username: 'u', password: 'p', notes: '备注', totp: 'TOTP', folder: '工作' })!;
    expect(a.type).toBe('login_account');
    expect(a.name).toBe('站点A');
    expect(a.provider).toBe('example.com');
    expect(a.loginUrl).toBe('https://www.example.com/login');
    expect(a.username).toBe('u');
    expect(a.secret).toBe('p');
    expect((a.extra as Record<string, unknown>).import_notes).toBe('备注');
    expect((a.extra as Record<string, unknown>).import_totp).toBe('TOTP');
    expect((a.extra as Record<string, unknown>).import_folder).toBe('工作');
  });

  it('只有备注 → note；什么都没有 → null', () => {
    const note = itemToAsset({ title: '纯备注', notes: '正文' })!;
    expect(note.type).toBe('note');
    expect(note.content).toBe('正文');
    expect(itemToAsset({ title: '空' })).toBeNull();
  });
});