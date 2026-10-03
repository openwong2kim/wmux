// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { CustomWmuxToolsGroup } from '../custom/CustomWmuxToolsGroup';
import { CustomPanel } from '../CustomPanel';
import { CORE_TOOL_SURFACE } from '../../../../../../shared/coreSurface';
import { ROLE_TOOL_SURFACES } from '../../../../../../shared/roleSurfaces';
import type { ProviderInventory, SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createSampleWmuxTools(): SurfaceItem[] {
  return CORE_TOOL_SURFACE.map((name) => ({
    id: `claude:mcp-tool:wmux:${name}`,
    provider: 'claude',
    kind: 'mcp-tool',
    name,
    parent: 'wmux',
    source: 'wmux',
    enabled: true,
    effect: 'removes',
    toggleable: true,
    readOnlyReason: null,
    hookEvent: null,
    hookCost: null,
    descriptionChars: null,
    originPath: '/home/.claude.json',
    wmuxRequired: false,
  }));
}

describe('CustomWmuxToolsGroup unit tests', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it('renders wmux tools group with count, note, preset buttons, and tools list', async () => {
    const tools = createSampleWmuxTools();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(CustomWmuxToolsGroup, {
          tools,
          allTools: tools,
        }),
      );
    });

    expect(container.querySelector('[data-testid="token-custom-wmux-group"]')).toBeDefined();
    expect(container.querySelector('[data-testid="token-custom-wmux-group"]')?.textContent).toContain('wmux core tools');
    expect(container.querySelector('[data-testid="token-custom-wmux-count"]')?.textContent).toBe(
      `${tools.length} of ${tools.length} enabled`,
    );
    expect(container.querySelector('[data-testid="token-custom-wmux-note"]')?.textContent).toContain(
      'Applies to every pane of this CLI; roles are still narrowed per pane at launch. browser_* and company_* tools are not listed here.',
    );

    expect(container.querySelector('[data-testid="wmux-preset-core"]')).toBeDefined();
    expect(container.querySelector('[data-testid="wmux-preset-planner"]')).toBeDefined();
    expect(container.querySelector('[data-testid="wmux-preset-reviewer"]')).toBeDefined();
    expect(container.querySelector('[data-testid="wmux-preset-none"]')).toBeDefined();
    expect(container.querySelector('[data-testid="wmux-preset-all-core"]')).toBeDefined();
    expect(container.querySelector('[data-testid="wmux-preset-all-core"]')?.textContent).toBe('All core');

    expect(container.querySelector('[data-testid="wmux-tools-list"]')).toBeDefined();
    expect(container.querySelector('[data-testid="mcp-tool-terminal_read"]')).toBeDefined();
  });

  it('toggles collapse state on clicking collapse button', async () => {
    const tools = createSampleWmuxTools();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(CustomWmuxToolsGroup, {
          tools,
          allTools: tools,
        }),
      );
    });

    const collapseBtn = container.querySelector('[data-testid="token-custom-wmux-collapse-btn"]') as HTMLButtonElement;
    expect(collapseBtn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="wmux-tools-list"]')).not.toBeNull();

    await act(async () => {
      collapseBtn.click();
    });

    expect(collapseBtn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="wmux-tools-list"]')).toBeNull();

    await act(async () => {
      collapseBtn.click();
    });

    expect(collapseBtn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="wmux-tools-list"]')).not.toBeNull();
  });

  it('presets trigger onBatchToggle with expected target states', async () => {
    const tools = createSampleWmuxTools();
    const onBatchToggle = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(CustomWmuxToolsGroup, {
          tools,
          allTools: tools,
          onBatchToggle,
        }),
      );
    });

    // 1. Planner preset
    const plannerBtn = container.querySelector('[data-testid="wmux-preset-planner"]') as HTMLButtonElement;
    await act(async () => {
      plannerBtn.click();
    });
    expect(onBatchToggle).toHaveBeenCalledTimes(1);
    const plannerUpdates: Array<{ itemId: string; next: boolean }> = onBatchToggle.mock.calls[0][0];
    const plannerNames = new Set(ROLE_TOOL_SURFACES.Planner);
    for (const update of plannerUpdates) {
      const toolName = update.itemId.split(':').pop()!;
      expect(update.next).toBe(plannerNames.has(toolName));
    }

    // 2. Reviewer preset
    const reviewerBtn = container.querySelector('[data-testid="wmux-preset-reviewer"]') as HTMLButtonElement;
    await act(async () => {
      reviewerBtn.click();
    });
    expect(onBatchToggle).toHaveBeenCalledTimes(2);
    const reviewerUpdates: Array<{ itemId: string; next: boolean }> = onBatchToggle.mock.calls[1][0];
    const reviewerNames = new Set(ROLE_TOOL_SURFACES.Reviewer);
    for (const update of reviewerUpdates) {
      const toolName = update.itemId.split(':').pop()!;
      expect(update.next).toBe(reviewerNames.has(toolName));
    }

    // 3. None preset
    const noneBtn = container.querySelector('[data-testid="wmux-preset-none"]') as HTMLButtonElement;
    await act(async () => {
      noneBtn.click();
    });
    expect(onBatchToggle).toHaveBeenCalledTimes(3);
    const noneUpdates: Array<{ itemId: string; next: boolean }> = onBatchToggle.mock.calls[2][0];
    for (const update of noneUpdates) {
      expect(update.next).toBe(false);
    }

    // 4. All core preset
    const allBtn = container.querySelector('[data-testid="wmux-preset-all-core"]') as HTMLButtonElement;
    await act(async () => {
      allBtn.click();
    });
    expect(onBatchToggle).toHaveBeenCalledTimes(4);
    const allUpdates: Array<{ itemId: string; next: boolean }> = onBatchToggle.mock.calls[3][0];
    for (const update of allUpdates) {
      expect(update.next).toBe(true);
    }

    // 5. Core preset
    const coreBtn = container.querySelector('[data-testid="wmux-preset-core"]') as HTMLButtonElement;
    await act(async () => {
      coreBtn.click();
    });
    expect(onBatchToggle).toHaveBeenCalledTimes(5);
    const coreUpdates: Array<{ itemId: string; next: boolean }> = onBatchToggle.mock.calls[4][0];
    const coreNames = new Set(CORE_TOOL_SURFACE);
    for (const update of coreUpdates) {
      const toolName = update.itemId.split(':').pop()!;
      expect(update.next).toBe(coreNames.has(toolName));
    }
  });

  it('individual tool row calls onToggle', async () => {
    const tools = createSampleWmuxTools();
    const onToggle = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(CustomWmuxToolsGroup, {
          tools,
          allTools: tools,
          onToggle,
        }),
      );
    });

    const toggleBtn = container.querySelector('[data-testid="toggle-mcp-tool-terminal_read"]') as HTMLButtonElement;
    expect(toggleBtn).toBeDefined();
    await act(async () => {
      toggleBtn.click();
    });
    expect(onToggle).toHaveBeenCalledWith('claude:mcp-tool:wmux:terminal_read');
  });
});

