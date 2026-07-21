import { describe, expect, it, vi, beforeEach } from 'vitest';

// Packaged RPC fallback coverage for the browser_cookies / _storage / _emulate /
// _resize state tools (#111). On packaged builds engine.getPage() returns null
// and each tool must route its operation through the browser.* RPC channel
// instead of throwing "No browser page available".

// Mock the RPC transport. __tests__/ -> playwright/ -> mcp/, so ../../wmux-client
// resolves to src/mcp/wmux-client.
// #517: tool handlers are wrapped in withAutomationLease, which issues
// browser.lease.* RPCs around the real operation. Keep those transparent to
// this suite's call-sequence assertions: lease traffic is answered inline
// ({ token: null } → the helper proceeds unleased, no renew/release) and only
// non-lease methods reach the recorded mock.
const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));
vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    typeof method === 'string' && method.startsWith('browser.lease.')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

// Mock PlaywrightEngine so getPage() is controllable per test.
const getPage = vi.fn();
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPage }) },
}));

import { registerStateTools } from '../tools/state';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

// Minimal McpServer stand-in that captures each registered tool's handler.
function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerStateTools(server as never);
  return tools;
}

const tools = collectTools();
const cookies = tools.get('browser_cookies')!;
const storage = tools.get('browser_storage')!;
const emulate = tools.get('browser_emulate')!;
const resize = tools.get('browser_resize')!;

beforeEach(() => {
  mockSendRpc.mockReset();
  getPage.mockReset();
  getPage.mockResolvedValue(null); // default: packaged (no Playwright Page)
});

describe('browser_cookies RPC fallback', () => {
  it('get routes to browser.cookies and returns the cookie list', async () => {
    mockSendRpc.mockResolvedValue({
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com' }],
    });
    const res = await cookies({ action: 'get', surfaceId: 's1' });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.cookies', {
      action: 'get',
      urls: [],
      surfaceId: 's1',
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"value": "abc"');
  });

  it('get passes url through as a single-element urls array', async () => {
    mockSendRpc.mockResolvedValue({ cookies: [] });
    await cookies({ action: 'get', url: 'https://example.com' });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.cookies', {
      action: 'get',
      urls: ['https://example.com'],
    });
  });

  it('redacts values from sensitive domains returned over RPC', async () => {
    mockSendRpc.mockResolvedValue({
      cookies: [{ name: 'sid', value: 'secret', domain: 'mail.gmail.com' }],
    });
    const res = await cookies({ action: 'get' });
    expect(res.content[0].text).toContain('<REDACTED sensitive-domain>');
    expect(res.content[0].text).not.toContain('secret');
  });

  it('set routes prepared cookies to browser.cookies', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    const res = await cookies({
      action: 'set',
      cookies: [{ name: 'a', value: 'b' }],
      url: 'https://example.com',
    });
    const [method, params] = mockSendRpc.mock.calls[0];
    expect(method).toBe('browser.cookies');
    expect((params as { action: string }).action).toBe('set');
    expect((params as { cookies: { url?: string }[] }).cookies[0].url).toBe('https://example.com');
    expect(res.content[0].text).toContain('Set 1 cookie(s).');
  });

  it('clear routes to browser.cookies', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    const res = await cookies({ action: 'clear' });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.cookies', { action: 'clear' });
    expect(res.content[0].text).toContain('Cookies cleared.');
  });

  it('uses the Playwright Page when one exists (no RPC)', async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    getPage.mockResolvedValue({ context: () => ({ clearCookies }) });
    await cookies({ action: 'clear' });
    expect(clearCookies).toHaveBeenCalledTimes(1);
    expect(mockSendRpc).not.toHaveBeenCalled();
  });
});

describe('browser_storage RPC fallback', () => {
  it('get checks the sensitive domain via location.href then reads over RPC', async () => {
    mockSendRpc.mockImplementation((_method: string, params: { expression: string }) => {
      if (params.expression === 'location.href') return Promise.resolve({ value: 'https://example.com' });
      return Promise.resolve({ value: { token: 'xyz' } });
    });
    const res = await storage({ type: 'local', action: 'get', surfaceId: 's1' });
    // First call resolves the URL, second runs the stringified reader.
    expect(mockSendRpc).toHaveBeenCalledWith('browser.evaluate', {
      expression: 'location.href',
      surfaceId: 's1',
    });
    expect(res.content[0].text).toContain('"token": "xyz"');
  });

  it('blocks get on a sensitive page resolved over RPC', async () => {
    mockSendRpc.mockResolvedValue({ value: 'https://mail.gmail.com/inbox' });
    const res = await storage({ type: 'local', action: 'get' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('sensitive-domain blocklist');
  });

  it('set routes a stringified setItem call over browser.evaluate', async () => {
    mockSendRpc.mockResolvedValue({ value: null });
    await storage({ type: 'session', action: 'set', key: 'k', value: 'v' });
    const expr = mockSendRpc.mock.calls[0][1].expression as string;
    expect(expr).toContain('sessionStorage');
    expect(expr).toContain('setItem');
    expect(expr).toContain('["sessionStorage","k","v"]');
  });
});

describe('browser_resize RPC fallback', () => {
  it('routes to browser.resize', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    const res = await resize({ width: 800, height: 600, surfaceId: 's1' });
    expect(mockSendRpc).toHaveBeenCalledWith('browser.resize', {
      width: 800,
      height: 600,
      surfaceId: 's1',
    });
    expect(res.content[0].text).toContain('800x600');
  });
});

describe('browser_emulate RPC fallback', () => {
  it('forwards normalized settings and renders the applied summary', async () => {
    mockSendRpc.mockResolvedValue({ applied: ['offline=true', 'geo=1,2'] });
    const res = await emulate({
      offline: true,
      geo: { latitude: 1, longitude: 2 },
      credentials: { username: 'u', password: 'p' },
      surfaceId: 's1',
    });
    const [method, params] = mockSendRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('browser.emulate');
    expect(params.offline).toBe(true);
    expect(params.geo).toEqual({ latitude: 1, longitude: 2 });
    expect(params.credentialsRequested).toBe(true);
    expect(params.surfaceId).toBe('s1');
    expect(res.content[0].text).toContain('offline=true');
  });

  it('resolves a device preset to deviceMetrics + userAgent (no playwright-core in main)', async () => {
    mockSendRpc.mockResolvedValue({ applied: ['device=iPhone 13'] });
    await emulate({ device: 'iPhone 13' });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.deviceMetrics).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(typeof params.userAgent).toBe('string');
    expect(params.deviceReset).toBeUndefined();
  });

  it('flags an unknown device before any RPC', async () => {
    const res = await emulate({ device: 'NoSuchPhone 99' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown device');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('signals device reset when device is null', async () => {
    mockSendRpc.mockResolvedValue({ applied: ['device=reset (use browser_resize to set viewport)'] });
    await emulate({ device: null });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.deviceReset).toBe(true);
    expect(params.deviceMetrics).toBeUndefined();
  });
});
