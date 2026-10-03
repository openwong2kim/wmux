// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { CustomPanel, type CustomPanelProps, assertProviderMatches, buildPayloadChanges } from '../CustomPanel';
import type { ProviderInventory, SurfaceProviderId } from '../../../../../../shared/tokenUsage/surfaceTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockClaudeInventory: ProviderInventory = {
  provider: 'claude',
  cliVersion: '1.0.5',
  versionSupported: true,
  writable: true,
  items: [
    {
      id: 'claude:mcp-server::my-server',
      provider: 'claude',
      kind: 'mcp-server',
      name: 'my-server',
      parent: null,
      source: 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: '/home/.claude.json',
      wmuxRequired: false,
    },
    {
      id: 'claude:mcp-tool:my-server:tool-a',
      provider: 'claude',
      kind: 'mcp-tool',
      name: 'tool-a',
      parent: 'my-server',
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: '/home/.claude.json',
      wmuxRequired: false,
    },
    {
      id: 'claude:skill::my-skill',
      provider: 'claude',
      kind: 'skill',
      name: 'my-skill',
      parent: null,
      source: 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: 42,
      originPath: '/home/.claude/skills/my-skill/SKILL.md',
      wmuxRequired: false,
    },
    {
      id: 'claude:plugin::my-plugin',
      provider: 'claude',
      kind: 'plugin',
      name: 'my-plugin',
      parent: null,
      source: 'user',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: '/home/.claude/settings.json',
      wmuxRequired: false,
    },
    {
      id: 'claude:hook::my-hook',
      provider: 'claude',
      kind: 'hook',
      name: 'my-hook',
      parent: null,
      source: 'wmux',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: 'SessionStart',
      hookCost: 'injects-context',
      descriptionChars: null,
      originPath: '/home/.claude/settings.json',
      wmuxRequired: true,
    },
    {
      id: 'claude:builtin-tool::WebSearch',
      provider: 'claude',
      kind: 'builtin-tool',
      name: 'WebSearch',
      parent: null,
      source: 'builtin',
      enabled: false,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: '/home/.claude/settings.json',
      wmuxRequired: false,
    },
    {
      id: 'claude:builtin-tool::ReadMe',
      provider: 'claude',
      kind: 'builtin-tool',
      name: 'ReadMe',
      parent: null,
      source: 'builtin',
      enabled: true,
      effect: 'none',
      toggleable: false,
      readOnlyReason: 'managed by CLI',
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: null,
      wmuxRequired: false,
    },
  ],
  warnings: ['Sample test warning about tools/list'],
  scannedAtMs: 123456789,
};

