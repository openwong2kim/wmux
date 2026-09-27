// @vitest-environment jsdom
//
// The Remote hub's "Other computers": per-host status (dot + text) that never
// waits on an offline host, one field that takes any pairing link, a Paste
// button that is the ONLY thing that reads the clipboard, and re-pairing that
// replaces the rejected host in place.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import OtherComputersSection from '../OtherComputersSection';
import { useStore } from '../../../stores';
import type { RemoteHostPublic, RemoteHostStatus } from '../../../../shared/remoteHosts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = (id: string): RemoteHostPublic => ({ id, label: `${id}-mac`, origin: `https://${id}.ts.net`, addedAt: 1 });
const LINK = 'https://desk.tail1234.ts.net/pair#wmux-desktop-code=QWXZ7K9M';

let container: HTMLDivElement;
let root: Root;
let hostsList: ReturnType<typeof vi.fn>;
let hostsStatus: ReturnType<typeof vi.fn>;
let hostsPair: ReturnType<typeof vi.fn>;
let hostsAdd: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;
let onOpenHost: ReturnType<typeof vi.fn<(hostId: string) => void>>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  hostsList = vi.fn().mockResolvedValue([host('live'), host('idle'), host('off'), host('revoked')]);
  hostsStatus = vi.fn().mockResolvedValue({
    live: 'connected',
    idle: 'reachable',
    off: 'unreachable',
    revoked: 'needs-repair',
  } satisfies Record<string, RemoteHostStatus>);
  hostsPair = vi.fn().mockResolvedValue({ ok: true, host: host('new') });
  hostsAdd = vi.fn().mockResolvedValue({ ok: true, host: host('tok') });
  readText = vi.fn().mockResolvedValue(`  ${LINK}\n`);
  onOpenHost = vi.fn<(hostId: string) => void>();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: { hostsList, hostsStatus, hostsPair, hostsAdd },
  };
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = { readText, writeText: vi.fn() };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { clipboardAPI?: unknown }).clipboardAPI;
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => root.render(createElement(OtherComputersSection, { onOpenHost })));
  await flush();
}

const rows = () => Array.from(container.querySelectorAll('[data-testid="remote-hub-host"]')) as HTMLButtonElement[];
const statusTexts = () => rows().map((r) => r.querySelector('[data-testid="remote-hub-host-status"]')?.textContent);
const buttonNamed = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const field = () => container.querySelector('input') as HTMLInputElement;

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Other computers — status', () => {
  it('lists hosts at once and fills each status when the probe answers', async () => {
    let answer: (v: Record<string, RemoteHostStatus>) => void = () => undefined;
    hostsStatus.mockReturnValue(new Promise((r) => { answer = r; }));
    await mount();
    // The offline host does not hold the list up: rows are there, "Checking…".
    expect(rows()).toHaveLength(4);
    expect(statusTexts()).toEqual(['Checking…', 'Checking…', 'Checking…', 'Checking…']);

    await act(async () => answer({ live: 'connected', idle: 'reachable', off: 'unreachable', revoked: 'needs-repair' }));
    await flush();
    expect(statusTexts()).toEqual(['Connected', 'Reachable', 'Unreachable', 'Needs re-pairing']);
    expect(rows().map((r) => r.dataset.status)).toEqual(['connected', 'reachable', 'unreachable', 'needs-repair']);
  });

  it('offers "Pair again" only for a host that refused the credential, never for an unreachable one', async () => {
    await mount();
    const pairAgain = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Pair again');
    expect(pairAgain).toHaveLength(1);
    expect(pairAgain[0].closest('[role="listitem"]')?.textContent).toContain('revoked-mac');
  });

  it('hands a clicked host to the attach dialog', async () => {
    await mount();
    act(() => rows()[1].click());
    expect(onOpenHost).toHaveBeenCalledWith('idle');
  });
});

