import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
// The bridge is plain .mjs (Codex spawns it directly); it exports the pure
// envelope builder so this test can validate the shape without a live codex-cli.
import { buildCodexHookEnvelope, shouldTryNextTarget } from '../bin/wmux-codex-hooks-bridge.mjs';
import { isAgentSignal } from '../../shared/signal-types';

// The payloads below are the ones codex-cli 0.151.0 actually sends, captured
// live on 2026-08-31 against a stub Responses endpoint. Notably: the envelope
// is Claude Code's verbatim, `Stop` carries a `turn_id` and `SessionEnd` does
// not, and three of the events carry raw content.
const STOP_PAYLOAD = {
  session_id: '01a0582a-52b6-7a50-aaba-07e35bd05aba',
  turn_id: '01a0582a-5333-7050-89d8-9a02a7993faa',
  transcript_path: 'C:\\codex\\sessions\\rollout-01a0582a.jsonl',
  cwd: 'D:\\work\\proj',
  hook_event_name: 'Stop',
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  stop_hook_active: false,
  last_assistant_message: 'here is the answer, at length',
};
const SESSION_START_PAYLOAD = {
  session_id: '01a0582a-52b6-7a50-aaba-07e35bd05aba',
  transcript_path: 'C:\\codex\\sessions\\rollout-01a0582a.jsonl',
  cwd: 'D:\\work\\proj',
  hook_event_name: 'SessionStart',
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  source: 'startup',
};
const PROMPT_PAYLOAD = {
  session_id: '01a0582a-52b6-7a50-aaba-07e35bd05aba',
  turn_id: '01a0582a-5333-7050-89d8-9a02a7993faa',
  cwd: 'D:\\work\\proj',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'the user typed this',
};
// Codex normalizes tool names into Claude Code's vocabulary — a shell call
// arrives as `tool_name: "Bash"`. Measured, and deliberately unmapped.
const PRE_TOOL_USE_PAYLOAD = {
  session_id: '01a0582a-52b6-7a50-aaba-07e35bd05aba',
  turn_id: '01a0582a-5333-7050-89d8-9a02a7993faa',
  cwd: 'D:\\work\\proj',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /secret' },
  tool_use_id: 'call_1',
};

const baseEnv = {
  WMUX_PTY_ID: 'pty-123',
  WMUX_WORKSPACE_ID: 'ws-abc',
  WMUX_SURFACE_ID: 'surf-9',
} as NodeJS.ProcessEnv;

