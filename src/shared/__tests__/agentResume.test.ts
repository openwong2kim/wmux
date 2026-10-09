import { describe, it, expect } from 'vitest';
import {
  toResumeCommand,
  isResumableLaunchCommand,
  resumeOfferForRecovered,
  permissionFlagFor,
  mergeResumeBinding,
  isProvisionalCapture,
  normalizeResumeCwd,
  isUsableResumeBinding,
  resumeGrammarFor,
  PERMISSION_FLAG,
  type ResumeBinding,
  type PermissionMode,
  isPlausibleResumeSessionId,
  parseCodexRolloutStem,
  defaultResumeSkipPermissions,
  resumePermissionFlag,
  withLaunchSessionId,
} from '../agentResume';

// #1916 — the resume toggle's default and the flag a user-typed resume line carries.
describe('defaultResumeSkipPermissions / resumePermissionFlag (#1916)', () => {
  const BYPASS = '--dangerously-skip-permissions';
  it('defaults ON only for an exact resume of a bypassPermissions session', () => {
    expect(defaultResumeSkipPermissions('bypassPermissions', true)).toBe(true);
    expect(defaultResumeSkipPermissions('bypassPermissions', false)).toBe(false);
    expect(defaultResumeSkipPermissions(undefined, true)).toBe(false);
    for (const mode of ['default', 'plan', 'acceptEdits', 'auto'] as const) {
      expect(defaultResumeSkipPermissions(mode, true)).toBe(false);
    }
  });

  it('a line without an exact session never carries a permission flag', () => {
    for (const recordedMode of [undefined, 'bypassPermissions', 'plan'] as const) {
      for (const skipPermissions of [true, false]) {
        expect(resumePermissionFlag({ agent: 'claude', exact: false, recordedMode, skipPermissions })).toBe('');
      }
    }
  });

  it('an exact resume: ON → bypass; OFF → the recorded mode, never a recorded bypass', () => {
    expect(resumePermissionFlag({ agent: 'claude', exact: true, recordedMode: undefined, skipPermissions: true })).toBe(BYPASS);
    expect(resumePermissionFlag({ agent: 'claude', exact: true, recordedMode: 'bypassPermissions', skipPermissions: false })).toBe('');
    expect(resumePermissionFlag({ agent: 'claude', exact: true, recordedMode: 'plan', skipPermissions: false })).toBe('--permission-mode plan');
  });

  it('an agent without a permission flag (codex) gets none', () => {
    expect(resumePermissionFlag({ agent: 'codex', exact: true, recordedMode: 'bypassPermissions', skipPermissions: true })).toBe('');
  });
});

const CWD = 'D:\\wmux';
const binding = (over: Partial<ResumeBinding> = {}): ResumeBinding => ({
  agent: 'claude',
  sessionId: 'abc-123',
  cwd: CWD,
  ts: 1,
  ...over,
});

