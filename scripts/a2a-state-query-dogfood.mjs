// 빌드된 Electron 앱에서 내부 단건 상태 조회와 기존 답장 UX를 검증한다.
// 실행 전: npm run build:daemon && npm run build:mcp && node e2e/build.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `-a2a-state-dogfood-${process.pid}`;
const dataDir = path.join(os.homedir(), `.wmux${suffix}`);
const env = { ...process.env, WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1', WMUX_TEST_CDP_PORT: '1' };
for (const key of ['WMUX_SOCKET_PATH', 'WMUX_AUTH_TOKEN', 'WMUX_WORKSPACE_ID', 'WMUX_PTY_ID', 'WMUX_SURFACE_ID', 'ELECTRON_RUN_AS_NODE']) delete env[key];
let app;
const logs = [];
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env, timeout: 60_000 });
  app.process().stderr?.on('data', (d) => { logs.push(String(d)); if (logs.length > 100) logs.shift(); });
  const win = await app.firstWindow();
  await win.waitForFunction(() => !!window.__wmuxChannelsRpc, { timeout: 30_000 });
  const rpc = async (method, params) => {
    const reply = await win.evaluate(async ({ method, params }) => window.electronAPI.rpc.invoke(method, params), { method, params });
    assert.equal(reply.ok, true, `${method}: ${JSON.stringify(reply)}`);
    assert.ok(!reply.result?.error, `${method}: ${JSON.stringify(reply.result)}`);
    return reply.result;
  };
  const receiver = await rpc('workspace.new', { name: 'A2A state dogfood' });
  assert.ok(receiver.id, JSON.stringify(receiver));
  let taskId;
  for (let i = 0; i < 150; i++) {
    const sent = await rpc('a2a.task.send', { workspaceId: 'ws-human', to: receiver.id, title: `dogfood-${i}`, message: 'x'.repeat(9000), silent: true });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    taskId = sent.taskId;
  }
  const state = () => rpc('a2a.task.query', { workspaceId: 'ws-human', view: 'state', taskId });
  const compact = await state();
  assert.equal(compact.tasks.length, 1);
  assert.equal(compact.tasks[0].status.state, 'submitted');
  assert.ok(!('history' in compact.tasks[0]));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(compactBytes < 512);
  const legacy = await rpc('a2a.task.query', { workspaceId: 'ws-human' });
  assert.equal(legacy.tasks.length, 150);
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
  assert.ok(legacyBytes > 1_000_000);
  const page = await rpc('a2a.task.query', { workspaceId: 'ws-human', view: 'page' });
  assert.equal(page.tasks.length, 20);
  assert.equal(page.total, 150);
  assert.deepEqual((await rpc('a2a.task.query', { workspaceId: 'ws-human', view: 'state', taskId: 'missing' })).tasks, []);
  await rpc('a2a.task.update', { workspaceId: receiver.id, taskId, status: 'working' });
  assert.equal((await state()).tasks[0].status.state, 'working');
  await rpc('a2a.task.update', { workspaceId: receiver.id, taskId, status: 'completed', evidence: { summary: 'dogfood complete', items: [{ kind: 'inspection', status: 'verified', summary: 'state query checked' }] } });
  assert.equal((await state()).tasks[0].status.state, 'completed');
  const reply = await rpc('a2a.task.send', { workspaceId: 'ws-human', taskId, message: 'dogfood follow-up', silent: true });
  assert.equal(reply.ok, true);
  assert.equal((await state()).tasks[0].status.state, 'submitted');
  const detail = await rpc('a2a.task.query', { workspaceId: 'ws-human', view: 'page', taskId });
  assert.equal(detail.task.history.at(-1).parts[0].text, 'dogfood follow-up');
  console.log(JSON.stringify({ passed: true, tasks: 150, compactBytes, legacyBytes, checks: ['compact state', 'legacy full query', 'paged query', 'missing task', 'working', 'completed', 'sender reopen', 'reply history'] }, null, 2));
} catch (error) {
  console.error(logs.join('').slice(-6000));
  throw error;
} finally {
  // 이 실행 전용 suffix의 데몬만 종료한다. 사용자 세션에는 접근하지 않는다.
  const pidFile = path.join(dataDir, 'daemon.pid');
  const daemonPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : null;
  if (app) await app.close().catch(() => {});
  if (daemonPid && Number.isInteger(daemonPid)) {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* 이미 종료됨 */ }
  }
  console.log(`dogfood artifacts: ${dataDir}`);
}
