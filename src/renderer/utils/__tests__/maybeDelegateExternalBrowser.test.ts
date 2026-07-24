// @vitest-environment jsdom
//
// #517 external backend — renderer delegation guard. Every user-facing "open a
// browser" affordance (pane button, palette, keyboard, sidebar badge, terminal
// link) funnels through openUrlInBrowserPane or a direct addBrowserSurface call
// that first consults maybeDelegateExternalBrowser. In 'external' mode it hands
// the URL to the OS browser and reports "handled" so no webview is mounted.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maybeDelegateExternalBrowser, openUrlInBrowserPane } from '../browserPaneActions';
import { useStore } from '../../stores';
import { DEFAULT_BROWSER_URL } from '../browserPane';

const openExternal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    shell: { openExternal },
  };
  useStore.setState({ browserBackend: 'builtin' } as never);
});

describe('maybeDelegateExternalBrowser (#517)', () => {
  it('returns false and does nothing in builtin mode', () => {
    useStore.setState({ browserBackend: 'builtin' } as never);
    expect(maybeDelegateExternalBrowser('https://x.test')).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('delegates a URL to the OS browser in external mode', () => {
    useStore.setState({ browserBackend: 'external' } as never);
    expect(maybeDelegateExternalBrowser('https://x.test')).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://x.test');
  });

  it('opens the default homepage when no URL is given (empty pane button)', () => {
    useStore.setState({ browserBackend: 'external' } as never);
    expect(maybeDelegateExternalBrowser(undefined)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(DEFAULT_BROWSER_URL);
  });

  it('openUrlInBrowserPane short-circuits in external mode without creating a surface', () => {
    useStore.setState({ browserBackend: 'external' } as never);
    const result = openUrlInBrowserPane('https://x.test');
    expect(result).toEqual({ ok: true, surfaceId: '', paneId: '', url: 'https://x.test', reused: false });
    expect(openExternal).toHaveBeenCalledWith('https://x.test');
  });
});
