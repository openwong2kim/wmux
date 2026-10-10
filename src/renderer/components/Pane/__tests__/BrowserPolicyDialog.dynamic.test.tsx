// @vitest-environment jsdom
//
// The pane's browser-protection editor against a mocked preload policy API:
// what it writes (with the epoch it read), how it handles a stale write, the
// empty-allowlist copy, the rebind notice, and per-line host validation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import BrowserPolicyDialog, { hostLines, invalidHostLines } from '../BrowserPolicyDialog';
import { useStore } from '../../../stores';
import type { BrowserPolicyReadResult, BrowserPolicyWritePayload, BrowserPolicyWriteResult, PanePolicy } from '../../../../shared/browserPolicy';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'ws-1';
const PANE = 'pane-1';

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let readResult: BrowserPolicyReadResult;
type WriteReply = BrowserPolicyWriteResult;
const api = {
  get: vi.fn<(ws: string, pane: string) => Promise<BrowserPolicyReadResult>>(async () => readResult),
  set: vi.fn<(p: BrowserPolicyWritePayload) => Promise<WriteReply>>(async () => ({ ok: true, epoch: 9 })),
};
const onClose = vi.fn();
const onSaved = vi.fn();

function entry(over: Partial<PanePolicy> = {}): PanePolicy {
  return {
    workspaceId: WS, paneId: PANE, profileId: 'work', protected: true,
    hosts: { mode: 'allowlist', allow: ['example.com'], block: [] },
    ...over,
  };
}

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(React.createElement(BrowserPolicyDialog, { workspaceId: WS, paneId: PANE, onClose, onSaved }));
  });
  await flush();
}

const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);

async function click(id: string): Promise<void> {
  const el = q(id);
  expect(el, id).not.toBeNull();
  act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}

function type(id: string, value: string): void {
  const el = q<HTMLTextAreaElement>(id)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function chooseMode(label: string): void {
  const btn = [...q('browser-policy-mode')!.querySelectorAll('button')].find((b) => b.textContent === label)!;
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  readResult = { ok: true, state: 'ok', epoch: 4, policy: entry(), currentProfile: 'work' };
  api.get.mockClear();
  api.set.mockClear();
  onClose.mockClear();
  onSaved.mockClear();
  useStore.setState({ toasts: [] });
  (window as unknown as { electronAPI: unknown }).electronAPI = { browser: { policy: api } };
});

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  container?.remove();
  root = undefined;
  container = undefined;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('host line parsing', () => {
  it('trims, drops empty lines, and reports the textarea line of each bad rule', () => {
    expect(hostLines('  a.com \n\n*.b.com\r\n')).toEqual(['a.com', '*.b.com']);
    expect(invalidHostLines('a.com\n\nhttps://x.com/path\nbad host')).toEqual([
      { line: 3, rule: 'https://x.com/path' },
      { line: 4, rule: 'bad host' },
    ]);
  });
});