describe('CustomPanel integration with CustomWmuxToolsGroup', () => {
  let container: HTMLDivElement;
  let readInventoryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    const wmuxTools = createSampleWmuxTools();
    const mockInventory: ProviderInventory = {
      provider: 'claude',
      cliVersion: '1.0.5',
      versionSupported: true,
      writable: true,
      scannedAtMs: 1_000,
      warnings: [],
      items: [
        {
          id: 'claude:mcp-server::wmux',
          provider: 'claude',
          kind: 'mcp-server',
          name: 'wmux',
          parent: null,
          source: 'wmux',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: '/home/.claude.json',
          wmuxRequired: true,
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
        ...wmuxTools,
      ],
    };

    readInventoryMock = vi.fn().mockResolvedValue(mockInventory);
    (window as any).electronAPI = {
      tokenUsage: {
        readInventory: readInventoryMock,
        previewChanges: vi.fn(),
        applyChanges: vi.fn(),
      },
    };
  });

  afterEach(() => {
    document.body.removeChild(container);
    delete (window as any).electronAPI;
    vi.restoreAllMocks();
  });

  it('stages only changed items when a preset is clicked and never touches non-wmux items', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    expect(container.querySelector('[data-testid="token-custom-wmux-group"]')).not.toBeNull();

    // First, stage a non-wmux item (toggle plugin)
    const togglePlugin = container.querySelector('[data-testid="toggle-plugin-my-plugin"]') as HTMLButtonElement;
    await act(async () => {
      togglePlugin.click();
    });

    const stagedCount1 = container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent;
    expect(stagedCount1).toBe('1 change');

    // Click Planner preset
    const plannerBtn = container.querySelector('[data-testid="wmux-preset-planner"]') as HTMLButtonElement;
    await act(async () => {
      plannerBtn.click();
    });

    // All tools originally had enabled: true.
    // Planner keeps 6 tools enabled, disables (CORE_TOOL_SURFACE.length - 6) tools.
    // The 6 planner tools match their original enabled state, so they are NOT staged!
    // The changed wmux tools are staged to false.
    // The non-wmux plugin is still staged to true!
    const plannerToolCount = ROLE_TOOL_SURFACES.Planner.length;
    const changedWmuxCount = CORE_TOOL_SURFACE.length - plannerToolCount;
    const expectedTotalStaged = 1 + changedWmuxCount;

    const stagedCount2 = container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent;
    expect(stagedCount2).toBe(`${expectedTotalStaged} changes`);

    // Verify planner tools are NOT marked as staged
    const plannerTool = container.querySelector('[data-testid="mcp-tool-terminal_read"]');
    expect(plannerTool?.getAttribute('data-staged')).toBeNull();

    // Verify non-planner tool IS marked as staged
    const nonPlannerTool = container.querySelector('[data-testid="mcp-tool-pane_split"]');
    expect(nonPlannerTool?.getAttribute('data-staged')).toBe('true');

    // Verify non-wmux plugin is still staged
    const pluginRow = container.querySelector('[data-testid="plugin-my-plugin"]');
    expect(pluginRow?.getAttribute('data-staged')).toBe('true');

    // Now click All core preset: wmux tools were originally all enabled, so All core restores them to original state.
    // Staged changes for wmux tools should be cleared; plugin remains staged.
    const allBtn = container.querySelector('[data-testid="wmux-preset-all-core"]') as HTMLButtonElement;
    await act(async () => {
      allBtn.click();
    });

    const stagedCount3 = container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent;
    expect(stagedCount3).toBe('1 change');
    expect(pluginRow?.getAttribute('data-staged')).toBe('true');
    expect(nonPlannerTool?.getAttribute('data-staged')).toBeNull();
  });

  it('wmux declared in user and project config for claude yields exactly one row per tool, one warning, and presets stage each tool once', async () => {
    const wmuxTools = createSampleWmuxTools();
    const mockInventory: ProviderInventory = {
      provider: 'claude',
      cliVersion: '1.0.5',
      versionSupported: true,
      writable: true,
      scannedAtMs: 1_000,
      warnings: ['wmux is declared in several places; tool switches apply to project'],
      items: [
        {
          id: 'claude:mcp-server::wmux',
          provider: 'claude',
          kind: 'mcp-server',
          name: 'wmux',
          parent: null,
          source: 'wmux',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: '/home/.claude.json',
          wmuxRequired: true,
        },
        {
          id: 'claude:mcp-server::wmux#project-1',
          provider: 'claude',
          kind: 'mcp-server',
          name: 'wmux',
          parent: null,
          source: 'wmux',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: '/proj/.mcp.json',
          wmuxRequired: true,
        },
        ...wmuxTools,
      ],
    };

    readInventoryMock.mockResolvedValue(mockInventory);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel));
    });

    // Exactly one row per tool in CustomWmuxToolsGroup
    for (const tool of wmuxTools) {
      const rows = container.querySelectorAll(`[data-testid="mcp-tool-${tool.name}"]`);
      expect(rows.length).toBe(1);
    }

    // Warning is rendered in CustomPanel
    expect(container.textContent).toContain('wmux is declared in several places; tool switches apply to project');

    // Clicking None preset stages each tool once
    const noneBtn = container.querySelector('[data-testid="wmux-preset-none"]') as HTMLButtonElement;
    await act(async () => {
      noneBtn.click();
    });

    const stagedCount = container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent;
    expect(stagedCount).toBe(`${CORE_TOOL_SURFACE.length} changes`);
  });

  it('wmux declared in user and project config for agy yields exactly one row per tool, one warning, and presets stage each tool once', async () => {
    const agyWmuxTools: SurfaceItem[] = CORE_TOOL_SURFACE.map((name) => ({
      id: `agy:mcp-tool:wmux:${name}`,
      provider: 'agy',
      kind: 'mcp-tool',
      name,
      parent: 'wmux',
      source: 'wmux',
      enabled: true,
      effect: 'removes',
      toggleable: true,
      readOnlyReason: null,
      hookEvent: null,
      hookCost: null,
      descriptionChars: null,
      originPath: '/proj/.agents/mcp_config.json',
      wmuxRequired: false,
    }));

    const mockInventory: ProviderInventory = {
      provider: 'agy',
      cliVersion: '1.2.14',
      versionSupported: true,
      writable: true,
      scannedAtMs: 1_000,
      warnings: [
        'Full MCP tool list requires live tools/list (config only records tool overrides).',
        'wmux is declared in several places; tool switches apply to project',
      ],
      items: [
        {
          id: 'agy:mcp-server::wmux',
          provider: 'agy',
          kind: 'mcp-server',
          name: 'wmux',
          parent: null,
          source: 'wmux',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: '/home/.gemini/config/mcp_config.json',
          wmuxRequired: true,
        },
        {
          id: 'agy:mcp-server::wmux#project-1',
          provider: 'agy',
          kind: 'mcp-server',
          name: 'wmux',
          parent: null,
          source: 'wmux',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: '/proj/.agents/mcp_config.json',
          wmuxRequired: true,
        },
        ...agyWmuxTools,
      ],
    };

    readInventoryMock.mockResolvedValue(mockInventory);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(CustomPanel, { providers: ['agy'] }));
    });

    // Exactly one row per tool in CustomWmuxToolsGroup
    for (const tool of agyWmuxTools) {
      const rows = container.querySelectorAll(`[data-testid="mcp-tool-${tool.name}"]`);
      expect(rows.length).toBe(1);
    }

    // Warning is rendered in CustomPanel
    expect(container.textContent).toContain('wmux is declared in several places; tool switches apply to project');

    // Clicking Planner preset stages each changed tool once
    const plannerBtn = container.querySelector('[data-testid="wmux-preset-planner"]') as HTMLButtonElement;
    await act(async () => {
      plannerBtn.click();
    });

    const plannerToolCount = ROLE_TOOL_SURFACES.Planner.length;
    const changedWmuxCount = CORE_TOOL_SURFACE.length - plannerToolCount;
    const stagedCount = container.querySelector('[data-testid="token-custom-staged-count"]')?.textContent;
    expect(stagedCount).toBe(`${changedWmuxCount} changes`);
  });
});
