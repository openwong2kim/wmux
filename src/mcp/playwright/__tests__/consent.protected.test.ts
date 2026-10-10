import { beforeEach, describe, expect, it, vi } from 'vitest';

// Protected panes on the MCP lane: page scripts, downloads and sensitive-site
// cookies ask main first. The agent's allowDangerous / allowSensitiveDomains
// never stand in for the operator there; an unprotected pane never asks.

const { mockSendRpc, getPage, isolated, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  isolated: vi.fn(async () => 'ran'),
  resolveRef: vi.fn(),
}));

const PROTECTED = { protected: true, epoch: 3, hosts: { mode: 'allowlist', allow: ['a.test', 'gmail.com'], block: [] } };
let policy: unknown = PROTECTED;

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 't', policy });
    if (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get') return Promise.resolve({ token: null });
    return mockSendRpc(method, ...args);
  },
}));
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend: vi.fn(), isLiveWriteConfined: async () => false }),
  },
}));
vi.mock('../snapshot', () => ({
  resolveRef,
  generateSnapshot: vi.fn(),
  generateScopedSnapshot: vi.fn(),
  markDomRefsActive: vi.fn(),
}));
vi.mock('../isolated-eval', () => ({ evaluateIsolated: isolated, waitForIsolated: vi.fn() }));
vi.mock('../user-gesture', () => ({ evaluateWithGesture: vi.fn() }));

import { registerInspectionTools } from '../tools/inspection';
import { registerStateTools } from '../tools/state';
import { registerFileTools } from '../tools/file';
import { resetProtectionMemoryForTests } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<string, ToolHandler>();
const server = { tool: (name: string, _d: string, _s: unknown, h: ToolHandler) => tools.set(name, h) } as never;
const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') } as never;
registerInspectionTools(server, deps);
registerStateTools(server, deps);
registerFileTools(server, deps);
const tool = (name: string) => tools.get(name) as ToolHandler;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

const consentCalls = () => mockSendRpc.mock.calls.filter(([m]) => m === 'browser.consent.request');

function grantAll() {
  mockSendRpc.mockImplementation(async (method: string) => {
    if (method === 'browser.consent.request') return { ok: true, operationId: 'op-1', epoch: 3, via: 'once' };
    if (method === 'browser.consent.awaitDownload') return { ok: true, path: '/tmp/wmux-download-x/g1', url: 'http://a.test/f.bin', suggestedFilename: 'f.bin' };
    return {};
  });
}

