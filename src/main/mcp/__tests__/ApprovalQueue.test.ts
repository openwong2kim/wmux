import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApprovalQueue, type ApprovalPromptInfo } from '../ApprovalQueue';
import { PluginTrustStore } from '../PluginTrustStore';

let tmpDir = '';
let dbPath = '';
let store: PluginTrustStore;
let opened: ApprovalPromptInfo[] = [];

let nextPromptId = 1;
function mintId(): string {
  return `prompt-${nextPromptId++}`;
}

function makeQueue(): ApprovalQueue {
  opened = [];
  return new ApprovalQueue(store, {
    openPrompt: (info) => opened.push(info),
    mintPromptId: mintId,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-approval-test-'));
  dbPath = path.join(tmpDir, 'plugin-trust.json');
  store = new PluginTrustStore(dbPath);
  nextPromptId = 1;
  opened = [];
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('ApprovalQueue.requestApproval', () => {
  it('opens a prompt and resolves on approve', async () => {
    const queue = makeQueue();
    const p = queue.requestApproval({
      clientName: 'plugin-a',
      declaredCapabilities: ['pane.read'],
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].promptId).toBe('prompt-1');
    expect(opened[0].clientName).toBe('plugin-a');
    expect(opened[0].declaredCapabilities).toEqual(['pane.read']);

    await queue.resolvePrompt('prompt-1', true);
    const result = await p;
    expect(result.approved).toBe(true);
    expect(result.promptId).toBe('prompt-1');
    expect(result.identity?.status).toBe('trusted');
    expect(result.identity?.name).toBe('plugin-a');
  });

  it('persists denied status (spec §4.3)', async () => {
    const queue = makeQueue();
    const p = queue.requestApproval({
      clientName: 'plugin-b',
      declaredCapabilities: ['terminal.read'],
    });
    await queue.resolvePrompt('prompt-1', false);
    const result = await p;
    expect(result.approved).toBe(false);
    expect(result.identity?.status).toBe('denied');

    // Subsequent reads see the denied state on disk.
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    expect(onDisk.plugins['plugin-b'].status).toBe('denied');
  });

  it('dedupes concurrent requests with identical (clientName, capabilities)', async () => {
    const queue = makeQueue();
    const p1 = queue.requestApproval({
      clientName: 'plugin-c',
      declaredCapabilities: ['pane.read', 'meta.read'],
    });
    const p2 = queue.requestApproval({
      clientName: 'plugin-c',
      declaredCapabilities: ['pane.read', 'meta.read'],
    });
    const p3 = queue.requestApproval({
      clientName: 'plugin-c',
      // Same set in different order — still same dedupe key.
      declaredCapabilities: ['meta.read', 'pane.read'],
    });

    // Only one prompt opened despite three requestApproval calls.
    expect(opened).toHaveLength(1);
    expect(queue.inflightCount()).toBe(1);

    await queue.resolvePrompt('prompt-1', true);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(true);
    expect(r3.approved).toBe(true);
    expect(r1.promptId).toBe(r2.promptId);
    expect(r2.promptId).toBe(r3.promptId);
  });

  it('treats different capability sets as different prompts', async () => {
    const queue = makeQueue();
    queue.requestApproval({
      clientName: 'plugin-d',
      declaredCapabilities: ['pane.read'],
    });
    queue.requestApproval({
      clientName: 'plugin-d',
      // Different set → distinct prompt
      declaredCapabilities: ['pane.read', 'meta.write'],
    });
    expect(opened).toHaveLength(2);
    expect(queue.inflightCount()).toBe(2);
  });

  it('treats different plugin names as different prompts', async () => {
    const queue = makeQueue();
    queue.requestApproval({
      clientName: 'plugin-e',
      declaredCapabilities: ['pane.read'],
    });
    queue.requestApproval({
      clientName: 'plugin-f',
      declaredCapabilities: ['pane.read'],
    });
    expect(opened).toHaveLength(2);
  });

  it('survives an opener that throws', async () => {
    const queue = new ApprovalQueue(store, {
      openPrompt: () => {
        throw new Error('renderer dead');
      },
      mintPromptId: mintId,
    });
    const p = queue.requestApproval({
      clientName: 'plugin-g',
      declaredCapabilities: ['pane.read'],
    });
    // Promise must still be pending — the queue is still tracking it.
    expect(queue.inflightCount()).toBe(1);
    await queue.resolvePrompt('prompt-1', true);
    const result = await p;
    expect(result.approved).toBe(true);
  });

  it('keeps coalesced waiters whole when the trust-store write fails', async () => {
    // Point the store at an unwritable location to force setUserDecision throw.
    const badStore = new PluginTrustStore(
      path.join(tmpDir, 'no-such-dir', 'plugin-trust.json'),
    );
    // Try a write to ensure subsequent ones also fail (atomicWriteJSON throws
    // when the parent dir can't be created — but we mkdir via ensureWmuxHomeDir
    // which targets a fixed path. To force a failure deterministically, stub
    // setUserDecision.
    const stubbed = badStore as unknown as {
      setUserDecision: () => Promise<never>;
    };
    stubbed.setUserDecision = vi.fn(async () => {
      throw new Error('disk write failed');
    });

    const queue = new ApprovalQueue(badStore, {
      openPrompt: (info) => opened.push(info),
      mintPromptId: mintId,
    });
    const p = queue.requestApproval({
      clientName: 'plugin-h',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt('prompt-1', true);
    const result = await p;
    // Approved decision is communicated to the waiter; identity is
    // undefined because the persistence write failed.
    expect(result.approved).toBe(true);
    expect(result.identity).toBeUndefined();
  });
});

describe('ApprovalQueue.resolvePrompt', () => {
  it('is a no-op for unknown promptIds', async () => {
    const queue = makeQueue();
    await expect(queue.resolvePrompt('does-not-exist', true)).resolves.toBeUndefined();
  });

  it('is idempotent (second resolve does nothing)', async () => {
    const queue = makeQueue();
    const p = queue.requestApproval({
      clientName: 'plugin-i',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt('prompt-1', true);
    await queue.resolvePrompt('prompt-1', false); // second call — no-op
    const result = await p;
    expect(result.approved).toBe(true);
  });
});

describe('ApprovalQueue.cancelPrompt', () => {
  it('rejects all coalesced waiters with the cancellation reason', async () => {
    const queue = makeQueue();
    const p1 = queue.requestApproval({
      clientName: 'plugin-j',
      declaredCapabilities: ['pane.read'],
    });
    const p2 = queue.requestApproval({
      clientName: 'plugin-j',
      declaredCapabilities: ['pane.read'],
    });
    queue.cancelPrompt('prompt-1', 'plugin disconnected');
    await expect(p1).rejects.toThrow(/plugin disconnected/);
    await expect(p2).rejects.toThrow(/plugin disconnected/);
  });

  it('is a no-op for unknown promptIds', () => {
    const queue = makeQueue();
    expect(() => queue.cancelPrompt('does-not-exist', 'whatever')).not.toThrow();
  });
});
