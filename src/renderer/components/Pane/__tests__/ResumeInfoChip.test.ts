import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    expect(out).toMatchObject({
      command: 'claude --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('skip-permissions ON never rides the cwd-relative fallback (#1916)', () => {
    const out = buildPaneResumeCommand(claude({ permissionMode: 'bypassPermissions' }), ['/Users/me/OTHER'], true);
    expect(out).toMatchObject({ command: 'claude --resume', exact: false });
  });

  it('skip-permissions OFF drops a captured bypassPermissions on an EXACT resume (#1916)', () => {
    const out = buildPaneResumeCommand(claude({ permissionMode: 'bypassPermissions' }), ['/Users/me/proj'], false);
    expect(out).toMatchObject({
      command: 'claude --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('the cwd-relative fallback withholds the permission choices in the role args (#1916)', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/OTHER'], false, {
      agent: 'claude', args: '--permission-mode bypassPermissions --verbose',
    });
    expect(out?.command).toBe('claude --resume --verbose');
    const exactOut = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false, {
      agent: 'claude', args: '--permission-mode acceptEdits',
    });
    expect(exactOut?.command).toBe('claude --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a --permission-mode acceptEdits');
  });

  it('the cwd-relative fallback withholds a role skip flag for every agent (#1916)', () => {
    const claudeOut = buildPaneResumeCommand(claude(), ['/Users/me/OTHER'], true, { agent: 'claude', skipPermissions: true });
    expect(claudeOut?.command).toBe('claude --resume');
    const codexOut = buildPaneResumeCommand(
      claude({ agent: 'codex', sessionId: 'sess-77' }),
      ['/Users/me/OTHER'],
      false,
      { agent: 'codex', skipPermissions: true },
    );
    expect(codexOut?.command).toBe('codex resume');
  });

  it('skip-permissions OFF + default mode → plain exact resume, no permission flag', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false);
    expect(out).toMatchObject({
      command: 'claude --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('skip-permissions OFF restores the captured permission mode on an EXACT resume', () => {
    const out = buildPaneResumeCommand(claude({ permissionMode: 'acceptEdits' }), ['/Users/me/proj'], false);
    expect(out).toMatchObject({
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
    expect(out).toMatchObject({ command: 'claude --resume', exact: false });
  });

  it('missing live cwd → fallback (cannot confirm the cwd-scoped resume)', () => {
    const out = buildPaneResumeCommand(claude(), [undefined], false);
    expect(out).toMatchObject({ command: 'claude --resume', exact: false });
  });

  it('codex takes no permission flag even with skip-permissions ON', () => {
    const out = buildPaneResumeCommand(
      claude({ agent: 'codex', sessionId: 'sess-77' }),
      ['/Users/me/proj'],
      true,
    );
    expect(out).toMatchObject({ command: 'codex resume sess-77', exact: true });
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
    expect(out).toMatchObject({
      command: 'claude --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      exact: true,
    });
  });

  it('no candidate matches → fallback', () => {
    const out = buildPaneResumeCommand(claude(), ['C:\\Users\\me', 'D:\\other'], false);
    expect(out).toMatchObject({ command: 'claude --resume', exact: false });
  });

  it('empty candidate list → fallback', () => {
    const out = buildPaneResumeCommand(claude(), [], false);
    expect(out).toMatchObject({ command: 'claude --resume', exact: false });
  });

  it('non-resumable agent → null (no affordance)', () => {
    expect(buildPaneResumeCommand(claude({ agent: 'gemini' }), ['/Users/me/proj'], true)).toBeNull();
  });

  // D2 — a role→model binding re-asserts the enforced model on resume, so a
  // rebuilt resume command doesn't silently drop the fleet guarantee.
  it('re-asserts the bound model on an exact resume', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false, { agent: 'claude', model: 'haiku' });
    expect(out?.command).toBe('claude --model haiku --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a');
  });

  it('re-asserts the bound model on the cwd-relative fallback too', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/OTHER'], false, { agent: 'claude', model: 'haiku' });
    expect(out?.command).toBe('claude --model haiku --resume');
  });

  it('reports roleRewritten so the caller can log the change once', () => {
    const rewritten = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false, {
      agent: 'claude',
      model: 'haiku',
    });
    expect(rewritten?.roleRewritten).toBe(true);
    const untouched = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false);
    expect(untouched?.roleRewritten).toBe(false);
  });

  it('does not apply a binding that names a different agent', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/proj'], false, {
      agent: 'codex',
      model: 'gpt-5.5',
    });
    expect(out?.command).toBe('claude --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a');
    expect(out?.roleRewritten).toBe(false);
  });

  it('keeps the skip-permissions flag when re-asserting the model', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/proj'], true, {
      agent: 'claude',
      model: 'haiku',
    });
    expect(out?.command).toBe(
      'claude --model haiku --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
    );
  });
  // #1342 — a remote pane's cwds live on another machine, so the host answers
  // the cwd question and its verdict overrides the local comparison entirely.
  it('honours the host cwd verdict over the local comparison (remote panes)', () => {
    const binding: ResumeBinding = { agent: 'claude', sessionId: 'conv-1', cwd: '', ts: 0 };
    // No local cwd matches '' — the host says the recorded cwd still holds.
    expect(buildPaneResumeCommand(binding, [], true, undefined, true)?.command)
      .toBe('claude --dangerously-skip-permissions --resume conv-1');
    // Host says it no longer matches → the cwd-relative fallback, even though
    // a naive local compare of two empty strings would have said "exact". The
    // fallback carries no bypass flag (#1916).
    expect(buildPaneResumeCommand(binding, [''], true, undefined, false)?.command)
      .toBe('claude --resume');
  });
});

