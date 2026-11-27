import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, WrongPassphraseError } from '../src/core/vault';
import { SettingsStore, DEFAULT_SETTINGS } from '../src/core/settings';
import { PP, cleanup, daysAgo, tmpDir } from './helpers';

/**
 * 保险库存储层：加密落盘、脱敏、审计、reload、锁定、并发写。
 * 这一层是所有上层（REST / MCP / CLI / SSH agent）的共同地基，回归优先级最高。
 */
describe('保险库存储层', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => cleanup(dir));

  it('首次传口令即初始化 keystore 并解锁', () => {
    const v = new Vault(dir, PP);
    expect(v.locked).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keystore.json'))).toBe(true);
  });

  it('不传口令构造是锁定态，错误口令抛 WrongPassphraseError', () => {
    new Vault(dir, PP);
    expect(new Vault(dir).locked).toBe(true);
    expect(() => new Vault(dir, 'wrong-passphrase')).toThrow(WrongPassphraseError);
  });

  it('list 剥离敏感字段，get 才返回明文；server 内联 SSH 凭证自动拆成独立 ssh_key', () => {
    const v = new Vault(dir, PP);
    v.add({
      type: 'server',
      name: 'web-01',
      ip: '10.0.0.1',
      sshPort: 22,
      sshUser: 'root',
      sshPassword: 'FAKE_PWD_1',
      openPorts: [22, 80, 443],
      tags: ['prod'],
    });
    v.add({ type: 'cloud_account', name: 'aliyun-prod', provider: 'aliyun', accessKeyId: 'FAKE_AK_2', secretAccessKey: 'FAKE_SK_2', tags: [] });

    const list = v.list();
    // server 的内联 SSH 凭证被迁出 → 1 server + 1 ssh_key + 1 cloud_account
    expect(list.length).toBe(3);
    for (const a of list) {
      expect('sshPassword' in a).toBe(false);
      expect('secretAccessKey' in a).toBe(false);
    }

    const server = list.find((a) => a.name === 'web-01')!;
    expect(v.get(server.id)?.publicIp ?? v.get(server.id)?.ip).toBe('10.0.0.1');
    const sshLogin = v.list().find((a) => a.type === 'ssh_key')!;
    expect(sshLogin).toBeTruthy();
    expect(v.get(sshLogin.id)?.sshPassword).toBe('FAKE_PWD_1');
  });

  it('getServerConnection 按公网 IP 命中并带上关联登录凭证', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'server', name: 'web-02', publicIp: '198.51.100.9', sshUser: 'root', sshPassword: 'FAKE_PWD_9', tags: [] });
    const conn = v.getServerConnection('198.51.100.9');
    expect(conn?.sshUser).toBe('root');
    expect(conn?.sshPassword).toBe('FAKE_PWD_9');
  });

  it('审计记录 actor 与动作；Agent 自报操作可检索', () => {
    const v = new Vault(dir, PP);
    const a = v.add({ type: 'note', name: 'memo', content: 'hello', tags: [] });
    v.setActor('claude-desktop/1.0');
    v.get(a.id);
    const audit = v.auditLog();
    expect(audit.some((e) => e.action === 'get_asset' && e.actor === 'claude-desktop/1.0')).toBe(true);

    const logged = v.logAgentAction('已 SSH 登录 web-01 查看 nginx 日志', { target: 'web-01', command: 'tail -f' });
    expect(logged.action).toBe('agent_action');
    expect(logged.actor).toBe('claude-desktop/1.0');
    expect(logged.description).toContain('nginx');
  });

  it('审计 meta 白名单：自定义字段里的敏感键不会原样写进审计', () => {
    const v = new Vault(dir, PP);
    v.logAgentAction('测试 meta 过滤', { password: 'SHOULD_NOT_APPEAR', target: 'web-01' });
    const raw = fs.readFileSync(path.join(dir, 'audit.log.jsonl'), 'utf8');
    expect(raw.includes('SHOULD_NOT_APPEAR')).toBe(false);
  });

  it('轮换提醒只标记超期项', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'api_key', name: 'old-key', username: 'svc', secret: 'FAKE_KEY_4', rotationReminderDays: 30, lastRotatedAt: daysAgo(100), tags: [] });
    v.add({ type: 'api_key', name: 'new-key', username: 'svc', secret: 'FAKE_KEY_5', rotationReminderDays: 30, lastRotatedAt: daysAgo(10), tags: [] });
    const due = v.dueForRotation();
    expect(due.some((a) => a.name === 'old-key')).toBe(true);
    expect(due.some((a) => a.name === 'new-key')).toBe(false);
  });

  it('重新打开读到一致数据；lock() 后重新解锁数据完好', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n1', content: 'a', tags: [] });
    v.add({ type: 'note', name: 'n2', content: 'b', tags: [] });
    expect(new Vault(dir, PP).list().length).toBe(2);

    v.lock();
    expect(v.locked).toBe(true);
    expect(new Vault(dir, PP).list().length).toBe(2);
  });

  it('双实例先后写入不互相覆盖，save 后不留 .tmp（原子写）', () => {
    const a = new Vault(dir, PP);
    a.add({ type: 'note', name: '桌面端写入', content: 'A', tags: [] });
    // 模拟另一进程：启动时加载，内存停留在只有 1 条的时刻
    const b = new Vault(dir, PP);
    a.add({ type: 'note', name: '桌面端又写入', content: 'B', tags: [] });
    b.add({ type: 'note', name: 'MCP 写入', content: 'C', tags: [] });

    expect(new Vault(dir, PP).list().length).toBe(3);
    expect(fs.existsSync(path.join(dir, 'vault.enc.json.tmp'))).toBe(false);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'vault.enc.json'), 'utf8'))).not.toThrow();
  });
});

describe('设置存储', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => cleanup(dir));

  it('默认值：后台常驻 + 15 分钟自动锁定 + 审计 5MB/3 代', () => {
    const s = new SettingsStore(dir).get();
    expect(s.closeAction).toBe(DEFAULT_SETTINGS.closeAction);
    expect(s.autoLockMinutes).toBe(DEFAULT_SETTINGS.autoLockMinutes);
    expect(s.auditMaxMB).toBe(5);
    expect(s.auditKeepGenerations).toBe(3);
  });

  it('非法值收敛：自动锁定上限 24 小时，审计范围夹紧', () => {
    const st = new SettingsStore(dir);
    const saved = st.set({ closeAction: 'quit', autoLockMinutes: 9999, auditMaxMB: 9999, auditKeepGenerations: 99 });
    expect(saved.closeAction).toBe('quit');
    expect(saved.autoLockMinutes).toBe(1440);
    expect(saved.auditMaxMB).toBe(100);
    expect(saved.auditKeepGenerations).toBe(10);
  });

  it('非法 closeAction 被拒绝并保留原值；设置持久化', () => {
    const st = new SettingsStore(dir);
    st.set({ closeAction: 'quit' });
    expect(st.set({ closeAction: 'hacky' as never }).closeAction).toBe('quit');
    expect(new SettingsStore(dir).get().closeAction).toBe('quit');
  });
});