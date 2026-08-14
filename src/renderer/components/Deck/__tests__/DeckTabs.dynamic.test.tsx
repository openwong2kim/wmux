// @vitest-environment jsdom
//
// Dynamic tab-switch test for the Command Deck tab bar (Phase 1 P1a). Mounts
// the real <DeckTabs/> via react-dom/client and drives clicks, asserting the
// onSelect callback fires with the right tab and that aria-selected/data-active
// track the controlled `active` prop. Mirrors the Composer.mentions.dynamic
// harness (the packaged Electron UI can't be automated).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckTabs } from '../DeckTabs';
import type { DeckTab } from '../../../stores/slices/deckSlice';

let container: HTMLDivElement;
let root: Root;

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

function mount(props: {
  active: DeckTab;
  onSelect?: (t: DeckTab) => void;
  channelsUnread?: number;
  showChannels?: boolean;
  afterTabs?: React.ReactNode;
  rightSlot?: React.ReactNode;
  commanderModelLabel?: string;
  commanderModelOptions?: { value: string; label: string }[];
  commanderModelValue?: string;
  onCommanderModelSelect?: (v: string) => void;
}): void {
  act(() => {
    root.render(
      createElement(DeckTabs, {
        active: props.active,
        onSelect: props.onSelect ?? vi.fn(),
        channelsUnread: props.channelsUnread,
        ...(props.showChannels !== undefined ? { showChannels: props.showChannels } : {}),
        ...(props.afterTabs !== undefined ? { afterTabs: props.afterTabs } : {}),
        ...(props.rightSlot !== undefined ? { rightSlot: props.rightSlot } : {}),
        ...(props.commanderModelLabel !== undefined ? { commanderModelLabel: props.commanderModelLabel } : {}),
        ...(props.commanderModelOptions !== undefined ? { commanderModelOptions: props.commanderModelOptions } : {}),
        ...(props.commanderModelValue !== undefined ? { commanderModelValue: props.commanderModelValue } : {}),
        ...(props.onCommanderModelSelect !== undefined ? { onCommanderModelSelect: props.onCommanderModelSelect } : {}),
        t: (k: string) => k,
      }),
    );
  });
}

