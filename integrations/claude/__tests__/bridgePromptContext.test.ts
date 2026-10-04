/**
 * `--context` — the HQ brain's UserPromptSubmit hook.
 *
 * Main's brain lane may answer `hooks.signal` with `additionalContext` (which
 * workspace the human was viewing). In `--context` mode the bridge prints it as
 * Claude Code's UserPromptSubmit `hookSpecificOutput`, and in every other case
 * it prints nothing and exits 0 — a prompt is never blocked from here. The real
 * bridge runs as a subprocess against a fake socket so the bytes on stdout are
 * what is asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BRIDGE = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const LINE = '[wmux context] viewing workspace "iOS app" (ws-a), pane p-1, branch feat/live, cwd /code/ios';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-ctx-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

type Captured = { method: string; token: string; params: { kind: string } };

async function runBridge(args: string[], result: Record<string, unknown>): Promise<{
  code: number | null; stdout: string; requests: Captured[];
}> {
  const home = mkdtempSync(path.join(tmp, 'home-'));
  mkdirSync(path.join(home, '.wmux'), { recursive: true });
  writeFileSync(path.join(home, '.wmux', 'daemon-auth-token'), 'daemon-token\n', 'utf8');
  writeFileSync(path.join(home, '.wmux-auth-token'), 'main-token\n', 'utf8');
  const sock = path.join(home, 'm.sock');
  const requests: Captured[] = [];
  const server: Server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      requests.push(req);
      conn.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const out = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WMUX_PIPE_NAME: sock, WMUX_PTY_ID: 'pty-brain' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: 'UserPromptSubmit', prompt: 'merge this' }));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { ...out, requests };
}

// Unix socket fake endpoint; the bridge's Windows transport is a named pipe.
describe.skipIf(process.platform === 'win32')('claude bridge --context', () => {
  it('prints the context line as UserPromptSubmit hook output, addressed to main', async () => {
    const { code, stdout, requests } = await runBridge(['UserPromptSubmit', '--context'], { ok: true, additionalContext: LINE });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: LINE },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('hooks.signal');
    expect(requests[0].token).toBe('main-token');
    expect(requests[0].params.kind).toBe('agent.user_prompt_submit');
  });

  it.each([
    [{ ok: true }],
    [{ ok: true, additionalContext: '' }],
    [{ ok: false, reason: 'no-workspace-match', additionalContext: LINE }],
  ])('prints nothing and exits 0 for %j', async (result) => {
    const { code, stdout } = await runBridge(['UserPromptSubmit', '--context'], result);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('prints nothing without --context, even when the endpoint offers a line', async () => {
    const { code, stdout } = await runBridge(['UserPromptSubmit'], { ok: true, additionalContext: LINE });
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});
