/**
 * MCP 接入元数据（不启动 stdio、不碰保险库），供三处共用：
 * - mcp.ts：stdio 服务的 tools/list 直接返回 TOOL_SPECS
 * - server.ts / 界面教程：MCP_TOOL_GUIDE 由同一份定义派生，避免双份手工维护
 */
import { TYPE_LABELS } from './schema';
import { FIELD_KINDS } from './builtin-fields';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] };
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_assets',
    description: '列出保险库中的资产（内置 11 类 + 用户自定义类型），只返回元数据不含敏感字段。项目档案用 type=project 读；收支/成本等业务台账不在这里，用 list_collections + get_collection。每条带稳定序号 no（每类独立编号，创建后不变），用户说「服务器 3 号」时可据此定位。可按类型或标签过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '资产类型 key（server/ssh_key/...）或中文名；也支持用户自定义类型（note 为备忘录）' },
        tag: { type: 'string', description: '按标签过滤' },
      },
    },
  },
  {
    name: 'search_assets',
    description: '按关键词搜索资产（名称/IP/备注/备忘录正文等），返回元数据。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_asset',
    description: '获取一项资产的完整信息（含敏感凭证与自定义字段 extra），会写审计日志。可传 id，也可传 type + no（稳定序号，如 type=server&no=3 即「服务器 3 号」，序号见 list_assets 输出）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '资产 id' },
        type: { type: 'string', description: '资产类型（与 no 搭配按序号取）' },
        no: { type: 'number', description: '该类型内的稳定序号（与 type 搭配）' },
      },
    },
  },
  {
    name: 'get_server_connection',
    description:
      '按服务器名称、公网/私网 IP 或序号取连接信息（target 传纯数字即按「N 号」匹配，如 "3" = 服务器 3 号）。凭证来自关联的 SSH 登录（用户/端口/密码或私钥）；更安全可用 request_ssh_access（真密钥不进上下文）。会写审计。',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: '名称 / IP / 纯数字序号' } }, required: ['target'] },
  },
  {
    name: 'add_asset',
    description:
      '新增一项资产。建模约定：服务器建 server 类型（机器档案：名称/公网IP/端口），SSH 用户/密码/私钥建 ssh_key 类型（SSH 登录），并通过 sshKeyId 或 links:[{id,role:"ssh_key"}] 把登录关联到 server —— request_ssh_access 面向 server（或自带 sshHost 的独立 ssh_key）。敏感字段请直接传明文，保险库会加密存储。用户自定义字段放在 extra 对象里（键形如 cf_xxx，定义见界面「设置 → 字段管理」），只用于展示/搜索。',
    inputSchema: { type: 'object', properties: { asset: { type: 'object' } }, required: ['asset'] },
  },
  {
    name: 'update_asset',
    description: '更新资产。自定义字段放在 patch.extra 里合并（传空字符串可清空某一项）；其余字段按 key 覆盖。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] },
  },
  {
    name: 'delete_asset',
    description: '删除资产。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_field_schema',
    description:
      '读取资产类型与字段定义（内置字段 + 用户自定义字段）。用于回答「这个类型有哪些字段」「某个字段叫什么/是什么类型」；返回 key、中文显示名、控件类型、是否敏感、是否作为列/进表单。type 可传类型 key 或中文名，不传则返回全部；传 * 只看所有类型通用的自定义字段。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '资产类型 key 或中文名；不传=全部；*=所有类型通用的自定义字段' },
      },
    },
  },
  {
    name: 'upsert_field',
    description:
      '新增或修改字段定义。内置字段只能改显示名/是否作为列/是否进表单（kind 不可改）；自定义字段可以改类型、选项、敏感标记等。新增自定义字段不要传 key 或传空字符串，保存后返回生成的 cf_ 开头 key。改字段会影响应用界面的列与表单，属于 full 权限操作。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '资产类型 key 或中文名；*=所有类型通用' },
        key: { type: 'string', description: '改已有自定义字段时传；新增留空' },
        label: { type: 'string', description: '显示名（新增必填）' },
        kind: { type: 'string', enum: FIELD_KINDS, description: '字段类型' },
        secret: { type: 'boolean', description: '敏感字段：列表/搜索中脱敏' },
        options: { type: 'array', items: { type: 'string' }, description: 'kind=select 时的选项' },
        list: { type: 'boolean', description: '是否可作为列' },
        form: { type: 'boolean', description: '是否出现在新增/编辑表单' },
        hint: { type: 'string', description: '表单里的提示文案' },
        width: { type: 'number', description: '列宽 px（可选）' },
      },
      required: ['type'],
    },
  },
  {
    name: 'delete_field',
    description:
      '删除一个自定义字段。内置字段不能删除（可用 upsert_field 把 list 或 form 设为 false 隐藏）。删除字段定义不会清掉资产里已存在的值，但界面不再展示。属于 full 权限操作。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '资产类型 key 或中文名；*=所有类型通用' },
        key: { type: 'string', description: '字段 key（cf_ 开头）' },
      },
      required: ['type', 'key'],
    },
  },
  {
    name: 'upsert_asset_type',
    description:
      '新增或修改自定义资产类型。不传 key=新增（label 必填，可给 category 分类、color 颜色 #rrggbb）；传 key=改名/改分类/改颜色。内置类型不能修改。新类型可随后用 upsert_field 添加字段。属于 full 权限操作。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '自定义类型 key（ct_ 开头）；新增不传' },
        label: { type: 'string', description: '类型名称，如「数据库」' },
        category: { type: 'string', description: '分类，如「云资源」「账号与密钥」' },
        color: { type: 'string', description: '颜色 #rrggbb（可选）' },
      },
      required: ['label'],
    },
  },
  {
    name: 'delete_asset_type',
    description:
      '删除自定义资产类型；该类型下还有资产时会被拒绝，需要先删除或改类型。字段定义会一并清理。内置类型不能删除。属于 full 权限操作。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: '自定义类型 key（ct_ 开头）' } },
      required: ['key'],
    },
  },
  {
    name: 'log_agent_action',
    description: 'Agent 在取用凭证后，主动上报它“做了什么”（如“已 SSH 登录 web-01 查看 nginx 错误日志”）。便于事后审计“取完之后干了啥”。',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '本次操作的文字描述' },
        meta: { type: 'object', description: '可选结构化附带信息（如 {target, command}）' },
      },
      required: ['description'],
    },
  },
  {
    name: 'export_backup',
    description: '导出一份自包含的加密备份（加密保险库 + keystore + 白名单绑定/调度），供迁移到其它机器或离线冷备。不含模型用量/CLI 登录态。返回 JSON 字符串。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'import_backup',
    description: '导入备份：需传入备份 JSON 与主口令（用于校验），校验通过才写回资产与白名单。便于从冷备恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        backup: { type: 'string', description: 'export_backup 返回的备份 JSON 字符串' },
        passphrase: { type: 'string', description: '原备份所用的主口令' },
      },
      required: ['backup', 'passphrase'],
    },
  },
  {
    name: 'request_proxy_access',
    description: 'Model B：为某资产申请一个短期代理访问令牌与代理基址。Agent 之后通过该基址发起真实 API 调用，真实密钥由代理服务端注入，永不进入 Agent 上下文（避免明文泄露）。',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '资产 id' },
        ttl: { type: 'number', description: '令牌有效期秒，默认 3600' },
      },
      required: ['assetId'],
    },
  },
  {
    name: 'request_ssh_access',
    description:
      'Model B SSH：为 server 资产（或自带 sshHost 主机地址的 ssh_key 登录资产）申请短期本地堡垒令牌。Agent 用 ssh -p <proxyPort> <token>@127.0.0.1 连接，真实密码/私钥由本地代理注入目标机，永不进入 Agent 上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'server 资产 id；自带主机地址的 ssh_key 也可以' },
        ttl: { type: 'number', description: '令牌有效期秒，默认 3600' },
      },
      required: ['assetId'],
    },
  },
  {
    name: 'whitelist_status',
    description: 'IP 白名单状态：探测本机当前公网 IP，并列出所有白名单绑定（云厂商/地域/目标资源/最近一次同步结果）与自动同步调度配置。只读，不改动云端。',
    inputSchema: {
      type: 'object',
      properties: {
        detect: { type: 'boolean', description: '是否探测公网 IP，默认 true；离线环境可传 false 跳过' },
      },
    },
  },
  {
    name: 'whitelist_sync',
    description: '手动触发 IP 白名单同步：把本机当前公网 IP 推送到云厂商安全组前缀列表/地址模板。不传 bindingId 则同步全部启用中的绑定。结果与审计都会落盘。',
    inputSchema: {
      type: 'object',
      properties: {
        bindingId: { type: 'string', description: '要同步的绑定 id（whitelist_status 可查）；不传则同步全部启用中的绑定' },
      },
    },
  },
  {
    name: 'ai_usage_snapshot',
    description: '查询模型用量快照（余额/当月消费/免费额度/模型清单等）。读最近一次刷新的本地缓存，只读不调云 API。不传 accountId 则返回所有已监控的云账号。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '云账号资产 id；不传则返回全部' },
      },
    },
  },
  {
    name: 'list_collections',
    description: '列出保险库里所有加密集合的名字。集合与资产是两套数据：工作台业务数据（收支/成本/任务/灵感/聊天等）、助手会话与记忆都存在集合里，list_assets 看不到。拿到名字后用 get_collection 读内容。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_collection',
    description: '按名字读取一个加密集合的完整内容（只读）。常见集合：workbench（工作台：revenue 收支 / costs 成本 / tasks 任务 / docs 资料证书 / ideas 灵感 / chats 聊天 / settings 设置）、ai_sessions（助手会话）、ai_memory（助手记忆）、ai_conf（助手模型配置）。集合不存在返回 null。项目档案不在这里，用 list_assets 的 type=project 读。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '集合名，见 list_collections' } },
      required: ['name'],
    },
  },
  {
    name: 'project_upsert',
    description: '一次性登记/更新一个本地项目的启动配置。**只需写主项目**（id、名称、路径、启动命令、端口），程序会自动扫描项目目录，把数据库/缓存等依赖拆成挂在它下面的子节点（自动起 id、自动挂 parent、自动给停止命令），页面上折叠成一张卡。也可以**手工写任意多个依赖节点**：一个主项目下挂 3 个、5 个、8 个都行（每个节点单独调一次本工具，写 parent=主项目 id + kind/commands/stopCommand/probe），页面按 parent 折叠，启动按拓扑序、停止逆序。**重复依赖的处理规则（重要）**：写依赖节点前，先看已有档案里是否已经有同一个资源（同一个容器名 / 同一个 compose service / 同一个独占端口）。已经存在就**不要新建节点**：要么让本项目 dependsOn 指向那个已有 id，要么照实写 parent 和 probe.docker/ports —— 后端会按资源指纹（depFingerprint）识别出重复，把两边都自动标成 shared 并在 warnings 里说明，所以即使重复登记也不会出现「关 A 把 B 的库停了」。返回写后完整档案 + 本次自动派生了哪些子节点（derived）+ 哪些没自动收（skipped，需要人决定）+ sharedWith（本次自动标共享的节点）。刻意没拆时传 autoDiscover=false。这是静态档案，写入一次长期有效；之后反复启停都无需再调用。运行态（status/pid）由应用自己探测，禁止写入。按 id 幂等覆盖，可只传要改的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        autoDiscover: { type: 'boolean', description: '是否自动扫描并派生依赖子节点，默认 true；已手工写好节点时传 false' },
        project: {
          type: 'object',
          description: '项目档案。也可把字段直接平铺在本层。',
          properties: {
            id: { type: 'string', description: '标识，小写字母/数字/-/_，如 flintkeep；重复写即更新' },
            name: { type: 'string', description: '项目名称' },
            cwd: { type: 'string', description: '项目绝对路径' },
            pathMac: { type: 'string', description: 'Mac 上的路径（可选，优先于 cwd）' },
            notes: { type: 'string', description: '备注' },
            tags: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string', enum: ['process', 'compose', 'docker'], description: '默认 process；容器项目后两者需写 stopCommand' },
            commands: {
              type: 'array',
              description: '启动命令，按顺序执行；除最后一条外都是准备步骤（等退出码 0），最后一条常驻。也可直接传多行字符串。',
              items: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' },
                  kind: { type: 'string', enum: ['setup', 'service'] },
                  cwd: { type: 'string' },
                  timeoutMs: { type: 'number' },
                },
                required: ['cmd'],
              },
            },
            probe: {
              type: 'object',
              properties: {
                ports: { type: 'array', items: { type: 'number' }, description: '判活端口，可多个' },
                url: { type: 'string', description: '「打开」按钮的访问地址' },
                healthUrl: { type: 'string' },
                mode: { type: 'string', enum: ['any', 'all'], description: '多端口判活策略，默认 any' },
                readyTimeoutMs: { type: 'number' },
                docker: {
                  type: 'object',
                  properties: {
                    container: { type: 'string', description: '容器名' },
                    composeService: { type: 'string' },
                    projectName: { type: 'string' },
                  },
                },
              },
            },
            stopCommand: { type: 'string', description: '容器项目必填：怎么停容器，如 docker compose stop postgres / docker stop myapp' },
            parent: { type: 'string', description: '从属的主项目 id。手工加依赖节点时必须写；同一主项目下可挂任意多个子节点。传空字符串=解绑成独立卡片。改挂靠关系也用它。' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖项目 id，启动按拓扑序、停止逆序；写了它就不自动派生' },
            shared: { type: 'boolean', description: '共享依赖：被多个项目使用时不自动停。同一份资源（同容器/同 compose service/同端口）被两个项目各登记一次时，写入会自动把两边都标成 shared，并把原因写进返回的 warnings' },
            stopPolicy: { type: 'string', enum: ['self', 'cascade', 'keep'] },
            registeredBy: { type: 'string', description: 'Agent 名称，仅审计用' },
          },
          required: ['id', 'name', 'cwd', 'commands'],
        },
      },
    },
  },
  {
    name: 'projects_status',
    description: '只读：列出已登记的本地项目及其当前运行状态（端口 TCP 探测 + 容器状态实时计算）。状态含 stopped/starting/running/unhealthy/failed/unknown，running 会标出是应用启动(managed)还是别的 Agent 在终端启动(external)。也返回残留信息（关闭后仍有端口/容器存活）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project_start',
    description: '启动一个已登记的项目：依赖先起并等就绪，再起主项目；进程独立常驻，与 MCP 会话断开无关。失败会返回具体是哪一步、哪个节点。默认等到就绪或超时才返回（可能几十秒到几分钟），传 wait=false 则只发出指令立即返回。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '已登记的项目 id' },
        wait: { type: 'boolean', description: '是否等到就绪，默认 true' },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_stop',
    description: '关闭一个已登记的项目。默认按档案的 stopPolicy 执行（cascade 连带停独占依赖、shared/keep 保留、仍被其他运行中项目引用的不停）；cascade=false 只停本项目；only="deps" 只关依赖、主程序保留（例如只把数据库停掉）。关闭后会复检端口与容器，残留会一并返回。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '已登记的项目 id' },
        cascade: { type: 'boolean', description: '是否连带停独占依赖；不传则按档案 stopPolicy' },
        only: { type: 'string', enum: ['all', 'deps'], description: 'all=自己+依赖（默认）；deps=只关依赖，主程序保留' },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_discover',
    description: '体检：扫描项目目录（docker-compose 的 services、.env 端口、package.json 脚本、ecosystem.config），列出「跟这个项目有关但还没登记」的节点（数据库/Redis/容器等），以及已登记项的差异。只读不写。登记前先用它扫一遍，可避免漏节点导致关闭关不干净。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '要扫描的项目绝对路径' },
        id: { type: 'string', description: '可选：已登记的项目 id，用于对比是否漏登记' },
      },
      required: ['cwd'],
    },
  },
];

