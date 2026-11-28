# 燧垒（FlintKeep）

[简体中文](README.md) · [English](README.en.md)

燧垒是一个本地加密的基础设施凭证与资产保险库：Agent 通过 MCP 使用密钥，但永远看不到密钥。

## 功能

- 多类型资产：服务器(含开放端口)、SSH 密钥、云账号、OSS、宝塔面板、MCP 配置、通用密钥
- AES-256-GCM 加密本地存储，列表/搜索默认脱敏，敏感字段不落地展示
- **密钥轮换提醒**：每个资产可设“多少天提醒换密 + 最近换密日期”，到期在界面打「⚠ 待换密」标，支持「待轮换」筛选
- Agent 接入：内置 MCP stdio 服务，Agent 取连接信息；审计记录调用方/动作/时间/资产
- **Agent 自报操作审计**：Agent 取完凭证后通过 `log_agent_action` 工具/接口上报“它做了什么”（如“已 SSH 登录 web-01 查看 nginx 日志”），与取密记录拼成完整审计链，回答“取完之后干了啥”
- **加密备份 / 恢复**（设置页）：导出一份自包含加密备份（燧垒 + keystore + 白名单绑定/调度），可迁移到其它机器；导入需同一主口令校验，**错误口令直接拒绝且不覆盖本地数据**。不含模型用量与百炼 CLI 登录态
- **Model B 代理注入（真密钥不进 Agent 上下文）**：为资产申请「短期令牌 + 本地代理基址」，Agent 经代理发起真实 API 调用，**真实密钥由代理服务端注入**，Agent 只持令牌（不含任何密钥）；注入模式覆盖 header / Basic / 宝塔 API 签名，**以及云厂商请求签名（AWS SigV4 / 阿里云·腾讯云 HMAC-SHA1）**——让云账号、OSS 也走 Model B，真密钥不落 Agent 上下文
- **Model B SSH 会话代理（本地堡垒）**：`request_ssh_access` 签发短期令牌；Agent 执行 `ssh -p 8789 <token>@127.0.0.1`，真实密码/私钥由本地 `ssh2` 代理注入目标机，全程不进 Agent 上下文
- 审计日志：所有取密、新增、改动、Agent 自报操作、代理访问均留痕（界面审计页单独高亮 `agent_action`）
- 界面：资产增删改查、解锁遮罩、轮换筛选、设置页**加密备份导入/导出**、详情页**签发 HTTP/SSH 代理**
- **IP 白名单自动更新**：家庭宽带公网 IP 变了，云上放行规则自动跟着改 —— 阿里云更新**前缀列表**、腾讯云更新 **IP 地址模板**；IP 没变就不调云 API（避免限流）；支持应用内定时与系统级定时（`npm run whitelist:run`）
- **模型用量（AI 用量监控）**：云账号的余额 / 消费 / 资源包 / 模型清单，以及**模型免费额度**（额度、到期、重置、用完即停）；免费额度走百炼官方 CLI，多账号各自绑定、**归属严格**（未绑定就不显示，绝不把 A 账号的额度显示到 B 账号）
- **备忘录 + 字段管理**：`note` 类型资产随手写；列与新增/编辑表单都由字段定义驱动——设置页可改内置字段显示名、控制是否作为列/是否进表单，也可新增自定义字段（文本/数字/下拉/日期/敏感等，值存 `asset.extra`，参与展示与搜索）；每个资产 tab 仍可独立配置显示列（上限 20，列多自动横向滚动）
- **桌面客户端**：`npm run desktop` 一键启动，退出重开即加载新代码（启动前自动清理残留后端进程）
- **托盘后台常驻 + 自动锁定**：关闭窗口默认缩到菜单栏托盘继续运行（白名单定时同步、用量自动刷新、Agent 的 MCP 与代理令牌不中断），设置页可改为「退出程序」；无操作自动锁定（默认 15 分钟，可调可关）或托盘一键锁定——锁定后取密、代理、SSH 堡垒、MCP 工具调用全部拒绝，重新输口令恢复
- **每日自动备份**：`data/backups/daily-YYYY-MM-DD/` 滚动保存最近 7 天的加密库与白名单配置（纯密文文件拷贝，无需解锁、不产生明文），与手动导出互为双保险
- **防爆破与站点隔离**：解锁口令连续失败指数退避（1s→2s→4s…封顶 60s）；REST 仅接受回环 Host（防 DNS rebinding 读走备份）；复制敏感值 30 秒后自动清空剪贴板

