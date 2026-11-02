import { describe, expect, it } from 'vitest';
import { companyFolder } from '../companyFolder';
import type { PaneLeaf, Surface, Workspace } from '../../../../shared/types';

const surface = (id: string, cwd: string, surfaceType: Surface['surfaceType'] = 'terminal'): Surface =>
  ({ id, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd, surfaceType });
const ceo = (surfaces: Surface[], activeSurfaceId: string): PaneLeaf =>
  ({ id: 'p-ceo', type: 'leaf', surfaces, activeSurfaceId }) as PaneLeaf;
const ws = (startupCwd?: string): Workspace =>
  ({ id: 'ws-co', name: 'co', ...(startupCwd !== undefined ? { profile: { startupCwd } } : {}) }) as Workspace;

describe('companyFolder', () => {
  it('takes the folder the company was made in when it is an absolute path', () => {
    expect(companyFolder(ws('/code/wmux/'), ceo([surface('a', '/elsewhere')], 'a'))).toBe('/code/wmux');
    expect(companyFolder(ws('C:\\code\\wmux'), undefined)).toBe('C:\\code\\wmux');
  });

  it('passes over a relative or ~ folder for where the CEO works', () => {
    const leaf = ceo([surface('a', '/code/wmux')], 'a');
    expect(companyFolder(ws('code/wmux'), leaf)).toBe('/code/wmux');
    expect(companyFolder(ws('~/code/wmux'), leaf)).toBe('/code/wmux');
    expect(companyFolder(ws('.'), leaf)).toBe('/code/wmux');
    expect(companyFolder(ws('~'), undefined)).toBeUndefined();
  });

  it('reads the CEO pane\'s active terminal first, then its other terminals', () => {
    const tabs = [surface('first', '/code/old'), surface('board', '', 'board'), surface('front', '/code/wmux')];
    expect(companyFolder(ws(), ceo(tabs, 'front'))).toBe('/code/wmux');
    // With the board in front, the terminals in order.
    expect(companyFolder(ws(), ceo(tabs, 'board'))).toBe('/code/old');
    // An active terminal with no absolute folder gives way to the next.
    expect(companyFolder(ws(), ceo([surface('front', 'relative'), surface('next', '/code/next')], 'front'))).toBe('/code/next');
    expect(companyFolder(ws(), undefined)).toBeUndefined();
  });
});
