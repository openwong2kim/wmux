#!/usr/bin/env node
// fake-claude: a scripted fan-out WORKER for factory smoke instances.
//
// Bot presets launch their workers as `claude … "<prompt>"` in a task pane.
// On a smoke instance the runner puts a `claude` wrapper running this file
// first on the pane's PATH, so a stub scenario never starts a real model.
// The worker does what a real one reports, through the same wmux MCP tool a
// real worker uses (`ledger_update`, identity = the pane it runs in):
//
//   1. reads its task id from the task's meta stamp
//      (<worktrees>/.meta/<worktree folder>/task.json);
//   2. optionally commits a file on its branch and has main push it with
//      the real `task_push` tool, the only push a bot's worker has
//      (FACTORY_E2E_WORKER_COMMIT=1; never a verify worker, whose tree is a
//      detached PR head), so a lane scenario has a bot branch;
//   3. a verify worker "installs dependencies" (an empty node_modules: the
//      scratch repo has none) so the base gate can run on its checkout;
//   4. after FACTORY_E2E_WORKER_DELAY_MS reports `review_requested` (or the
//      status in FACTORY_E2E_WORKER_STATUS) with a one-line summary;
//   5. stays alive (an agent that exits leaves a bare shell, which the
//      fan-out launch check reads as "no agent started").
//
// The `start` line also records what the launch would load: whether it
// carried `--strict-mcp-config`, the server names in its `--mcp-config` file
// and the settings file's allow rules (never a key value: the files hold
// none); for codex, the MCP `-c` words.
//
// Every step is logged to FACTORY_E2E_WORKER_LOG as one JSON line.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const LOG = process.env.FACTORY_E2E_WORKER_LOG;
const MCP_BUNDLE = process.env.FACTORY_E2E_MCP_BUNDLE;
const NODE = process.env.FACTORY_E2E_NODE || process.execPath;
const DELAY_MS = Number(process.env.FACTORY_E2E_WORKER_DELAY_MS ?? 1500);
const STATUS = process.env.FACTORY_E2E_WORKER_STATUS || 'review_requested';
const COMMIT = process.env.FACTORY_E2E_WORKER_COMMIT === '1';
const LINGER_MS = Number(process.env.FACTORY_E2E_WORKER_LINGER_MS ?? 15 * 60_000);

function log(event, data = {}) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, cwd: process.cwd(), event, ...data })}\n`);
  } catch {
    /* evidence only */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taskId() {
  const cwd = process.cwd();
  const stamp = path.join(path.dirname(cwd), '.meta', path.basename(cwd), 'task.json');
  try {
    const id = JSON.parse(fs.readFileSync(stamp, 'utf8')).taskId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

function git(args) {
  const r = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** One MCP tools/call through the bundled server, run as a child of this
 *  process so the server resolves this pane as the caller. */
async function mcpCall(name, args) {
  if (!MCP_BUNDLE) return { ok: false, text: 'FACTORY_E2E_MCP_BUNDLE is not set' };
  const child = spawn(NODE, [MCP_BUNDLE], { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => resolve({ error: { message: `timeout ${method}` } }), 60_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wmux-fake-worker', version: '1' } });
    if (init.error) return { ok: false, text: init.error.message };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const r = await request('tools/call', { name, arguments: args });
    if (r.error) return { ok: false, text: r.error.message };
    return { ok: !r.result?.isError, text: (r.result?.content ?? []).map((c) => c.text ?? '').join('\n') };
  } finally {
    child.kill();
  }
}

/** What the launch line's MCP and settings flags load. */
function launchConfig(argv) {
  const value = (flag) => argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const read = (file) => {
    try {
      return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    } catch {
      return null;
    }
  };
  const mcp = read(value('--mcp-config'));
  const settings = read(value('--settings'));
  // A codex line's `-c` words: the features and owner servers it turns off,
  // and each connection table's name with the tools it lists.
  const words = argv.filter((_, i) => argv[i - 1] === '-c');
  const tables = words.map((w) => /^mcp_servers\.([a-z0-9-]+)=(\{.*\})$/.exec(w)).filter(Boolean);
  return {
    strict: argv.includes('--strict-mcp-config'),
    mcpServers: mcp ? Object.keys(mcp.mcpServers ?? {}) : null,
    allow: settings?.permissions?.allow ?? [],
    codexMcp: {
      featuresOff: words.map((w) => /^features\.(\w+)=false$/.exec(w)?.[1]).filter(Boolean),
      serversOff: words.map((w) => /^mcp_servers\.([A-Za-z0-9_-]+)\.enabled=false$/.exec(w)?.[1]).filter(Boolean),
      tables: tables.map((m) => ({ name: m[1], enabledTools: /"enabled_tools"=\[([^\]]*)\]/.exec(m[2])?.[1] ?? null })),
    },
  };
}

async function main() {
  const id = taskId();
  // Which CLI ran this worker (fake-codex.mjs sets codex), and whether the
  // codex rules file main writes was in place.
  const agent = process.env.FACTORY_E2E_WORKER_AGENT || 'claude';
  const rulesPresent = fs.existsSync(path.join(process.cwd(), '.codex', 'rules', 'wmux-bot-worker.rules'));
  log('start', { taskId: id, agent, rulesPresent, ...launchConfig(process.argv.slice(2)), args: process.argv.slice(2).map((a) => a.slice(0, 200)) });
  if (!id) {
    log('no-task-id');
  } else {
    // A verify worker grades a detached PR head: it never commits there.
    const verifyWorker = process.argv.slice(2).some((a) => a.includes('# Verify worker'));
    if (COMMIT && !verifyWorker) {
      fs.writeFileSync(path.join(process.cwd(), `worker-${id}.txt`), `${id}\n`);
      const add = git(['add', '-A']);
      const commit = git(['-c', 'user.name=fake-worker', '-c', 'user.email=fake-worker@example.invalid', 'commit', '-q', '-m', `worker ${id}`]);
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
      const push = await mcpCall('task_push', {});
      log('commit', { add: add.code, commit: commit.code, push: push.ok ? 0 : 1, pushErr: push.ok ? '' : push.text.slice(0, 300), branch, head: git(['rev-parse', 'HEAD']).out });
    }
    // A verify worker installs the dependencies the gate needs; the scratch
    // repo has none, so an empty (git-ignored) node_modules is the install.
    if (verifyWorker) {
      fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
      log('deps', { nodeModules: true });
    }
    await sleep(DELAY_MS);
    const r = await mcpCall('ledger_update', {
      task_id: id,
      status: STATUS,
      expected_rev: 1,
      summary: `fake worker: ${STATUS} for ${id}`,
    });
    log('ledger_update', { ok: r.ok, text: r.text.slice(0, 800) });
  }
  await sleep(LINGER_MS);
  log('exit');
}

main().catch((err) => {
  log('error', { message: String(err) });
});