// #1677 — a role's skipPermissions vs the chip's explicit toggle. Claude runs
// bypass when --dangerously-skip-permissions and --permission-mode share a line,
// so injecting the role's flag would silently override an explicit OFF.
describe('buildPaneResumeCommand — role skipPermissions vs the toggle', () => {
  const SID = 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a';
  const skipRole = { agent: 'claude', model: 'haiku', effort: 'low', skipPermissions: true };
  const countSkip = (cmd: string | undefined) =>
    (cmd ?? '').split(' ').filter((t) => t === '--dangerously-skip-permissions').length;

  it('toggle OFF keeps the captured mode and withholds the role skip flag', () => {
    const out = buildPaneResumeCommand(claude({ permissionMode: 'plan' }), ['/Users/me/proj'], false, skipRole);
    expect(out?.command).toBe(`claude --model haiku --effort low --permission-mode plan --resume ${SID}`);
    expect(countSkip(out?.command)).toBe(0);
  });

  it('toggle OFF on the cwd-relative fallback still withholds it', () => {
    const out = buildPaneResumeCommand(claude(), ['/Users/me/OTHER'], false, skipRole);
    expect(out?.command).toBe('claude --model haiku --effort low --resume');
  });

  it('toggle ON carries exactly one skip flag', () => {
    const out = buildPaneResumeCommand(claude({ permissionMode: 'plan' }), ['/Users/me/proj'], true, skipRole);
    expect(out?.command).toBe(
      `claude --model haiku --effort low --dangerously-skip-permissions --resume ${SID}`,
    );
    expect(countSkip(out?.command)).toBe(1);
  });

  it('codex has no toggle, so the role skip flag still applies', () => {
    const out = buildPaneResumeCommand(
      claude({ agent: 'codex', sessionId: 'sess-77' }),
      ['/Users/me/proj'],
      false,
      { agent: 'codex', skipPermissions: true },
    );
    expect(out?.command).toBe('codex --dangerously-bypass-approvals-and-sandbox resume sess-77');
  });

  // #1681 — a skip flag in the role's args used to survive an explicit OFF.
  it('toggle OFF also drops the skip flag from the role args, keeping the other args', () => {
    const argsRole = { agent: 'claude', model: 'haiku', args: '--dangerously-skip-permissions --verbose' };
    const exact = buildPaneResumeCommand(claude({ permissionMode: 'plan' }), ['/Users/me/proj'], false, argsRole);
    expect(exact?.command).toBe(`claude --model haiku --permission-mode plan --resume ${SID} --verbose`);
    const fallback = buildPaneResumeCommand(claude(), ['/Users/me/OTHER'], false, argsRole);
    expect(fallback?.command).toBe('claude --model haiku --resume --verbose');
    expect(countSkip(fallback?.command)).toBe(0);
  });

  it('codex (no toggle) keeps a skip flag in the role args', () => {
    const out = buildPaneResumeCommand(
      claude({ agent: 'codex', sessionId: 'sess-77' }),
      ['/Users/me/proj'],
      false,
      { agent: 'codex', args: '--yolo' },
    );
    expect(out?.command).toBe('codex resume sess-77 --yolo');
  });
});

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

// #1946 — a Codex binding that no longer matches the pane's folder opens the
// `codex resume` picker instead of reopening the folder's newest thread.
describe('buildPaneResumeCommand — no exact session opens the picker (#1946)', () => {
  const THREAD = '0199a1b2-0000-7000-8000-9f8e7d6c5b4a';
  const codex = (over: Partial<ResumeBinding> = {}): ResumeBinding =>
    ({ agent: 'codex', sessionId: THREAD, cwd: 'D:/repo', ts: 1, ...over });

  it('bound and in its folder: the exact thread', () => {
    expect(buildPaneResumeCommand(codex(), ['d:\\repo\\'], false))
      .toMatchObject({ command: `codex resume ${THREAD}`, exact: true });
  });

  it('bound to another folder: the picker, never --last', () => {
    const out = buildPaneResumeCommand(codex({ cwd: 'D:/other' }), ['D:/repo'], true);
    expect(out).toMatchObject({ command: 'codex resume', exact: false });
    expect(out?.command).not.toContain('--last');
  });

  it('a role model rides the picker line without adding a positional after `resume`', () => {
    const out = buildPaneResumeCommand(codex({ cwd: 'D:/other' }), ['D:/repo'], false, { agent: 'codex', model: 'gpt-5' });
    expect(out?.command).toBe('codex --model gpt-5 resume');
  });

  it("the chip's action button names the picker when the session is not exact", () => {
    const src = readFileSync(resolve(__dirname, '../ResumeInfoChip.tsx'), 'utf8');
    expect(src).toMatch(/built\.exact\s*\?\s*t\('resume\.label', \{ agent: agentName \}\)\s*:\s*t\('resume\.pickLabel', \{ agent: agentName \}\)/);
    expect(src).toContain("t('resume.pickerNote')");
    expect(src).toContain("title={built.exact ? t('resume.tooltip') : t('resume.pickTooltip')}");
  });
});
