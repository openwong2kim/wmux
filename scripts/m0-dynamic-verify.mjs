#!/usr/bin/env node
/**
 * M0 dynamic verification — end-to-end exercise of the new MetadataStore +
 * pane.rpc wire format running inside the actual packaged Electron app.
 *
 * Strategy: spawn the packaged Electron app, then talk to its pipe directly
 * with raw JSON-RPC (skipping the MCP wrapper that enforces external-caller
 * workspace identity guards — those are a separate security feature, not
 * part of M0). This exercises the actual handler chain:
 *
 *     pipe socket → PipeServer → RpcRouter → pane.rpc handler →
 *                   MetadataStore → SessionManager.saveMetadataSync
 *
 * What it proves that unit tests cannot:
 *   - MetadataStore is wired into the live IPC server in src/main/index.ts
 *     (not just tested in isolation against a mock router).
 *   - pane.rpc handlers serve real pipe traffic and round-trip the new wire
 *     format end to end (mergeMode, expectedVersion, version, asOfSeq,
 *     bootId).
 *   - VERSION_CONFLICT actually surfaces over the wire on stale writes.
 *   - The shipped vite/asar bundle is intact (not a source-only mirage).
 *
 * Isolation:
 *   - Temp USERPROFILE/HOME so .<exe>/, auth token, pid-map, tcp-port are
 *     sandboxed.
 *   - Win32 pipe name is shared per Windows account (os.userInfo()), so we
 *     pre-flight a check that no real wmux is on it and abort otherwise.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  EXECUTABLE_NAME,
  authTokenPath as appAuthTokenPath,
  packagedAppExe,
  mainPipeName,
} from './helpers/packaged-app.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const APP_EXE = packagedAppExe();
const PIPE_NAME = mainPipeName('', os.userInfo().username);

if (!fs.existsSync(APP_EXE)) {
  console.error(`Packaged app missing at ${APP_EXE}. Run \`npm run package\` first.`);
  process.exit(2);
}

function pipeAlive() {
  return new Promise((resolve) => {
    const sock = net.createConnection(PIPE_NAME);
    const done = (val) => { try { sock.destroy(); } catch {} resolve(val); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `${EXECUTABLE_NAME}-m0-dyn-`));
const AUTH_TOKEN_PATH = appAuthTokenPath(TEST_HOME, '');

let appProc;
const cleanup = () => {
  if (appProc && !appProc.killed) {
    try { appProc.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }, 1500);
};
process.on('exit', () => {
  if (appProc && !appProc.killed) { try { appProc.kill('SIGKILL'); } catch {} }
});
process.on('SIGINT', () => { cleanup(); setTimeout(() => process.exit(130), 2000); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, fn, timeoutMs = 30000, intervalMs = 200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
};

// One-shot RPC over the named pipe.
async function rpc(method, params = {}, token) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(PIPE_NAME);
    let buf = '';
    let settled = false;
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      reject(new Error(`rpc timeout: ${method}`));
    }, 8000);

    sock.once('connect', () => {
      sock.write(JSON.stringify({ id, method, params, token }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch {}
            if (msg.ok === false) return reject(new Error(msg.error));
            return resolve(msg.result ?? msg);
          }
        } catch { /* ignore non-json */ }
      }
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  console.log(`pipe: ${PIPE_NAME}`);
  console.log(`temp HOME: ${TEST_HOME}`);

  if (await pipeAlive()) {
    console.error('A wmux pipe already exists for this Windows user — aborting.');
    cleanup();
    process.exit(3);
  }

  const isolatedEnv = {
    ...process.env,
    USERPROFILE: TEST_HOME,
    HOME: TEST_HOME,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    APPDATA: path.join(TEST_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(TEST_HOME, 'AppData', 'Local'),
    WMUX_DISABLE_CDP: 'true',
  };
  fs.mkdirSync(isolatedEnv.APPDATA, { recursive: true });
  fs.mkdirSync(isolatedEnv.LOCALAPPDATA, { recursive: true });

  console.log('--- spawning Electron app ---');
  appProc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT,
    env: isolatedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  appProc.stdout.on('data', (b) => process.stderr.write(`[app] ${b}`));
  appProc.stderr.on('data', (b) => process.stderr.write(`[app:err] ${b}`));
  appProc.on('exit', (code) => console.error(`[app] exited with ${code}`));

  await waitFor('auth token file', () => fs.existsSync(AUTH_TOKEN_PATH), 30000);
  const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf-8').trim();
  console.log(`--- auth token loaded (${token.length} chars) ---`);

  await waitFor('pipe ready', () => pipeAlive(), 15000);
  console.log('--- pipe accepting connections ---');

  // Give the renderer time to materialize a default workspace + pane.
  await sleep(2500);

  // 1) workspace.list — confirms basic RPC routing
  const wsResult = await rpc('workspace.list', {}, token);
  const workspaces = wsResult?.workspaces ?? wsResult ?? [];
  check('workspace.list returns >=1 workspace', workspaces.length >= 1, `count=${workspaces.length}`);
  if (workspaces.length === 0) {
    console.error('No workspace materialized — aborting.');
    cleanup();
    process.exit(1);
  }
  const wsId = workspaces[0].id || workspaces[0].workspaceId;
  console.log(`--- workspace: ${wsId} ---`);

  // 2) pane.list — must include M0-c envelope
  const pl = await rpc('pane.list', { workspaceId: wsId }, token);
  const panes = pl?.panes || pl?.leaves || [];
  check('pane.list returns envelope object', typeof pl === 'object' && pl !== null);
  check('pane.list envelope has asOfSeq (M0-c)', typeof pl?.asOfSeq === 'number', `asOfSeq=${pl?.asOfSeq}`);
  check('pane.list envelope has bootId (M0-c)', typeof pl?.bootId === 'string' && pl.bootId.length > 0, `bootId=${pl?.bootId?.slice(0, 8)}…`);
  check('pane.list returns >=1 pane', panes.length >= 1, `count=${panes.length}`);
  if (panes.length === 0) { cleanup(); process.exit(1); }

  const target = panes.find((p) => p.id || p.paneId);
  const paneId = target.id || target.paneId;
  check('pane carries version field (M0-c)', typeof target.version === 'number', `version=${target.version}`);
  check('pane carries metadata field (M0-c)', 'metadata' in target, `metadata=${JSON.stringify(target.metadata)}`);

  // 3) pane.getMetadata before any write
  const initial = await rpc('pane.getMetadata', { paneId, workspaceId: wsId }, token);
  check('pane.getMetadata returns version', typeof initial?.version === 'number', `version=${initial?.version}`);
  const baselineVersion = initial?.version ?? 0;

  // 4) pane.setMetadata with expectedVersion=baselineVersion (fresh claim)
  let claimResult;
  try {
    claimResult = await rpc('pane.setMetadata', {
      paneId, workspaceId: wsId,
      label: 'qa-dyn', role: 'verify',
      custom: { 'qa.dyn.run': '1' },
      mergeMode: 'merge',
      expectedVersion: baselineVersion,
    }, token);
    check('pane.setMetadata fresh claim with expectedVersion succeeds', true, `version after = ${claimResult?.version}`);
  } catch (e) {
    check('pane.setMetadata fresh claim with expectedVersion succeeds', false, e.message);
  }

  // 5) Read back — version must have advanced
  const afterClaim = await rpc('pane.getMetadata', { paneId, workspaceId: wsId }, token);
  const afterVersion = afterClaim?.version ?? 0;
  check('version advanced after write (monotonic)', afterVersion > baselineVersion, `${baselineVersion} → ${afterVersion}`);
  check('label round-trips through MetadataStore', afterClaim?.metadata?.label === 'qa-dyn', `label=${afterClaim?.metadata?.label}`);
  check('role round-trips', afterClaim?.metadata?.role === 'verify', `role=${afterClaim?.metadata?.role}`);
  check('custom k/v round-trips', afterClaim?.metadata?.custom?.['qa.dyn.run'] === '1', `custom=${JSON.stringify(afterClaim?.metadata?.custom)}`);

  // 6) Stale write — expectedVersion=baselineVersion (now stale) must FAIL with VERSION_CONFLICT
  let conflictSurfaced = false;
  let conflictMsg = '';
  try {
    await rpc('pane.setMetadata', {
      paneId, workspaceId: wsId,
      label: 'should-not-stick',
      expectedVersion: baselineVersion,
    }, token);
    conflictMsg = '(write succeeded but should have failed)';
  } catch (e) {
    conflictMsg = e.message;
    if (/VERSION_CONFLICT|version.*conflict|currentVersion/i.test(e.message)) {
      conflictSurfaced = true;
    }
  }
  check('stale expectedVersion → VERSION_CONFLICT (M0-a/M0-f)', conflictSurfaced, conflictMsg);

  // 7) Verify the rejected write did NOT mutate state
  const afterStale = await rpc('pane.getMetadata', { paneId, workspaceId: wsId }, token);
  check('VERSION_CONFLICT did not advance version', (afterStale?.version ?? 0) === afterVersion, `still ${afterStale?.version}`);
  check('VERSION_CONFLICT did not corrupt label', afterStale?.metadata?.label === 'qa-dyn', `label=${afterStale?.metadata?.label}`);

  // 8) mergeMode=replace with current version → wipes everything except provided fields
  await rpc('pane.setMetadata', {
    paneId, workspaceId: wsId,
    label: 'replaced',
    mergeMode: 'replace',
    expectedVersion: afterVersion,
  }, token);
  const afterReplace = await rpc('pane.getMetadata', { paneId, workspaceId: wsId }, token);
  check('mergeMode=replace keeps provided label', afterReplace?.metadata?.label === 'replaced', `label=${afterReplace?.metadata?.label}`);
  check('mergeMode=replace wipes role', !afterReplace?.metadata?.role, `role=${afterReplace?.metadata?.role}`);
  check('mergeMode=replace wipes custom', !afterReplace?.metadata?.custom || Object.keys(afterReplace.metadata.custom).length === 0, `custom=${JSON.stringify(afterReplace?.metadata?.custom)}`);
  check('mergeMode=replace advances version', (afterReplace?.version ?? 0) > afterVersion, `${afterVersion} → ${afterReplace?.version}`);
  const replaceVersion = afterReplace?.version ?? 0;

  // 9) mergeMode=replaceShared — overwrites label/role/status, preserves custom from another writer
  // First seed custom via merge mode
  await rpc('pane.setMetadata', {
    paneId, workspaceId: wsId,
    custom: { 'orchestrator.taskId': 'T-42', 'qa.dyn.shared': 'X' },
    mergeMode: 'merge',
    expectedVersion: replaceVersion,
  }, token);
  const afterSeed = await rpc('pane.getMetadata', { paneId, workspaceId: wsId }, token);
  // Now write with replaceShared — should keep the custom keys
  await rpc('pane.setMetadata', {
    paneId, workspaceId: wsId,
    label: 'shared-write',
    role: 'shared-role',
    mergeMode: 'replaceShared',
    expectedVersion: afterSeed?.version,
  }, token);
  const afterShared = await rpc('pane.getMetadata', { paneId, workspaceId: wsId }, token);
  check('mergeMode=replaceShared rewrites label', afterShared?.metadata?.label === 'shared-write');
  check('mergeMode=replaceShared rewrites role', afterShared?.metadata?.role === 'shared-role');
  check('mergeMode=replaceShared preserves other writer custom keys',
    afterShared?.metadata?.custom?.['orchestrator.taskId'] === 'T-42'
    && afterShared?.metadata?.custom?.['qa.dyn.shared'] === 'X',
    `custom=${JSON.stringify(afterShared?.metadata?.custom)}`);

  // 10) pane.list reflects the latest metadata + version (snapshot integration)
  const finalList = await rpc('pane.list', { workspaceId: wsId }, token);
  const finalPane = (finalList?.panes ?? finalList?.leaves ?? []).find((p) => (p.id || p.paneId) === paneId);
  check('pane.list snapshot reflects latest metadata (M0-c integration)',
    finalPane?.metadata?.label === 'shared-write' && finalPane?.version === afterShared?.version,
    `list pane: label=${finalPane?.metadata?.label} version=${finalPane?.version}; getMetadata: version=${afterShared?.version}`);
  check('pane.list asOfSeq advanced from initial', finalList?.asOfSeq > pl?.asOfSeq, `${pl?.asOfSeq} → ${finalList?.asOfSeq}`);
  check('pane.list bootId stable across calls', finalList?.bootId === pl?.bootId);

  // Summary
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} dynamic checks passed ===`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }

  // Try a graceful shutdown via daemon RPC; fall back to SIGTERM.
  try { await rpc('daemon.shutdown', {}, token); } catch {}
  cleanup();
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 2200);
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  cleanup();
  setTimeout(() => process.exit(2), 2200);
});
