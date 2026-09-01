#!/usr/bin/env node
/**
 * Live dogfood for browser_replay (record → save → restart → run → heal).
 *
 * Drives the REAL bundled MCP server over stdio against a REAL running wmux,
 * the same way a host does. Nothing here is stubbed: the browser is a live
 * surface, the traces go through the actual RPC broker into
 * ~/.wmux/browser-action-cache.json, and the replay resolves against a real
 * accessibility tree.
 *
 * The eight checks, in order:
 *   D1  a flow can be performed and every action reported success
 *   D2  save names it and reports the step count
 *   D3  a FRESH MCP process (the restart case) still lists it — the ref map
 *       it was recorded against is gone, the cache file is not
 *   D4  run replays it and the result contains NO snapshot
 *   D5  run is repeatable (3/3)
 *   D6  a page whose target element was removed stops at that step and names it
 *   D7  a password step is stored as a hole and refuses to run
 *   D8  forget removes it
 *
 * Usage:
 *   node scripts/browser-replay-dogfood.mjs [--url <page>] [--keep]
 *
 * Requires a running wmux whose MCP client policy admits this caller — an
 * unconfirmed plugin is refused at browser_navigate and the script SKIPs with
 * that message rather than pretending the checks ran. Register it first
 * (`wmux mcp clients` shows how wmux identified the caller).
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the environment was
 * not available (no wmux, no browser surface) — never a false PASS.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BUNDLE = path.join(REPO_ROOT, 'dist', 'mcp-bundle', 'index.js');
const TIMEOUT = 60_000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const URL_UNDER_TEST = arg('--url', 'https://example.com/');
const KEEP = argv.includes('--keep');
const TRACE_NAME = 'dogfood-replay';

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
};

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    cwd: REPO_ROOT,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
    ),
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'browser-replay-dogfood', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: TIMEOUT });
  return client;
}

const textOf = (res) =>
  (res?.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT });
  return { text: textOf(res), isError: res?.isError === true };
}

function fail(reason) {
  console.log(`SKIP — ${reason}`);
  process.exit(2);
}

const main = async () => {
  let client;
  try {
    client = await connect();
  } catch (err) {
    fail(`the bundled MCP server would not start (${err?.message ?? err}). Run npm run build:mcp.`);
  }

  // Environment gate. A dogfood that "passes" without a browser proves nothing.
  const opened = await call(client, 'browser_navigate', { url: URL_UNDER_TEST });
  if (opened.isError) {
    fail(`no browser surface for this workspace: ${opened.text.slice(0, 200)}`);
  }

  // Start clean so a previous run cannot make a check pass.
  await call(client, 'browser_replay', { action: 'forget', name: TRACE_NAME });

  // D1 — perform a flow. A snapshot first, so the actions address real refs.
  const snap = await call(client, 'browser_snapshot', {});
  const refMatch = /\bref[=\s"[]*(\d+)/.exec(snap.text);
  if (!refMatch) fail('the page under test exposed no refs to act on');
  const ref = refMatch[1];
  const acted = await call(client, 'browser_click', { ref });
  check('D1-flow-performed', !acted.isError, `clicked ref=${ref}: ${acted.text.split('\n').pop()}`);

  // D2 — save it.
  const saved = await call(client, 'browser_replay', { action: 'save', name: TRACE_NAME });
  check(
    'D2-save',
    !saved.isError && /\bstep\(s\)/.test(saved.text),
    saved.text.split('\n')[0],
  );

  // D3 — a fresh MCP process: every in-memory ref map is gone.
  await client.close().catch(() => undefined);
  const restarted = await connect();
  const listed = await call(restarted, 'browser_replay', { action: 'list' });
  check(
    'D3-survives-restart',
    listed.text.includes(TRACE_NAME),
    'a new MCP process still lists the flow (the cache file outlived the ref map)',
  );

  // D4 — replay, and prove no snapshot came back with it.
  await call(restarted, 'browser_navigate', { url: URL_UNDER_TEST });
  const ran = await call(restarted, 'browser_replay', { action: 'run', name: TRACE_NAME });
  const looksLikeSnapshot = /\[ref=\d+\]|^\s*-\s+\w+ "/m.test(ran.text);
  check('D4-run', !ran.isError, ran.text.split('\n')[0]);
  check(
    'D4-no-snapshot-exposed',
    !looksLikeSnapshot,
    'the replay result carries no snapshot lines — this is the whole saving',
  );

  // D5 — repeatable.
  let repeats = 0;
  for (let i = 0; i < 3; i++) {
    await call(restarted, 'browser_navigate', { url: URL_UNDER_TEST });
    const again = await call(restarted, 'browser_replay', { action: 'run', name: TRACE_NAME });
    if (!again.isError) repeats++;
  }
  check('D5-repeatable', repeats === 3, `${repeats}/3 replays succeeded`);

  // D6 — remove the element the flow depends on; the replay must stop AT it.
  await call(restarted, 'browser_navigate', { url: URL_UNDER_TEST });
  await call(restarted, 'browser_evaluate', {
    expression: 'document.querySelectorAll("a,button").forEach((el) => el.remove()), "removed"',
  });
  const broken = await call(restarted, 'browser_replay', { action: 'run', name: TRACE_NAME });
  check(
    'D6-self-heal-report',
    broken.isError && /stopped at step \d+/.test(broken.text) && /finish from here/.test(broken.text),
    broken.text.split('\n')[0],
  );

  // D7 — a password step is a hole that refuses to run.
  await call(restarted, 'browser_navigate', { url: 'data:text/html,<input type=password>' });
  const pwSnap = await call(restarted, 'browser_snapshot', {});
  const pwRef = /\bref[=\s"[]*(\d+)/.exec(pwSnap.text)?.[1];
  if (pwRef) {
    await call(restarted, 'browser_type', { ref: pwRef, text: 'dogfood-secret-value' });
    const pwSaved = await call(restarted, 'browser_replay', { action: 'save', name: `${TRACE_NAME}-pw` });
    const pwRun = await call(restarted, 'browser_replay', { action: 'run', name: `${TRACE_NAME}-pw` });
    check(
      'D7-password-hole',
      pwSaved.text.includes('refuse to run') && pwRun.isError && pwRun.text.includes('password'),
      'the password step is stored as a hole and the flow refuses to run',
    );
    await call(restarted, 'browser_replay', { action: 'forget', name: `${TRACE_NAME}-pw` });
  } else {
    check('D7-password-hole', false, 'could not reach a password field to test with');
  }

  // D8 — forget.
  if (!KEEP) {
    const forgotten = await call(restarted, 'browser_replay', { action: 'forget', name: TRACE_NAME });
    const after = await call(restarted, 'browser_replay', { action: 'list' });
    check(
      'D8-forget',
      forgotten.text.startsWith('Forgot') && !after.text.includes(TRACE_NAME),
      'the flow is gone from the workspace',
    );
  }

  await restarted.close().catch(() => undefined);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.log(`ERROR — ${err?.stack ?? err}`);
  process.exit(1);
});
