import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';

/*
 * The wired path: a dialog raised inside a tool call is dismissed (today's
 * behaviour) and noted on that same result — including when the body throws
 * past its own catch — and browser_dialog arms only on an agent-owned tab.
 */

const { mockSendRpc, engine } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  engine: { page: undefined as unknown, owner: 'agent' as string },
}));

vi.mock('../../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

// Resolves the page and attaches tracking the way getPageForScope does for a
// write: same key function, same scope.
vi.mock('../../PlaywrightEngine', async () => {
  const modal = await import('../../modalState');
  return {
    PlaywrightEngine: {
      getInstance: () => ({
        drainLocalLifecycle: () => [],
        dialogOwnerOf: async () => engine.owner,
        getPageForScope: async (scope: { workspaceId?: string; surfaceId?: string }) => {
          const page = engine.page as Page;
          modal.attachModalTracking(page, modal.modalScopeKey(scope.workspaceId, scope.surfaceId));
          return page;
        },
      }),
    },
  };
});

import { leasedMutation, withAutomationLease } from '../../automationLease';
import { PlaywrightEngine } from '../../PlaywrightEngine';
import { registerFileTools } from '../../tools/file';
import { __resetSurfaceRoutingForTesting } from '../../surfaceRouting';
import { fakeDialog, makeFakePage } from './fakePage';

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function dialogTool(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (name: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (name === 'browser_dialog') handler = h;
    },
  };
  registerFileTools(server as never, deps);
  if (!handler) throw new Error('browser_dialog failed to register');
  return handler;
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

beforeEach(() => {
  __resetSurfaceRoutingForTesting();
  engine.owner = 'agent';
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
    return Promise.resolve({});
  });
});

describe('[modal] notes through the lease', () => {
  it('a dialog raised inside a tool call is dismissed and noted on that result', async () => {
    const fake = makeFakePage();
    engine.page = fake.page;
    const dialog = fakeDialog('alert', 'Saved!');

    const clicked = await withAutomationLease(deps, 'surf-1', async (scope) => {
      await PlaywrightEngine.getInstance().getPageForScope(scope, { intent: 'write' });
      fake.page.emit('dialog', dialog);
      return { content: [{ type: 'text', text: 'Clicked element ref=e1' }] };
    });
    expect(dialog.dismiss).toHaveBeenCalled();
    expect(clicked.content[0].text).toMatch(/^\[modal\]\n- an alert appeared and was dismissed/);
    expect(clicked.content[1].text).toBe('Clicked element ref=e1');

    const next = await withAutomationLease(deps, 'surf-1', async () => ({
      content: [{ type: 'text', text: 'snapshot' }],
    }));
    expect(next.content).toHaveLength(1);
  });

  it('a body that throws past its own catch still carries the note', async () => {
    const fake = makeFakePage();
    engine.page = fake.page;
    const result = await leasedMutation(deps, 'surf-2', async (scope) => {
      await PlaywrightEngine.getInstance().getPageForScope(scope, { intent: 'write' });
      fake.page.emit('dialog', fakeDialog('confirm', 'Sure?'));
      throw new Error('navigation interrupted');
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as ToolResult)).toContain('[modal]\n- a confirm appeared and was dismissed');
    expect(textOf(result as ToolResult)).toContain('navigation interrupted');
  });
});

describe('browser_dialog', () => {
  it('arms on an agent-owned tab', async () => {
    const fake = makeFakePage();
    engine.page = fake.page;
    const result = await dialogTool()({ accept: true, surfaceId: 'surf-3' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Dialog handler set. Next dialog will be accepted.');
  });

  it('refuses on a tab the user lent, leaving the page untouched', async () => {
    const fake = makeFakePage();
    engine.page = fake.page;
    engine.owner = 'borrowed';
    const result = await dialogTool()({ accept: true, surfaceId: 'surf-4' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('left to the person using it');
    expect(textOf(result)).toContain('effect_state: none');
  });
});
