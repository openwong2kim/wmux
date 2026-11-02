import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyLaunchScreen } from '../agentFirstRun';

/** A live capture of Claude Code 2.1.316's screen-reader layout (daemon/approvals/__tests__/fixtures/screen-reader/). */
const screenReader = (name: string): string =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'daemon', 'approvals', '__tests__', 'fixtures', 'screen-reader', `${name}.json`), 'utf8')) as {
    screen: string[];
  }).screen.join('\n');

const UPSELL = [
  'Try the new fullscreen renderer?',
  '',
  '❯ 1. Yes, try it',
  '  2. Not now',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

const ASK_USER_QUESTION = [
  '│ Which migration should I run first?',
  '│ ❯ 1. 0001_init',
  '│   2. 0002_users',
  'Enter to confirm · Esc to cancel',
].join('\n');

describe('classifyLaunchScreen', () => {
  it('names a known interstitial so it can be dismissed', () => {
    expect(classifyLaunchScreen(UPSELL)).toEqual({
      kind: 'first-run',
      prompt: { kind: 'interstitial', headline: 'fullscreen renderer upsell' },
    });
  });

  it('treats codex folder trust as a trust dialog (never answered)', () => {
    const screen = '> You are running Codex in /work\n  Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\nPress enter to continue';
    const out = classifyLaunchScreen(screen);
    expect(out?.kind).toBe('first-run');
    expect(out?.kind === 'first-run' && out.prompt.kind).toBe('trust');
  });

  it('names the agent a folder-trust screen names, and no agent otherwise', () => {
    const gemini = [
      ' │ Do you trust the files in this folder?                     │',
      ' │ Trusting a folder allows Gemini CLI to load its local      │',
      ' │ ● 1. Trust folder (proj)                                   │',
    ].join('\n');
    expect(classifyLaunchScreen(gemini)).toEqual({ kind: 'first-run', prompt: { kind: 'trust', headline: 'gemini folder trust dialog' } });
    const qwen = '   │ Do you trust this folder?\n   │ Trusting a folder allows Qwen Code to execute\n   │ › 1. Trust folder (proj)';
    expect(classifyLaunchScreen(qwen)).toEqual({ kind: 'first-run', prompt: { kind: 'trust', headline: 'qwen folder trust dialog' } });
    // Codex 0.157 does not name itself, but its choices do.
    expect(classifyLaunchScreen('Trust this folder?\n› 1. Trust and continue\n  2. Quit')).toEqual({ kind: 'first-run', prompt: { kind: 'trust', headline: 'codex folder trust dialog' } });
    expect(classifyLaunchScreen('Do you trust this folder?\n› 1. Allow\n  2. Deny')).toEqual({ kind: 'first-run', prompt: { kind: 'trust', headline: 'folder trust dialog' } });
  });

  it('finds the name a narrow box wrapped across its borders', () => {
    const gemini = [
      ' │ Do you trust the │',
      ' │ files in this    │',
      ' │ folder?          │',
      ' │ folder allows    │',
      ' │ Gemini           │',
      ' │ CLI to load its  │',
      ' │ ● 1. Trust fold… │',
    ].join('\n');
    expect(classifyLaunchScreen(gemini)).toEqual({ kind: 'first-run', prompt: { kind: 'trust', headline: 'gemini folder trust dialog' } });
  });

  it('treats the codex-cli 0.157 "Trust this folder?" screen as trust (never answered)', () => {
    const screen = [
      'Folder access',
      '',
      'Trust this folder?',
      '/work/repo',
      '',
      '› 1. Trust and continue',
      '  2. Quit',
      '',
      'Press enter to continue',
    ].join('\n');
    const out = classifyLaunchScreen(screen);
    expect(out?.kind === 'first-run' && out.prompt.kind).toBe('trust');
  });

  it('reports any other menu as blocking — an AskUserQuestion is never pasted into', () => {
    expect(classifyLaunchScreen(ASK_USER_QUESTION)).toEqual({ kind: 'blocking', headline: 'unrecognised menu' });
    expect(classifyLaunchScreen('Update available!\n› 1. Update now\n  2. Skip')).toEqual({ kind: 'blocking', headline: 'unrecognised menu' });
  });

  it('returns null for a plain idle composer', () => {
    expect(classifyLaunchScreen('╭──────╮\n│ > Try "fix lint errors" │\n╰──────╯\n  ? for shortcuts')).toBeNull();
  });

  it.each(['claude-sr-bash-100x30', 'claude-sr-edit-100x30', 'claude-sr-ask-100x30', 'claude-sr-askmulti-100x30'])(
    'blocks on a dialog in Claude Code\'s screen-reader layout (%s), which draws no cursor',
    (name) => {
      expect(classifyLaunchScreen(screenReader(name))).toEqual({ kind: 'blocking', headline: 'unrecognised menu' });
    },
  );

  it('reads a screen-reader screen whose dialog was answered as no menu', () => {
    expect(classifyLaunchScreen(screenReader('claude-sr-ask-answered-100x30'))).toBeNull();
  });
});
