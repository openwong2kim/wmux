import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

import { registerNavigationTools } from '../tools/navigation';
import { REDACTED_PASSWORD } from '../redact';
import type { BrowserToolDeps } from '../browserScope';

// Every URL a tool renders gets the same masking browser_network's listing
// does. A credential reaches a URL two ways in practice: a query parameter on
// a GET login, and `scheme://user:password@host` basic-auth userinfo.

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(deps: BrowserToolDeps): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerNavigationTools(server as never, deps);
  return tools;
}

const SECRET_URL = 'https://x.test/login?user=alice&password=hunter2SECRET';
const USERINFO_URL = 'https://alice:hunter2SECRET@x.test/dashboard';

describe('URL echoes in navigation results', () => {
  const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
  let navigate: ToolHandler;
  let navigateBack: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkspaceId.mockResolvedValue('ws-caller');
    const tools = collectTools({ resolveWorkspaceId });
    navigate = tools.get('browser_navigate')!;
    navigateBack = tools.get('browser_navigate_back')!;
  });

  /** Lease/lifecycle plumbing the leased tools need, plus a per-test override. */
  function leasedRouter(extra?: (method: string) => unknown | undefined) {
    return (method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      const handled = extra?.(method);
      return Promise.resolve(handled === undefined ? {} : handled);
    };
  }

  it('masks a query-string credential in the browser_navigate echo', async () => {
    mockSendRpc.mockImplementation(
      leasedRouter((method) => (method === 'browser.evaluate' ? { value: SECRET_URL } : undefined)),
    );

    const result = await navigate({ url: SECRET_URL, surfaceId: 'surface-a' });

    const text = result.content.map((c) => c.text).join('\n');
    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`password=${REDACTED_PASSWORD}`);
    // The rest of the URL still identifies where the agent landed.
    expect(text).toContain('https://x.test/login?user=alice');
  });

  it('masks userinfo in the browser_navigate echo, keeping the username', async () => {
    mockSendRpc.mockImplementation(
      leasedRouter((method) => (method === 'browser.evaluate' ? { value: USERINFO_URL } : undefined)),
    );

    const result = await navigate({ url: USERINFO_URL, surfaceId: 'surface-a' });

    const text = result.content.map((c) => c.text).join('\n');
    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`https://alice:${REDACTED_PASSWORD}@x.test/dashboard`);
  });

  it('masks the browser_navigate_back echo', async () => {
    mockSendRpc.mockImplementation(
      leasedRouter((method) => (method === 'browser.evaluate' ? { value: SECRET_URL } : undefined)),
    );

    const result = await navigateBack({ surfaceId: 'surface-a' });

    const text = result.content.map((c) => c.text).join('\n');
    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(REDACTED_PASSWORD);
  });

  it('masks lifecycle event URLs prepended to a tool result', async () => {
    let drained = false;
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lifecycle.get') {
        // One drain reports the hop; later drains are empty.
        if (drained) return Promise.resolve({ entries: [] });
        drained = true;
        return Promise.resolve({
          entries: [{ type: 'navigated', url: SECRET_URL, ts: Date.now() }],
        });
      }
      if (method === 'browser.evaluate') return Promise.resolve({ value: 'https://x.test/home' });
      return Promise.resolve({});
    });

    const result = await navigate({ url: 'https://x.test/home', surfaceId: 'surface-a' });

    const text = result.content.map((c) => c.text).join('\n');
    expect(text).toContain('[browser events]');
    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`password=${REDACTED_PASSWORD}`);
  });

  it('leaves an ordinary navigation URL untouched', async () => {
    mockSendRpc.mockImplementation(
      leasedRouter((method) =>
        method === 'browser.evaluate' ? { value: 'https://x.test/docs?page=2' } : undefined,
      ),
    );

    const result = await navigate({ url: 'https://x.test/docs?page=2', surfaceId: 'surface-a' });

    const text = result.content.map((c) => c.text).join('\n');
    expect(text).toContain('Navigated to https://x.test/docs?page=2');
    expect(text).not.toContain(REDACTED_PASSWORD);
  });
});

describe('URL echoes in the browser_tabs listing', () => {
  const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
  let tabs: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkspaceId.mockResolvedValue('ws-caller');
    tabs = collectTools({ resolveWorkspaceId }).get('browser_tabs')!;
  });

  it('masks credentials in listed tab URLs and keeps the rest of the descriptor', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      action: 'list',
      tabs: [
        { surfaceId: 's1', paneId: 'p1', url: SECRET_URL, title: 'Login', selected: true },
        { surfaceId: 's2', paneId: 'p2', url: USERINFO_URL, title: 'Dash', selected: false },
        { surfaceId: 's3', paneId: 'p3', url: 'https://x.test/docs', title: 'Docs', selected: false },
      ],
    });

    const result = await tabs({ action: 'list' });
    const text = result.content[0].text;

    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`password=${REDACTED_PASSWORD}`);
    expect(text).toContain(`https://alice:${REDACTED_PASSWORD}@x.test/dashboard`);
    // Untouched tab, and the surrounding descriptor fields, survive intact.
    expect(text).toContain('https://x.test/docs');
    expect(text).toContain('"surfaceId": "s1"');
    expect(text).toContain('"title": "Login"');
    expect(text).toContain('"selected": true');
  });
});
