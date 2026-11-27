<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { lang, useT } from './ui/i18n';
import { zh } from '../shared/i18n/zh';

const zhDict: Record<string, string> = zh as any;

const tr = useT();

const setup = ref<any>(null);
const localPass = ref('');
const copied = ref('');
const loadErr = ref('');
const showPromptPreview = ref(false);
const showJsonPreview = ref(false);

async function load() {
  loadErr.value = '';
  try {
    const r = await fetch('/api/mcp-setup');
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || !j.mcpScript) {
      const tip =
        r.status === 404 || j.error === 'not found'
          ? tr('mcp.err.missing')
          : j.error || tr('mcp.err.http', { n: r.status });
      loadErr.value = tip;
      setup.value = null;
      return;
    }
    setup.value = j;
  } catch (e: any) {
    loadErr.value = tr('mcp.err.network', { msg: e.message || tr('mcp.err.load') });
  }
}

/** 口令：填了就用真实值，没填留占位符，由 Agent 向用户询问后再替换 */
const passValue = computed(() => localPass.value.trim() || tr('mcp.passPlaceholder'));

/** 工具说明：英文界面用字典里的精简英文，中文用后端原文（更详细） */
function toolDesc(t: any): string {
  if (lang.value !== 'en-US') return t.desc;
  const key = 'mcp.tool.' + t.name;
  return key in zhDict ? tr(key as any) : t.desc;
}

/**
 * stdio 服务的三要素。客户端不管用 JSON 配置、CLI 还是设置面板，登记的都是同一组
 * command / args / env；GUI 启动的宿主常没有 npx，所以优先用后端给的绝对路径。
 */
const stdioSpec = computed(() => {
  if (!setup.value?.mcpScript) return null;
  const guiSafe = setup.value.nodeBin && setup.value.tsxCli;
  return {
    command: guiSafe ? setup.value.nodeBin : 'npx',
    args: guiSafe ? [setup.value.tsxCli, setup.value.mcpScript] : ['tsx', setup.value.mcpScript],
    env: {
      VAULT_DATA_DIR: setup.value.dataDir,
      VAULT_PASSPHRASE: passValue.value,
    },
  };
});

const mcpJson = computed(() => {
  const spec = stdioSpec.value;
  if (!spec) return '';
  return JSON.stringify({ mcpServers: { flintkeep: spec } }, null, 2);
});

const agentPrompt = computed(() => {
  const spec = stdioSpec.value;
  if (!spec || !setup.value?.mcpScript) return '';
  if (lang.value === 'en-US') return agentPromptEn(spec);
  const passHint = localPass.value.trim()
    ? 'VAULT_PASSPHRASE 已按我在应用里解锁燧垒的主口令填好，请原样保留。'
    : 'VAULT_PASSPHRASE 现在是占位符「你的主口令」：请先向我询问解锁燧垒用的主口令再替换它，不要猜测，也不要把占位符写进配置。';
  return `请把下面这个本机 MCP 服务登记到你（当前 Agent）自己的 MCP 配置里，让我以后能直接通过你查用本机「密钥管理 / 燧垒」。

服务名：flintkeep
传输方式：stdio（由客户端拉起子进程，走标准输入输出通信，不监听端口）
项目目录：${setup.value.projectRoot}
MCP 入口：${setup.value.mcpScript}
数据目录：${setup.value.dataDir}
连上后通过 tools/list 可看到全部工具（资产查询与取凭证、代理令牌、白名单同步、模型用量、项目启停等）。

启动参数（均为本机绝对路径，请勿改写或换成相对路径）：
  command: ${spec.command}
  args: ${JSON.stringify(spec.args)}
  env: VAULT_DATA_DIR=${spec.env.VAULT_DATA_DIR}、VAULT_PASSPHRASE=${spec.env.VAULT_PASSPHRASE}

通用 JSON 片段（多数客户端使用 mcpServers 字段）：

${mcpJson.value}

请按你所用客户端的规则完成登记：
1. 找到你自己用户级或项目级的 MCP 配置；若已有其它服务，只合并 flintkeep 这一项，不要整文件覆盖。
2. 若你的客户端不用这种 JSON（用命令行添加或设置面板填写），按它的格式登记同一个 stdio 服务，command / args / env 三项保持上面的值不变。
3. ${passHint}
4. MCP 是 stdio 服务，不能弹窗输口令，口令只能通过 VAULT_PASSPHRASE 传入，且必须与我在应用里解锁燧垒的口令一致。配置只留在本机，不要提交到公开仓库，也不要在回复里复述口令。

完成后告诉我：配置写到了哪里（或用了哪条命令）、要怎样重新加载（多数客户端需完全退出后重开才会加载新的 MCP 服务）；重新加载后请调用 list_assets 验证连接，并简述返回了哪几类资产。`;
});