describe('toResumeCommand (X6)', () => {
  describe('rewrites known agent launchers', () => {
    const r = (c: string) => toResumeCommand(c, binding(), CWD);
    it('claude → claude --resume <id>', () => {
      expect(r('claude')).toBe('claude --resume abc-123');
    });

    it('preserves trailing args after the launcher', () => {
      expect(r('claude --dangerously-skip-permissions')).toBe(
        'claude --resume abc-123 --dangerously-skip-permissions',
      );
    });

    it('preserves a quoted prompt argument verbatim', () => {
      expect(r('claude "do the thing"')).toBe('claude --resume abc-123 "do the thing"');
    });

    it('matches a Windows .exe / .cmd basename', () => {
      expect(r('claude.cmd')).toBe('claude.cmd --resume abc-123');
      expect(r('claude.exe --foo')).toBe('claude.exe --resume abc-123 --foo');
    });

    it('matches a quoted absolute path launcher', () => {
      expect(r('"C:\\tools\\claude\\claude.exe" --foo')).toBe(
        '"C:\\tools\\claude\\claude.exe" --resume abc-123 --foo',
      );
    });

    it('normalizes a POSIX absolute path launcher', () => {
      expect(r('/usr/local/bin/claude')).toBe('/usr/local/bin/claude --resume abc-123');
    });

    it('tolerates leading whitespace (preserved verbatim)', () => {
      expect(r('  claude')).toBe('  claude --resume abc-123');
    });
  });

  // Recovery resumes only the pane's own id: with no exact binding the launch
  // stays fresh — never `--continue` / `resume --last` (#1946).
  describe('no exact binding → a fresh launch, never a latest-in-folder guess', () => {
    it('no binding leaves claude / codex unchanged', () => {
      expect(toResumeCommand('claude')).toBe('claude');
      expect(toResumeCommand('claude --model haiku', undefined, CWD)).toBe('claude --model haiku');
      expect(toResumeCommand('codex')).toBe('codex');
      expect(toResumeCommand('codex "do it"')).toBe('codex "do it"');
    });
  });

  // A1 — a pinned `--session-id X` must never reach a relaunch as-is: Claude
  // refuses an id already in use, and `--session-id X --resume X` is not a resume.
  describe('--session-id in the launch line', () => {
    const U = '7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90';
    it('exact resume replaces the pinned id with the binding id', () => {
      expect(toResumeCommand(`claude --session-id ${U} --model opus`, binding(), CWD)).toBe(
        'claude --resume abc-123 --model opus',
      );
      expect(toResumeCommand(`claude --model opus --session-id=${U}`, binding(), CWD)).toBe(
        'claude --resume abc-123 --model opus',
      );
    });
    it('no binding strips the pin (a fresh session, not "already in use")', () => {
      expect(toResumeCommand(`claude --session-id ${U}`)).toBe('claude');
      expect(toResumeCommand(`claude --session-id ${U} "hi"`, undefined, CWD)).toBe('claude "hi"');
    });
    it('a quoted --session-id inside a prompt is left alone', () => {
      expect(toResumeCommand('claude "explain --session-id x"', binding(), CWD)).toBe(
        'claude --resume abc-123 "explain --session-id x"',
      );
    });
    it('re-applying is a fixpoint', () => {
      const once = toResumeCommand(`claude --session-id ${U}`, binding(), CWD);
      expect(toResumeCommand(once, binding(), CWD)).toBe(once);
    });
  });

  describe('idempotency — never double-adds / leaves resume+oneshot unchanged', () => {
    it('already --continue → unchanged', () => {
      const c = 'claude --continue';
      expect(toResumeCommand(c)).toBe(c);
    });
    it('re-applying is a fixpoint', () => {
      const once = toResumeCommand('claude --foo', binding(), CWD);
      expect(toResumeCommand(once, binding(), CWD)).toBe(once);
    });
    it('--resume <id> → unchanged (would double-resume)', () => {
      const c = 'claude --resume abc-123';
      expect(toResumeCommand(c)).toBe(c);
    });
    it('-c → unchanged', () => {
      expect(toResumeCommand('claude -c')).toBe('claude -c');
    });
    it('-p / --print one-shot → unchanged (semantics differ)', () => {
      expect(toResumeCommand('claude -p "hi"')).toBe('claude -p "hi"');
      expect(toResumeCommand('claude --print "hi"')).toBe('claude --print "hi"');
    });
    it('short-flag cluster containing c/r/p → unchanged', () => {
      expect(toResumeCommand('claude -cp')).toBe('claude -cp');
    });
    it('a flag inside a QUOTED prompt is NOT treated as a resume flag', () => {
      // The prompt mentions --continue but the command itself is fresh.
      expect(toResumeCommand('claude "explain the --continue flag"', binding(), CWD)).toBe(
        'claude --resume abc-123 "explain the --continue flag"',
      );
    });
  });

  // D2 durability — a launch string that already carries a role-enforced
  // `--model` (from the input.send rewrite, baked into the persisted command)
  // must survive supervised replay verbatim, so the bound model outlives a reboot.
  describe('preserves a trailing --model on resume (D2 durability)', () => {
    it('exact resume keeps --model haiku', () => {
      expect(toResumeCommand('claude --model haiku', binding(), CWD)).toBe(
        'claude --resume abc-123 --model haiku',
      );
    });
  });

  describe('leaves non-agent / ambiguous commands unchanged', () => {
    it('unknown launcher (node, bash) → unchanged', () => {
      expect(toResumeCommand('node server.js')).toBe('node server.js');
      expect(toResumeCommand('bash -lc "loop.sh"')).toBe('bash -lc "loop.sh"');
    });
    it('false-positive prefix (claude-foo) → unchanged', () => {
      expect(toResumeCommand('claude-foo')).toBe('claude-foo');
      expect(toResumeCommand('claudette')).toBe('claudette');
    });
    it('env-assignment prefix → unchanged', () => {
      expect(toResumeCommand('FOO=claude claude')).toBe('FOO=claude claude');
    });
    it('empty / whitespace → unchanged', () => {
      expect(toResumeCommand('')).toBe('');
      expect(toResumeCommand('   ')).toBe('   ');
    });
  });

  describe('X6 ③ — id-aware resume with a binding', () => {
    it('binding + cwd match → --resume <id> (no permFlag by default, D6 fail-safe)', () => {
      expect(toResumeCommand('claude', binding(), CWD)).toBe('claude --resume abc-123');
    });

    it('preserves trailing args after the inserted --resume', () => {
      expect(toResumeCommand('claude --model opus', binding(), CWD)).toBe(
        'claude --resume abc-123 --model opus',
      );
    });

    it('cwd MISMATCH → fresh launch (F7: --resume is cwd-scoped)', () => {
      expect(toResumeCommand('claude', binding({ cwd: 'C:\\other' }), CWD)).toBe('claude');
    });

    it('no paneCwd provided → cannot prove cwd match → fresh launch', () => {
      expect(toResumeCommand('claude', binding())).toBe('claude');
    });

    it('binding for a DIFFERENT agent slug → fresh launch', () => {
      expect(toResumeCommand('claude', binding({ agent: 'codex' }), CWD)).toBe('claude');
    });

    it('binding with an empty sessionId → fresh launch', () => {
      expect(toResumeCommand('claude', binding({ sessionId: '' }), CWD)).toBe('claude');
    });

    it('undefined binding → fresh launch', () => {
      expect(toResumeCommand('claude', undefined, CWD)).toBe('claude');
    });

    it('already --resume <id> → unchanged even with a binding (no double-resume)', () => {
      const c = 'claude --resume zzz-999';
      expect(toResumeCommand(c, binding(), CWD)).toBe(c);
    });

    it('idempotent: re-applying the id-aware build is a fixpoint', () => {
      const once = toResumeCommand('claude --model opus', binding(), CWD);
      expect(toResumeCommand(once, binding(), CWD)).toBe(once);
    });

    it('transcriptPath is carried metadata (D5 probe) — never enters the command', () => {
      expect(
        toResumeCommand('claude', binding({ transcriptPath: 'C:\\u\\.claude\\projects\\x\\abc-123.jsonl' }), CWD),
      ).toBe('claude --resume abc-123');
    });
  });

  describe('X6 ③ — opt-in permission-mode restore (restorePermissionMode)', () => {
    const opt = { restorePermissionMode: true };

    it('bypassPermissions → --resume <id> --dangerously-skip-permissions', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'bypassPermissions' }), CWD, opt)).toBe(
        'claude --resume abc-123 --dangerously-skip-permissions',
      );
    });

    it('acceptEdits → --resume <id> --permission-mode acceptEdits', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'acceptEdits' }), CWD, opt)).toBe(
        'claude --resume abc-123 --permission-mode acceptEdits',
      );
    });

    it('plan → --resume <id> --permission-mode plan', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'plan' }), CWD, opt)).toBe(
        'claude --resume abc-123 --permission-mode plan',
      );
    });

    it('default → --resume <id> (no flag, even when opted in)', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'default' }), CWD, opt)).toBe(
        'claude --resume abc-123',
      );
    });

    it('no permissionMode captured → --resume <id> only', () => {
      expect(toResumeCommand('claude', binding(), CWD, opt)).toBe('claude --resume abc-123');
    });

    it('opt-in has NO effect without an exact binding (cwd mismatch)', () => {
      expect(
        toResumeCommand('claude', binding({ cwd: 'C:\\other', permissionMode: 'bypassPermissions' }), CWD, opt),
      ).toBe('claude');
    });

    it('default OFF: bypass binding does NOT auto-add the flag (D6 fail-safe)', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'bypassPermissions' }), CWD)).toBe(
        'claude --resume abc-123',
      );
    });
  });

  describe('codex — subcommand resume grammar (resume <id>)', () => {
    const cbind = (over: Partial<ResumeBinding> = {}): ResumeBinding => ({
      agent: 'codex',
      sessionId: 'uuid-1',
      cwd: CWD,
      ts: 1,
      ...over,
    });

    it('preserves a trailing prompt after the exact resume', () => {
      expect(toResumeCommand('codex "do it"', cbind(), CWD)).toBe('codex resume uuid-1 "do it"');
    });

    it('binding + cwd match → codex resume <id> (exact)', () => {
      expect(toResumeCommand('codex', cbind(), CWD)).toBe('codex resume uuid-1');
    });

    it('preserves trailing args after the exact resume', () => {
      expect(toResumeCommand('codex --model gpt-5.5', cbind(), CWD)).toBe(
        'codex resume uuid-1 --model gpt-5.5',
      );
    });

    it('cwd MISMATCH → fresh launch (F7: cwd-scoped)', () => {
      expect(toResumeCommand('codex', cbind({ cwd: 'C:\\other' }), CWD)).toBe('codex');
    });

    it('codex.exe / codex.cmd basename resumes', () => {
      expect(toResumeCommand('codex.exe', cbind(), CWD)).toBe('codex.exe resume uuid-1');
      expect(toResumeCommand('codex.cmd --foo', cbind(), CWD)).toBe('codex.cmd resume uuid-1 --foo');
    });

    it('already `codex resume ...` → unchanged (no double-resume), even with a binding', () => {
      expect(toResumeCommand('codex resume uuid-9')).toBe('codex resume uuid-9');
      expect(toResumeCommand('codex resume --last')).toBe('codex resume --last');
      expect(toResumeCommand('codex resume uuid-9', cbind(), CWD)).toBe('codex resume uuid-9');
    });

    it('`codex exec|e ...` one-shot → unchanged', () => {
      expect(toResumeCommand('codex exec "run"')).toBe('codex exec "run"');
      expect(toResumeCommand('codex e "run"')).toBe('codex e "run"');
    });

    it('a codex `-c` config override is NOT a resume flag — still rewritten (CodeRabbit)', () => {
      // Codex `-c key=value` is a config override, unlike claude `-c` (=continue).
      // The claude SKIP_TOKENS / short-flag heuristic must not short-circuit it.
      expect(toResumeCommand('codex -c model="o3"', cbind(), CWD)).toBe('codex resume uuid-1 -c model="o3"');
      expect(toResumeCommand('codex -c model=o3', cbind(), CWD)).toBe('codex resume uuid-1 -c model=o3');
    });

    it('a quoted `resume` in a codex prompt is NOT the subcommand', () => {
      expect(toResumeCommand('codex "resume the task"', cbind(), CWD)).toBe('codex resume uuid-1 "resume the task"');
    });

    it('codex has no permission mode → opt-in restore is a no-op', () => {
      expect(toResumeCommand('codex', cbind(), CWD, { restorePermissionMode: true })).toBe(
        'codex resume uuid-1',
      );
    });

    it('claude binding on a codex launcher → fresh launch (agent mismatch)', () => {
      expect(toResumeCommand('codex', binding({ agent: 'claude' }), CWD)).toBe('codex');
    });

    it('isResumableLaunchCommand: true for bare codex, false once resuming / one-shot', () => {
      expect(isResumableLaunchCommand('codex')).toBe(true);
      expect(isResumableLaunchCommand('codex resume --last')).toBe(false);
      expect(isResumableLaunchCommand('codex exec "x"')).toBe(false);
    });
  });

  describe('mergeResumeBinding — sticky permissionMode / transcriptPath (codex P2)', () => {
    it('keeps a prior permissionMode when the new capture lacks one (tail miss)', () => {
      const prev = binding({ permissionMode: 'bypassPermissions' });
      const next = binding({ permissionMode: undefined, ts: 2 });
      expect(mergeResumeBinding(prev, next).permissionMode).toBe('bypassPermissions');
    });

    it('a real mode change still overrides the prior (not blindly sticky)', () => {
      const prev = binding({ permissionMode: 'bypassPermissions' });
      const next = binding({ permissionMode: 'acceptEdits', ts: 2 });
      expect(mergeResumeBinding(prev, next).permissionMode).toBe('acceptEdits');
    });

    it('keeps a prior transcriptPath when the new capture omits it', () => {
      const prev = binding({ transcriptPath: 'C:\\t\\abc.jsonl' });
      const next = binding({ transcriptPath: undefined, ts: 2 });
      expect(mergeResumeBinding(prev, next).transcriptPath).toBe('C:\\t\\abc.jsonl');
    });

    it('takes the latest sessionId/cwd/ts (stable fields are not sticky)', () => {
      const prev = binding({ sessionId: 'old', cwd: 'C:\\a', ts: 1 });
      const next = binding({ sessionId: 'new', cwd: 'C:\\b', ts: 9 });
      const m = mergeResumeBinding(prev, next);
      expect([m.sessionId, m.cwd, m.ts]).toEqual(['new', 'C:\\b', 9]);
    });

    it('no prior → returns the new binding unchanged', () => {
      const next = binding({ permissionMode: 'plan' });
      expect(mergeResumeBinding(undefined, next)).toEqual(next);
    });

    it('normalizeResumeCwd: drive-case + trailing slash compare equal; POSIX stays case-sensitive (codex P2)', () => {
      expect(normalizeResumeCwd('D:\\repo')).toBe(normalizeResumeCwd('d:/repo/'));
      expect(normalizeResumeCwd('C:\\Users\\rizz\\')).toBe(normalizeResumeCwd('c:/Users/rizz'));
      expect(normalizeResumeCwd('/Foo')).not.toBe(normalizeResumeCwd('/foo'));
    });

    it('toResumeCommand resumes the EXACT id when the binding cwd differs only by format (codex P2)', () => {
      const b = binding({ sessionId: 'sess-xyz', cwd: 'D:\\repo' });
      // paneCwd reported as forward-slash / trailing-slash — same dir, must still --resume.
      expect(toResumeCommand('claude', b, 'd:/repo/')).toContain('--resume sess-xyz');
    });

    it('does NOT carry sticky fields to a DIFFERENT conversation (CodeRabbit)', () => {
      // A fresh SessionStart in a reused pane (new sessionId, no tail data yet)
      // must not inherit the prior conversation's bypassPermissions / transcript.
      const prev = binding({ sessionId: 'old', permissionMode: 'bypassPermissions', transcriptPath: 'C:\\t\\old.jsonl' });
      const next = binding({ sessionId: 'new', permissionMode: undefined, transcriptPath: undefined, ts: 9 });
      const m = mergeResumeBinding(prev, next);
      expect(m.permissionMode).toBeUndefined();
      expect(m.transcriptPath).toBeUndefined();
      expect(m.sessionId).toBe('new');
    });
  });

  describe('permissionFlagFor (pill helper) — the 5-mode mapping', () => {
    it('maps every mode', () => {
      expect(permissionFlagFor('bypassPermissions')).toBe('--dangerously-skip-permissions');
      expect(permissionFlagFor('acceptEdits')).toBe('--permission-mode acceptEdits');
      expect(permissionFlagFor('plan')).toBe('--permission-mode plan');
      expect(permissionFlagFor('auto')).toBe('--permission-mode auto');
      expect(permissionFlagFor('default')).toBe('');
    });
    it('undefined → empty string', () => {
      expect(permissionFlagFor(undefined)).toBe('');
    });
    it('PERMISSION_FLAG table covers exactly the 5 modes', () => {
      expect(Object.keys(PERMISSION_FLAG).sort()).toEqual(
        (['acceptEdits', 'auto', 'bypassPermissions', 'default', 'plan'] as PermissionMode[]).sort(),
      );
    });
  });

  describe('isResumableLaunchCommand', () => {
    it('true for a fresh claude launch', () => {
      expect(isResumableLaunchCommand('claude')).toBe(true);
    });
    it('false for already-resuming or non-agent', () => {
      expect(isResumableLaunchCommand('claude --continue')).toBe(false);
      expect(isResumableLaunchCommand('node x.js')).toBe(false);
    });
  });

  describe('resumeOfferForRecovered (Feature ② EC4 gate)', () => {
    it('offers the slug for an interactive agent shell', () => {
      expect(resumeOfferForRecovered({ lastDetectedAgent: 'claude' })).toBe('claude');
    });
    it('offers codex (subcommand resume grammar)', () => {
      expect(resumeOfferForRecovered({ lastDetectedAgent: 'codex' })).toBe('codex');
    });
    it('does NOT offer an agent wmux cannot resume (no dead pill for gemini/aider)', () => {
      expect(resumeOfferForRecovered({ lastDetectedAgent: 'gemini' })).toBeUndefined();
      expect(resumeOfferForRecovered({ lastDetectedAgent: 'aider' })).toBeUndefined();
    });
    it('no offer when no agent was detected', () => {
      expect(resumeOfferForRecovered({})).toBeUndefined();
      expect(resumeOfferForRecovered({ lastDetectedAgent: '' })).toBeUndefined();
    });
    it('EXCLUDES exec units (they auto-resume via Feature ①)', () => {
      expect(resumeOfferForRecovered({ exec: { command: 'claude' }, lastDetectedAgent: 'claude' })).toBeUndefined();
    });
    it('EXCLUDES supervised units', () => {
      expect(resumeOfferForRecovered({ supervision: { restart: 'always' }, lastDetectedAgent: 'claude' })).toBeUndefined();
    });
  });
});