## 设计取向（重要）

- **自己写、不 fork** GitHub 项目；但架构借鉴成熟开源方案的设计思路：Keygate（alias + 代理 + 审计 + MCP）、Teleport（审计/会话录屏）、ClawVault（仪表盘/审计）、Infisical（Agent Proxy）、gopass（加密存储）。协议不开源的只学思路，不动代码。
- **协议**：本项目代码采用 **AGPL-3.0-only** 开源——闭源分发或闭源服务化需另行获得商业授权；「燧垒 / FlintKeep」名称与 Logo 不在授权范围内，衍生项目须改名发布。

## 与同类产品的对比

燧垒的定位不是「又一个密码管理器」，而是 **AI Agent 的凭证管道**：本地加密保险库 + Agent 自取凭证 + 真密钥不进上下文 + 审计闭环。

| 能力                                              | 燧垒                 | 1Password / Bitwarden                                      | Infisical / HashiCorp Vault | psst / sallyport 等新锐 |
| ------------------------------------------------- | -------------------- | ---------------------------------------------------------- | --------------------------- | ----------------------- |
| 本地加密存储（数据不出设备）                      | ✅                   | ❌（云同步托管）                                           | ❌（服务端托管）            | 部分                    |
| Agent 经 MCP 自取凭证                             | ✅                   | ❌（1Password 官方明确不做 MCP server，仅 CLI 运行时解析） | CLI/SDK 为主                | ✅                      |
| 真密钥不进 Agent 上下文（代理注入）               | ✅ HTTP + SSH 全覆盖 | ❌                                                         | 部分                        | 理念相近、实现不全      |
| 云厂商请求签名注入（AWS SigV4 / 阿里云 / 腾讯云） | ✅                   | ❌                                                         | ❌                          | ❌                      |
| SSH 本地堡垒（令牌连接、真凭证注入目标机）        | ✅                   | ❌（SSH agent 仅本地签名）                                 | ❌                          | ❌                      |
| 审计闭环（取密记录 + Agent 自报操作）             | ✅                   | 活动日志                                                   | ✅                          | 部分                    |
| 密钥轮换提醒                                      | ✅                   | Watchtower 弱密码检测                                      | 部分                        | ❌                      |
| 国内云白名单自动更新（阿里云/腾讯云）             | ✅                   | ❌                                                         | ❌                          | ❌                      |
| 模型用量 / 免费额度监控                           | ✅                   | ❌                                                         | ❌                          | ❌                      |

> 1Password™ 是 AgileBits Inc. 的商标；Bitwarden、Infisical、HashiCorp Vault 等为各自所有者的商标。燧垒（FlintKeep）与上述产品无关联、未获其背书，本表仅为功能事实的描述性对比。

## 技术栈

- 前端：Vue3 + Vite（可视化界面）
- 本地服务：Node http（REST API，供界面与 Agent 之外的工具调用）
- 加密存储：AES-256-GCM 本地文件；主密钥由「用户口令 + 随机 salt」经 PBKDF2（21 万次迭代）派生，落地只存 salt + verifier（keystore.json），密钥仅在内存，重启需重输口令
- Agent 对接：内置 MCP stdio 服务（自实现 JSON-RPC，无第三方 SDK）
- 桌面壳：Electron（最终打包步骤，见下）

## 目录

