import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// browser_request_help — the tool half of the hand-off. Everything below the
// RPC boundary is faked: `sendRpc` is the only seam, exactly as in
// wait.fallback.test.ts, so the four terminal states, the one-per-surface
// refusal and the unresolvable-ref note are exercised as the agent sees them.
//
// The lease/lifecycle infrastructure traffic withAutomationLease issues around
// every browser tool body is routed to its own mock so the assertions below see
// only the browser.help.* calls.
const { mockSendRpc, mockLeaseRpc, getPage, getInstance } = vi.hoisted(() => {
  const getPage = vi.fn();
  return {
    mockSendRpc: vi.fn(),
    mockLeaseRpc: vi.fn(),
    getPage,
    getInstance: vi.fn(() => ({ getPageForScope: getPage, drainLocalLifecycle: () => [] })),
  };
});
vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    typeof method === 'string' && method.startsWith('browser.help.')
      ? mockSendRpc(method, ...args)
      : mockLeaseRpc(method, ...args),
}));
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance },
}));

import { createHelpToolCatalog, registerHelpTools } from '../tools/help';
import type { WmuxToolProfile } from '../../toolCatalog';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';
import {
  expectCommanderCatalogLockstep,
  expectCoreCatalogLockstep,
  expectFrozenCatalog,
} from '../../__tests__/catalogAssertions';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(profile: WmuxToolProfile = 'full'): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerHelpTools(server as never, browserToolDeps, {
    profile,
    context: { principal: { kind: 'unattributed' } },
  });
  return tools;
}

const requestHelp = collectTools().get('browser_request_help');
if (!requestHelp) throw new Error('browser_request_help failed to register');

/** The text of a tool result, with the lifecycle/hint prelude stripped. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

/**
 * Route browser.help.* the way main would: one `request`, then a scripted
 * sequence of `status` answers consumed one per poll.
 */
function scriptStatuses(
  statuses: Array<{ state: string; url?: string }>,
  opened: Record<string, unknown> = { requestId: 'req-1', highlighted: null },
): void {
  let i = 0;
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.help.request') return Promise.resolve(opened);
    if (method === 'browser.help.status') {
      const next = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return Promise.resolve(next);
    }
    return Promise.resolve({ state: 'cancelled' });
  });
}