const mockCodexInventory: ProviderInventory = {
  provider: 'codex',
  cliVersion: '0.159.2',
  versionSupported: true,
  writable: true,
  items: [
    {
      id: 'codex:mcp-server::codex-server',
      provider: 'codex',
      kind: 'mcp-server',
      name: 'codex-server',
      parent: null,
      source: 'user',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: '/home/.codex/config.toml',
      wmuxRequired: false,
    },
  ],
  warnings: [],
  scannedAtMs: 123456789,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CustomPanel UI', () => {
  let readInventoryMock: ReturnType<typeof vi.fn>;
  let previewChangesMock: ReturnType<typeof vi.fn>;
  let applyChangesMock: ReturnType<typeof vi.fn>;
  let reconcileSurfaceMock: ReturnType<typeof vi.fn>;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    readInventoryMock = vi.fn().mockImplementation(async ({ provider }) => {
      if (provider === 'claude') return mockClaudeInventory;
      if (provider === 'codex') return mockCodexInventory;
      return {
        provider,
        cliVersion: null,
        versionSupported: false,
        writable: false,
        items: [],
        warnings: [],
        scannedAtMs: Date.now(),
      };
    });

    previewChangesMock = vi.fn().mockImplementation(async ({ provider, changes }) => {
      return {
        provider,
        edits: changes.map((c: { itemId: string; enabled: boolean }) => ({
          path: '/home/.claude/settings.json',
          summary: `set ${c.itemId} = ${c.enabled}`,
        })),
        rejected: [],
        requiresNewSession: true,
      };
    });

    applyChangesMock = vi.fn().mockImplementation(async ({ provider, changes }) => {
      return {
        provider,
        ok: true,
        appliedItemIds: changes.map((c: { itemId: string; enabled: boolean }) => c.itemId),
        backups: ['/home/.claude/settings.json.bak'],
        error: null,
      };
    });

    reconcileSurfaceMock = vi.fn().mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedItems: [],
      driftedCount: 0,
      truncated: false,
    });

    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: readInventoryMock,
        previewChanges: previewChangesMock,
        applyChanges: applyChangesMock,
        reconcileSurface: reconcileSurfaceMock,
      },
    };
  });

  afterEach(() => {
    document.body.removeChild(container);
    delete (window as any).electronAPI;
    vi.restoreAllMocks();
  });

  it('renders initial panel with claude inventory and placeholder note', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // The panel is the editor itself: no placeholder saying it is not built yet.
    expect(container.querySelector('[data-testid="token-custom-panel"]')?.textContent).not.toContain('not implemented');

    expect(readInventoryMock).toHaveBeenCalledWith({ provider: 'claude' });

    expect(container.textContent).toContain('my-server');
    expect(container.textContent).toContain('tool-a');
    expect(container.textContent).toContain('my-skill');
    expect(container.textContent).toContain('42 chars');
    expect(container.textContent).toContain('my-plugin');
    expect(container.textContent).toContain('my-hook');
    expect(container.textContent).toContain('injects-context');
    expect(container.textContent).toContain('needed by wmux');
    expect(container.textContent).toContain('WebSearch');

    expect(container.querySelector('[data-testid="token-custom-warnings"]')?.textContent).toContain(
      'Sample test warning about tools/list',
    );

    expect(container.textContent).toContain('Changes take effect on the next CLI session.');

    const readOnlyRow = container.querySelector('[data-testid="builtin-ReadMe"]');
    expect(readOnlyRow?.querySelector('input[type="checkbox"]')).toBeNull();
    expect(readOnlyRow?.querySelector('[role="switch"]')).toBeNull();
    expect(readOnlyRow?.textContent).toContain('managed by CLI');

    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow?.querySelector('[role="switch"]')).not.toBeNull();
    expect(serverRow?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      root.unmount();
    });
  });

  it('switching provider tab loads the new provider inventory', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    expect(readInventoryMock).toHaveBeenCalledWith({ provider: 'claude' });

    const codexButton = container.querySelector('button[role="radio"][aria-checked="false"]') as HTMLButtonElement;
    expect(codexButton).toBeTruthy();

    await act(async () => {
      codexButton.click();
    });

    expect(readInventoryMock).toHaveBeenCalledWith({ provider: 'codex' });
    expect(container.textContent).toContain('codex-server');

    await act(async () => {
      root.unmount();
    });
  });

  it('search box filters items by name', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const searchInput = container.querySelector('[data-testid="token-custom-search"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(searchInput, 'my-skill');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('my-skill');
    expect(container.textContent).not.toContain('WebSearch');

    await act(async () => {
      root.unmount();
    });
  });

  it('only changed checkbox filters to items where enabled is false', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const onlyChanged = container.querySelector('[data-testid="token-custom-only-changed"]') as HTMLElement;
    expect(onlyChanged).toBeTruthy();

    await act(async () => {
      onlyChanged.click();
    });

    expect(container.querySelector('[data-testid="skill-my-skill"]')).toBeNull();
    expect(container.querySelector('[data-testid="hook-my-hook"]')).toBeNull();

    expect(container.textContent).toContain('my-plugin');
    expect(container.textContent).toContain('WebSearch');
    expect(container.querySelector('[data-testid="mcp-server-my-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-server-header-my-server"]')?.className).toContain('opacity-60');
    expect(container.querySelector('[data-testid="mcp-tool-tool-a"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('when search filters out parent server but keeps child tool, still renders parent server row above the tool', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const searchInput = container.querySelector('[data-testid="token-custom-search"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(searchInput, 'tool-a');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow).not.toBeNull();
    const serverHeader = container.querySelector('[data-testid="mcp-server-header-my-server"]');
    expect(serverHeader?.className).toContain('opacity-60');

    expect(container.querySelector('[data-testid="mcp-tool-tool-a"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('staging and unstaging updates row, switch aria-checked, and toggles sticky action bar', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    const skillRow = container.querySelector('[data-testid="skill-my-skill"]');
    const skillSwitch = skillRow?.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(skillSwitch).toBeTruthy();
    expect(skillSwitch.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      skillSwitch.click();
    });

    expect(skillSwitch.getAttribute('aria-checked')).toBe('false');
    expect(skillRow?.getAttribute('data-staged')).toBe('true');
    expect(skillRow?.textContent).toContain('staged');

    const actionBar = container.querySelector('[data-testid="token-custom-action-bar"]');
    expect(actionBar).not.toBeNull();
    expect(actionBar?.textContent).toContain('1 change');

    await act(async () => {
      skillSwitch.click();
    });

    expect(skillSwitch.getAttribute('aria-checked')).toBe('true');
    expect(skillRow?.getAttribute('data-staged')).toBeNull();
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('discard button clears all staged changes', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    const serverSwitch = container.querySelector('[data-testid="toggle-mcp-server-my-server"]') as HTMLButtonElement;

    await act(async () => {
      skillSwitch.click();
      serverSwitch.click();
    });

    const actionBar = container.querySelector('[data-testid="token-custom-action-bar"]');
    expect(actionBar?.textContent).toContain('2 changes');

    const discardBtn = container.querySelector('[data-testid="token-custom-discard"]') as HTMLButtonElement;
    expect(discardBtn).toBeTruthy();

    await act(async () => {
      discardBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();
    expect(skillSwitch.getAttribute('aria-checked')).toBe('true');
    expect(serverSwitch.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      root.unmount();
    });
  });

  it('preview rendering (edits + rejected) and un-stages rejected items', async () => {
    previewChangesMock.mockResolvedValueOnce({
      provider: 'claude',
      edits: [
        { path: '/home/.claude/settings.json', summary: 'disable my-skill' },
      ],
      rejected: [
        { itemId: 'claude:mcp-server::my-server', reason: 'Server locked by daemon' },
      ],
      requiresNewSession: true,
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    const serverSwitch = container.querySelector('[data-testid="toggle-mcp-server-my-server"]') as HTMLButtonElement;

    await act(async () => {
      skillSwitch.click();
      serverSwitch.click();
    });

    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    expect(previewChangesMock).toHaveBeenCalledWith({
      provider: 'claude',
      changes: [
        { itemId: 'claude:skill::my-skill', enabled: false },
        { itemId: 'claude:mcp-server::my-server', enabled: false },
      ],
    });

    const dialog = container.querySelector('[data-testid="token-custom-preview-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('/home/.claude/settings.json');
    expect(dialog?.textContent).toContain('disable my-skill');
    expect(dialog?.textContent).toContain('Server locked by daemon');
    expect(dialog?.textContent).toContain('Takes effect in the next CLI session.');

    const backBtn = container.querySelector('[data-testid="token-custom-preview-back"]') as HTMLButtonElement;
    await act(async () => {
      backBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-preview-dialog"]')).toBeNull();
    const actionBar = container.querySelector('[data-testid="token-custom-action-bar"]');
    expect(actionBar?.textContent).toContain('1 change');

    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow?.textContent).toContain('Server locked by daemon');

    await act(async () => {
      root.unmount();
    });
  });

  it('apply sends exactly the right payload and succeeds', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    const applyBtn = container.querySelector('[data-testid="token-custom-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    expect(applyChangesMock).toHaveBeenCalledWith({
      provider: 'claude',
      changes: [{ itemId: 'claude:skill::my-skill', enabled: false }],
      allowWmuxRequired: undefined,
    });

    expect(container.querySelector('[data-testid="token-custom-apply-result"]')?.textContent).toContain(
      'Changes applied successfully.',
    );
    expect(container.textContent).toContain('/home/.claude/settings.json.bak');
    expect(container.textContent).toContain('Takes effect in the next CLI session.');

    expect(readInventoryMock).toHaveBeenCalledTimes(2);

    const doneBtn = container.querySelector('[data-testid="token-custom-apply-done"]') as HTMLButtonElement;
    await act(async () => {
      doneBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('wmux-required confirmation gate (no allowWmuxRequired before confirm, true after)', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const hookSwitch = container.querySelector('[data-testid="toggle-hook-my-hook"]') as HTMLButtonElement;
    await act(async () => {
      hookSwitch.click();
    });

    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    const applyBtn = container.querySelector('[data-testid="token-custom-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    expect(applyChangesMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="token-custom-wmux-confirm"]')?.textContent).toContain(
      'wmux needs this item; disabling it can break wmux features in that CLI',
    );

    await act(async () => {
      applyBtn.click();
    });

    expect(applyChangesMock).toHaveBeenCalledWith({
      provider: 'claude',
      changes: [{ itemId: 'claude:hook::my-hook', enabled: false }],
      allowWmuxRequired: true,
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('error keeps staging and reloads inventory', async () => {
    applyChangesMock.mockResolvedValueOnce({
      provider: 'claude',
      ok: false,
      appliedItemIds: [],
      backups: [],
      error: 'Permission denied on settings file',
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    const applyBtn = container.querySelector('[data-testid="token-custom-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-apply-result"]')?.textContent).toContain(
      'Failed to apply changes: Permission denied on settings file',
    );
    expect(readInventoryMock).toHaveBeenCalledTimes(2);

    const backBtn = container.querySelector('[data-testid="token-custom-apply-back"]') as HTMLButtonElement;
    await act(async () => {
      backBtn.click();
    });

    const closeBtn = container.querySelector('.ui-dialog-close') as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent).toContain('1 change');

    await act(async () => {
      root.unmount();
    });
  });

  it('provider switch with staged changes prompts to discard or stay', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    const codexTab = container.querySelector('button[role="radio"][aria-checked="false"]') as HTMLButtonElement;
    await act(async () => {
      codexTab.click();
    });

    const discardDialog = container.querySelector('[data-testid="token-custom-discard-dialog"]');
    expect(discardDialog).not.toBeNull();
    expect(discardDialog?.textContent).toContain('Switching providers will discard your 1 staged change.');
    expect(readInventoryMock).toHaveBeenCalledTimes(1);

    const stayBtn = container.querySelector('[data-testid="token-custom-stay-btn"]') as HTMLButtonElement;
    await act(async () => {
      stayBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-discard-dialog"]')).toBeNull();
    expect(readInventoryMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).not.toBeNull();

    await act(async () => {
      codexTab.click();
    });

    const discardConfirmBtn = container.querySelector('[data-testid="token-custom-discard-confirm-btn"]') as HTMLButtonElement;
    await act(async () => {
      discardConfirmBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-discard-dialog"]')).toBeNull();
    expect(readInventoryMock).toHaveBeenCalledWith({ provider: 'codex' });
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keyboard toggle with Space', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    expect(skillSwitch.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      skillSwitch.focus();
      skillSwitch.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    });

    expect(skillSwitch.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('cost hint for MCP servers shows count of staged tools', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const toolSwitch = container.querySelector('[data-testid="toggle-mcp-tool-tool-a"]') as HTMLButtonElement;
    expect(toolSwitch).toBeTruthy();

    await act(async () => {
      toolSwitch.click();
    });

    const serverHeader = container.querySelector('[data-testid="mcp-server-header-my-server"]');
    expect(serverHeader?.textContent).toContain('1 staged tool');

    await act(async () => {
      toolSwitch.click();
    });

    expect(serverHeader?.textContent).not.toContain('staged tool');

    await act(async () => {
      root.unmount();
    });
  });

  it('slow inventory for provider A after switching to B', async () => {
    const claudeDeferred = createDeferred<ProviderInventory>();
    readInventoryMock.mockImplementation(async ({ provider }) => {
      if (provider === 'claude') {
        return claudeDeferred.promise;
      }
      if (provider === 'codex') {
        return mockCodexInventory;
      }
      return {
        provider,
        cliVersion: null,
        versionSupported: false,
        writable: false,
        items: [],
        warnings: [],
        scannedAtMs: Date.now(),
      };
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Claude inventory is loading
    expect(container.textContent).toContain('Loading surface inventory...');

    // Switch to Codex while Claude request is still pending
    const codexTab = container.querySelector('button[role="radio"][aria-checked="false"]') as HTMLButtonElement;
    expect(codexTab).toBeTruthy();
    await act(async () => {
      codexTab.click();
    });

    // Codex inventory resolves and is displayed
    expect(container.querySelector('[data-testid="mcp-server-codex-server"]')).not.toBeNull();
    expect(container.textContent).not.toContain('my-server');

    // Stale slow Claude response finally resolves
    await act(async () => {
      claudeDeferred.resolve(mockClaudeInventory);
    });

    // Claude response must be dropped: Codex items remain, Claude items not rendered
    expect(container.querySelector('[data-testid="mcp-server-codex-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-server-my-server"]')).toBeNull();
    expect(container.querySelector('[data-testid="skill-my-skill"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('applies only what a successful preview showed', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });
    const click = async (testId: string) => {
      await act(async () => {
        (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
      });
    };
    const applyBtn = () => container.querySelector('[data-testid="token-custom-apply"]') as HTMLButtonElement;

    // Preview A succeeds for my-skill: Apply is enabled.
    await click('toggle-skill-my-skill');
    await click('token-custom-preview');
    expect(applyBtn().disabled).toBe(false);

    // Staging another row after the preview disables Apply until it is previewed again.
    await click('toggle-mcp-server-my-server');
    expect(applyBtn().disabled).toBe(true);

    // Preview B fails: preview A is gone and Apply stays disabled.
    previewChangesMock.mockRejectedValueOnce(new Error('preview B failed'));
    await click('token-custom-preview');
    expect(container.textContent).toContain('preview B failed');
    expect(applyBtn().disabled).toBe(true);
    await click('token-custom-apply');
    expect(applyChangesMock).not.toHaveBeenCalled();

    // A successful preview of the current set enables Apply, and Apply sends that set.
    await click('token-custom-preview');
    expect(applyBtn().disabled).toBe(false);
    await click('token-custom-apply');
    expect(applyChangesMock).toHaveBeenCalledTimes(1);
    const sent = applyChangesMock.mock.calls[0][0].changes.map((c: { itemId: string }) => c.itemId).sort();
    expect(sent).toEqual(['claude:mcp-server::my-server', 'claude:skill::my-skill']);

    await act(async () => {
      root.unmount();
    });
  });

  it('slow preview after staging another row', async () => {
    const previewDeferred = createDeferred<any>();
    previewChangesMock.mockImplementation(() => previewDeferred.promise);

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Stage first row: my-skill
    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    const skillRow = container.querySelector('[data-testid="skill-my-skill"]');
    expect(skillRow?.getAttribute('data-staged')).toBe('true');

    // Click Preview
    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-preview-dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Loading preview...');

    // While preview is in flight, stage another row: my-server
    const serverSwitch = container.querySelector('[data-testid="toggle-mcp-server-my-server"]') as HTMLButtonElement;
    await act(async () => {
      serverSwitch.click();
    });

    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow?.getAttribute('data-staged')).toBe('true');

    // Now the slow preview response arrives with rejected items for my-skill
    await act(async () => {
      previewDeferred.resolve({
        provider: 'claude',
        edits: [
          { path: '/home/.claude/settings.json', summary: 'stale edit' },
        ],
        rejected: [
          { itemId: 'claude:skill::my-skill', reason: 'Skill rejected by stale preview' },
        ],
        requiresNewSession: true,
      });
    });

    // The stale preview response must be dropped:
    // 1. my-skill must NOT be un-staged
    expect(skillRow?.getAttribute('data-staged')).toBe('true');
    // 2. my-server is still staged
    expect(serverRow?.getAttribute('data-staged')).toBe('true');
    // 3. rejected reason must NOT be displayed
    expect(container.textContent).not.toContain('Skill rejected by stale preview');
    // 4. stale edits must NOT be rendered
    expect(container.textContent).not.toContain('stale edit');

    await act(async () => {
      root.unmount();
    });
  });

  it('apply in flight then provider switch', async () => {
    const applyDeferred = createDeferred<any>();
    applyChangesMock.mockImplementation(() => applyDeferred.promise);

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Stage a row in Claude: my-skill
    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    // Click Preview and then Apply
    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    const applyBtn = container.querySelector('[data-testid="token-custom-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    expect(applyChangesMock).toHaveBeenCalledTimes(1);

    // While apply is in flight, switch provider to Codex
    const codexTab = container.querySelector('button[role="radio"][aria-checked="false"]') as HTMLButtonElement;
    await act(async () => {
      codexTab.click();
    });

    const discardConfirmBtn = container.querySelector('[data-testid="token-custom-discard-confirm-btn"]') as HTMLButtonElement;
    await act(async () => {
      discardConfirmBtn.click();
    });

    // Now Codex is active
    expect(container.querySelector('[data-testid="mcp-server-codex-server"]')).not.toBeNull();

    // Stage a row in Codex
    const codexServerSwitch = container.querySelector('[data-testid="toggle-mcp-server-codex-server"]') as HTMLButtonElement;
    await act(async () => {
      codexServerSwitch.click();
    });

    const codexRow = container.querySelector('[data-testid="mcp-server-codex-server"]');
    expect(codexRow?.getAttribute('data-staged')).toBe('true');

    // Now apply for Claude succeeds
    await act(async () => {
      applyDeferred.resolve({
        provider: 'claude',
        ok: true,
        appliedItemIds: ['claude:skill::my-skill'],
        backups: ['/home/.claude/settings.json.bak'],
        error: null,
      });
    });

    // 1. Codex staged row must NOT be cleared or touched
    expect(codexRow?.getAttribute('data-staged')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')?.textContent).toContain('1 change');

    // 2. Active view is still Codex, Claude inventory did not replace it
    expect(container.querySelector('[data-testid="mcp-server-codex-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-server-my-server"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('apply success while an extra row was staged after the click (the extra row stays staged)', async () => {
    const applyDeferred = createDeferred<any>();
    applyChangesMock.mockImplementation(() => applyDeferred.promise);

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Stage row 1: my-skill
    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    const skillRow = container.querySelector('[data-testid="skill-my-skill"]');
    expect(skillRow?.getAttribute('data-staged')).toBe('true');

    // Click Preview and then Apply
    const previewBtn = container.querySelector('[data-testid="token-custom-preview"]') as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });

    const applyBtn = container.querySelector('[data-testid="token-custom-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });

    expect(applyChangesMock).toHaveBeenCalledTimes(1);

    // Attempting to toggle row 1 (which is being applied) queues nothing:
    await act(async () => {
      skillSwitch.click();
    });
    // skill-my-skill remains in its staged state
    expect(skillRow?.getAttribute('data-staged')).toBe('true');

    // While apply is in flight, an extra row is staged: my-server
    const serverSwitch = container.querySelector('[data-testid="toggle-mcp-server-my-server"]') as HTMLButtonElement;
    await act(async () => {
      serverSwitch.click();
    });

    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow?.getAttribute('data-staged')).toBe('true');

    // Action bar reflects 2 changes
    expect(container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent).toContain('2 changes');

    // Now apply succeeds for my-skill
    await act(async () => {
      applyDeferred.resolve({
        provider: 'claude',
        ok: true,
        appliedItemIds: ['claude:skill::my-skill'],
        backups: ['/home/.claude/settings.json.bak'],
        error: null,
      });
    });

    // 1. Applied row (my-skill) is cleared from staged changes
    expect(skillRow?.getAttribute('data-staged')).toBeNull();

    // 2. Extra row (my-server) STAYS STAGED
    expect(serverRow?.getAttribute('data-staged')).toBe('true');

    // 3. Action bar remains with 1 staged change
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent).toContain('1 change');

    await act(async () => {
      root.unmount();
    });
  });

  it('filters provider tabs using providers prop but never hides a provider with staged changes', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel, { providers: ['claude', 'agy'] as SurfaceProviderId[] }));
    });

    const tabs = container.querySelector('[data-testid="token-custom-provider-tabs"]');
    expect(tabs?.textContent).toContain('Claude Code');
    expect(tabs?.textContent).toContain('Antigravity');
    expect(tabs?.textContent).not.toContain('Codex');

    // Stage a change on claude
    const skillSwitch = container.querySelector('[data-testid="toggle-skill-my-skill"]') as HTMLButtonElement;
    await act(async () => {
      skillSwitch.click();
    });

    // Now re-render with providers that only include agy (claude has staged changes)
    await act(async () => {
      root.render(createElement(CustomPanel, { providers: ['agy'] as SurfaceProviderId[] }));
    });

    // Claude must NOT be hidden because it has staged changes!
    expect(tabs?.textContent).toContain('Claude Code');
    expect(tabs?.textContent).toContain('Antigravity');

    await act(async () => {
      root.unmount();
    });
  });

  it('displays reconciliation notice, lists names, stages choices on re-apply, and dismisses', async () => {
    reconcileSurfaceMock.mockResolvedValue({
      newItems: 1,
      removedItems: 1,
      driftedCount: 1,
      truncated: false,
      driftedItems: [
        {
          itemId: 'claude:mcp-server::my-server',
          name: 'my-server',
          kind: 'mcp-server',
          wanted: false,
          actual: true,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Notice should be visible: 1 drift + 1 new + 1 removed = 3 changed
    const notice = container.querySelector('[data-testid="token-custom-reconcile-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('3 items changed outside wmux since you last applied');

    // Name of drifted item is listed (no-overflow case)
    const names = container.querySelector('[data-testid="token-custom-reconcile-names"]');
    expect(names?.textContent).toContain('my-server');
    expect(names?.textContent).not.toContain('more not shown');

    // Re-apply my choices button is present
    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    expect(reapplyBtn).toBeTruthy();

    // Click Re-apply my choices
    await act(async () => {
      reapplyBtn.click();
    });

    // my-server row should now be staged (wanted was false, live inventory had enabled: true)
    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow?.getAttribute('data-staged')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeTruthy();

    // Dismiss notice
    const dismissBtn = container.querySelector('[data-testid="token-custom-reconcile-dismiss"]') as HTMLButtonElement;
    expect(dismissBtn).toBeTruthy();
    await act(async () => {
      dismissBtn.click();
    });

    // Notice is now dismissed
    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).toBeNull();

    // Refreshing inventory restores the notice if items are still drifted
    const refreshBtn = container.querySelector('[data-testid="token-custom-refresh"]') as HTMLButtonElement;
    await act(async () => {
      refreshBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it('re-apply my choices does not stage protected wmuxRequired items and shows could not be re-applied count', async () => {
    reconcileSurfaceMock.mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedCount: 1,
      truncated: false,
      driftedItems: [
        {
          itemId: 'claude:hook::my-hook',
          name: 'my-hook',
          kind: 'hook',
          wanted: false,
          actual: true,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const notice = container.querySelector('[data-testid="token-custom-reconcile-notice"]');
    expect(notice).toBeTruthy();

    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    // Hook row should NOT be staged
    const hookRow = container.querySelector('[data-testid="hook-my-hook"]');
    expect(hookRow?.getAttribute('data-staged')).toBeNull();
    // Action bar should NOT be present (no staging)
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    // Message shows "1 could not be re-applied"
    const unappliedNotice = container.querySelector('[data-testid="token-custom-reconcile-unapplied"]');
    expect(unappliedNotice?.textContent).toContain('1 could not be re-applied');

    await act(async () => {
      root.unmount();
    });
  });

  it('re-apply my choices does not stage read-only items and shows could not be re-applied count', async () => {
    reconcileSurfaceMock.mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedCount: 1,
      truncated: false,
      driftedItems: [
        {
          itemId: 'claude:builtin-tool::ReadMe',
          name: 'ReadMe',
          kind: 'builtin-tool',
          wanted: false,
          actual: true,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    // ReadMe is toggleable: false, should NOT be staged
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();
    const unappliedNotice = container.querySelector('[data-testid="token-custom-reconcile-unapplied"]');
    expect(unappliedNotice?.textContent).toContain('1 could not be re-applied');

    await act(async () => {
      root.unmount();
    });
  });

  it('re-apply my choices does not stage items missing from inventory and shows could not be re-applied count', async () => {
    reconcileSurfaceMock.mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedCount: 1,
      truncated: false,
      driftedItems: [
        {
          itemId: 'claude:skill::missing-skill',
          name: 'missing-skill',
          kind: 'skill',
          wanted: false,
          actual: true,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();
    const unappliedNotice = container.querySelector('[data-testid="token-custom-reconcile-unapplied"]');
    expect(unappliedNotice?.textContent).toContain('1 could not be re-applied');

    await act(async () => {
      root.unmount();
    });
  });

  it('re-apply my choices stages only stageable items and counts unstageable ones', async () => {
    reconcileSurfaceMock.mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedCount: 2,
      truncated: false,
      driftedItems: [
        {
          itemId: 'claude:mcp-server::my-server',
          name: 'my-server',
          kind: 'mcp-server',
          wanted: false,
          actual: true,
        },
        {
          itemId: 'claude:hook::my-hook',
          name: 'my-hook',
          kind: 'hook',
          wanted: false,
          actual: true,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    // my-server is staged
    const serverRow = container.querySelector('[data-testid="mcp-server-my-server"]');
    expect(serverRow?.getAttribute('data-staged')).toBe('true');

    // my-hook is NOT staged
    const hookRow = container.querySelector('[data-testid="hook-my-hook"]');
    expect(hookRow?.getAttribute('data-staged')).toBeNull();

    // Action bar reflects 1 change
    expect(container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent).toContain('1 change');

    // Unapplied message shows "1 could not be re-applied"
    const unappliedNotice = container.querySelector('[data-testid="token-custom-reconcile-unapplied"]');
    expect(unappliedNotice?.textContent).toContain('1 could not be re-applied');

    await act(async () => {
      root.unmount();
    });
  });

  it('switching providers clears reconcile result immediately, ignores late response, and never stages items from another provider', async () => {
    const claudeDeferred = createDeferred<any>();
    const codexDeferred = createDeferred<any>();

    reconcileSurfaceMock.mockImplementation((p: string) => {
      if (p === 'claude') return claudeDeferred.promise;
      if (p === 'codex') return codexDeferred.promise;
      return Promise.resolve({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false });
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // 1. Resolve claude reconcile
    await act(async () => {
      claudeDeferred.resolve({
        newItems: 0,
        removedItems: 0,
        driftedCount: 1,
        truncated: false,
        driftedItems: [
          {
            itemId: 'claude:mcp-server::my-server',
            name: 'my-server',
            kind: 'mcp-server',
            wanted: false,
            actual: true,
          },
        ],
      });
    });

    // Notice is visible for claude
    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="token-custom-reconcile-names"]')?.textContent).toContain('my-server');

    // 2. Switch provider to Codex: notice must be cleared IMMEDIATELY
    const codexTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Codex'));
    expect(codexTab).toBeTruthy();

    await act(async () => {
      codexTab!.click();
    });

    // Notice is cleared immediately upon switching!
    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).toBeNull();

    // 3. Suppose a late claude reconcile response resolves after switching
    const lateClaudeDeferred = createDeferred<any>();
    reconcileSurfaceMock.mockImplementation((p: string) => {
      if (p === 'claude') return lateClaudeDeferred.promise;
      if (p === 'codex') return codexDeferred.promise;
      return Promise.resolve({ newItems: 0, removedItems: 0, driftedItems: [], driftedCount: 0, truncated: false });
    });

    await act(async () => {
      lateClaudeDeferred.resolve({
        newItems: 0,
        removedItems: 0,
        driftedCount: 1,
        truncated: false,
        driftedItems: [
          {
            itemId: 'claude:mcp-server::my-server',
            name: 'my-server',
            kind: 'mcp-server',
            wanted: false,
            actual: true,
          },
        ],
      });
    });

    // The late claude response is ignored; reconcile notice remains null
    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).toBeNull();

    // 4. Now resolve codex reconcile
    await act(async () => {
      codexDeferred.resolve({
        newItems: 0,
        removedItems: 0,
        driftedCount: 1,
        truncated: false,
        driftedItems: [
          {
            itemId: 'codex:mcp-server::codex-server',
            name: 'codex-server',
            kind: 'mcp-server',
            wanted: false,
            actual: true,
          },
        ],
      });
    });

    // Notice now appears for codex
    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="token-custom-reconcile-names"]')?.textContent).toContain('codex-server');

    // Click Re-apply my choices on codex tab
    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    // Only codex item is staged; no claude items are staged
    const codexRow = container.querySelector('[data-testid="mcp-server-codex-server"]');
    expect(codexRow?.getAttribute('data-staged')).toBe('true');
    expect(container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent).toContain('1 change');

    await act(async () => {
      root.unmount();
    });
  });

  it('truncation: notice shows true count, lists up to 5 names, displays "and N more not shown", and stages all returned entries', async () => {
    // Build 200 items in inventory
    const customItems = [];
    const returnedDrifted = [];
    for (let i = 0; i < 200; i++) {
      const id = `claude:mcp-server::server-${i}`;
      customItems.push({
        id,
        provider: 'claude' as const,
        kind: 'mcp-server' as const,
        name: `server-${i}`,
        parent: null,
        source: 'user' as const,
        enabled: true,
        effect: 'removes' as const,
        toggleable: true,
        readOnlyReason: null,
        hookEvent: null,
        hookCost: null,
        descriptionChars: null,
        originPath: '/home/.claude.json',
        wmuxRequired: false,
      });
      returnedDrifted.push({
        itemId: id,
        name: `server-${i}`,
        kind: 'mcp-server' as const,
        wanted: false,
        actual: true,
      });
    }

    readInventoryMock.mockResolvedValueOnce({
      provider: 'claude',
      cliVersion: '1.0.5',
      versionSupported: true,
      writable: true,
      items: customItems,
      warnings: [],
      scannedAtMs: Date.now(),
    });

    reconcileSurfaceMock.mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedCount: 210,
      truncated: true,
      driftedItems: returnedDrifted,
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // 1. Notice shows true total count (210)
    const notice = container.querySelector('[data-testid="token-custom-reconcile-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('210 items changed outside wmux since you last applied');

    // 2. Lists up to 5 names and overflow summary (210 - 200 = 10)
    const names = container.querySelector('[data-testid="token-custom-reconcile-names"]');
    expect(names?.textContent).toContain('server-0, server-1, server-2, server-3, server-4 and 10 more not shown');
    expect(names?.textContent).not.toContain('server-5');
    expect(notice?.textContent).toContain('server-0, server-1, server-2, server-3, server-4 and 10 more not shown');

    // 4. "Re-apply my choices" stages all 200 returned entries
    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    const stagedCount = container.querySelector('[data-testid="token-custom-staged-count"]');
    expect(stagedCount?.textContent).toContain('200 changes');

    await act(async () => {
      root.unmount();
    });
  });

  describe('buildPayloadChanges & assertProviderMatches', () => {
    it('assertProviderMatches throws when actualProvider does not match expectedProvider', () => {
      expect(() => assertProviderMatches('claude:mcp-server::my-server', 'claude', 'codex')).toThrow(
        'Assertion failed: staged change for claude:mcp-server::my-server has provider "claude", expected "codex"',
      );
      expect(() => assertProviderMatches('claude:mcp-server::my-server', 'claude', 'claude')).not.toThrow();
    });

    it('buildPayloadChanges builds payload only from entries matching requestProvider', () => {
      const staged = new Map<string, boolean>([
        ['claude:mcp-server::my-server', false],
        ['codex:mcp-server::codex-server', true],
        ['agy:skill::my-skill', false],
      ]);

      const claudePayload = buildPayloadChanges(staged, 'claude');
      expect(claudePayload).toEqual([
        { itemId: 'claude:mcp-server::my-server', enabled: false },
      ]);

      const codexPayload = buildPayloadChanges(staged, 'codex');
      expect(codexPayload).toEqual([
        { itemId: 'codex:mcp-server::codex-server', enabled: true },
      ]);

      const agyPayload = buildPayloadChanges(staged, 'agy');
      expect(agyPayload).toEqual([
        { itemId: 'agy:skill::my-skill', enabled: false },
      ]);
    });

    it('buildPayloadChanges uses inventory items provider when available', () => {
      const inventory: ProviderInventory = {
        provider: 'claude',
        cliVersion: '1.0.0',
        versionSupported: true,
        writable: true,
        items: [
          {
            id: 'legacy-id-without-prefix',
            provider: 'claude',
            kind: 'skill',
            name: 'skill',
            parent: null,
            source: 'user',
            enabled: true,
            effect: 'none',
            toggleable: true,
            readOnlyReason: null,
            hookEvent: null,
            hookCost: null,
            descriptionChars: null,
            originPath: null,
            wmuxRequired: false,
          },
        ],
        warnings: [],
        scannedAtMs: 0,
      };

      const staged = new Map<string, boolean>([
        ['legacy-id-without-prefix', false],
      ]);

      expect(buildPayloadChanges(staged, 'claude', inventory)).toEqual([
        { itemId: 'legacy-id-without-prefix', enabled: false },
      ]);
      expect(buildPayloadChanges(staged, 'codex', inventory)).toEqual([]);
    });
  });

  it('switch A -> B shows loading state without rows/toggles/presets, refuses toggles during loading, and resolves late', async () => {
    const codexDeferred = createDeferred<ProviderInventory>();

    const claudeWithWmux: ProviderInventory = {
      ...mockClaudeInventory,
      items: [
        ...mockClaudeInventory.items,
        {
          id: 'claude:mcp-tool:wmux:read_file',
          provider: 'claude',
          kind: 'mcp-tool',
          name: 'read_file',
          parent: 'wmux',
          source: 'wmux',
          enabled: true,
          effect: 'none',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: true,
        },
      ],
    };

    const codexWithWmux: ProviderInventory = {
      ...mockCodexInventory,
      items: [
        ...mockCodexInventory.items,
        {
          id: 'codex:mcp-tool:wmux:read_file',
          provider: 'codex',
          kind: 'mcp-tool',
          name: 'read_file',
          parent: 'wmux',
          source: 'wmux',
          enabled: true,
          effect: 'none',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: true,
        },
      ],
    };

    readInventoryMock.mockImplementation(({ provider }: { provider: string }) => {
      if (provider === 'claude') {
        return Promise.resolve(claudeWithWmux);
      }
      if (provider === 'codex') {
        return codexDeferred.promise;
      }
      return Promise.resolve({
        provider,
        cliVersion: null,
        versionSupported: false,
        writable: false,
        items: [],
        warnings: [],
        scannedAtMs: Date.now(),
      });
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // 1. Initially provider A (claude) is resolved and rendered
    expect(container.querySelector('[data-testid="mcp-server-my-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="toggle-mcp-server-my-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="wmux-preset-core"]')).not.toBeNull();

    // 2. Switch from Claude (A) to Codex (B)
    const codexTab = container.querySelector('button[role="radio"][aria-checked="false"]') as HTMLButtonElement;
    expect(codexTab).toBeTruthy();
    await act(async () => {
      codexTab.click();
    });

    // 3. During loading: selected provider (codex) differs from inventory provider (claude)
    // Loading state is displayed
    expect(container.textContent).toContain('Loading surface inventory...');
    // No rows are present (neither claude nor codex)
    expect(container.querySelector('[data-testid="mcp-server-my-server"]')).toBeNull();
    expect(container.querySelector('[data-testid="mcp-server-codex-server"]')).toBeNull();
    // No toggles are present
    expect(container.querySelectorAll('button[role="switch"]').length).toBe(0);
    expect(container.querySelector('[data-testid="toggle-mcp-server-my-server"]')).toBeNull();
    // No preset buttons are present
    expect(container.querySelector('[data-testid="wmux-preset-core"]')).toBeNull();
    expect(container.querySelector('[data-testid="wmux-preset-planner"]')).toBeNull();
    expect(container.querySelector('[data-testid="wmux-preset-reviewer"]')).toBeNull();
    expect(container.querySelector('[data-testid="wmux-preset-none"]')).toBeNull();
    expect(container.querySelector('[data-testid="wmux-preset-all-core"]')).toBeNull();

    // Verify action bar / staged changes cannot be created during loading
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    // 4. Resolve Codex late
    await act(async () => {
      codexDeferred.resolve(mockCodexInventory);
    });

    // 5. Codex inventory resolves and is displayed
    expect(container.textContent).not.toContain('Loading surface inventory...');
    expect(container.querySelector('[data-testid="mcp-server-codex-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="toggle-mcp-server-codex-server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-server-my-server"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('refuses to stage drifted item whose provider differs from selected provider in re-apply choices', async () => {
    reconcileSurfaceMock.mockResolvedValue({
      newItems: 0,
      removedItems: 0,
      driftedCount: 1,
      truncated: false,
      driftedItems: [
        {
          itemId: 'codex:mcp-server::other-server',
          name: 'other-server',
          current: true,
          wanted: false,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Notice is shown
    expect(container.querySelector('[data-testid="token-custom-reconcile-notice"]')).not.toBeNull();

    // Re-apply choices
    const reapplyBtn = container.querySelector('[data-testid="token-custom-reapply-choices"]') as HTMLButtonElement;
    await act(async () => {
      reapplyBtn.click();
    });

    // Codex item could not be re-applied because active provider is Claude
    const unapplied = container.querySelector('[data-testid="token-custom-reconcile-unapplied"]');
    expect(unapplied).not.toBeNull();
    expect(unapplied?.textContent).toContain('1 could not be re-applied');
    // Nothing was staged
    expect(container.querySelector('[data-testid="token-custom-action-bar"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