describe('BrowserPolicyDialog', () => {
  it('loads the pane policy and saves it with the epoch it read', async () => {
    await mount();
    expect(api.get).toHaveBeenCalledWith(WS, PANE);
    expect(q<HTMLTextAreaElement>('browser-policy-allow')!.value).toBe('example.com');
    type('browser-policy-allow', ' example.com \n\n*.docs.example.com\n');
    type('browser-policy-block', 'ads.example.com');
    await click('browser-policy-save');
    expect(api.set).toHaveBeenCalledWith({
      workspaceId: WS,
      paneId: PANE,
      profileId: 'work',
      protected: true,
      hosts: { mode: 'allowlist', allow: ['example.com', '*.docs.example.com'], block: ['ads.example.com'] },
      expectedEpoch: 4,
    });
    expect(onSaved).toHaveBeenCalledWith(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('a stale write reloads, toasts, and stays open', async () => {
    await mount();
    api.set.mockResolvedValueOnce({ ok: false, code: 'stale', error: 'the browser policy changed since it was read; re-read and try again' });
    readResult = { ...readResult, epoch: 7, policy: entry({ hosts: { mode: 'allowlist', allow: ['other.com'], block: [] } }) };
    await click('browser-policy-save');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'info', message: 'Changed elsewhere — reloaded' });
    expect(onClose).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('browser-policy-allow')!.value).toBe('other.com');
    await click('browser-policy-save');
    expect(api.set.mock.calls.at(-1)![0].expectedEpoch).toBe(7);
  });

  it('only the stale code reloads, never the message text', async () => {
    await mount();
    api.set.mockResolvedValueOnce({ ok: false, code: 'invalid', error: 'stale? re-read and try again' });
    await click('browser-policy-save');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'error' });
  });

  it('any other refusal toasts its error and stays open', async () => {
    await mount();
    api.set.mockResolvedValueOnce({ ok: false, code: 'not-exclusive', error: 'protection needs a Chrome profile bound to this pane alone' });
    await click('browser-policy-save');
    expect(useStore.getState().toasts.at(-1)).toMatchObject({
      level: 'error', message: 'protection needs a Chrome profile bound to this pane alone',
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains that an empty "Only these sites" list blocks everything', async () => {
    await mount();
    expect(q('browser-policy-empty-allowlist')).toBeNull();
    type('browser-policy-allow', '  \n');
    expect(q('browser-policy-empty-allowlist')?.textContent).toBe('No sites listed: this pane will open nothing.');
    chooseMode('Any site');
    expect(q('browser-policy-empty-allowlist')).toBeNull();
    expect(q('browser-policy-allow')).toBeNull();
  });

  it('shows a rebind notice and Save confirms the current profile', async () => {
    readResult = { ok: true, state: 'ok', epoch: 5, policy: entry({ profileId: 'old' }), currentProfile: 'work' };
    await mount();
    expect(q('browser-policy-rebound')?.textContent).toContain('Profile changed — confirm the allowed sites');
    await click('browser-policy-save');
    expect(api.set.mock.calls[0][0]).toMatchObject({ profileId: 'work', protected: true, expectedEpoch: 5 });
  });

  it('no rebind notice when the policy matches the pane', async () => {
    await mount();
    expect(q('browser-policy-rebound')).toBeNull();
  });

  it('flags invalid lines and will not save them', async () => {
    await mount();
    type('browser-policy-allow', 'example.com\nhttps://example.com/login');
    expect(q('browser-policy-allow-errors')?.textContent).toContain('Line 2');
    expect(q<HTMLButtonElement>('browser-policy-save')!.disabled).toBe(true);
    await click('browser-policy-save');
    expect(api.set).not.toHaveBeenCalled();
  });

  it('an unprotected pane with no stored policy closes without writing', async () => {
    readResult = { ok: true, state: 'missing', epoch: 0, policy: null, currentProfile: 'work' };
    await mount();
    expect(q('browser-policy-mode')).toBeNull();
    await click('browser-policy-save');
    expect(api.set).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('turning protection on for a new pane writes it', async () => {
    readResult = { ok: true, state: 'missing', epoch: 0, policy: null, currentProfile: 'work' };
    await mount();
    await click('browser-policy-protect');
    await click('browser-policy-save');
    expect(api.set.mock.calls[0][0]).toMatchObject({
      protected: true, hosts: { mode: 'off', allow: [], block: [] }, expectedEpoch: 0,
    });
  });

  it('a failed read toasts and closes', async () => {
    readResult = { ok: false, error: 'that pane is not in that workspace' };
    await mount();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'error', message: 'that pane is not in that workspace' });
    expect(onClose).toHaveBeenCalled();
  });

  it('an unreadable policy file says so, and Save writes even with protection off', async () => {
    readResult = { ok: true, state: 'corrupt', epoch: 0, policy: null, currentProfile: 'work' };
    await mount();
    expect(q('browser-policy-unreadable')).not.toBeNull();
    await click('browser-policy-save');
    expect(api.set.mock.calls[0][0]).toMatchObject({ protected: false, expectedEpoch: 0 });
  });

  it('a hidden invalid list never blocks Save and is sent without its bad lines', async () => {
    await mount();
    type('browser-policy-allow', 'example.com\nbad host');
    chooseMode('Any site');
    expect(q<HTMLButtonElement>('browser-policy-save')!.disabled).toBe(false);
    await click('browser-policy-save');
    expect(api.set.mock.calls[0][0].hosts).toEqual({ mode: 'off', allow: ['example.com'], block: [] });
  });

  it('turning protection off is not blocked by an invalid block list', async () => {
    await mount();
    type('browser-policy-block', 'bad host');
    await click('browser-policy-protect');
    await click('browser-policy-save');
    expect(api.set.mock.calls[0][0]).toMatchObject({ protected: false, hosts: { block: [] } });
  });

  it('renders outside the pane, on document.body', async () => {
    await mount();
    expect(container!.querySelector('[data-testid="browser-policy-dialog"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="browser-policy-dialog"]')).not.toBeNull();
  });

  it('the switch description follows the toggle and the refused state', async () => {
    readResult = { ok: true, state: 'corrupt', epoch: 0, policy: null, currentProfile: 'work' };
    await mount();
    const desc = () => document.querySelector('[data-testid="browser-policy-dialog"] .ui-field-description')?.textContent;
    expect(desc()).toBe('Off: saving lifts the block and the pane browses as before.');
    await click('browser-policy-protect');
    expect(desc()).toBe("On: agents open only the allowed sites, in this pane's own Chrome profile.");
  });

  it('warns that Chrome restarts only when the protection would change', async () => {
    await mount();
    expect(q('browser-policy-restart')).toBeNull();
    type('browser-policy-allow', 'other.com');
    expect(q('browser-policy-restart')).toBeNull();
    await click('browser-policy-protect');
    expect(q('browser-policy-restart')?.textContent).toBe('Chrome for this pane restarts when you save, and its open tabs close.');
  });

  it("main's legacy decision means no refused notice, even with an unreadable file", async () => {
    readResult = { ok: true, state: 'corrupt', epoch: 0, policy: null, currentProfile: 'work', decision: 'legacy' } as BrowserPolicyReadResult;
    await mount();
    expect(q('browser-policy-unreadable')).toBeNull();
    await click('browser-policy-save');
    expect(api.set).not.toHaveBeenCalled();
  });
});
