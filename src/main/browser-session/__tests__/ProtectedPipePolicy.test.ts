// A protected profile's rules for its pipe's clients: download settings are
// answered, not forwarded; a client's new context is denied before it hears
// of it; download events reach only the clients that hold the page and asked
// for events in its context.
import { describe, expect, it, vi } from 'vitest';
import type { ClientRef } from '../CdpPipeMux';
import { ProtectedPipePolicy, appLaunchUrl, type ProtectedPipeDeps } from '../ProtectedPipePolicy';

const ext = (label: string): ClientRef => ({ kind: 'external', label });
const main: ClientRef = { kind: 'internal', label: 'main' };

function rig(over: Partial<ProtectedPipeDeps> = {}) {
  const calls: string[] = [];
  const sent: Array<{ to: string; method: string; sessionId?: string }> = [];
  /** The pages each client holds, with their browser context ('DEFAULT' is Chrome's default context's id; null: none named). */
  const pages = new Map<ClientRef, Record<string, string | null>>();
  const policy = new ProtectedPipePolicy({
    denyContext: async (id) => { calls.push(`deny ${id}`); },
    disposeContext: async (id) => { calls.push(`dispose ${id}`); },
    contextOf: (client, targetId) => pages.get(client)?.[targetId],
    emit: (client, method, _params, sessionId) => { sent.push({ to: client.label, method, ...(sessionId !== undefined && { sessionId }) }); return true; },
    ...over,
  });
  return { policy, calls, sent, pages };
}

