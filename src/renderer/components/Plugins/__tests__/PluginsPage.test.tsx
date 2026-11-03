// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PluginsPage from '../PluginsPage';
import { en } from '../../../i18n/locales/en';
import { useStore } from '../../../stores';
import type { InstalledUiPlugin } from '../../../../shared/pluginManagement';

vi.mock('../../../hooks/useT', () => ({
  useT: () => (key: keyof typeof en, params?: Record<string, string>) =>
    (en[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match),
}));
vi.mock('../../Connectors/ConnectorsPage', () => ({ default: () => <div data-connectors-page /> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { useStore.setState({ pluginsSelection: null, appRoute: 'plugins' }); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
function button(text: string, scope: ParentNode = host) {
  const result = [...scope.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
const hasButton = (text: string) => [...host.querySelectorAll('button')].some((item) => item.textContent === text);
const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-plugin-row="${id}"]`)!;
const office: InstalledUiPlugin = { name: 'office', version: '1.0.0', enabled: true, managed: true,
  trustStatus: 'unconfirmed', capabilities: ['ui.rail-page', 'agent.state.read', 'pane.read'], activationEvents: [],
  contributes: { railPage: { title: 'Office', entry: 'index.html' } } };
async function mount(initial: InstalledUiPlugin[]) {
  let plugins = initial;
  const requestApproval = vi.fn(async () => ({ approved: false }));
  const api = {
    list: vi.fn(async () => ({ plugins, failures: [] })), onChanged: vi.fn(() => () => undefined),
    install: vi.fn(async () => { plugins = [office]; }), remove: vi.fn(async () => { plugins = []; }), setEnabled: vi.fn(async () => undefined),
  };
  vi.stubGlobal('electronAPI', { pluginManagement: api, plugins: { list: api.list, requestApproval } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PluginsPage />));
  return { api, requestApproval };
}

it('lists Signature before Catalog, then Connectors, from the catalog data', async () => {
  await mount([]);
  const headings = [...host.querySelectorAll('[data-plugins-section]')].map((item) => item.getAttribute('data-plugins-section'));
  expect(headings).toEqual(['signature', 'catalog', 'connectors']);
  const rows = [...host.querySelectorAll('[data-plugin-row]')].map((item) => item.getAttribute('data-plugin-row'));
  expect(rows).toEqual(['office', 'agent-state-page', 'commander', 'connectors']);
  // The first row opens selected, with its Signature chip and credit.
  expect(row('office').getAttribute('aria-current')).toBe('true');
  expect(host.querySelector('[data-plugin-signature-chip]')).not.toBeNull();
  expect(host.textContent).toContain('bluemas · MIT · 1.1.0');
  expect(host.textContent).toContain(en['plugins.page.cap.noTerminal']);
  expect(host.querySelector('[data-installed-section]')).toBeNull();
});

it('installs without auto-approval, then reviews permissions on request', async () => {
  const { api, requestApproval } = await mount([]);
  expect(host.textContent).toContain(en['plugins.page.noteAvailable']);
  await act(async () => button('Install').click());
  expect(api.install).toHaveBeenCalledExactlyOnceWith('office');
  // The clicked button is gone; focus lands on the new primary, not the body.
  expect(document.activeElement?.textContent).toBe('Review permissions to open');
  expect(requestApproval).not.toHaveBeenCalled();
  expect(row('office').textContent).toContain('Not approved');
  await act(async () => button('Review permissions to open').click());
  expect(requestApproval).toHaveBeenCalledExactlyOnceWith('office');
});

it('opens, disables and re-enables an approved plugin', async () => {
  const { api } = await mount([{ ...office, trustStatus: 'trusted' }]);
  expect(row('office').textContent).toContain('On');
  await act(async () => button('Open').click());
  expect(useStore.getState().appRoute).toBe('plugin:office');
  await act(async () => button('Disable').click());
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith('office', false);
  act(() => root.unmount());
  const second = await mount([{ ...office, trustStatus: 'trusted', enabled: false }]);
  expect(row('office').textContent).toContain('Off');
  expect(hasButton('Open')).toBe(false);
  await act(async () => button('Enable').click());
  expect(second.api.setEnabled).toHaveBeenCalledExactlyOnceWith('office', true);
});

it('blocks Enable and Disable for a bundle that failed validation', async () => {
  await mount([{ ...office, invalid: true }]);
  expect(button('Uninstall').disabled).toBe(false);
  act(() => root.unmount());
  await mount([{ ...office, invalid: true, enabled: false }]);
  expect(button('Enable').disabled).toBe(true);
});

it('requires confirmation to remove a catalog bundle', async () => {
  const { api } = await mount([office]);
  await act(async () => button('Uninstall').click());
  expect(api.remove).not.toHaveBeenCalled();
  expect(button('Cancel')).toBe(document.activeElement);
  await act(async () => button('Uninstall').click());
  expect(api.remove).toHaveBeenCalledExactlyOnceWith('office');
  expect(row('office').textContent).not.toContain('Not approved');
});

it('lists a bundle installed by hand under Installed and offers no file deletion', async () => {
  const { api } = await mount([{ ...office, name: 'hand-made', managed: false, contributes: { railPage: { title: 'Hand made', entry: 'index.html' } } }]);
  expect(host.querySelector('[data-plugins-section="installed"]')).not.toBeNull();
  await act(async () => row('hand-made').click());
  expect(hasButton('Uninstall')).toBe(false);
  expect(host.textContent).toContain(en['plugins.settings.manual']);
  await act(async () => button('Disable').click());
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith('hand-made', false);
  expect(api.remove).not.toHaveBeenCalled();
});

it('shows each catalog entry under its own name, tagline and publisher', async () => {
  await mount([]);
  expect(row('office').textContent).toContain(en['plugins.page.officeTagline']);
  expect(row('agent-state-page').textContent).toContain(en['plugins.page.agentStatusTagline']);
  await act(async () => row('agent-state-page').click());
  expect(useStore.getState().pluginsSelection).toBe('agent-state-page');
  expect(host.textContent).toContain(en['plugins.settings.agentStatusHint']);
  expect(host.textContent).toContain('wmux · MIT · 1.0.0');
  expect(host.querySelector('[data-plugin-signature-chip]')).toBeNull();
});

it('shows the Connectors content when the connectors row is selected', async () => {
  useStore.getState().setAppRoute('connectors');
  await mount([]);
  expect(row('connectors').getAttribute('aria-current')).toBe('true');
  expect(host.querySelector('[data-connectors-page]')).not.toBeNull();
});

it('walks the rows with the arrow keys, selecting as it goes', async () => {
  await mount([]);
  row('office').focus();
  await act(async () => row('office').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.activeElement).toBe(row('agent-state-page'));
  expect(useStore.getState().pluginsSelection).toBe('agent-state-page');
  await act(async () => row('agent-state-page').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(useStore.getState().pluginsSelection).toBe('connectors');
});

it('keeps Install waiting until the inventory has been read once', async () => {
  vi.stubGlobal('electronAPI', { pluginManagement: { list: vi.fn(async () => { throw new Error('down'); }), onChanged: () => () => undefined }, plugins: { list: vi.fn(async () => ({ plugins: [], failures: [] })) } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PluginsPage />));
  expect(button('Install').disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it('filters rows by the search field', async () => {
  await mount([]);
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'status');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const rows = [...host.querySelectorAll('[data-plugin-row]')].map((item) => item.getAttribute('data-plugin-row'));
  expect(rows).toEqual(['agent-state-page']);
});

it('shows a catalog entry\'s preview in a reserved 16:10 box, named for the plugin', async () => {
  await mount([]);
  const box = host.querySelector('[data-plugin-preview="office"]');
  expect(box?.className).toBe('wmux-plugins-preview');
  const image = box?.querySelector('img');
  expect(image?.getAttribute('alt')).toBe('Office plugin preview');
  expect(image?.getAttribute('src')).toMatch(/plugin-office.*\.webp/);
  // Width and height reserve the box before decode; decoding stays lazy.
  expect([image?.getAttribute('width'), image?.getAttribute('height')]).toEqual(['1280', '800']);
  expect([image?.getAttribute('loading'), image?.getAttribute('decoding')]).toEqual(['lazy', 'async']);
  await act(async () => row('agent-state-page').click());
  const agentImage = host.querySelector('[data-plugin-preview="agent-state-page"] img');
  expect(agentImage?.getAttribute('alt')).toBe('Agent status plugin preview');
  expect(agentImage?.getAttribute('src')).toMatch(/plugin-agent-state-page.*\.webp/);
});

it('shows no preview for a bundle installed by hand', async () => {
  await mount([{ ...office, name: 'hand-made', managed: false, contributes: { railPage: { title: 'Hand made', entry: 'index.html' } } }]);
  await act(async () => row('hand-made').click());
  expect(host.querySelector('[data-plugin-detail="hand-made"]')).not.toBeNull();
  expect(host.querySelector('[data-plugin-preview]')).toBeNull();
});
