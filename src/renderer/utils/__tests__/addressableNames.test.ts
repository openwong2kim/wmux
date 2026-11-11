// Workspace and tab names are addresses: the rename checks refuse a pane tag,
// a name another one already has (compared normalized), and hidden
// characters, and allow everything else.
import { describe, expect, it } from 'vitest';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { SHADOW_WORKSPACE_PREFIX } from '../../../shared/pcRail/shadowId';
import { normalizeAddressableName, tabNameRefusal, workspaceNameRefusal } from '../addressableNames';

const named = (id: string, name: string) => ({ id, name });

function wsWithTab(id: string, name: string, surfaceId: string, userName?: string): Workspace {
  const leaf: PaneLeaf = {
    id: `pane-${surfaceId}`,
    type: 'leaf',
    activeSurfaceId: surfaceId,
    surfaces: [{ id: surfaceId, ptyId: `pty-${surfaceId}`, title: 't', shell: '', cwd: '', ...(userName ? { userName } : {}) }],
  };
  return { id, name, rootPane: leaf, activePaneId: leaf.id };
}

describe('the pane-tag rule matches the resolver: whole tags only', () => {
  it('refuses a tag, with or without its tab and agent suffixes', () => {
    for (const name of ['w1-2', 'W10-3', 'w1-2.3', 'w1-2(claude)', 'w1-2.2(codex)']) {
      expect(workspaceNameRefusal([], 'ws', name), name).toBe('pane-tag');
      expect(tabNameRefusal([], undefined, 's', name), name).toBe('pane-tag');
    }
  });

  it('allows a name that only starts like one', () => {
    for (const name of ['w12-13 notes', 'w2-3-migration', 'w1-2x', 'notes w1-2']) {
      expect(workspaceNameRefusal([], 'ws', name), name).toBeNull();
      expect(tabNameRefusal([], undefined, 's', name), name).toBeNull();
    }
  });
});

describe('duplicates compare normalized', () => {
  it('folds case, outer spaces and composed forms', () => {
    const others = [named('b', 'Café API')];
    expect(workspaceNameRefusal(others, 'a', 'cafe\u0301 api')).toBe('taken');
    expect(workspaceNameRefusal(others, 'a', '  CAFÉ   API ')).toBe('taken');
    expect(workspaceNameRefusal(others, 'a', 'cafe api')).toBeNull();
  });

  it('sees through hidden characters an existing name already carries', () => {
    expect(workspaceNameRefusal([named('b', 'be\u200Bta')], 'a', 'beta')).toBe('taken');
    expect(normalizeAddressableName('a\u202Eb\uFEFF')).toBe('ab');
  });

  it('a workspace keeps its own name; a PC rail shadow never clashes', () => {
    expect(workspaceNameRefusal([named('a', 'alpha')], 'a', 'Alpha')).toBeNull();
    expect(workspaceNameRefusal([named(`${SHADOW_WORKSPACE_PREFIX}host:ws`, 'beta')], 'a', 'beta')).toBeNull();
  });

  it('a tab name clashes with another tab anywhere, not with itself', () => {
    const workspaces = [wsWithTab('w1', 'one', 's1', 'Builder'), wsWithTab('w2', 'two', 's2')];
    expect(tabNameRefusal(workspaces, undefined, 's2', 'builder')).toBe('taken');
    expect(tabNameRefusal(workspaces, undefined, 's1', 'builder')).toBeNull();
    expect(tabNameRefusal(workspaces, { 'pane-s1': 'docs' }, 's2', 'DOCS')).toBe('taken');
  });
});

describe('hidden characters are refused outright', () => {
  it('zero-width, BOM and bidi controls', () => {
    for (const ch of ['\u200B', '\u200C', '\u200D', '\uFEFF', '\u200E', '\u202E', '\u2066', '\u2069', '\u061C']) {
      const name = `rel${ch}ease`;
      expect(workspaceNameRefusal([], 'ws', name), JSON.stringify(name)).toBe('hidden-chars');
      expect(tabNameRefusal([], undefined, 's', name), JSON.stringify(name)).toBe('hidden-chars');
    }
  });

  it('ordinary non-ASCII names are fine', () => {
    for (const name of ['배포 준비', 'Zażółć', 'café']) {
      expect(workspaceNameRefusal([], 'ws', name), name).toBeNull();
    }
  });
});
