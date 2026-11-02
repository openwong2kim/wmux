// @vitest-environment jsdom
//
// #2901: xterm activates a link on mouseup of any button. The provider tests
// cover OSC 8, hard-wrapped and path links; this mounts the REAL useTerminal
// (same harness as useTerminal.fixedGeometry.test.tsx) to drive the handler it
// gives WebLinksAddon, the plain-URL leg no provider test reaches.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type UrlHandler = (event: MouseEvent, uri: string) => void;
const captured = vi.hoisted(() => ({ handler: undefined as UrlHandler | undefined, openTerminalUrl: vi.fn() }));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: UrlHandler) { captured.handler = handler; }
    activate() { /* inert */ }
    dispose() { /* inert */ }
  },
}));
vi.mock('../../utils/browserPaneActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/browserPaneActions')>()),
  openTerminalUrl: captured.openTerminalUrl,
}));

let root: Root | null = null;

beforeAll(async () => {
  installCanvas2dStub();
  const unsub = () => () => undefined;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
        resize: vi.fn(async () => undefined), setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined), list: vi.fn(async () => []),
        reconnect: vi.fn(async () => ({ success: true })),
      },
      daemon: { onConnected: unsub },
      shell: { openPath: vi.fn(async () => ({ ok: true })) },
    },
  });
  globalThis.ResizeObserver ??= class { observe() { /* inert */ } unobserve() { /* inert */ } disconnect() { /* inert */ } } as unknown as typeof ResizeObserver;
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(), addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  const { useTerminal } = await import('../useTerminal');
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId: 'p1', isVisible: true });
    return <div ref={ref} />;
  }
  const mounted = createRoot(document.body.appendChild(document.createElement('div')));
  root = mounted;
  await act(async () => { mounted.render(<Harness />); });
}, 60_000);

afterAll(() => act(() => root?.unmount()));

describe('useTerminal plain URL links (#2901)', () => {
  it.each([
    [0, true],
    [1, false],
    [2, false],
  ])('mouse button %i opens the URL: %s', (button, opens) => {
    expect(captured.handler).toBeDefined();
    captured.openTerminalUrl.mockClear();
    captured.handler?.(new MouseEvent('mouseup', { button }), 'https://example.com/');
    expect(captured.openTerminalUrl).toHaveBeenCalledTimes(opens ? 1 : 0);
  });
});