describe('isUsableResumeBinding', () => {
  it('accepts a complete binding', () => {
    expect(isUsableResumeBinding(binding())).toBe(true);
    expect(isUsableResumeBinding({ agent: 'codex', sessionId: 's', cwd: '/x', ts: 0 })).toBe(true);
  });

  it('rejects a binding missing its folder, session id or agent, or of the wrong shape', () => {
    const noCwd: Partial<ResumeBinding> = binding();
    delete noCwd.cwd;
    expect(isUsableResumeBinding(noCwd)).toBe(false);
    expect(isUsableResumeBinding(binding({ cwd: '' }))).toBe(false);
    expect(isUsableResumeBinding({ ...binding(), cwd: 42 })).toBe(false);
    expect(isUsableResumeBinding(binding({ sessionId: '' }))).toBe(false);
    expect(isUsableResumeBinding({ ...binding(), agent: undefined })).toBe(false);
    for (const value of [undefined, null, 'claude', 7, []]) expect(isUsableResumeBinding(value)).toBe(false);
    // The exact shape a caller of daemon.setResumeBinding can send without a folder.
    expect(isUsableResumeBinding({ agent: 'claude', sessionId: 'abc-123' })).toBe(false);
  });
});

describe('resumeGrammarFor (#1342 — slugs now arrive from another machine)', () => {
  it('answers only for its own launchers, never off the prototype chain', () => {
    expect(resumeGrammarFor('claude')).toBeDefined();
    expect(resumeGrammarFor('codex')).toBeDefined();
    // A bare index would return Object's own members here: truthy, with no
    // `withId` to call — a remote-supplied slug crashing the renderer mid-render.
    expect(resumeGrammarFor('constructor')).toBeUndefined();
    expect(resumeGrammarFor('toString')).toBeUndefined();
    expect(resumeGrammarFor('__proto__')).toBeUndefined();
    expect(resumeGrammarFor('gemini')).toBeUndefined();
  });
});