/**
 * MCP v2 工具面（默认只暴露这 9 个）。
 *
 * 为什么收敛：27 个细粒度工具会让 Agent 在近义工具间反复试探，实测 tools/list 就有
 * 19.3KB（约 6k tokens），列表类返回再吃 4k，模型只能多轮枚举。v2 以「任务」而不是
 * 「表操作」组织入口：找（find）→ 看（show）→ 用（connect）→ 改（manage）……
 * 老工具仍保留在 TOOL_SPECS 里做兼容，FLINTKEEP_MCP_PROFILE=full 时一并下发。
 */
export const TOOL_SPECS_V2: ToolSpec[] = [
  {
    name: 'find',
    description: '找资产/项目：按关键词或类型查询，返回紧凑卡片（id/名称/类型/序号/一行摘要），默认 20 条分页。取代 list_assets 与 search_assets。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（名称/IP/备注/正文）；不传则按类型列出' },
        kind: { type: 'string', description: '类型 key 或中文名（server/ssh_key/cloud_account/oss/baota/mcp/api_key/login_account/email_account/note/project）' },
        tag: { type: 'string', description: '按标签过滤' },
        limit: { type: 'number', description: '每页条数，默认 20，上限 50' },
        offset: { type: 'number', description: '偏移量，翻页用 nextOffset' },
        fields: { type: 'array', items: { type: 'string' }, description: '只返回这些字段（id/type/name/no/tags/hint）' },
      },
    },
  },
  {
    name: 'show',
    description: '看明细：target 传 id、名称或「类型:序号」（如 server:3）。默认脱敏；用户明确要看密码/私钥原文时才传 reveal=true（写审计）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'id / 名称 / 类型:序号 / 纯序号（唯一时）；也可用 id 传同值' },
        reveal: { type: 'boolean', description: 'true=返回含敏感字段的完整内容，会写审计；默认 false' },
        fields: { type: 'array', items: { type: 'string' }, description: '只返回这些字段（id/type/name 始终返回）' },
      },
      required: ['target'],
    },
  },
  {
    name: 'connect',
    description: '用资产（一次调用）：服务器/SSH 返回可直接执行的 ssh 命令（密钥由燧垒注入）；云账号/OSS/宝塔/API Key 返回代理基址+令牌+示例；真密钥不进上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'id / 名称 / 类型:序号 / 纯序号（唯一时）；也可用 id 传同值' },
        ttl: { type: 'number', description: '令牌有效期（秒），默认 900，上限 14400' },
      },
      required: ['target'],
    },
  },
  {
    name: 'manage',
    description: '改资产：action=add|update|delete|history|restore。delete/restore 必须带 confirm=true；history 看历史版本，restore 回滚到某一版。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add / update / delete / history / restore' },
        asset: { type: 'object', description: 'add 时的资产对象（同界面表单字段）' },
        id: { type: 'string', description: 'update / delete / history / restore 的目标 id（也可用 target 传同值）' },
        target: { type: 'string', description: 'id 的别名：与 show/connect 的 target 一致，传哪个都行' },
        patch: { type: 'object', description: 'update 时要改的字段' },
        vid: { type: 'string', description: 'history 返回的版本 id（restore 用）' },
        confirm: { type: 'boolean', description: 'delete / restore 必须为 true' },
      },
      required: ['action'],
    },
  },
  {
    name: 'run_project',
    description: '项目：action=status|list|start|stop|discover。start/stop/discover 需用户在设置里打开「允许 Agent 执行本机命令」。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status / list / start / stop / discover' },
        id: { type: 'string', description: '项目 id（start/stop/discover 用，也可用 target 传同值）' },
        target: { type: 'string', description: 'id 的别名：与 show/connect 的 target 一致' },
        cwd: { type: 'string', description: 'discover 时扫描的绝对路径' },
      },
      required: ['action'],
    },
  },
  {
    name: 'sync_whitelist',
    description: 'IP 白名单：action=status 查本机公网 IP 与绑定状态；action=sync 推送本机 IP（需执行权限）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status / sync' },
        bindingId: { type: 'string', description: 'sync 指定绑定；不传同步所有启用的绑定' },
      },
      required: ['action'],
    },
  },
  {
    name: 'usage',
    description: '模型用量快照（余额/消费/免费额度/模型清单），只读本地缓存不调云 API。不传 accountId 返回全部。',
    inputSchema: {
      type: 'object',
      properties: { accountId: { type: 'string', description: '云账号资产 id；不传返回全部' } },
    },
  },
  {
    name: 'note',
    description: '写一条审计备注，记录 Agent 做了什么（例如「已连上 web-01 查看 nginx 日志」）。',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '一句话说明' },
        meta: { type: 'object', description: '可选结构化字段（白名单外的键会被丢弃）' },
      },
      required: ['description'],
    },
  },
  {
    name: 'backup',
    description: '备份：action=export 导出加密备份串；action=import 导入（需执行权限，先校验后落盘）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'export / import' },
        backup: { type: 'string', description: 'import 时的备份串' },
        passphrase: { type: 'string', description: 'import 时备份所用的主口令' },
      },
      required: ['action'],
    },
  },
];

