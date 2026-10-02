#!/usr/bin/env node
// Drives a built helper by hand, for dogfooding on Windows:
//
//   node probe.mjs <exe> <method> [paramsJson] [<method> [paramsJson]]...
//
// Spawns the helper, prints how long `hello` took, sends each request in
// order (one at a time, as main does), prints each response as one JSON line
// with "ms" added (screenshot data shortened to its length), then closes
// stdin. In a paramsJson, the string "$snap" is replaced by the snapshotId of
// the last getAppState, and "$target" by {pid, windowId} of its window:
//
//   node probe.mjs dist/wmux-computer-use.exe getAppState '{"app":"notepad","mode":"ax"}' \
//     click '{"snapshotId":"$snap","target":"$target","index":3,"button":"left","clickCount":1,"modifiers":[]}' \
//     type '{"snapshotId":"$snap","target":"$target","text":"hi"}'

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [exeArg, ...rest] = process.argv.slice(2);
if (!exeArg || rest.length === 0) {
  console.error('usage: node probe.mjs <exe> <method> [paramsJson] [<method> [paramsJson]]...');
  process.exit(2);
}
const requests = [];
for (let i = 0; i < rest.length; i++) {
  const method = rest[i];
  let params = {};
  if (i + 1 < rest.length && rest[i + 1].trim().startsWith('{')) {
    try {
      params = JSON.parse(rest[++i]);
    } catch (e) {
      console.error(`params for ${method} are not JSON: ${e.message}`);
      process.exit(2);
    }
  }
  requests.push({ method, params });
}

const child = spawn(resolve(exeArg), [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
child.on('error', (e) => { console.error(`could not start the helper: ${e.message}`); process.exit(1); });
let exitInfo = null;
child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

const lines = [];
let waiter = null;
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (waiter) waiter(line); else lines.push(line);
  }
});
child.stdout.on('end', () => { if (waiter) waiter(null); });

function nextLine(timeoutMs) {
  if (lines.length) return Promise.resolve(lines.shift());
  return new Promise((res) => {
    const t = setTimeout(() => { waiter = null; res(null); }, timeoutMs);
    waiter = (line) => { clearTimeout(t); waiter = null; res(line); };
  });
}

function shorten(value) {
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'data' && typeof v === 'string' && v.length > 64 ? `<${v.length} base64 chars>` : shorten(v);
    }
    return out;
  }
  return value;
}

function substitute(value, snap, target) {
  if (value === '$snap') return snap ?? value;
  if (value === '$target') return target ?? value;
  if (Array.isArray(value)) return value.map((v) => substitute(v, snap, target));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, snap, target)]));
  }
  return value;
}

const started = performance.now();
const hello = await nextLine(10000);
if (hello === null) {
  console.error(`no hello within 10 s${exitInfo ? ` (exited with ${exitInfo.code})` : ''}`);
  process.exit(1);
}
console.log(JSON.stringify({ ...JSON.parse(hello), ms: Math.round(performance.now() - started) }));

let snap = null;
let target = null;
let id = 1;
for (const { method, params } of requests) {
  const request = { id: id++, method, params: substitute(params, snap, target) };
  const t0 = performance.now();
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const line = await nextLine(method === 'getAppState' ? 20000 : 12000);
  const ms = Math.round(performance.now() - t0);
  if (line === null) {
    console.log(JSON.stringify({ id: request.id, method, ms, error: 'no response (timed out or the helper exited)' }));
    break;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(JSON.stringify({ id: request.id, method, ms, raw: line.slice(0, 500) }));
    continue;
  }
  if (method === 'getAppState' && msg.ok) {
    snap = msg.result.snapshotId;
    target = { pid: msg.result.window.pid, windowId: msg.result.window.id };
  }
  console.log(JSON.stringify({ ...shorten(msg), method, ms }));
}

child.stdin.end();
const deadline = performance.now() + 5000;
while (!exitInfo && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
if (!exitInfo) {
  console.error('the helper did not exit within 5 s of stdin EOF; killing it');
  child.kill();
  process.exit(1);
}
console.error(`helper exited with ${exitInfo.code}`);
