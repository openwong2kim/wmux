// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PluginRailPage, { PluginRailNavigation } from '../PluginRailPage';
import { IconOffice, IconPackage } from '../../components/icons';
import { useStore } from '../../stores';
import type { PluginHostPluginSummary } from '../../../shared/pluginHost';
const mock = vi.hoisted(() => ({ plugins: [] as Array<PluginHostPluginSummary & { managed?: boolean }> }));
vi.mock('../usePlugins', () => ({ usePlugins: () => ({ plugins: mock.plugins, loaded: true }), refreshPlugins: vi.fn() }));
vi.mock('../../hooks/useT', () => ({ useT: () => (key: string) => key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { plugins: {
    frameReady: vi.fn(async () => true), onFrameNavigation: vi.fn(() => vi.fn()),
  } };
});
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; delete (window as unknown as { electronAPI?: unknown }).electronAPI; });
function setup(status: PluginHostPluginSummary['trustStatus']) {
  mock.plugins = [{ name: 'agents', version: '1', capabilities: ['ui.rail-page'], activationEvents: [], trustStatus: status, contributes: { railPage: { title: 'Agent page', entry: 'page.html' } } }];
  useStore.setState({ appRoute: 'plugin:agents' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root?.render(<PluginRailPage name="agents" />));
}
describe('plugin rail page mount gate', () => {
  it('does not mount an unapproved iframe', () => {
    setup('unconfirmed');
    expect(host?.querySelector('iframe')).toBeNull();
    expect(host?.textContent).toContain('plugins.page.approve');
  });
  it('mounts only a trusted sandboxed iframe and removes it on leaving', () => {
    setup('trusted');
    const frame = host?.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe('wmux-plugin://agents/page.html');
    act(() => root?.render(null));
    expect(host?.querySelector('iframe')).toBeNull();
  });
  it('returns to workspaces if the selected plugin becomes unavailable', () => {
    setup('trusted');
    mock.plugins = [];
    act(() => root?.render(<PluginRailPage name="agents" />));
    expect(host?.querySelector('iframe')).toBeNull();
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});

describe('plugin rail item glyph', () => {
  function railGlyph(managed: boolean): string | undefined {
    mock.plugins = [{ name: 'office', version: '1', capabilities: ['ui.rail-page'], activationEvents: [], trustStatus: 'trusted', managed, contributes: { railPage: { title: 'My office', entry: 'index.html' } } }];
    useStore.setState({ appRoute: 'workspaces' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    act(() => root?.render(<PluginRailNavigation compact={false} />));
    return host.querySelector('[data-sidebar-nav="plugin:office"] .wmux-nav-icon')?.innerHTML;
  }

  it('gives a bundle installed by hand under a catalog id the package glyph, not the entry it shares a name with', () => {
    expect(railGlyph(false)).toBe(renderToStaticMarkup(<IconPackage size={16} />));
  });

  it("gives the catalog's own install the entry's glyph", () => {
    expect(railGlyph(true)).toBe(renderToStaticMarkup(<IconOffice size={16} />));
  });
});
