import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Vault, WrongPassphraseError } from './vault';

// 注意：以下均为明显虚构的测试数据，非真实凭证。
const PP = 'test-passphrase-123'; // 测试用主口令

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

function makeTmp(): string {
  const dir = path.join(os.tmpdir(), 'flintkeep-test-' + cryptoRandom());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function run() {
  console.log('== 主密钥安全存储 (PBKDF2 + verifier) 测试 ==');
  const dir = makeTmp();

  // 1) 首次运行：传入口令即初始化 keystore
  const v1 = new Vault(dir, PP);
  assert(!v1.locked, '首次运行传入口令后保险库已解锁');
  assert(fs.existsSync(path.join(dir, 'keystore.json')), '已生成 keystore.json (salt + verifier)');

  // 2) 新增资产（合成数据，字段名需与 schema.ts 一致）
  // server 上旧式内联 SSH 凭证会在 reload/list 时自动拆到关联的 ssh_key
  v1.add({ type: 'server', name: 'web-01', ip: '10.0.0.1', sshPort: 22, sshUser: 'root', sshPassword: 'FAKE_PWD_1', openPorts: [22, 80, 443], tags: ['prod'] });
  v1.add({ type: 'cloud_account', name: 'aliyun-prod', provider: 'aliyun', accessKeyId: 'FAKE_AK_2', secretAccessKey: 'FAKE_SK_2', tags: [] });
  v1.add({ type: 'baota', name: 'bt-panel', ip: '10.0.0.2', panelUrl: 'http://10.0.0.2:8888', baotaUser: 'admin', baotaPassword: 'FAKE_PWD_3', baotaApiKey: 'FAKE_BTKEY_3', tags: [] });

  // 3) list 剥离敏感字段（迁移后多 1 条自动拆出的 SSH 登录）
  const list = v1.list();
  assert(list.length === 4, 'list 返回 4 项资产（含从 server 拆出的 SSH 登录）');
  assert(
    list.every((a) => !('sshPassword' in a) && !('secretAccessKey' in a) && !('baotaPassword' in a) && !('baotaApiKey' in a)),
    'list 结果不含 sshPassword / secretAccessKey / baotaPassword 等敏感字段'
  );

  // 4) get：凭证在关联的 SSH 登录上；server 有 publicIp
  const server = list.find((a) => a.name === 'web-01')!;
  const full = v1.get(server.id)!;
  assert(full.publicIp === '10.0.0.1' || full.ip === '10.0.0.1', 'server 公网 IP 已回填');
  assert(!full.sshPassword, 'server 上不再内联 sshPassword');
  const sshLogin = v1.list().find((a) => a.type === 'ssh_key' && a.name.includes('web-01'))!;
  assert(!!sshLogin, '已自动拆出 SSH 登录资产');
  const sshFull = v1.get(sshLogin.id)!;
  assert(sshFull.sshPassword === 'FAKE_PWD_1', 'SSH 登录资产含明文密码');

  // 5) getServerConnection：按公网 IP 命中，合并关联凭证
  const conn = v1.getServerConnection('10.0.0.1')!;
  assert(conn && conn.sshUser === 'root' && conn.sshPassword === 'FAKE_PWD_1', 'getServerConnection 按 IP 命中并返回凭证');

  // 6) 审计：设置 actor 后应有记录
  v1.setActor('claude-desktop/1.0');
  v1.get(server.id);
  const audit = v1.auditLog();
  assert(audit.some((e) => e.action === 'get_asset' && e.actor === 'claude-desktop/1.0'), '审计日志记录 actor 与动作');

  // 6b) Agent 自报操作审计（取完之后做了什么）
  const logged = v1.logAgentAction('已 SSH 登录 web-01 查看 nginx 错误日志', { target: 'web-01', command: 'tail -f /var/log/nginx/error.log' });
  assert(logged.action === 'agent_action' && logged.actor === 'claude-desktop/1.0' && logged.description.includes('nginx'), 'Agent 自报操作写入审计（含 actor 与描述）');
  const audit2 = v1.auditLog();
  assert(audit2.some((e) => e.action === 'agent_action' && e.description.includes('nginx')), '审计日志可检索到 agent_action 记录');

  // 7) 轮换提醒
  const old = new Date(Date.now() - 100 * 86400000).toISOString();
  const recent = new Date(Date.now() - 10 * 86400000).toISOString();
  v1.add({ type: 'api_key', name: 'old-key', username: 'svc', secret: 'FAKE_KEY_4', rotationReminderDays: 30, lastRotatedAt: old, tags: [] });
  v1.add({ type: 'api_key', name: 'new-key', username: 'svc', secret: 'FAKE_KEY_5', rotationReminderDays: 30, lastRotatedAt: recent, tags: [] });
  const due = v1.dueForRotation();
  assert(due.some((a) => a.name === 'old-key') && !due.some((a) => a.name === 'new-key'), '轮换提醒：超期项被标记、未超期项不标记');

  // 8) 重新打开（同一目录、正确口令）→ 必须能解锁并读到数据
  const v2 = new Vault(dir, PP);
  assert(!v2.locked, '再次用正确口令打开同一目录：已解锁');
  assert(v2.list().length === 6, '重新打开后资产数量一致 (含拆出的 SSH 登录与轮换项共 6 项)');

  // 9) 错误口令 → 必须抛 WrongPassphraseError
  let threw = false;
  try { new Vault(dir, 'wrong-passphrase'); } catch (e) { threw = e instanceof WrongPassphraseError; }
  assert(threw, '错误口令打开已存在的 keystore 抛出 WrongPassphraseError');

  // 10) 无口令构造 → 锁定态
  const v3 = new Vault(dir);
  assert(v3.locked, '不传口令构造 → 处于锁定态');

  // 10a) 资产关联 + 登录账号
  const sshKey = v1.add({
    type: 'ssh_key',
    name: 'prod-key',
    publicKey: 'ssh-rsa AAAA',
    privateKeyEnc: 'FAKE_PRIVATE',
    tags: [],
  });
  const loginAcc = v1.add({
    type: 'login_account',
    name: '阿里云主号',
    provider: '阿里云控制台',
    phone: '13800000000',
    secret: 'FAKE_LOGIN_PWD',
    tags: ['aliyun'],
  });
  const linkedServer = v1.add({
    type: 'server',
    name: 'linked-web',
    publicIp: '10.0.0.9',
    tags: [],
    links: [
      { id: sshKey.id, role: 'ssh_key' },
      { id: loginAcc.id, role: 'login' },
    ],
  });
  // 凭证写在 SSH 登录上
  v1.update(sshKey.id, { sshUser: 'root', authMethod: 'key', sshPort: 22 });
  assert(linkedServer.sshKeyId === sshKey.id, '关联 ssh_key 时自动同步 sshKeyId');
  const listedLogin = v1.list().find((a) => a.id === loginAcc.id)!;
  assert(!('secret' in listedLogin) && listedLogin.phone === '13800000000', '登录账号列表脱敏密码但保留手机号');

  // 私钥文件：独立加密目录 + get_server_connection 附带私钥
  const uploaded = v1.add({
    type: 'ssh_key',
    name: 'ed25519-box',
    keyFileName: '198.51.100.10_id_ed25519',
    privateKeyEnc: '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n',
    tags: [],
  });
  assert(!!uploaded.keyFileRel && fs.existsSync(path.join(dir, uploaded.keyFileRel!)), '私钥写入 data/ssh_keys 加密文件');
  const keyFileRaw = fs.readFileSync(path.join(dir, uploaded.keyFileRel!), 'utf8');
  assert(!keyFileRaw.includes('BEGIN OPENSSH'), '独立目录中的密钥文件为加密内容（不含明文头）');
  v1.update(uploaded.id, { sshUser: 'root', authMethod: 'key', sshPort: 22 });
  v1.add({
    type: 'server',
    name: 'box-134',
    publicIp: '198.51.100.10',
    tags: [],
    links: [{ id: uploaded.id, role: 'ssh_key' }],
  });
  const connKey = v1.getServerConnection('198.51.100.10')!;
  assert(!!connKey.privateKeyEnc && connKey.keyFileName === '198.51.100.10_id_ed25519', 'get_server_connection 附带关联私钥供 Agent 使用');

  v1.remove(linkedServer.id);
  v1.remove(sshKey.id);
  v1.remove(loginAcc.id);
  // box-134 / uploaded 留给后续数量断言前删掉
  const box = v1.list().find((a) => a.name === 'box-134');
  if (box) v1.remove(box.id);
  v1.remove(uploaded.id);

  // 10b) 修改主口令：旧口令失效，新口令可开，资产仍在
  const NEW_PP = 'new-passphrase-456';
  v2.changePassphrase(PP, NEW_PP);
  let oldThrew = false;
  try { new Vault(dir, PP); } catch (e) { oldThrew = e instanceof WrongPassphraseError; }
  assert(oldThrew, '改口令后旧口令被拒绝');
  const v2b = new Vault(dir, NEW_PP);
  assert(!v2b.locked && v2b.list().length === 6, '新口令可解锁且资产数量不变');
  // 后续备份用例改用新口令
  const PP_AFTER = NEW_PP;

  // 11) 加密备份导出 + 导入（跨目录恢复，需同一口令；含白名单）
  const wlSample = [
    {
      id: 'wl-1',
      name: 'home',
      provider: 'aliyun',
      assetId: 'asset-x',
      region: 'cn-hangzhou',
      prefixListId: 'pl-test',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify(wlSample, null, 2));
  fs.writeFileSync(
    path.join(dir, 'whitelist_schedule.json'),
    JSON.stringify({ enabled: true, intervalMinutes: 30 }, null, 2)
  );
  const backup = v2b.exportBackup();
  assert(backup.includes('flintkeep-backup'), '导出备份含格式标记');
  assert(backup.includes('"version": 2'), '导出备份为 version 2');
  assert(backup.includes('pl-test'), '导出备份含白名单绑定');
  const dir2 = makeTmp();
  const v4 = new Vault(dir2); // 锁定态
  v4.unlock(PP_AFTER); // 用同一口令解锁（新目录，首次创建 keystore）
  const impStats = v4.importBackup(backup, PP_AFTER);
  const restored = v4.list();
  assert(restored.length === 6, '导入备份后资产数量一致 (6 项)');
  assert(impStats.imported === 6 && impStats.whitelist === 1, '导入统计：6 资产 + 1 白名单');
  assert(restored.some((a) => a.name === 'old-key'), '导入备份含轮换资产 old-key');
  const wlRestored = JSON.parse(fs.readFileSync(path.join(dir2, 'whitelist.json'), 'utf8'));
  assert(Array.isArray(wlRestored) && wlRestored[0]?.prefixListId === 'pl-test', '导入后白名单绑定恢复');
  const wlSched = JSON.parse(fs.readFileSync(path.join(dir2, 'whitelist_schedule.json'), 'utf8'));
  assert(wlSched.enabled === true && wlSched.intervalMinutes === 30, '导入后白名单调度配置恢复');

  // 12) 错误口令导入 → 拒绝且不损坏本地
  let importThrew = false;
  try { v4.importBackup(backup, 'totally-wrong'); } catch (e) { importThrew = e instanceof WrongPassphraseError; }
  assert(importThrew, '错误口令导入备份抛出 WrongPassphraseError（不覆盖本地数据）');
  assert(v4.list().length === 6, '错误口令导入被拒后本地数据完好 (仍为 6 项)');

  // 13) Model B 代理注入：纯逻辑校验（不联网）
  const { buildProxyInjection } = await import('./proxy');
  const injHeader = buildProxyInjection({ type: 'api_key', secret: 'SECRET_A', proxyInject: { mode: 'header' } });
  assert(injHeader.headers['Authorization'] === 'Bearer SECRET_A', 'header 模式注入 Authorization: Bearer');
  const injCustom = buildProxyInjection({ type: 'api_key', secret: 'SECRET_A', proxyInject: { mode: 'header', headerName: 'X-API-Key' } });
  assert(injCustom.headers['X-API-Key'] === 'SECRET_A', 'header 自定义头名注入正确');
  const injBasic = buildProxyInjection({ type: 'api_key', username: 'u1', secret: 'pw1', proxyInject: { mode: 'basic' } });
  assert(injBasic.headers['Authorization'] === 'Basic ' + Buffer.from('u1:pw1').toString('base64'), 'basic 模式注入 Basic 认证');
  const injBt = buildProxyInjection({ type: 'baota', baotaApiKey: 'BTK', proxyInject: { mode: 'baota' } });
  assert(!!injBt.query['request_time'] && !!injBt.query['request_token'], 'baota 模式生成签名查询参数');

  // 14) Model B 代理集成：本地回显目标 + 代理转发，验证真实密钥被注入且令牌不含密钥
  const echoPort = 18923;
  const proxyPort = 18924;
  const echo = http.createServer((req, res) => {
    const hdrs: any = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, headers: hdrs, url: req.url }));
  });
  await new Promise<void>((r) => echo.listen(echoPort, () => r()));
  const v5 = new Vault(dir2, PP_AFTER); // 复用已解锁的 dir2（含 6 项资产）
  const asset = v5.add({ type: 'api_key', name: 'svc-proxy', username: 'u', secret: 'REAL_SECRET_X', baseUrl: `http://127.0.0.1:${echoPort}`, proxyInject: { mode: 'header', headerName: 'X-API-Key' }, tags: [] });
  const { ProxyServer } = await import('./proxy');
  // 上游是 http echo：本机链路，显式允许（等价于设置里打开「允许代理转发到 http 上游」）
  const px = new ProxyServer(v5, proxyPort, () => true);
  await px.listen();

  const token = v5.issueProxyToken(asset.id, 3600);
  assert(!token.includes('REAL_SECRET_X'), '签发的令牌不含真实密钥');

  // 用令牌经代理访问 → 回显目标应收到注入的 X-API-Key
  const fwd = await new Promise<any>((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/${asset.id}/v1/ping?tok=${token}`, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  assert(fwd.headers['x-api-key'] === 'REAL_SECRET_X', '代理转发时真实密钥被注入 (X-API-Key)');
  assert(fwd.url === '/v1/ping', '代理保留子路径转发');

  // 无效令牌 → 403
  const bad = await new Promise<number>((resolve) => {
    http.get(`http://127.0.0.1:${proxyPort}/${asset.id}/x?tok=bogus`, (r) => resolve(r.statusCode || 0)).on('error', () => resolve(0));
  });
  assert(bad === 403, '无效令牌经代理 → 403');

  await px.close();
  await new Promise<void>((r) => echo.close(() => r()));

  // 15) 云厂商签名正确性
  const { signingKey, hmacSha256Hex, awsCanonicalRequest, applyAliyunSignature } = await import('./proxy');
  // 15a) AWS SigV4 派生密钥 + 签名 对齐官方验证向量（techoverflow 提供）
  const k = signingKey('346NO6UJCAMHLHX4SMFA', '20130524', 'global', 's3');
  assert(hmacSha256Hex(k, 'ThisStringWillBeSigned') === '3be60989db53028ca485b46a07df9287a1731df74a234ea247a99febb7c2eb31', 'AWS SigV4 派生密钥 + 签名 对齐官方向量');
  // 15b) AWS 规范请求构造对齐 get-vanilla 文档向量
  const crUrl = new URL('https://example.amazonaws.com/');
  const crHeaders = { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' };
  const canonical = awsCanonicalRequest('GET', crUrl, crHeaders, '');
  const { createHash, createHmac } = await import('crypto');
  const EXPECTED_CANONICAL =
    'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert(canonical === EXPECTED_CANONICAL, 'AWS 规范请求构造对齐 get-vanilla 文档');

  // 15c) 阿里云 HMAC-SHA1 签名自校验：重算应与注入的 Signature 一致
  const aliyunAsset = { type: 'cloud_account', provider: 'aliyun', accessKeyId: 'TESTAK', secretAccessKey: 'TESTSK', cloudVersion: '2014-05-26' };
  const aliyunTarget = new URL('http://mock.aliyun.com/?Action=DescribeRegions');
  applyAliyunSignature(aliyunAsset, 'GET', aliyunTarget);
  const sp = aliyunTarget.searchParams;
  assert(!!sp.get('Signature') && sp.get('SignatureMethod') === 'HMAC-SHA1' && !!sp.get('Timestamp'), '阿里云签名生成 Signature / Timestamp / SignatureMethod');
  // 重算 stringToSign（不含 Signature 自身）并 HMAC，确认与注入 Signature 一致
  const enc = (s: string) => encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
  const keys = [...sp.keys()].filter((kk) => kk !== 'Signature').sort();
  const sorted = keys.map((kk) => `${enc(kk)}=${enc(sp.get(kk) || '')}`).join('&');
  const stringToSign = `GET&${enc('/')}&${enc(sorted)}`;
  // 规范要点：HMAC 密钥为 AccessKeySecret + "&"（早期漏掉 & ，真实调用会返回 IncompleteSignature）
  const recomputedHmac = createHmac('sha1', 'TESTSK&').update(stringToSign).digest('base64');
  assert(recomputedHmac === sp.get('Signature'), '阿里云签名自校验：重算 HMAC 与注入 Signature 一致');

  // 16) AWS SigV4 经代理全链路：echo 目标应收到 Authorization 头（含 Credential/Signature）
  const echo2Port = 18931;
  const echo2 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers }));
  });
  await new Promise<void>((r) => echo2.listen(echo2Port, () => r()));
  const v6 = new Vault(dir2, PP_AFTER);
  const awsAsset = v6.add({ type: 'cloud_account', name: 'aws-e2e', provider: 'aws', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', cloudService: 'sts', baseUrl: `http://127.0.0.1:${echo2Port}`, proxyInject: { mode: 'aws' }, tags: [] });
  const px2 = new ProxyServer(v6, 18932, () => true);
  await px2.listen();
  const awsTok = v6.issueProxyToken(awsAsset.id, 3600);
  const awsFwd = await new Promise<any>((resolve, reject) => {
    http.get(`http://127.0.0.1:18932/${awsAsset.id}/?tok=${awsTok}`, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  assert((awsFwd.headers['authorization'] || '').startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/') && (awsFwd.headers['authorization'] || '').includes('Signature='), 'AWS SigV4 经代理注入 Authorization（Credential+Signature）');
  await px2.close();
  await new Promise<void>((r) => echo2.close(() => r()));

  // 16b) 腾讯云 TC3 经代理注入：签名必须与真实转发请求逐字节一致
  const tcProxyEchoPort = 18955;
  let tcProxyReq: { headers: Record<string, any>; body: string; url: string } = { headers: {}, body: '', url: '' };
  const tcProxyEcho = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      tcProxyReq = { headers: req.headers, body: d, url: req.url || '/' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Response: { RequestId: 'tc3-proxy' } }));
    });
  });
  await new Promise<void>((r) => tcProxyEcho.listen(tcProxyEchoPort, () => r()));
  const v6b = new Vault(makeTmp(), PP_AFTER);
  const tcAsset = v6b.add({
    type: 'cloud_account',
    name: 'tencent-cvm',
    provider: 'tencent',
    accessKeyId: 'FAKE_SID',
    secretAccessKey: 'FAKE_SKEY',
    cloudService: 'cvm',
    region: 'ap-shanghai',
    baseUrl: `http://127.0.0.1:${tcProxyEchoPort}`,
    proxyInject: { mode: 'tencent' },
    tags: [],
  });
  // http 上游默认被拒，这里显式允许（本机 echo，等同于设置里的「允许转发到 http 上游」）
  const px2b = new ProxyServer(v6b, 18956, () => true);
  await px2b.listen();
  const tcTok = v6b.issueProxyToken(tcAsset.id, 3600);
  const tcResp = await new Promise<any>((resolve, reject) => {
    const rq = http.request(
      `http://127.0.0.1:18956/${tcAsset.id}/?Region=ap-shanghai&InstanceIds.0=ins-1`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-TC-Action': 'DescribeInstances',
          'X-TC-Version': '2017-03-12',
          Authorization: `Bearer ${tcTok}`,
        },
      },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }
    );
    rq.on('error', reject);
    rq.end('{"InstanceIds":["ins-1"]}');
  });
  assert(tcResp.status === 200, '腾讯云 TC3 经代理转发成功');
  const tcAuth = String(tcProxyReq.headers['authorization'] || '');
  assert(
    tcAuth.startsWith('TC3-HMAC-SHA256 Credential=FAKE_SID/') &&
      tcAuth.includes('SignedHeaders=content-type;host') &&
      /Signature=[0-9a-f]{64}$/.test(tcAuth),
    '腾讯云 TC3 经代理注入 Authorization（Credential / SignedHeaders / Signature）'
  );
  // 用 echo 真实收到的 URL / content-type / body 复算签名：这一步才能证明「签名与发出的请求一致」
  const { tc3CanonicalQuery, tc3SigningKey } = await import('./tcloud');
  const tcSha256h = (s: string) => createHash('sha256').update(s).digest('hex');
  const tcDateM = /Credential=FAKE_SID\/(\d{4}-\d{2}-\d{2})\//.exec(tcAuth);
  const tcRealUrl = new URL(`http://127.0.0.1:${tcProxyEchoPort}${tcProxyReq.url}`);
  const tcCanonical = [
    'POST',
    tcRealUrl.pathname,
    tc3CanonicalQuery(tcRealUrl),
    `content-type:${String(tcProxyReq.headers['content-type'])}`,
    `host:${tcRealUrl.host}`,
    '',
    'content-type;host',
    tcSha256h(tcProxyReq.body),
  ].join('\n');
  const tcSts = ['TC3-HMAC-SHA256', String(tcProxyReq.headers['x-tc-timestamp']), `${tcDateM?.[1]}/cvm/tc3_request`, tcSha256h(tcCanonical)].join('\n');
  const tcExpectSig = createHmac('sha256', tc3SigningKey('FAKE_SKEY', String(tcDateM?.[1]), 'cvm')).update(tcSts).digest('hex');
  assert(/Signature=([0-9a-f]{64})$/.exec(tcAuth)?.[1] === tcExpectSig, 'TC3 签名与真实转发请求逐字节一致（path / query / content-type / body）');

  // 缺 cloudService 时应拒绝并指出缺什么，而不是把未签名的请求发给上游
  const noSvc = v6b.add({
    type: 'cloud_account',
    name: 'tencent-nosvc',
    accessKeyId: 'A',
    secretAccessKey: 'B',
    baseUrl: `http://127.0.0.1:${tcProxyEchoPort}`,
    proxyInject: { mode: 'tencent' },
    tags: [],
  });
  const noSvcTok = v6b.issueProxyToken(noSvc.id, 3600);
  const noSvcResp = await new Promise<any>((resolve, reject) => {
    http.get(`http://127.0.0.1:18956/${noSvc.id}/?tok=${noSvcTok}`, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    }).on('error', reject);
  });
  assert(noSvcResp.status === 400 && String(noSvcResp.body).includes('cloudService'), '腾讯云缺 cloudService 时 400 并提示补字段');
  await px2b.close();
  await new Promise<void>((r) => tcProxyEcho.close(() => r()));

  // 17) SSH 会话代理：签发 / 校验 / 经 mock 目标透传 exec
  console.log('\n== SSH 会话代理 (Model B) 测试 ==');
  const { SshProxyServer, resolveSshTarget } = await import('./sshproxy');
  const ssh2mod = (await import('ssh2')).default;
  const MockSshServer = ssh2mod.Server;
  const SshClient = ssh2mod.Client;
  const dir3 = makeTmp();
  process.env.SSH_PROXY_PORT = '18940';
  const v7 = new Vault(dir3, PP);
  const sshCred = v7.add({
    type: 'ssh_key',
    name: 'ssh-target-login',
    sshPort: 18941,
    sshUser: 'root',
    sshPassword: 'FAKE_SSH_PWD',
    authMethod: 'password',
    tags: [],
  });
  const sshSrv = v7.add({
    type: 'server',
    name: 'ssh-target',
    publicIp: '127.0.0.1',
    tags: [],
    links: [{ id: sshCred.id, role: 'ssh_key' }],
  });
  const badType = v7.add({ type: 'api_key', name: 'not-server', secret: 'x', tags: [] });
  let sshIssueThrew = false;
  try {
    v7.issueSshAccess(badType.id);
  } catch {
    sshIssueThrew = true;
  }
  assert(sshIssueThrew, '非 server 资产签发 SSH 代理被拒绝');

  const access = v7.issueSshAccess(sshSrv.id, 600);
  assert(access.proxyHost === '127.0.0.1' && access.proxyPort === 18940 && !!access.token && access.ttl === 600, 'issueSshAccess 返回 proxyHost/port/token/ttl');
  assert(!access.token.includes('FAKE_SSH_PWD'), 'SSH 令牌不含真实密码');
  assert(access.targetHint.includes('127.0.0.1'), 'targetHint 含目标 IP');

  const resolved = resolveSshTarget(v7, v7.peek(sshSrv.id)!);
  assert(resolved.password === 'FAKE_SSH_PWD' && resolved.username === 'root', 'resolveSshTarget 解析密码认证');

  const { privateKey: targetPem } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const mockTarget = new MockSshServer({ hostKeys: [Buffer.from(targetPem)] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'root' && (ctx as any).password === 'FAKE_SSH_PWD') ctx.accept();
      else if (ctx.method === 'none') ctx.reject(['password']);
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _rej, info) => {
          const stream = acceptExec();
          stream.write('ECHO:' + info.command);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((r) => mockTarget.listen(18941, '127.0.0.1', () => r()));

  const bastion = new SshProxyServer(v7, dir3, 18940);
  await bastion.listen();

  // 无效令牌应被拒绝
  let badAuth = false;
  await new Promise<void>((resolve) => {
    const c = new SshClient();
    c.on('ready', () => { badAuth = false; c.end(); resolve(); })
      .on('error', () => { badAuth = true; resolve(); })
      .connect({ host: '127.0.0.1', port: 18940, username: 'invalid-token', password: 'x', readyTimeout: 5000, algorithms: undefined } as any);
  });
  assert(badAuth, '无效令牌连接 SSH 代理被拒绝');

  // 有效令牌经堡垒 exec，目标应收到命令并回显（Agent 侧无需真实密码）
  const execOut = await new Promise<string>((resolve, reject) => {
    const c = new SshClient();
    let buf = '';
    c.on('ready', () => {
      c.exec('uname -a', (err, stream) => {
        if (err) return reject(err);
        stream.on('data', (d: Buffer) => { buf += d.toString(); });
        stream.on('close', () => { c.end(); resolve(buf); });
      });
    }).on('error', reject)
      .connect({
        host: '127.0.0.1',
        port: 18940,
        username: access.token,
        password: 'ignored',
        readyTimeout: 8000,
        // 测试环境跳过 host key 校验
        hostVerifier: () => true,
      } as any);
  });
  assert(execOut.includes('ECHO:uname -a'), '经 SSH 堡垒透传 exec，目标回显命令');

  const sshAudit = v7.auditLog(50);
  assert(sshAudit.some((e) => e.action === 'proxy_access' && e.path === 'ssh-session'), 'SSH 会话写入 proxy_access 审计');

  // 18) 主机密钥校验（TOFU）：真实会话已记录指纹；一致放行、变更拒绝
  const { SshKnownHosts } = await import('./sshproxy');
  const khFile = path.join(dir3, 'ssh_known_hosts.json');
  assert(
    fs.existsSync(khFile) && Object.keys(JSON.parse(fs.readFileSync(khFile, 'utf8'))).length === 1,
    'SSH 堡垒已记录目标主机密钥指纹 (TOFU)'
  );
  const khDir = makeTmp();
  const kh = new SshKnownHosts(khDir);
  assert(kh.check('10.0.0.9', 22, 'FP_A') === true, '主机密钥首次连接记录并放行 (TOFU)');
  assert(kh.check('10.0.0.9', 22, 'FP_A') === true, '主机密钥一致放行');
  assert(kh.check('10.0.0.9', 22, 'FP_B') === false, '主机密钥变更被拒绝（防中间人）');
  assert(kh.check('10.0.0.9', 2222, 'FP_B') === true, '不同端口按独立条目记录');

  await bastion.close();
  await new Promise<void>((r) => mockTarget.close(() => r()));

  // 19) 白名单模块（整合 easy_whitelist）：IP 探测 / 阿里云前缀列表 / 腾讯云地址模板
  console.log('\n== 白名单模块 (easy_whitelist 整合) 测试 ==');
  const { detectPublicIp, isValidIpv4, extractIp, dedupIps } = await import('./ipdetect');
  const { WhitelistStore, buildAliyunRpcQuery, aliyunUpdatePrefixList, runBinding } = await import('./whitelist');
  const { tcloudCall, buildTc3Headers, tc3Signature } = await import('./tcloud');
  const { aliyunSignature } = await import('./proxy');

  assert(isValidIpv4('1.2.3.4') && !isValidIpv4('999.1.1.1') && !isValidIpv4('abc'), 'IP 校验：合法 IPv4 通过、非法拒绝');
  assert(extractIp('IP: 8.8.8.8 来自某处', /IP\s*:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/) === '8.8.8.8', '从响应正文提取 IP');
  assert(
    JSON.stringify(dedupIps(['1.1.1.1', '1.1.1.1', '2.2.2.2', 'bad'])) === JSON.stringify(['1.1.1.1', '2.2.2.2']),
    'IP 去重并剔除非法项'
  );

  const fakeFetch = async (_url: string) => ({ text: async () => 'IP: 203.0.113.7 来自某处' });
  const detected = await detectPublicIp({ fetcher: fakeFetch as any });
  assert(detected.length === 1 && detected[0] === '203.0.113.7', '注入 fetch 的公网 IP 探测（多源去重）');

  // 阿里云 RPC 查询串 + 签名自校验
  const q = buildAliyunRpcQuery({
    accessKeyId: 'FAKE_AK',
    accessKeySecret: 'FAKE_SK',
    action: 'ModifyPrefixList',
    params: { RegionId: 'cn-hangzhou', PrefixListId: 'pl-1' },
  });
  const qp = new URLSearchParams(q);
  assert(
    qp.get('Action') === 'ModifyPrefixList' && qp.get('AccessKeyId') === 'FAKE_AK' && qp.get('SignatureMethod') === 'HMAC-SHA1' && !!qp.get('Signature'),
    '阿里云 RPC 查询串含 Action / AccessKeyId / 签名方法与签名'
  );
  const qObj: Record<string, string> = {};
  for (const [k, val] of qp.entries()) qObj[k] = val;
  assert(aliyunSignature(qObj, 'FAKE_SK', 'GET') === qp.get('Signature'), '阿里云签名自校验：重算与内置 Signature 一致');

  // 独立复算一遍签名，锁死官方规范关键点：HMAC 密钥必须是 AccessKeySecret + "&"
  // （曾漏掉 & ，真实调用会返回 IncompleteSignature）
  const { aliyunEnc } = await import('./proxy');
  const sp2 = new URLSearchParams(
    buildAliyunRpcQuery({
      accessKeyId: 'AK_TEST',
      accessKeySecret: 'SK_TEST',
      action: 'DescribeSecurityGroups',
      params: { RegionId: 'cn-hangzhou' },
    })
  );
  const canonObj: Record<string, string> = {};
  for (const [k, v] of sp2.entries()) if (k !== 'Signature') canonObj[k] = v;
  const canon = Object.keys(canonObj)
    .sort()
    .map((k) => `${aliyunEnc(k)}=${aliyunEnc(canonObj[k])}`)
    .join('&');
  const sts = `GET&${aliyunEnc('/')}&${aliyunEnc(canon)}`;
  const expectSig = crypto.createHmac('sha1', 'SK_TEST&').update(sts).digest('base64');
  assert(
    expectSig === sp2.get('Signature'),
    '阿里云签名符合官方规范：HMAC 密钥为 AccessKeySecret+"&"（漏掉会导致 IncompleteSignature）'
  );

  // 阿里云前缀列表更新（本地 echo 模拟 ECS API）
  const aliEchoPort = 18951;
  let lastQuery = '';
  const aliEcho = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://localhost');
    lastQuery = u.search || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.searchParams.get('Action') === 'DescribePrefixListAttributes') {
      res.end(JSON.stringify({ Entries: { Entry: [{ Cidr: '198.51.100.1', Description: 'old' }] } }));
    } else {
      res.end(JSON.stringify({ RequestId: 'r1', Code: 'Success' }));
    }
  });
  await new Promise<void>((r) => aliEcho.listen(aliEchoPort, () => r()));
  const up = await aliyunUpdatePrefixList({
    accessKeyId: 'FAKE_AK',
    accessKeySecret: 'FAKE_SK',
    region: 'cn-hangzhou',
    prefixListId: 'pl-1',
    ips: ['203.0.113.7'],
    endpoint: `127.0.0.1:${aliEchoPort}`,
  });
  assert(up.ok && up.added?.[0] === '203.0.113.7' && up.removed?.[0] === '198.51.100.1', '阿里云前缀列表：移除旧条目 + 加入当前 IP（替换语义）');
  const mq = new URLSearchParams(lastQuery);
  assert(
    mq.get('Action') === 'ModifyPrefixList' && mq.get('AddEntry.1.Cidr') === '203.0.113.7' && mq.get('RemoveEntry.1.Cidr') === '198.51.100.1',
    'ModifyPrefixList 请求带 AddEntry / RemoveEntry 条目'
  );
  await new Promise<void>((r) => aliEcho.close(() => r()));

  // 腾讯云 TC3 签名与调用
  const tcH = buildTc3Headers({
    secretId: 'FAKE_SID',
    secretKey: 'FAKE_SKEY',
    action: 'ModifyAddressTemplateAttribute',
    host: 'vpc.tencentcloudapi.com',
    payload: '{"a":1}',
    service: 'vpc',
    version: '2017-03-12',
    region: 'ap-shanghai',
    timestamp: 1700000000,
  });
  assert(
    /^TC3-HMAC-SHA256 Credential=FAKE_SID\/\d{4}-\d{2}-\d{2}\/vpc\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/.test(tcH.Authorization),
    'TC3 Authorization 头格式正确（vpc/tc3_request + 64 位十六进制签名）'
  );
  assert(tcH['X-TC-Action'] === 'ModifyAddressTemplateAttribute' && tcH['X-TC-Version'] === '2017-03-12', 'TC3 请求头含 X-TC-Action / X-TC-Version');
  const s1 = tc3Signature('FAKE_SKEY', '2023-11-14', 'vpc', 'STS');
  assert(s1 === tc3Signature('FAKE_SKEY', '2023-11-14', 'vpc', 'STS') && /^[0-9a-f]{64}$/.test(s1), 'TC3 签名确定性且为 64 位十六进制');

  const tcEchoPort = 18952;
  let tcBody = '';
  const tcEcho = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      tcBody = d;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Response: { RequestId: 'r2' } }));
    });
  });
  await new Promise<void>((r) => tcEcho.listen(tcEchoPort, () => r()));
  const tcr = await tcloudCall({
    secretId: 'FAKE_SID',
    secretKey: 'FAKE_SKEY',
    action: 'ModifyAddressTemplateAttribute',
    region: 'ap-shanghai',
    endpoint: `127.0.0.1:${tcEchoPort}`,
    payload: { AddressTemplateId: 'atm-1', AddressesExtra: [{ Address: '203.0.113.7' }] },
  });
  assert(tcr.ok, '腾讯云调用（本地 echo）成功');
  assert(JSON.parse(tcBody).AddressesExtra?.[0]?.Address === '203.0.113.7', '腾讯云请求体带 AddressesExtra（整体替换语义）');
  await new Promise<void>((r) => tcEcho.close(() => r()));

  // 绑定存储 + 执行策略（停用跳过 / IP 未变跳过 / 缺 AK 失败 / 审计留痕）
  const dir4 = makeTmp();
  const wv = new Vault(dir4, PP);
  const cloudAk = wv.add({ type: 'cloud_account', name: 'aliyun-wl', provider: 'aliyun', accessKeyId: 'FAKE_AK', secretAccessKey: 'FAKE_SK', region: 'cn-hangzhou', tags: [] });
  const cloudNoAk = wv.add({ type: 'cloud_account', name: 'no-ak', provider: 'aliyun', region: 'cn-hangzhou', tags: [] });
  const ws = new WhitelistStore(dir4);
  const b1 = ws.add({ provider: 'aliyun', assetId: cloudAk.id, region: 'cn-hangzhou', prefixListId: 'pl-1', enabled: true });
  assert(ws.list().length === 1 && ws.get(b1.id)?.prefixListId === 'pl-1', '白名单绑定新增与读取');
  assert(!JSON.stringify(ws.list()).includes('FAKE_SK'), '绑定存储不含任何密钥');

  const bOff = ws.add({ provider: 'aliyun', assetId: cloudAk.id, region: 'cn-hangzhou', prefixListId: 'pl-2', enabled: false });
  const rOff = await runBinding(wv, ws, ws.get(bOff.id)!, { detect: { fetcher: fakeFetch as any } });
  assert(rOff.skipped === true && !rOff.ok, '停用的绑定执行被跳过');

  const bNoAk = ws.add({ provider: 'aliyun', assetId: cloudNoAk.id, region: 'cn-hangzhou', prefixListId: 'pl-3', enabled: true });
  const rNoAk = await runBinding(wv, ws, ws.get(bNoAk.id)!, { detect: { fetcher: fakeFetch as any } });
  assert(!rNoAk.ok && rNoAk.message.includes('AccessKey'), '缺少 AccessKey 时执行失败并给出明确原因');

  // 上次 IP 与当前一致 → 跳过调用（避免打满云 API QPS）
  const bSame = ws.add({ provider: 'aliyun', assetId: cloudAk.id, region: 'cn-hangzhou', prefixListId: 'pl-4', enabled: true, lastIp: '203.0.113.7' });
  const rSame = await runBinding(wv, ws, ws.get(bSame.id)!, { detect: { fetcher: fakeFetch as any } });
  assert(rSame.ok && rSame.skipped === true && rSame.ip === '203.0.113.7', 'IP 未变化时跳过云 API 调用');

  const wlAudit = wv.auditLog(50).filter((e: any) => e.action === 'whitelist_update');
  assert(wlAudit.length >= 3, '白名单执行写入 whitelist_update 审计');

  // ===== 白名单下拉：地域 / 地址模板 / 前缀列表 =====
  // 这些 ID 是云上生成的字符串，让用户手填极易填错，故一律实时拉取成下拉。
  // 解析路径写错（如漏了 Response 层）会静默返回空列表，这里用假响应锁死。
  const wl = await import('./whitelist');
  const fakeJson = (body: any) => (async () => ({ text: async () => JSON.stringify(body) })) as any;

  const tcRegions = await wl.tencentListRegions({
    secretId: 'SID',
    secretKey: 'SKEY',
    fetcher: fakeJson({ Response: { RegionSet: [{ Region: 'ap-guangzhou', RegionName: '华南地区(广州)' }, { Region: 'ap-shanghai', RegionName: '华东地区(上海)' }] } }),
  });
  assert(tcRegions.length === 2 && tcRegions[0].id === 'ap-guangzhou', '腾讯云地域列表解析 RegionSet（带中文名）');
  assert(tcRegions[0].name.includes('广州'), '地域显示中文名，不用对着 ap-guangzhou 猜');

  const tcTpl = await wl.tencentListAddressTemplates({
    secretId: 'SID',
    secretKey: 'SKEY',
    region: 'ap-guangzhou',
    fetcher: fakeJson({
      Response: {
        AddressTemplateSet: [
          { AddressTemplateId: 'atm-1', AddressTemplateName: '家里宽带', AddressSet: ['1.2.3.4', '5.6.7.8'] },
          { AddressTemplateId: 'atm-2', AddressTemplateName: '公司', AddressSet: [] },
        ],
      },
    }),
  });
  assert(tcTpl.length === 2 && tcTpl[0].id === 'atm-1', '腾讯云地址模板解析 AddressTemplateSet');
  assert(tcTpl[0].name.includes('家里宽带') && tcTpl[0].desc!.includes('1.2.3.4'), '模板项带名称与现有 IP，便于确认选对');
  assert(tcTpl[1].desc === '（暂无条目）', '空模板也标出来，不显示成空白');

  const aliRegions = await wl.aliyunListRegions({
    accessKeyId: 'AK',
    accessKeySecret: 'SK',
    fetcher: fakeJson({ Regions: { Region: [{ RegionId: 'cn-hangzhou', LocalName: '华东1（杭州）' }] } }),
  });
  assert(aliRegions.length === 1 && aliRegions[0].id === 'cn-hangzhou', '阿里云地域列表解析 Regions.Region');

  const aliPl = await wl.aliyunListPrefixLists({
    accessKeyId: 'AK',
    accessKeySecret: 'SK',
    region: 'cn-hangzhou',
    fetcher: fakeJson({ PrefixLists: { PrefixList: [{ PrefixListId: 'pl-1', PrefixListName: '白名单A', MaxEntries: 50 }] } }),
  });
  assert(aliPl.length === 1 && aliPl[0].id === 'pl-1', '阿里云前缀列表解析 PrefixLists.PrefixList');

  // 坑：腾讯云网关要求 X-TC-Region 头非空，传空串会直接被拒
  // （MissingParameter: The request is missing the required parameter Region），
  // 而 DescribeRegions 是全局接口、原本不需要地域 —— 所以必须有兜底值。
  let sentRegion = '';
  const capFetch = (body: any) =>
    (async (_u: string, init: any) => {
      sentRegion = String(init?.headers?.['X-TC-Region'] ?? '');
      return { text: async () => JSON.stringify(body) };
    }) as any;
  await wl.tencentListRegions({ secretId: 'SID', secretKey: 'SKEY', fetcher: capFetch({ Response: { RegionSet: [] } }) });
  assert(sentRegion === wl.TC_DEFAULT_REGION, '拉取地域时 X-TC-Region 有兜底值（空值会被网关拒）');
  await wl.tencentListAddressTemplates({
    secretId: 'SID', secretKey: 'SKEY', region: 'ap-shanghai',
    fetcher: capFetch({ Response: { AddressTemplateSet: [] } }),
  });
  assert(sentRegion === 'ap-shanghai', '拉模板时带上真实选择的地域');

  // 错误不能被静默成空列表：必须抛出，由接口层转成可展示的原因
  let tcErr = '';
  try {
    await wl.tencentListRegions({
      secretId: 'SID',
      secretKey: 'SKEY',
      fetcher: fakeJson({ Response: { Error: { Code: 'AuthFailure', Message: '权限不足' } } }),
    });
  } catch (e) {
    tcErr = (e as Error).message;
  }
  assert(/AuthFailure/.test(tcErr), '腾讯云报错要抛出（不能静默成空列表，否则用户以为没有可选资源）');

  // ===== 免费额度取舍规则（回归：绑定后额度被静默清空） =====
  // 真实事故：控制台令牌失效后，用户点「绑定」→ 84 条额度瞬间变 0 条且无任何提示。
  // 根因是把「绑定」当成取数开关、且把取数异常吞成 undefined。以下用例锁死新规则。
  // ===== 模型价目：摘要 / 去重 / 家族匹配 / 改价 diff（多厂商 CatalogSource 预留）=====
  {
    const {
      normalizePriceEntries,
      summarizePrices,
      diffCatalog,
      lookupCatalogModel,
      applyCatalogPrices,
      catalogModelFromRaw,
      appendCatalogHistory,
      CATALOG_SOURCES,
    } = await import('./model-catalog');

    const rawDup = [
      { priceName: '输入', type: 'input_token', price: '0.8', priceUnit: '每百万tokens' },
      { priceName: '输出', type: 'output_token', price: '2', priceUnit: '每百万tokens' },
      { priceName: '输入', type: 'input_token', price: '0.8', priceUnit: '每百万tokens' }, // 官方重复档
      { priceName: '输入（缓存命中）', type: 'input_token_cache', price: '0.1', priceUnit: '每百万tokens' },
    ];
    const prices = normalizePriceEntries(rawDup);
    assert(prices.length === 3, '价目去重：同 type+price+unit 只留一条');
    assert(summarizePrices(prices) === '入 0.8 / 出 2 · 百万tokens', '文本价摘要：入/出 + 单位');

    const video = normalizePriceEntries([
      { priceName: '视频生成（480P）', type: 'video_ratio_480p', price: '0.45', priceUnit: '每秒' },
      { priceName: '视频生成（720P）', type: 'video_ratio_720p', price: '0.9', priceUnit: '每秒' },
      { priceName: '视频生成（480P）', type: 'video_ratio_480p', price: '0.3', priceUnit: '每秒', discount: 0.7 },
    ]);
    assert(/480P 0\.45\/秒起/.test(summarizePrices(video)), '视频价摘要：取标准档最低分辨率');

    const free = normalizePriceEntries([
      { priceName: '输入', type: 'input_token', price: '0', priceUnit: '每百万tokens' },
      { priceName: '输出', type: 'output_token', price: '0', priceUnit: '每百万tokens' },
    ]);
    assert(summarizePrices(free) === '标价免费', '全零价 → 标价免费');

    const nested = normalizePriceEntries([{ prices: [{ price: '1', type: 'input_token', priceName: '输入', priceUnit: '每百万tokens' }] }]);
    assert(nested.length === 1 && nested[0].price === '1', 'DashScope 嵌套 prices[] 可展平');

    const fam = catalogModelFromRaw({
      model: 'qwen-plus',
      name: 'Qwen-Plus',
      capabilities: ['TG'],
      prices: rawDup,
    })!;
    assert(fam.id === 'qwen-plus' && fam.prices.length === 3, '从 CLI 原始项生成 CatalogModel');
    const hit = lookupCatalogModel([fam], 'qwen-plus-2025-07-14');
    assert(hit?.id === 'qwen-plus', '版本号模型按最长家族前缀匹配价目');
    const applied = applyCatalogPrices(
      [{ id: 'qwen-plus-2025-07-14', price: '按量', free: false }],
      [fam]
    );
    assert(applied[0].price === fam.price && (applied[0] as any).prices?.length === 3, '账号清单可挂上目录价');

    const prev = [fam];
    const next = [
      { ...fam, prices: normalizePriceEntries([{ priceName: '输入', type: 'input_token', price: '1.6', priceUnit: '每百万tokens' }, { priceName: '输出', type: 'output_token', price: '4', priceUnit: '每百万tokens' }]), price: '入 1.6 / 出 4 · 百万tokens' },
      catalogModelFromRaw({ model: 'new-model', name: 'New', capabilities: ['TG'], prices: [] })!,
    ];
    const d = diffCatalog(prev, next);
    assert(d.added.includes('new-model') && d.priceChanged.some((x) => x.id === 'qwen-plus'), '目录 diff：上新 + 改价');
    assert(d.removed.length === 0, '目录 diff：未下架时 removed 为空');

    const first = appendCatalogHistory(null, [fam], { provider: 'aliyun', source: 'bailian-cli', ts: '2026-01-01T00:00:00.000Z' });
    assert(first.history?.length === 0 && first.lastDiff?.added.length === 0, '首次拉目录不记「全量新增」噪音');
    const second = appendCatalogHistory(first, next, { provider: 'aliyun', source: 'bailian-cli', ts: '2026-01-02T00:00:00.000Z' });
    assert((second.history?.length || 0) === 1 && (second.history![0].priceChanged?.length || 0) >= 1, '二次拉取写入改价历史');

    assert(!!(CATALOG_SOURCES.aliyun && CATALOG_SOURCES.tencent && CATALOG_SOURCES.volcengine), '价目源已注册 aliyun / tencent / volcengine');
    // 火山：已接 Ark CLI；未登录时 fetchCatalog 应抛错（不静默 null）
    try {
      await CATALOG_SOURCES.volcengine.fetchCatalog();
    } catch (e) {
      assert(/Ark|未登录|凭证|arkcli/i.test(String((e as Error).message || e)), '火山价目未登录时给出明确错误');
    }
    // 腾讯云：已接 TokenHub；未登录时 fetchCatalog 应抛错（不静默 null）
    try {
      await CATALOG_SOURCES.tencent.fetchCatalog();
      assert(true, '腾讯云价目源已实现（已登录则拉到数据，未登录见下一断言）');
    } catch (e) {
      assert(/TokenHub|未登录|凭证|thcli/i.test(String((e as Error).message || e)), '腾讯云价目未登录时给出明确错误');
    }
  }

  // ===== TokenHub CLI 封装（腾讯云对等接入）=====
  {
    const {
      thBin,
      thBinPath,
      thcliAvailable,
      tokenhubPricesFromModel,
      tokenhubModelToCatalog,
      mapTokenHubQuotasFromPlanList,
      mapTokenHubQuotasFromEndpoints,
      readThProfileCreds,
      inferTokenhubBaseUrl,
    } = await import('./tokenhub-cli');
    const { getHandler, SUPPORTED_PROVIDERS } = await import('./ai-usage');

    assert(fs.existsSync(thBin()), '项目内已安装 thcli（node_modules/.bin/thcli）');
    assert(thBinPath().includes('thcli'), 'thBinPath 指向 thcli');
    assert(thcliAvailable().ok === true, 'thcliAvailable：已安装则 ok');
    assert(SUPPORTED_PROVIDERS.includes('tencent'), 'SUPPORTED_PROVIDERS 含 tencent');
    assert(getHandler('tencent')?.id === 'tencent', 'TencentHandler 已注册');

    const priced = tokenhubModelToCatalog({
      ModelId: 'hunyuan-lite',
      ModelName: '混元 Lite',
      Tags: ['Text'],
      Status: 'pre-offline',
      ReleaseAt: '2026-03-10T08:00:00+08:00',
      OfflineAt: '2026-11-12T00:00:00+08:00',
      DiscontinuedAt: '2026-10-31T00:00:00+08:00',
      FreeTrialInfo: { CapacitySize: 1000000, Unit: 'token', ValidityDays: 365 },
      ModelChargingInfo: [
        {
          ChargingItems: [
            { DisplayName: '输入', PriceName: 'input_token', Price: '0.1', PriceUnit: '每百万tokens' },
            { DisplayName: '输出', PriceName: 'output_token', Price: '0.2', PriceUnit: '每百万tokens' },
          ],
        },
      ],
    });
    assert(!!priced && priced.id === 'hunyuan-lite' && priced.prices.length === 2, 'TokenHub 模型可转 CatalogModel');
    // summarizePrices 认 type===input_token/output_token；否则走兜底「名称 价/单位」
    assert(priced!.price.length > 0, 'TokenHub 价摘要非空');
    assert(priced!.status === 'pre-offline' && priced!.offlineAt === '2026-11-12', '映射 Status / OfflineAt');
    assert(priced!.publishedAt === '2026-03-10' && priced!.freeTrial === true, '映射 ReleaseAt / FreeTrialInfo');

    const prices2 = tokenhubPricesFromModel({
      ModelChargingInfo: [{ ChargingItems: [{ PriceName: '输入', Price: '1', PriceUnit: '每百万tokens' }] }],
    });
    assert(prices2.length === 1 && prices2[0].price === '1', 'ChargingItems 归一化');

    const plans = mapTokenHubQuotasFromPlanList({
      TokenPlanSet: [
        {
          PlanName: 'trial-plan',
          ModelType: 'Text',
          PackageInfo: { TotalQuota: 1000, TotalUsed: 200, ExpireTime: '2026-12-31T00:00:00Z' },
        },
      ],
    });
    assert(plans.length === 1 && plans[0].remaining === 800 && plans[0].remainingPercent === 80, 'plan 额度映射 remaining/percent');
    assert(plans[0].expires === '2026-12-31', 'plan 到期日截取 YYYY-MM-DD');
    assert(plans[0].autoStop === null && plans[0].postpaid == null, 'plan 行无 PaymentEnabled');

    const eps = mapTokenHubQuotasFromEndpoints({
      EndpointSet: [
        {
          EndpointId: 'ep-abc',
          ModelId: 'ep-model-1',
          PaymentEnabled: true,
          FreeQuota: JSON.stringify({ Total: 100, Used: 40 }),
        },
        {
          EndpointId: 'ep-def',
          ModelId: 'ep-model-2',
          PaymentEnabled: false,
          FreeQuota: { Total: 50, Used: 10 },
        },
      ],
    });
    assert(eps.length === 2 && eps[0].remaining === 60, 'endpoint FreeQuota JSON 映射');
    assert(eps[0].postpaid === true && eps[0].autoStop === false && eps[0].endpointId === 'ep-abc', 'PaymentEnabled on → postpaid');
    assert(eps[1].postpaid === false && eps[1].autoStop === true && eps[1].remaining === 40, 'PaymentEnabled off → 近用完即停');

    // 现行 thcli：ModelEndpointSet + ChargeDetail.FreeQuota（领取后的真实形状）
    const live = mapTokenHubQuotasFromEndpoints({
      ModelEndpointSet: [
        {
          EndpointId: 'deepseek-v4.1-flash',
          ModelId: 'deepseek-v4.1-flash',
          ServiceType: 'TEXT_GENERATION',
          PaymentEnabled: false,
          ChargeDetail:
            '{"FreeQuota":{"TotalQuota":1000000,"UsedQuota":225,"UsagePercent":0,"ExpireTime":"2027-10-28T14:16:56Z"}}',
        },
        {
          EndpointId: 'kimi-k3.1-pro',
          ModelId: 'kimi-k3.1-pro',
          Status: 'VIRTUAL',
          PaymentEnabled: false,
          FreeTrialClaimed: false,
        },
      ],
    });
    assert(live.length === 1 && live[0].remaining === 999775, 'ChargeDetail.FreeQuota → remaining');
    assert(live[0].expires === '2027-10-28' && live[0].autoStop === true, 'ChargeDetail 到期日与用完即停');

    assert(inferTokenhubBaseUrl('cn', 'gz').includes('tencentmaas.com'), '国内站 Base URL');
    assert(inferTokenhubBaseUrl('intl', 'sg').includes('tencentcloudmaas.com'), '国际站 Base URL');

    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'thcli-creds-'));
    fs.writeFileSync(
      path.join(tdir, 'default.tokenhub.json'),
      JSON.stringify({ cn: { gz: { default: 'sk-tencent-TESTKEY999' } } })
    );
    const cred = readThProfileCreds('default', tdir)!;
    assert(cred.apiKey === 'sk-tencent-TESTKEY999', '读 tokenhub.json 明文 Key（不代跑 reveal）');
    fs.rmSync(tdir, { recursive: true, force: true });
  }

  // ===== Ark CLI 封装（火山引擎对等接入）=====
  {
    const {
      arkBin,
      arkBinPath,
      arkcliAvailable,
      arkPricesFromChargeItems,
      arkPricingRowToCatalog,
      mapArkFreeQuotasFromBalance,
      modalityFromArk,
      arkModelListItemToCatalog,
    } = await import('./ark-cli');
    const { getHandler, SUPPORTED_PROVIDERS } = await import('./ai-usage');

    assert(fs.existsSync(arkBin()), '项目内已安装 arkcli');
    assert(arkBinPath().includes('arkcli'), 'arkBinPath 指向 arkcli');
    assert(arkcliAvailable().ok === true, 'arkcliAvailable：已安装则 ok');
    assert(SUPPORTED_PROVIDERS.includes('volcengine'), 'SUPPORTED_PROVIDERS 含 volcengine');
    assert(getHandler('volcengine')?.id === 'volcengine', 'VolcengineHandler 已注册');

    const prices = arkPricesFromChargeItems({
      ChargeItems: [
        { Type: 'InferencePrompt', Price: 0.8, UnitCode: '千tokens' },
        { Type: 'InferenceCompletion', Price: 2, UnitCode: '千tokens' },
        { Type: 'BatchInferencePrompt', Price: 0.4, UnitCode: '千tokens' },
      ],
    });
    assert(prices.length === 2 && prices.some((p) => p.type === 'input_token'), 'Ark ChargeItems 过滤批量后映射出入');

    const cat = arkPricingRowToCatalog({
      FoundationModelName: 'doubao-seed-1-6',
      DisplayName: 'Doubao Seed 1.6',
      VendorName: 'Doubao',
      State: 'Available',
      InferenceFreeUsage: { Total: 500000, Consumed: 1000 },
      ChargeItems: [
        { Type: 'InferencePrompt', Price: 0.8, UnitCode: '千tokens' },
        { Type: 'InferenceCompletion', Price: 2, UnitCode: '千tokens' },
      ],
    });
    assert(!!cat && cat.id === 'doubao-seed-1-6' && cat.freeTrial === true, 'Ark pricing 行可转 CatalogModel');
    assert(cat!.prices.length === 2 && cat!.price.length > 0, 'Ark 价摘要非空');

    const quotas = mapArkFreeQuotasFromBalance({
      items: [
        {
          model: 'doubao-seed-1-6',
          free_usage: { total: 500000, consumed: 100000, remaining: 400000 },
          resource_packs: [{ type: 'FreeInference', total: 500000, consumed: 100000, remaining: 400000 }],
        },
      ],
    });
    assert(quotas.length === 1 && quotas[0].remaining === 400000 && quotas[0].remainingPercent === 80, 'Ark free-quota 映射');
    assert(quotas[0].autoStop === null, '火山无百炼式用完即停 → autoStop null');

    assert(
      modalityFromArk({
        foundation_model_tag: {
          filter_domains: ['Vision'],
          customized_tags: ['Vision', 'ImageGeneration'],
          task_types: ['text_to_image'],
        },
      }) === '图片',
      'Ark Vision/ImageGeneration → 图片'
    );
    assert(
      modalityFromArk({
        foundation_model_tag: {
          filter_domains: ['Voice'],
          customized_tags: ['Voice', 'SpeechSynthesis'],
        },
      }) === '语音',
      'Ark Voice → 语音'
    );
    assert(
      modalityFromArk({
        foundation_model_tag: {
          filter_domains: ['Vector'],
          customized_tags: ['Vector', 'TextVectorization'],
        },
      }) === '向量',
      'Ark Vector → 向量'
    );
    const listed = arkModelListItemToCatalog({
      name: 'doubao-seedream-5-0',
      display_name: 'Seedream',
      foundation_model_tag: {
        filter_domains: ['Vision'],
        customized_tags: ['Vision', 'ImageGeneration'],
      },
    });
    assert(listed?.modality === '图片' && (listed.capabilities || []).includes('ImageGeneration'), 'list 项带正确模态与能力标签');
  }

  const {
    decideFreeQuotas,
    cliErrorText,
    extractWorkspaceId,
    cliMatchReason,
    isBailianConsoleSessionError,
    isBailianTeamAuthError,
  } = await import('./ai-usage');
  assert(
    isBailianConsoleSessionError(new Error('Console session is not logged in or has expired.')),
    '会话过期文案识别为可续期'
  );
  assert(isBailianTeamAuthError(new Error('Console gateway error: BailianGateway.Team.NotAuthorised')), 'Team.NotAuthorised 识别');
  assert(!isBailianConsoleSessionError(new Error('ETIMEDOUT')), '超时不误判为会话过期');

  const Q1 = [{ model: 'qwen-plus' }] as any[];

  const d1 = decideFreeQuotas({ fresh: Q1, prevQuotas: [{ model: 'old' }] as any[], profile: 'default', prevFrom: 'default' });
  assert(d1.quotas === Q1 && d1.stale === false, '取数成功：一律用新值，不沿用旧值');

  const d2 = decideFreeQuotas({ fresh: undefined, prevQuotas: Q1, profile: 'default', prevFrom: 'default' });
  assert(d2.quotas === Q1 && d2.stale === true, '取数失败且同一 Profile：沿用旧值并标记 stale（不清空）');

  const d3 = decideFreeQuotas({ fresh: undefined, prevQuotas: Q1, profile: 'profile-2', prevFrom: 'default' });
  assert(d3.quotas === undefined && d3.stale === false, '换绑到别的 Profile：丢弃旧值，防止 A 账号额度显示在 B 账号');

  const d4 = decideFreeQuotas({ fresh: undefined, prevQuotas: undefined, profile: 'default', prevFrom: 'default' });
  assert(d4.quotas === undefined && d4.stale === false, '取数失败且从无旧值：返回空，由页面说明原因');

  const d5 = decideFreeQuotas({ fresh: undefined, prevQuotas: Q1, profile: 'default', prevFrom: undefined });
  assert(d5.quotas === Q1 && d5.stale === true, '老快照无来源标记：按 default 处理，仍能沿用（升级不丢数据）');

  const d6 = decideFreeQuotas({ fresh: [], prevQuotas: Q1, profile: 'default', prevFrom: 'default' });
  assert(d6.quotas?.length === 0 && d6.stale === false, '取数成功但为空数组：以空为准，不回退旧值');

  // 用户明确要求「选哪个账号就只显示哪个账号的数据」：未绑定一律不显示，
  // 哪怕历史上残留过别账号的额度也要清掉，避免误判归属。
  const d7 = decideFreeQuotas({ fresh: undefined, prevQuotas: Q1, profile: undefined, prevFrom: 'default' });
  assert(d7.quotas === undefined && d7.stale === false, '未绑定 CLI：一律不显示额度（即使有历史残留也清空）');

  assert(
    extractWorkspaceId('https://ws-2np8a7gkhwzg8ww2.cn-beijing.maas.aliyuncs.com') === 'ws-2np8a7gkhwzg8ww2',
    '从 Base URL 提取业务空间 ID（判断 CLI 身份归属的依据）'
  );
  assert(extractWorkspaceId('') === undefined && extractWorkspaceId(undefined) === undefined, '空 Base URL 返回 undefined');

  // CLI 明文 Key：default 在顶层，其它 Profile 嵌套；绑定时可据此写入资产
  {
    const { readCliProfileCreds } = await import('./ai-usage');
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailian-cfg-'));
    fs.writeFileSync(
      path.join(bdir, 'config.json'),
      JSON.stringify({
        api_key: 'sk-default-AAAA',
        base_url: 'https://ws-aaa.cn-beijing.maas.aliyuncs.com',
        workspace_id: 'ws-aaa',
        baogui: {
          api_key: 'sk-baogui-BBBB',
          base_url: 'https://ws-bbb.cn-beijing.maas.aliyuncs.com',
          workspace_id: 'ws-bbb',
        },
      })
    );
    const d = readCliProfileCreds('default', bdir)!;
    assert(d.apiKey === 'sk-default-AAAA' && d.workspaceId === 'ws-aaa', 'default Profile 从顶层读明文 Key');
    const b = readCliProfileCreds('baogui', bdir)!;
    assert(b.apiKey === 'sk-baogui-BBBB' && b.workspaceId === 'ws-bbb', '具名 Profile 从嵌套块读明文 Key');
    assert(readCliProfileCreds('missing', bdir) === null, '不存在的 Profile 返回 null');
    fs.rmSync(bdir, { recursive: true, force: true });
  }

  assert(
    cliMatchReason({ apiKey: 'sk-w...YS68' }, { apiKey: 'sk-w12345678YS68' }) === 'apiKey',
    'CLI 身份与本账号 API Key 掩码吻合 → 判定属于本账号'
  );
  assert(
    cliMatchReason({ workspaceId: 'ws-a' }, { workspaceId: 'ws-a' }) === 'workspace',
    '业务空间一致 → 判定属于本账号'
  );
  assert(cliMatchReason({ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }) === null, '业务空间不一致 → 判定不属于本账号');
  assert(cliMatchReason(null, { apiKey: 'x' }) === null, '无身份信息时无法判定（不误报匹配）');

  const e1 = cliErrorText(new Error('Console gateway error: BailianGateway.Team.NotAuthorised'));
  assert(/无权限|NotAuthorised|浏览器|一键续期/.test(e1), 'Team.NotAuthorised 要转成人话并引导浏览器续期（勿再怂恿 AK 覆盖）');

  const e2 = cliErrorText(new Error('No console access token found'));
  assert(e2.includes('bl auth login --console'), '未登录控制台要提示登录命令');

  assert(cliErrorText(new Error('boom')).includes('boom'), '未知错误原样透出，不吞掉原因');

  // 模型分类映射（回归：TR 向量/重排与全模态曾全落「其他」，用户以为后台没这模型）
  const { modalityOf } = await import('./ai-usage');
  assert(modalityOf(['TR']) === '向量', 'TR（向量/重排）归「向量」而不是「其他」');
  assert(modalityOf(['Multimodal-Omni']) === '全模态', '全模态（omni）归「全模态」而不是「其他」');
  assert(modalityOf(['3D-generation']) === '其他', '真正的异类（3D 生成）仍归「其他」');

  // ===== 并发写 / 原子写 / 锁定 / 设置（后台常驻安全性的回归）=====
  const cdir = makeTmp();
  const cvA = new Vault(cdir, PP);
  cvA.add({ type: 'note', name: '桌面端写入', content: 'A', tags: [] });
  // 模拟另一进程（MCP）：启动时加载，内存停留在只有 1 条资产的时刻
  const cvB = new Vault(cdir, PP);
  cvA.add({ type: 'note', name: '桌面端又写入', content: 'B', tags: [] });
  cvB.add({ type: 'note', name: 'MCP 写入', content: 'C', tags: [] });
  assert(new Vault(cdir, PP).list().length === 3, '双进程先后写入不互相覆盖（写前 reload）');
  assert(!fs.existsSync(path.join(cdir, 'vault.enc.json.tmp')), 'save() 后无残留 .tmp（原子写）');
  JSON.parse(fs.readFileSync(path.join(cdir, 'vault.enc.json'), 'utf8'));
  assert(true, 'vault.enc.json 始终是完整 JSON（rename 原子替换，写一半也不损坏）');

  cvA.lock();
  assert(cvA.locked, 'lock() 后进入锁定态');
  const cvC = new Vault(cdir, PP);
  assert(cvC.list().length === 3, '重新解锁后数据完好');

  const { SettingsStore, DEFAULT_SETTINGS } = await import('./settings');
  const st = new SettingsStore(cdir);
  const d = st.get();
  assert(d.closeAction === DEFAULT_SETTINGS.closeAction && d.autoLockMinutes === DEFAULT_SETTINGS.autoLockMinutes, '设置默认：后台常驻 + 15 分钟自动锁定');
  const stSaved = st.set({ closeAction: 'quit', autoLockMinutes: 9999 });
  assert(stSaved.closeAction === 'quit' && stSaved.autoLockMinutes === 1440, '非法值收敛：自动锁定上限 24 小时');
  assert(st.set({ closeAction: 'hacky' as any }).closeAction === 'quit', '非法 closeAction 被拒绝，保留原值');
  assert(new SettingsStore(cdir).get().closeAction === 'quit', '设置持久化到 settings.json');
  fs.rmSync(cdir, { recursive: true, force: true });

  // ===== 数据目录写锁（server / MCP / Electron 多进程读改写互斥）=====
  {
    const ldir = makeTmp();
    const lv = new Vault(ldir, PP);
    const lockPath = path.join(ldir, 'vault.enc.json.lock');
    const la = lv.add({ type: 'note', name: 'lock-a', content: 'x', tags: [] });
    assert(!fs.existsSync(lockPath), 'add 后不残留写锁文件');
    lv.update(la.id, { name: 'lock-a2' });
    lv.setCollection('workbench', { revenue: [] });
    lv.remove(la.id);
    assert(!fs.existsSync(lockPath), 'update / setCollection / remove 后均不残留写锁');

    const { withFileLock, FileLockTimeoutError } = await import('./file-lock');
    let reentered = 0;
    withFileLock(lockPath, () => {
      reentered += 1;
      withFileLock(lockPath, () => {
        reentered += 1;
      });
    });
    assert(reentered === 2 && !fs.existsSync(lockPath), '同进程重入不死锁且释放干净');

    // 外部进程持锁 → 本进程写操作应超时报错，而不是硬写覆盖别人的数据
    const lfd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(lfd, JSON.stringify({ pid: 12345 }));
    let blocked: any = null;
    try {
      lv.add({ type: 'note', name: 'blocked', content: 'x', tags: [] });
    } catch (e) {
      blocked = e;
    }
    fs.closeSync(lfd);
    fs.unlinkSync(lockPath);
    assert(blocked instanceof FileLockTimeoutError && String(blocked.message).includes('12345'), '外部持锁时写操作超时并指出持锁进程');
    fs.rmSync(ldir, { recursive: true, force: true });
  }

  // ===== 条目版本历史（每资产 10 版；回滚本身也可回滚）=====
  {
    const vdir = makeTmp();
    const vv = new Vault(vdir, PP);
    const va = vv.add({ type: 'api_key', name: 'ver-a', secret: 'SECRET_V1', tags: [] });
    assert(vv.listAssetVersions(va.id).length === 0, '版本历史：新增不产生版本');
    vv.update(va.id, { secret: 'SECRET_V2' });
    const vlist = vv.listAssetVersions(va.id);
    assert(
      vlist.length === 1 && vlist[0].changed.includes('secret') && !JSON.stringify(vlist).includes('SECRET_V1'),
      '版本历史：记录改前快照与变更字段名，摘要不含密钥'
    );
    vv.restoreAssetVersion(va.id, vlist[0].vid);
    assert(vv.get(va.id)?.secret === 'SECRET_V1', '版本历史：回滚恢复旧值');
    assert(vv.listAssetVersions(va.id)[0]?.source === 'restore', '版本历史：回滚本身留一版');
    for (let i = 0; i < 12; i += 1) vv.update(va.id, { username: 'u' + i });
    assert(vv.listAssetVersions(va.id).length === 10, '版本历史：每资产上限 10 版');
    fs.rmSync(vdir, { recursive: true, force: true });
  }

  // ===== 资产稳定序号（口头引用：服务器 3 号）=====
  const ndir = makeTmp();
  const nv = new Vault(ndir, PP);
  const sn1 = nv.add({ type: 'server', name: 'web-01', ip: '1.1.1.1', tags: [] });
  const sn2 = nv.add({ type: 'server', name: 'web-02', ip: '2.2.2.2', tags: [] });
  const cn1 = nv.add({ type: 'cloud_account', name: 'aliyun', provider: 'aliyun', accessKeyId: 'AK', secretAccessKey: 'SK', tags: [] });
  assert(sn1.no === 1 && sn2.no === 2, '同类型资产序号 1、2 递增');
  assert(cn1.no === 1, '不同类型独立编号（cloud_account 也从 1 开始）');
  nv.remove(sn1.id);
  const sn3 = nv.add({ type: 'server', name: 'web-03', ip: '3.3.3.3', tags: [] });
  assert(sn3.no === 3, '删除后序号不回收（新资产拿 3 而非复用 1）');
  assert(new Vault(ndir, PP).get(sn2.id)!.no === 2, '序号落库持久化（重载后不变）');

  // project 类型（机房场景的数据基座）
  const prj = nv.add({ type: 'project', name: '示例项目', kind: 'Web 应用', status: 'dev', progress: 60, urls: { web: 'https://x.example' }, links: [{ id: sn2.id, role: 'server' }], tags: [] });
  assert(prj.no === 1 && prj.type === 'project', 'project 类型可入保险库并分配序号');

  // 缺号资产（旧版数据）在加载时自动补新号，且不动已有编号
  nv.update(sn2.id, { no: undefined } as any);
  const nvB = new Vault(ndir, PP);
  assert(nvB.get(sn2.id)!.no === 4 && nvB.get(sn3.id)!.no === 3, '缺号补新号（不冲突），已有编号不受影响');
  const connByNo = nvB.getServerConnection('3');
  assert(!!connByNo && JSON.stringify(connByNo).includes('3.3.3.3'), 'getServerConnection("3") 按序号命中 3 号服务器');

  // Agent 常把 SSH 登录建成独立 ssh_key（自带主机地址）：request_ssh_access 应能直接签发（回归）
  const standaloneKey = nvB.add({ type: 'ssh_key', name: '独立登录', sshHost: '5.5.5.5', sshPort: 2222, sshUser: 'ubuntu', sshPassword: 'FAKE_PW_X', tags: [] });
  const issued = nvB.issueSshAccess(standaloneKey.id, 60);
  assert(issued.targetHint === 'ubuntu@5.5.5.5:2222', '自带主机地址的独立 ssh_key 可直接签发 SSH 代理');
  fs.rmSync(ndir, { recursive: true, force: true });

  // ===== MCP stdio 服务（协议协商 / 工具清单 / 白名单与用量工具 / 崩溃兜底）=====
  const { spawn } = await import('child_process');
  const { TOOL_SPECS, TOOL_SPECS_V2, MCP_TOOL_GUIDE } = await import('./mcp-meta');
  // v2 之后默认工具面是 9 个入口，GUIDE 跟着 TOOL_SPECS_V2 派生；27 个老工具只在 full 档出现
  assert(
    MCP_TOOL_GUIDE.length === TOOL_SPECS_V2.length && TOOL_SPECS_V2.every((t) => MCP_TOOL_GUIDE.some((g) => g.name === t.name)),
    'MCP_TOOL_GUIDE 由 TOOL_SPECS_V2 派生（单一来源，默认只暴露 9 个入口）'
  );
  assert(
    TOOL_SPECS.every((t) => !MCP_TOOL_GUIDE.some((g) => g.name === t.name)),
    '27 个老工具默认不出现在工具指南（需 full 档开启）'
  );

  const mdir = makeTmp();
  const mv = new Vault(mdir, PP);
  mv.add({ type: 'note', name: '部署备忘', content: 'nginx 配置在 /etc/nginx/conf.d', tags: [] });
  mv.setCollection('workbench', { revenue: [{ amount: 100, label: '服务费' }], costs: [] });
  const cloud = mv.add({ type: 'cloud_account', name: 'aliyun-test', provider: 'aliyun', accessKeyId: 'FAKE_AK_M', secretAccessKey: 'FAKE_SK_M', tags: [] });
  // 内联 SSH 凭证的 server：reload 时会自动拆出关联的 ssh_key（供类型别名测试用）
  mv.add({ type: 'server', name: 'web-01', ip: '9.9.9.9', sshUser: 'root', sshPassword: 'FAKE_PW_Z', tags: [] });
  const { AiUsageStore } = await import('./ai-usage');
  // 绑定设为 disabled：whitelist_sync 不会真实外呼云厂商
  const wlBinding = new WhitelistStore(mdir).add({ provider: 'aliyun', assetId: cloud.id, region: 'cn-hangzhou', enabled: false, name: '禁用绑定' });
  new AiUsageStore(mdir).saveSnapshot({
    accountId: cloud.id, provider: 'aliyun', ts: new Date().toISOString(),
    balance: { amount: 12.5, currency: 'CNY' }, modelTotal: 3,
  } as any);

  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [path.join(process.cwd(), 'src', 'core', 'mcp.ts')], {
    env: { ...process.env, VAULT_DATA_DIR: mdir, VAULT_PASSPHRASE: PP },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (m: any) => void>();
  let mcpStderr = '';
  child.stdout.on('data', (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      } catch { /* 忽略非 JSON 行 */ }
    }
  });
  child.stderr.on('data', (b) => { mcpStderr += String(b); });
  child.on('error', (e) => { mcpStderr += String(e); });
  const ask = (id: number, method: string, params?: any) => new Promise<any>((resolve, reject) => {
    pending.set(id, (m) => (m.result ? resolve(m.result) : reject(new Error(JSON.stringify(m.error || m)))));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`MCP 响应超时 id=${id}`)); }, 20000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const callTool = async (id: number, name: string, args: any) => JSON.parse((await ask(id, 'tools/call', { name, arguments: args })).content[0].text);

  try {
    const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '0.0.1' } });
    assert(init.protocolVersion === '2025-06-18', 'initialize 回显受支持的客户端协议版本');

    const tl = await ask(2, 'tools/list');
    const names: string[] = tl.tools.map((t: any) => t.name);
    assert(tl.tools.length === TOOL_SPECS.length, `tools/list 返回全部 ${TOOL_SPECS.length} 个工具`);
    assert(['whitelist_status', 'whitelist_sync', 'ai_usage_snapshot'].every((n) => names.includes(n)), '白名单与模型用量工具已进入 MCP 工具清单');

    const st = await callTool(3, 'whitelist_status', { detect: false });
    assert(st.bindings.length === 1 && st.bindings[0].enabled === false, 'whitelist_status 返回绑定列表与启停状态');
    assert(st.schedule && st.schedule.enabled === false, 'whitelist_status 返回调度配置');

    // 回归：缺 params 的坏请求曾会让 stdio 进程未捕获异常直接崩掉（Agent 端表现为 MCP 掉线）
    const bad = await ask(4, 'tools/call');
    assert(Array.isArray(bad?.content) && String(bad.content[0].text).includes('未知工具'), '坏请求（缺 params）返回错误结果而不是崩溃');

    const la = await callTool(5, 'list_assets', {});
    assert(Array.isArray(la) && la.some((a: any) => a.type === 'note'), '坏请求之后服务仍存活（list_assets 正常响应）');
    assert(Array.isArray(la) && la.every((a: any) => typeof a.no === 'number'), 'list_assets 输出稳定序号 no（供口头引用）');

    const us = await callTool(6, 'ai_usage_snapshot', {});
    const acct = us.accounts.find((a: any) => a.accountId === cloud.id);
    assert(acct?.accountName === 'aliyun-test' && acct.snapshot?.balance?.amount === 12.5, 'ai_usage_snapshot 返回本地缓存快照与账号名');

    const syAll = await callTool(7, 'whitelist_sync', {});
    assert(syAll.results.length === 0, 'whitelist_sync 不带 id 时只同步启用中的绑定（禁用绑定被跳过）');
    const syOne = await callTool(8, 'whitelist_sync', { bindingId: wlBinding.id });
    assert(syOne.results.length === 1 && syOne.results[0].skipped === true, 'whitelist_sync 指定禁用绑定 → 返回 skipped（不真实外呼云端）');
    const auditText = fs.readFileSync(path.join(mdir, 'audit.log.jsonl'), 'utf8');
    assert(auditText.includes('"actor":"test-client/0.0.1"') && auditText.includes('whitelist_update'), '同步写审计，actor 为 initialize 上报的客户端身份');

    // 桌面端自动锁定不得打断正在工作的 Agent（教训：锁标记曾造成"间歇性找不到一切"）。
    // 即使数据目录残留 .locked 标记，MCP 也必须继续服务。
    fs.writeFileSync(path.join(mdir, '.locked'), new Date().toISOString());
    const lk = await callTool(9, 'list_assets', {});
    assert(Array.isArray(lk) && lk.length > 0, '遗留锁标记不影响 MCP 服务（Agent 不受桌面端锁定影响）');
    fs.rmSync(path.join(mdir, '.locked'), { force: true });
    const unl = await callTool(10, 'list_assets', {});
    assert(Array.isArray(unl), '无标记时同样正常');

    // 按类型 + 序号取资产（"备忘录 1 号"）
    const gno = await callTool(11, 'get_asset', { type: 'note', no: 1 });
    assert(gno && gno.name === '部署备忘', 'MCP 支持按类型+序号取资产（type+no）');

    // 类型宽容解析：Agent 常传中文标签/别名，不能让它拿到空列表就说"找不到"
    const byCn = await callTool(12, 'list_assets', { type: '服务器' });
    assert(Array.isArray(byCn) && byCn.every((a: any) => a.type === 'server') && byCn.length >= 1, '中文类型名「服务器」可正常过滤');
    const byAlias = await callTool(13, 'get_asset', { type: 'SSH 登录', no: 1 });
    assert(byAlias && byAlias.type === 'ssh_key', '别名/中文标签 + 序号可取到资产');
    const badType = await callTool(14, 'list_assets', { type: '不存在的东西' });
    assert(badType && badType.error && badType.hint, '未知类型返回明确错误与可用类型提示（而不是空列表）');

    // 工作台业务数据（收支/成本等）不在资产里，通过加密集合正常暴露给 MCP
    const cols = await callTool(15, 'list_collections', {});
    assert(Array.isArray(cols) && cols.includes('workbench'), 'MCP 可列出加密集合（工作台业务数据可见）');
    const wb = await callTool(16, 'get_collection', { name: 'workbench' });
    assert(wb && wb.revenue?.[0]?.amount === 100, 'MCP 可读取工作台收支数据');
  } catch (e) {
    fail++;
    console.error('  ✗ MCP stdio 测试失败：', (e as Error).message, mcpStderr ? '\n  stderr: ' + mcpStderr.slice(0, 500) : '');
  } finally {
    child.kill();
    fs.rmSync(mdir, { recursive: true, force: true });
  }

  // ===== 审计日志轮转（回归：audit.log.jsonl 无限增长）=====
  const adir = makeTmp();
  const av = new Vault(adir, PP, { auditMaxBytes: 400 });
  for (let i = 0; i < 60; i++) av.logAgentAction('压测动作 ' + i, { seq: i });
  assert(fs.existsSync(path.join(adir, 'audit.log.jsonl.1')), '审计超过阈值自动轮转出 .1 归档');
  assert(fs.statSync(path.join(adir, 'audit.log.jsonl')).size <= 400 + 300, '主审计文件滚动后从阈值附近重新开始（不超过阈值+单条）');
  fs.rmSync(adir, { recursive: true, force: true });

  // ===== 每日自动备份（回归：误删/损坏无副本可救）=====
  const bdir = makeTmp();
  const bv = new Vault(bdir, PP);
  bv.add({ type: 'note', name: '备份源', content: 'x', tags: [] });
  const { DailyBackup } = await import('./backup');
  const bk = new DailyBackup(bdir, 3);
  const r1 = bk.run(new Date('2026-10-01T10:00:00'));
  assert(!!r1 && r1.files.includes('vault.enc.json') && r1.files.includes('keystore.json'), '每日备份包含加密库与 keystore');
  assert(bk.run(new Date('2026-10-01T12:00:00')) === null, '当天无变动不重复备份');
  bv.add({ type: 'note', name: '当天又改了', content: 'y', tags: [] });
  assert(bk.run(new Date('2026-10-01T15:00:00')) !== null, '当天有变动时刷新当天备份');
  for (const d of ['2026-10-02', '2026-10-03', '2026-10-04']) {
    bv.add({ type: 'note', name: 'day ' + d, content: 'z', tags: [] });
    assert(bk.run(new Date(d + 'T10:00:00')) !== null, d + ' 产生备份');
  }
  assert(bk.list().length === 3, '只保留最近 keep=3 天的备份目录');
  fs.rmSync(bdir, { recursive: true, force: true });

  // ===== REST 安全（Host 校验 / 解锁退避 / 活动心跳 / 手动锁定）：真实 server 子进程 =====
  const sdir = makeTmp();
  new Vault(sdir, PP); // 预置 keystore，让错误口令真的返回 401
  const sport = 18000 + Math.floor(Math.random() * 1000);
  const sproc = spawn(tsx, [path.join(process.cwd(), 'server.ts')], {
    env: {
      ...process.env,
      VAULT_DATA_DIR: sdir,
      PORT: String(sport),
      PROXY_PORT: String(sport + 1),
      SSH_PROXY_PORT: String(sport + 2),
      VAULT_PASSPHRASE: '', // 不做启动自动解锁
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvErr = '';
  sproc.stdout.resume(); // 丢弃日志防止管道堵塞
  sproc.stderr.on('data', (b) => { srvErr += String(b); });

  function reqHttp(opts: http.RequestOptions, body?: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: sport, ...opts }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }); }
          catch { resolve({ status: res.statusCode || 0, body: d }); }
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.end(JSON.stringify(body));
      else req.end();
    });
  }

  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await reqHttp({ path: '/api/locked', method: 'GET' })).status === 200) { ready = true; break; } } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(ready, 'REST 服务子进程启动就绪');

    const evil = await reqHttp({ path: '/api/locked', method: 'GET', headers: { Host: 'evil.example' } });
    assert(evil.status === 403, '非回环 Host 被拒绝（DNS rebinding 防护）');
    const ok1 = await reqHttp({ path: '/api/locked', method: 'GET' });
    assert(ok1.status === 200 && ok1.body.locked === true, '回环 Host 正常访问，初始为锁定态');

    const bad1 = await reqHttp({ path: '/api/unlock', method: 'POST' }, { passphrase: 'wrong-pass' });
    assert(bad1.status === 401, '错误口令返回 401');
    const bad2 = await reqHttp({ path: '/api/unlock', method: 'POST' }, { passphrase: 'wrong-pass' });
    assert(bad2.status === 429 && bad2.body.retryAfterMs > 0, '连续失败触发退避（429 + retryAfterMs）');
    await new Promise((r) => setTimeout(r, 1100));
    const good = await reqHttp({ path: '/api/unlock', method: 'POST' }, { passphrase: PP });
    assert(good.status === 200 && good.body.ok === true, '退避窗口过后正确口令可解锁');

    const act = await reqHttp({ path: '/api/activity', method: 'POST' });
    assert(act.status === 200, '活动心跳接口可用（防纯浏览被自动锁定误伤）');

    await reqHttp({ path: '/api/lock', method: 'POST' });
    const st = await reqHttp({ path: '/api/locked', method: 'GET' });
    assert(st.body.locked === true, '手动锁定接口生效');
    await reqHttp({ path: '/api/unlock', method: 'POST' }, { passphrase: PP });

    // 机房主页：TCP 连通性检测（本机起一个真监听口 → 必须在线；不存在的 id → 404）
    const { createServer: tcpServer } = await import('net');
    const nls = tcpServer();
    await new Promise<void>((r) => nls.listen(0, '127.0.0.1', () => r()));
    const nport = (nls.address() as any).port as number;
    const sVault = new Vault(sdir, PP);
    const dev = sVault.add({ type: 'server', name: 'probe-me', ip: '127.0.0.1', sshPort: nport, tags: [] });
    const chk = await reqHttp({ path: `/api/studio/check?id=${dev.id}`, method: 'GET' });
    assert(chk.status === 200 && chk.body.ok === true && typeof chk.body.ms === 'number', `机房检测：真监听口返回在线（${chk.body.ms}ms）`);
    const chk404 = await reqHttp({ path: '/api/studio/check?id=no-such', method: 'GET' });
    assert(chk404.status === 404, '机房检测：不存在的资产返回 404');
    nls.close();
  } catch (e) {
    fail++;
    console.error('  ✗ REST 安全测试失败：', (e as Error).message, srvErr ? '\n  stderr: ' + srvErr.slice(0, 500) : '');
  } finally {
    sproc.kill();
    fs.rmSync(sdir, { recursive: true, force: true });
  }

  console.log('\n== 项目探测特征校验测试 ==');
  {
    const pdir = makeTmp();
    const mkSrv = (body: string) => new Promise<{ srv: import('http').Server; port: number }>((resolve) => {
      const srv = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as any).port }));
    });
    const a = await mkSrv('<html><title>项目A</title></html>');
    const b = await mkSrv('<html><title>别人的服务</title></html>');
    const { writeProjects } = await import('./project-store');
    const { probeOnce } = await import('./project-probe');
    const rec = (id: string, port: number, fp?: string) => ({
      id, name: id, cwd: pdir, commands: [{ cmd: 'noop' }],
      probe: { ports: [port], healthUrl: `http://127.0.0.1:${port}`, ...(fp ? { fingerprint: fp } : {}) },
    });
    writeProjects(pdir, {
      version: 1,
      projects: [
        rec('fp-hit', a.port, '项目A'),      // 指纹命中 → running
        rec('fp-miss', b.port, '项目A'),    // 端口开着但内容是别人的 → 不算在跑
        rec('no-fp', b.port),               // 没配指纹 → 维持旧行为（2xx 即在跑）
      ],
    });
    const st = await probeOnce(pdir);
    assert(st['fp-hit']?.status === 'running', `特征校验：指纹命中判 running`);
    assert(st['fp-miss']?.status === 'stopped', `特征校验：端口被别人占不误判（实际=${st['fp-miss']?.status}）`);
    assert(st['no-fp']?.status === 'running', '未配指纹时维持旧行为（2xx 即在线）');
    a.srv.close(); b.srv.close();
    fs.rmSync(pdir, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.rmSync(dir3, { recursive: true, force: true });
  fs.rmSync(dir4, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

run();
