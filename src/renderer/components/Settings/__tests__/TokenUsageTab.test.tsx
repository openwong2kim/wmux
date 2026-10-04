// @vitest-environment jsdom
/**
 * Settings › Agents › Token usage. The repo's vitest config is node-env, so the
 * view is rendered with renderToStaticMarkup (same as the role-binding tests);
 * what Apply writes is covered by src/shared/__tests__/tokenProfiles.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenUsageView, type TokenUsageViewProps } from '../tabs/TokenUsageTab';
import { t as translate } from '../../../i18n';
import { applyTokenProfile } from '../../../../shared/tokenProfiles';
import type { OrchestratorRoleBindings } from '../../../../shared/orchestratorRole';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = translate as unknown as TokenUsageViewProps['t'];

const BOUND: OrchestratorRoleBindings = {
  Planner: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  Builder: { agent: 'agy', model: 'gemini-3.8-flash-high', skipPermissions: true },
  Tester: { agent: 'agy', model: 'gemini-3.8-flash-high' },
  Reviewer: { agent: 'codex', model: 'gpt-6-sol', effort: 'high' },
};

function render(bindings: OrchestratorRoleBindings): string {
  return renderToStaticMarkup(
    createElement(TokenUsageView, {
      bindings,
      onApply: () => undefined,
      onOpenTab: () => undefined,
      deckBrainModel: 'claude-sonnet-5-5',
      deckBrainEffort: 'medium',
      t,
    }),
  );
}

describe('TokenUsageView', () => {
  it('with no bound role offers only the way to Roles & fan-out', () => {
    const html = render({});
    expect(html).toContain('Bind roles first');
    expect(html).not.toContain('token-profile-apply');
    expect(html).not.toContain('data-token-role=');
  });

  it('shows Custom and previews every change before Apply', () => {
    const html = render(BOUND);
    expect(html).toMatch(/data-testid="token-profile-current"[^>]*>Custom</);
    expect(html).toContain('data-testid="token-profile-apply"');
    expect(html).toContain('Planner: claude-opus-5-5 · high → claude-sonnet-5-5 · low · tools role');
    expect(html).toContain('Builder: gemini-3.8-flash-high · high → gemini-3.8-flash-low · low · tools role');
    expect(html).toContain('Reviewer: gpt-6-sol · high → gpt-6-sol · low · tools role');
    expect(html).toContain('>Full<');
    expect(html).toContain('>Coding<');
  });

  it('once applied, reads Minimal and has nothing to apply', () => {
    const html = render(applyTokenProfile(BOUND, 'minimal'));
    expect(html).toMatch(/data-testid="token-profile-current"[^>]*>Minimal</);
    expect(html).toContain('token-profile-nochanges');
    expect(html).not.toContain('token-profile-apply');
  });

  it('shows shared pane note when Builder and Tester share an agent', () => {
    const html = render(BOUND);
    expect(html).toContain('data-testid="token-shared-pane"');
    expect(html).toContain('Builder and Tester share one agy pane; that pane runs the Builder launch.');
  });

  it('does not show shared pane note when Builder and Tester have different agents or are unbound', () => {
    const htmlDiff = render({
      Builder: { agent: 'agy', model: 'gemini-3.8-flash-high' },
      Tester: { agent: 'claude', model: 'claude-sonnet-5-5' },
    });
    expect(htmlDiff).not.toContain('data-testid="token-shared-pane"');

    const htmlOnlyBuilder = render({
      Builder: { agent: 'agy', model: 'gemini-3.8-flash-high' },
    });
    expect(htmlOnlyBuilder).not.toContain('data-testid="token-shared-pane"');
  });

  it('shows the Deck brain model and effort with a link to Moa settings', () => {
    const html = render(BOUND);
    expect(html).toContain('claude-sonnet-5-5 · medium');
    expect(html).toContain('Open Moa settings');
  });

  it('toggles Custom panel when clicking the badge or using keyboard', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(TokenUsageView, {
          bindings: BOUND,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    const badge = container.querySelector('[data-testid="token-profile-current"]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('role')).toBe('button');
    expect(badge.getAttribute('tabindex')).toBe('0');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeNull();

    // Click to show Custom panel
    act(() => {
      badge.click();
    });
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="token-custom-panel"]')?.textContent).not.toContain('not implemented');

    // Keyboard activation (Enter) to hide
    act(() => {
      badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeNull();

    // Keyboard activation (Space) to show
    act(() => {
      badge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeTruthy();

    // Click again to hide Custom panel
    act(() => {
      badge.click();
    });
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('opens the Custom panel from a real Customize button and scrolls it into view', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: BOUND,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    const button = container.querySelector('[data-testid="token-customize-button"]') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => {
      button.click();
    });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await act(async () => {
      button.click();
    });
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('toggles Custom panel when clicking the surface badge or using keyboard on it', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(TokenUsageView, {
          bindings: BOUND,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    const surfaceBadge = container.querySelector('[data-testid="token-surface-badge"]') as HTMLElement;
    expect(surfaceBadge).toBeTruthy();
    expect(surfaceBadge.getAttribute('role')).toBe('button');
    expect(surfaceBadge.getAttribute('tabindex')).toBe('0');
    expect(surfaceBadge.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeNull();

    // Click to show Custom panel
    act(() => {
      surfaceBadge.click();
    });
    expect(surfaceBadge.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeTruthy();

    // Keyboard activation (Enter) to hide
    act(() => {
      surfaceBadge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(surfaceBadge.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeNull();

    // Keyboard activation (Space) to show
    act(() => {
      surfaceBadge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(surfaceBadge.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-panel"]')).toBeTruthy();

    act(() => {
      root.unmount();
    });
  });

  it('passes active providers down to QuotaSection and CustomPanel', async () => {
    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: vi.fn().mockResolvedValue({ items: [] }),
        readQuota: vi.fn().mockResolvedValue({}),
        listProfiles: vi.fn().mockResolvedValue([]),
        reconcileSurface: vi.fn().mockResolvedValue({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false }),
      },
    };

    const container = document.createElement('div');
    const root = createRoot(container);
    const singleBound: OrchestratorRoleBindings = {
      Builder: { agent: 'claude', model: 'claude-opus-5-5' },
    };

    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: singleBound,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    // Quota cards: only claude should be rendered
    expect(container.querySelector('[data-testid="quota-card-claude"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="quota-card-codex"]')).toBeNull();
    expect(container.querySelector('[data-testid="quota-card-agy"]')).toBeNull();

    // Open custom panel
    const badge = container.querySelector('[data-testid="token-profile-current"]') as HTMLElement;
    await act(async () => {
      badge.click();
    });

    // Custom controls tabs: only claude should be rendered
    const tabs = container.querySelector('[data-testid="token-custom-provider-tabs"]');
    expect(tabs?.textContent).toContain('Claude Code');
    expect(tabs?.textContent).not.toContain('Codex');
    expect(tabs?.textContent).not.toContain('Antigravity');

    await act(async () => {
      root.unmount();
    });
    delete (window as any).electronAPI;
  });

  it('derives surface badge text as "Surface: default" when all non-wmux items are enabled', async () => {
    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: vi.fn().mockResolvedValue({
          items: [
            { id: '1', enabled: true, toggleable: true, wmuxRequired: false, source: 'user' },
            { id: '2', enabled: false, toggleable: true, wmuxRequired: true, source: 'wmux' },
          ],
        }),
        readQuota: vi.fn().mockResolvedValue({}),
        listProfiles: vi.fn().mockResolvedValue([]),
        reconcileSurface: vi.fn().mockResolvedValue({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false }),
      },
    };

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: BOUND,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    const surfaceBadge = container.querySelector('[data-testid="token-surface-badge"]');
    expect(surfaceBadge?.textContent).toBe('Surface: default');

    await act(async () => {
      root.unmount();
    });
    delete (window as any).electronAPI;
  });

  it('derives surface badge text as "Surface: N off" when non-wmux items are disabled', async () => {
    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: vi.fn().mockResolvedValue({
          items: [
            { id: '1', enabled: false, toggleable: true, wmuxRequired: false, source: 'user' },
            { id: '2', enabled: false, toggleable: true, wmuxRequired: false, source: 'project' },
            { id: '3', enabled: true, toggleable: true, wmuxRequired: false, source: 'user' },
            { id: '4', enabled: false, toggleable: true, wmuxRequired: true, source: 'wmux' },
          ],
        }),
        readQuota: vi.fn().mockResolvedValue({}),
        listProfiles: vi.fn().mockResolvedValue([]),
        reconcileSurface: vi.fn().mockResolvedValue({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false }),
      },
    };

    const container = document.createElement('div');
    const root = createRoot(container);

    // Provide singleBound so readInventory is only called once for 'claude'
    const singleBound: OrchestratorRoleBindings = {
      Builder: { agent: 'claude', model: 'claude-opus-5-5' },
    };

    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: singleBound,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    const surfaceBadge = container.querySelector('[data-testid="token-surface-badge"]');
    expect(surfaceBadge?.textContent).toBe('Surface: 2 off');

    await act(async () => {
      root.unmount();
    });
    delete (window as any).electronAPI;
  });

  it('ignores stale inventory response when a newer request completes first', async () => {
    function createDeferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const firstDeferred = createDeferred<any>();
    const secondDeferred = createDeferred<any>();
    let callCount = 0;

    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return firstDeferred.promise;
          return secondDeferred.promise;
        }),
        readQuota: vi.fn().mockResolvedValue({}),
        listProfiles: vi.fn().mockResolvedValue([]),
        reconcileSurface: vi.fn().mockResolvedValue({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false }),
      },
    };

    const container = document.createElement('div');
    const root = createRoot(container);

    const singleBound1: OrchestratorRoleBindings = {
      Builder: { agent: 'claude', model: 'claude-opus-5-5' },
    };
    const singleBound2: OrchestratorRoleBindings = {
      Builder: { agent: 'codex', model: 'gpt-6-sol' },
    };

    // Render with first binding -> triggers callCount 1
    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: singleBound1,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    // Re-render with second binding -> triggers callCount 2
    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: singleBound2,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    // Resolve second request first with 3 off
    await act(async () => {
      secondDeferred.resolve({
        items: [
          { id: '1', enabled: false, toggleable: true, wmuxRequired: false, source: 'user' },
          { id: '2', enabled: false, toggleable: true, wmuxRequired: false, source: 'user' },
          { id: '3', enabled: false, toggleable: true, wmuxRequired: false, source: 'user' },
        ],
      });
    });

    const surfaceBadge = container.querySelector('[data-testid="token-surface-badge"]');
    expect(surfaceBadge?.textContent).toBe('Surface: 3 off');

    // Resolve first request later with 0 off (stale)
    await act(async () => {
      firstDeferred.resolve({
        items: [],
      });
    });

    // Badge should still be "Surface: 3 off", not overwritten by the stale first response
    expect(surfaceBadge?.textContent).toBe('Surface: 3 off');

    await act(async () => {
      root.unmount();
    });
    delete (window as any).electronAPI;
  });

  it('refreshSurfaceState uses Promise.allSettled: preserves successful providers and appends "(some unavailable)" on failure', async () => {
    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: vi.fn().mockImplementation(({ provider }: { provider: string }) => {
          if (provider === 'claude') {
            return Promise.resolve({
              provider: 'claude',
              items: [
                { id: 'claude:1', enabled: false, toggleable: true, wmuxRequired: false, source: 'user' },
                { id: 'claude:2', enabled: false, toggleable: true, wmuxRequired: false, source: 'project' },
              ],
            });
          }
          if (provider === 'codex') {
            return Promise.reject(new Error('Codex connection timed out'));
          }
          return Promise.resolve({ items: [] });
        }),
        readQuota: vi.fn().mockResolvedValue({}),
        listProfiles: vi.fn().mockResolvedValue([]),
        reconcileSurface: vi.fn().mockResolvedValue({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false }),
      },
    };

    const container = document.createElement('div');
    const root = createRoot(container);

    const dualBound: OrchestratorRoleBindings = {
      Builder: { agent: 'claude', model: 'claude-opus-5-5' },
      Reviewer: { agent: 'codex', model: 'gpt-6-sol' },
    };

    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: dualBound,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    const surfaceBadge = container.querySelector('[data-testid="token-surface-badge"]');
    expect(surfaceBadge?.textContent).toBe('Surface: 2 off (some unavailable)');

    await act(async () => {
      root.unmount();
    });
    delete (window as any).electronAPI;
  });

  it('when only unsupported agents are bound, QuotaSection shows empty note and CustomPanel shows all 3 providers', async () => {
    const mockReadQuota = vi.fn().mockResolvedValue({});
    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: vi.fn().mockResolvedValue({
          provider: 'claude',
          items: [],
        }),
        readQuota: mockReadQuota,
        listProfiles: vi.fn().mockResolvedValue([]),
        reconcileSurface: vi.fn().mockResolvedValue({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false }),
      },
    };

    const container = document.createElement('div');
    const root = createRoot(container);

    const unsupportedBound: OrchestratorRoleBindings = {
      Builder: { agent: 'custom-cli', model: 'custom-model' },
    };

    await act(async () => {
      root.render(
        createElement(TokenUsageView, {
          bindings: unsupportedBound,
          onApply: () => undefined,
          onOpenTab: () => undefined,
          deckBrainModel: 'claude-sonnet-5-5',
          deckBrainEffort: 'medium',
          t,
        }),
      );
    });

    // Quota section shows empty note and fetches nothing
    expect(container.textContent).toContain('No supported agent is bound to a role');
    expect(container.querySelector('[data-testid="token-quota-empty"]')).not.toBeNull();
    expect(mockReadQuota).not.toHaveBeenCalled();

    // Toggle custom panel
    const surfaceBadge = container.querySelector('[data-testid="token-surface-badge"]') as HTMLElement;
    await act(async () => {
      surfaceBadge.click();
    });

    // Custom panel is open and shows all 3 providers
    expect(container.querySelector('[data-testid="token-custom-panel"]')).not.toBeNull();
    const providerTabs = container.querySelectorAll('[data-testid="token-custom-provider-tabs"] button[role="radio"]');
    expect(providerTabs.length).toBe(3);

    await act(async () => {
      root.unmount();
    });
    delete (window as any).electronAPI;
  });
});
