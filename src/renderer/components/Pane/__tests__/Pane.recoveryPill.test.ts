/**
 * D2 — the reboot-recovery pill re-asserts the role's bound model.
 *
 * The pill (Pane.tsx, `resumeHint && resumePtyReady && !supervision` IIFE) takes
 * precedence right after a reboot and constructs its own resume-command strings
 * typed straight to the PTY. Round 1 fixed the persistent chip
 * (buildPaneResumeCommand) but NOT this pill, so a role-bound pane recovering
 * right after a reboot resumed WITHOUT its bound `--model` — contradicting the
 * "a bound model survives a reboot" guarantee.
 *
 * `planRecoveryPillType` is the pure decision the pill's primary click performs.
 * The repo's vitest runs node-env (no jsdom / RTL — see the sibling
 * Pane.enforcedModelBadge.test.ts), so we assert the exact typed string here
 * rather than mounting the component and spying on window.electronAPI.pty.write.
 */
import { describe, it, expect } from 'vitest';
import { planRecoveryPillType } from '../Pane';
import type { RoleBinding } from '../../../../shared/orchestratorRole';

const SID = 'a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a';
// A Reviewer role bound to claude/haiku — the fleet guarantee under test.
const reviewer: RoleBinding = { agent: 'claude', model: 'haiku' };

describe('planRecoveryPillType — role model on the launcher-prefixed variants', () => {
  it('forceSkip whole line (toggle ON) injects --model and clears the hint', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: SID,
      permFlag: '--dangerously-skip-permissions',
      forceSkip: true,
      resumeStage: 0,
      roleBinding: reviewer,
    });
    expect(plan).toMatchObject({
      text: `claude --model haiku --dangerously-skip-permissions --resume ${SID}`,
      clearHint: true,
      advanceStage: false,
      rewritten: true,
    });
  });

  it('forceSkip cwd-relative fallback (no session) still injects --model', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: undefined,
      permFlag: '--dangerously-skip-permissions',
      forceSkip: true,
      resumeStage: 0,
      roleBinding: reviewer,
    });
    expect(plan?.text).toBe('claude --model haiku --dangerously-skip-permissions --continue');
    expect(plan?.rewritten).toBe(true);
  });

  it('default-mode whole line (toggle OFF, no permission flag) injects --model in one click', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: SID,
      permFlag: '',
      forceSkip: false,
      resumeStage: 0,
      roleBinding: reviewer,
    });
    expect(plan).toMatchObject({
      text: `claude --model haiku --resume ${SID}`,
      clearHint: true,
      advanceStage: false,
      rewritten: true,
    });
  });

  it('no-binding cwd-relative fallback (--continue) injects --model', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: undefined,
      permFlag: '',
      forceSkip: false,
      resumeStage: 0,
      roleBinding: reviewer,
    });
    expect(plan?.text).toBe('claude --model haiku --continue');
    expect(plan?.clearHint).toBe(true);
  });
});

describe('planRecoveryPillType — two-stage assembly puts the model on the base', () => {
  it('stage 0 types the permission-restore base WITH the model, then advances', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: SID,
      permFlag: '--permission-mode plan',
      forceSkip: false,
      resumeStage: 0,
      roleBinding: reviewer,
    });
    expect(plan).toMatchObject({
      text: 'claude --model haiku --permission-mode plan',
      clearHint: false,
      advanceStage: true,
      rewritten: true,
    });
  });

  it('stage 1 continuation is a bare resume fragment — NOT launcher-prefixed, NOT rewritten', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: SID,
      permFlag: '--permission-mode plan',
      forceSkip: false,
      resumeStage: 1,
      roleBinding: reviewer,
    });
    // The fragment carries no launcher stem, so applyRoleBinding no-ops on it —
    // the model must NOT be injected here (it already rode the stage-0 base).
    expect(plan?.text).toBe(` --resume ${SID}`);
    expect(plan?.text).not.toContain('--model');
    expect(plan?.rewritten).toBe(false);
    expect(plan?.clearHint).toBe(true);
  });

  it('the two typed fragments assemble into one valid line carrying --model', () => {
    const base = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: '--permission-mode plan',
      forceSkip: false, resumeStage: 0, roleBinding: reviewer,
    });
    const cont = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: '--permission-mode plan',
      forceSkip: false, resumeStage: 1, roleBinding: reviewer,
    });
    // Stage 0 types the base (no clear); stage 1 appends the fragment. What the
    // shell ends up with is base + fragment on a single line.
    const assembled = `${base?.text}${cont?.text}`;
    expect(assembled).toBe(`claude --model haiku --permission-mode plan --resume ${SID}`);
  });
});

describe('planRecoveryPillType — gates that must NOT rewrite', () => {
  it('no role binding → command is untouched (the fix does not touch the unbound path)', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: SID,
      permFlag: '--dangerously-skip-permissions',
      forceSkip: true,
      resumeStage: 0,
      roleBinding: undefined,
    });
    expect(plan?.text).toBe(`claude --dangerously-skip-permissions --resume ${SID}`);
    expect(plan?.text).not.toContain('--model');
    expect(plan?.rewritten).toBe(false);
  });

  it('binding names a DIFFERENT agent than the launcher → no injection (applyRoleBinding gate)', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: SID,
      permFlag: '',
      forceSkip: false,
      resumeStage: 0,
      roleBinding: { agent: 'codex', model: 'gpt-5.5' },
    });
    expect(plan?.text).toBe(`claude --resume ${SID}`);
    expect(plan?.rewritten).toBe(false);
  });

  it('codex binding on a codex launcher injects --model (launcher-agnostic)', () => {
    const plan = planRecoveryPillType({
      launcher: 'codex',
      sessionId: 'sess-77',
      permFlag: '',
      forceSkip: false,
      resumeStage: 0,
      roleBinding: { agent: 'codex', model: 'gpt-5.5' },
    });
    expect(plan?.text).toBe('codex --model gpt-5.5 resume sess-77');
    expect(plan?.rewritten).toBe(true);
  });

  it('non-resumable launcher → null (pill should not have shown)', () => {
    expect(
      planRecoveryPillType({
        launcher: 'gemini',
        sessionId: SID,
        permFlag: '',
        forceSkip: false,
        resumeStage: 0,
        roleBinding: reviewer,
      }),
    ).toBeNull();
  });
});