/** 英文界面下给 Agent 的说明（同一份内容，英文表述） */
function agentPromptEn(spec: any): string {
  const passHint = localPass.value.trim()
    ? 'VAULT_PASSPHRASE is already set to the passphrase I use to unlock the vault in the app — keep it as is.'
    : 'VAULT_PASSPHRASE is currently the placeholder "your-passphrase": ask me for the passphrase I use to unlock the vault, then replace it. Do not guess, and never leave the placeholder in the config.';
  return `Register the local MCP server below in your own (the current agent's) MCP config so I can query the local password vault through you.

Service name: flintkeep
Transport: stdio (the client spawns a child process and talks over stdin/stdout; no port is opened)
Project directory: ${setup.value.projectRoot}
MCP entry: ${setup.value.mcpScript}
Data directory: ${setup.value.dataDir}
Once connected, tools/list shows every tool (asset lookup and credential retrieval, proxy tokens, whitelist sync, model usage, project start/stop, ...).

Launch settings (absolute paths on this machine — do not rewrite them or use relative paths):
  command: ${spec.command}
  args: ${JSON.stringify(spec.args)}
  env: VAULT_DATA_DIR=${spec.env.VAULT_DATA_DIR}, VAULT_PASSPHRASE=${spec.env.VAULT_PASSPHRASE}

Generic JSON snippet (most clients use the mcpServers field):

${mcpJson.value}

Register it following your client's rules:
1. Find your user-level or project-level MCP config; if other servers are listed, merge only the flintkeep entry — do not overwrite the whole file.
2. If your client does not use this JSON (CLI or settings UI instead), register the same stdio service in its format, keeping command / args / env exactly as above.
3. ${passHint}
4. MCP is a stdio service and cannot prompt for a passphrase; it can only arrive via VAULT_PASSPHRASE, and it must match the passphrase I use to unlock the vault in the app. Keep the config on this machine only, never commit it to a public repo, and never repeat the passphrase back to me.

When done, tell me where the config was written (or which command you used), how to reload (most clients need a full quit and restart to pick up a new MCP server), and after reloading call list_assets to verify the connection and briefly list which asset types came back.`;
}

async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    setTimeout(() => {
      if (copied.value === key) copied.value = '';
    }, 1600);
  } catch {
    copied.value = 'fail';
  }
}

onMounted(load);
</script>

