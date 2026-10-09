import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';

/*
 * The wired path: a tool call under the automation lease raises a dialog, the
 * lease puts the [modal] block on that result (an error result too), and the
 * browser_dialog TOOL answers it, after which the block is gone.
 */

const { mockSendRpc, engine } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  engine: { page: undefined as unknown },
}));

vi.mock('../../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

// The engine resolves the page and attaches tracking exactly as
// getPageForScope does for an agent-owned tab: same key function, same scope.
vi.mock('../../PlaywrightEngine', async () => {
  const modal = await import('../../modalState');
  return {
    PlaywrightEngine: {
      getInstance: () => ({
        drainLocalLifecycle: () => [],
        getPageForScope: async (scope: { workspaceId?: string; surfaceId?: string }) => {
          const page = engine.page as Page;
          modal.attachModalTracking(page, {
            scopeKey: modal.modalScopeKey(scope.workspaceId, scope.surfaceId),
            fileChooser: true,
          });
          return page;
        },
      }),
    },
  };
});

import { withAutomationLease } from '../../automationLease';
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

beforeEach(() => {
  __resetSurfaceRoutingForTesting();
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation((method: string) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
    if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
    return Promise.resolve({});
  });
});

describe('[modal] through the lease and the browser_dialog tool', () => {
  it('a dialog raised inside a tool call is on that result, and answered by the tool', async () => {
    const fake = makeFakePage();
    engine.page = fake.page;
    const dialog = fakeDialog('alert', 'Saved!');

    const clicked = await withAutomationLease(deps, 'surf-1', async (scope) => {
      await PlaywrightEngine.getInstance().getPageForScope(scope, { intent: 'write' });
      fake.page.emit('dialog', dialog);
      return { content: [{ type: 'text', text: 'Clicked element ref=e1' }] };
    });
    expect(clicked.content[0].text).toMatch(/^\[modal\]\n- alert: "Saved!"/);
    expect(clicked.content[1].text).toBe('Clicked element ref=e1');

    // A read that failed on the open dialog carries the explanation too.
    const failedRead = await withAutomationLease(deps, 'surf-1', async () => ({
      content: [{ type: 'text', text: 'JavaScript dialog interrupted evaluation' }],
      isError: true,
    }));
    expect(failedRead.content[0].text).toContain('[modal]');

    const answered = await dialogTool()({ accept: true, surfaceId: 'surf-1' });
    expect(answered.content.map((c) => c.text).join('\n')).toContain('The alert was accepted.');
    expect(answered.content[0].text).not.toContain('[modal]');
    expect(dialog.accept).toHaveBeenCalled();

    const after = await withAutomationLease(deps, 'surf-1', async () => ({
      content: [{ type: 'text', text: 'snapshot' }],
    }));
    expect(after.content).toHaveLength(1);
  });

  it('a dialog nobody’s call raised is shown, but the tool refuses to answer it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fake = makeFakePage();
      engine.page = fake.page;
      await withAutomationLease(deps, 'surf-2', async (scope) => {
        await PlaywrightEngine.getInstance().getPageForScope(scope, { intent: 'write' });
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      vi.setSystemTime(Date.now() + 5_000);
      const dialog = fakeDialog('confirm', 'Leave the call?');
      fake.page.emit('dialog', dialog);

      const refused = await dialogTool()({ accept: true, surfaceId: 'surf-2' });
      expect(refused.isError).toBe(true);
      const text = refused.content.map((c) => c.text).join('\n');
      expect(text).toContain('did not open from an agent action');
      expect(text).toContain('error_code: dialog_blocked');
      expect(dialog.accept).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
