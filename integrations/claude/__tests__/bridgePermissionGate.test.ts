/**
 * #783 — the permission gate's headless guard.
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
 * and assert on the JSON it writes to stdout, so the guard cannot silently
 * regress to something that is false in both modes.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');

/** Run the bridge in gate mode and return the parsed PreToolUse decision. */
function runGate(env: Record<string, string | undefined>): {
  permissionDecision?: string;
  permissionDecisionReason?: string;
} {
  const stdout = execFileSync(
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
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
  const parsed = JSON.parse(line) as { hookSpecificOutput?: Record<string, string> };
  return parsed.hookSpecificOutput ?? {};
}

describe('permission gate — headless guard', () => {
  it('defers when the entrypoint is headless (claude -p reports sdk-cli)', () => {
    const out = runGate({ WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDECODE: '1' });
    expect(out.permissionDecision).toBe('ask');
    expect(out.permissionDecisionReason).toContain('headless');
  });

  it('defers when there is no entrypoint at all (CI, bare invocation)', () => {
    const out = runGate({ WMUX_PTY_ID: 'pty-1' });
    expect(out.permissionDecision).toBe('ask');
  });

  it('defers outside a wmux pane even for an interactive entrypoint', () => {
    const out = runGate({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' });
    expect(out.permissionDecision).toBe('ask');
  });

  it('honours WMUX_GATE=0 before anything else', () => {
    const out = runGate({ WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'cli', WMUX_GATE: '0' });
    expect(out.permissionDecision).toBe('ask');
    expect(out.permissionDecisionReason).toContain('WMUX_GATE=0');
  });

  it('does NOT short-circuit an interactive pane — it reaches the daemon path', () => {
    // The guard must let this through. What happens AFTER it (reaching a
    // daemon, or failing open when none is listening) depends on the machine,
    // so this asserts only on the guard's own signature: an interactive pane
    // is never refused with the headless reason. If the guard ever regresses
    // to a tty check — false in an interactive pane too — this fails.
    const out = runGate({ WMUX_PTY_ID: 'pty-1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' });
    expect(out.permissionDecisionReason ?? '').not.toContain('headless');
  });
});
