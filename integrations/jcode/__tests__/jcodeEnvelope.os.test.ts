import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The entry point is plain .mjs (jcode spawns it through node); it exports the
// env → payload mapping and the envelope builder so they can be checked
// without a live jcode.
import { buildJcodeEnvelope, jcodePayloadFromEnv } from '../bin/wmux-jcode-bridge.mjs';
import { isAgentSignal } from '../../shared/signal-types';

// jcode session ids are its own shape (docs/HOOKS.md, #3067), not UUIDs.
const SESSION = 'session_calf_1793795316908_9e051dbeac3a2b8b';

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    WMUX_PTY_ID: 'pty-123',
    WMUX_WORKSPACE_ID: 'ws-abc',
    JCODE_HOOK_SESSION_ID: SESSION,
    JCODE_HOOK_CWD: '/work/proj',
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe('buildJcodeEnvelope', () => {
  it.each([
    ['session_start', 'agent.session_start'],
    ['turn_start', 'agent.user_prompt_submit'],
    ['turn_end', 'agent.stop'],
    ['session_end', 'agent.session_end'],
  ])('maps %s to %s, an envelope the daemon accepts', (event, kind) => {
    const envelope = buildJcodeEnvelope(env({ JCODE_HOOK_EVENT: event, JCODE_HOOK_SOURCE: 'create' }), { now: 7 });
    expect(envelope).toMatchObject({ kind, agent: 'jcode', agentSessionId: SESSION, ptyId: 'pty-123', cwd: '/work/proj', ts: 7 });
    expect(isAgentSignal(envelope)).toBe(true);
  });

  it('translates the session_start source: create → startup, resume → resume; attach sends nothing', () => {
    const start = (s?: string) => buildJcodeEnvelope(env({ JCODE_HOOK_EVENT: 'session_start', ...(s ? { JCODE_HOOK_SOURCE: s } : {}) }));
    expect(start('create')?.payload).toEqual({ source: 'startup' });
    expect(start('resume')?.payload).toEqual({ source: 'resume' });
    // A session_start clears the pane's state as a fresh session; an attach is not one.
    expect(start('attach')).toBeNull();
    expect(start()).toBeNull();
    // turn_start's source (chat / run) is not a session start.
    expect(jcodePayloadFromEnv(env({ JCODE_HOOK_EVENT: 'turn_start', JCODE_HOOK_SOURCE: 'resume' }))).not.toHaveProperty('source');
  });

  it('ignores per-tool events and drops a payload without WMUX_PTY_ID', () => {
    expect(buildJcodeEnvelope(env({ JCODE_HOOK_EVENT: 'post_tool' }))).toBeNull();
    expect(buildJcodeEnvelope(env({ JCODE_HOOK_EVENT: 'turn_end', WMUX_PTY_ID: '' }))).toBeNull();
  });

  it('never carries the reply, the tool input or the mirrored payload', () => {
    const serialized = JSON.stringify(buildJcodeEnvelope(env({
      JCODE_HOOK_EVENT: 'turn_end',
      JCODE_HOOK_LAST_ASSISTANT_TEXT: 'here is the answer',
      JCODE_HOOK_PAYLOAD: '{"prompt":"the user typed this"}',
      JCODE_HOOK_TOOL_INPUT: '{"command":"secret"}',
    })));
    expect(serialized).not.toContain('here is the answer');
    expect(serialized).not.toContain('the user typed this');
    expect(serialized).not.toContain('secret');
  });
});

describe('wmux-jcode-bridge as a process', () => {
  // jcode passes nothing on stdin. A hook that waited on an inherited,
  // never-closed stdin would sit until the bridge's 4s watchdog on every event.
  it('exits 0 promptly, silently, with stdin left open', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-jcode-'));
    try {
      const script = path.join(__dirname, '..', 'bin', 'wmux-jcode-bridge.mjs');
      const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WMUX_PTY_ID: 'pty-1', JCODE_HOOK_EVENT: 'turn_end', JCODE_HOOK_SESSION_ID: SESSION };
      const started = Date.now();
      const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [script], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c) => { out += String(c); });
        child.on('exit', (c) => resolve({ code: c, stdout: out }));
      });
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(Date.now() - started).toBeLessThan(3000);
      // No wmux in the temp home: the bridge logged that, and nothing else.
      const log = fs.readFileSync(path.join(home, '.wmux', 'jcode-hooks.log'), 'utf8');
      expect(log).toContain('no-auth-token');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
