/**
 * Leftover background-work mining for Stop envelopes.
 *
 * The count must answer ONE question at Stop time: are background tasks the
 * agent started still running? Verified transcript shapes (live spike
 * 2026-08-15): a `run_in_background` Bash tool_use gets an IMMEDIATE
 * "Command running in background" tool_result (not a completion), and the
 * real settlement is a durable task-notification record —
 * `queue-operation` content or `attachment(queued_command).prompt` —
 * carrying <tool-use-id> and <status>completed|failed</status>.
 *
 * These tests run the REAL bridge function: the CLI entrypoint is stripped
 * (main() runs at module top level and would read stdin) and the miner
 * re-exported from a temp copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let count: (transcriptPath: string) => number;

function fixture(name: string, lines: unknown[]): string {
  const p = path.join(tmp, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function bgStart(id: string) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', run_in_background: true } },
      ],
    },
  };
}

function bgStartResult(id: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: id, type: 'tool_result', content: `Command running in background with ID: task1. Output is being written to: /tmp/x` },
      ],
    },
  };
}

function notificationRecord(id: string, status: 'completed' | 'failed') {
  const body = `<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;
  return { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-15T00:00:00.000Z', sessionId: 's1', content: body };
}

function notificationAttachment(id: string, status: 'completed' | 'failed') {
  const body = `<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;
  return { type: 'attachment', attachment: { type: 'queued_command', prompt: body, commandMode: 'task-notification', timestamp: '2026-08-15T00:00:00.000Z' }, timestamp: '2026-08-15T00:00:00.000Z' };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-lw-'));
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  // Strip the shebang — vite's transform (which intercepts even runtime
  // dynamic imports under vitest) rejects it with a SyntaxError on Windows.
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { countLeftoverBackgroundTasks };\n';
  const mod = path.join(tmp, 'bridge-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ countLeftoverBackgroundTasks: count } = await import(pathToFileURL(mod).href));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('countLeftoverBackgroundTasks', () => {
  it('in-flight task: start + immediate "running" result, no notification → 1', () => {
    const p = fixture('inflight.jsonl', [
      bgStart('call_a'),
      bgStartResult('call_a'),
    ]);
    expect(count(p)).toBe(1);
  });

  it('settled via queue-operation notification → 0', () => {
    const p = fixture('settled-queue.jsonl', [
      bgStart('call_a'),
      bgStartResult('call_a'),
      notificationRecord('call_a', 'completed'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('settles even with leading whitespace in the body and a non-whitelisted status (fail-open)', () => {
    // review-team catch: `startsWith` + a (completed|failed) whitelist would
    // miss a body carrying leading whitespace or a future terminal status
    // value — the task would then count as running FOREVER and permanently
    // suppress every later Stop alarm, the exact failure mode this miner
    // exists to avoid. Any <status> settles; a spurious settle at worst
    // fires one window-gated alarm.
    const body = '  \n<task-notification>\n<tool-use-id>call_w</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>killed</status>\n<summary>Background command finished</summary>\n</task-notification>';
    const p = fixture('settled-loose.jsonl', [
      bgStart('call_w'),
      bgStartResult('call_w'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-15T00:00:00.000Z', sessionId: 's1', content: body },
    ]);
    expect(count(p)).toBe(0);
  });

  it('settles when the notification carries NO <status> tag at all', () => {
    // The value whitelist was already loosened; requiring the TAG had the same
    // failure mode and was left in place. A task-notification whose status tag
    // is absent, renamed, or moved would never settle its id, so leftover
    // stayed above zero and every later Stop in that session was suppressed —
    // permanent silence, from a shape change we do not control. The ARRIVAL of
    // a notification for an id is the settlement; the status is diagnostic.
    const body = '<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>call_nostatus</tool-use-id>\n<summary>Background command finished</summary>\n</task-notification>';
    const p = fixture('settled-no-status.jsonl', [
      bgStart('call_nostatus'),
      bgStartResult('call_nostatus'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-15T00:00:00.000Z', sessionId: 's1', content: body },
    ]);
    expect(count(p)).toBe(0);
  });

  it('settled via the DURABLE attachment shape (queue already drained) → 0', () => {
    const p = fixture('settled-attachment.jsonl', [
      bgStart('call_a'),
      bgStartResult('call_a'),
      notificationAttachment('call_a', 'failed'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('a failed task also settles (it is not leftover work)', () => {
    const p = fixture('settled-failed.jsonl', [
      bgStart('call_a'),
      notificationRecord('call_a', 'failed'),
    ]);
    expect(count(p)).toBe(0);
  });

  it('two starts, one settled → 1', () => {
    const p = fixture('two.jsonl', [
      bgStart('call_a'),
      bgStart('call_b'),
      bgStartResult('call_a'),
      bgStartResult('call_b'),
      notificationRecord('call_a', 'completed'),
    ]);
    expect(count(p)).toBe(1);
  });

  it('a synchronously REJECTED background attempt is not leftover work (live-spike false positive)', () => {
    // Real shape observed 2026-08-15: the worktree-isolation hook refused the
    // command, so the tool_result is an error string — no task ever spawned,
    // no task-notification will ever arrive. Counting it would suppress every
    // later Stop alarm for the rest of the session.
    const p = fixture('rejected.jsonl', [
      bgStart('call_r'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { tool_use_id: 'call_r', type: 'tool_result', content: 'This session is isolated in the worktree /x, but this command is too complex to verify that it stays inside the worktree; break it into plain, separate commands' },
          ],
        },
      },
    ]);
    expect(count(p)).toBe(0);
  });

  it('foreground Bash tool_use is ignored entirely', () => {
    const p = fixture('foreground.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_f', name: 'Bash', input: { command: 'ls' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: 'call_f', type: 'tool_result', content: 'file1\nfile2' }] },
      },
    ]);
    expect(count(p)).toBe(0);
  });

  it('non-Bash background tools are ignored', () => {
    const p = fixture('other-tool.jsonl', [
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_t', name: 'Task', input: { prompt: 'x', run_in_background: true } }] },
      },
    ]);
    expect(count(p)).toBe(0);
  });

  it('fail-open: missing file → 0', () => {
    expect(count(path.join(tmp, 'does-not-exist.jsonl'))).toBe(0);
  });

  it('fail-open: malformed lines are skipped, not fatal', () => {
    const p = path.join(tmp, 'malformed.jsonl');
    writeFileSync(
      p,
      '{not json\n' + JSON.stringify(bgStart('call_a')) + '\n' + JSON.stringify(bgStartResult('call_a')) + '\n',
      'utf8',
    );
    expect(count(p)).toBe(1);
  });

  it('a background tool_use with NO tool_result is conservatively not counted', () => {
    // The immediate result is always written after the dispatch, so a
    // result-less start at Stop time means a tail-boundary anomaly — count
    // nothing rather than risk permanent suppression.
    const p = fixture('resultless.jsonl', [bgStart('call_x')]);
    expect(count(p)).toBe(0);
  });
});
