import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

import { registerInspectionTools } from '../tools/inspection';
import { REDACTED_PASSWORD } from '../redact';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInspectionTools(server as never, browserToolDeps);
  return tools;
}

const tools = collectTools();
const network = tools.get('browser_network');
const responseBody = tools.get('browser_response_body');
if (!network || !responseBody) throw new Error('network tools failed to register');

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  getPage.mockReset();
  // Both tools take the RPC path when no Page exists, which is where the
  // main-process capture buffer is drained — the same formatter serves the
  // Playwright path.
  getPage.mockResolvedValue(null);
});

describe('browser_network — request listing', () => {
  it('masks a credential a page put in the query string', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { url: 'https://x.test/login?user=alice&password=hunter2SECRET', method: 'GET', status: 302 },
      ],
    });

    const result = await network({});

    expect(result.content[0].text).not.toContain('hunter2SECRET');
    expect(result.content[0].text).toContain(`password=${REDACTED_PASSWORD}`);
    // The field NAME and the rest of the request stay readable — this listing
    // exists to be debugged against.
    expect(result.content[0].text).toContain('user=alice');
    expect(result.content[0].text).toContain('"method": "GET"');
    expect(result.content[0].text).toContain('"status": 302');
  });

  it('leaves ordinary URLs untouched', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { url: 'https://x.test/account/reset-password?token=abc123', method: 'POST', status: 200 },
        { url: 'https://x.test/api/items?page=2', method: 'GET', status: 200 },
      ],
    });

    const result = await network({});

    expect(result.content[0].text).toContain('reset-password?token=abc123');
    expect(result.content[0].text).toContain('api/items?page=2');
    expect(result.content[0].text).not.toContain(REDACTED_PASSWORD);
  });
});

describe('browser_response_body', () => {
  it('masks a JSON body that echoes the submitted credential back', async () => {
    mockSendRpc.mockResolvedValue({
      body: '{"error":"invalid","submitted":{"username":"alice","password":"hunter2SECRET"}}',
    });

    const result = await responseBody({ urlPattern: '*login*' });

    expect(result.content[0].text).not.toContain('hunter2SECRET');
    expect(result.content[0].text).toContain(`"password":"${REDACTED_PASSWORD}"`);
    expect(result.content[0].text).toContain('"username":"alice"');
    expect(result.content[0].text).toContain('"error":"invalid"');
  });

  it('masks a form-urlencoded echo', async () => {
    mockSendRpc.mockResolvedValue({ body: 'username=alice&password=hunter2SECRET&csrf=t0ken' });

    const result = await responseBody({ urlPattern: '*login*' });

    expect(result.content[0].text).toBe(
      `username=alice&password=${REDACTED_PASSWORD}&csrf=t0ken`,
    );
  });

  it('returns an unrelated body byte for byte', async () => {
    const body = '{"items":[{"id":1,"passport":"X123"}],"total":1}';
    mockSendRpc.mockResolvedValue({ body });

    const result = await responseBody({ urlPattern: '*api*' });

    expect(result.content[0].text).toBe(body);
  });
});