/** v2 工具名集合：handleCall 用它决定走新入口还是老实现 */
export const V2_TOOL_NAMES: string[] = TOOL_SPECS_V2.map((t) => t.name);

/**
 * initialize 时下发给 Agent 的使用说明。
 * 这是"少走弯路"的最低成本手段：把标准路径直接写进协议层，模型不用靠试探去猜。
 */
export const MCP_INSTRUCTIONS = [
  '燧垒是本地加密凭证库。多数任务 1-2 次调用即可完成，不要枚举全部资产，也不要用多次 find 试探。',
  '- 连服务器/SSH：connect("web-01") → 直接执行返回的 command；不要先 find 再 connect，也不要索取密码。',
  '- 调云 API / OSS / 宝塔 / API Key：connect("阿里云-主账号") → 用返回的 baseUrl + token + example 发请求。',
  '- 找东西：find("nginx")；需要细节再 show(id)。只有用户明确要求看密码/私钥原文时才 show(target, reveal=true)，该操作写审计。',
  '- 改资产用 manage（删除必须 confirm=true）；项目启停用 run_project，需用户先开启执行权限。',
  '- 工具报错时读 next 字段按提示重试一次，不要换工具穷举。',
  '- 字段/类型/集合等配置类工具默认不暴露；确需使用时请用户在设置里开启「完整工具集」。',
].join('\n');