describe('Other computers — pairing field', () => {
  it('reads the clipboard only on the Paste click — not on open, typing or submit', async () => {
    await mount();
    act(() => (container.querySelector('[aria-label="Pair new computer"]') as HTMLButtonElement).click());
    await flush();
    type('https://desk.tail1234.ts.net ');
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(readText).not.toHaveBeenCalled();

    await act(async () => buttonNamed('Paste link')!.click());
    await flush();
    expect(readText).toHaveBeenCalledTimes(1);
    // The address is readable; only the code is dots.
    expect(field().type).toBe('text');
    expect(field().value).toBe('https://desk.tail1234.ts.net/pair#wmux-desktop-code=••••••••');
    expect(container.querySelector('[data-testid="remote-hub-destination"]')?.textContent).toBe(
      'Pairs with https://desk.tail1234.ts.net',
    );
  });

  it('pairs a new computer from the pasted link in one click', async () => {
    await mount();
    act(() => (container.querySelector('[aria-label="Pair new computer"]') as HTMLButtonElement).click());
    await act(async () => buttonNamed('Paste link')!.click());
    await flush();
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    // Origin and code only — the raw link never crosses into main.
    expect(hostsPair).toHaveBeenCalledWith('https://desk.tail1234.ts.net', 'QWXZ7K9M', undefined);
    expect(hostsStatus).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('[data-testid="remote-hub-pair-form"]')).toBeNull();
  });

  it('registers a `wmux web` token URL through hostsAdd', async () => {
    await mount();
    act(() => (container.querySelector('[aria-label="Pair new computer"]') as HTMLButtonElement).click());
    type('https://box.ts.net:7681/?token=abc');
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(hostsAdd).toHaveBeenCalledWith('https://box.ts.net:7681/?token=abc');
    expect(hostsPair).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) link without calling main', async () => {
    await mount();
    act(() => (container.querySelector('[aria-label="Pair new computer"]') as HTMLButtonElement).click());
    type('javascript:alert(1)//https://x/pair?code=QWXZ7K9M');
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(hostsPair).not.toHaveBeenCalled();
    expect(hostsAdd).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('not a pairing link');
  });

  it('re-pairs a refused host IN PLACE (replaceHostId) and clears its rejected flag', async () => {
    act(() => useStore.setState({
      remoteWorkspaces: [
        { key: 'revoked::ws', hostId: 'revoked', hostLabel: 'revoked-mac', workspaceId: 'ws', name: 'ws', panes: [], authRejected: true },
      ] as never,
    }));
    hostsPair.mockResolvedValue({ ok: true, host: host('revoked') });
    await mount();
    act(() => buttonNamed('Pair again')!.click());
    expect(container.textContent).toContain('“revoked-mac”');
    type('https://revoked.ts.net/pair#wmux-desktop-code=QWXZ7K9M');
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(hostsPair).toHaveBeenCalledWith('https://revoked.ts.net', 'QWXZ7K9M', undefined, 'revoked');
    expect(useStore.getState().remoteWorkspaces[0]?.authRejected).toBe(false);
    act(() => useStore.setState({ remoteWorkspaces: [] }));
  });

  it('keeps the existing "already registered" answer', async () => {
    hostsPair.mockResolvedValue({ ok: false, reason: 'already-registered' });
    await mount();
    act(() => (container.querySelector('[aria-label="Pair new computer"]') as HTMLButtonElement).click());
    type(LINK);
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(container.querySelector('[data-testid="remote-hub-pair-form"]')).not.toBeNull();
  });
});

describe('Other computers — credential safety', () => {
  const openForm = () => act(() => (container.querySelector('[aria-label="Pair new computer"]') as HTMLButtonElement).click());

  it('refuses a re-pair whose link points at a different machine, before any IPC', async () => {
    await mount();
    act(() => buttonNamed('Pair again')!.click());
    type(LINK); // desk.tail1234.ts.net, not revoked.ts.net
    expect(container.querySelector('[data-testid="remote-hub-origin-mismatch"]')?.textContent).toContain(
      'https://desk.tail1234.ts.net',
    );
    expect(buttonNamed('Pair')!.disabled).toBe(true);
    expect(hostsPair).not.toHaveBeenCalled();
  });

  it('refuses plain http to another computer with a "needs HTTPS" reason', async () => {
    await mount();
    openForm();
    type('http://192.168.1.5:7681/pair#wmux-desktop-code=QWXZ7K9M');
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(hostsPair).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('needs HTTPS');
  });

  it('refuses a link hiding its address behind user@', async () => {
    await mount();
    openForm();
    type('https://desk.ts.net@evil.example/pair#wmux-desktop-code=QWXZ7K9M');
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(hostsPair).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.className).toBe('ui-row-error');
  });

  it('frees the form as soon as pairing succeeds; statuses refresh behind it', async () => {
    await mount();
    hostsStatus.mockReturnValue(new Promise(() => undefined)); // never answers
    openForm();
    type(LINK);
    await act(async () => buttonNamed('Pair')!.click());
    await flush();
    expect(container.querySelector('[data-testid="remote-hub-pair-form"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-hub-paired-with"]')?.textContent).toBe(
      'Paired with https://desk.tail1234.ts.net',
    );
    // Open again at once: not stuck "Pairing…".
    openForm();
    expect(buttonNamed('Pairing…')).toBeUndefined();
  });

  it('does not open a host registered over plain http (its token would cross in the clear)', async () => {
    hostsStatus.mockResolvedValue({ live: 'insecure' });
    await mount();
    expect(rows()[0].disabled).toBe(true);
    expect(statusTexts()[0]).toBe('Needs HTTPS');
  });
});
