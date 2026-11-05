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
  name: 'Acme',
  wsOrdinal: 2,
  rootPane: { id: 'root', type: 'branch' as const, direction: 'horizontal' as const, children },
  activePaneId: children[0].id,
});

const claude = (...ptys: string[]) => Object.fromEntries(ptys.map((p) => [p, { slug: 'claude' as const }]));

const ws = wsOf(leaf('a', 1, { ptyId: 'pty-a' }), leaf('b', 2, { ptyId: 'pty-b' }));

describe('a2aPartyName', () => {
  it('joins the workspace and the pane the pty lives in with a dot', () => {
    expect(a2aPartyName(ws, { b: 'release' }, undefined, 'pty-b')).toBe('Acme.release');
  });

  it('uses the auto name when the pane was never renamed, with the agent suffix', () => {
    expect(a2aPartyName(ws, {}, claude('pty-a'), 'pty-a')).toBe('Acme.w2-1(claude)');
  });

  it('falls back to the bare workspace name for an unknown or missing pty', () => {
    expect(a2aPartyName(ws, {}, undefined, 'pty-nope')).toBe('Acme');
    expect(a2aPartyName(ws, {}, undefined)).toBe('Acme');
  });

  it('names the terminal by its userName, ahead of the pane label and any title', () => {
    const named = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'alpha', title: '✳ Other' }));
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a')).toBe('Acme.alpha');
    expect(a2aPartyName(named, { a: 'Beta' }, claude('pty-a'), 'pty-a')).toBe('Acme.alpha');
  });

  it('reads an agent title as the name only while the setting is on', () => {
    const named = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ alpha' }));
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a', true)).toBe('Acme.alpha');
    // OFF is the must-fix: nothing OSC-derived is used as a name.
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a')).toBe('Acme.w2-1(claude)');
  });

  it('keeps the pane label when the terminal has no name of its own', () => {
    const unnamed = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ Fix the login flow' }));
    expect(a2aPartyName(unnamed, { a: 'Beta' }, claude('pty-a'), 'pty-a')).toBe('Acme.Beta');
  });

  it('does not read a plain shell title as a name, even on an agent terminal', () => {
    const shell = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: 'bash' }));
    expect(a2aPartyName(shell, {}, claude('pty-a'), 'pty-a', true)).toBe('Acme.w2-1(claude)');
  });

  it('tells two unnamed terminals of one pane apart, each with its own agent', () => {
    const two = wsOf(leaf('a', 1, { ptyId: 'pty-1' }, { ptyId: 'pty-2' }));
    const agents = { 'pty-1': { slug: 'claude' as const }, 'pty-2': { slug: 'codex' as const } };
    expect(a2aPartyName(two, {}, agents, 'pty-1')).toBe('Acme.w2-1.1(claude)');
    expect(a2aPartyName(two, {}, agents, 'pty-2')).toBe('Acme.w2-1.2(codex)');
    expect(a2aPartyName(two, { a: 'Beta' }, agents, 'pty-2')).toBe('Acme.Beta.2');
  });

  it('counts only terminal tabs for the .N suffix', () => {
    const three = wsOf(leaf('a', 1,
      { ptyId: 'pty-1' },
      { ptyId: '', surfaceType: 'browser' },
      { ptyId: 'pty-2' }));
    const agents = { 'pty-1': { slug: 'claude' as const }, 'pty-2': { slug: 'codex' as const } };
    // The browser tab does not shift the terminal number: pty-2 is still `.2`.
    expect(a2aPartyName(three, {}, agents, 'pty-2')).toBe('Acme.w2-1.2(codex)');
  });

  it('names a named background tab by its own name, not the active one', () => {
    const two = wsOf(leaf('a', 1, { ptyId: 'pty-1', userName: 'alpha' }, { ptyId: 'pty-2', userName: 'beta' }));
    expect(a2aPartyName(two, {}, claude('pty-1', 'pty-2'), 'pty-2')).toBe('Acme.beta');
  });

  it('never lets a name pass for another party, comparing final names', () => {
    const dup = wsOf(leaf('a', 1, { ptyId: 'pty-1', userName: 'release' }, { ptyId: 'pty-2', userName: 'release' }));
    expect(a2aPartyName(dup, {}, claude('pty-1', 'pty-2'), 'pty-1')).toBe('Acme.w2-1.1(claude)');
    // A name that spells another pane's label.
    const asLabel = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'release' }), leaf('b', 2, { ptyId: 'pty-b' }));
    expect(a2aPartyName(asLabel, { b: 'release' }, claude('pty-a'), 'pty-a')).toBe('Acme.w2-1(claude)');
    // A name that spells another terminal's `label.N` fallback.
    const asTab = wsOf(
      leaf('a', 1, { ptyId: 'pty-a', userName: 'release.2' }),
      leaf('b', 2, { ptyId: 'pty-1' }, { ptyId: 'pty-2' }));
    expect(a2aPartyName(asTab, { b: 'release' }, {
      'pty-a': { slug: 'claude' as const },
      'pty-1': { slug: 'codex' as const },
      'pty-2': { slug: 'codex' as const },
    }, 'pty-a')).toBe('Acme.w2-1(claude)');
  });

  it('a name taken by another pane label falls back, and no other terminal can then take that fallback', () => {
    const w = wsOf(
      leaf('a', 1, { ptyId: 'pty-a', userName: 'foo' }),
      leaf('b', 2, { ptyId: 'pty-b' }),
      leaf('c', 3, { ptyId: 'pty-c', userName: 'api' }));
    const agents = { 'pty-a': { slug: 'claude' as const }, 'pty-b': { slug: 'codex' as const }, 'pty-c': { slug: 'claude' as const } };
    // pty-a's `foo` collides with pane b's label `foo`, so pty-a falls back to `api`.
    expect(a2aPartyName(w, { a: 'api', b: 'foo' }, agents, 'pty-a')).toBe('Acme.api');
    // Now `api` is taken by pty-a's fallback, so a terminal named `api` cannot use it.
    expect(a2aPartyName(w, { a: 'api', b: 'foo' }, agents, 'pty-c')).toBe('Acme.w2-3(claude)');
  });

  it('reserves the terminal part when the workspace name is very long', () => {
    const long = wsOf(leaf('a', 1, { ptyId: 'pty-a' }));
    long.name = 'A'.repeat(100);
    expect(a2aPartyName(long, {}, claude('pty-a'), 'pty-a')).toBe('A'.repeat(87) + '.w2-1(claude)');
  });

  it('caps a very long terminal name so the workspace name keeps room', () => {
    const long = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'x'.repeat(70) }));
    expect(a2aPartyName(long, {}, claude('pty-a'), 'pty-a')).toBe('Acme.' + 'x'.repeat(60));
  });

  it('keeps the tab number when a long label is truncated', () => {
    const label = 'x'.repeat(70);
    const w = wsOf(leaf('a', 1, { ptyId: 'pty-1' }, { ptyId: 'pty-2' }));
    const agents = { 'pty-1': { slug: 'claude' as const }, 'pty-2': { slug: 'codex' as const } };
    expect(a2aPartyName(w, { a: label }, agents, 'pty-1')).toBe('Acme.' + 'x'.repeat(58) + '.1');
    expect(a2aPartyName(w, { a: label }, agents, 'pty-2')).toBe('Acme.' + 'x'.repeat(58) + '.2');
  });

  it('flattens control, bidi and format characters out of a name', () => {
    const bidi = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'build\u202e' }));
    expect(a2aPartyName(bidi, {}, claude('pty-a'), 'pty-a')).toBe('Acme.build');
    const ctrl = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: 'a\nb' }));
    expect(a2aPartyName(ctrl, {}, claude('pty-a'), 'pty-a')).toBe('Acme.a b');
    // A zero-width space does not make two names distinct.
    const fmt = wsOf(leaf('a', 1, { ptyId: 'pty-1', userName: 'release\u200b' }, { ptyId: 'pty-2', userName: 'release' }));
    expect(a2aPartyName(fmt, {}, claude('pty-1', 'pty-2'), 'pty-1')).toBe('Acme.w2-1.1(claude)');
  });

  it('falls back to the coordinate when a userName flattens to nothing', () => {
    const s = wsOf(leaf('a', 1, { ptyId: 'pty-a', userName: '\u200b' }));
    expect(a2aPartyName(s, {}, claude('pty-a'), 'pty-a')).toBe('Acme.w2-1(claude)');
  });
});

