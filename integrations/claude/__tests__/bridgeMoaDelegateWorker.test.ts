/**
 * A fan-out worker under Moa's delegate (main's delegateSpawnPolicy) keeps
 * AskUserQuestion in its tool list and refuses it in its own PreToolUse hook,
 * which sends the question to moa_ask. The plugin's AskUserQuestion hook runs
 * beside it; its `agent.awaiting_input` would leave a needs-you record that no
 * answer ever retires. The worker's settings set WMUX_MOA_DELEGATE_WORKER=1,
 * and the bridge sends nothing then. Without it, the report goes out as before.
 *
 * Same harness as bridgePermissionRequest.test.ts: the real bridge as a
 * subprocess against a fake daemon socket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BRIDGE = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-moa-worker-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

type Captured = { method: string; params: { kind: string } };

async function runAsk(extraEnv: Record<string, string>): Promise<{ code: number | null; stdout: string; requests: Captured[] }> {
  const home = mkdtempSync(path.join(tmp, 'home-'));
  mkdirSync(path.join(home, '.wmux'), { recursive: true });
  writeFileSync(path.join(home, '.wmux', 'daemon-auth-token'), 'test-token\n', 'utf8');
  const sock = path.join(home, 'd.sock');
  const requests: Captured[] = [];
  const server: Server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      requests.push(req);
      conn.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const payload = {
    session_id: 's-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
  };
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, 'PreToolUse'], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WMUX_PIPE_NAME: sock, WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...extraEnv },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { ...result, requests };
}

describe('claude bridge, AskUserQuestion in a Moa delegate worker', () => {
  it.skipIf(process.platform === 'win32')('reports it as awaiting_input in an ordinary pane', async () => {
    const { code, requests } = await runAsk({});
    expect(code).toBe(0);
    expect(requests.map((r) => r.params.kind)).toEqual(['agent.awaiting_input']);
  });

  it.skipIf(process.platform === 'win32')('sends nothing in a delegate worker, and exits 0 silently', async () => {
    const { code, stdout, requests } = await runAsk({ WMUX_MOA_DELEGATE_WORKER: '1' });
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(requests).toEqual([]);
  });
});