// #1946 — a person-driven resume without an exact session opens the agent's
// own session picker; only the unattended replay keeps the latest-in-folder form.
describe('resume picker grammar (#1946)', () => {
  it("names each agent's session picker", () => {
    expect(resumeGrammarFor('claude')?.picker).toBe('--resume');
    expect(resumeGrammarFor('codex')?.picker).toBe('resume');
  });

  it('the unattended replay resumes only an exact binding, never a guess or a picker nobody can drive', () => {
    expect(toResumeCommand('claude')).toBe('claude');
    expect(toResumeCommand('codex')).toBe('codex');
    const codexBinding: ResumeBinding = { agent: 'codex', sessionId: '0199a1b2-0000-7000-8000-9f8e7d6c5b4a', cwd: 'D:/repo', ts: 1 };
    expect(toResumeCommand('codex', codexBinding, 'D:/elsewhere')).toBe('codex');
    expect(toResumeCommand('codex', codexBinding, 'd:\\repo')).toBe(`codex resume ${codexBinding.sessionId}`);
  });

  it('no permission flag rides a line without an exact session', () => {
    for (const recordedMode of ['bypassPermissions', 'acceptEdits', 'plan', undefined] as const) {
      expect(resumePermissionFlag({ agent: 'claude', exact: false, recordedMode, skipPermissions: true })).toBe('');
      expect(resumePermissionFlag({ agent: 'claude', exact: false, recordedMode, skipPermissions: false })).toBe('');
    }
  });
});

