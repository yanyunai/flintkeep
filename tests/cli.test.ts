import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vault } from '../src/core/vault';
import { CLI_VERSION, EXIT, parseArgs, runCli } from '../src/core/cli';
import { PP, cleanup, tmpDir } from './helpers';

/**
 * `fk` 命令行（进程内调用 runCli，不 spawn 子进程）。
 *
 * 关注点是「脚本/CI 能用它做什么、会在什么情况下失败」：
 * 脱敏默认开、connect 只给命令或令牌、inject 原子替换、退出码分级。
 */
const DATA_DIR = tmpDir('fk-cli-');
const EMPTY_DIR = tmpDir('fk-cli-empty-');

let serverNo = 0;
let apiNo = 0;

/** 捕获 stdout/stderr 并临时覆盖凭据环境变量；单个用例内可重复调用 */
async function cli(
  argv: string[],
  env: Record<string, string | undefined> = { FK_PASSPHRASE: PP, FK_DATA_DIR: DATA_DIR }
): Promise<{ code: number; out: string; err: string }> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // 兜底清掉别名，避免宿主环境把它们带进来
  for (const k of ['FK_PASSPHRASE', 'VAULT_PASSPHRASE', 'FK_SK', 'VAULT_SECRET_KEY']) {
    if (!(k in env)) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  }

  let out = '';
  let err = '';
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  (process.stdout as any).write = (c: any) => ((out += String(c)), true);
  (process.stderr as any).write = (c: any) => ((err += String(c)), true);
  let code: number = EXIT.ok;
  try {
    code = await runCli(argv);
  } finally {
    (process.stdout as any).write = ow;
    (process.stderr as any).write = ew;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { code, out, err };
}

function parseJson(out: string): any {
  return JSON.parse(out.trim());
}

beforeAll(() => {
  const v = new Vault(DATA_DIR, PP);
  const srv = v.add({
    type: 'server',
    name: 'cli-web-01',
    publicIp: '198.51.100.31',
    sshUser: 'root',
    sshPassword: 'FAKE_PWD_CLI',
    tags: ['prod'],
  });
  const key = v.add({ type: 'api_key', name: 'cli-api', username: 'svc', secret: 'FAKE_KEY_CLI', tags: [] });
  v.add({ type: 'note', name: 'cli-note', content: '备忘', tags: [] });
  serverNo = Number(srv.no);
  apiNo = Number(key.no);
});

afterAll(() => {
  cleanup(DATA_DIR);
  cleanup(EMPTY_DIR);
});

describe('参数解析与帮助', () => {
  it('--k v / --k=v / 布尔 flag / 位置参数各自就位', () => {
    const p = parseArgs(['show', 'server:1', '--json', '--ttl=600', '--field', 'secret']);
    expect(p.cmd).toBe('show');
    expect(p.positional).toEqual(['server:1']);
    expect(p.flags.json).toBe(true);
    expect(p.flags.ttl).toBe('600');
    expect(p.flags.field).toBe('secret');
  });

  it('version 输出 CLI_VERSION 并退出 0', async () => {
    const r = await cli(['version'], {});
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(`fk ${CLI_VERSION}`);
  });

  it('help 给出凭据说明并退出 0', async () => {
    const r = await cli(['help'], {});
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('FK_PASSPHRASE');
    expect(r.out).toContain('FK_SK');
  });

  it('未知命令退出 2 并说明支持的命令', async () => {
    const r = await cli(['nope'], {});
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('未知命令');
  });
});

describe('凭据与状态', () => {
  it('没有 keystore 时 status 仍是只读体检（退出 0，unlocked=false）', async () => {
    const r = await cli(['status', '--json', '--data-dir', EMPTY_DIR], {});
    expect(r.code).toBe(EXIT.ok);
    const j = parseJson(r.out);
    expect(j.unlocked).toBe(false);
    expect(j.total).toBeNull();
  });

  it('有库但没口令：非 TTY 下退出 3（凭据缺失）', async () => {
    // 显式指向测试库：这条用例验的是「没口令」，不能顺带依赖当前工作目录下有没有 data/
    const r = await cli(['list'], { FK_PASSPHRASE: undefined, FK_DATA_DIR: DATA_DIR });
    expect(r.code).toBe(EXIT.auth);
    expect(r.err).toContain('未提供口令');
  });

  it('有口令时 status 报出条目数', async () => {
    const r = await cli(['status', '--json']);
    expect(r.code).toBe(EXIT.ok);
    const j = parseJson(r.out);
    expect(j.unlocked).toBe(true);
    expect(j.total >= 3).toBe(true);
    expect(j.counts.server >= 1).toBe(true);
  });
});

