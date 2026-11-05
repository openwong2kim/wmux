import { describe, it, expect } from 'vitest';
import { a2aPartyName, terminalManualName } from '../a2aPartyName';
import type { PaneLeaf, Surface } from '../../../shared/types';

type SurfaceInit = {
  ptyId: string;
  title?: string;
  cwd?: string;
  userName?: string;
  surfaceType?: string;
};

const leaf = (id: string, ordinal: number, ...surfaces: SurfaceInit[]): PaneLeaf => ({
  id,
  type: 'leaf',
  ordinal,
  activeSurfaceId: `s-${id}-0`,
  surfaces: surfaces.map((s, i) => ({
    id: `s-${id}-${i}`,
    title: '',
    cwd: '',
    ...s,
  })) as PaneLeaf['surfaces'],
});

const wsOf = (...children: PaneLeaf[]) => ({
  name: 'Simply',
  wsOrdinal: 2,
  rootPane: { id: 'root', type: 'branch' as const, direction: 'horizontal' as const, children },
  activePaneId: children[0].id,
});

const claude = (...ptys: string[]) => Object.fromEntries(ptys.map((p) => [p, { slug: 'claude' as const }]));

const ws = wsOf(leaf('a', 1, { ptyId: 'pty-a' }), leaf('b', 2, { ptyId: 'pty-b' }));

describe('a2aPartyName', () => {
  it('joins the workspace and the pane the pty lives in with a dot', () => {
    expect(a2aPartyName(ws, { b: 'release' }, undefined, 'pty-b')).toBe('Simply.release');
  });

  it('uses the auto name when the pane was never renamed, with the agent suffix', () => {
    expect(a2aPartyName(ws, {}, claude('pty-a'), 'pty-a')).toBe('Simply.w2-1(claude)');
  });

  it('falls back to the bare workspace name for an unknown or missing pty', () => {
    expect(a2aPartyName(ws, {}, undefined, 'pty-nope')).toBe('Simply');
    expect(a2aPartyName(ws, {}, undefined)).toBe('Simply');
  });

  it('names the terminal by its userName, ahead of the pane label and any title', () => {
    const named = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'koles1', title: '✳ Other' }));
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a')).toBe('Simply.koles1');
    expect(a2aPartyName(named, { a: 'TOKENY' }, claude('pty-a'), 'pty-a')).toBe('Simply.koles1');
  });

  it('reads an agent title as the name only while the setting is on', () => {
    const named = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ koles1' }));
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a', true)).toBe('Simply.koles1');
    // OFF is the must-fix: nothing OSC-derived is used as a name.
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a')).toBe('Simply.w2-1(claude)');
  });

  it('keeps the pane label when the terminal has no name of its own', () => {
    const unnamed = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ Fix the login flow' }));
    expect(a2aPartyName(unnamed, { a: 'TOKENY' }, claude('pty-a'), 'pty-a')).toBe('Simply.TOKENY');
  });

  it('does not read a plain shell title as a name, even on an agent terminal', () => {
    const shell = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: 'bash' }));
    expect(a2aPartyName(shell, {}, claude('pty-a'), 'pty-a', true)).toBe('Simply.w2-1(claude)');
  });

  it('tells two unnamed terminals of one pane apart, each with its own agent', () => {
    const two = wsOf(leaf('a', 1, { ptyId: 'pty-1' }, { ptyId: 'pty-2' }));
    const agents = { 'pty-1': { slug: 'claude' as const }, 'pty-2': { slug: 'codex' as const } };
    expect(a2aPartyName(two, {}, agents, 'pty-1')).toBe('Simply.w2-1.1(claude)');
    expect(a2aPartyName(two, {}, agents, 'pty-2')).toBe('Simply.w2-1.2(codex)');
    expect(a2aPartyName(two, { a: 'TOKENY' }, agents, 'pty-2')).toBe('Simply.TOKENY.2');
  });

  it('counts only terminal tabs for the .N suffix', () => {
    const three = wsOf(leaf('a', 1,
      { ptyId: 'pty-1' },
      { ptyId: '', surfaceType: 'browser' },
      { ptyId: 'pty-2' }));
    const agents = { 'pty-1': { slug: 'claude' as const }, 'pty-2': { slug: 'codex' as const } };
    // The browser tab does not shift the terminal number: pty-2 is still `.2`.
    expect(a2aPartyName(three, {}, agents, 'pty-2')).toBe('Simply.w2-1.2(codex)');
  });

  it('names a named background tab by its own name, not the active one', () => {
    const two = wsOf(leaf('a', 1, { ptyId: 'pty-1', userName: 'MIS' }, { ptyId: 'pty-2', userName: 'Tokeny' }));
    expect(a2aPartyName(two, {}, claude('pty-1', 'pty-2'), 'pty-2')).toBe('Simply.Tokeny');
  });

  it('never lets a name pass for another party, comparing final names', () => {
    const dup = wsOf(leaf('a', 1, { ptyId: 'pty-1', userName: 'Refactoring' }, { ptyId: 'pty-2', userName: 'Refactoring' }));
    expect(a2aPartyName(dup, {}, claude('pty-1', 'pty-2'), 'pty-1')).toBe('Simply.w2-1.1(claude)');
    // A name that spells another pane's label.
    const asLabel = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'release' }), leaf('b', 2, { ptyId: 'pty-b' }));
    expect(a2aPartyName(asLabel, { b: 'release' }, claude('pty-a'), 'pty-a')).toBe('Simply.w2-1(claude)');
    // A name that spells another terminal's `label.N` fallback.
    const asTab = wsOf(
      leaf('a', 1, { ptyId: 'pty-a', userName: 'release.2' }),
      leaf('b', 2, { ptyId: 'pty-1' }, { ptyId: 'pty-2' }));
    expect(a2aPartyName(asTab, { b: 'release' }, {
      'pty-a': { slug: 'claude' as const },
      'pty-1': { slug: 'codex' as const },
      'pty-2': { slug: 'codex' as const },
    }, 'pty-a')).toBe('Simply.w2-1(claude)');
  });

  it('reserves the terminal part when the workspace name is very long', () => {
    const long = wsOf(leaf('a', 1, { ptyId: 'pty-a' }));
    long.name = 'A'.repeat(100);
    expect(a2aPartyName(long, {}, claude('pty-a'), 'pty-a')).toBe('A'.repeat(87) + '.w2-1(claude)');
  });

  it('flattens control, bidi and U+061C characters out of a name', () => {
    const bidi = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'MIS\u202e' }));
    expect(a2aPartyName(bidi, {}, claude('pty-a'), 'pty-a')).toBe('Simply.MIS');
    const ctrl = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'a\nb' }));
    expect(a2aPartyName(ctrl, {}, claude('pty-a'), 'pty-a')).toBe('Simply.a b');
  });
});

