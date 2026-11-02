// @vitest-environment jsdom
//
// The + menu lists the active workspace's folder company (from its wmux.json)
// first under Company. Picking it opens its review while it waits for one,
// else the New company dialog filled from it; the menu makes nothing itself.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../utils/projectConfigProbe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/projectConfigProbe')>()),
  probeProjectConfig: vi.fn(async () => null),
}));

import { useStore } from '../../../stores';
import { probeProjectConfig } from '../../../utils/projectConfigProbe';
import type { ProjectConfigState, WmuxProjectCompany } from '../../../../shared/wmuxProjectConfig';
import PresetPicker from '../PresetPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const company = (name: string): WmuxProjectCompany => ({
  name,
  mission: 'Ship refunds',
  ceo: 0,
  seats: [
    { label: 'ceo', owns: 'Plans', agent: 'claude' },
    { label: 'web', owns: 'UI', agent: 'claude' },
    { label: 'api', owns: 'Payments', agent: 'codex' },
  ],
});

const shop = (patch: Partial<ProjectConfigState> = {}): ProjectConfigState => ({
  found: true,
  root: '/users/jamie/dev/shop',
  configPath: '/Users/jamie/dev/shop/wmux.json',
  contentHash: 'h1',
  trust: 'untrusted',
  config: { version: 1, company: company('shop team') },
  ...patch,
});
const OTHER = { ...shop(), configPath: '/Users/jamie/dev/other/wmux.json', config: { version: 1 as const, company: company('other team') } };

let container: HTMLDivElement;
let root: Root;
let saved: Partial<ReturnType<typeof useStore.getState>>;

function mount(state: ProjectConfigState): void {
  act(() => useStore.setState({ projectConfigs: { 'ws-a': state, 'ws-b': OTHER } } as never));
  act(() => root.render(createElement(PresetPicker, { onClose: () => undefined })));
}

const heading = () => Array.from(container.querySelectorAll('div')).find((d) => d.textContent === 'Company') as HTMLElement;
const fileRow = () => container.querySelector('[data-company-file]') as HTMLButtonElement | null;

beforeEach(() => {
  const s = useStore.getState();
  saved = { workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId, projectConfigs: s.projectConfigs };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // A read of the file finds what the store holds, unless a test says otherwise.
  vi.mocked(probeProjectConfig).mockReset().mockImplementation(async (id) => useStore.getState().projectConfigs[id] ?? null);
  act(() => useStore.setState({
    workspaces: [
      { id: 'ws-a', name: 'shop', metadata: { cwd: '/Users/jamie/dev/shop' } },
      { id: 'ws-b', name: 'other', metadata: { cwd: '/Users/jamie/dev/other' } },
    ],
    activeWorkspaceId: 'ws-a',
  } as never));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState(saved));
});

describe('PresetPicker: this folder\'s company', () => {
  it('lists the active workspace\'s company first under Company, and reads the file again', () => {
    mount(shop());
    expect(probeProjectConfig).toHaveBeenCalledWith('ws-a');
    const row = fileRow();
    expect(heading().nextElementSibling).toBe(row);
    expect(row?.textContent).toContain('shop team');
    expect(row?.textContent).toContain('3 seats');
    expect(row?.textContent).toContain('This folder\'s company, from wmux.json in …/dev/shop');
    expect(container.textContent).not.toContain('other team');
  });

  it('says it is reviewed first only while it waits for a review', () => {
    mount(shop());
    expect(fileRow()?.textContent).toContain('Review it before it starts');
    act(() => root.unmount());
    root = createRoot(container);
    mount(shop({ trust: 'trusted', companyReviewed: true }));
    expect(fileRow()?.textContent).not.toContain('Review it before it starts');
  });

  it('opens the review when the company waits for one', async () => {
    mount(shop({ trust: 'trusted', companyReviewed: false }));
    await act(async () => fileRow()?.click());
    expect(container.querySelector('[data-testid="company-file-review-dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="company-preset-dialog"]')).toBeNull();
  });

  it('opens the New company dialog filled from the file once it was reviewed, making nothing', async () => {
    mount(shop({ trust: 'trusted', companyReviewed: true }));
    const before = useStore.getState().workspaces.length;
    await act(async () => fileRow()?.click());
    const dialog = container.querySelector('[data-testid="company-preset-dialog"]') as HTMLElement;
    expect(dialog.querySelector('.ui-dialog-title')?.textContent).toBe('New company: shop team');
    expect(dialog.querySelector('[data-preset-folder]')?.textContent).toBe('/Users/jamie/dev/shop');
    expect(container.querySelector('[data-testid="company-file-review-dialog"]')).toBeNull();
    expect(useStore.getState().workspaces).toHaveLength(before);
  });

  it('branches on the file as it is when picked, not on the menu\'s copy', async () => {
    mount(shop({ trust: 'trusted', companyReviewed: true }));
    const changed = shop({ contentHash: 'h2', trust: 'stale' });
    vi.mocked(probeProjectConfig).mockImplementation(async (id) => {
      useStore.setState({ projectConfigs: { ...useStore.getState().projectConfigs, [id]: changed } } as never);
      return changed;
    });
    await act(async () => fileRow()?.click());
    expect(container.querySelector('[data-testid="company-file-review-dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="company-preset-dialog"]')).toBeNull();
  });

  it('shows a company the file holds but cannot be read as a row that does nothing', () => {
    mount(shop({ config: { version: 1, companyInvalid: true } }));
    expect(fileRow()).toBeNull();
    const row = container.querySelector('[data-company-file-invalid]') as HTMLElement;
    expect(row.tagName).toBe('DIV');
    expect(heading().nextElementSibling).toBe(row);
    expect(row.textContent).toContain('This folder\'s company can\'t be read');
    expect(row.textContent).toContain('Fix the company in wmux.json in …/dev/shop');
  });

  it('has no row when the file holds no company', () => {
    mount(shop({ config: { version: 1, commands: [{ id: 'dev', title: 'Dev', command: 'npm run dev' }] } }));
    expect(fileRow()).toBeNull();
    expect(container.querySelector('[data-company-file-invalid]')).toBeNull();
    expect(heading().nextElementSibling?.getAttribute('data-company-preset')).toBe('researcher-devs');
  });
});
