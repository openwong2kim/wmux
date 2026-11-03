import { describe, it, expect } from 'vitest';
import { a2aPartyName, terminalManualName } from '../a2aPartyName';
import type { PaneLeaf, Surface } from '../../../shared/types';

type SurfaceInit = { ptyId: string; title?: string; titleLocked?: boolean; cwd?: string };

const leaf = (id: string, ordinal: number, ...surfaces: SurfaceInit[]): PaneLeaf => ({
  id,
  type: 'leaf',
  ordinal,
  activeSurfaceId: `s-${id}-0`,
  surfaces: surfaces.map((s, i) => ({ id: `s-${id}-${i}`, title: '', cwd: '', ...s }) as PaneLeaf['surfaces'][number]),
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

  it('names the terminal by the name its agent was given, ahead of the pane label', () => {
    const named = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ koles1' }));
    expect(a2aPartyName(named, {}, claude('pty-a'), 'pty-a')).toBe('Simply.koles1');
    expect(a2aPartyName(named, { a: 'TOKENY' }, claude('pty-a'), 'pty-a')).toBe('Simply.koles1');
  });

  it('keeps the pane label when the terminal has no name of its own', () => {
    const unnamed = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ Fix the login flow' }));
    expect(a2aPartyName(unnamed, { a: 'TOKENY' }, claude('pty-a'), 'pty-a')).toBe('Simply.TOKENY');
  });

  it('does not read a plain shell title as a name', () => {
    const shell = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: 'node' }));
    expect(a2aPartyName(shell, {}, undefined, 'pty-a')).toBe('Simply.w2-1');
  });

  it('tells two unnamed terminals of one pane apart, each with its own agent', () => {
    const two = wsOf(leaf('a', 1, { ptyId: 'pty-1' }, { ptyId: 'pty-2' }));
    const agents = { 'pty-1': { slug: 'claude' as const }, 'pty-2': { slug: 'codex' as const } };
    expect(a2aPartyName(two, {}, agents, 'pty-1')).toBe('Simply.w2-1.1(claude)');
    expect(a2aPartyName(two, {}, agents, 'pty-2')).toBe('Simply.w2-1.2(codex)');
    expect(a2aPartyName(two, { a: 'TOKENY' }, agents, 'pty-2')).toBe('Simply.TOKENY.2');
  });

  it('names a named background tab by its own name, not the active one', () => {
    const two = wsOf(leaf('a', 1, { ptyId: 'pty-1', title: '✳ MIS' }, { ptyId: 'pty-2', title: '◑ Tokeny' }));
    expect(a2aPartyName(two, {}, claude('pty-1', 'pty-2'), 'pty-2')).toBe('Simply.Tokeny');
  });

  it('never lets a title pass for another party', () => {
    const dup = wsOf(leaf('a', 1, { ptyId: 'pty-1', title: '✳ Refactoring' }, { ptyId: 'pty-2', title: '✳ Refactoring' }));
    expect(a2aPartyName(dup, {}, claude('pty-1', 'pty-2'), 'pty-1')).toBe('Simply.w2-1.1(claude)');
    const asLabel = wsOf(leaf('a', 1, { ptyId: 'pty-a', title: '✳ release' }), leaf('b', 2, { ptyId: 'pty-b' }));
    expect(a2aPartyName(asLabel, { b: 'release' }, claude('pty-a'), 'pty-a')).toBe('Simply.w2-1(claude)');
  });
});

describe('terminalManualName', () => {
  const t = (title: string, extra: Partial<Surface> = {}, hasAgent = true) =>
    terminalManualName({ title, cwd: 'C:\\work\\acme-shop', ...extra }, hasAgent);

  it('reads a name an agent was renamed to, without its status glyph or folder suffix', () => {
    expect(t('◑ Tokeny')).toBe('Tokeny');
    expect(t('✳ MIS')).toBe('MIS');
    expect(t('MOBBBB | acme-shop')).toBe('MOBBBB');
    expect(t('BE111')).toBe('BE111');
  });

  it('ignores titles that are not a name', () => {
    for (const title of [
      '✳ Clean up the release notes', '✳ Claude Code', 'codex', 'codex.exe', 'PowerShell 7', 'pwsh.exe',
      'acme-shop', 'w1-364', '✳', '', 'MINGW64:/c/work/x', 'user@host:~/p', 'C:\\Users\\x\\npm\\codex.cmd',
    ]) {
      expect(t(title)).toBeUndefined();
    }
  });

  it('reads an agent-set title only on a terminal running an agent', () => {
    expect(t('koles1', {}, false)).toBeUndefined();
  });

  it('keeps a title the user typed into wmux as it is', () => {
    expect(t('build box', { titleLocked: true }, false)).toBe('build box');
  });

  it('drops control and bidi characters so a title cannot forge a line or flip the name', () => {
    expect(t('a\nb', { titleLocked: true })).toBe('a b');
    expect(t('\u202eMIS')).toBe('MIS');
  });
});
