// @vitest-environment jsdom
//
// The New company dialog and the folder's company in its wmux.json: opened
// from the file it is filled from it; "Save as this folder's company" reads
// the file, confirms, and saves the dialog's company with the hash it read,
// or says why it cannot.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../utils/projectConfigProbe', () => ({ probeProjectConfig: vi.fn(async () => null) }));

import { useStore } from '../../../stores';
import { probeProjectConfig } from '../../../utils/projectConfigProbe';
import { BUILTIN_COMPANY_PRESETS } from '../../../../shared/companyPreset';
import { companyFileJson, type CompanyFileView, type WmuxProjectCompany } from '../../../../shared/companyFile';
import type { ProjectConfigState } from '../../../../shared/wmuxProjectConfig';
import CompanyPresetDialog from '../CompanyPresetDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY: WmuxProjectCompany = {
  name: 'shop team',
  mission: 'Ship one-click refunds',
  standingOrders: 'Every PR gets a review\nbefore it merges.',
  ceo: 1,
  seats: [
    { label: 'web', owns: 'Storefront', agent: 'claude' },
    { label: 'ceo', owns: 'Plans the work', agent: 'claude' },
    { label: 'api', owns: 'Payments', agent: 'codex' },
  ],
};

let container: HTMLDivElement;
let root: Root;
let saved: Partial<ReturnType<typeof useStore.getState>>;
const companyGet = vi.fn();
const companySave = vi.fn();
const pickFolder = vi.fn();
const onClose = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const get = vi.fn();
const seatLaunches = vi.fn();
const APPROVED_FILE: ProjectConfigState = {
  found: true, root: '/dev/shop', configPath: '/dev/shop/wmux.json', contentHash: 'h1', trust: 'trusted', companyReviewed: true,
  config: { version: 1, company: COMPANY },
};

function renderFromFile(): void {
  act(() => root.render(createElement(CompanyPresetDialog, { fromFile: { company: COMPANY, folder: '/dev/shop' }, onClose })));
}