describe('清单与详情', () => {
  it('list --json 不把备忘录混进清单，类型标签是中文', async () => {
    const r = await cli(['list', '--json']);
    expect(r.code).toBe(EXIT.ok);
    const j = parseJson(r.out);
    const types = j.items.map((i: any) => i.type);
    expect(types).not.toContain('note');
    const srv = j.items.find((i: any) => i.type === 'server');
    expect(srv.typeLabel).toBe('服务器');
    // 摘要只给连接线索，不铺满密钥
    expect(srv.summary).toBe('198.51.100.31');
  });

  it('list 文本模式带表头与条目', async () => {
    const r = await cli(['list']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('cli-web-01');
    expect(r.out).toContain('类型');
  });

  it('show 默认脱敏，并提示可用 --reveal', async () => {
    const r = await cli(['show', 'cli-api']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).not.toContain('FAKE_KEY_CLI');
    expect(r.out).toContain('已脱敏');
  });

  it('show --reveal 返回明文并写审计', async () => {
    const r = await cli(['show', 'cli-api', '--reveal', '--json']);
    expect(r.code).toBe(EXIT.ok);
    expect(parseJson(r.out).secret).toBe('FAKE_KEY_CLI');
    const v = new Vault(DATA_DIR, PP);
    const actions = v.auditLog(200).map((e: any) => e.action);
    expect(actions).toContain('get_asset');
  });

  it('目标未找到退出 4', async () => {
    const r = await cli(['show', '根本没有这个资产']);
    expect(r.code).toBe(EXIT.notFound);
    expect(r.err).toContain('未找到');
  });

  it('模糊命中多条退出 4 并列出候选', async () => {
    const r = await cli(['show', 'cli']);
    expect(r.code).toBe(EXIT.notFound);
    expect(r.err).toContain('多个候选');
    expect(r.err).toContain('cli-web-01');
  });

  it('「类型:序号」可解析', async () => {
    const typed = await cli(['show', `api_key:${apiNo}`, '--json']);
    expect(typed.code).toBe(EXIT.ok);
    expect(parseJson(typed.out).name).toBe('cli-api');
  });

  it('纯序号只在唯一命中时可用；同号多类型时按歧义处理', async () => {
    // 本库里 server / ssh_key / api_key 都是 1 号，纯序号必须拒绝
    const ambiguous = await cli(['show', String(serverNo), '--json']);
    expect(ambiguous.code).toBe(EXIT.notFound);
    expect(ambiguous.err).toContain('多个候选');

    // 单资产小库：纯序号唯一，正常解析
    const mini = tmpDir('fk-cli-mini-');
    try {
      const mv = new Vault(mini, PP);
      mv.add({ type: 'api_key', name: 'only-one', secret: 'x', tags: [] });
      const r = await cli(['show', '1', '--json', '--data-dir', mini]);
      expect(r.code).toBe(EXIT.ok);
      expect(parseJson(r.out).name).toBe('only-one');
    } finally {
      cleanup(mini);
    }
  });
});

describe('连接与环境导出', () => {
  it('connect 服务器只给堡垒命令，不含密码', async () => {
    const r = await cli(['connect', `server:${serverNo}`, '--json']);
    expect(r.code).toBe(EXIT.ok);
    const j = parseJson(r.out);
    expect(j.mode).toBe('ssh');
    expect(j.command).toContain(`-p ${j.proxyPort}`);
    expect(j.command).toContain(`${j.token}@${j.proxyHost}`);
    expect(j.command).not.toContain('FAKE_PWD_CLI');
    expect(JSON.stringify(j)).not.toContain('FAKE_PWD_CLI');
  });

  it('connect API 密钥给代理基址与令牌，不发明文密钥', async () => {
    const r = await cli(['connect', `api_key:${apiNo}`, '--json']);
    expect(r.code).toBe(EXIT.ok);
    const j = parseJson(r.out);
    expect(j.mode).toBe('proxy');
    expect(j.proxyBase).toContain('127.0.0.1');
    expect(typeof j.token).toBe('string');
    expect(j.token.length > 8).toBe(true);
    expect(JSON.stringify(j)).not.toContain('FAKE_KEY_CLI');
  });

  it('env 把密钥字段导出成 export 行（明文走 stdout）', async () => {
    const r = await cli(['env', `api_key:${apiNo}`]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('export SECRET="FAKE_KEY_CLI"');
    // 提示只走 stderr，不污染管道
    expect(r.err).toContain('明文');
  });

  it('env --json 只给字段映射', async () => {
    const r = await cli(['env', `api_key:${apiNo}`, '--json']);
    const j = parseJson(r.out);
    expect(j.fields.secret).toBe('FAKE_KEY_CLI');
    expect(j.asset).toBe('cli-api');
  });
});

describe('模板注入', () => {
  it('占位符被替换成真实值', async () => {
    const tpl = path.join(DATA_DIR, 'tpl.txt');
    fs.writeFileSync(tpl, `key={{fk:api_key:${apiNo}.secret}}\nuser={{fk:cli-api.username}}\n`);
    const r = await cli(['inject', '--in', tpl]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('key=FAKE_KEY_CLI');
    expect(r.out).toContain('user=svc');
  });

  it('任一占位符失败则整体不输出（已取到的值不泄漏）', async () => {
    const tpl = path.join(DATA_DIR, 'tpl-bad.txt');
    fs.writeFileSync(tpl, `a={{fk:api_key:${apiNo}.secret}}\nb={{fk:不存在的目标.secret}}\n`);
    const r = await cli(['inject', '--in', tpl]);
    expect(r.code).toBe(EXIT.notFound);
    expect(r.out).toBe('');
    expect(r.err).not.toContain('FAKE_KEY_CLI');
  });

  it('占位符格式错误按用法错误退出 2', async () => {
    const tpl = path.join(DATA_DIR, 'tpl-fmt.txt');
    fs.writeFileSync(tpl, 'x={{fk:nodot}}');
    const r = await cli(['inject', '--in', tpl]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('占位符格式');
    expect(r.out).toBe('');
  });

  it('--out 写文件且不回显内容', async () => {
    const tpl = path.join(DATA_DIR, 'tpl-out.txt');
    const dst = path.join(DATA_DIR, 'out.env');
    fs.writeFileSync(tpl, 'S={{fk:api_key:' + apiNo + '.secret}}');
    const r = await cli(['inject', '--in', tpl, '--out', dst]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toBe('');
    expect(r.err).toContain('已写入');
    expect(fs.readFileSync(dst, 'utf8')).toBe('S=FAKE_KEY_CLI');
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600);
  });
});

describe('访问令牌', () => {
  it('scope 为空拒绝创建（不允许一令牌全库）', async () => {
    const r = await cli(['token', 'create', '--name', 'ci']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('scope 不能为空');
  });

  it('create → list → revoke 全链路', async () => {
    const created = await cli([
      'token',
      'create',
      '--name',
      'ci-runner',
      '--assets',
      `api_key:${apiNo}`,
      '--caps',
      'proxy',
      '--days',
      '7',
      '--json',
    ]);
    expect(created.code).toBe(EXIT.ok);
    const j = parseJson(created.out);
    expect(j.token.startsWith('fksa_')).toBe(true);
    expect(j.caps).toEqual(['proxy']);
    expect(j.daysLeft > 0).toBe(true);

    const listed = await cli(['token', 'list', '--json']);
    const l = parseJson(listed.out);
    expect(l.total >= 1).toBe(true);
    expect(l.items[0].prefix).toBe(j.token.slice(0, 12));

    const revoked = await cli(['token', 'revoke', j.token.slice(0, 12), '--json']);
    expect(revoked.code).toBe(EXIT.ok);
    expect(parseJson(revoked.out).active).toBe(false);
  });
});
