// A protected profile's rules for its pipe's clients: download settings are
// answered, not forwarded; a client's new context is denied before it hears
// of it; download events reach only the clients that hold the page.
import { describe, expect, it } from 'vitest';
import type { ClientRef } from '../CdpPipeMux';
import { ProtectedPipePolicy, type ProtectedPipeDeps } from '../ProtectedPipePolicy';

const ext = (label: string): ClientRef => ({ kind: 'external', label });
const main: ClientRef = { kind: 'internal', label: 'main' };

function rig(over: Partial<ProtectedPipeDeps> = {}) {
  const calls: string[] = [];
  const sent: Array<{ to: string; method: string; sessionId?: string }> = [];
  const pages = new Map<ClientRef, string[]>();
  const gone = new Set<ClientRef>();
  const policy = new ProtectedPipePolicy({
    attached: (client) => !gone.has(client),
    denyContext: async (id) => { calls.push(`deny ${id}`); },
    disposeContext: async (id) => { calls.push(`dispose ${id}`); },
    ownsTarget: (client, targetId) => pages.get(client)?.includes(targetId) ?? false,
    emit: (client, method, _params, sessionId) => { sent.push({ to: client.label, method, ...(sessionId !== undefined && { sessionId }) }); return true; },
    ...over,
  });
  return { policy, calls, sent, pages, gone };
}

describe('ProtectedPipePolicy', () => {
  it('answers a client\'s download settings and cancels itself, and lets main\'s own through', () => {
    const { policy } = rig();
    const a = ext('a');
    expect(policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/x' } })).toEqual({ absorb: {}, reason: 'download-behavior' });
    expect(policy.filter(a, { method: 'Page.setDownloadBehavior', params: { behavior: 'allow' } })).toEqual({ absorb: {}, reason: 'page-download-behavior' });
    expect(policy.filter(a, { method: 'Browser.cancelDownload', params: { guid: 'g' } })).toEqual({ absorb: {}, reason: 'cancel-download' });
    expect(policy.filter(main, { method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } })).toBeNull();
    expect(policy.filter(a, { method: 'Page.navigate', params: { url: 'http://a.test/' } })).toBeNull();
  });

  it('refuses context options that change where a context\'s traffic goes, and allows the rest', () => {
    const { policy } = rig();
    const a = ext('a');
    for (const option of ['proxyServer', 'proxyBypassList', 'originsWithUniversalNetworkAccess']) {
      const answer = policy.filter(a, { method: 'Target.createBrowserContext', params: { [option]: option === 'originsWithUniversalNetworkAccess' ? ['http://x/'] : 'x' } });
      expect(answer && 'refuse' in answer && answer.reason).toBe('context-options');
    }
    expect(policy.filter(a, { method: 'Target.createBrowserContext', params: { disposeOnDetach: true } })).toBeNull();
    expect(policy.filter(a, { method: 'Target.createBrowserContext', params: {} })).toBeNull();
  });

  it('denies a client\'s new context before its reply, and closes one it could not deny', async () => {
    const { policy, calls } = rig();
    const a = ext('a');
    expect(policy.beforeReply(a, 'Target.getTargets', {})).toBeNull();
    expect(policy.beforeReply(main, 'Target.createBrowserContext', { browserContextId: 'C0' })).toBeNull();
    await expect(policy.beforeReply(a, 'Target.createBrowserContext', { browserContextId: 'C1' })).resolves.toBeNull();
    expect(calls).toEqual(['deny C1']);

    const failing = rig({ denyContext: () => Promise.reject(new Error('gone')) });
    failing.policy.filter(a, { method: 'Browser.setDownloadBehavior', params: {} });
    const error = await failing.policy.beforeReply(a, 'Target.createBrowserContext', { browserContextId: 'C2' });
    expect(error?.message).toMatch(/^policy_denied:/);
    expect(failing.calls).toEqual(['dispose C2']);
  });

  it('holds a context list while a new context\'s deny is in flight', async () => {
    let answer: () => void = () => undefined;
    const { policy } = rig({ denyContext: () => new Promise<void>((resolve) => { answer = resolve; }) });
    const a = ext('a');
    expect(policy.beforeReply(a, 'Target.getBrowserContexts', {})).toBeNull();
    const created = policy.beforeReply(a, 'Target.createBrowserContext', { browserContextId: 'C1' });
    const listed = policy.beforeReply(ext('b'), 'Target.getBrowserContexts', { browserContextIds: ['C1'] });
    let heard = false;
    void listed?.then(() => { heard = true; });
    await Promise.resolve();
    expect(heard).toBe(false);
    answer();
    await expect(created).resolves.toBeNull();
    await expect(listed).resolves.toBeNull();
    expect(policy.beforeReply(a, 'Target.getBrowserContexts', {})).toBeNull();
  });

  it('keeps download events on per context, and forgets a client that has left', () => {
    const { policy, sent, pages, gone } = rig();
    const a = ext('a');
    pages.set(a, ['P1']);
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', browserContextId: 'A', eventsEnabled: true } });
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'default', browserContextId: 'B' } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g1', frameId: 'P1' });
    expect(sent).toEqual([{ to: 'a', method: 'Browser.downloadWillBegin' }]);
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'default', browserContextId: 'A' } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g2', frameId: 'P1' });
    expect(sent).toHaveLength(1);

    const b = ext('b');
    pages.set(b, ['P1']);
    policy.filter(b, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    gone.add(b);
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g3', frameId: 'P1' });
    expect(sent).toHaveLength(1);
    expect((policy as unknown as { listening: Map<ClientRef, unknown> }).listening.size).toBe(0);
  });

  it('sends a download\'s events to the clients that asked and hold its page, and to no one when no client holds it', () => {
    const { policy, sent, pages } = rig();
    const [a, b, c] = [ext('a'), ext('b'), ext('c')];
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    policy.filter(b, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    // A session of a's own (newBrowserCDPSession) asked too: it gets them on that session.
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true }, sessionId: 'S1' });
    policy.filter(c, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow' } });
    pages.set(a, ['P1']);
    pages.set(b, ['P2']);
    pages.set(c, ['P1']);

    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g1', frameId: 'P1' });
    policy.downloadEvent('Browser.downloadProgress', { guid: 'g1', state: 'canceled' });
    // Done: later progress for that guid goes nowhere.
    policy.downloadEvent('Browser.downloadProgress', { guid: 'g1', state: 'inProgress' });
    expect(sent).toEqual([
      { to: 'a', method: 'Browser.downloadWillBegin' },
      { to: 'a', method: 'Browser.downloadWillBegin', sessionId: 'S1' },
      { to: 'a', method: 'Browser.downloadProgress' },
      { to: 'a', method: 'Browser.downloadProgress', sessionId: 'S1' },
    ]);

    sent.length = 0;
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g2', frameId: 'P9' });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g3' });
    policy.downloadEvent('Browser.downloadProgress', { guid: 'g2', state: 'canceled' });
    expect(sent).toEqual([]);
  });
});
