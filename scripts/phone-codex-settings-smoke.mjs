// Exercise live settings without a provider turn, credentials, or user threads.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const probeDirectory = await mkdtemp(path.join(tmpdir(), 'wmux-codex-settings-'));
const args = ['app-server', '--stdio',
  '-c', 'model_provider="wmux_fixture"', '-c', 'model="fixture-a"',
  '-c', 'model_providers.wmux_fixture.name="wmux fixture"',
  '-c', 'model_providers.wmux_fixture.base_url="http://127.0.0.1:9/v1"',
  '-c', 'model_providers.wmux_fixture.wire_api="responses"',
  '-c', 'model_providers.wmux_fixture.requires_openai_auth=false'];
const child = spawn('codex', args, {
  cwd: probeDirectory,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    LANG: 'en_US.UTF-8', CODEX_HOME: probeDirectory },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let serial = 0;
const pending = new Map();
const notifications = [];
let stderr = '';
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  if (line.length > 2 * 1024 * 1024) { child.kill(); return; }
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  } else if (message.method) {
    notifications.push(message);
    if (notifications.length > 100) notifications.shift();
  }
});
const exited = new Promise(resolve => child.once('close', resolve));
child.on('error', error => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
  pending.clear();
});
child.on('exit', () => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Probe server exited')); }
  pending.clear();
});
function request(method, params) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await request('initialize', {clientInfo:{name:'wmux_settings_probe',version:'1.0.0'},capabilities:{experimentalApi:true,requestAttestation:false}});
  child.stdin.write(JSON.stringify({method:'initialized'}) + '\n');
  const started = await request('thread/start', {model:'fixture-a',modelProvider:'wmux_fixture',cwd:probeDirectory,
    ephemeral:true,approvalPolicy:'never',sandbox:'read-only'});
  const threadId = started.thread.id;
  assert.equal(started.model, 'fixture-a');
  const loaded = await request('thread/loaded/list', {limit:100});
  assert(loaded.data.includes(threadId));
  const before = await request('thread/read', {threadId,includeTurns:false});
  assert.equal(before.thread.model, 'fixture-a');
  await request('thread/settings/update', {threadId,model:'fixture-b',effort:'low'});
  const after = await request('thread/read', {threadId,includeTurns:false});
  assert.equal(after.thread.model, 'fixture-b');
  assert.equal(after.thread.reasoningEffort, 'low');
  assert.equal(after.thread.status.type, 'idle');
  const notificationDeadline = Date.now() + 2000;
  while (!notifications.some(event => event.method === 'thread/settings/updated') && Date.now() < notificationDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(notifications.some(event => event.method === 'thread/settings/updated' && event.params.threadId === threadId &&
    event.params.threadSettings.model === 'fixture-b' && event.params.threadSettings.effort === 'low'));
  console.log(JSON.stringify({ok:true,loadedThread:true,model:after.thread.model,effort:after.thread.reasoningEffort,
    settingsNotification:true,turnStarted:false}));
} catch (error) {
  console.error(String(error));
  // The isolated environment contains no authentication material.
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
  lines.close();
  await rm(probeDirectory, {recursive:true,force:true});
}