beforeEach(() => {
  __resetSurfaceRoutingForTesting();
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  mockLeaseRpc.mockReset();
  mockLeaseRpc.mockResolvedValue({ token: null });
  getPage.mockReset();
  getPage.mockResolvedValue(null);
  // The tool sleeps 1s between polls; fake timers keep the suite instant.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run the tool to completion while letting its poll sleeps elapse. */
async function runHelp(args: Record<string, unknown>) {
  const pending = requestHelp!(args);
  // Generous: each iteration only needs one 1s tick, and over-advancing is
  // harmless once the promise has settled.
  await vi.advanceTimersByTimeAsync(20_000);
  return pending;
}

describe('browser_request_help catalog registration', () => {
  it('registers on full only and stays off core and commander', () => {
    expect([...collectTools('full').keys()]).toEqual(['browser_request_help']);
    expect([...collectTools('core').keys()]).toEqual([]);
    expect([...collectTools('commander').keys()]).toEqual([]);
  });

  it('keeps the declared schema order, profile membership, and frozen descriptors', () => {
    const specs = createHelpToolCatalog(browserToolDeps);
    expect(specs.map((spec) => spec.name)).toEqual(['browser_request_help']);
    expect(specs[0]?.profiles).toEqual(['full']);
    expect(Object.keys(specs[0]?.inputSchema ?? {})).toEqual([
      'prompt',
      'ref',
      'timeoutMs',
      'completion',
      'surfaceId',
    ]);
    expectCommanderCatalogLockstep(specs);
    expectCoreCatalogLockstep(specs);
    expectFrozenCatalog(specs);
  });
});

describe('browser_request_help terminal states', () => {
  it('reports `continued` when the human presses Done', async () => {
    scriptStatuses([
      { state: 'pending' },
      { state: 'continued', url: 'https://example.test/account' },
    ]);
    const text = textOf(await runHelp({ prompt: 'Sign in, then press Done.' }));
    expect(text).toContain('the human pressed Done');
    expect(text).toContain('help_state: continued');
    expect(text).toContain('url: https://example.test/account');
    // The machine-readable pair is LAST, so a truncating client keeps it.
    const lines = text.trim().split('\n');
    expect(lines[lines.length - 2]).toBe('help_state: continued');
    expect(lines[lines.length - 1]).toBe('url: https://example.test/account');
  });

  it('reports `completed` when the completion criteria are met', async () => {
    scriptStatuses([{ state: 'completed', url: 'https://example.test/dash' }]);
    const text = textOf(
      await runHelp({ prompt: 'Log in', completion: { urlIncludes: '/dash' } }),
    );
    expect(text).toContain('completion criteria you gave were met');
    expect(text).toContain('help_state: completed');
    // The condition is forwarded to main, which owns the polling.
    const opened = mockSendRpc.mock.calls.find((c) => c[0] === 'browser.help.request');
    expect((opened?.[1] as { completion?: unknown }).completion).toEqual({ urlIncludes: '/dash' });
  });

  it('reports `cancelled` when the human presses Cancel', async () => {
    scriptStatuses([{ state: 'cancelled', url: 'https://example.test/login' }]);
    const text = textOf(await runHelp({ prompt: 'Sign in' }));
    expect(text).toContain('cancelled by the human');
    expect(text).toContain('help_state: cancelled');
  });

  it('reports `timed_out` when nobody answers before main\'s deadline', async () => {
    scriptStatuses([{ state: 'timed_out', url: 'https://example.test/login' }]);
    const text = textOf(await runHelp({ prompt: 'Sign in' }));
    expect(text).toContain('nobody answered');
    expect(text).toContain('help_state: timed_out');
  });

  it('prints url: (unknown) when main could not read the page', async () => {
    scriptStatuses([{ state: 'continued' }]);
    expect(textOf(await runHelp({ prompt: 'Sign in' }))).toContain('url: (unknown)');
  });
});

describe('browser_request_help refusals', () => {
  it('leads with help_already_pending: when the surface already has an open ask', async () => {
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.help.request') {
        return Promise.reject(
          new Error(
            'help_already_pending: this browser surface already has an open help request (req-0).',
          ),
        );
      }
      return Promise.resolve({ state: 'pending' });
    });
    const result = await runHelp({ prompt: 'Sign in' });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('help_already_pending:')).toBe(true);
  });

  it('leads with not_supported: on an external-backend workspace', async () => {
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.help.request') {
        return Promise.reject(
          new Error(
            'browser.help.request: not_supported: this workspace delegates browser opens to the OS browser.',
          ),
        );
      }
      return Promise.resolve({ state: 'pending' });
    });
    const result = await runHelp({ prompt: 'Sign in' });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('not_supported:')).toBe(true);
  });

  it('refuses a prompt that sanitizes away, without opening anything', async () => {
    scriptStatuses([{ state: 'continued' }]);
    const result = await runHelp({ prompt: '   ' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('printable characters');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('errors rather than waiting when main accepts but returns no requestId', async () => {
    scriptStatuses([{ state: 'continued' }], {});
    const result = await runHelp({ prompt: 'Sign in' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('returned no requestId');
  });
});

describe('browser_request_help ref highlighting', () => {
  it('says so when the ref could not be resolved, and still waits', async () => {
    scriptStatuses([{ state: 'continued', url: 'https://example.test/x' }], {
      requestId: 'req-1',
      highlighted: false,
    });
    const text = textOf(await runHelp({ prompt: 'Click the outlined button', ref: 'e9' }));
    expect(text).toContain('ref "e9" could not be resolved');
    expect(text).toContain('help_state: continued');
  });

  it('adds no note when the highlight landed', async () => {
    scriptStatuses([{ state: 'continued' }], { requestId: 'req-1', highlighted: true });
    const text = textOf(await runHelp({ prompt: 'Click the outlined button', ref: 'e9' }));
    expect(text).not.toContain('could not be resolved');
  });
});

describe('browser_request_help polling', () => {
  it('polls status rather than holding one long RPC', async () => {
    scriptStatuses([
      { state: 'pending' },
      { state: 'pending' },
      { state: 'pending' },
      { state: 'continued' },
    ]);
    await runHelp({ prompt: 'Sign in' });
    const statusCalls = mockSendRpc.mock.calls.filter((c) => c[0] === 'browser.help.status');
    expect(statusCalls.length).toBe(4);
    // Every poll names the request it opened.
    for (const call of statusCalls) {
      expect((call[1] as { requestId?: unknown }).requestId).toBe('req-1');
    }
  });

  it('keeps polling through a transient status failure', async () => {
    let n = 0;
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.help.request') {
        return Promise.resolve({ requestId: 'req-1', highlighted: null });
      }
      n += 1;
      if (n === 1) return Promise.reject(new Error('RPC timeout: browser.help.status (10000ms)'));
      return Promise.resolve({ state: 'continued' });
    });
    const text = textOf(await runHelp({ prompt: 'Sign in' }));
    expect(text).toContain('help_state: continued');
  });
});
