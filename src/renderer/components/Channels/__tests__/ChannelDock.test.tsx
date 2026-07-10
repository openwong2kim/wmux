// ─── Regression guard: right-side channel dock wiring (Approach A) ───────────
//
// The dock replaced the old `position: fixed` ChannelView overlay (which COVERED
// the terminals) with a flex sibling that REFLOWS them. The behavioral proof is
// the live CDP dogfood (scripts/channel-dock-dogfood.mjs, 6/6). Store-connected
// chrome can't be seeded under the node-env renderToStaticMarkup harness, so
// this pins the wiring in source (same lockstep pattern as Sidebar.companyMode)
// to stop a silent regression back to the covering overlay or an orphaned panel.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'src/renderer');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

const dock = read('components/Channels/ChannelDock.tsx');
const channelView = read('components/Channels/ChannelView.tsx');
const appLayout = read('components/Layout/AppLayout.tsx');
const sidebar = read('components/Sidebar/Sidebar.tsx');
const uiSlice = read('stores/slices/uiSlice.ts');

describe('channel dock — wiring regression guard', () => {
  it('ChannelDock renders the list + the conversation', () => {
    expect(dock).toMatch(/<ChannelsPanel\s*\/>/);
    expect(dock).toMatch(/<ChannelView\s*\/>/);
    expect(dock).toContain('data-channel-dock');
  });

  it('ChannelDock is a Command Deck: tab bar + Commander tab (default) over the channels tab', () => {
    // Phase 1 P1a — the dock gained a [Commander] [Channels] tab bar; Commander
    // is the default and the classic list/conversation moved under the channels
    // tab (conditional render, code otherwise unchanged).
    expect(dock).toMatch(/<DeckTabs\b/);
    expect(dock).toMatch(/<CommanderView\s*\/>/);
    expect(dock).toContain('activeDeckTab');
    expect(dock).toMatch(/activeDeckTab === 'commander'/);
  });

  it('ChannelView is dock content, NOT a fixed covering overlay', () => {
    // The old overlay used `fixed top-0 right-0 ... pointer-events-none`. The
    // dock content must be a flex column instead.
    expect(channelView).not.toMatch(/fixed\s+top-0\s+right-0/);
    expect(channelView).not.toContain('pointer-events-none');
    expect(channelView).toMatch(/data-channel-view-wrapper/);
  });

  it('AppLayout mounts ChannelDock gated on channelDockVisible (not the old overlay)', () => {
    expect(appLayout).toMatch(/import ChannelDock from '\.\.\/Channels\/ChannelDock'/);
    expect(appLayout).toContain('channelDockVisible && (');
    expect(appLayout).toMatch(/<ChannelDock\s*\/>/);
    // The old always-mounted overlay <ChannelView /> must be gone from AppLayout.
    expect(appLayout).not.toMatch(/^\s*<ChannelView\s*\/>/m);
  });

  it('Sidebar no longer mounts ChannelsPanel (it moved to the dock)', () => {
    expect(sidebar).not.toMatch(/<ChannelsPanel\s*\/>/);
  });

  it('uiSlice owns the persisted channelDockVisible flag + toggle', () => {
    expect(uiSlice).toContain('channelDockVisible');
    expect(uiSlice).toMatch(/toggleChannelDock/);
  });
});
