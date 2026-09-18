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
  it('opens a prompt and exposes promptId synchronously', () => {
    const queue = makeQueue();
    const handle = queue.requestApproval({
      clientName: 'plugin-a',
      declaredCapabilities: ['pane.read'],
    });
    // promptId available BEFORE the user clicks anything — this is what
    // RpcRouter threads into rejection.pendingApproval.
    expect(handle.promptId).toBe('prompt-1');
    expect(opened).toHaveLength(1);
    expect(opened[0].promptId).toBe('prompt-1');
    expect(opened[0].clientName).toBe('plugin-a');
    expect(opened[0].declaredCapabilities).toEqual(['pane.read']);
  });

  it('resolves with trusted status on approve', async () => {
    const queue = makeQueue();
    const handle = queue.requestApproval({
      clientName: 'plugin-a',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt(handle.promptId, true);
    const result = await handle.resolution;
    expect(result.approved).toBe(true);
    expect(result.promptId).toBe('prompt-1');
    expect(result.identity?.status).toBe('trusted');
    expect(result.identity?.name).toBe('plugin-a');
  });

  it('trusts the prompt snapshot if capabilities change before approval', async () => {
    const queue = makeQueue();
    await store.upsertDeclaration('plugin-race', ['pane.read']);
    const handle = queue.requestApproval({
      clientName: 'plugin-race',
      declaredCapabilities: ['pane.read'],
    });

    await store.upsertDeclaration('plugin-race', ['terminal.send']);
    await queue.resolvePrompt(handle.promptId, true);
    const result = await handle.resolution;

    expect(result.identity?.status).toBe('trusted');
    expect(result.identity?.declaredCapabilities).toEqual(['pane.read']);
    expect((await store.get('plugin-race'))?.declaredCapabilities).toEqual([
      'pane.read',
    ]);
  });

  it('persists denied status (spec §4.3)', async () => {
    const queue = makeQueue();
    const handle = queue.requestApproval({
      clientName: 'plugin-b',
      declaredCapabilities: ['terminal.read'],
    });
    await queue.resolvePrompt(handle.promptId, false);
    const result = await handle.resolution;
    expect(result.approved).toBe(false);
    expect(result.identity?.status).toBe('denied');

    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    expect(onDisk.plugins['plugin-b'].status).toBe('denied');
  });

  it('dedupes concurrent requests with identical (clientName, capabilities)', async () => {
    const queue = makeQueue();
    const h1 = queue.requestApproval({
      clientName: 'plugin-c',
      declaredCapabilities: ['pane.read', 'meta.read'],
    });
    const h2 = queue.requestApproval({
      clientName: 'plugin-c',
      declaredCapabilities: ['pane.read', 'meta.read'],
    });
    const h3 = queue.requestApproval({
      clientName: 'plugin-c',
      // Same set in different order — still same dedupe key.
      declaredCapabilities: ['meta.read', 'pane.read'],
    });

    // Only one prompt opened despite three requestApproval calls.
    expect(opened).toHaveLength(1);
    expect(queue.inflightCount()).toBe(1);
    // All three handles share the same promptId.
    expect(h1.promptId).toBe('prompt-1');
    expect(h2.promptId).toBe('prompt-1');
    expect(h3.promptId).toBe('prompt-1');

    await queue.resolvePrompt('prompt-1', true);
    const [r1, r2, r3] = await Promise.all([
      h1.resolution,
      h2.resolution,
      h3.resolution,
    ]);
    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(true);
    expect(r3.approved).toBe(true);
  });

  it('treats different capability sets as different prompts', () => {
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

  it('treats different plugin names as different prompts', () => {
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
    const handle = queue.requestApproval({
      clientName: 'plugin-g',
      declaredCapabilities: ['pane.read'],
    });
    expect(handle.promptId).toBe('prompt-1');
    expect(queue.inflightCount()).toBe(1);
    await queue.resolvePrompt(handle.promptId, true);
    const result = await handle.resolution;
    expect(result.approved).toBe(true);
  });

  it('keeps coalesced waiters whole when the trust-store write fails', async () => {
    const badStore = new PluginTrustStore(
      path.join(tmpDir, 'no-such-dir', 'plugin-trust.json'),
    );
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
    const handle = queue.requestApproval({
      clientName: 'plugin-h',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt(handle.promptId, true);
    const result = await handle.resolution;
    expect(result.approved).toBe(true);
    expect(result.identity).toBeUndefined();
  });
});

describe('ApprovalQueue.resolvePrompt', () => {
  it('is a no-op for unknown promptIds', async () => {
    const queue = makeQueue();
    await expect(
      queue.resolvePrompt('does-not-exist', true),
    ).resolves.toBeUndefined();
  });

  it('is idempotent (second resolve does nothing)', async () => {
    const queue = makeQueue();
    const handle = queue.requestApproval({
      clientName: 'plugin-i',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt(handle.promptId, true);
    await queue.resolvePrompt(handle.promptId, false); // second call — no-op
    const result = await handle.resolution;
    expect(result.approved).toBe(true);
  });
});

describe('ApprovalQueue.cancelPrompt', () => {
  it('rejects all coalesced waiters with the cancellation reason', async () => {
    const queue = makeQueue();
    const h1 = queue.requestApproval({
      clientName: 'plugin-j',
      declaredCapabilities: ['pane.read'],
    });
    const h2 = queue.requestApproval({
      clientName: 'plugin-j',
      declaredCapabilities: ['pane.read'],
    });
    queue.cancelPrompt(h1.promptId, 'plugin disconnected');
    await expect(h1.resolution).rejects.toThrow(/plugin disconnected/);
    await expect(h2.resolution).rejects.toThrow(/plugin disconnected/);
  });

  it('is a no-op for unknown promptIds', () => {
    const queue = makeQueue();
    expect(() =>
      queue.cancelPrompt('does-not-exist', 'whatever'),
    ).not.toThrow();
  });
});

describe('ApprovalQueue removal-push (closePrompt)', () => {
  function makeQueueWithCloser(closePrompt: (promptId: string) => void): ApprovalQueue {
    opened = [];
    return new ApprovalQueue(store, {
      openPrompt: (info) => opened.push(info),
      closePrompt,
      mintPromptId: mintId,
    });
  }

  it('fires closePrompt with the exact promptId on resolve', async () => {
    const closePrompt = vi.fn();
    const queue = makeQueueWithCloser(closePrompt);
    const handle = queue.requestApproval({
      clientName: 'plugin-close-a',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt(handle.promptId, true);
    expect(closePrompt).toHaveBeenCalledTimes(1);
    expect(closePrompt).toHaveBeenCalledWith(handle.promptId);
  });

  it('fires closePrompt with the exact promptId on cancel', () => {
    const closePrompt = vi.fn();
    const queue = makeQueueWithCloser(closePrompt);
    const handle = queue.requestApproval({
      clientName: 'plugin-close-b',
      declaredCapabilities: ['terminal.read'],
    });
    // Reject the parked waiter so the unhandled rejection doesn't leak.
    void handle.resolution.catch(() => {});
    queue.cancelPrompt(handle.promptId, 'plugin disconnected');
    expect(closePrompt).toHaveBeenCalledTimes(1);
    expect(closePrompt).toHaveBeenCalledWith(handle.promptId);
  });

  it('does NOT fire closePrompt for a no-op resolve (double-resolve fires once)', async () => {
    const closePrompt = vi.fn();
    const queue = makeQueueWithCloser(closePrompt);
    const handle = queue.requestApproval({
      clientName: 'plugin-close-c',
      declaredCapabilities: ['pane.read'],
    });
    await queue.resolvePrompt(handle.promptId, true);
    // Second resolve hits the `if (!key) return` guard → no second push.
    await queue.resolvePrompt(handle.promptId, false);
    // Unknown promptId never entered the queue → guard short-circuits.
    await queue.resolvePrompt('never-existed', true);
    expect(closePrompt).toHaveBeenCalledTimes(1);
    expect(closePrompt).toHaveBeenCalledWith(handle.promptId);
  });
});

// ── requestConsent: a one-off question that grants nothing durable ───────────
//
// The live-Chrome tab borrow prompt rides this queue so it appears in both of
// the queue's renditions (the modal and the Fleet approvals inbox) without any
// new UI. What it must NOT do is write the plugin trust DB: "lend this agent
// that tab" says nothing about whether a CLIENT is trusted, and recording it
// there would mark one on the strength of a question about a browser tab.
describe('ApprovalQueue.requestConsent', () => {
  it('opens a prompt carrying the kind, the question and the deadline', () => {
    const queue = makeQueue();
    const handle = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-9',
      clientName: 'Docs',
      title: 'Agent in workspace Docs wants to control tab "Inbox" (https://mail.example.com)',
      deadlineAt: 1_700_000_000_000,
    });

    expect(handle.promptId).toBe('prompt-1');
    expect(opened[0]).toEqual({
      promptId: 'prompt-1',
      clientName: 'Docs',
      declaredCapabilities: [],
      kind: 'browser-borrow',
      title: 'Agent in workspace Docs wants to control tab "Inbox" (https://mail.example.com)',
      deadlineAt: 1_700_000_000_000,
    });
  });

  it('resolves its waiters WITHOUT recording a client decision', async () => {
    const queue = makeQueue();
    const handle = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-9',
      clientName: 'Docs',
      title: 'lend a tab?',
    });

    await queue.resolvePrompt(handle.promptId, true);

    const result = await handle.resolution;
    expect(result.approved).toBe(true);
    // No trust record: the prompt was about a tab, not about a client.
    expect(await store.get('Docs')).toBeUndefined();
  });

  it('a denial is likewise not recorded against the client', async () => {
    const queue = makeQueue();
    const handle = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-9',
      clientName: 'Docs',
      title: 'lend a tab?',
    });

    await queue.resolvePrompt(handle.promptId, false);

    expect((await handle.resolution).approved).toBe(false);
    expect(await store.get('Docs')).toBeUndefined();
  });

  it('coalesces on the caller dedupe key, and two tabs are two questions', () => {
    const queue = makeQueue();
    const first = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-9',
      clientName: 'Docs',
      title: 'lend tab 9?',
    });
    const again = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-9',
      clientName: 'Docs',
      title: 'lend tab 9?',
    });
    const other = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-10',
      clientName: 'Docs',
      title: 'lend tab 10?',
    });

    expect(again.promptId).toBe(first.promptId);
    expect(other.promptId).not.toBe(first.promptId);
    expect(opened).toHaveLength(2);
  });

  it('cancelling rejects every waiter (a withdrawn prompt was not approved)', async () => {
    const queue = makeQueue();
    const handle = queue.requestConsent({
      kind: 'browser-borrow',
      dedupeKey: 'ws-1::tab-9',
      clientName: 'Docs',
      title: 'lend a tab?',
    });

    queue.cancelPrompt(handle.promptId, 'borrow request expired');

    await expect(handle.resolution).rejects.toThrow('borrow request expired');
    expect(queue.inflightCount()).toBe(0);
  });
});