function button(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

const saveLink = () => container.querySelector('[data-company-file-save]') as HTMLButtonElement;
const confirmBox = () => container.querySelector('[data-company-file-confirm]') as HTMLElement | null;

async function openConfirm(view: CompanyFileView): Promise<HTMLElement> {
  companyGet.mockResolvedValue(view);
  await act(async () => saveLink().click());
  await flush();
  const box = confirmBox();
  if (!box) throw new Error('no confirm');
  return box;
}

beforeEach(() => {
  const s = useStore.getState();
  saved = { workspaces: s.workspaces };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  companyGet.mockReset();
  get.mockReset().mockResolvedValue(APPROVED_FILE);
  seatLaunches.mockReset().mockResolvedValue({ ok: true, labels: COMPANY.seats.map((s) => s.label), commands: COMPANY.seats.map(() => null), cwds: COMPANY.seats.map(() => null) });
  companySave.mockReset().mockResolvedValue({ ok: true, contentHash: 'h2' });
  pickFolder.mockReset().mockResolvedValue(['/dev/shop']);
  onClose.mockReset();
  vi.mocked(probeProjectConfig).mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    projectConfig: { companyGet, companySave, get },
    dialog: { pickFolder },
    company: { seatLaunches },
  };
  act(() => useStore.setState({ workspaces: [{ id: 'ws-1', name: 'shop', metadata: { cwd: '/dev/shop' } }] } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState(saved));
});

describe('CompanyPresetDialog from the folder\'s wmux.json', () => {
  it('is filled from the file: name, folder, mission, standing orders, seats and the CEO', () => {
    renderFromFile();
    expect(container.querySelector('.ui-dialog-title')?.textContent).toBe('New company: shop team');
    const inputs = container.querySelectorAll('input');
    expect((inputs[0] as HTMLInputElement).value).toBe('shop team');
    expect(container.querySelector('[data-preset-folder]')?.textContent).toBe('/dev/shop');
    expect((inputs[1] as HTMLInputElement).value).toBe('Ship one-click refunds');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Every PR gets a review\nbefore it merges.');
    const rows = Array.from(container.querySelectorAll('[data-preset-seat]'));
    expect(rows.map((r) => (r.querySelector('input') as HTMLInputElement).value)).toEqual(['web', 'ceo', 'api']);
    expect(rows.map((r) => r.querySelector('[role="radio"]')?.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(rows.map((r) => (r.querySelector('select') as HTMLSelectElement).value)).toEqual(['claude', 'claude', 'codex']);
  });

  it('a built-in preset keeps its title, and Save is off until a folder is chosen', async () => {
    act(() => root.render(createElement(CompanyPresetDialog, { preset: BUILTIN_COMPANY_PRESETS[1], onClose })));
    expect(container.querySelector('.ui-dialog-title')?.textContent).toBe('New company: Lead + reviewer');
    expect(saveLink().disabled).toBe(true);
    await act(async () => (container.querySelector('[data-preset-folder]') as HTMLButtonElement).click());
    await flush();
    expect(saveLink().disabled).toBe(false);
  });

  it('reads the file, confirms, and saves the dialog\'s company with the hash it read', async () => {
    renderFromFile();
    const box = await openConfirm({ dir: '/dev/shop', exists: true, contentHash: 'h1' });
    expect(companyGet).toHaveBeenCalledWith('/dev/shop');
    expect(box.textContent).toContain('Save this company to /dev/shop/wmux.json?');
    expect(box.textContent).toContain('It never holds launch flags, environment, tokens, folders, or seats on other PCs.');
    expect(box.textContent).not.toContain('It replaces');
    expect(companySave).not.toHaveBeenCalled();

    await act(async () => button('Save', box).click());
    await flush();
    expect(companySave).toHaveBeenCalledWith('/dev/shop', companyFileJson(COMPANY), 'h1');
    expect(confirmBox()).toBeNull();
    expect(container.querySelector('[data-company-file-note]')?.textContent).toBe('Saved to /dev/shop/wmux.json.');
    expect(probeProjectConfig).toHaveBeenCalledWith('ws-1');
    // The dialog stays, and Make is still there.
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Make company').disabled).toBe(false);
  });

  it('makes the company only while the file\'s company is approved here, as main reads it at Make', async () => {
    get.mockResolvedValue({ ...APPROVED_FILE, trust: 'stale', contentHash: 'h9', companyReviewed: undefined });
    renderFromFile();
    await act(async () => button('Make company').click());
    await flush();
    expect(get).toHaveBeenCalledWith('/dev/shop');
    expect(seatLaunches).not.toHaveBeenCalled();
    expect(container.querySelector('[data-company-file-note]')?.textContent)
      .toBe('This folder\'s wmux.json changed, or its company is no longer approved here. Pick it from the + menu again to review it.');

    get.mockResolvedValue(APPROVED_FILE);
    await act(async () => button('Make company').click());
    await flush();
    expect(seatLaunches).toHaveBeenCalledTimes(1);
    expect(seatLaunches.mock.calls[0][0]).toMatchObject({ company: COMPANY.name, folder: '/dev/shop' });
  });

  it('says why Save is off when the text is what the file can\'t keep', () => {
    act(() => root.render(createElement(CompanyPresetDialog, {
      fromFile: { company: { ...COMPANY, standingOrders: 'Review\tevery PR' }, folder: '/dev/shop' },
      onClose,
    })));
    expect(saveLink().disabled).toBe(true);
    expect(container.querySelector('[data-company-file-unsavable]')?.textContent)
      .toBe('This company can\'t be saved to wmux.json: a field holds a tab or a hidden character, or is too long.');
  });

  it('puts the keyboard on the confirm\'s Save once it opens', async () => {
    renderFromFile();
    await openConfirm({ dir: '/dev/shop', exists: true, contentHash: 'h1' });
    expect(document.activeElement?.textContent).toBe('Save');
  });

  it('says which company the save replaces', async () => {
    renderFromFile();
    const box = await openConfirm({ dir: '/dev/shop', exists: true, contentHash: 'h1', company: { ...COMPANY, name: 'old team' } });
    expect(box.textContent).toContain('It replaces the company already in this file, old team.');
  });

  it.each([
    ['other-folder', { dir: '/dev', exists: true, contentHash: 'h1' }, 'This folder\'s company is kept in /dev/wmux.json. Choose that folder to save it there.'],
    ['review-first', { dir: '/dev/shop', exists: true, contentHash: 'h1' }, '/dev/shop/wmux.json holds settings not approved on this PC. Review it from the sidebar first.'],
    ['no-project', { exists: false }, 'Choose a folder in a git repository to save its company.'],
    ['invalid', { dir: '/dev/shop', exists: true, contentHash: 'h1' }, '/dev/shop/wmux.json can\'t be read.'],
  ] as const)('a %s file shows why in place of Save', async (reason, view, text) => {
    renderFromFile();
    const box = await openConfirm({ ...view, saveBlocked: reason });
    expect(box.querySelector('[data-company-file-blocked]')?.textContent).toBe(text);
    expect(Array.from(box.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Cancel']);
    expect(companySave).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, error: 'changed' }, 'wmux.json changed since it was read. Try again.'],
    [{ ok: false, error: 'write-failed', detail: 'EACCES' }, 'wmux.json was not saved: EACCES'],
    [{ ok: false, error: 'invalid-input' }, 'This company can\'t be saved as it is.'],
  ])('a refused save says why', async (result, text) => {
    companySave.mockResolvedValue(result);
    renderFromFile();
    const box = await openConfirm({ dir: '/dev/shop', exists: true, contentHash: 'h1' });
    await act(async () => button('Save', box).click());
    await flush();
    expect(container.querySelector('[data-company-file-note]')?.textContent).toBe(text);
    expect(probeProjectConfig).not.toHaveBeenCalled();
  });
});
