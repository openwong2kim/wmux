// @vitest-environment jsdom
//
// Every way into remote attach after the sidebar's Remote button became the
// single remote hub:
//   - the + menu's "Attach remote workspace" opens the hub on "Other
//     computers" (and falls back to the attach dialog when no hub is mounted —
//     MiniSidebar.attachRemote.test.tsx pins that fallback);
//   - a host clicked in the hub opens the attach dialog already showing its
//     workspaces;
//   - the app-level "Pair again" (AppLayout → remoteRepairHostId) still mounts
//     the attach dialog in repair mode, whose pairing replaces the host in
//     place (AttachRemoteModal.repairAndAttached.test.tsx pins replaceHostId).
// And the phone half: the hub's menu is two buttons, Pair a phone (the app's
// one dialog) and Phone access settings (the settings view); a request for
// Phone access settings is answered by the Remote page's button alone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebToggle from '../WebToggle';
import PresetPicker from '../../Sidebar/PresetPicker';
import AttachRemoteModal from '../../Sidebar/AttachRemoteModal';
import { useStore } from '../../../stores';
import type { RemoteHostPublic } from '../../../../shared/remoteHosts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST: RemoteHostPublic = { id: 'host-1', label: 'office-mac', origin: 'https://office-mac.ts.net', addedAt: 1 };

let container: HTMLDivElement;
let root: Root;
let workspacesList: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  workspacesList = vi.fn().mockResolvedValue({ ok: true, workspaces: [] });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    web: {
      status: vi.fn(async () => ({ running: false })),
      deviceList: vi.fn(async () => ({ devices: [] })),
    },
    remote: {
      hostsList: vi.fn().mockResolvedValue([HOST]),
      hostsStatus: vi.fn().mockResolvedValue({ 'host-1': 'reachable' }),
      hostsAdd: vi.fn(),
      hostsPair: vi.fn(),
      hostsRemove: vi.fn(),
      workspacesList,
      workspaceCreate: vi.fn(),
      attachmentsAdd: vi.fn().mockResolvedValue(true),
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

describe('Remote hub entry points', () => {
  it('the sidebar hub registers itself and opens on "Other computers" when asked', async () => {
    const before = useStore.getState().remoteHubMounted;
    await act(async () => root.render(<WebToggle variant="sidebar" />));
    await flush();
    expect(useStore.getState().remoteHubMounted).toBe(before + 1);
    expect(document.querySelector('[data-testid="remote-hub-others"]')).toBeNull();

    await act(async () => useStore.getState().openRemoteHub());
    await flush();
    expect(document.querySelector('[data-testid="remote-hub-others"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="remote-hub-host"]')?.textContent).toContain('office-mac');

    act(() => root.unmount());
    root = createRoot(container);
    expect(useStore.getState().remoteHubMounted).toBe(before);
  });

  it('the + menu entry opens the hub instead of a dialog when a hub is mounted', async () => {
    act(() => useStore.setState({ remoteHubMounted: 1 }));
    const seq = useStore.getState().remoteHubRequestSeq;
    const onClose = vi.fn();
    await act(async () => root.render(createElement(PresetPicker, { onClose })));
    const row = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Attach remote workspace'),
    ) as HTMLButtonElement;
    await act(async () => row.click());
    await flush();
    expect(useStore.getState().remoteHubRequestSeq).toBe(seq + 1);
    expect(onClose).toHaveBeenCalled();
    expect(container.querySelector('.ui-dialog')).toBeNull();
    act(() => useStore.setState({ remoteHubMounted: 0 }));
  });

  it('a host handed over from the hub opens the attach dialog on its workspaces', async () => {
    await act(async () =>
      root.render(createElement(AttachRemoteModal, { initialHostId: 'host-1', onClose: vi.fn() })),
    );
    await flush();
    expect(workspacesList).toHaveBeenCalledWith('host-1');
  });

  it('the menu: Pair a phone closes the hub and opens the app\'s one dialog; settings opens in place', async () => {
    act(() => useStore.setState({ phonePairOpen: false }));
    await act(async () => root.render(<WebToggle variant="sidebar" />));
    await flush();
    const toggle = () => container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
    await act(async () => toggle().click());
    await flush();
    expect(document.querySelector('[data-testid="remote-hub-others"]')).not.toBeNull();
    const pair = document.querySelector('[data-testid="web-menu-pair"]') as HTMLButtonElement;
    expect(pair.textContent).toBe('Pair a phone…');
    await act(async () => pair.click());
    await flush();
    expect(useStore.getState().phonePairOpen).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    // No second dialog here: AppLayout mounts the one.
    expect(document.querySelector('[data-testid="phone-pair-dialog"]')).toBeNull();

    await act(async () => toggle().click());
    await flush();
    await act(async () => (document.querySelector('[data-testid="web-menu-settings"]') as HTMLButtonElement).click());
    await flush();
    expect(document.querySelector('[data-testid="web-menu-pair"]')).toBeNull();
    expect(document.body.textContent).toContain('Share this computer');
    act(() => useStore.setState({ phonePairOpen: false }));
  });

  it('a Phone access settings request opens the Remote page button once, and never the sidebar hub', async () => {
    await act(async () => root.render(<><WebToggle variant="sidebar" /><WebToggle variant="page" /></>));
    await flush();
    await act(async () => useStore.getState().setPhoneSettingsPending(true));
    await flush();
    const toggles = Array.from(container.querySelectorAll('[data-testid="deck-web-toggle"]'));
    expect(toggles.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    expect(document.querySelectorAll('[data-testid="web-menu-pair"]')).toHaveLength(0);
    expect(document.body.textContent).toContain('Share this computer');
    expect(useStore.getState().phoneSettingsPending).toBe(false);
  });

  it('a request made before the Remote page mounts is answered when it does', async () => {
    act(() => useStore.setState({ phoneSettingsPending: true }));
    await act(async () => root.render(<WebToggle variant="page" />));
    await flush();
    expect((container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement).getAttribute('aria-expanded')).toBe('true');
    expect(useStore.getState().phoneSettingsPending).toBe(false);
  });

  it('AppLayout mounts the one Pair a phone dialog from the store flag', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'Layout', 'AppLayout.tsx'), 'utf-8');
    expect(source).toMatch(/phonePairOpen && \(\s*<PhonePairDialog/);
    expect(source).toMatch(/setPhoneSettingsPending\(true\);\s*s\.setAppRoute\('remote'\)/);
    expect(source.match(/<PhonePairDialog/g)).toHaveLength(1);
  });

  it('AppLayout still mounts the attach dialog in repair mode for "Pair again"', () => {
    // Source pin (AppLayout has no jsdom fixture; house pattern: appLayout.*.test.ts).
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'Layout', 'AppLayout.tsx'), 'utf-8');
    expect(source).toMatch(/remoteRepairHostId && \(\s*<AttachRemoteModal[\s\S]{0,120}repairHostId=\{remoteRepairHostId\}/);
  });
});