describe('isProvisionalCapture (#1624 — Codex first-turn title thread)', () => {
  const REAL = '01a0e712-ff3d-77f3-834b-4854dcc549f1';
  const TITLE = '01a0e713-2a61-7593-9d58-782daa920c8d';
  const rollout = `/h/.codex/sessions/2026/09/28/rollout-2026-09-28T17-12-57-${REAL}.jsonl`;
  const real = binding({ agent: 'codex', sessionId: REAL, transcriptPath: rollout });

  it('keeps the bound rollout when a second id with no rollout arrives in the same pane', () => {
    expect(isProvisionalCapture(real, binding({ agent: 'codex', sessionId: TITLE, ts: 2 }))).toBe(true);
  });

  it("rebinds a real session switch once discovery supplies the new id's rollout", () => {
    const next = binding({ agent: 'codex', sessionId: TITLE, transcriptPath: rollout.replace(REAL, TITLE), ts: 2 });
    expect(isProvisionalCapture(real, next)).toBe(false);
  });

  it('does not hold back when nothing transcript-backed is bound yet (title thread finished first)', () => {
    const title = binding({ agent: 'codex', sessionId: TITLE });
    expect(isProvisionalCapture(title, binding({ agent: 'codex', sessionId: REAL, ts: 2 }))).toBe(false);
    expect(isProvisionalCapture(undefined, title)).toBe(false);
  });

  it('never holds back an agent switch or the same session re-reporting', () => {
    expect(isProvisionalCapture(real, binding({ agent: 'claude', sessionId: TITLE }))).toBe(false);
    expect(isProvisionalCapture(real, binding({ agent: 'codex', sessionId: REAL, ts: 2 }))).toBe(false);
  });

  it('keeps the existing Claude SessionStart rule', () => {
    const prev = binding({ transcriptPath: '/p/abc-123.jsonl' });
    expect(isProvisionalCapture(prev, binding({ sessionId: 'new-456' }))).toBe(true);
  });
});