```
flintkeep/
  src/core/        纯逻辑（可 Node 直接测）
    schema.ts      数据模型 + 敏感字段
    vault.ts       加密燧垒 + 脱敏列表 + 审计(含调用方)
    proxy.ts       HTTP Model B 代理注入
    sshproxy.ts    SSH Model B 本地堡垒
    mcp.ts         MCP stdio 服务（Agent 接入点）
    mcp-meta.ts    MCP 工具定义（单一来源：stdio 服务与界面教程共用）
    ipdetect.ts    公网 IP 探测
    whitelist.ts   IP 白名单（阿里云前缀列表 / 腾讯云地址模板）
    ai-usage.ts    模型用量（云账单 + 模型清单 + 百炼 CLI 免费额度）
    settings.ts    应用设置（关窗行为 / 自动锁定时长）
    backup.ts      每日自动备份（滚动保留最近 7 天）
    tcloud.ts      腾讯云 TC3-HMAC-SHA256 签名
    test.ts        核心自测（149 断言）
  src/renderer/    Vue 界面（资产清单/增删改查/审计/白名单/模型用量/备忘录）
  server.ts        REST API + 生产静态服务
  electron/        Electron 桌面壳（main.mjs + 启动前端口清理）
  data/            运行时生成的加密燧垒 + 审计日志（勿提交）
```

## 快速开始

```bash
npm install

# 1) 核心自测（含 PBKDF2 / verifier / HTTP 代理 / SSH 堡垒 / 白名单 / 用量 等断言）
npm run core:test

# 2) 桌面客户端（推荐）
npm run desktop

#    或跑浏览器版（开发模式：前端 8790 + 本地服务 8787）
npm run dev
#   浏览器打开 http://localhost:8790 → 首次进入输口令解锁（即初始化 keystore）

# 3) 让 Agent 接入：解锁后打开界面顶栏「MCP 接入」页
#    方式一：复制通用说明，贴进任意支持 MCP 的 Agent 对话，由它自己登记这个 stdio 服务
#    方式二：按页内 JSON 片段合并进自己客户端的 MCP 配置（command/args/env 三项通用）
#    MCP 从 VAULT_PASSPHRASE 读口令（无法弹窗）；必须与解锁口令相同。
```

> 兼容旧版：若数据目录里还有旧版（直接 `sha256(VAULT_MASTER_KEY)` 做密钥）的 `vault.enc.json` 且没 keystore，设置 `VAULT_MASTER_KEY` 启动时会自动迁移到 PBKDF2 方案。

## MCP 工具清单（Agent 可调用的工具）

标准路径是「找 → 看 → 用」，`initialize` 下发的 instructions 里写着同样的话：

- `find` / `show` / `connect`：找资产 → 看详情（默认脱敏，不含任何密钥字段）→ 换短期凭据。
  `connect` 返回可直接执行的 `ssh` 命令，或代理地址 + 令牌；真实密钥由本地代理注入，不进 Agent 上下文。
- `manage` / `run_project` / `sync_whitelist` / `usage` / `note` / `backup`：其余任务入口。
  注意 `usage` 是模型用量快照，不是使用说明。

默认只下发这 9 个入口。需要字段/类型/集合等配置能力时，在设置里打开「完整工具集」；
其中 `get_asset`、`get_server_connection` **已停用**，调用会被转到 `show` / `connect`，结果里带
`deprecated` 与 `next`，指向该用的新工具。

**Agent 默认拿不到明文。** 要看密码/私钥原文，只有两个出口：

- 桌面端：在设置里打开「允许 Agent 查看密钥」后，`show(target, reveal=true)` 才返回明文并写审计；
- 终端：`fk show --reveal` / `fk env` / `fk inject`，不受这个开关限制。

备忘录即 `note` 类型资产，正文可被 `find` 搜索到。

