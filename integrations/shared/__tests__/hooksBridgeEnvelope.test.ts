import { describe, it, expect } from 'vitest';
// The shared Claude-compatible bridge is plain .mjs; it exports the pure
// normaliser so the envelope can be checked without a live CLI.
import {
  buildHookEnvelope,
  flavourFor,
  resolveEventName,
  FLAVOURS,
} from '../bin/wmux-hooks-bridge.mjs';
import { isAgentSignal } from '../signal-types';

const env = {
  WMUX_PTY_ID: 'pty-7',
  WMUX_WORKSPACE_ID: 'ws-1',
} as NodeJS.ProcessEnv;

// Payload shapes as GitHub Copilot CLI documents them for its PascalCase
// (Claude-compatible) events, including the content fields that must never
// leave the bridge.
const COPILOT_STOP = {
  session_id: 'c0ffee00-1111-2222-3333-444455556666',
  timestamp: '2026-10-08T00:00:00Z',
  cwd: 'C:\\work\\repo',
  transcript_path: 'C:\\Users\\me\\.copilot\\session-state\\x.jsonl',
  stop_reason: 'end_turn',
  stop_hook_active: false,
};

describe('buildHookEnvelope — copilot flavour', () => {
  it('maps Stop to agent.stop with the session id for resume', () => {
    expect(buildHookEnvelope('copilot', COPILOT_STOP, { env, now: 5, event: 'Stop' })).toEqual({
      kind: 'agent.stop',
      agent: 'copilot',
      agentSessionId: 'c0ffee00-1111-2222-3333-444455556666',
      ptyId: 'pty-7',
      workspaceId: 'ws-1',
      cwd: 'C:\\work\\repo',
      payload: {},
      ts: 5,
    });
  });

  it('produces envelopes the daemon accepts, for every mapped event', () => {
    for (const event of Object.keys(FLAVOURS.copilot.events)) {
      const envelope = buildHookEnvelope('copilot', { session_id: 's1', cwd: '/r' }, { env, now: 1, event });
      expect(isAgentSignal(envelope), event).toBe(true);
    }
  });

  it('maps the turn and approval events to the documented states', () => {
    const kind = (event: string) => buildHookEnvelope('copilot', { cwd: '/r' }, { env, now: 1, event })?.kind;
    expect(kind('SessionStart')).toBe('agent.session_start');
    expect(kind('UserPromptSubmit')).toBe('agent.user_prompt_submit');
    expect(kind('PermissionRequest')).toBe('agent.awaiting_input');
  });

  // The installer passes the event in argv because the docs omit
  // hook_event_name from some PascalCase payloads (Stop among them).
  it('takes the event name from argv when the payload has none', () => {
    expect(resolveEventName({ cwd: '/r' }, 'Stop')).toBe('Stop');
    expect(buildHookEnvelope('copilot', { cwd: '/r' }, { env, now: 1 })).toBeNull();
    expect(buildHookEnvelope('copilot', { cwd: '/r', hook_event_name: 'Stop' }, { env, now: 1 })?.kind).toBe('agent.stop');
  });

  it('reads the camelCase session id the docs show for PermissionRequest', () => {
    const envelope = buildHookEnvelope('copilot', { sessionId: 'abc-1', cwd: '/r', toolName: 'bash' }, { env, now: 1, event: 'PermissionRequest' });
    expect(envelope?.agentSessionId).toBe('abc-1');
  });

  it('forwards only a session start source the daemon understands', () => {
    const start = (source: unknown) =>
      buildHookEnvelope('copilot', { cwd: '/r', source }, { env, now: 1, event: 'SessionStart' })?.payload;
    expect(start('startup')).toEqual({ source: 'startup' });
    expect(start('resume')).toEqual({ source: 'resume' });
    // Copilot's own "new" is not translated into a guess.
    expect(start('new')).toEqual({});
    // A stop never carries one.
    expect(buildHookEnvelope('copilot', { cwd: '/r', source: 'startup' }, { env, now: 1, event: 'Stop' })?.payload).toEqual({});
  });

  it('never registers per-tool-call or unmeasured events', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'ErrorOccurred', 'SessionEnd', 'Notification']) {
      expect(buildHookEnvelope('copilot', { cwd: '/r' }, { env, now: 1, event }), event).toBeNull();
    }
  });
});

