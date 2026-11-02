// @vitest-environment jsdom
//
// The review of a folder's company before it first starts here: each seat
// with what wmux starts and where it works, the text verbatim, the rest of an
// untrusted file; Approve trusts the shown bytes with the company reviewed
// and only then makes the company, from the file's folder. The whole file is
// shown on request, only while it is the one on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { createLeafPane } from '../../../../shared/types';
import type { ProjectConfigState, WmuxProjectCompany } from '../../../../shared/wmuxProjectConfig';
import CompanyFileReviewDialog from '../CompanyFileReviewDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY: WmuxProjectCompany = {
  name: 'shop team',
  mission: 'Ship one-click refunds',
  standingOrders: 'The CEO writes no code.\n  Every PR gets a review from #reviewer.',
  ceo: 0,
  seats: [
    { label: 'ceo', owns: 'Plans the work', agent: 'claude' },
    { label: 'web', owns: 'Storefront', agent: 'claude' },
    { label: 'api', owns: 'Payments', agent: 'codex' },
    { label: 'notes', owns: 'Notes' },
  ],
};

const UNTRUSTED: ProjectConfigState = {
  found: true,
  root: '/dev/shop',
  configPath: '/dev/shop/wmux.json',
  contentHash: 'h1',
  trust: 'untrusted',
  config: {
    version: 1,
    company: COMPANY,
    commands: [{ id: 'dev', title: 'Dev server', command: 'npm run dev' }],
    fanout: { setup: 'npm ci', copy: ['.env'] },
  },
};
const APPROVED: ProjectConfigState = { ...UNTRUSTED, trust: 'trusted', unattended: false, companyReviewed: true };
const WHOLE = '{\r\n  "version": 1,\r\n  "portRange": [3000, 3100],\r\n  "x": "a\u202eb",\r\n  "company": {}\r\n}';