describe('buildCodexHookEnvelope', () => {
  it('maps Stop to a canonical agent.stop envelope', () => {
    expect(buildCodexHookEnvelope(STOP_PAYLOAD, { env: baseEnv, now: 42 })).toEqual({
      kind: 'agent.stop',
      agent: 'codex',
      agentSessionId: '01a0582a-52b6-7a50-aaba-07e35bd05aba',
      ptyId: 'pty-123',
      workspaceId: 'ws-abc',
      surfaceId: 'surf-9',
      cwd: 'D:\\work\\proj',
      payload: {
        turn_id: '01a0582a-5333-7050-89d8-9a02a7993faa',
        transcript_path: 'C:\\codex\\sessions\\rollout-01a0582a.jsonl',
      },
      ts: 42,
    });
  });

  it('maps SessionStart to agent.session_start and keeps the resume marker', () => {
    const envelope = buildCodexHookEnvelope(SESSION_START_PAYLOAD, { env: baseEnv, now: 1 });
    expect(envelope?.kind).toBe('agent.session_start');
    expect(envelope?.payload).toMatchObject({ source: 'startup' });
  });

  // `source` has NO CONSUMER in src/ today — nothing reads
  // signal.payload.source. These two cases pin it as a future candidate, not
  // as a working feature: they assert the bridge carries it faithfully, and
  // claim nothing about a resumed pane being identified downstream, because
  // today it is not.
  it('carries the resume marker faithfully, though nothing reads it yet', () => {
    const envelope = buildCodexHookEnvelope(
      { ...SESSION_START_PAYLOAD, source: 'resume' },
      { env: baseEnv, now: 1 },
    );
    expect(envelope?.agentSessionId).toBe(SESSION_START_PAYLOAD.session_id);
    expect(envelope?.payload).toMatchObject({ source: 'resume' });
  });

  // `source` is meaningful only on SessionStart. Carrying it on a turn boundary
  // would invent a field Codex never sends there.
  it('does not carry source on turn-scoped events', () => {
    const envelope = buildCodexHookEnvelope(
      { ...STOP_PAYLOAD, source: 'startup' },
      { env: baseEnv, now: 1 },
    );
    expect(envelope?.payload).not.toHaveProperty('source');
  });

  it('maps UserPromptSubmit to agent.user_prompt_submit', () => {
    expect(buildCodexHookEnvelope(PROMPT_PAYLOAD, { env: baseEnv, now: 1 })?.kind)
      .toBe('agent.user_prompt_submit');
  });

  it('produces an envelope the wmux daemon accepts', () => {
    for (const payload of [STOP_PAYLOAD, SESSION_START_PAYLOAD, PROMPT_PAYLOAD]) {
      expect(isAgentSignal(buildCodexHookEnvelope(payload, { env: baseEnv, now: 1 }))).toBe(true);
    }
  });

  // The privacy contract. Codex hands us the user's whole prompt, the model's
  // whole reply and whole tool inputs; wmux's bridges are metadata-only, so
  // none of it may survive into anything we send. Asserted on the SERIALIZED
  // envelope, not field-by-field, so a future field that happens to carry
  // content fails this too.
  it('never carries the user prompt, the assistant reply or a tool input', () => {
    const stop = JSON.stringify(buildCodexHookEnvelope(STOP_PAYLOAD, { env: baseEnv, now: 1 }));
    expect(stop).not.toContain('here is the answer');
    expect(stop).not.toContain('last_assistant_message');

    const prompt = JSON.stringify(buildCodexHookEnvelope(PROMPT_PAYLOAD, { env: baseEnv, now: 1 }));
    expect(prompt).not.toContain('the user typed this');
    // The KEY, not the substring: `agent.user_prompt_submit` legitimately
    // contains "prompt", so a bare toContain would fail on the kind itself.
    expect(prompt).not.toContain('"prompt"');

    const tool = JSON.stringify(buildCodexHookEnvelope(PRE_TOOL_USE_PAYLOAD, { env: baseEnv, now: 1 }));
    expect(tool).toBe('null');
  });

  // Codex DOES supply a session id, unlike Kiro — but a session id is not a
  // pane: two panes can hold two sessions in the same cwd. WMUX_PTY_ID stays
  // the only thing that attributes a signal to a pane, and with none, dropping
  // beats guessing.
  it('drops the signal when the pane cannot be identified', () => {
    expect(buildCodexHookEnvelope(STOP_PAYLOAD, { env: {}, now: 1 })).toBeNull();
    expect(buildCodexHookEnvelope(STOP_PAYLOAD, { env: { WMUX_PTY_ID: '' }, now: 1 })).toBeNull();
  });

  // Every one of these is a real member of Codex's HookEventName enum. Three
  // were measured firing (PreToolUse, SessionEnd) or are documented as
  // unmeasured (PermissionRequest, the rest) — none is mapped, each for a
  // reason recorded in the bridge's EVENT_TO_KIND comment. Pinning them keeps
  // a later "while we're here" mapping from landing unnoticed.
  it('ignores events wmux has no faithful mapping for', () => {
    expect(buildCodexHookEnvelope(PRE_TOOL_USE_PAYLOAD, { env: baseEnv, now: 1 })).toBeNull();
    for (const event of [
      'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
      'SessionEnd', 'SubagentStart', 'SubagentStop', 'Interrupt', 'SomethingNew',
    ]) {
      expect(
        buildCodexHookEnvelope({ hook_event_name: event, cwd: '/p' }, { env: baseEnv, now: 1 }),
        event,
      ).toBeNull();
    }
  });

  // Lowercase is Kiro's spelling, not Codex's. A bridge that accepted both
  // would quietly paper over a config pointed at the wrong agent.
  it('does not accept Kiro-cased event names', () => {
    for (const event of ['stop', 'sessionStart', 'userPromptSubmit']) {
      expect(
        buildCodexHookEnvelope({ hook_event_name: event, cwd: '/p' }, { env: baseEnv, now: 1 }),
        event,
      ).toBeNull();
    }
  });

  it('survives payloads that are not the shape Codex documents', () => {
    for (const bad of [null, undefined, 'a string', 42, [], {}, { hook_event_name: 5 }]) {
      expect(buildCodexHookEnvelope(bad, { env: baseEnv, now: 1 })).toBeNull();
    }
  });

  // A session id is what makes the resume binding possible, but a Stop without
  // one is still a real turn boundary and must not be thrown away.
  it('still reports the turn boundary when the session id is missing', () => {
    const noSession: Record<string, unknown> = { ...STOP_PAYLOAD };
    delete noSession.session_id;
    const envelope = buildCodexHookEnvelope(noSession, { env: baseEnv, now: 1 });
    expect(envelope?.kind).toBe('agent.stop');
    expect(envelope).not.toHaveProperty('agentSessionId');
  });

  it('falls back to the process cwd when the payload omits one', () => {
    const envelope = buildCodexHookEnvelope({ hook_event_name: 'Stop' }, { env: baseEnv, now: 1 });
    expect(envelope?.cwd).toBe(process.cwd());
  });

  it('omits workspace and surface ids rather than emitting empty ones', () => {
    const envelope = buildCodexHookEnvelope(STOP_PAYLOAD, { env: { WMUX_PTY_ID: 'p1' }, now: 1 });
    expect(envelope).not.toHaveProperty('workspaceId');
    expect(envelope).not.toHaveProperty('surfaceId');
  });

  // An event name that resolves through Object.prototype used to sail past the
  // `!kind` guard in the Kiro bridge and produce an envelope whose kind was a
  // function or `{}`, which then went to the daemon instead of being dropped.
  it('drops event names that only exist on the prototype chain', () => {
    for (const event of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(
        buildCodexHookEnvelope({ hook_event_name: event, cwd: 'C:/x' }, { env: { WMUX_PTY_ID: 'p1' }, now: 1 }),
        event,
      ).toBeNull();
    }
  });
});