describe('ProtectedPipePolicy', () => {
  it('answers a client\'s download settings and cancels itself, and lets main\'s own through', () => {
    const { policy } = rig();
    const a = ext('a');
    expect(policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/x' } })).toEqual({ absorb: {}, reason: 'download-behavior' });
    expect(policy.filter(a, { method: 'Page.setDownloadBehavior', params: { behavior: 'allow' } })).toEqual({ absorb: {}, reason: 'page-download-behavior' });
    expect(policy.filter(a, { method: 'Browser.cancelDownload', params: { guid: 'g' } })).toEqual({ absorb: {}, reason: 'cancel-download' });
    expect(policy.filter(main, { method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } })).toBeNull();
    // Choosing a device for a page's request is refused on a protected profile.
    const device = policy.filter(a, { method: 'DeviceAccess.selectPrompt', params: { id: 'p', deviceId: 'd' } });
    expect(device && 'refuse' in device && device.reason).toBe('device-access');
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
    expect(error?.reason).toBeUndefined();
    expect(failing.calls).toEqual(['dispose C2']);
  });

  it('holds a context list until a failed deny\'s close has settled', async () => {
    let closed: (() => void) | null = null;
    const { policy } = rig({
      denyContext: () => Promise.reject(new Error('gone')),
      disposeContext: () => new Promise<void>((resolve) => { closed = resolve; }),
    });
    const a = ext('a');
    const created = policy.beforeReply(a, 'Target.createBrowserContext', { browserContextId: 'C1' });
    const listed = policy.beforeReply(ext('b'), 'Target.getBrowserContexts', { browserContextIds: ['C1'] });
    let heard = false;
    void listed?.then(() => { heard = true; });
    // The close is in flight; the list waits on it.
    await vi.waitFor(() => expect(closed).not.toBeNull(), { timeout: 1_000 });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(heard).toBe(false);
    (closed as unknown as () => void)();
    await expect(created).resolves.toMatchObject({ message: expect.stringMatching(/^policy_denied:/) });
    await expect(listed).resolves.toBeNull();
  });

  it('a context that can be neither denied nor closed is counted, warned of once, and denied before a list names it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let denies = 0;
    let denyWorks = false;
    const { policy } = rig({
      denyContext: () => { denies++; return denyWorks ? Promise.resolve() : Promise.reject(new Error('gone')); },
      disposeContext: () => Promise.reject(new Error('gone')),
    });
    const a = ext('a');
    for (const id of ['C1', 'C2']) {
      expect(await policy.beforeReply(a, 'Target.createBrowserContext', { browserContextId: id })).toMatchObject({ reason: 'context-unguarded' });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain('C1');
    // A list naming one is refused while it still can't be denied ...
    expect(await policy.beforeReply(a, 'Target.getBrowserContexts', { browserContextIds: ['C1', 'C2'] })).toMatchObject({ reason: 'context-unguarded' });
    // ... and answered once it is; a list that no longer names one lets it go.
    denyWorks = true;
    denies = 0;
    expect(await policy.beforeReply(a, 'Target.getBrowserContexts', { browserContextIds: ['C1'] })).toBeNull();
    expect(denies).toBe(1);
    expect(policy.beforeReply(a, 'Target.getBrowserContexts', { browserContextIds: [] })).toBeNull();
    warn.mockRestore();
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

  it('sends download events only for the contexts a session asked for, the default context included', async () => {
    const { policy, sent, pages } = rig();
    const a = ext('a');
    await policy.beforeReply(a, 'Target.createBrowserContext', { browserContextId: 'A' });
    pages.set(a, { P1: 'A', P0: 'DEFAULT' });
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', browserContextId: 'A', eventsEnabled: true } });
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'default', browserContextId: 'B' } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g1', frameId: 'P1' });
    // Events on for context A only: a page in the default context gets none.
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g0', frameId: 'P0' });
    expect(sent).toEqual([{ to: 'a', method: 'Browser.downloadWillBegin' }]);
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g2', frameId: 'P0' });
    expect(sent).toHaveLength(2);
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'default', browserContextId: 'A' } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g3', frameId: 'P1' });
    expect(sent).toHaveLength(2);
  });

  it('a held frame whose context was never named counts as the default context; a frame not held reaches no one', () => {
    const { policy, sent, pages } = rig();
    const a = ext('a');
    pages.set(a, { P0: null });
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g1', frameId: 'P0' });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g2', frameId: 'not-held' });
    expect(sent).toEqual([{ to: 'a', method: 'Browser.downloadWillBegin' }]);
  });

  it('forgets a client that left: what it asked for and what it was told', () => {
    const { policy, pages } = rig();
    const [a, b] = [ext('a'), ext('b')];
    for (const c of [a, b]) {
      pages.set(c, { P0: 'DEFAULT' });
      policy.filter(c, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    }
    // Begun, never finished: both are on its list.
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g1', frameId: 'P0' });
    policy.forget(a);
    const inside = policy as unknown as { listening: Map<ClientRef, unknown>; told: Map<string, Array<{ client: ClientRef }>> };
    expect([...inside.listening.keys()]).toEqual([b]);
    expect(inside.told.get('g1')?.map((l) => l.client)).toEqual([b]);
    policy.forget(b);
    expect(inside.listening.size).toBe(0);
    expect(inside.told.size).toBe(0);
  });

  it('drops a client whose only session stopped taking events', () => {
    const { policy, pages } = rig({ emit: () => false });
    const a = ext('a');
    pages.set(a, { P0: 'DEFAULT' });
    policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', eventsEnabled: true } });
    policy.downloadEvent('Browser.downloadWillBegin', { guid: 'g1', frameId: 'P0' });
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
    pages.set(a, { P1: 'DEFAULT' });
    pages.set(b, { P2: 'DEFAULT' });
    pages.set(c, { P1: 'DEFAULT' });

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

describe('ProtectedPipePolicy, the pages an outside client may open', () => {
  const ALLOWED = ['http://a.test/', 'https://a.test/x', 'about:blank', 'about:blank#x', 'data:text/html,hi', '', '  https://a.test '];
  const REFUSED = [
    'chrome://inspect/#remote-debugging', 'CHROME://inspect', ' chrome://inspect', 'chrome:inspect',
    'chrome-untrusted://x/', 'devtools://devtools/bundled/inspector.html', 'chrome-extension://abc/x.html',
    'view-source:https://a.test/', 'view-source:chrome://inspect', 'file:///etc/hosts', 'javascript:1', 'about:inspect',
  ];
  const refused = (answer: ReturnType<ProtectedPipePolicy['filter']>) => !!answer && 'refuse' in answer && answer.reason === 'scheme-not-allowed';

  it('opens and navigates to http(s), data: and about:blank only', () => {
    const { policy } = rig();
    const a = ext('a');
    for (const url of ALLOWED) {
      expect(policy.filter(a, { method: 'Target.createTarget', params: { url } }), url).toBeNull();
      expect(policy.filter(a, { method: 'Page.navigate', params: { url } }), url).toBeNull();
    }
    expect(policy.filter(a, { method: 'Target.createTarget', params: {} })).toBeNull();
    for (const url of REFUSED) {
      const create = policy.filter(a, { method: 'Target.createTarget', params: { url } });
      expect(refused(create), url).toBe(true);
      expect(create && 'refuse' in create && create.refuse.message).toBe('policy_denied: scheme not allowed on a protected profile');
      expect(refused(policy.filter(a, { method: 'Page.navigate', params: { url } })), url).toBe(true);
    }
    expect(refused(policy.filter(a, { method: 'Page.navigate', params: {} }))).toBe(true);
    expect(refused(policy.filter(a, { method: 'Target.createTarget', params: { url: 42 } }))).toBe(true);
  });

  it('leaves main\'s own connections unfiltered', () => {
    const { policy } = rig();
    expect(policy.filter(main, { method: 'Target.createTarget', params: { url: 'chrome://inspect' } })).toBeNull();
    expect(policy.filter(main, { method: 'Page.navigate', params: { url: 'chrome://settings' } })).toBeNull();
    expect(policy.filter(main, { method: 'Page.navigateToHistoryEntry', params: { entryId: 7 } })).toBeNull();
  });

  it('goes to a history entry only when the client was shown it at a URL it may open', () => {
    const { policy } = rig();
    const a = ext('a');
    const b = ext('b');
    expect(policy.beforeReply(a, 'Page.getNavigationHistory', {
      currentIndex: 1,
      entries: [{ id: 1, url: 'https://a.test/' }, { id: 2, url: 'chrome://settings/' }, { id: 3, url: 'about:blank' }],
    })).toBeNull();
    const go = (client: ClientRef, entryId: unknown) => policy.filter(client, { method: 'Page.navigateToHistoryEntry', params: { entryId } });
    expect(go(a, 1)).toBeNull();
    expect(go(a, 3)).toBeNull();
    expect(refused(go(a, 2))).toBe(true);
    // An id it was never shown, a malformed one, and another client's.
    expect(refused(go(a, 9))).toBe(true);
    expect(refused(go(a, '1'))).toBe(true);
    expect(refused(go(b, 1))).toBe(true);
    // Main's own history replies teach nothing.
    expect(policy.beforeReply(main, 'Page.getNavigationHistory', { entries: [{ id: 9, url: 'https://a.test/' }] })).toBeNull();
    expect(refused(go(a, 9))).toBe(true);
  });

  it('forgets the entries a client was shown when it leaves', () => {
    const { policy } = rig();
    const a = ext('a');
    policy.beforeReply(a, 'Page.getNavigationHistory', { entries: [{ id: 1, url: 'https://a.test/' }] });
    expect(policy.filter(a, { method: 'Page.navigateToHistoryEntry', params: { entryId: 1 } })).toBeNull();
    policy.forget(a);
    expect(refused(policy.filter(a, { method: 'Page.navigateToHistoryEntry', params: { entryId: 1 } }))).toBe(true);
  });

  it('counts as handed to another app only a fixed list of schemes, read the way a typed URL is', () => {
    for (const url of ['mailto:a@b.test', ' MAILTO:a@b.test', 'tel:+1', 'sms:+1', 'callto:x', 'facetime:x']) {
      expect(appLaunchUrl(url), url).toBe(true);
    }
    for (const url of ['view-source:mailto:a@b.test', 'chrome://settings', 'web+app:x', 'zoommtg://x', 'search-ms:query=x', 'search:x', 'microsoft-edge:https://a.test/', 'https://a.test/', 'not a url']) {
      expect(appLaunchUrl(url), url).toBe(false);
    }
  });
});