let container: HTMLDivElement;
let root: Root;
let saved: Partial<ReturnType<typeof useStore.getState>>;
const setTrust = vi.fn();
const get = vi.fn();
const text = vi.fn();
const seatLaunches = vi.fn();
const workerAgents = vi.fn();
const onClose = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function render(state: ProjectConfigState): Promise<HTMLElement> {
  act(() => useStore.setState({ projectConfigs: { 'ws-1': state } } as never));
  act(() => root.render(createElement(CompanyFileReviewDialog, { workspaceId: 'ws-1', onClose })));
  await flush();
  return container.querySelector('[data-testid="company-file-review-dialog"]') as HTMLElement;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

const cells = (i: number) =>
  Array.from(container.querySelectorAll(`[data-review-seat="${i}"] td`)).map((td) => td.textContent);

beforeEach(() => {
  const s = useStore.getState();
  saved = { workspaces: s.workspaces, projectConfigs: s.projectConfigs, activeWorkspaceId: s.activeWorkspaceId, projectLayoutAutoApplied: s.projectLayoutAutoApplied };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setTrust.mockReset().mockResolvedValue({ ok: true });
  get.mockReset().mockResolvedValue(APPROVED);
  text.mockReset().mockResolvedValue({ configPath: '/dev/shop/wmux.json', contentHash: 'h1', text: WHOLE });
  seatLaunches.mockReset().mockResolvedValue({
    ok: true,
    labels: ['ceo', 'web', 'api', 'notes'],
    commands: ['claude', 'claude', 'codex', null],
    cwds: [null, '/wt/web', '/wt/api', null],
  });
  workerAgents.mockReset().mockResolvedValue([
    { agent: 'claude', label: 'Claude Code', installed: true },
    { agent: 'codex', label: 'Codex', installed: true },
  ]);
  onClose.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    projectConfig: { setTrust, get, text },
    company: { seatLaunches },
    factory: { workerAgents },
  };
  act(() => useStore.setState({ workspaces: [{ id: 'ws-1', name: 'shop', metadata: { cwd: '/dev/shop' } }] } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState(saved));
});

describe('CompanyFileReviewDialog', () => {
  it('lists each seat with its agent, what wmux starts and where it works', async () => {
    const dialog = await render(UNTRUSTED);
    expect(dialog.querySelector('.ui-dialog-title')?.textContent).toBe('Review shop team before it starts');
    expect(dialog.textContent).toContain('From /dev/shop/wmux.json. Nothing starts until you approve it on this PC.');
    expect(dialog.textContent).toContain('Seats (4)');
    expect(cells(0)).toEqual(['ceoCEO', 'Plans the work', 'Claude Code', 'claude', 'this folder']);
    expect(cells(1)).toEqual(['web', 'Storefront', 'Claude Code', 'claude', 'own worktree']);
    expect(cells(2)).toEqual(['api', 'Payments', 'Codex', 'codex', 'own worktree']);
    expect(cells(3)).toEqual(['notes', 'Notes', 'No agent', 'plain shell', 'this folder']);
  });

  it('shows the mission and standing orders verbatim', async () => {
    await render(UNTRUSTED);
    expect(container.querySelector('[data-company-review-mission] > p')?.textContent).toBe('Ship one-click refunds');
    expect(container.querySelector('[data-company-review-orders] > p')?.textContent)
      .toBe('The CEO writes no code.\n  Every PR gets a review from #reviewer.');
  });

  it('lists the rest of the file only while it is not trusted', async () => {
    await render(UNTRUSTED);
    const also = container.querySelector('[data-company-review-also]') as HTMLElement;
    expect(also.textContent).toContain('approving trusts them too');
    expect(also.textContent).toContain('npm run dev');
    expect(also.textContent).toContain('npm ci');
    expect(also.textContent).toContain('.env');

    act(() => root.unmount());
    root = createRoot(container);
    await render({ ...UNTRUSTED, trust: 'trusted', prepReviewed: true, companyReviewed: false });
    expect(container.querySelector('[data-company-review-also]')).toBeNull();
  });

  it('says a layout in the file can then open new workspaces of this folder', async () => {
    const layout = { type: 'branch' as const, direction: 'horizontal' as const, children: [{ type: 'leaf' as const, command: 'npm run dev' }, { type: 'leaf' as const }] };
    await render({ ...UNTRUSTED, config: { ...UNTRUSTED.config!, layout } });
    expect(container.querySelector('[data-company-review-also]')?.textContent)
      .toContain('approving trusts them too, and new workspaces in this folder can then open with its layout');
  });

  it('keeps showing the file it opened on, and turns Approve off, when another file is read while it is open', async () => {
    await render(UNTRUSTED);
    act(() => useStore.setState({
      projectConfigs: { 'ws-1': { ...UNTRUSTED, configPath: '/dev/other/wmux.json', root: '/dev/other', contentHash: 'h3', config: { version: 1, company: { ...COMPANY, name: 'other team' } } } },
    } as never));
    expect(container.querySelector('.ui-dialog-title')?.textContent).toBe('Review shop team before it starts');
    expect(container.querySelector('[data-company-review-moved]')?.textContent)
      .toBe('This file changed while this was open. Close it and pick the company again to review it.');
    const approve = button('Approve and make company');
    expect(approve.disabled).toBe(true);
    await act(async () => approve.click());
    await flush();
    expect(setTrust).not.toHaveBeenCalled();
    expect(seatLaunches).not.toHaveBeenCalled();
  });

  it('shows the whole file on request, each hidden character as its code point, even with nothing else to list', async () => {
    await render({ ...UNTRUSTED, config: { version: 1, company: COMPANY } });
    expect(container.querySelector('[data-company-review-also]')).toBeNull();
    expect(container.querySelector('[data-company-review-file]')).toBeNull();
    await act(async () => button('Show the whole file').click());
    await flush();
    expect(text).toHaveBeenCalledWith('/dev/shop');
    expect(container.querySelector('[data-company-review-file]')?.textContent)
      .toBe('{\n  "version": 1,\n  "portRange": [3000, 3100],\n  "x": "a⟨U+202E⟩b",\n  "company": {}\n}');
    expect(container.querySelector('[data-company-review-hidden]')?.textContent)
      .toBe('Hidden characters in this file: 1. Each is shown as ⟨U+…⟩ where it sits.');
    expect(button('Approve and make company').disabled).toBe(false);
    await act(async () => button('Hide the whole file').click());
    expect(container.querySelector('[data-company-review-file]')).toBeNull();
  });

  it.each([
    ['other bytes', { configPath: '/dev/shop/wmux.json', contentHash: 'h2', text: '{"version": 1}' }],
    ['another file', { configPath: '/dev/wmux.json', contentHash: 'h1', text: '{"version": 1}' }],
    ['no file', null],
  ])('does not show a whole file with %s, and turns Approve off though the store still holds the file on screen', async (_what, read) => {
    text.mockResolvedValue(read);
    // The re-probe still reads the bytes on screen, as main's cache can after a same-size edit.
    get.mockResolvedValue(UNTRUSTED);
    await render(UNTRUSTED);
    await act(async () => button('Show the whole file').click());
    await flush();
    expect(get).toHaveBeenCalledWith('/dev/shop');
    expect(useStore.getState().projectConfigs['ws-1']?.contentHash).toBe('h1');
    expect(container.querySelector('[data-company-review-file]')).toBeNull();
    expect(container.querySelector('[data-company-review-moved]')).not.toBeNull();
    const approve = button('Approve and make company');
    expect(approve.disabled).toBe(true);
    await act(async () => approve.click());
    await flush();
    expect(setTrust).not.toHaveBeenCalled();
  });

  it('marks bytes that are not UTF-8 where they sit', async () => {
    text.mockResolvedValue({ configPath: '/dev/shop/wmux.json', contentHash: 'h1', text: '{"a": "x\ufffdy"}' });
    await render(UNTRUSTED);
    await act(async () => button('Show the whole file').click());
    await flush();
    expect(container.querySelector('[data-company-review-file]')?.textContent).toBe('{"a": "x⟨U+FFFD⟩y"}');
  });

  it('keeps a file dense in hidden characters to a bounded number of elements, every one still marked', async () => {
    text.mockResolvedValue({ configPath: '/dev/shop/wmux.json', contentHash: 'h1', text: `{"pad": "${'\u200b'.repeat(2500)}"}` });
    await render(UNTRUSTED);
    await act(async () => button('Show the whole file').click());
    await flush();
    expect(container.querySelectorAll('[data-hidden-char]').length).toBe(2000);
    const shown = container.querySelector('[data-company-review-file]')?.textContent ?? '';
    expect(shown).toBe(`{"pad": "${'⟨U+200B⟩'.repeat(2500)}"}`);
    expect(container.querySelector('[data-company-review-hidden]')?.textContent).toContain('Hidden characters in this file: 2500.');
  });

  it('still hides the whole file once the file on screen has changed', async () => {
    await render(UNTRUSTED);
    await act(async () => button('Show the whole file').click());
    await flush();
    act(() => useStore.setState({ projectConfigs: { 'ws-1': { ...UNTRUSTED, contentHash: 'h2' } } } as never));
    expect(button('Approve and make company').disabled).toBe(true);
    const hide = button('Hide the whole file');
    expect(hide.disabled).toBe(false);
    await act(async () => hide.click());
    expect(container.querySelector('[data-company-review-file]')).toBeNull();
    expect(button('Show the whole file').disabled).toBe(true);
  });

  it('lists the setup of trusted bytes whose grant never showed it, since approving covers it', async () => {
    await render({ ...UNTRUSTED, trust: 'trusted', prepReviewed: false, companyReviewed: false });
    const also = container.querySelector('[data-company-review-also]') as HTMLElement;
    expect(also.textContent).toContain('npm ci');
    expect(also.textContent).toContain('.env');
  });

  it('approves nothing when the file in the store is no longer the one on screen', async () => {
    await render(UNTRUSTED);
    const approve = button('Approve and make company');
    // The store moves on before the dialog has drawn it.
    useStore.setState({ projectConfigs: { 'ws-1': { ...UNTRUSTED, contentHash: 'h2' } } } as never);
    await act(async () => approve.click());
    await flush();
    expect(setTrust).not.toHaveBeenCalled();
    expect(seatLaunches).not.toHaveBeenCalled();
    expect(container.querySelector('[data-company-review-note]')?.textContent).toBe('wmux.json changed. Review it again.');
  });

  it('a trust decision that was not saved makes nothing', async () => {
    setTrust.mockRejectedValue(new Error('disk full'));
    await render(UNTRUSTED);
    await act(async () => button('Approve and make company').click());
    await flush();
    expect(seatLaunches).not.toHaveBeenCalled();
    expect(container.querySelector('[data-company-review-note]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Approve trusts the shown bytes with the company reviewed, then makes the company in the file\'s folder', async () => {
    await render(UNTRUSTED);
    await act(async () => button('Approve and make company').click());
    await flush();
    expect(setTrust).toHaveBeenCalledWith('/dev/shop', 'trusted', 'h1', false, true);
    expect(seatLaunches).toHaveBeenCalledTimes(1);
    expect(setTrust.mock.invocationCallOrder[0]).toBeLessThan(seatLaunches.mock.invocationCallOrder[0]);
    expect(seatLaunches.mock.calls[0][0]).toMatchObject({
      company: 'shop team',
      folder: '/dev/shop',
      mission: 'Ship one-click refunds',
      standingOrders: COMPANY.standingOrders,
      ceo: 0,
      tellSeats: true,
      seats: [
        { label: 'ceo', owns: 'Plans the work', agent: 'claude' },
        { label: 'web', owns: 'Storefront', agent: 'claude' },
        { label: 'api', owns: 'Payments', agent: 'codex' },
        { label: 'notes', owns: 'Notes' },
      ],
    });
    expect(useStore.getState().workspaces.some((w) => w.name === 'shop team' && w.company)).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('decides on the file as main reads it after the approval, not on what the approval saw', async () => {
    get.mockResolvedValueOnce(APPROVED).mockResolvedValueOnce({ ...APPROVED, contentHash: 'h2', trust: 'stale', companyReviewed: undefined });
    await render(UNTRUSTED);
    await act(async () => button('Approve and make company').click());
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(seatLaunches).not.toHaveBeenCalled();
    expect(container.querySelector('[data-company-review-note]')?.textContent).toBe('wmux.json changed. Review it again.');
  });

  it('a re-approval of trusted bytes keeps their unattended consent', async () => {
    await render({ ...UNTRUSTED, trust: 'trusted', unattended: true, companyReviewed: false });
    await act(async () => button('Approve and make company').click());
    await flush();
    expect(setTrust).toHaveBeenCalledWith('/dev/shop', 'trusted', 'h1', true, true);
  });

  it('a file changed under the approval makes nothing and asks again', async () => {
    get.mockResolvedValue({ ...APPROVED, contentHash: 'h2', trust: 'stale', companyReviewed: undefined });
    await render(UNTRUSTED);
    await act(async () => button('Approve and make company').click());
    await flush();
    expect(setTrust).toHaveBeenCalled();
    expect(seatLaunches).not.toHaveBeenCalled();
    expect(container.querySelector('[data-company-review-note]')?.textContent).toBe('wmux.json changed. Review it again.');
    expect(container.querySelector('[data-company-review-moved]')).not.toBeNull();
    expect(button('Approve and make company').disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('approving does not lay the file\'s layout over the workspace it was picked from', async () => {
    const pane = createLeafPane();
    const layout = { type: 'branch' as const, direction: 'horizontal' as const, children: [{ type: 'leaf' as const }, { type: 'leaf' as const }] };
    const withLayout = { ...UNTRUSTED, config: { ...UNTRUSTED.config!, layout } };
    get.mockResolvedValue({ ...APPROVED, config: withLayout.config });
    act(() => useStore.setState({
      workspaces: [{ id: 'ws-1', name: 'shop', metadata: { cwd: '/dev/shop' }, rootPane: pane }],
      projectLayoutAutoApplied: {},
    } as never));
    await render(withLayout);
    await act(async () => button('Approve and make company').click());
    await flush();
    expect(seatLaunches).toHaveBeenCalledTimes(1);
    expect(useStore.getState().workspaces.find((w) => w.id === 'ws-1')?.rootPane).toBe(pane);
  });

  it('Deny denies the file and closes', async () => {
    get.mockResolvedValue({ ...UNTRUSTED, trust: 'denied' });
    await render(UNTRUSTED);
    await act(async () => button('Deny').click());
    await flush();
    expect(setTrust).toHaveBeenCalledWith('/dev/shop', 'denied', 'h1', false, false);
    expect(seatLaunches).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('an agent that is not installed here is named and keeps Approve off', async () => {
    workerAgents.mockResolvedValue([
      { agent: 'claude', label: 'Claude Code', installed: true },
      { agent: 'codex', label: 'Codex', installed: false },
    ]);
    await render(UNTRUSTED);
    expect(container.querySelector('[data-company-review-install]')?.textContent).toBe('Install Codex to start this company.');
    const approve = button('Approve and make company');
    expect(approve.disabled).toBe(true);
    await act(async () => approve.click());
    expect(setTrust).not.toHaveBeenCalled();
  });
});
