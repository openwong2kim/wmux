/**
 * After a turn ends, Claude Code runs its own forked agents in the background
 * (the prompt suggestion, the away recap). Their tool hooks fire in the user's
 * session with an `agent_id` and NO `agent_type` — a real subagent always
 * carries both. Reported, a fork's PostToolUse stamped the pane's activity and
 * lit the sidebar's running dot for two minutes with the agent idle at its
 * prompt. The bridge sends nothing for them; a real subagent's hooks and the
 * main thread's go out as before.
 *
 * Same harness as bridgeMoaDelegateWorker.os.test.ts: the real bridge as a
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
beforeAll(() => { tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-fork-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

type Captured = { method: string; params: { kind: string } };

async function runHook(hookName: string, payload: Record<string, unknown>): Promise<{ code: number | null; stdout: string; requests: Captured[] }> {
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
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE, hookName], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WMUX_PIPE_NAME: sock, WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: hookName, ...payload }));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { ...result, requests };
}

const TOOL = { tool_name: 'Bash', tool_input: { command: 'cat notes.log' }, tool_response: { stdout: '' } };

describe('claude bridge, hooks from Claude Code\'s internal forked agents', () => {
  it.skipIf(process.platform === 'win32')('reports a main-thread PostToolUse as activity', async () => {
    const { requests } = await runHook('PostToolUse', TOOL);
    expect(requests.map((r) => r.params.kind)).toEqual(['agent.activity']);
  });

  it.skipIf(process.platform === 'win32')('reports a real subagent\'s PostToolUse as activity', async () => {
    const { requests } = await runHook('PostToolUse', { ...TOOL, agent_id: 'a1', agent_type: 'general-purpose' });
    expect(requests.map((r) => r.params.kind)).toEqual(['agent.activity']);
  });

  it.skipIf(process.platform === 'win32')('sends nothing for a fork\'s PostToolUse (agent_id, no agent_type)', async () => {
    const { code, stdout, requests } = await runHook('PostToolUse', { ...TOOL, agent_id: 'a1' });
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(requests).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('sends nothing for a fork\'s SubagentStop (agent_type "")', async () => {
    const { requests } = await runHook('SubagentStop', { agent_id: 'a1', agent_type: '', stop_hook_active: false, agent_transcript_path: '' });
    expect(requests).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('still reports a real subagent\'s SubagentStop', async () => {
    const { requests } = await runHook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '' });
    expect(requests.map((r) => r.params.kind)).toEqual(['agent.subagent_stop']);
  });
});
