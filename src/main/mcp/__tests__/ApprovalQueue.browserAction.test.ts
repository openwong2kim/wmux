import { describe, expect, it, vi } from 'vitest';
import { ApprovalQueue, type ApprovalPromptInfo, type ApprovalResult } from '../ApprovalQueue';
import type { PluginTrustStore } from '../PluginTrustStore';

// The 'browser-action' kind: carries what the dialog shows, and only it may
// carry `remember`. Every other kind resolves exactly as before.

function make() {
  const opened: ApprovalPromptInfo[] = [];
  let n = 0;
  const queue = new ApprovalQueue({ setUserDecision: vi.fn(async () => undefined) } as unknown as PluginTrustStore, {
    openPrompt: (info) => opened.push(info),
    mintPromptId: () => `p${++n}`,
  });
  return { queue, opened };
}

const ACTION = { workspaceId: 'ws', paneId: 'pane', action: 'download' as const, host: 'a.test' };

describe('ApprovalQueue — browser-action', () => {
  it('opens the prompt with its browserAction and honours remember on an approval', async () => {
    const { queue, opened } = make();
    const h = queue.requestConsent({ kind: 'browser-action', dedupeKey: 'op-1', clientName: 'ws', title: 't', browserAction: ACTION });
    expect(opened[0]).toMatchObject({ kind: 'browser-action', browserAction: ACTION });
    await queue.resolvePrompt(h.promptId, true, { remember: true });
    await expect(h.resolution).resolves.toEqual({ approved: true, promptId: h.promptId, identity: undefined, remember: true });
  });

  it('remember on a deny grants nothing', async () => {
    const { queue } = make();
    const h = queue.requestConsent({ kind: 'browser-action', dedupeKey: 'op-1', clientName: 'ws', title: 't', browserAction: ACTION });
    await queue.resolvePrompt(h.promptId, false, { remember: true });
    await expect(h.resolution).resolves.toEqual({ approved: false, promptId: h.promptId, identity: undefined });
  });

  it('only boolean true approves', async () => {
    const { queue } = make();
    const h = queue.requestConsent({ kind: 'browser-action', dedupeKey: 'op-1', clientName: 'ws', title: 't', browserAction: ACTION });
    await queue.resolvePrompt(h.promptId, 'yes' as unknown as boolean);
    expect((await h.resolution).approved).toBe(false);
  });

  it.each(['browser-borrow', 'computer-app'] as const)('%s ignores remember: result and payload as before', async (kind) => {
    const { queue, opened } = make();
    const h = queue.requestConsent({ kind, dedupeKey: 'k', clientName: 'ws', title: 't', browserAction: ACTION });
    expect(opened[0]).toEqual({ promptId: h.promptId, clientName: 'ws', declaredCapabilities: [], kind, title: 't' });
    await queue.resolvePrompt(h.promptId, true, { remember: true });
    const result: ApprovalResult = await h.resolution;
    expect(result).toEqual({ approved: true, promptId: h.promptId, identity: undefined });
    expect('remember' in result).toBe(false);
  });

  it('each operation id is its own prompt (no coalescing)', () => {
    const { queue, opened } = make();
    const a = queue.requestConsent({ kind: 'browser-action', dedupeKey: 'op-1', clientName: 'ws', title: 't', browserAction: ACTION });
    const b = queue.requestConsent({ kind: 'browser-action', dedupeKey: 'op-2', clientName: 'ws', title: 't', browserAction: ACTION });
    expect(a.promptId).not.toBe(b.promptId);
    expect(opened).toHaveLength(2);
  });
});
