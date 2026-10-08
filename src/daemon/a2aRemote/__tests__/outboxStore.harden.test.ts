// The outbox re-hardens its file after every write (on Windows that rewrites
// the file and holds it). Shutdown must be able to wait for it, or the folder
// stays locked after stop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let release: (() => void) | null = null;
const calls: string[] = [];
vi.mock('../../../shared/security', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/security')>()),
  reHardenTokenFile: vi.fn((p: string) => {
    calls.push(p);
    return new Promise<void>((r) => { release = r; });
  }),
}));

import { OutboxStore } from '../outboxStore';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  calls.length = 0;
  release = null;
});

const env = (n: number) => ({
  protocol: 1, linkId: '11111111-1111-4111-8111-111111111111', linkVersion: 2, messageId: `m${n}`, kind: 'task' as const, text: 'x', sentAt: new Date().toISOString(),
});

describe('OutboxStore re-harden', () => {
  it('idle() waits for the running re-harden; writes meanwhile ask for one more run, never a parallel one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbox-harden-'));
    dirs.push(dir);
    const outbox = new OutboxStore({ dir });
    outbox.enqueue('22222222-2222-4222-8222-222222222222', env(1));
    outbox.enqueue('22222222-2222-4222-8222-222222222222', env(2));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    let idle = false;
    const done = outbox.idle().then(() => { idle = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    release!();
    await vi.waitFor(() => expect(calls).toHaveLength(2)); // the second write's run
    expect(idle).toBe(false);
    release!();
    await done;
    expect(idle).toBe(true);
  });
});