/** 界面教程用清单：从 v2 定义派生（单一定义来源） */
export const MCP_TOOL_GUIDE: { name: string; desc: string }[] = TOOL_SPECS_V2.map((t) => ({
  name: t.name,
  desc: t.description,
}));

/**
 * 资产类型的宽容解析：Agent 常传中文标签（"服务器"/"SSH 登录"）或别名（"ssh"/"密钥"），
 * 而存储键是英文（server/ssh_key）。这里统一归一化，避免"精确匹配不上 → 空列表 → Agent 说找不到"。
 */
const TYPE_ALIASES: Record<string, string> = {};
(function buildAliases() {
  for (const [key, label] of Object.entries(TYPE_LABELS)) {
    TYPE_ALIASES[key.toLowerCase()] = key;
    TYPE_ALIASES[String(label).toLowerCase()] = key;
  }
  const extras: Record<string, string> = {
    服务器: 'server', 机器: 'server',
    ssh: 'ssh_key', 'ssh登录': 'ssh_key', 密钥: 'ssh_key', 'sshkey': 'ssh_key', 'ssh key': 'ssh_key',
    云: 'cloud_account', 云api: 'cloud_account', '云账号(api)': 'cloud_account',
    对象存储: 'oss',
    宝塔: 'baota', 宝塔面板: 'baota',
    'mcp服务': 'mcp',
    api: 'api_key', apikey: 'api_key', 'api密钥': 'api_key', 'api/模型密钥': 'api_key',
    平台账号: 'login_account', 登录账号: 'login_account',
    邮箱: 'email_account', 邮箱账号: 'email_account', 邮箱登录: 'email_account',
    备忘: 'note',
  };
  for (const [alias, key] of Object.entries(extras)) TYPE_ALIASES[alias.toLowerCase()] = key;
})();

/**
 * 归一化资产类型；识别不了返回 null（调用方应回明确错误而不是空列表）。
 * extras 是用户自定义类型的「中文名 → key」映射，由调用方从 asset_types.json 读取。
 */
export function normalizeAssetType(raw: unknown, extras: Record<string, string> = {}): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const k = raw.trim().toLowerCase();
  return TYPE_ALIASES[k] || extras[k] || null;
}

export function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