REST 另有：`GET /api/backup/export`、`POST /api/backup/import {backup, passphrase}`、`POST /api/agent-action {description, meta}`、`POST /api/proxy/issue {assetId, ttl}`、`POST /api/ssh/issue {assetId, ttl}`、`GET /api/rotation`、`GET /api/audit`、`POST /api/unlock {passphrase}`、`POST /api/lock`（手动锁定）、`GET|PUT /api/settings`（关窗行为/自动锁定）、`POST /api/activity`（活动心跳）。独立端口：HTTP 代理默认 `PORT+1`=8788；SSH 堡垒默认 `SSH_PROXY_PORT`=8789。

## 安全模型

- **数据不出设备**：凭证库只存在本机（AES-256-GCM 加密），绝不上传任何第三方；白名单同步、用量查询等云端自动化仅调用你自己配置的 API 密钥、操作你自己的云账号。
- 燧垒文件整体 AES-256-GCM 加密；明文只在内存解密。
- **主密钥派生**：用户口令 + 随机 16 字节 salt，PBKDF2-HMAC-SHA256（21 万次迭代）派生出 32 字节 AES-256 密钥。落地的 `keystore.json` 只存 `salt` + `verifier`（一段用派生密钥加密的已知明文）。
- **解锁校验**：派生密钥后解密 verifier 比对；口令错则 GCM 校验失败 / 明文不符，直接抛 `WrongPassphraseError`，绝不用错误密钥去解密燧垒，避免静默损坏。
- **内存密钥**：派生密钥只存在于进程内存，重启后必须从 keystore 用口令重新派生；桌面端通过 `POST /api/unlock` 传口令，服务端默认锁定（返回 423），解锁后才开放数据接口。
- **自动锁定**：无操作超过设定时长（默认 15 分钟）即锁定——清除内存密钥、停掉代理与 SSH 堡垒。**只影响桌面端/REST，不影响 Agent 的 MCP**：MCP 持有口令是既定设计，锁标记挡不住新进程、只会打断正在工作的会话；要断开 Agent 访问请删除其 MCP 配置。界面上的点击/按键会重置计时，纯浏览不会被误锁。
- **解锁防爆破**：口令连续失败按指数退避强制等待（封顶 60 秒），窗口期内连正确口令也拒绝。
- **DNS rebinding 防护**：REST 只接受 `127.0.0.1` / `localhost` / `[::1]` 的 Host 头，恶意网页把域名重绑定到本机也无法以同源身份读取响应。
- **审计轮转**：audit.log.jsonl 超过 5MB 自动滚动保留最近 3 代，长期使用不会无限膨胀。
- 列表/搜索默认剥离敏感字段；仅显式 `get` / `get_server_connection` 返回明文并写审计。
- 审计记录调用方（Agent 身份）、动作、时间、资产 —— 回答“哪个 Agent 什么时候取了什么”；Agent 另可通过 `log_agent_action`（MCP 工具 / `POST /api/agent-action`）上报“取完之后做了什么”，补全审计闭环。
- **两种取用模式**：v1 = 明文直给 + 审计（Model A）；v2 = 代理注入（Model B，真密钥不进 Agent 上下文）。
  - **HTTP Model B**：`request_proxy_access` / `POST /api/proxy/issue` → 端口 8788；`proxyInject.mode`：`header` / `basic` / `baota` / `aws`（SigV4）/ `aliyun`（HMAC-SHA1）。
  - **SSH Model B**：`request_ssh_access` / `POST /api/ssh/issue` → 端口 8789；Agent 用令牌作 username 连本地堡垒，`ssh2` 注入真实密码或关联 `ssh_key` 私钥拨目标机；写 `proxy_access` 审计。
  - **已验证（core:test）**：HTTP 注入与云签名；SSH 签发/拒签/无效令牌拒绝/经 mock 目标透传 exec。

## 桌面端（Electron）

```bash
# 推荐：一键启动（Vite 热更新 + Electron 同进程启动 REST/代理）
npm run desktop
#   退出后重开即加载新代码 —— 启动前会自动清掉上一轮残留的后端进程

# 开发：仅 Electron 开发窗
npm run dev:electron
#   窗口加载 http://127.0.0.1:8790（API 经 Vite 代理到 8787）

# 生产预览：先 build 静态资源，Electron 打开 http://127.0.0.1:8787
npm run start:electron
```

