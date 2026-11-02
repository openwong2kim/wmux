// @vitest-environment jsdom
//
// The To hand out add form and the card's lines: the folders it offers, who
// added an item, and Add held until there is a title and a folder, with
// main's refusal shown in the form.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HandOutAddResult, HandOutEntry } from '../../../../shared/handOut';
import type { Workspace } from '../../../../shared/types';
import { HandOutAddForm, HandOutCard, handOutAddedLine, handOutFolderChoices } from '../HandOutList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);
const ws = (id: string, startupCwd?: string, cwd?: string) =>
  ({ id, name: id, ...(startupCwd ? { profile: { startupCwd } } : {}), ...(cwd ? { metadata: { cwd } } : {}) }) as unknown as Workspace;

describe('handOutFolderChoices', () => {
  it('offers each open workspace\'s folder once, the active workspace\'s first', () => {
    const choices = handOutFolderChoices([
      ws('a', '/code/wmux'),
      ws('b', undefined, '/code/wmux-web'),
      ws('c'),
      ws('d', '/code/wmux'),
      ws('e', '/code/wmux-ios'),
    ], 'e');
    expect(choices).toEqual(['/code/wmux-ios', '/code/wmux', '/code/wmux-web']);
  });
});

describe('handOutAddedLine', () => {
  const NOW = 10 * 24 * 60 * 60 * 1000;
  const entry = (addedBy: HandOutEntry['addedBy'], ageMs: number): HandOutEntry =>
    ({ id: 'ho-1', title: 'x', folder: '/code', addedBy, createdAt: NOW - ageMs, state: 'open' });
  const names = (id: string) => (id === 'ws-co' ? 'wmux co.' : '');

  it('names the owner as you, and an agent pane by its name and workspace', () => {
    expect(handOutAddedLine(entry({ kind: 'owner' }, 2 * 86_400_000), NOW, names, t)).toBe('fleet.handOut.addedByYou · 2d');
    expect(handOutAddedLine(entry({ kind: 'pane', workspaceId: 'ws-co', paneId: 'p1', name: 'ceo' }, 3 * 3_600_000), NOW, names, t))
      .toBe('fleet.handOut.addedBy(#ceo) · wmux co. · 3h');
  });

  it('says "now" under a minute and leaves out a workspace that is gone', () => {
    expect(handOutAddedLine(entry({ kind: 'pane', workspaceId: 'ws-gone', paneId: 'p1' }, 5_000), NOW, names, t))
      .toBe('fleet.handOut.addedBy(fleet.handOut.aPane) · fleet.handOut.now');
  });
});

describe('HandOutAddForm', () => {
  let container: HTMLDivElement;
  let root: Root;
  const add = vi.fn<(req: unknown) => Promise<HandOutAddResult>>();
  const onDone = vi.fn();

  beforeEach(() => {
    add.mockReset();
    onDone.mockReset();
    (window as unknown as { electronAPI: unknown }).electronAPI = { handOut: { add } };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root.render(<HandOutAddForm folders={['/code/wmux', '/code/wmux-web']} onDone={onDone} t={t} />); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const field = (name: string) => container.querySelector<HTMLInputElement>(`[data-fleet-hand-out-${name}]`)!;
  const submitButton = () => field('submit') as unknown as HTMLButtonElement;
  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('starts on the first folder and holds Add until there is a title', () => {
    expect(field('folder').value).toBe('/code/wmux');
    expect(submitButton().disabled).toBe(true);
    type(field('title'), '   ');
    expect(submitButton().disabled).toBe(true);
    type(field('title'), 'Write the release notes');
    expect(submitButton().disabled).toBe(false);
    type(field('folder'), '');
    expect(submitButton().disabled).toBe(true);
  });

  it('adds on Enter and closes with the new item', async () => {
    add.mockResolvedValue({ ok: true, item: { id: 'ho-new', title: 'T', folder: '/code/wmux', addedBy: { kind: 'owner' }, createdAt: 1 } });
    type(field('title'), 'T');
    await act(async () => {
      field('title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    });
    expect(add).toHaveBeenCalledWith({ title: 'T', folder: '/code/wmux' });
    expect(onDone).toHaveBeenCalledWith('ho-new');
  });

  it('shows main\'s refusal in the form and stays open', async () => {
    add.mockResolvedValue({ ok: false, code: 'full', message: 'full' });
    type(field('title'), 'T');
    await act(async () => {
      submitButton().click();
      await settle();
    });
    expect(container.querySelector('[data-fleet-hand-out-error]')?.textContent).toBe('fleet.handOut.form.full');
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('HandOutCard', () => {
  it('shows a long folder by its last two segments, keeping the full path as its tooltip and in its name', () => {
    const folder = '/private/tmp/claude-501/-Users-someone-Desktop-coding-wmux/c6e8dfc2/scratchpad/wmux-web';
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const item: HandOutEntry = { id: 'ho-1', title: 'Move the docs site', folder, agent: 'codex', addedBy: { kind: 'owner' }, createdAt: 0, state: 'open' };
    act(() => {
      root.render(<HandOutCard item={item} layout="board" focused={false} now={0} workspaceName={() => ''}
        onFocus={() => undefined} onHandOut={() => undefined} onRemove={() => undefined} t={t} />);
    });
    const line = container.querySelector<HTMLElement>('[data-fleet-hand-out-folder-line]')!;
    expect(line.textContent).toBe('…/scratchpad/wmux-web');
    expect(line.title).toBe(folder);
    expect(container.querySelector('[data-fleet-hand-out]')?.getAttribute('aria-label')).toContain(folder);
    act(() => root.unmount());
    container.remove();
  });
});
