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
  it('ChannelDock is Moa only: the tab bar shows no Channels tab and the channels view is unreachable', () => {
    // Owner decision 2026-10-04: the right panel is Moa only. Channel data, the
    // MCP channel tools and the phone's /api/channels stay; the desktop tab goes.
    expect(dock).toContain('data-channel-dock');
    expect(dock).toMatch(/<DeckTabs\b/);
    expect(dock).toMatch(/showChannels=\{false\}/);
    expect(dock).toMatch(/active="commander"/);
    // The conversation is pinned by prop: Moa's HQ when Moa runs, else the
    // active workspace (resolveMoaPanelMode), never read inside the view.
    expect(dock).toMatch(/<CommanderView chatWorkspaceId=\{mode\.chatWorkspaceId\} viewedWorkspaceId=\{activeWorkspaceId\}/);
    // No path from the dock to the channel list or a conversation.
    expect(dock).not.toMatch(/<ChannelsPanel\b/);
    expect(dock).not.toMatch(/<ChannelView\b/);
    expect(dock).not.toContain('activeDeckTab');
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
    // Collapsed means absent again (owner decision 2026-08-18): the 36px glyph
    // rail that used to stand in for the dock is gone, and the way back is the
    // titlebar's DeckToggle. Nothing may render on this edge while collapsed —
    // that is the whole point, the terminals take the width.
    expect(appLayout).toContain("channelDockVisible && dockMode === 'inline' && (");
    // Too narrow for the panes' floor: the dock leaves the row and floats over
    // the panes on the far edge (dockLayout.ts), so the sheet never overflows.
    expect(appLayout).toContain("channelDockVisible && dockMode === 'overlay' && (");
    expect(appLayout).toMatch(/data-dock-overlay[\s\S]{0,200}absolute inset-y-0/);
    expect(appLayout).not.toMatch(/<DeckMiniRail\s*\/>/);
    expect(appLayout).toMatch(/<ChannelDock\s*\/>/);
    // The old always-mounted overlay <ChannelView /> must be gone from AppLayout.
    expect(appLayout).not.toMatch(/^\s*<ChannelView\s*\/>/m);
  });

  it('Sidebar no longer mounts ChannelsPanel (it moved to the dock)', () => {
    expect(sidebar).not.toMatch(/<ChannelsPanel\s*\/>/);
  });

  it('uiSlice owns the persisted channelDockVisible flag + setter', () => {
    expect(uiSlice).toContain('channelDockVisible');
    // `toggleChannelDock` went with the sidebar rows that were its only
    // caller — the deck strip and the collapsed rail both set the flag to a
    // known value rather than flipping it (2026-08-14).
    expect(uiSlice).toMatch(/setChannelDockVisible/);
    expect(uiSlice).not.toMatch(/toggleChannelDock/);
  });
});
