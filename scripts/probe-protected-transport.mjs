#!/usr/bin/env node
/**
 * Probe: does a protected browser profile hold the same rows on the debugging
 * pipe as on the DevTools port, on this machine's Chrome or Edge?
 *
 * For each browser found, runs ProtectedTransport.chrome.runtime.test.ts with
 * every row on both transports (PROTECTED_TABLE_OUT) and prints the port|pipe
 * table. That suite launches the production ChromeLauncher on a fresh temp
 * profile, behind the production proxy, against a local fixture server only;
 * downloads go to temp folders. No existing profile is read or written.
 *
 * Usage: node scripts/probe-protected-transport.mjs [--browser chrome|edge|<path>]... [--headful] [--json out.json]
 * --headful runs Chrome with windows, as wmux does (headless Chrome denies
 * downloads in a new context by default).
 * Exits 1 when a browser that was found fails a pipe row, the pipe holds less
 * than the port on any row, or the suite did not finish; 2 on a bad argument.
 * REPORTED_ROWS are known differences from the port: printed, never failed on.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = 'src/main/browser-session/__tests__/ProtectedTransport.chrome.runtime.test.ts';
const SUITE_TIMEOUT_MS = 15 * 60_000;

/** Rows the suite records but does not assert on the pipe (REPORTED_ROWS there): known differences from the port. */
const REPORTED_ROWS = new Set(['k']);
const USAGE = 'usage: node scripts/probe-protected-transport.mjs [--browser chrome|edge|<path>]... [--headful] [--json out.json]';

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const wanted = [];
let jsonOut = null;
let headful = false;
for (let i = 0; i < args.length; i++) {
  const value = () => {
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) usageError(`${args[i - 1]} needs a value`);
    return v;
  };
  if (args[i] === '--browser') wanted.push(value());
  else if (args[i] === '--headful') headful = true;
  else if (args[i] === '--json') jsonOut = value();
  else usageError(`unknown argument: ${args[i]}`);
}
if (wanted.length === 0) wanted.push('chrome', 'edge');

function candidates(name) {
  if (name !== 'chrome' && name !== 'edge') return [name];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = name === 'chrome' ? 'Google\\Chrome\\Application\\chrome.exe' : 'Microsoft\\Edge\\Application\\msedge.exe';
    return roots.map((r) => path.join(r, rel));
  }
  if (process.platform === 'darwin') {
    return name === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return name === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}

const cell = (v) => (v === undefined ? 'not run' : v ? 'holds' : 'does not hold');
const results = [];
let failed = false;

for (const name of wanted) {
  const binary = candidates(name).find((p) => fs.existsSync(p));
  if (!binary) {
    console.log(`${name}: not found`);
    continue;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-protected-probe-'));
  const out = path.join(scratch, 'table.json');
  const run = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '-c', 'vitest.runtime.config.ts', SUITE], {
    cwd: root,
    env: { ...process.env, CHROME_PATH: binary, PROTECTED_TABLE_OUT: out, ...(headful && { PROTECTED_HEADFUL: '1' }) },
    encoding: 'utf8',
    timeout: SUITE_TIMEOUT_MS,
  });
  let table = null;
  try { table = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* the suite did not get as far as writing it */ }
  fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${name} (${binary}), ${process.platform}-${process.arch}${headful ? ', headful' : ''}`);
  if (!table) {
    failed = true;
    console.log(`the suite wrote no table (exit ${run.status ?? run.signal ?? run.error?.message})`);
    console.log((run.stdout ?? '').split('\n').slice(-30).join('\n'));
    results.push({ name, binary, error: 'no table' });
    continue;
  }
  console.log('| row | protection | port | pipe | notes |');
  console.log('|---|---|---|---|---|');
  for (const r of table.rows) {
    const notes = ['port', 'pipe'].filter((t) => r.note?.[t]).map((t) => `${t}: ${r.note[t]}`).join('; ');
    console.log(`| ${r.id} | ${r.what} | ${cell(r.port)} | ${cell(r.pipe)} | ${notes} |`);
  }
  const counted = table.rows.filter((r) => !REPORTED_ROWS.has(r.id));
  const pipeShort = counted.filter((r) => r.pipe !== true).map((r) => r.id);
  const weaker = counted.filter((r) => r.port === true && r.pipe !== true).map((r) => r.id);
  const reported = table.rows.filter((r) => REPORTED_ROWS.has(r.id) && r.pipe !== true).map((r) => r.id);
  if (reported.length) console.log(`known differences from the port, reported only: ${reported.join(', ')}`);
  if (pipeShort.length || weaker.length || run.status !== 0) {
    failed = true;
    console.log(`pipe rows not holding: ${pipeShort.join(', ') || 'none'}; pipe weaker than the port: ${weaker.join(', ') || 'none'}; suite exit ${run.status}`);
  }
  results.push({ name, binary, exit: run.status, ...table });
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ platform: `${process.platform}-${process.arch}`, headful, results }, null, 2));
if (results.length === 0) {
  console.log('no browser found');
  process.exit(1);
}
process.exit(failed ? 1 : 0);
