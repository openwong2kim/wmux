import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ResumeInfoChip, { buildPaneResumeCommand } from '../ResumeInfoChip';
import type { ResumeBinding } from '../../../../shared/agentResume';

// buildPaneResumeCommand — the per-pane resume affordance's command builder.
// Mirrors the reboot-recovery pill's exact-vs-fallback gates (deckRecovery /
// Pane.tsx). This is the exact string typed into the pane on 복구.
const claude = (over: Partial<ResumeBinding> = {}): ResumeBinding => ({
  agent: 'claude',
  sessionId: 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
  cwd: '/Users/me/proj',
  ts: 1,
  ...over,
});

describe('buildPaneResumeCommand', () => {
  // The pane's skip-permissions toggle. Default-on (`true`) is what the chip
  // renders; the explicit `false` cases below prove the opt-out path.
  it('skip-permissions ON (default) → exact resume forces --dangerously-skip-permissions', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/proj'], true);
    expect(out).toEqual({
      command: 'claude --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('skip-permissions ON also rides the cwd-relative fallback (a launch pref, not conversation-scoped)', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/OTHER'], true);
    expect(out).toEqual({ command: 'claude --dangerously-skip-permissions --continue', exact: false });
  });

  it('skip-permissions OFF + default mode → plain exact resume, no permission flag', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false);
    expect(out).toEqual({
      command: 'claude --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('skip-permissions OFF restores the captured permission mode on an EXACT resume', () => {
    const out = buildPaneResumeCommand(claude({ permissionMode: 'acceptEdits' }), ['/Users/me/proj'], false);
    expect(out).toEqual({
      command: 'claude --permission-mode acceptEdits --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('skip-permissions OFF drops the captured mode on a cwd-relative fallback (mode is conversation-scoped)', () => {
    const out = buildPaneResumeCommand(
      claude({ permissionMode: 'bypassPermissions' }),
      ['/Users/me/OTHER'],
      false,
    );
    expect(out).toEqual({ command: 'claude --continue', exact: false });
  });

  it('missing live cwd → fallback (cannot confirm the cwd-scoped resume)', () => {
    const out = buildPaneResumeCommand(claude(), [undefined], false);
    expect(out).toEqual({ command: 'claude --continue', exact: false });
  });

  it('codex takes no permission flag even with skip-permissions ON', () => {
    const out = buildPaneResumeCommand(
      claude({ agent: 'codex', sessionId: 'sess-77' }),
      ['/Users/me/proj'],
      true,
    );
    expect(out).toEqual({ command: 'codex resume sess-77', exact: true });
  });

  it('trailing-slash / Windows drive-letter case differences still count as a match', () => {
    expect(buildPaneResumeCommand(claude({ cwd: '/Users/me/proj/' }), ['/Users/me/proj'], true)?.exact).toBe(true);
    expect(
      buildPaneResumeCommand(claude({ cwd: 'D:\\repo' }), ['d:/repo'], true)?.exact,
    ).toBe(true);
  });

  // Regression (2026-07-21, live-observed): surface.cwd stale at the shell's
  // spawn dir (`cd X; claude` one-liner → no prompt render → no OSC 7) while
  // the hook-reported workspace cwd (metadata.cwd) matched the binding — the
  // gate wrongly downgraded to `--continue`, dropping the permission flag.
  it('stale first candidate + matching second candidate (metadata.cwd) → exact resume', () => {
    const out = buildPaneResumeCommand(
      claude({ cwd: 'D:\\wmux' }),
      ['C:\\Users\\me', 'D:\\wmux'],
      true,
    );
    expect(out).toEqual({
      command: 'claude --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('no candidate matches → fallback', () => {
    const out = buildPaneResumeCommand(claude(), ['C:\\Users\\me', 'D:\\other'], false);
    expect(out).toEqual({ command: 'claude --continue', exact: false });
  });

  it('empty candidate list → fallback', () => {
    const out = buildPaneResumeCommand(claude(), [], false);
    expect(out).toEqual({ command: 'claude --continue', exact: false });
  });

  it('non-resumable agent → null (no affordance)', () => {
    expect(buildPaneResumeCommand(claude({ agent: 'gemini' }), ['/Users/me/proj'], true)).toBeNull();
  });
});

// ─── Render smoke test ───────────────────────────────────────────────────────
// vitest runs node-env (no jsdom); renderToStaticMarkup renders the collapsed
// chip — proves the component mounts without throwing (valid hooks, no undefined
// access during render) and surfaces the trigger. The popover contents live
// behind local `open` state, which static markup can't toggle; their inputs
// (the UUID + the command string) are covered by buildPaneResumeCommand above.
describe('ResumeInfoChip render smoke', () => {
  const binding: ResumeBinding = {
    agent: 'claude',
    sessionId: 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
    cwd: '/Users/me/proj',
    ts: 1,
  };

  it('mounts and renders the collapsed resume trigger without throwing', () => {
    const html = renderToStaticMarkup(
      createElement(ResumeInfoChip, { ptyId: 'pty-1', binding, paneCwds: ['/Users/me/proj'] }),
    );
    expect(html).toContain('Resume'); // trigger label (t('resume.label'))
    // Collapsed by default → the UUID is NOT in the initial markup.
    expect(html).not.toContain(binding.sessionId);
  });

  it('renders nothing for a non-resumable agent', () => {
    const html = renderToStaticMarkup(
      createElement(ResumeInfoChip, {
        ptyId: 'pty-1', binding: { ...binding, agent: 'gemini' }, paneCwds: ['/Users/me/proj'],
      }),
    );
    expect(html).toBe('');
  });
});
