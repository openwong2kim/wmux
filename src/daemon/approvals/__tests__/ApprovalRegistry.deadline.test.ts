import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalRegistry } from '../ApprovalRegistry';
import { GateBroker } from '../GateBroker';

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

/** Let the registry's mutation chain drain. */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * `deadlineAt` (wave 2) exists so a surface can render an honest countdown.
 * A gate has a real timer behind it; a screen-backed question does not, and
 * inventing one for it would put a clock on a prompt that never expires.
 */
describe('deadlineAt', () => {
  it('carries the deadline the BROKER armed, not createdAt + the cap', async () => {
    const created = 1_000_000;
    const registry = makeRegistry(created);

    // The id comes back synchronously; the record itself lands when the
    // registry's mutation chain drains.
    const id = registry.noteGateAwaiting({ sessionId: 'pty-1', agent: 'claude', toolName: 'Bash' });

    // The broker arms its timer LATER than the record's birth, and for the
    // BRIDGE's own remaining budget when that is shorter than the cap. Both
    // differences are why the registry may not compute this itself.
    const armedAt = created + 400;
    let stamped: Promise<void> = Promise.resolve();
    const broker = new GateBroker({
      now: () => armedAt,
      deadlineMs: 120_000,
      noteDeadline: (gateId, deadlineAt) => {
        stamped = registry.noteGateDeadline(gateId, deadlineAt);
      },
    });
    broker.awaitVerdict(id, 'pty-1', 30_000);
    await stamped;

    const gate = registry.list().pending.find((r) => r.kind === 'awaiting_permission');
    expect(gate?.createdAt).toBe(created);
    expect(gate?.deadlineAt).toBe(armedAt + 30_000);
    broker.cancelAll('test-teardown');
  });

  it('leaves a gate no broker ever armed without a countdown', async () => {
    const registry = makeRegistry(1_000_000);

    registry.noteGateAwaiting({ sessionId: 'pty-3', agent: 'claude', toolName: 'Bash' });
    await drain();

    const gate = registry.list().pending.find((r) => r.kind === 'awaiting_permission');
    expect(gate).toBeDefined();
    expect(gate?.deadlineAt).toBeUndefined();
  });

  it('leaves a screen-backed question without one', async () => {
    const registry = makeRegistry(1_000_000);

    await registry.noteHookAwaitingInput({ sessionId: 'pty-2', agent: 'claude' });

    const question = registry.list().pending.find((r) => r.kind === 'awaiting_input');
    expect(question).toBeDefined();
    expect(question?.deadlineAt).toBeUndefined();
  });
});
