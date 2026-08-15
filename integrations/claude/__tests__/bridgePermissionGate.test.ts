/**
 * #783 — the permission gate's headless guard.
 * #898 — and the shape of a "no opinion" answer.
 *
 * The guard decides whether a tool call waits for a remote answer or falls
 * straight through to Claude Code's local prompt. Getting it wrong is bad in
 * BOTH directions: too strict and `claude -p` / CI hang on the first gated
 * tool; too loose and the gate never fires at all, so the feature is dead
 * while looking installed.
 *
 * An earlier revision keyed on `process.stderr.isTTY`. Measured on a real
 * install, that is FALSE for an interactive pane too (Claude Code pipes the
 * hook's stdio), so the gate could never fire. The distinguisher that actually
 * separates the two is `CLAUDE_CODE_ENTRYPOINT`: `cli` interactive,
 * `sdk-cli` for `claude -p`. These tests run the REAL bridge as a subprocess
 * and assert on the bytes it writes to stdout, so the guard cannot silently
 * regress to something that is false in both modes.
 *
 * The fall-through paths used to answer `permissionDecision: 'ask'`, on the
 * belief that it meant "I have no opinion". It does not — it forces a prompt
 * and overrides the session's permission mode, so an installed plugin re-asked
 * for every Read in a `bypassPermissions` session and `WMUX_GATE=0` did not
 * turn it off. Measured on Claude Code 2.1.233 under
 * `--permission-mode bypassPermissions`, with the same probe hook on the same
 * wide matcher:
 *
 *   emits `ask`     -> permission_denials: [Read, Bash]
 *   emits nothing   -> permission_denials: []
 *
 * So these tests assert on STDOUT BEING EMPTY, not on a decision value. An
 * assertion like `toBe('ask')` is what let the bug ship green.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');

/** Run the bridge in gate mode and return its raw stdout. */
function runGate(env: Record<string, string | undefined>): string {
  return execFileSync(
    process.execPath,
    [BRIDGE_PATH, 'PreToolUse', '--permission-gate'],
    {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        // Point the bridge at a socket that does not exist, so a test that
        // DOES reach the daemon path fails open instead of hanging on a real
        // daemon that may be running on this machine.
        WMUX_SOCKET_PATH: '/nonexistent/wmux-test.sock',
        ...env,
      },
    },
  );
}

describe('permission gate — headless guard', () => {
  it('says nothing when the entrypoint is headless (claude -p reports sdk-cli)', () => {
    const out = runGate({ WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDECODE: '1' });
    expect(out).toBe('');
  });

  it('says nothing when there is no entrypoint at all (CI, bare invocation)', () => {
    expect(runGate({ WMUX_PTY_ID: 'pty-1' })).toBe('');
  });

  it('says nothing outside a wmux pane even for an interactive entrypoint', () => {
    expect(runGate({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' })).toBe('');
  });

  it('honours WMUX_GATE=0 before anything else, and truly silently', () => {
    // The escape hatch has to actually escape. When this emitted `ask`, turning
    // the gate off left the prompting in place — the reporter's "changing the
    // mode does not help" (#898).
    expect(runGate({
      WMUX_PTY_ID: 'pty-1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      WMUX_GATE: '0',
    })).toBe('');
  });

  it('never forces a prompt when the daemon is unreachable', () => {
    // An interactive pane DOES reach the daemon path; the socket above does not
    // exist, so this exercises the transport-failure fall-through. Failing open
    // means writing nothing — not asking.
    expect(runGate({
      WMUX_PTY_ID: 'pty-1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE: '1',
    })).toBe('');
  });

  it('never emits a bare `ask` on any fall-through path', () => {
    // Belt and braces across every guard combination: whatever changes, the
    // bridge may only ever write a real verdict.
    const combos: Array<Record<string, string | undefined>> = [
      { WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
      { WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'cli', WMUX_GATE: '0' },
      { CLAUDE_CODE_ENTRYPOINT: 'cli' },
      { WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
      { WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'vscode' },
    ];
    for (const env of combos) {
      expect(runGate(env)).not.toContain('"permissionDecision"');
    }
  });
});
