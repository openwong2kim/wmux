// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { createOsc8LinkHandler, normalizeOsc8Uri } from '../osc8LinkHandler';
import { openTerminalUrl } from '../../utils/browserPaneActions';
import { useStore } from '../../stores';
import { getLeafPanes } from '../../../shared/paneUtils';

const terminals: Terminal[] = [];
const openExternal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  // Match Electron's window-open policy: a blank popup is denied.
  vi.spyOn(window, 'open').mockReturnValue(null);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true, value: { shell: { openExternal } },
  });
  useStore.setState({ browserBackend: 'external' });
});
afterEach(() => { terminals.splice(0).forEach((t) => t.dispose()); vi.restoreAllMocks(); });

async function hyperlink(uri: string): Promise<ILink | undefined> {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  terminals.push(terminal);
  terminal.options.linkHandler = createOsc8LinkHandler((event, url) =>
    openTerminalUrl(url, { modifierHeld: event.ctrlKey || event.metaKey }));
  await new Promise<void>((resolve) => terminal.write(`\x1b]8;;${uri}\x07Report\x1b]8;;\x07`, resolve));
  // Use xterm's actual OSC 8 parser/provider, not an invented link callback.
  const core = (terminal as unknown as {
    _core: { _linkProviderService: { linkProviders: ILinkProvider[] } };
  })._core;
  return new Promise((resolve) => core._linkProviderService.linkProviders[0].provideLinks(1, (links) => resolve(links?.[0])));
}

describe('formatted terminal hyperlinks', () => {
  it.each([
    ['https://example.com/reports/run?team=one&view=full', false],
    ['https://example.com/reports/run', true],
    ['http://localhost:3000/report', false],
  ])('opens %s in the OS browser with external backend (modifier=%s)', async (url, ctrlKey) => {
    const link = await hyperlink(url as string);
    expect(link).toBeDefined();
    link!.activate(new MouseEvent('click', { ctrlKey: ctrlKey as boolean }), link!.text);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(url as string));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('retains embedded routing for localhost in builtin mode', async () => {
    useStore.setState({ browserBackend: 'builtin' });
    const url = 'http://localhost:4991/osc8-report';
    const link = await hyperlink(url);
    link!.activate(new MouseEvent('click'), link!.text);
    const browsers = useStore.getState().workspaces.flatMap((ws) =>
      getLeafPanes(ws.rootPane).flatMap((pane) => pane.surfaces).filter((surface) => surface.surfaceType === 'browser'));
    expect(browsers.some((surface) => surface.browserUrl === url)).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('does not open anything when the destination confirmation is cancelled', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const link = await hyperlink('https://example.com/report');
    link!.activate(new MouseEvent('click'), link!.text);
    expect(openExternal).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each(['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'custom:launch'])('does not activate non-web OSC 8 destinations: %s', async (url) => {
    expect(await hyperlink(url)).toBeUndefined();
    expect(openExternal).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });
});

describe('OSC 8 destination normalization (#1272)', () => {
  it.each([
    // Bidi override in the path is percent-encoded, not rendered.
    ['https://example.com/‮gpj.exe', 'https://example.com/%E2%80%AEgpj.exe'],
    // IDN homograph host (Cyrillic "a") is shown as punycode.
    ['https://аpple.com/login', 'https://xn--pple-43d.com/login'],
    // Tab/newline are dropped by the parser; other C0 controls are encoded.
    ['https://example.com/a\tb\nc\x01d', 'https://example.com/abc%01d'],
    // Zero-width space and bidi isolate in the fragment.
    ['https://example.com/#​x⁦y', 'https://example.com/#%E2%80%8Bx%E2%81%A6y'],
  ])('normalizes %j to an ASCII href', (raw, expected) => {
    const href = normalizeOsc8Uri(raw);
    expect(href).toBe(expected);
    expect(href).toMatch(/^[\x21-\x7E]+$/);
  });

  it.each(['not a url', 'https://', 'http://[bad', 'javascript:alert(1)', 'file:///etc/passwd'])(
    'rejects %j', (raw) => {
      expect(normalizeOsc8Uri(raw)).toBeNull();
    });

  it('confirms and activates the same normalized href', () => {
    const activate = vi.fn();
    const event = new MouseEvent('click');
    createOsc8LinkHandler(activate).activate(event, 'https://аpple.com/‮evil', undefined as never);
    const expected = 'https://xn--pple-43d.com/%E2%80%AEevil';
    const shown = vi.mocked(window.confirm).mock.calls[0][0] as string;
    expect(shown).toContain(expected);
    expect(shown).not.toMatch(/[а‮]/);
    expect(activate).toHaveBeenCalledExactlyOnceWith(event, expected);
  });

  it('neither confirms nor activates an unparseable destination', () => {
    const activate = vi.fn();
    createOsc8LinkHandler(activate).activate(new MouseEvent('click'), 'http://[bad', undefined as never);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