describe('terminalManualName', () => {
  const t = (over: Partial<Pick<Surface, 'title' | 'cwd' | 'userName'>>, hasAgent = true, osc = true) =>
    terminalManualName({ title: '', cwd: 'C:\\work\\acme-shop', ...over }, hasAgent, osc);

  it('reads a userName the user set through wmux, as-is', () => {
    expect(t({ userName: 'build box', title: '✳ Tokeny' }, false, false)).toBe('build box');
  });

  it('reads an agent title only when the setting is on and the terminal has an agent', () => {
    expect(t({ title: '◑ Tokeny' })).toBe('Tokeny');
    expect(t({ title: '✳ MIS' })).toBe('MIS');
    expect(t({ title: 'MOBBBB | acme-shop' })).toBe('MOBBBB');
    expect(t({ title: 'BE111' })).toBe('BE111');
    expect(t({ title: 'koles1' }, false)).toBeUndefined();
    expect(t({ title: 'koles1' }, true, false)).toBeUndefined();
  });

  it('reads a multi-word agent title when the setting is on (no one-word rule)', () => {
    expect(t({ title: '✳ Clean up the release notes' })).toBe('Clean up the release notes');
  });

  it('ignores titles that are not a name', () => {
    for (const title of [
      'codex', 'codex.exe', 'PowerShell 7', 'pwsh.exe', 'bash', 'zsh',
      'acme-shop', 'w1-364', '✳', '', 'MINGW64:/c/work/x', 'user@host:~/p', 'C:\\Users\\x\\npm\\codex.cmd',
    ]) {
      expect(t({ title })).toBeUndefined();
    }
  });

  it('drops bidi and U+061C characters so a title cannot flip the name', () => {
    expect(t({ title: '\u202eMIS' })).toBe('MIS');
    expect(t({ title: '\u061cMIS' })).toBe('MIS');
  });
});
