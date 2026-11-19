import { describe, expect, it } from 'vitest';
import { phonePaneProfiles, type PhonePaneProfileSources } from '../phonePaneProfiles';
import type { ChromePaneBindings } from '../../../shared/chromePaneBinding';

const WS = 'ws-blog';

function sources(over: Partial<PhonePaneProfileSources> & { panes?: ChromePaneBindings; layout?: Record<string, string> | null } = {}): PhonePaneProfileSources {
  const panes = over.panes ?? { 'pane-1': { workspaceId: WS, profile: 'naver-blog' } };
  const layout = over.layout === undefined ? { 'pane-1': WS } : over.layout;
  return {
    paneBindings: () => panes,
    workspaceBindings: () => ({}),
    paneWorkspaces: () => (layout === null ? null : new Map(Object.entries(layout))),
    sessionRestored: () => true,
    isProtected: () => false,
    ...over,
  };
}

describe('phonePaneProfiles: a pane profile the phone may show', () => {
  it('a profile bound to one pane of this workspace, unprotected, with the layout agreeing', () => {
    expect(phonePaneProfiles(WS, sources())).toEqual({ profiles: ['naver-blog'], unknown: false });
  });

  it('no pane of this workspace is bound: nothing, and nothing unknown', () => {
    expect(phonePaneProfiles('ws-other', sources())).toEqual({ profiles: [], unknown: false });
  });

  it('a pane bound in another workspace is never this one\'s', () => {
    const src = sources({ panes: { 'pane-9': { workspaceId: 'ws-2', profile: 'shop' } }, layout: { 'pane-9': 'ws-2' } });
    expect(phonePaneProfiles(WS, src)).toEqual({ profiles: [], unknown: false });
  });

  it('a policy on the profile (protected, refused or unconfirmed) excludes it, and so does a throwing check', () => {
    expect(phonePaneProfiles(WS, sources({ isProtected: () => true })).profiles).toEqual([]);
    expect(phonePaneProfiles(WS, sources({ isProtected: () => { throw new Error('unreadable'); } })).profiles).toEqual([]);
  });

  it('a profile a second pane or any workspace is bound to is not one pane\'s alone (any letter case)', () => {
    const twoPanes = sources({
      panes: { 'pane-1': { workspaceId: WS, profile: 'naver-blog' }, 'pane-2': { workspaceId: 'ws-2', profile: 'Naver-Blog' } },
      layout: { 'pane-1': WS, 'pane-2': 'ws-2' },
    });
    expect(phonePaneProfiles(WS, twoPanes).profiles).toEqual([]);
    expect(phonePaneProfiles(WS, sources({ workspaceBindings: () => ({ 'ws-3': 'NAVER-BLOG' }) })).profiles).toEqual([]);
  });

  it('never default or live, even if a hand-edited file binds them to a pane', () => {
    expect(phonePaneProfiles(WS, sources({ panes: { 'pane-1': { workspaceId: WS, profile: 'default' } } })).profiles).toEqual([]);
    expect(phonePaneProfiles(WS, sources({ panes: { 'pane-1': { workspaceId: WS, profile: 'Live' } } })).profiles).toEqual([]);
  });

  it('a pane the layout puts in another workspace (moved, not re-homed yet) is not this one\'s', () => {
    expect(phonePaneProfiles(WS, sources({ layout: { 'pane-1': 'ws-2' } }))).toEqual({ profiles: [], unknown: false });
  });

  it('a pane whose workspace the layout does not tell is unknown: no PTY, no layout, or not the restored session', () => {
    expect(phonePaneProfiles(WS, sources({ layout: {} }))).toEqual({ profiles: [], unknown: true });
    expect(phonePaneProfiles(WS, sources({ layout: null }))).toEqual({ profiles: [], unknown: true });
    expect(phonePaneProfiles(WS, sources({ sessionRestored: () => false }))).toEqual({ profiles: [], unknown: true });
  });
});
