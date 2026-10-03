// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { McpStatusSection, type ElectronMcpApi } from '../McpStatusSection';
import { useStore } from '../../../stores';
import type { McpStatusPayload } from '../../../../preload/preload';

function render(ui: React.ReactElement): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('McpStatusSection', () => {
  let mockStatus: McpStatusPayload;
  let mockApi: ElectronMcpApi;

  beforeEach(() => {
    useStore.setState({ toasts: [] });
    mockStatus = {
      targets: [
        {
          id: 'claude',
          displayName: 'Claude Code',
          format: 'json',
          configPath: '/mock/.claude.json',
          configExists: true,
          configModified: '2026-09-30T12:00:00Z',
          verified: true,
          wmux: { registered: true, path: '/mock/entry.js' },
        },
        {
          id: 'agy',
          displayName: 'Antigravity CLI',
          format: 'json',
          configPath: '/mock/mcp_config.json',
          configExists: true,
          configModified: '2026-09-30T12:00:00Z',
          verified: false,
          wmux: { registered: false, path: null },
        },
      ],
    };

    mockApi = {
      check: vi.fn(async () => mockStatus),
      reregister: vi.fn(async () => mockStatus),
      unregister: vi.fn(async () => mockStatus),
      registerTarget: vi.fn(async (targetId: string) => ({
        id: targetId,
        success: true,
        status: mockStatus,
      })),
    };
  });

  it('shows Register for an unregistered/opt-in row and Re-register for a registered row', async () => {
    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    const claudeRow = container.querySelector('[data-mcp-target="claude"]')!;
    const agyRow = container.querySelector('[data-mcp-target="agy"]')!;

    const claudeBtn = claudeRow.querySelector('[data-mcp-action="claude"]') as HTMLButtonElement;
    const agyBtn = agyRow.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;

    expect(claudeBtn.textContent).toBe('Re-register');
    expect(agyBtn.textContent).toBe('Register');
  });

  it('calls registerTarget with that id when Register is clicked', async () => {
    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    const agyBtn = container.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;
    await act(async () => {
      agyBtn.click();
    });
    await flush();

    expect(mockApi.registerTarget).toHaveBeenCalledWith('agy');
  });

  it('pushes the registered toast and nothing about a quota sensor', async () => {
    const updatedStatus = {
      targets: [
        mockStatus.targets[0],
        { ...mockStatus.targets[1], wmux: { registered: true, path: '/mock/entry.js' } },
      ],
    };
    (mockApi.registerTarget as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      (mockApi.check as ReturnType<typeof vi.fn>).mockResolvedValue(updatedStatus);
      return {
        id: 'agy',
        success: true,
        status: updatedStatus,
      };
    });

    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    const agyBtn = container.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;
    await act(async () => {
      agyBtn.click();
    });
    await flush();

    const toasts = useStore.getState().toasts;
    expect(toasts.some((t) => t.message === 'Registered Antigravity CLI' && t.level === 'info')).toBe(true);
    expect(toasts.some((t) => t.message.includes('Quota'))).toBe(false);

    // After success, row flips to Re-register
    const updatedBtn = container.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;
    expect(updatedBtn.textContent).toBe('Re-register');
  });

  it('pushes error toast on registration failure with known sentence', async () => {
    (mockApi.registerTarget as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'agy',
      success: false,
      error: 'The CLI config file was not found',
      status: mockStatus,
    });

    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    const agyBtn = container.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;
    await act(async () => {
      agyBtn.click();
    });
    await flush();

    const toasts = useStore.getState().toasts;
    expect(
      toasts.some(
        (t) =>
          t.level === 'error' &&
          t.message === 'The CLI config file was not found',
      ),
    ).toBe(true);
  });

  it('shows "Registration failed" when res.error is an unknown error string', async () => {
    (mockApi.registerTarget as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'agy',
      success: false,
      error: 'SyntaxError: Unexpected token SECRET_FRAGMENT in JSON at position 12',
      status: mockStatus,
    });

    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    const agyBtn = container.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;
    await act(async () => {
      agyBtn.click();
    });
    await flush();

    const toasts = useStore.getState().toasts;
    expect(
      toasts.some(
        (t) =>
          t.level === 'error' &&
          t.message === 'Registration failed',
      ),
    ).toBe(true);
    expect(toasts.some((t) => t.message.includes('SECRET_FRAGMENT'))).toBe(false);
  });

  it('disables the button while registerTarget call runs', async () => {
    let resolveCall!: (val: unknown) => void;
    (mockApi.registerTarget as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    const agyBtn = container.querySelector('[data-mcp-action="agy"]') as HTMLButtonElement;
    expect(agyBtn.disabled).toBe(false);

    act(() => {
      agyBtn.click();
    });

    expect(agyBtn.disabled).toBe(true);
    expect(agyBtn.textContent).toBe('…');

    await act(async () => {
      resolveCall({
        id: 'agy',
        success: true,
        status: mockStatus,
      });
    });
    await flush();

    expect(agyBtn.disabled).toBe(false);
  });

  it('keeps global Re-register unchanged and working', async () => {
    const { container, cleanup } = render(<McpStatusSection api={mockApi} />);
    cleanups.push(cleanup);
    await flush();

    // Global Re-register button is in the actions area at bottom
    const buttons = Array.from(container.querySelectorAll('button'));
    const globalReregisterBtn = buttons.find((b) => b.textContent?.includes('Re-register') && !b.hasAttribute('data-mcp-action'));
    expect(globalReregisterBtn).toBeDefined();

    await act(async () => {
      globalReregisterBtn!.click();
    });
    await flush();

    expect(mockApi.reregister).toHaveBeenCalledTimes(1);
    expect(mockApi.registerTarget).not.toHaveBeenCalled();
  });
});
