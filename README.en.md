# FlintKeep (燧垒)

[简体中文](README.md) · [English](README.en.md)

FlintKeep is a local, encrypted vault for infrastructure credentials and assets: agents use secrets through MCP but never see them.

## Features

- Multiple asset types: servers (with open ports), SSH keys, cloud accounts, OSS, BT panel, MCP configs, generic secrets
- AES-256-GCM encrypted local storage; list/search results are redacted by default, sensitive fields are never rendered
- **Rotation reminders**: each asset can define "remind me every N days + last rotated date"; due items get a "⚠ rotate" badge and a dedicated filter
- Agent access: built-in MCP stdio server; the audit log records caller / action / time / asset
- **Agent-reported actions**: after using a credential, an agent reports what it did via `log_agent_action` (e.g. "SSH'd into web-01 and tailed nginx logs"), completing the audit chain — so you can answer "what happened after the secret was handed over"
- **Encrypted backup / restore** (Settings): export a self-contained encrypted backup (vault + keystore + whitelist bindings/schedule) that can be moved to another machine; import requires the same master passphrase — **a wrong passphrase is rejected and local data is left untouched**. Model usage and Bailian CLI logins are not included
- **Model B proxy injection (real keys never enter the agent context)**: issue a short-lived token plus a local proxy base URL; the agent calls the real API through the proxy and the **proxy injects the real secret server-side**. Injection modes cover header / Basic / BT panel signing, **and cloud request signing (AWS SigV4 / Alibaba Cloud & Tencent Cloud HMAC-SHA1)** — so cloud accounts and OSS also work under Model B
- **Model B SSH session proxy (local bastion)**: `request_ssh_access` issues a short-lived token; the agent runs `ssh -p 8789 <token>@127.0.0.1` and the local `ssh2` proxy injects the real password or private key toward the target host — never into the agent context
- Audit log: every credential retrieval, create, update, agent-reported action and proxy access is recorded (agent actions are highlighted in the audit page)
- UI: asset CRUD, unlock overlay, rotation filter, encrypted backup import/export in Settings, per-asset HTTP/SSH proxy issuance in the detail panel
- **IP allowlist auto-update**: when your home broadband public IP changes, cloud allow rules follow — Alibaba Cloud **prefix lists**, Tencent Cloud **IP address templates**; no cloud API call is made when the IP is unchanged (avoids rate limits); supports in-app scheduling and system-level scheduling (`npm run whitelist:run`)
- **Model usage monitoring**: balance / spend / resource packs / model list for cloud accounts, plus **free-tier quotas** (amount, expiry, reset, stop-at-zero). Free quotas come from the official Bailian CLI, bound per account with **strict attribution** (an unbound account shows nothing; account A's quota is never shown under account B)
- **Notes + field management**: `note` assets for quick notes; columns and create/edit forms are driven by field definitions — rename built-in fields in Settings, toggle whether they appear as a column or in the form, and add custom fields (text / number / select / date / secret; values live in `asset.extra` and participate in display and search). Each asset tab still configures its own columns (max 20, horizontal scroll when exceeded)
- **Desktop client**: `npm run desktop` starts everything in one command; quitting and reopening picks up new code (stale backend processes are cleaned up first)
- **Tray residency + auto-lock**: closing the window minimizes to the menu-bar tray by default and keeps running (whitelist scheduled sync, automatic usage refresh, agent MCP and proxy tokens stay alive); Settings can switch it to "quit". Idle auto-lock (15 minutes by default, adjustable or off) or one-click lock from the tray — once locked, credential retrieval, proxies, the SSH bastion and MCP tool calls are all refused until the passphrase is entered again
- **Daily automatic backup**: `data/backups/daily-YYYY-MM-DD/` keeps the last 7 days of the encrypted vault and whitelist config (a plain ciphertext file copy — no unlock needed, no plaintext produced), a second line of defense alongside manual export
- **Brute-force protection & origin isolation**: consecutive failed unlocks trigger exponential backoff (1s→2s→4s… capped at 60s); REST accepts loopback Host headers only (defeats DNS rebinding that tries to read the backup); copied secrets are cleared from the clipboard after 30 seconds

## Design stance (important)

- **Written from scratch, no forking** of GitHub projects; the architecture borrows design ideas from mature open-source projects: Keygate (alias + proxy + audit + MCP), Teleport (audit / session recording), ClawVault (dashboard / audit), Infisical (agent proxy), gopass (encrypted storage). For projects whose license is not open, only the ideas are studied — no code is copied.
- **License**: this project is **AGPL-3.0-only** — closed-source distribution or closed-source service deployment requires a separate commercial license; the "燧垒 / FlintKeep" name and logo are not covered by the license, and derivative projects must be published under a different name.

## Comparison with similar products

FlintKeep is not positioned as "yet another password manager" but as a **credential pipeline for AI agents**: local encrypted vault + agents fetch credentials themselves + real keys never enter the context + a closed audit loop.

| Capability                                                                    | FlintKeep             | 1Password / Bitwarden                                                               | Infisical / HashiCorp Vault | psst / sallyport and similar         |
| ----------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------ |
| Local encrypted storage (data never leaves the device)                        | ✅                    | ❌ (cloud-synced)                                                                   | ❌ (server-hosted)          | Partial                              |
| Agents fetch credentials via MCP                                              | ✅                    | ❌ (1Password explicitly does not ship an MCP server; CLI resolves at runtime only) | Mostly CLI/SDK              | ✅                                   |
| Real keys never enter the agent context (proxy injection)                     | ✅ HTTP + SSH covered | ❌                                                                                  | Partial                     | Same idea, incomplete implementation |
| Cloud request-signature injection (AWS SigV4 / Alibaba Cloud / Tencent Cloud) | ✅                    | ❌                                                                                  | ❌                          | ❌                                   |
| Local SSH bastion (token connect, real credential injected at the target)     | ✅                    | ❌ (SSH agent signs locally only)                                                   | ❌                          | ❌                                   |
| Closed audit loop (retrieval log + agent-reported actions)                    | ✅                    | Activity log                                                                        | ✅                          | Partial                              |
| Rotation reminders                                                            | ✅                    | Watchtower weak-password check                                                      | Partial                     | ❌                                   |
| Automatic allowlist updates for Chinese clouds (Alibaba / Tencent)            | ✅                    | ❌                                                                                  | ❌                          | ❌                                   |
| Model usage / free-quota monitoring                                           | ✅                    | ❌                                                                                  | ❌                          | ❌                                   |

> 1Password™ is a trademark of AgileBits Inc.; Bitwarden, Infisical, HashiCorp Vault and others are trademarks of their respective owners. FlintKeep is not affiliated with, or endorsed by, any of these products; this table is a descriptive comparison of functional facts only.

## Tech stack

- Frontend: Vue 3 + Vite (the visual UI)
- Local service: Node http (REST API, for the UI and for tools other than the agent)
- Encrypted storage: AES-256-GCM local files; the master key is derived from the user passphrase + a random salt via PBKDF2 (210,000 iterations); only salt + verifier are persisted (`keystore.json`); the key exists in memory only, so a restart requires re-entering the passphrase
- Agent integration: built-in MCP stdio server (hand-written JSON-RPC, no third-party SDK)
- Desktop shell: Electron (the packaging step is described below)

## Layout

```
flintkeep/
  src/core/        pure logic (runnable directly under Node)
    schema.ts      data model + sensitive fields
    vault.ts       encrypted vault + redacted listing + audit (with caller)
    proxy.ts       HTTP Model B proxy injection
    sshproxy.ts    SSH Model B local bastion
    mcp.ts         MCP stdio server (the agent entry point)
    mcp-meta.ts    MCP tool definitions (single source: stdio server and in-app docs)
    ipdetect.ts    public IP detection
    whitelist.ts   IP allowlist (Alibaba prefix lists / Tencent address templates)
    ai-usage.ts    model usage (cloud billing + model list + Bailian CLI free quota)
    settings.ts    app settings (close behavior / auto-lock duration)
    backup.ts      daily automatic backup (rolling 7 days)
    tcloud.ts      Tencent Cloud TC3-HMAC-SHA256 signing
    test.ts        core self-test (149 assertions)
  src/renderer/    Vue UI (asset list / CRUD / audit / whitelist / usage / notes)
  server.ts        REST API + production static serving
  electron/        Electron shell (main.mjs + pre-start port cleanup)
  data/            encrypted vault + audit log generated at runtime (do not commit)
```

## Quick start

```bash
npm install

# 1) core self-test (PBKDF2 / verifier / HTTP proxy / SSH bastion / whitelist / usage assertions)
npm run core:test

# 2) desktop client (recommended)
npm run desktop

#    or the browser build (dev mode: UI 8790 + local service 8787)
npm run dev
#   open http://localhost:8790 → enter the passphrase on first run (this initializes the keystore)

# 3) let an agent in: unlock, then open "MCP access" in the top bar
#    option 1: copy the generic instructions into any MCP-capable agent and let it register this stdio server
#    option 2: merge the JSON snippet into your own client's MCP config (command/args/env are generic)
#    MCP reads the passphrase from VAULT_PASSPHRASE (it cannot prompt); it must match the unlock passphrase.
```

> Legacy: if the data directory still contains an old `vault.enc.json` (key derived as `sha256(VAULT_MASTER_KEY)`) and no keystore, setting `VAULT_MASTER_KEY` migrates it to the PBKDF2 scheme on startup.

## MCP tools (callable by agents)

- `list_assets` / `search_assets`: list / search assets (redacted metadata)
- `get_asset` / `get_server_connection`: fetch a single plaintext credential / server connection info by name or IP (both audited)
- `add_asset` / `update_asset` / `delete_asset`: create, update, delete assets
- `log_agent_action`: after using a credential, the agent reports what it did (audited, completing the "what happened after" half of the chain)
- `export_backup` / `import_backup`: export / import a self-contained encrypted backup (migration or cold storage)
- `request_proxy_access`: Model B HTTP — issues a short-lived proxy token and base URL for an asset (the real secret is injected by the proxy and never enters the agent context)
- `request_ssh_access`: Model B SSH — issues a local bastion token for a server asset (`ssh -p <proxyPort> <token>@127.0.0.1`)
- `whitelist_status` / `whitelist_sync`: current allowlist state (public IP, bindings, schedule) / trigger one sync manually (audited)
- `ai_usage_snapshot`: model usage snapshot (balance / spend / free quota, read from local cache — no cloud API call)

Notes are `note` assets and can be maintained directly with `add_asset` / `update_asset` / `search_assets` (the body is searchable).

Other REST endpoints: `GET /api/backup/export`, `POST /api/backup/import {backup, passphrase}`, `POST /api/agent-action {description, meta}`, `POST /api/proxy/issue {assetId, ttl}`, `POST /api/ssh/issue {assetId, ttl}`, `GET /api/rotation`, `GET /api/audit`, `POST /api/unlock {passphrase}`, `POST /api/lock`, `GET|PUT /api/settings`, `POST /api/activity` (heartbeat). Separate ports: the HTTP proxy defaults to `PORT+1` = 8788; the SSH bastion defaults to `SSH_PROXY_PORT` = 8789.

## Security model

- **Data never leaves the device**: the vault lives on the local machine only (AES-256-GCM encrypted) and is never uploaded to any third party; cloud automations (allowlist sync, usage queries) only use the API keys you configured yourself and operate on your own cloud accounts.
- The whole vault file is encrypted with AES-256-GCM; plaintext is decrypted in memory only.
- **Master key derivation**: passphrase + a random 16-byte salt, PBKDF2-HMAC-SHA256 (210,000 iterations) → a 32-byte AES-256 key. The persisted `keystore.json` stores only `salt` + `verifier` (a known plaintext encrypted with the derived key).
- **Unlock check**: after deriving the key, the verifier is decrypted and compared; a wrong passphrase fails the GCM check / mismatches the plaintext and raises `WrongPassphraseError` — the wrong key is never used to decrypt the vault, so silent corruption is impossible.
- **In-memory key**: the derived key exists only in process memory; after a restart it must be re-derived from the keystore with the passphrase. The desktop app posts the passphrase to `POST /api/unlock`; the server is locked by default (423) and only opens data endpoints after unlocking.
- **Auto-lock**: after the configured idle period (15 minutes by default) the vault locks — the in-memory key is cleared and the proxy and SSH bastion stop. **This affects the desktop app / REST only, not the agent's MCP**: MCP holding the passphrase is by design, and a lock flag cannot stop a new process — it would only break sessions already working. To cut an agent off, remove its MCP config. UI clicks and keystrokes reset the timer, so pure reading never triggers a lock.
- **Unlock brute-force protection**: consecutive failures force an exponential wait (capped at 60 seconds); even a correct passphrase is rejected inside the window.
- **DNS rebinding protection**: REST accepts only `127.0.0.1` / `localhost` / `[::1]` Host headers, so a malicious page rebinding a domain to localhost still cannot read responses as same-origin.
- **Audit rotation**: `audit.log.jsonl` rolls over above 5 MB and keeps the last 3 generations, so long-term use never grows without bound.
- Listing and search strip sensitive fields by default; only an explicit `get` / `get_server_connection` returns plaintext and writes an audit record.
- Audit records the caller (agent identity), action, time and asset — answering "which agent took what, and when"; agents can additionally report "what I did afterwards" via `log_agent_action` (MCP tool / `POST /api/agent-action`), closing the loop.
- **Two retrieval modes**: v1 = plaintext handed over + audited (Model A); v2 = proxy injection (Model B, real keys never enter the agent context).
  - **HTTP Model B**: `request_proxy_access` / `POST /api/proxy/issue` → port 8788; `proxyInject.mode`: `header` / `basic` / `baota` / `aws` (SigV4) / `aliyun` (HMAC-SHA1).
  - **SSH Model B**: `request_ssh_access` / `POST /api/ssh/issue` → port 8789; the agent uses the token as the username to connect to the local bastion, and `ssh2` injects either the real password or the linked `ssh_key` private key toward the target host; writes a `proxy_access` audit record.
  - **Verified in `core:test`**: HTTP injection and cloud signing; SSH issuance / refusal / invalid-token rejection / passthrough exec against a mock target.

## Desktop (Electron)

```bash
# Recommended: one command (Vite HMR + Electron starting REST/proxy in the same process)
npm run desktop
#   Quit and relaunch to load new code — stale backend processes are cleaned up before start

# Development: Electron dev window only
npm run dev:electron
#   The window loads http://127.0.0.1:8790 (API proxied by Vite to 8787)

# Production preview: build static assets first, Electron opens http://127.0.0.1:8787
npm run start:electron
```

> If the first Electron binary download is slow, set  
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` before `npm i`.  
> Installer distribution (electron-builder) is not wired up yet — see `docs/06` Phase B.
>
> If port `8787` is taken: `set PORT=8799 && npm run desktop`;  
> to keep `npm run dev` running in another terminal: `set KEEP_EXISTING_BACKEND=1`.

## IP allowlist

The "Allowlist" page: detect the current public IP → compare with existing cloud entries → **update only when the IP changed**.

| Provider      | Object updated          | Notes                                                                        |
| ------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Alibaba Cloud | ECS prefix list         | `DescribePrefixLists` / `ModifyPrefixList` (RPC HMAC-SHA1)                   |
| Tencent Cloud | VPC IP address template | `DescribeAddressTemplates` / `ModifyAddressTemplateAttribute` (full replace) |

Tencent Cloud security groups merely **reference** the address template, so editing the template grants access automatically — the "security group ID" is only a note; the template itself must be created first under VPC → IP address templates in the console. Region and template ID are fetched live in the page (no manual input; needs read-only permissions: `QcloudVPCReadOnlyAccess` on Tencent Cloud, `AliyunECSReadOnlyAccess` on Alibaba Cloud).

## Model usage

Balance / spend / resource packs go through Alibaba Cloud BssOpenApi; the model list goes through DashScope; **free quotas are only available through the official Bailian CLI `bl`** (the model-list API has no quota fields and there is no public quota API).

```bash
bl auth login --console                        # first time: browser login
bl auth login --console --config profile-2     # second Alibaba Cloud account: log into a separate profile
```

Then bind the profile to the matching cloud account under "Model usage → CLI identity" (the page walks through 4 steps and copies the commands for you). **No paid probing**: probing would call real models, consume quota and risk rate limiting, so it is disabled; the CLI side relies on scheduling plus rate limiting.

The console access token expires; the page then tells you to log in again (an AK/SK-generated token does not help — you must redo the browser login).

## Verification

```bash
npm run core:test      # 149 assertions (crypto / concurrent writes / locking / backup / MCP subprocess E2E / REST security …)
npm run smoke:server   # /api/locked lock-state smoke test
npm run smoke:memo     # notes smoke test (11/11)
npm run smoke:whitelist# allowlist smoke test (19/19)
npm run build
```
