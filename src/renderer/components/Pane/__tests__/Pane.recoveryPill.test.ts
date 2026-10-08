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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { claimAutoResume, markResumePillUsed, planAutoResume, planRecoveryPillType, resolveRecoveryPillPermissions } from '../Pane';
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

  it('cwd-relative fallback (no session) injects --model but ignores forceSkip (#1916)', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude',
      sessionId: undefined,
      permFlag: '--dangerously-skip-permissions',
      forceSkip: true,
      resumeStage: 0,
      roleBinding: reviewer,
    });
    expect(plan?.text).toBe('claude --model haiku --continue');
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

// #1677 — the pill's explicit "skip permissions: OFF" wins over a role's
// skipPermissions; model/effort injection is unchanged.
describe('planRecoveryPillType — role skipPermissions vs the toggle', () => {
  const skipRole: RoleBinding = { agent: 'claude', model: 'haiku', skipPermissions: true };

  it('toggle OFF: the permission-restore base carries no skip flag', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: '--permission-mode plan',
      forceSkip: false, resumeStage: 0, roleBinding: skipRole,
    });
    expect(plan?.text).toBe('claude --model haiku --permission-mode plan');
  });

  it('toggle OFF without a captured mode: one line, still no skip flag', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: '',
      forceSkip: false, resumeStage: 0, roleBinding: skipRole,
    });
    expect(plan?.text).toBe(`claude --model haiku --resume ${SID}`);
  });

  it('toggle ON: exactly one skip flag', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: '--dangerously-skip-permissions',
      forceSkip: true, resumeStage: 0, roleBinding: skipRole,
    });
    expect(plan?.text).toBe(`claude --model haiku --dangerously-skip-permissions --resume ${SID}`);
  });

  it('codex (no toggle) still gets the role skip flag', () => {
    const plan = planRecoveryPillType({
      launcher: 'codex', sessionId: 'sess-77', permFlag: '',
      forceSkip: false, resumeStage: 0, roleBinding: { agent: 'codex', skipPermissions: true },
    });
    expect(plan?.text).toBe('codex --dangerously-bypass-approvals-and-sandbox resume sess-77');
  });

  // #1681 — a skip flag in the role's args used to survive an explicit OFF.
  it('toggle OFF drops the skip flag from the role args on both stages, keeping the other args', () => {
    const argsRole: RoleBinding = { agent: 'claude', model: 'haiku', args: '--dangerously-skip-permissions --verbose' };
    const stage0 = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: '--permission-mode plan',
      forceSkip: false, resumeStage: 0, roleBinding: argsRole,
    });
    expect(stage0?.text).toBe('claude --model haiku --permission-mode plan --verbose');
    const oneLine = planRecoveryPillType({
      launcher: 'claude', sessionId: undefined, permFlag: '',
      forceSkip: false, resumeStage: 0, roleBinding: argsRole,
    });
    expect(oneLine?.text).toBe('claude --model haiku --continue --verbose');
  });

  it('codex (no toggle) keeps a skip flag in the role args', () => {
    const plan = planRecoveryPillType({
      launcher: 'codex', sessionId: 'sess-77', permFlag: '',
      forceSkip: false, resumeStage: 0, roleBinding: { agent: 'codex', args: '--yolo' },
    });
    expect(plan?.text).toBe('codex resume sess-77 --yolo');
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

describe('planAutoResume — Claude panes resume themselves on app start', () => {
  const binding = { agent: 'claude', cwd: 'C:/git/wmux', sessionId: SID };

  it('resumes the exact conversation when the binding matches the pane cwd', () => {
    expect(planAutoResume({ enabled: true, agent: 'claude', binding, paneCwds: ['c:/git/wmux/'], roleBinding: undefined }))
      .toBe(`claude --resume ${SID}`);
  });

  it('falls back to cwd-relative --continue without a matching binding', () => {
    expect(planAutoResume({ enabled: true, agent: 'claude', binding: undefined, paneCwds: ['C:/git/wmux'], roleBinding: undefined }))
      .toBe('claude --continue');
    expect(planAutoResume({ enabled: true, agent: 'claude', binding, paneCwds: ['C:/elsewhere'], roleBinding: undefined }))
      .toBe('claude --continue');
  });

  it('restores the captured permission mode on one line, and never adds bypass', () => {
    const line = planAutoResume({
      enabled: true,
      agent: 'claude',
      binding: { ...binding, permissionMode: 'acceptEdits' },
      paneCwds: ['C:/git/wmux'],
      roleBinding: undefined,
    });
    expect(line).toContain(`--resume ${SID}`);
    expect(line).toContain('acceptEdits');
    expect(line).not.toContain('--dangerously-skip-permissions');
    expect(planAutoResume({ enabled: true, agent: 'claude', binding, paneCwds: [], roleBinding: undefined }))
      .not.toContain('--dangerously-skip-permissions');
  });

  it('never adds --dangerously-skip-permissions for a saved bypassPermissions mode', () => {
    const line = planAutoResume({
      enabled: true,
      agent: 'claude',
      binding: { ...binding, permissionMode: 'bypassPermissions' },
      paneCwds: ['C:/git/wmux'],
      roleBinding: undefined,
    });
    expect(line).toBe(`claude --resume ${SID}`);
  });

  it('leaves other agents and non-agent panes alone', () => {
    expect(planAutoResume({ enabled: true, agent: 'codex', binding: undefined, paneCwds: [], roleBinding: undefined })).toBeNull();
    expect(planAutoResume({ enabled: true, agent: undefined, binding: undefined, paneCwds: [], roleBinding: undefined })).toBeNull();
  });
});

describe('planAutoResume — the opt-in setting (#1826)', () => {
  const binding = { agent: 'claude', cwd: 'C:/git/wmux', sessionId: SID };

  it('types nothing into a recovered Claude pane while the setting is off', () => {
    expect(planAutoResume({ enabled: false, agent: 'claude', binding, paneCwds: ['C:/git/wmux'], roleBinding: undefined }))
      .toBeNull();
    expect(planAutoResume({ enabled: false, agent: 'claude', binding: undefined, paneCwds: ['C:/git/wmux'], roleBinding: undefined }))
      .toBeNull();
  });

  it('the Pane effect reads the setting at decision time and re-checks it before writing', () => {
    // No Pane mount harness exists; pin the wiring so the only pty.write path
    // of this feature cannot bypass the setting.
    const source = readFileSync(resolve(__dirname, '../Pane.tsx'), 'utf8');
    expect(source).toMatch(/planAutoResume\(\{\s*enabled: useStore\.getState\(\)\.claudeResumeOnStart,/);
    // Not a subscription: flipping the switch on must not type into panes
    // that already show the pill.
    expect(source).not.toMatch(/useStore\(\(s\) => s\.claudeResumeOnStart\)/);
    expect(source).toMatch(/\[activeSurfacePtyId, resumePtyReady, resumeHint, resumeBinding, supervision, chatV2OwnsPane\]\);/);
    expect(source).toMatch(/if \(!useStore\.getState\(\)\.claudeResumeOnStart\) return;[^\n]*\n\s*if \(useStore\.getState\(\)\.resumeHintByPtyId/);
  });
});

describe('planAutoResume — session id validation', () => {
  it('types only a well-formed session id, otherwise falls back to --continue', () => {
    const base = { enabled: true, agent: 'claude', paneCwds: ['C:/git/wmux'], roleBinding: undefined };
    expect(planAutoResume({ ...base, binding: { agent: 'claude', cwd: 'C:/git/wmux', sessionId: SID } }))
      .toBe(`claude --resume ${SID}`);
    for (const sessionId of ['not a session id', `${SID} extra`, 'rollout-2026-10-01', SID.toUpperCase(), '']) {
      expect(planAutoResume({ ...base, binding: { agent: 'claude', cwd: 'C:/git/wmux', sessionId, permissionMode: 'acceptEdits' } }))
        .toBe('claude --continue');
    }
  });
});

describe('automatic resume vs the Resume pill', () => {
  it('a pill click on a pty blocks the automatic resume for it', () => {
    markResumePillUsed('pty-pill-clicked');
    expect(claimAutoResume('pty-pill-clicked')).toBe(false);
  });

  it('each pty is resumed automatically at most once', () => {
    expect(claimAutoResume('pty-auto-once')).toBe(true);
    expect(claimAutoResume('pty-auto-once')).toBe(false);
  });

  it('the pill marks the pty before typing, and the timer claims it before writing', () => {
    const source = readFileSync(resolve(__dirname, '../Pane.tsx'), 'utf8');
    expect(source).toMatch(/markResumePillUsed\(ptyId\);[\s\S]{0,600}?if \(plan\.clearHint\) typeAndClear\(plan\.text\);/);
    expect(source).toMatch(/if \(!claimAutoResume\(ptyId\)\) return;[^\n]*\n\s*window\.electronAPI\.pty\.write\(ptyId, `\$\{line\}\\r`\);/);
  });
});

// #1916 — the pill's skip toggle starts at the recorded mode, and the
// cwd-relative fallback never carries --dangerously-skip-permissions.
describe('recovery pill permissions (#1916)', () => {
  const BYPASS = '--dangerously-skip-permissions';
  // What one primary click types, from the pill's own inputs.
  const typed = (args: {
    launcher?: string;
    sessionId: string | undefined;
    recordedMode?: Parameters<typeof resolveRecoveryPillPermissions>[0]['recordedMode'];
    skipOverride?: boolean;
    roleBinding?: RoleBinding;
  }) => {
    const launcher = args.launcher ?? 'claude';
    const perms = resolveRecoveryPillPermissions({
      launcher, sessionId: args.sessionId, recordedMode: args.recordedMode, skipOverride: args.skipOverride,
    });
    const plan = planRecoveryPillType({
      launcher, sessionId: args.sessionId, permFlag: perms.permFlag, forceSkip: perms.forceSkip,
      resumeStage: 0, roleBinding: args.roleBinding,
    });
    return { perms, text: plan?.text };
  };

  it('no binding: the toggle is not offered and the pill types plain --continue', () => {
    const { perms, text } = typed({ sessionId: undefined });
    expect(perms).toEqual({ canSkip: false, skipChecked: false, forceSkip: false, permFlag: '' });
    expect(text).toBe('claude --continue');
  });

  it('no binding: even a checked toggle cannot put bypass on --continue', () => {
    const { perms, text } = typed({ sessionId: undefined, recordedMode: 'bypassPermissions', skipOverride: true });
    expect(perms.forceSkip).toBe(false);
    expect(perms.permFlag).toBe('');
    expect(text).toBe('claude --continue');
  });

  it('no binding: a role skip flag (option or args) is withheld on --continue', () => {
    expect(typed({ sessionId: undefined, roleBinding: { agent: 'claude', skipPermissions: true } }).text)
      .toBe('claude --continue');
    expect(typed({ sessionId: undefined, roleBinding: { agent: 'claude', args: `${BYPASS} --verbose` } }).text)
      .toBe('claude --continue --verbose');
  });

  it('no binding, codex: the role skip flag is withheld on resume --last too', () => {
    expect(typed({ launcher: 'codex', sessionId: undefined, roleBinding: { agent: 'codex', skipPermissions: true } }).text)
      .toBe('codex resume --last');
  });

  it('binding without a permission mode: toggle offered, OFF by default, plain --resume', () => {
    const { perms, text } = typed({ sessionId: SID });
    expect(perms).toMatchObject({ canSkip: true, skipChecked: false, forceSkip: false, permFlag: '' });
    expect(text).toBe(`claude --resume ${SID}`);
  });

  it('binding recorded as default mode: OFF by default, plain --resume', () => {
    const { perms, text } = typed({ sessionId: SID, recordedMode: 'default' });
    expect(perms.skipChecked).toBe(false);
    expect(text).toBe(`claude --resume ${SID}`);
  });

  it('binding recorded as bypassPermissions: ON by default, one line with bypass', () => {
    const { perms, text } = typed({ sessionId: SID, recordedMode: 'bypassPermissions' });
    expect(perms).toMatchObject({ canSkip: true, skipChecked: true, forceSkip: true, permFlag: BYPASS });
    expect(text).toBe(`claude ${BYPASS} --resume ${SID}`);
  });

  it('binding recorded as bypassPermissions, toggle switched OFF: no bypass at all', () => {
    const { perms, text } = typed({ sessionId: SID, recordedMode: 'bypassPermissions', skipOverride: false });
    expect(perms.permFlag).toBe('');
    expect(text).toBe(`claude --resume ${SID}`);
  });

  it('binding recorded as plan: OFF by default, the plan mode is restored (staged base)', () => {
    const { perms, text } = typed({ sessionId: SID, recordedMode: 'plan' });
    expect(perms.skipChecked).toBe(false);
    expect(perms.permFlag).toBe('--permission-mode plan');
    expect(text).toBe('claude --permission-mode plan');
  });

  it('binding recorded as plan, toggle switched ON: bypass on the exact resume', () => {
    expect(typed({ sessionId: SID, recordedMode: 'plan', skipOverride: true }).text)
      .toBe(`claude ${BYPASS} --resume ${SID}`);
  });

  it('codex: no toggle, no permission flag', () => {
    const perms = resolveRecoveryPillPermissions({
      launcher: 'codex', sessionId: 'sess-77', recordedMode: 'bypassPermissions', skipOverride: undefined,
    });
    expect(perms.canSkip).toBe(false);
    expect(perms.permFlag).toBe('');
  });

  it('the pill holds only an explicit override, not a default-on toggle', () => {
    const src = readFileSync(resolve(__dirname, '../Pane.tsx'), 'utf8');
    expect(src).not.toContain('useState(true);\n  // Never carry a stale stage/toggle');
    expect(src).toContain('const [resumeSkipOverride, setResumeSkipOverride] = useState<boolean | undefined>(undefined);');
  });

  it('no binding: a permission choice in the role args is withheld on the fallback too', () => {
    expect(typed({ sessionId: undefined, roleBinding: { agent: 'claude', args: '--permission-mode bypassPermissions --verbose' } }).text)
      .toBe('claude --continue --verbose');
    expect(typed({ sessionId: undefined, roleBinding: { agent: 'claude', args: '--permission-mode acceptEdits' } }).text)
      .toBe('claude --continue');
  });

  it('an exact resume keeps the role args as before', () => {
    expect(typed({ sessionId: SID, roleBinding: { agent: 'claude', args: '--permission-mode acceptEdits' } }).text)
      .toBe(`claude --resume ${SID} --permission-mode acceptEdits`);
  });

  it('stage 1 always appends the bare resume arg, even if the toggle was switched ON meanwhile', () => {
    const plan = planRecoveryPillType({
      launcher: 'claude', sessionId: SID, permFlag: BYPASS, forceSkip: true, resumeStage: 1, roleBinding: undefined,
    });
    expect(plan).toMatchObject({ text: ` --resume ${SID}`, clearHint: true, advanceStage: false });
  });

  it('the toggle is locked after the staged first click', () => {
    const src = readFileSync(resolve(__dirname, '../Pane.tsx'), 'utf8');
    expect(src).toContain('disabled={resumeStage === 1}');
  });
});
