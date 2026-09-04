import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalRegistry } from '../ApprovalRegistry';
import { DEFAULT_GATE_DEADLINE_MS } from '../GateBroker';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-approval-deadline-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A frozen clock, so the deadline is an exact number and not a range. */
function makeRegistry(now: number): ApprovalRegistry {
  return new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => [],
    writeToSession: () => true,
    now: () => now,
  });
}

/**
 * `deadlineAt` (wave 2) exists so a surface can render an honest countdown.
 * A gate has a real timer behind it; a screen-backed question does not, and
 * inventing one for it would put a clock on a prompt that never expires.
 */
describe('deadlineAt', () => {
  it('stamps a permission gate with the broker deadline', async () => {
    const now = 1_000_000;
    const registry = makeRegistry(now);

    // The id comes back synchronously; the record itself lands when the
    // registry's mutation chain drains.
    registry.noteGateAwaiting({ sessionId: 'pty-1', agent: 'claude', toolName: 'Bash' });
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const gate = registry.list().pending.find((r) => r.kind === 'awaiting_permission');
    expect(gate?.deadlineAt).toBe(now + DEFAULT_GATE_DEADLINE_MS);
  });

  it('leaves a screen-backed question without one', async () => {
    const registry = makeRegistry(1_000_000);

    await registry.noteHookAwaitingInput({ sessionId: 'pty-2', agent: 'claude' });

    const question = registry.list().pending.find((r) => r.kind === 'awaiting_input');
    expect(question).toBeDefined();
    expect(question?.deadlineAt).toBeUndefined();
  });
});