> 首次安装 Electron 二进制较慢时，可设环境变量  
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后再 `npm i`。  
>
> 端口 `8787` 若被其它程序占用：换端口 `set PORT=8799 && npm run desktop`；  
> 想在别的终端同时保留 `npm run dev`：`set KEEP_EXISTING_BACKEND=1`。

### 打 Windows 安装包

```powershell
npm run dist:win   # 前端 → dist/、后端 → build/、electron-builder → release/
```

产物 `release/FlintKeep-<version>-setup.exe`（NSIS，按用户安装，不需要管理员权限）。
安装包里已经处理好三件事：后端/MCP/CLI 全部预编译成 JS 并用 Electron 自带的 Node 运行（目标机不需要 Node）、
内置 `bl` / `arkcli` / `thcli` 三个云 CLI（安装版也能查模型用量）、安装根目录带一个 `fk.cmd`（等价于源码态的 `fk`）。

### Windows 上的 SSH agent

Windows 没有 Unix domain socket，agent 监听命名管道 `\\.\pipe\flintkeep-agent-<用户名>`。
在 `%USERPROFILE%\.ssh\config` 里加两行即可让 `ssh` / `git` 用上保险库里的密钥（Win32-OpenSSH 不读 `SSH_AUTH_SOCK`）：

```
Host *
  IdentityAgent //./pipe/flintkeep-agent-<用户名>
```

`fk agent env` 会直接打印这两行；想零配置接管系统 agent 管道，用 `fk agent run --takeover`
（前提是系统 `ssh-agent` 服务保持停止）。macOS / Linux 仍是原来的 `SSH_AUTH_SOCK=<dataDir>/agent.sock`，行为不变。

## IP 白名单

「白名单」页：探测当前公网 IP → 与云上现有条目比对 → **IP 变了才更新**。

| 厂商   | 更新对象        | 说明                                                                      |
| ------ | --------------- | ------------------------------------------------------------------------- |
| 阿里云 | ECS 前缀列表    | `DescribePrefixLists` / `ModifyPrefixList`（RPC HMAC-SHA1）               |
| 腾讯云 | VPC IP 地址模板 | `DescribeAddressTemplates` / `ModifyAddressTemplateAttribute`（整体替换） |

腾讯云的安全组规则只是**引用**地址模板，改模板即自动放行，所以「安全组 ID」只是备注；模板需先在控制台「VPC → IP 地址模板」建好。地域与模板 ID 由页面实时下拉获取，不用手填（需只读权限：腾讯云 `QcloudVPCReadOnlyAccess`、阿里云 `AliyunECSReadOnlyAccess`）。

## 模型用量

余额 / 消费 / 资源包走阿里云 BssOpenApi；模型清单走 DashScope；**免费额度只能走百炼官方 CLI `bl`**（模型清单 API 不含额度字段，官方也无公开额度 API）。

```bash
bl auth login --console                        # 首次：浏览器登录
bl auth login --console --config profile-2     # 第二个阿里云账号：登录到独立 Profile
```

之后在页面「模型用量 → CLI 身份」里把 Profile 绑定到对应云账号（页面内有「＋ 添加 CLI 登录身份」4 步引导，命令可直接复制）。**不做花钱探测**：探测要真实调模型、消耗额度且易触发风控，已关闭；CLI 侧靠定时 + 限频。

控制台 access_token 会过期，过期后页面直接提示重新登录（此时用 AK/SK 生成 token 无效，必须重走浏览器登录）。

## 验证

```bash
npm run core:test      # 149 断言（加密/并发写/锁定/备份/MCP 子进程 E2E/REST 安全等）
npm run smoke:server   # /api/locked 锁态冒烟
npm run smoke:memo     # 备忘录冒烟（11/11）
npm run smoke:whitelist# 白名单冒烟（19/19）
npm run build
```
