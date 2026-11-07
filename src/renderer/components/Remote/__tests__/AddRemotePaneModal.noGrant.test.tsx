// @vitest-environment jsdom
//
// A pairing without the workspace grant cannot start a pane on the other PC:
// the host refuses the fresh workspace id with `unknown-workspace-id`. The
// dialog says so in its own words, naming the PC, and never shows the host's
// English detail.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import AddRemotePaneModal from '../AddRemotePaneModal';
import type { RemoteHostPublic } from '../../../../shared/remoteHosts';
import { en } from '../../../i18n/locales/en';
import { ko } from '../../../i18n/locales/ko';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST: RemoteHostPublic = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  addedAt: 1,
  allowInput: true,
};
const DETAIL = 'no live pane is running in that workspace — the daemon can only verify a workspace id it can see on a running session.';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function pickHostAndRead(title?: string): Promise<string> {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remote: {
      hostsList: vi.fn().mockResolvedValue([HOST]),
      workspaceCreate: vi.fn().mockResolvedValue({ ok: false, error: DETAIL, reason: 'unknown-workspace-id' }),
    },
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  act(() => r.render(<AddRemotePaneModal onClose={() => undefined} onCreated={() => undefined} {...(title ? { title } : {})} />));
  root = r;
  container = host;
  await flush();
  const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('office-mac'));
  expect(btn).toBeTruthy();
  await act(async () => {
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
  return document.body.querySelector('[role="alert"]')?.textContent ?? '';
}

describe('AddRemotePaneModal — a pairing that may not start panes', () => {
  // Read per test, so a build without the text fails each case on what the
  // dialog showed rather than the whole file on a missing key.
  const expected = (): string => String((en as Record<string, string>)['remote.newPaneNoWorkspaceGrant']).replace('{name}', 'office-mac');

  it('New remote pane words the refusal and names the PC', async () => {
    const text = await pickHostAndRead();
    expect(text).toBe(expected());
    expect(text).not.toContain('no live pane');
  });

  it('Split right — remote says the same', async () => {
    const text = await pickHostAndRead('Split right — remote');
    expect(text).toBe(expected());
    expect(text).not.toContain('workspaceId');
  });

  it('has a Korean text that names the PC too', () => {
    expect((ko as Record<string, string>)['remote.newPaneNoWorkspaceGrant']).toContain('{name}');
  });
});