function refuseConsent(message: string) {
  mockSendRpc.mockImplementation(async (method: string) => {
    if (method === 'browser.consent.request') throw new Error(message);
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  policy = PROTECTED;
  resetProtectionMemoryForTests();
  __resetSurfaceRoutingForTesting();
});

describe('browser_evaluate on a protected pane', () => {
  const page = { url: () => 'http://a.test/x' };
  beforeEach(() => getPage.mockResolvedValue(page));

  it('asks once for this script, then runs it', async () => {
    grantAll();
    const out = await tool('browser_evaluate')({ expression: 'document.title', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()).toHaveLength(1);
    expect(consentCalls()[0][1]).toMatchObject({ action: 'evaluate', url: 'http://a.test/x', detail: 'document.title' });
    expect(isolated).toHaveBeenCalledTimes(1);
  });

  it('allowDangerous does not bypass the question', async () => {
    grantAll();
    await tool('browser_evaluate')({ expression: 'fetch("/x")', allowDangerous: true, surfaceId: 's1' });
    expect(consentCalls()).toHaveLength(1);
  });

  it('a refusal runs nothing and comes back as the refusal', async () => {
    refuseConsent('browser.consent.request: needs_consent: evaluate on a.test. nobody is there');
    const out = await tool('browser_evaluate')({ expression: 'document.title', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^needs_consent:/);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('a page that moved to another site under the prompt is refused', async () => {
    let url = 'http://a.test/x';
    getPage.mockResolvedValue({ url: () => url });
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.consent.request') {
        url = 'http://gmail.com/';
        return { ok: true, operationId: 'op', epoch: 3 };
      }
      return {};
    });
    const out = await tool('browser_evaluate')({ expression: 'document.title', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(isolated).not.toHaveBeenCalled();
  });

  it('an unprotected pane never asks', async () => {
    policy = { protected: false };
    grantAll();
    await tool('browser_evaluate')({ expression: 'document.title', surfaceId: 's1' });
    expect(consentCalls()).toHaveLength(0);
    expect(isolated).toHaveBeenCalledTimes(1);
  });
});

describe('browser_cookies on a protected pane', () => {
  const cookies = [
    { name: 'a', value: 'A', domain: 'a.test', path: '/' },
    { name: 'm', value: 'SECRET', domain: '.gmail.com', path: '/' },
  ];
  const context = { cookies: vi.fn(async () => cookies), addCookies: vi.fn(), clearCookies: vi.fn() };
  beforeEach(() => getPage.mockResolvedValue({ url: () => 'http://a.test/', context: () => context }));

  it('without the flag sensitive values stay redacted and nobody is asked', async () => {
    grantAll();
    const out = await tool('browser_cookies')({ action: 'get', surfaceId: 's1' });
    expect(text(out)).toContain('<REDACTED sensitive-domain>');
    expect(consentCalls()).toHaveLength(0);
  });

  it('an equivalent hostname form (case, trailing dot) does not evade the sensitive list', async () => {
    grantAll();
    const out = await tool('browser_cookies')({ action: 'get', url: 'https://GMAIL.com./', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('sensitive-domain blocklist');
    expect(consentCalls()).toHaveLength(0);
  });

  it('allowSensitiveDomains asks for exactly the sensitive sites present', async () => {
    grantAll();
    const out = await tool('browser_cookies')({ action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(consentCalls()[0][1]).toMatchObject({ action: 'sensitive', hosts: ['gmail.com'] });
    expect(text(out)).toContain('SECRET');
  });

  it('a refused consent reveals nothing', async () => {
    refuseConsent('browser.consent.request: policy_denied: the operator denied it. Do not retry unchanged.');
    const out = await tool('browser_cookies')({ action: 'get', allowSensitiveDomains: true, surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(text(out)).not.toContain('SECRET');
  });

  it('setting a sensitive-site cookie asks first', async () => {
    grantAll();
    await tool('browser_cookies')({ action: 'set', cookies: [{ name: 'x', value: 'y', domain: 'gmail.com' }], surfaceId: 's1' });
    expect(consentCalls()[0][1]).toMatchObject({ action: 'sensitive', hosts: ['gmail.com'] });
    expect(context.addCookies).toHaveBeenCalled();
  });

  it('clearing asks before any sensitive cookie goes', async () => {
    refuseConsent('browser.consent.request: policy_denied: denied. Do not retry unchanged.');
    const out = await tool('browser_cookies')({ action: 'clear', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(context.clearCookies).not.toHaveBeenCalled();
  });
});

describe('browser_download on a protected pane', () => {
  const click = vi.fn(async () => undefined);
  const page = {
    url: () => 'http://a.test/files',
    context: () => ({
      newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'T1' } }), detach: async () => undefined }),
    }),
    waitForEvent: vi.fn(),
  };
  beforeEach(() => {
    getPage.mockResolvedValue(page);
    resolveRef.mockResolvedValue({ click });
  });

  it('asks for this download, clicks, and returns the file main let through', async () => {
    grantAll();
    const out = await tool('browser_download')({ ref: 'e1', surfaceId: 's1' });
    expect(out.isError).toBeUndefined();
    expect(consentCalls()[0][1]).toMatchObject({ action: 'download', url: 'http://a.test/files', targetId: 'T1' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(page.waitForEvent).not.toHaveBeenCalled();
    expect(text(out)).toContain('suggestedFilename: f.bin');
  });

  it('a refusal never clicks', async () => {
    refuseConsent('browser.consent.request: needs_consent: download on a.test. nobody is there');
    const out = await tool('browser_download')({ ref: 'e1', surfaceId: 's1' });
    expect(out.isError).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });
});
