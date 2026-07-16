// P4 acceptance probe: spawn the REAL bundled MCP server with and without
// --commander and diff the tools/list surfaces over actual stdio JSON-RPC.
import { spawn } from 'node:child_process';

const BUNDLE = 'D:/wmux/dist/mcp-bundle/index.js';

function listTools(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WMUX_COMMANDER_TOKEN: args.includes('--commander') ? 'probe-token' : undefined },
    });
    let buf = '';
    const tools = [];
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          } else if (msg.id === 2) {
            for (const t of msg.result.tools) tools.push(t.name);
            child.kill();
            resolve(tools);
          }
        } catch { /* partial */ }
      }
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 20000);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    }) + '\n');
  });
}

const full = await listTools([]);
const commander = await listTools(['--commander']);
const denied = ['pane_close', 'surface_close'];
const browser = commander.filter((t) => t.startsWith('browser_'));
const company = commander.filter((t) => t.startsWith('company_'));
console.log(JSON.stringify({
  fullCount: full.length,
  commanderCount: commander.length,
  fullHasPaneClose: full.includes('pane_close'),
  commanderHasDenied: denied.filter((t) => commander.includes(t)),
  commanderBrowserTools: browser.length,
  commanderCompanyTools: company.length,
  commanderHasDecisionGate: commander.includes('deck_ask_decision'),
  commanderHasSplit: commander.includes('pane_split'),
}, null, 2));