describe('shouldTryNextTarget', () => {
  it('stops on an answered call', () => {
    expect(shouldTryNextTarget({ ok: true }, 'agent.stop')).toBe(false);
  });

  it('stops on an ambiguous write for a kind that is not idempotent', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false })).toBe(false);
    expect(
      shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false }, 'agent.activity'),
    ).toBe(false);
  });

  // agent.user_prompt_submit is deliberately NOT idempotent here: the deck's
  // brain-pty lane claims it against a "one turn at a time" contract, where a
  // duplicate is not obviously free the way a repeated turn boundary is.
  it('stops on an ambiguous write for agent.user_prompt_submit', () => {
    expect(
      shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false }, 'agent.user_prompt_submit'),
    ).toBe(false);
  });

  it('keeps walking on an ambiguous write for an idempotent kind', () => {
    for (const kind of ['agent.stop', 'agent.session_start']) {
      expect(
        shouldTryNextTarget({ ok: false, error: 'timeout', retryable: false }, kind),
        kind,
      ).toBe(true);
    }
  });

  it('advances on a connect failure that never wrote', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'connect-error', retryable: true })).toBe(true);
  });

  it('advances on an explicit refusal from an older endpoint', () => {
    expect(shouldTryNextTarget({ ok: false, error: 'Unknown method' })).toBe(true);
  });
});

// #1111 lockstep, asserted locally.
//
// The canonical guard is src/main/mcp/__tests__/hookBridge.lockstep.test.ts,
// which parses every bridge source against the enforcer's own constants. It
// does not exist on this branch — #1111 is still in flight — and this bridge
// still has to be added to its BRIDGES list when the two land together.
//
// Until then these two assertions stand in for it, deliberately duplicating
// its logic rather than trusting the follow-up to remember: without the
// clientName the enforcer refuses this bridge's main-pipe `hooks.signal` as
// identity-status:legacy, and turn-state reporting degrades silently — which
// is the exact failure mode #1107 exists to remove.
describe('hook-bridge lane lockstep (#1111)', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'bin', 'wmux-codex-hooks-bridge.mjs'),
    'utf8',
  );

  it('declares the recognised clientName and puts it on the envelope', () => {
    // The literal the lockstep test greps for. Spelled out here rather than
    // imported: src/shared/rpc.ts is not reachable from a standalone bridge,
    // and a drifting copy is precisely what both tests exist to catch.
    expect(SRC).toContain("'wmux-hook-bridge'");
    expect(/clientName:/.test(SRC)).toBe(true);
  });

  it('calls no main-pipe method outside the one-method lane', () => {
    const found = new Set(
      [...SRC.matchAll(/method:\s*'([a-zA-Z][A-Za-z0-9]*\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]),
    );
    // `daemon.*` goes to the DaemonPipeServer, which has no enforcer.
    const mainPipe = [...found].filter((m) => !m.startsWith('daemon.'));
    expect(mainPipe).toEqual(['hooks.signal']);
  });
});