describe('isPlausibleResumeSessionId / parseCodexRolloutStem (#1823)', () => {
  const stem = 'rollout-2026-10-03T12-48-30-01234567-89ab-7cde-8fab-0123456789ab';

  it('takes only a UUID for claude and codex, never a rollout stem', () => {
    expect(isPlausibleResumeSessionId('claude', '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f')).toBe(true);
    expect(isPlausibleResumeSessionId('codex', '01234567-89ab-7cde-8fab-0123456789ab')).toBe(true);
    expect(isPlausibleResumeSessionId('claude', stem)).toBe(false);
    expect(isPlausibleResumeSessionId('codex', stem)).toBe(false);
    expect(isPlausibleResumeSessionId('opencode', 'ses_abc')).toBe(true);
  });

  it('splits a rollout stem into its local date and thread id', () => {
    expect(parseCodexRolloutStem(stem)).toEqual({ year: '2026', month: '10', day: '03', threadId: '01234567-89ab-7cde-8fab-0123456789ab' });
    expect(parseCodexRolloutStem('01234567-89ab-7cde-8fab-0123456789ab')).toBeUndefined();
  });
});

// A1 — a fresh wmux-launched Claude is pinned to a minted id.
describe('withLaunchSessionId (A1)', () => {
  const U = '7b0e3c2a-1f4d-4c8e-9a6b-2d5f8e1c3a90';
  it('pins a fresh claude launch right after the launcher', () => {
    expect(withLaunchSessionId('claude', U)).toBe(`claude --session-id ${U}`);
    expect(withLaunchSessionId('claude --model opus "fix it"', U)).toBe(`claude --session-id ${U} --model opus "fix it"`);
    expect(withLaunchSessionId('claude.cmd --dangerously-skip-permissions', U)).toBe(`claude.cmd --session-id ${U} --dangerously-skip-permissions`);
  });
  it('lowercases the id', () => {
    expect(withLaunchSessionId('claude', U.toUpperCase())).toBe(`claude --session-id ${U}`);
  });
  it('never touches a resume, continue, fork, print or an existing pin', () => {
    for (const c of ['claude --resume', `claude --resume ${U}`, 'claude -r', 'claude --continue', 'claude -c', 'claude -p "hi"',
      'claude --print "hi"', `claude --session-id ${U}`, `claude --session-id=${U}`, `claude --resume ${U} --fork-session`, 'claude --fork-session']) {
      expect(withLaunchSessionId(c, U)).toBe(c);
    }
  });
  it('skips subcommands, shell syntax and other launchers', () => {
    for (const c of ['claude mcp list', 'claude doctor', 'claude && echo done', 'cd /x && claude', 'FOO=1 claude', 'codex', 'claude-foo', '']) {
      expect(withLaunchSessionId(c, U)).toBe(c);
    }
  });
  it('refuses an id that is not a UUID', () => {
    expect(withLaunchSessionId('claude', 'not-a-uuid')).toBe('claude');
  });
  it('the pinned line is still resumable, and toResumeCommand drops the pin', () => {
    const line = withLaunchSessionId('claude --model opus', U);
    expect(isResumableLaunchCommand(line)).toBe(true);
    expect(toResumeCommand(line, { agent: 'claude', sessionId: U, cwd: '/r', ts: 1 }, '/r')).toBe(`claude --resume ${U} --model opus`);
  });
});
