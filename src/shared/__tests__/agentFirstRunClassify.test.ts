import { describe, expect, it } from 'vitest';
import { classifyLaunchScreen } from '../agentFirstRun';

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
});
