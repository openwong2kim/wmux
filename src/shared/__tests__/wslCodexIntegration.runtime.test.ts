import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWslInjection } from '../wslIntegration';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  // Resolved once: macOS os.tmpdir() is a symlink, and Codex reports the real cwd.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-')));
  dirs.push(dir);
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, "project ' with spaces 日本語");
  const bin = path.join(dir, 'real-bin');
  for (const p of [home, cwd, bin, path.join(home, '.codex')]) fs.mkdirSync(p, { recursive: true });
  const sessions = path.join(home, '.codex/sessions/2026/09/18');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-2026-09-18T00-00-00-${SESSION_ID}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: SESSION_ID, source: 'cli' } }) + '\n');
  const capture = path.join(dir, 'capture.mjs');
  fs.writeFileSync(capture, `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '-c' && args[1]?.startsWith('notify=["/bin/sh"')) {
  const [cmd, ...prefix] = JSON.parse(args[1].slice(7));
  // A real payload carries the turn's full input and answer; only the fields the
  // bridge reads may reach it (a Windows command line holds ~32K characters).
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': '${SESSION_ID}', 'turn-id': 'turn-1',
    cwd: process.cwd(), 'input-messages': ['a prompt'], 'last-assistant-message': 'x'.repeat(40000) });
  const result = spawnSync(cmd, [...prefix, payload], { env: process.env });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log(JSON.stringify({ args, electron: process.env.ELECTRON_RUN_AS_NODE }));
`);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec "$WMUX_TEST_NODE" "$WMUX_TEST_CAPTURE" "$@"\n', { mode: 0o700 });
  const bridge = path.join(dir, 'bridge.mjs');
  fs.writeFileSync(bridge, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.WMUX_TEST_RESULT, JSON.stringify({
  payload: JSON.parse(process.argv.at(-1)), pane: process.env.WMUX_PTY_ID,
  suffix: process.env.WMUX_DATA_SUFFIX, electron: process.env.ELECTRON_RUN_AS_NODE,
}));
`);
  const resultPath = path.join(dir, 'bridge-result.json');
  const injected = buildWslInjection({
    target: { distribution: 'Ubuntu', user: 'test' }, cwd, integrationDir: dir,
    bashInit: '# fixture', runtimePath: process.execPath, bridgePath: '/unused-claude', codexBridgePath: bridge,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, WMUX_TEST_NODE: process.execPath,
      WMUX_TEST_CAPTURE: capture, WMUX_TEST_RESULT: resultPath, WMUX_PTY_ID: 'pane-one', WMUX_DATA_SUFFIX: '-codex-test' },
  });
  const env = { ...injected.env, PATH: `${injected.env.WMUX_WSL_BIN}:${injected.env.WMUX_WSL_BIN}:${injected.env.PATH}` };
  const run = (args: string[] = [], overrides: Record<string, string> = {}) => {
    const result = spawnSync('/bin/bash', [path.join(dir, 'wsl/bin/codex'), ...args], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return { args: JSON.parse(result.stdout).args, electron: JSON.parse(result.stdout).electron, stderr: result.stderr };
  };
  return { dir, home, cwd, bin, run, resultPath, injected, env, rollout };
}

describe.skipIf(process.platform === 'win32')('WSL Codex per-launch notify', () => {
  it('captures identity and Linux cwd through the hook, preserves argv, and leaves configuration untouched', () => {
    const f = fixture();
    const config = path.join(f.home, '.codex/config.toml');
    fs.writeFileSync(config, '# existing settings\nmodel = "test"\n');
    const args = ['-c', 'model=test', 'resume', 'exact-session', '--', 'a "quoted" prompt'];
    const result = f.run(args);
    expect(result.args.slice(2)).toEqual(args);
    expect(result.electron).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(fs.readFileSync(f.resultPath, 'utf8'))).toEqual({
      payload: { type: 'agent-turn-complete', 'thread-id': SESSION_ID, 'turn-id': 'turn-1', cwd: f.cwd },
      pane: 'pane-one', suffix: '-codex-test', electron: '1',
    });
    expect(fs.readFileSync(config, 'utf8')).toBe('# existing settings\nmodel = "test"\n');
    expect(f.injected.env.WSLENV).toContain('WMUX_WSL_CODEX_BRIDGE/u');
    expect(f.injected.env.WSLENV).toContain('WMUX_WSL_CODEX_HOOK/p');
  });

  it.each(['user', 'profile', 'project', 'ancestor', 'cd', 'malformed'])('preserves %s configuration that cannot safely be overridden', (kind) => {
    const f = fixture();
    let config = path.join(f.home, '.codex/config.toml');
    const args: string[] = [];
    if (kind === 'profile') config = path.join(f.home, '.codex/work.config.toml');
    if (kind === 'project') config = path.join(f.cwd, '.codex/config.toml');
    if (kind === 'ancestor') config = path.join(f.dir, '.codex/config.toml');
    if (kind === 'cd') {
      const other = path.join(f.dir, 'another-project');
      config = path.join(other, '.codex/config.toml');
      args.push('--cd', other);
    }
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = kind === 'malformed' ? 'not valid toml' : '"notify" = ["my-notifier", "argument"]\n';
    fs.writeFileSync(config, original);
    const result = f.run(args);
    expect(result.args).toEqual(args);
    expect(result.stderr).toContain('resume capture not injected');
    expect(fs.existsSync(f.resultPath)).toBe(false);
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
  });

  it.each([['-c', 'notify=["custom"]'], ['--config=notify=[]'], ['-cnotify=["custom"]']])('preserves explicit notify override %j', (...args) => {
    const f = fixture();
    expect(f.run(args).args).toEqual(args);
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });

  it('binds a reverted thread, whose rollout filename carries a rollout ID after the thread ID', () => {
    const f = fixture();
    const reverted = f.rollout.replace(/\.jsonl$/, '_99999999-8888-4777-8666-555555555555.jsonl');
    fs.renameSync(f.rollout, reverted);
    f.run();
    expect(JSON.parse(fs.readFileSync(f.resultPath, 'utf8')).payload['thread-id']).toBe(SESSION_ID);
  });

  it.each(['temporary', 'subagent', 'mismatched', 'malformed'])('does not bind a %s notification as the conversation', (kind) => {
    const f = fixture();
    if (kind === 'temporary') fs.unlinkSync(f.rollout);
    if (kind === 'subagent') fs.writeFileSync(f.rollout, JSON.stringify({ type: 'session_meta',
      payload: { id: SESSION_ID, source: { subagent: 'review' } } }) + '\n');
    if (kind === 'mismatched') fs.writeFileSync(f.rollout, JSON.stringify({ type: 'session_meta',
      payload: { id: 'another-thread', source: 'cli' } }) + '\n');
    if (kind === 'malformed') fs.writeFileSync(f.rollout, 'invalid metadata\n');
    f.run();
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });

  it('honors CODEX_HOME and integration opt-out, and still launches when the helper is unavailable', () => {
    const f = fixture();
    const customHome = path.join(f.dir, 'custom-home');
    fs.mkdirSync(customHome);
    fs.writeFileSync(path.join(customHome, 'config.toml'), 'notify=["mine"]');
    expect(f.run(['resume', 'old'], { CODEX_HOME: customHome }).args).toEqual(['resume', 'old']);
    expect(f.run(['--version'], { WMUX_SHELL_INTEGRATION: '0' }).args).toEqual(['--version']);
    expect(f.run(['--version'], { WMUX_WSL_CODEX_CONFIG: '/missing-helper' }).args).toEqual(['--version']);
    expect(fs.existsSync(f.resultPath)).toBe(false);
  });
});

// Optional real-CLI contract check. The only model endpoint is a loopback stub;
// all config/auth/session state lives in the fixture, not the user's Codex home.
describe.runIf(process.platform !== 'win32' && !!process.env.WMUX_TEST_CODEX_BINARY)('real Codex notify contract', () => {
  it('captures a real interactive turn and the same thread after exact-ID resume', async () => {
    const f = fixture();
    fs.unlinkSync(f.rollout);
    fs.unlinkSync(path.join(f.bin, 'codex'));
    fs.symlinkSync(path.resolve(process.env.WMUX_TEST_CODEX_BINARY ?? ''), path.join(f.bin, 'codex'));
    const codexHome = path.join(f.home, '.codex');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `[projects.${JSON.stringify(f.cwd)}]\ntrust_level="trusted"\n`);
    const { spawn } = await import('node-pty');
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return; }
        const message = { id: 'msg_test', type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: 'ready', annotations: [] }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = (type: string, extra: Record<string, unknown>) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
        emit('response.created', { response: { id: 'resp_test', object: 'response', status: 'in_progress', output: [] } });
        emit('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
        emit('response.content_part.added', { item_id: 'msg_test', output_index: 0, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] } });
        emit('response.output_text.delta', { item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'ready' });
        emit('response.output_text.done', { item_id: 'msg_test', output_index: 0, content_index: 0, text: 'ready' });
        emit('response.output_item.done', { output_index: 0, item: message });
        emit('response.completed', { response: { id: 'resp_test', object: 'response', status: 'completed', output: [message],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const baseArgs = ['--no-alt-screen', '-c', 'tui.animations=false', '-c', 'model_provider="stub"', '-c', 'model="stub"',
      '-c', 'model_providers.stub.name="stub"', '-c', `model_providers.stub.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.stub.wire_api="responses"', '-c', 'model_providers.stub.requires_openai_auth=false'];
    let threadId: string | undefined;
    try {
      for (let round = 0; round < 2; round++) {
        fs.rmSync(f.resultPath, { force: true });
        const args = [...baseArgs, ...(threadId ? ['resume', threadId] : []), 'Say ready'];
        const child = spawn('/bin/bash', [path.join(f.dir, 'wsl/bin/codex'), ...args], {
          cwd: f.cwd, cols: 100, rows: 40,
          env: { ...f.env, CODEX_HOME: codexHome, TERM: 'xterm-256color', OPENAI_API_KEY: 'wmux-local-stub-only',
            PATH: `${f.env.PATH}:${path.dirname(process.execPath)}` },
        });
        const exited = new Promise<void>(resolve => child.onExit(() => resolve()));
        let output = '';
        child.onData(data => {
          output = (output + data).slice(-10_000);
          if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
        });
        try {
          await expect.poll(() => fs.existsSync(f.resultPath), { timeout: 20_000 }).toBe(true);
          const { payload, pane } = JSON.parse(fs.readFileSync(f.resultPath, 'utf8'));
          expect(payload.type).toBe('agent-turn-complete');
          expect(payload.cwd).toBe(f.cwd);
          expect(pane).toBe('pane-one');
          expect(payload['thread-id']).toEqual(threadId ?? expect.any(String));
          threadId = payload['thread-id'];
          // A captured ID must refer to a real persisted rollout, not a hidden title thread.
          await expect.poll(() => {
            const sessions = path.join(codexHome, 'sessions');
            return fs.existsSync(sessions) && fs.readdirSync(sessions, { recursive: true })
              .some(file => String(file).endsWith(`${threadId}.jsonl`));
          }, { timeout: 15_000 }).toBe(true);
        } catch (error) {
          throw new Error(`Codex fixture round ${round}: ${output}`, { cause: error });
        } finally {
          // Let Codex flush its rollout before starting the exact-ID resume.
          child.write('/exit\r');
          const killTimer = setTimeout(() => child.kill(), 5000);
          await exited;
          clearTimeout(killTimer);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60_000);
});
