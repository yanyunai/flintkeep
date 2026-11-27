process.env.PORT = '18791';
process.env.PROXY_PORT = '18792';
process.env.SSH_PROXY_PORT = '18793';
process.env.VAULT_DATA_DIR = new URL('../data-smoke-tmp', import.meta.url).pathname;

import path from 'path';
import { fileURLToPath } from 'url';
process.env.VAULT_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-smoke-tmp');

const { startAppServer, stopAppServer } = await import('../server.ts');
const { port } = await startAppServer();
const r = await fetch(`http://127.0.0.1:${port}/api/mcp-setup`);
const j = await r.json();
console.log(r.status, j.mcpScript ? 'ok' : j);
await stopAppServer();
process.exit(r.ok && j.mcpScript ? 0 : 1);