<template>
  <div class="mg-view">
    <div class="statusbar">
      <span class="st-live"><i></i>{{ tr('shell.status.unlocked') }}</span>
      <span>{{ tr('assets.crypto') }}</span>
      <span class="sp"></span>
      <span>{{ tr('mcp.summary', { n: setup?.tools?.length || 0 }) }}</span>
    </div>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="kicker">{{ tr('mcp.kicker') }}</div>
          <div class="page-title">{{ tr('mcp.title') }}</div>
        </div>
      </div>
      <p class="lead">{{ tr('mcp.lead') }}</p>

      <p v-if="loadErr" class="msg err">{{ tr('mcp.loadFail', { msg: loadErr }) }}</p>

      <div v-if="setup" class="paths">
        <div class="path-row">
          <span>{{ tr('mcp.path.project') }}</span>
          <code>{{ setup.projectRoot }}</code>
        </div>
        <div class="path-row">
          <span>{{ tr('mcp.path.script') }}</span>
          <code>{{ setup.mcpScript }}</code>
        </div>
        <div class="path-row">
          <span>{{ tr('mcp.path.data') }}</span>
          <code>{{ setup.dataDir }}</code>
        </div>
      </div>

      <label class="pass">
        <span>{{ tr('mcp.passLabel') }}</span>
        <input
          v-model="localPass"
          type="password"
          :placeholder="tr('mcp.passPlaceholderHint')"
        />
      </label>

      <section class="mcp-card rec">
        <header>
          <h3>{{ tr('mcp.way1') }}</h3>
          <span class="badge">{{ tr('mcp.recommended') }}</span>
        </header>
        <ol>
          <li>{{ tr('mcp.way1.step1') }}</li>
          <li>{{ tr('mcp.way1.step2') }}</li>
          <li>{{ tr('mcp.way1.step3a') }}<code>list_assets</code>{{ tr('mcp.way1.step3b') }}<code>flintkeep</code>{{ tr('mcp.way1.step3c') }}</li>
        </ol>
        <div class="acts">
          <button class="btn primary" @click="copy(agentPrompt, 'prompt')">
            {{ copied === 'prompt' ? tr('mcp.copied') : tr('mcp.copyPrompt') }}
          </button>
          <button class="btn" type="button" @click="showPromptPreview = !showPromptPreview">
            {{ showPromptPreview ? tr('mcp.collapse') : tr('mcp.preview') }}
          </button>
        </div>
        <p class="caption">{{ tr('mcp.previewNote') }}</p>
        <div v-if="showPromptPreview" class="code-wrap">
          <div class="code-h">{{ tr('mcp.preview.prompt') }}</div>
          <pre>{{ agentPrompt }}</pre>
        </div>
      </section>

      <section class="mcp-card">
        <header><h3>{{ tr('mcp.way2') }}</h3></header>
        <p class="sub">
          {{ tr('mcp.way2.a') }}<code>mcpServers</code>{{ tr('mcp.way2.b') }}
          {{ tr('mcp.way2.c') }}<code>command</code> / <code>args</code> /
          <code>env</code> {{ tr('mcp.way2.rest') }}
        </p>
        <div class="acts">
          <button class="btn" @click="copy(mcpJson, 'json')">
            {{ copied === 'json' ? tr('mcp.copiedJson') : tr('mcp.copyJson') }}
          </button>
          <button class="btn" type="button" @click="showJsonPreview = !showJsonPreview">
            {{ showJsonPreview ? tr('mcp.collapse') : tr('mcp.previewJson') }}
          </button>
        </div>
        <div v-if="showJsonPreview" class="code-wrap">
          <div class="code-h">{{ tr('mcp.preview.json') }}</div>
          <pre>{{ mcpJson }}</pre>
        </div>
      </section>

      <section class="mcp-card">
        <header>
          <h3>{{ tr('mcp.tools') }}</h3>
          <span class="badge soft">{{ setup?.tools?.length || 0 }}</span>
        </header>
        <p class="sub">
          {{ tr('mcp.toolsHint1') }}
          <code>VAULT_PASSPHRASE</code>{{ tr('mcp.toolsHint2') }}
        </p>

        <div v-if="setup?.tools?.length" class="tbl tool-tbl">
          <div class="t-head"><span>{{ tr('mcp.th.tool') }}</span><span>{{ tr('mcp.th.desc') }}</span></div>
          <div v-for="t in setup.tools" :key="t.name" class="t-row">
            <span class="mono">{{ t.name }}</span>
            <span class="meta">{{ toolDesc(t) }}</span>
          </div>
        </div>

        <p class="warn">{{ tr('mcp.warnRepo') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
[data-mgui] .mg-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}

.lead {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-3);
  max-width: 760px;
}

.msg {
  margin: 0 0 14px;
  font-size: 12.5px;
}
.msg.err {
  color: var(--danger);
}

/* 三行路径：等宽、可断行 */
.paths {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 12px 14px;
  margin-bottom: 14px;
}
.path-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  padding: 3px 0;
}
.path-row > span {
  font-size: 11.5px;
  color: var(--text-3);
}
.path-row code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-2);
  word-break: break-all;
}

.pass {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 460px;
  margin-bottom: 18px;
  font-size: 11.5px;
  color: var(--text-3);
}
.pass input {
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--panel);
  color: var(--text);
  font-size: 12.5px;
}

.mcp-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 16px 18px;
  margin-bottom: 12px;
  max-width: 860px;
}
.mcp-card.rec {
  border-color: var(--accent);
}
.mcp-card > header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.mcp-card h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.badge {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.badge.soft {
  background: var(--hover);
  color: var(--text-3);
}

.mcp-card ol {
  margin: 0 0 12px;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--text-2);
}
.sub {
  margin: 0 0 12px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-2);
}
.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.caption {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}

/* 代码块 */
.code-wrap {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg);
}
.code-h {
  padding: 6px 10px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--hover);
  border-bottom: 1px solid var(--line);
}
.code-wrap pre {
  margin: 0;
  padding: 12px 14px;
  max-height: 240px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 工具表 */
.tool-tbl {
  --cols: 220px minmax(0, 1fr);
  margin-bottom: 12px;
}
.tool-tbl .t-head,
.tool-tbl .t-row {
  grid-template-columns: var(--cols);
}
/* 模板的行默认固定 46px，工具说明是多行文字，必须放开高度否则会叠在一起 */
.tool-tbl .t-row {
  height: auto;
  min-height: 34px;
  padding-top: 8px;
  padding-bottom: 8px;
  align-items: start;
}
.tool-tbl .t-row .mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--accent);
  word-break: break-all;
}
.tool-tbl .t-row .meta {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: normal;
  word-break: break-word;
}

.warn {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  color: var(--warn);
  font-size: 11.5px;
  line-height: 1.6;
}

code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--hover);
  color: var(--text-2);
}
</style>