describe('terminalManualName', () => {
  const t = (over: Partial<Pick<Surface, 'title' | 'cwd' | 'userName'>>, hasAgent = true, osc = true) =>
    terminalManualName({ title: '', cwd: 'C:\\work\\acme-shop', ...over }, hasAgent, osc);

  it('reads a userName the user set through wmux, as-is', () => {
    expect(t({ userName: 'build box', title: '✳ beta' }, false, false)).toBe('build box');
  });

  it('reads an agent title only when the setting is on and the terminal has an agent', () => {
    expect(t({ title: '◑ beta' })).toBe('beta');
    expect(t({ title: '✳ alpha' })).toBe('alpha');
    expect(t({ title: 'build | acme-shop' })).toBe('build');
    expect(t({ title: 'build' })).toBe('build');
    expect(t({ title: 'alpha' }, false)).toBeUndefined();
    expect(t({ title: 'alpha' }, true, false)).toBeUndefined();
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

  it('drops bidi and format characters so a title cannot flip or forge the name', () => {
    expect(t({ title: 'a\u202eb' })).toBe('ab');
    expect(t({ title: 'rel\u061cease' })).toBe('release');
    expect(t({ title: 're\u200blease' })).toBe('release');
  });

  it('a userName that flattens to nothing is not a name', () => {
    expect(t({ userName: '\u200b' })).toBeUndefined();
  });
});