describe('buildHookEnvelope — gemini flavour', () => {
  it('maps BeforeAgent / AfterAgent to the turn start and end', () => {
    const kind = (event: string) =>
      buildHookEnvelope('gemini', { hook_event_name: event, session_id: 'g1', cwd: '/g' }, { env, now: 1 })?.kind;
    expect(kind('BeforeAgent')).toBe('agent.user_prompt_submit');
    expect(kind('AfterAgent')).toBe('agent.stop');
    expect(kind('SessionStart')).toBe('agent.session_start');
  });

  // Gemini reports a permission prompt as a Notification; other notification
  // types are not a wait on a human and must not become one.
  it('treats only a ToolPermission notification as awaiting input', () => {
    const notify = (notification_type: unknown) => buildHookEnvelope(
      'gemini',
      { hook_event_name: 'Notification', notification_type, message: 'm', cwd: '/g' },
      { env, now: 1 },
    );
    expect(notify('ToolPermission')?.kind).toBe('agent.awaiting_input');
    expect(notify('Other')).toBeNull();
    expect(notify(undefined)).toBeNull();
  });

  it('never maps BeforeTool, AfterTool or the model hooks', () => {
    for (const event of ['BeforeTool', 'AfterTool', 'BeforeModel', 'AfterModel', 'BeforeToolSelection', 'PreCompress']) {
      expect(buildHookEnvelope('gemini', { hook_event_name: event, cwd: '/g' }, { env, now: 1 }), event).toBeNull();
    }
  });
});

describe('buildHookEnvelope — rules every flavour inherits', () => {
  const flavours = Object.keys(FLAVOURS);
  const firstEvent = (flavour: string) => Object.keys(FLAVOURS[flavour as keyof typeof FLAVOURS].events)[0];

  // Payloads carry the prompt, the reply and tool inputs. Asserted on the
  // serialized envelope so any future field that leaks content fails too.
  it.each(flavours)('%s is metadata-only', (flavour) => {
    const event = firstEvent(flavour);
    const envelope = buildHookEnvelope(flavour, {
      hook_event_name: event,
      session_id: 's-1',
      cwd: '/p',
      prompt: 'SECRET-PROMPT',
      prompt_response: 'SECRET-REPLY',
      last_assistant_message: 'SECRET-REPLY',
      assistant_response: 'SECRET-REPLY',
      tool_input: { command: 'SECRET-TOOL' },
      transcript_path: '/home/me/SECRET.jsonl',
    }, { env, now: 1 });
    expect(envelope).not.toBeNull();
    const serialized = JSON.stringify(envelope);
    for (const secret of ['SECRET-PROMPT', 'SECRET-REPLY', 'SECRET-TOOL', 'SECRET.jsonl']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each(flavours)('%s drops a signal it cannot pin to a pane', (flavour) => {
    const event = firstEvent(flavour);
    expect(buildHookEnvelope(flavour, { hook_event_name: event, cwd: '/p' }, { env: {}, now: 1 })).toBeNull();
    expect(buildHookEnvelope(flavour, { hook_event_name: event, cwd: '/p' }, { env: { WMUX_PTY_ID: '' }, now: 1 })).toBeNull();
  });

  it.each(flavours)('%s drops event names that only exist on the prototype chain', (flavour) => {
    for (const event of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(buildHookEnvelope(flavour, { hook_event_name: event, cwd: '/p' }, { env, now: 1 }), event).toBeNull();
      expect(buildHookEnvelope(flavour, { cwd: '/p' }, { env, now: 1, event }), event).toBeNull();
    }
  });

  it('refuses unknown and prototype-chain flavours', () => {
    for (const flavour of ['claude', 'codex', 'constructor', '__proto__', '', undefined]) {
      expect(flavourFor(flavour), String(flavour)).toBeUndefined();
      expect(buildHookEnvelope(flavour, { hook_event_name: 'Stop', cwd: '/p' }, { env, now: 1, event: 'Stop' })).toBeNull();
    }
  });

  it('survives payloads that are not objects', () => {
    for (const bad of [null, undefined, 'a string', 42, []]) {
      expect(buildHookEnvelope('copilot', bad, { env, now: 1, event: 'Stop' })).toBeNull();
    }
  });

  // The id is persisted as a resume binding; anything that is not id-shaped
  // (a path, a sentence) is not carried.
  it('carries only an id-shaped session id', () => {
    const sid = (session_id: unknown) =>
      buildHookEnvelope('copilot', { session_id, cwd: '/p' }, { env, now: 1, event: 'Stop' })?.agentSessionId;
    expect(sid('3f2a-xyz_9.1')).toBe('3f2a-xyz_9.1');
    expect(sid('../../etc/passwd')).toBeUndefined();
    expect(sid('has space')).toBeUndefined();
    expect(sid('x'.repeat(200))).toBeUndefined();
    expect(sid(42)).toBeUndefined();
  });

  it('falls back to the process cwd when the payload omits one', () => {
    expect(buildHookEnvelope('copilot', {}, { env, now: 1, event: 'Stop' })?.cwd).toBe(process.cwd());
  });
});