const tab = (id: DeckTab): HTMLButtonElement => {
  const el = container.querySelector(`[data-deck-tab="${id}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`tab ${id} not rendered`);
  return el;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DeckTabs', () => {
  it('renders both tabs and marks the active one selected', () => {
    mount({ active: 'commander' });
    expect(tab('commander').getAttribute('aria-selected')).toBe('true');
    expect(tab('commander').getAttribute('data-active')).toBe('true');
    expect(tab('channels').getAttribute('aria-selected')).toBe('false');
    expect(tab('channels').getAttribute('data-active')).toBeNull();
  });

  it('fires onSelect with the clicked tab id', () => {
    const onSelect = vi.fn();
    mount({ active: 'commander', onSelect });
    act(() => {
      tab('channels').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('channels');
  });

  it('follows the controlled active prop on re-render', () => {
    mount({ active: 'commander' });
    expect(tab('commander').getAttribute('aria-selected')).toBe('true');
    mount({ active: 'channels' });
    expect(tab('channels').getAttribute('aria-selected')).toBe('true');
    expect(tab('commander').getAttribute('aria-selected')).toBe('false');
  });

  it('shows an unread badge on the Channels tab only when unread > 0', () => {
    mount({ active: 'commander', channelsUnread: 0 });
    expect(container.querySelector('[data-deck-tab-unread]')).toBeNull();
    mount({ active: 'commander', channelsUnread: 3 });
    const badge = container.querySelector('[data-deck-tab-unread]');
    expect(badge?.textContent).toContain('3');
  });

  it('renders Orchestrator·Git·Channels tabs (owner 2026-07-20: 덱 복귀, Review는 Git에 병합)', () => {
    mount({ active: 'commander' });
    const ids = Array.from(container.querySelectorAll('[data-deck-tab]')).map((el) =>
      el.getAttribute('data-deck-tab'),
    );
    expect(ids).toEqual(['commander', 'git', 'channels']);
  });

  it('hides the Channels tab (and its badge) when showChannels is false', () => {
    mount({ active: 'commander', showChannels: false, channelsUnread: 5 });
    expect(container.querySelector('[data-deck-tab="commander"]')).not.toBeNull();
    expect(container.querySelector('[data-deck-tab="channels"]')).toBeNull();
    expect(container.querySelector('[data-deck-tab-unread]')).toBeNull();
  });

  it('keeps non-tab controls OUT of the tablist', () => {
    // A tablist may own tabs and nothing else. The web glyph (afterTabs) and
    // the header controls are buttons, not tabs — inside the list they break
    // AT's "N of M" counting and its arrow-key model.
    mount({
      active: 'commander',
      afterTabs: createElement('button', { 'data-test-web': 'true' }, 'web'),
      rightSlot: createElement('button', { 'data-test-chip': 'true' }, 'chip'),
    });
    const list = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.querySelector('[data-test-web]')).toBeNull();
    expect(list.querySelector('[data-test-chip]')).toBeNull();
    // Every direct child of the list is a tab.
    const kids = Array.from(list.children);
    expect(kids.length).toBe(3);
    for (const kid of kids) {
      const isTab = kid.getAttribute('role') === 'tab' || kid.querySelector('[role="tab"]') !== null;
      expect(isTab).toBe(true);
    }
    // …and the glyphs still render, just as siblings.
    expect(container.querySelector('[data-test-web]')).not.toBeNull();
  });

  it('announces the unread count, which is only a badge visually', () => {
    mount({ active: 'commander', channelsUnread: 3 });
    expect(tab('channels').getAttribute('aria-label')).toBe('deck.tabChannels (3 unread)');
    expect(container.querySelector('[data-deck-tab-unread]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders rightSlot header controls after the tabs', () => {
    mount({
      active: 'commander',
      rightSlot: createElement('button', { 'data-test-chip': 'true' }, 'chip'),
    });
    const controls = container.querySelector('[data-deck-header-controls]');
    expect(controls).not.toBeNull();
    expect(controls?.querySelector('[data-test-chip]')).not.toBeNull();
  });

  it('renders no header-controls container when rightSlot is omitted', () => {
    mount({ active: 'commander' });
    expect(container.querySelector('[data-deck-header-controls]')).toBeNull();
  });

  it('carries the Agent tab name + current model in its label, now that the tab is a glyph', () => {
    mount({
      active: 'commander',
      commanderModelLabel: 'Sonnet 5',
      commanderModelOptions: MODEL_OPTIONS,
      commanderModelValue: 'sonnet',
      onCommanderModelSelect: vi.fn(),
    });
    // Icons replaced the text labels (owner 2026-08-14), so the name and the
    // model live in the tooltip / accessible name — the only place left to
    // read which model the orchestrator is on.
    // deck.tabCommander (identity translator returns the key) + ` (Sonnet 5)`.
    expect(tab('commander').getAttribute('aria-label')).toBe('deck.tabCommander (Sonnet 5)');
    expect(tab('commander').getAttribute('title')).toBe('deck.tabCommander (Sonnet 5)');
    expect(tab('git').getAttribute('aria-label')).toBe('deck.tabGit');
  });

  it('opens the model menu on active-tab re-click and fires the select callback', () => {
    const onSelect = vi.fn();
    const onCommanderModelSelect = vi.fn();
    mount({
      active: 'commander',
      onSelect,
      commanderModelLabel: 'Default',
      commanderModelOptions: MODEL_OPTIONS,
      commanderModelValue: '',
      onCommanderModelSelect,
    });
    // Active Agent tab: no menu yet.
    expect(container.querySelector('[data-commander-model-menu]')).toBeNull();
    // Re-clicking the ACTIVE tab toggles the model menu (not a tab select).
    act(() => {
      tab('commander').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
    const menu = container.querySelector('[data-commander-model-menu]');
    expect(menu).not.toBeNull();
    // Selecting a model fires the callback with the option value and closes the menu.
    const opts = Array.from(container.querySelectorAll('[data-commander-model-option]')) as HTMLButtonElement[];
    const opus = opts.find((o) => o.getAttribute('data-value') === 'opus');
    expect(opus).toBeTruthy();
    act(() => {
      (opus as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCommanderModelSelect).toHaveBeenCalledWith('opus');
    expect(container.querySelector('[data-commander-model-menu]')).toBeNull();
  });

  it('selects the tab (not the model menu) when the Agent tab is inactive', () => {
    const onSelect = vi.fn();
    mount({
      active: 'channels',
      onSelect,
      commanderModelLabel: 'Default',
      commanderModelOptions: MODEL_OPTIONS,
      commanderModelValue: '',
      onCommanderModelSelect: vi.fn(),
    });
    act(() => {
      tab('commander').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('commander');
    expect(container.querySelector('[data-commander-model-menu]')).toBeNull();
  });
});
