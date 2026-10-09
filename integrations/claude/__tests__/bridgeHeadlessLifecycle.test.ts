/**
 * A headless `claude -p` the pane's own agent starts through Bash inherits the
 * pane's WMUX_PTY_ID, so its lifecycle hooks name the host pane. Measured: it
 * reports CLAUDE_CODE_ENTRYPOINT=sdk-cli even when its parent is a `cli`. Its
 * session id and transcript path must never leave the bridge — a daemon would
 * rebind the pane to the child's conversation, and the spool would hand the
 * child's id to recovery. The entrypoint rides the envelope for the daemon.
 *
 * Runs both real bridges against a fake daemon socket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BRIDGES = [
  ['claude', path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs')],
  ['openclaude', path.resolve(process.cwd(), 'integrations/openclaude/bin/wmux-bridge.mjs')],
] as const;

const SESSION_ID = '0a1b2c3d-0000-4000-8000-0000000000c1';

type Envelope = Record<string, unknown> & { payload: Record<string, unknown> };

let tmp: string;
const sockDirs: string[] = [];
beforeAll(() => { tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-headless-')); });
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const dir of sockDirs) rmSync(dir, { recursive: true, force: true });
});

/** One Stop through the real bridge; `accept: false` makes the daemon refuse it (spool path). */
async function runStop(bridge: string, entrypoint: string | undefined, accept = true) {
  const home = mkdtempSync(path.join(tmp, 'home-'));
  mkdirSync(path.join(home, '.wmux'), { recursive: true });
  writeFileSync(path.join(home, '.wmux', 'daemon-auth-token'), 'test-token\n', 'utf8');
  // A Unix socket path is capped near 104 bytes; a long TMPDIR overflows it.
  const sock = path.join(mkdtempSync('/tmp/wbh-'), 'd.sock');
  sockDirs.push(path.dirname(sock));
  writeFileSync(path.join(home, '.wmux', 'daemon-pipe'), sock, 'utf8');
  const transcript = path.join(home, `${SESSION_ID}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } })}\n`, 'utf8');

  const envelopes: Envelope[] = [];
  const server: Server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      envelopes.push(req.params);
      const result = accept ? { ok: true } : { ok: false, reason: 'no-workspace-match' };
      conn.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, 'Stop'], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        WMUX_PTY_ID: 'pty-1',
        ...(entrypoint ? { CLAUDE_CODE_ENTRYPOINT: entrypoint } : {}),
      },
    });
    child.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ session_id: SESSION_ID, transcript_path: transcript, hook_event_name: 'Stop', cwd: home }));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const spoolDir = path.join(home, '.wmux', 'resume-spool');
  const spooled = existsSync(spoolDir) ? readdirSync(spoolDir).filter((f) => f.endsWith('.json')) : [];
  return { code, envelopes, spooled };
}

// Unix socket fake daemon; the bridges' Windows transport is a named pipe.
describe.skipIf(process.platform === 'win32').each(BRIDGES)('%s bridge lifecycle under a headless entrypoint', (_name, bridge) => {
  it('sdk-cli Stop carries the entrypoint and no binding fields', async () => {
    const { code, envelopes } = await runStop(bridge, 'sdk-cli');
    expect(code).toBe(0);
    expect(envelopes).toHaveLength(1);
    const [env] = envelopes;
    expect(env.kind).toBe('agent.stop');
    expect(env.entrypoint).toBe('sdk-cli');
    expect(env.ptyId).toBe('pty-1');
    expect(env.agentSessionId).toBeUndefined();
    expect(env.payload.transcript_path).toBeUndefined();
    expect(env.payload.session_id).toBeUndefined();
    expect(env.payload.usage).toBeUndefined();
    expect(typeof env.agentPid).toBe('number');
  });

  it('an interactive Stop still carries its session and transcript', async () => {
    const { envelopes } = await runStop(bridge, 'cli');
    expect(envelopes[0]).toMatchObject({ entrypoint: 'cli', agentSessionId: SESSION_ID });
    expect(String(envelopes[0].payload.transcript_path)).toMatch(new RegExp(`${SESSION_ID}\\.jsonl$`));
  });

  it('an absent entrypoint keeps today\'s envelope (the daemon judges it)', async () => {
    const { envelopes } = await runStop(bridge, undefined);
    expect(envelopes[0].entrypoint).toBeUndefined();
    expect(envelopes[0].agentSessionId).toBe(SESSION_ID);
  });

  it('a refused sdk-cli Stop spools nothing for recovery; an interactive one does', async () => {
    expect((await runStop(bridge, 'sdk-cli', false)).spooled).toHaveLength(0);
    expect((await runStop(bridge, 'cli', false)).spooled).toHaveLength(1);
  });
});
