import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeedSecretKeyError, Vault, WrongPassphraseError, WrongSecretKeyError } from '../src/core/vault';
import { generateSecretKey, isValidSecretKey, normalizeSecretKey } from '../src/core/secret-key';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * Secret Key 双因子：启用、三态解锁、停用窗口、改口令。
 * 这里每个断言都对应一条「用户会不会把自己锁在门外」的路径，松一条就是丢数据。
 */
describe('Secret Key 格式', () => {
  it('生成的 SK 是 28 位且校验位自洽，展示为 4 组 × 7', () => {
    const { secretKey, hint } = generateSecretKey();
    const norm = normalizeSecretKey(secretKey);
    expect(norm.length).toBe(28);
    expect(isValidSecretKey(norm)).toBe(true);
    expect(secretKey.split('-').length).toBe(4);
    expect(hint.length).toBe(4);
  });

  it('改一个字符（校验位对不上）即判非法', () => {
    const norm = normalizeSecretKey(generateSecretKey().secretKey);
    const bad = (norm[0] === 'A' ? 'B' : 'A') + norm.slice(1);
    expect(isValidSecretKey(bad)).toBe(false);
  });
});

describe('启用与解锁', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => cleanup(dir));

  it('启用返回一次性明文，状态变为双因子，本机落地 secret_key.txt', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });
    const r = v.enableSecretKey(PP);

    expect(r.secretKey.length > 0).toBe(true);
    expect(r.fingerprint.length).toBe(8);
    expect(v.secretKeyStatus().enabled).toBe(true);
    expect(fs.existsSync(path.join(dir, 'secret_key.txt'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'secret_key.txt')).mode & 0o777).toBe(0o600);
    // 数据仍在：启用过程是整库重加密，不是重建
    expect(v.list().length).toBe(1);
  });

  it('三态解锁：缺 SK / SK 错 / SK 对', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'api_key', name: 'k', secret: 'S1', tags: [] });
    const { secretKey } = v.enableSecretKey(PP);

    fs.rmSync(path.join(dir, 'secret_key.txt'));

    expect(() => new Vault(dir).unlock(PP)).toThrow(NeedSecretKeyError);
    const wrong = generateSecretKey().secretKey; // 格式合法但不是这把
    expect(() => new Vault(dir).unlock(PP, { secretKey: wrong })).toThrow(WrongSecretKeyError);

    const ok = new Vault(dir);
    ok.unlock(PP, { secretKey });
    // unlock() 的返回值是「是否新建了库」，不是「是否解锁成功」——用 locked 判结果
    expect(ok.locked).toBe(false);
    expect(ok.list().length).toBe(1);
  });

  it('口令错与 SK 错可区分（不会让用户反复改口令）', () => {
    const v = new Vault(dir, PP);
    const { secretKey } = v.enableSecretKey(PP);
    // 口令错时先报口令错，不报 SK 错
    expect(() => new Vault(dir).unlock('wrong-pass', { secretKey })).toThrow(WrongPassphraseError);
  });

  it('整段应急包文本粘进 SK 输入框也能解锁（宽容一层）', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });
    const { secretKey } = v.enableSecretKey(PP);
    const kit = v.emergencyKitText();
    expect(kit.text.includes(secretKey)).toBe(true);

    const ok = new Vault(dir);
    ok.unlock(PP, { secretKey: kit.text });
    expect(ok.locked).toBe(false);
  });
});

describe('停用与改口令', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => cleanup(dir));

  it('启用后 24h 内可停用，停用后口令单开', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });
    const { secretKey } = v.enableSecretKey(PP);
    expect(v.disableSecretKey(PP, { secretKey }).disabled).toBe(true);
    expect(v.secretKeyStatus().enabled).toBe(false);

    const again = new Vault(dir);
    again.unlock(PP);
    expect(again.locked).toBe(false);
    expect(again.list().length).toBe(1);
  });

  it('超过 24h 窗口拒绝停用（不给长期后门）', () => {
    const v = new Vault(dir, PP);
    const { secretKey } = v.enableSecretKey(PP);
    // 直接把 keystore 里的启用时间挪到 2 天前，等价于窗口过期
    const ksFile = path.join(dir, 'keystore.json');
    const ks = JSON.parse(fs.readFileSync(ksFile, 'utf8'));
    ks.sk.enabledAt = new Date(Date.now() - 2 * 86400000).toISOString();
    fs.writeFileSync(ksFile, JSON.stringify(ks));

    expect(() => new Vault(dir, PP, { secretKey }).disableSecretKey(PP, { secretKey })).toThrow(/24/);
  });

  it('双因子库改口令后：新口令 + 原 SK 可解，单口令仍不行', () => {
    const v = new Vault(dir, PP);
    v.add({ type: 'note', name: 'n', content: 'c', tags: [] });
    const { secretKey } = v.enableSecretKey(PP);
    v.changePassphrase(PP, 'new-pass-2', { secretKey });

    // 本机还存着 SK（「记住此设备」）时，单口令也能开——这是设计行为，先把它删掉再验三态
    fs.rmSync(path.join(dir, 'secret_key.txt'));
    expect(() => new Vault(dir).unlock('new-pass-2')).toThrow(NeedSecretKeyError);

    const ok = new Vault(dir);
    ok.unlock('new-pass-2', { secretKey });
    expect(ok.locked).toBe(false);
    expect(ok.list().length).toBe(1);
  });
});