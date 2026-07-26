import { describe, it, expect } from 'vitest';
import { activeSessionLocation, focusedTerminalPtyId } from '../focusedSurface';
import type { Workspace } from '../../../shared/types';

function leaf(id: string, surfaces: any[], activeSurfaceId: string) {
  return { id, type: 'leaf', surfaces, activeSurfaceId } as any;
}

function ws(rootPane: any, activePaneId: string): Workspace {
  return { id: 'w1', name: 'w', rootPane, activePaneId } as any;
}

describe('focusedTerminalPtyId', () => {
  it('returns the active terminal surface ptyId', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-1', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-1');
  });

  it('treats missing surfaceType as terminal', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-9' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-9');
  });

  it('returns null when the active surface is a browser/editor', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'browser' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });

  it('descends a branch tree to the active leaf', () => {
    const child = leaf('p2', [{ id: 's2', ptyId: 'pty-2', surfaceType: 'terminal' }], 's2');
    const root = { id: 'b', type: 'branch', children: [child] } as any;
    expect(focusedTerminalPtyId(ws(root, 'p2'))).toBe('pty-2');
  });

  it('returns null for undefined workspace or empty ptyId', () => {
    expect(focusedTerminalPtyId(undefined)).toBeNull();
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });
});

describe('activeSessionLocation', () => {
  it('uses the authoritative stored WSL location', () => {
    const location = {
      domain: 'wsl' as const,
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const root = leaf('p1', [{
      id: 's1',
      ptyId: 'pty-1',
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      location,
    }], 's1');

    expect(activeSessionLocation(ws(root, 'p1'))).toBe(location);
  });

  it('classifies a legacy surface without a persisted location', () => {
    const root = leaf('p1', [{
      id: 's1',
      ptyId: 'pty-1',
      cwd: 'C:\\dev\\fmux',
      shell: 'pwsh.exe',
    }], 's1');

    expect(activeSessionLocation(ws(root, 'p1'))).toEqual({
      domain: 'host',
      cwd: 'C:\\dev\\fmux',
      shell: 'pwsh.exe',
    });
  });

  it('classifies the workspace fallback with the profile shell', () => {
    const workspace = {
      ...ws(leaf('p1', [], ''), 'p1'),
      metadata: { cwd: '/home/me/proj' },
      profile: { shell: 'wsl.exe' },
    } as Workspace;

    expect(activeSessionLocation(workspace)).toEqual({
      domain: 'wsl',
      cwd: '/home/me/proj',
      shell: 'wsl.exe',
    });
  });

  // WorkspaceProfile.shell is optional. Classifying with '' would make every
  // guest cwd look host-native, and Windows would then resolve `/home/me/proj`
  // as `C:\home\me\proj` (issue #21 AC 6). Declining is the only honest answer.
  it('declines rather than guessing `host` when no shell is known', () => {
    const workspace = {
      ...ws(leaf('p1', [], ''), 'p1'),
      metadata: { cwd: '/home/me/proj' },
      profile: {},
    } as Workspace;

    expect(activeSessionLocation(workspace)).toBeNull();
  });
});
