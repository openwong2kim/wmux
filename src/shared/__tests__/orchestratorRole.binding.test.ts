import { describe, expect, it } from 'vitest';
import {
  applyRoleAgent,
  applyRoleBinding,
  bindingEnforcesFreshContext,
  bindingEnforcesModel,
  bindingEnforcesSkipPermissions,
  bindingSkipPermissionsFlag,
  launcherSupportsModelFlag,
  KNOWN_AGENT_STEMS,
  normalizeRoleBinding,
  normalizeRoleBindings,
  ROLE_BINDING_ARGS_MAX,
  type RoleBinding,
} from '../orchestratorRole';

describe('applyRoleBinding — model enforcement transform (D2)', () => {
  it('injects --model right after a bare claude launcher', () => {
    const r = applyRoleBinding('claude', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude --model haiku');
    expect(r.changed).toBe(true);
    expect(r.modelInjected).toBe(true);
  });

  it('injects --model for codex with a full model id', () => {
    const r = applyRoleBinding('codex', { agent: 'codex', model: 'gpt-5.5' });
    expect(r.command).toBe('codex --model gpt-5.5');
    expect(r.changed).toBe(true);
  });

  it('leaves an explicit --model untouched (manual override wins for this launch)', () => {
    const r = applyRoleBinding('claude --model opus', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude --model opus');
    expect(r.changed).toBe(false);
    expect(r.modelInjected).toBe(false);
  });

  it('treats --model=x form as an explicit flag (no second injection)', () => {
    const r = applyRoleBinding('claude --model=opus', { agent: 'claude', model: 'haiku' });
    expect(r.changed).toBe(false);
  });

  it('does NOT treat a --model inside a quoted prompt as explicit — injects once', () => {
    const r = applyRoleBinding('claude "explain the --model flag"', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude --model haiku "explain the --model flag"');
    expect(r.changed).toBe(true);
  });

  // P2-6 — a quoted token whose WHOLE value is the flag really does pass
  // `--model`, so a second one must not be injected.
  it('treats a standalone quoted "--model" token as an explicit flag', () => {
    const r = applyRoleBinding('claude "--model" opus', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude "--model" opus');
    expect(r.changed).toBe(false);
  });

  // P3 — the `=` form used to be checked only on UNQUOTED tokens, so this
  // produced `claude --model haiku "--model=opus"`: two model flags on a line
  // the operator had explicitly pinned.
  it('treats a quoted "--model=x" as an explicit flag (the shell passes it whole)', () => {
    const r = applyRoleBinding('claude "--model=opus"', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude "--model=opus"');
    expect(r.changed).toBe(false);
    expect(r.modelInjected).toBe(false);
  });

  it("treats the -m short form as explicit, quoted or not, bare or with '='", () => {
    for (const line of ['claude -m opus', 'claude -m=opus', 'claude "-m=opus"', "claude '-m' opus"]) {
      expect(applyRoleBinding(line, { agent: 'claude', model: 'haiku' }).changed).toBe(false);
    }
  });

  // The prose exclusion must survive the quoting relaxation: whitespace, not the
  // quote flag, is what disqualifies a token now.
  it('still injects when a quoted PROSE span merely opens with --model=', () => {
    const r = applyRoleBinding('claude "--model=opus is what I meant"', {
      agent: 'claude',
      model: 'haiku',
    });
    expect(r.command).toBe('claude --model haiku "--model=opus is what I meant"');
    expect(r.modelInjected).toBe(true);
  });

  it('does not mistake a longer flag that merely starts with --model', () => {
    const r = applyRoleBinding('claude --models=all', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude --model haiku --models=all');
    expect(r.modelInjected).toBe(true);
  });

  it('is a no-op + note for an agent with no known model-flag grammar', () => {
    const r = applyRoleBinding('gemini', { agent: 'gemini', model: 'flash' });
    expect(r.command).toBe('gemini');
    expect(r.changed).toBe(false);
    expect(r.note).toMatch(/no known --model flag/);
  });

  it('still appends args for an agent with no model-flag grammar', () => {
    const r = applyRoleBinding('opencode', { agent: 'opencode', model: 'x', args: '--verbose' });
    expect(r.command).toBe('opencode --verbose');
    expect(r.modelInjected).toBe(false);
    expect(r.note).toMatch(/no known --model flag/);
  });

  it('is unchanged for an undefined binding or a binding with no model/args', () => {
    expect(applyRoleBinding('claude', undefined).changed).toBe(false);
    expect(applyRoleBinding('claude', {}).changed).toBe(false);
    expect(applyRoleBinding('claude', { agent: 'claude' }).changed).toBe(false);
  });

  it('preserves the original trailing args when injecting the model', () => {
    const r = applyRoleBinding('claude --foo', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('claude --model haiku --foo');
  });

  it('does not apply a binding whose agent differs from the actual launcher', () => {
    // Reviewer bound to codex/o3; operator typed `claude` → o3 must NOT leak in.
    const r = applyRoleBinding('claude', { agent: 'codex', model: 'o3' });
    expect(r.changed).toBe(false);
    expect(r.command).toBe('claude');
    // ...but a different KNOWN agent is a policy deviation, so it is reported.
    expect(r.note).toMatch(/bound to "codex"/);
  });

  it('stays silent when a non-agent command runs in a bound pane', () => {
    const r = applyRoleBinding('ls -la', { agent: 'codex', model: 'o3' });
    expect(r.changed).toBe(false);
    expect(r.note).toBeUndefined();
  });

  it('applies when the binding agent matches the launcher stem', () => {
    const r = applyRoleBinding('codex', { agent: 'codex', model: 'o3' });
    expect(r.command).toBe('codex --model o3');
  });

  it('resolves a launcher stem from a path with a windows extension', () => {
    const r = applyRoleBinding('C:\\tools\\claude.cmd', { agent: 'claude', model: 'haiku' });
    expect(r.command).toBe('C:\\tools\\claude.cmd --model haiku');
  });

  it('appends normalized binding.args at the end', () => {
    const r = applyRoleBinding('claude', {
      agent: 'claude',
      model: 'haiku',
      args: '--dangerously-skip-permissions',
    });
    expect(r.command).toBe('claude --model haiku --dangerously-skip-permissions');
  });

  it('is idempotent — re-applying is a fixpoint', () => {
    const binding: RoleBinding = { agent: 'claude', model: 'haiku', args: '--foo' };
    const once = applyRoleBinding('claude', binding).command;
    const twice = applyRoleBinding(once, binding).command;
    expect(twice).toBe(once);
  });
});

// P1-1 — `args` used to be appended with no launcher gate at all, so EVERY
// submitted line in a bound pane was mutated.
describe('applyRoleBinding — non-agent commands are never touched (P1-1)', () => {
  it('leaves a shell command alone even when args are bound', () => {
    const r = applyRoleBinding('git commit -m "wip"', { args: '--dangerously-skip-permissions' });
    expect(r.command).toBe('git commit -m "wip"');
    expect(r.changed).toBe(false);
  });

  it('leaves an unrelated binary alone', () => {
    expect(applyRoleBinding('npm test', { agent: 'claude', args: '--foo' }).changed).toBe(false);
    expect(applyRoleBinding('ls', { args: '--foo' }).changed).toBe(false);
  });

  it('applies an args-only binding to a known agent launch', () => {
    const r = applyRoleBinding('claude', { args: '--verbose' });
    expect(r.command).toBe('claude --verbose');
    expect(r.modelInjected).toBe(false);
  });
});

// P1-2 — a model with no agent used to be forced onto whatever launched,
// producing `codex --model haiku` (an invalid launch).
describe('applyRoleBinding — a model needs an agent (P1-2)', () => {
  it('does not inject a model when the binding names no agent', () => {
    const r = applyRoleBinding('codex', { model: 'haiku' });
    expect(r.command).toBe('codex');
    expect(r.changed).toBe(false);
    expect(r.modelInjected).toBe(false);
    expect(r.note).toMatch(/no agent/);
  });

  it('still applies the args half of an agent-less binding', () => {
    const r = applyRoleBinding('claude', { model: 'haiku', args: '--verbose' });
    expect(r.command).toBe('claude --verbose');
    expect(r.modelInjected).toBe(false);
  });
});

// P2-1 — terminal_send is how the orchestrator talks to a RUNNING TUI. A
// sentence that happens to start with a launcher word must survive intact.
describe('applyRoleBinding — prose sent to a running agent is not rewritten (P2-1)', () => {
  const binding: RoleBinding = { agent: 'claude', model: 'haiku', args: '--foo' };

  it('leaves an instruction whose first word is the launcher alone', () => {
    const r = applyRoleBinding('claude code is failing on windows', binding);
    expect(r.command).toBe('claude code is failing on windows');
    expect(r.changed).toBe(false);
  });

  it('leaves a natural-language prompt alone', () => {
    const r = applyRoleBinding('please refactor the login flow', { args: '--foo' });
    expect(r.changed).toBe(false);
  });

  it('leaves a mixed flag/prose line alone', () => {
    const r = applyRoleBinding('codex should have used --model here right', binding);
    expect(r.changed).toBe(false);
  });

  it('still rewrites a quoted-prompt invocation (a real shell launch)', () => {
    const r = applyRoleBinding('claude "fix the login flow"', binding);
    expect(r.command).toBe('claude --model haiku "fix the login flow" --foo');
  });

  it('still rewrites a flag-value invocation', () => {
    const r = applyRoleBinding('claude --permission-mode plan', binding);
    expect(r.command).toBe('claude --model haiku --permission-mode plan --foo');
  });

  it('still rewrites a known sub-command invocation', () => {
    const r = applyRoleBinding('codex resume --last', { agent: 'codex', model: 'gpt-5.5' });
    expect(r.command).toBe('codex --model gpt-5.5 resume --last');
  });

  it('still rewrites a sub-command carrying its own id argument', () => {
    const r = applyRoleBinding('codex resume 0e1f-2a3b', { agent: 'codex', model: 'gpt-5.5' });
    expect(r.command).toBe('codex --model gpt-5.5 resume 0e1f-2a3b');
  });

  it('still rewrites the reconstructed claude resume line', () => {
    const r = applyRoleBinding(
      'claude --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
      { agent: 'claude', model: 'haiku' },
    );
    expect(r.command).toBe(
      'claude --model haiku --dangerously-skip-permissions --resume a1b2c3d4-0000-0000-0000-9f8e7d6c5b4a',
    );
  });
});

// P2-3 — the idempotence check was a raw suffix match.
describe('applyRoleBinding — args idempotence is token-aligned (P2-3)', () => {
  it('appends args when the command merely ENDS WITH a longer token', () => {
    const r = applyRoleBinding('claude --bar-foo', { agent: 'claude', args: '--foo' });
    expect(r.command).toBe('claude --bar-foo --foo');
  });

  it('does not re-append when the trailing tokens already match', () => {
    const r = applyRoleBinding('claude --bar --foo', { agent: 'claude', args: '--foo' });
    expect(r.changed).toBe(false);
  });

  it('matches a multi-token args run on token boundaries', () => {
    const binding: RoleBinding = { agent: 'claude', args: '--permission-mode plan' };
    const once = applyRoleBinding('claude', binding).command;
    expect(once).toBe('claude --permission-mode plan');
    expect(applyRoleBinding(once, binding).changed).toBe(false);
  });
});

describe('normalizeRoleBinding / normalizeRoleBindings', () => {
  it('normalizes agent to a launcher stem and caps fields', () => {
    const b = normalizeRoleBinding({ agent: 'C:\\bin\\Codex.EXE', model: '  o3  ', args: 'a\nb\tc' });
    expect(b).toEqual({ agent: 'codex', model: 'o3', args: 'a b c' });
  });

  it('strips control chars and length-caps args', () => {
    const long = 'x'.repeat(ROLE_BINDING_ARGS_MAX + 50);
    const b = normalizeRoleBinding({ args: long });
    expect(b?.args?.length).toBe(ROLE_BINDING_ARGS_MAX);
  });

  it('returns undefined for an empty or non-object binding', () => {
    expect(normalizeRoleBinding({})).toBeUndefined();
    expect(normalizeRoleBinding({ agent: '   ' })).toBeUndefined();
    expect(normalizeRoleBinding(null)).toBeUndefined();
    expect(normalizeRoleBinding('claude')).toBeUndefined();
  });

  it('drops empty bindings and invalid keys from a map', () => {
    const map = normalizeRoleBindings({
      Builder: { agent: 'claude', model: 'sonnet' },
      Reviewer: {},
      '   ': { model: 'haiku' },
      Tester: { model: 'haiku' },
    });
    expect(Object.keys(map).sort()).toEqual(['Builder', 'Tester']);
    expect(map.Builder).toEqual({ agent: 'claude', model: 'sonnet' });
  });

  it('returns an empty map for garbage input', () => {
    expect(normalizeRoleBindings(null)).toEqual({});
    expect(normalizeRoleBindings([1, 2, 3])).toEqual({});
    expect(normalizeRoleBindings('nope')).toEqual({});
  });
});

// SECURITY — the field validators, not the control-char strip, carry the safety
// posture. A model with a space silently became a claude PROMPT positional.
describe('normalizeRoleBinding — field validation', () => {
  it('accepts realistic model ids', () => {
    for (const m of ['haiku', 'gpt-5.5', 'claude-opus-4-8', 'us.anthropic.claude:1', 'o3_mini']) {
      expect(normalizeRoleBinding({ model: m })?.model).toBe(m);
    }
  });

  it('rejects a multi-word model (it would split into a prompt positional)', () => {
    expect(normalizeRoleBinding({ model: 'claude sonnet 4' })).toBeUndefined();
  });

  it('rejects a model carrying shell syntax', () => {
    expect(normalizeRoleBinding({ model: 'haiku; rm -rf /' })).toBeUndefined();
    expect(normalizeRoleBinding({ model: '$(id)' })).toBeUndefined();
    expect(normalizeRoleBinding({ model: 'haiku|tee' })).toBeUndefined();
  });

  it('keeps a model when a sibling field is rejected', () => {
    expect(normalizeRoleBinding({ model: 'haiku', args: 'a; b' })).toEqual({ model: 'haiku' });
  });

  it('accepts ordinary launch flags in args', () => {
    const b = normalizeRoleBinding({ args: '--dangerously-skip-permissions --permission-mode plan' });
    expect(b?.args).toBe('--dangerously-skip-permissions --permission-mode plan');
  });

  it('rejects args carrying a shell metacharacter', () => {
    for (const a of ['--foo; rm -rf /', '--foo && curl x', '--foo `id`', '--foo $(id)', '--foo | tee']) {
      expect(normalizeRoleBinding({ args: a })?.args).toBeUndefined();
    }
  });
});

// The spawnedProcess escape hatch exists for X8 supervised leaves, whose `exec`
// string becomes the pane's root process. These pin BOTH halves: that it lifts
// the prose gate, and that it lifts nothing else — the default path, gate 1, and
// every other rule must be exactly as they were.
describe('applyRoleBinding — spawnedProcess lifts the prose gate and nothing else', () => {
  it('enforces on a launch whose argument is a bare word', () => {
    const line = 'claude /loop';
    const bound: RoleBinding = { agent: 'claude', model: 'haiku' };
    // Submitted into a pane this is most likely a slash command typed at a
    // running agent, so the default still refuses.
    expect(applyRoleBinding(line, bound).changed).toBe(false);
    expect(applyRoleBinding(line, bound, { spawnedProcess: true }).command).toBe(
      'claude --model haiku /loop',
    );
  });

  it('still refuses a non-agent stem — gate 1 is not an option', () => {
    for (const cmd of ['npm run dev', 'git commit -m wip', 'ls']) {
      expect(applyRoleBinding(cmd, { agent: 'claude', model: 'haiku', args: '--x' }, {
        spawnedProcess: true,
      }).changed).toBe(false);
    }
  });

  it('still refuses when the launched agent is not the bound one', () => {
    const r = applyRoleBinding('codex /loop', { agent: 'claude', model: 'haiku' }, {
      spawnedProcess: true,
    });
    expect(r.changed).toBe(false);
    expect(r.note).toMatch(/bound to "claude"/);
  });

  it('still honors an explicit --model and the no-agent/no-grammar rules', () => {
    expect(applyRoleBinding('claude --model opus /loop', { agent: 'claude', model: 'haiku' }, {
      spawnedProcess: true,
    }).modelInjected).toBe(false);
    expect(applyRoleBinding('claude /loop', { model: 'haiku' }, { spawnedProcess: true })
      .modelInjected).toBe(false);
    expect(applyRoleBinding('gemini /loop', { agent: 'gemini', model: 'flash' }, {
      spawnedProcess: true,
    }).modelInjected).toBe(false);
  });

  it('leaves the prose gate armed for every caller that does not opt out', () => {
    // The regression this guards: a default-on flag would splice flags into an
    // orchestrator's message to a live TUI.
    for (const prose of ['claude code is failing on windows', 'claude please retry the build']) {
      expect(applyRoleBinding(prose, { agent: 'claude', model: 'haiku' }).changed).toBe(false);
      expect(applyRoleBinding(prose, { agent: 'claude', model: 'haiku' }, {}).changed).toBe(false);
      expect(applyRoleBinding(prose, { agent: 'claude', model: 'haiku' }, {
        spawnedProcess: false,
      }).changed).toBe(false);
    }
  });
});

describe('launcherSupportsModelFlag', () => {
  it('knows claude + codex, not gemini/aider', () => {
    expect(launcherSupportsModelFlag('claude')).toBe(true);
    expect(launcherSupportsModelFlag('codex')).toBe(true);
    expect(launcherSupportsModelFlag('gemini')).toBe(false);
    expect(launcherSupportsModelFlag('aider')).toBe(false);
  });

  it('knows agy (--model grammar verified against agy 1.2.13)', () => {
    expect(launcherSupportsModelFlag('agy')).toBe(true);
    expect(KNOWN_AGENT_STEMS.has('agy')).toBe(true);
  });
});

// P2-B — the predicate every "this pane runs that model" affordance gates on.
// Its contract is that it agrees with applyRoleBinding: whenever it says true,
// the rewrite really injects; whenever false, the launch is untouched.
describe('bindingEnforcesModel — the UI may only claim what the rewrite does', () => {
  it('is true only for a model + agent + verified grammar', () => {
    expect(bindingEnforcesModel({ agent: 'claude', model: 'haiku' })).toBe(true);
    expect(bindingEnforcesModel({ agent: 'codex', model: 'gpt-5.5' })).toBe(true);
  });

  it('is false for a model with no agent — nobody owns that --model grammar', () => {
    expect(bindingEnforcesModel({ model: 'haiku' })).toBe(false);
  });

  it('is false for an agent whose --model grammar is unverified', () => {
    expect(bindingEnforcesModel({ agent: 'gemini', model: 'flash' })).toBe(false);
    expect(bindingEnforcesModel({ agent: 'opencode', model: 'x' })).toBe(false);
  });

  it('is false for a binding with nothing to pin', () => {
    expect(bindingEnforcesModel(undefined)).toBe(false);
    expect(bindingEnforcesModel({})).toBe(false);
    expect(bindingEnforcesModel({ agent: 'claude' })).toBe(false);
    // Args-only really is enforced — but no MODEL is, and the badge shows a model.
    expect(bindingEnforcesModel({ agent: 'claude', args: '--verbose' })).toBe(false);
  });

  it('agrees with applyRoleBinding on every combination it reports', () => {
    const cases: RoleBinding[] = [
      { agent: 'claude', model: 'haiku' },
      { agent: 'codex', model: 'gpt-5.5' },
      { model: 'haiku' },
      { agent: 'gemini', model: 'flash' },
      { agent: 'opencode', model: 'x' },
      { agent: 'claude', args: '--verbose' },
      {},
    ];
    for (const binding of cases) {
      const launched = applyRoleBinding(binding.agent ?? 'claude', binding);
      expect(launched.modelInjected).toBe(bindingEnforcesModel(binding));
    }
  });
});

describe('applyRoleAgent — launcher swap for wmux-assembled launches', () => {
  const PROMPT_ARG = `"$(cat '/tmp/wtask/prompt.md')"`;

  it('swaps the launcher for the role\'s agent', () => {
    const out = applyRoleAgent(`claude ${PROMPT_ARG}`, { agent: 'codex' });
    expect(out.changed).toBe(true);
    expect(out.command).toBe(`codex ${PROMPT_ARG}`);
  });

  it('never swaps in agy, which rejects a positional prompt (even from a hand-edited binding)', () => {
    const out = applyRoleAgent(`claude ${PROMPT_ARG}`, { agent: 'agy', model: 'gemini-3.8-flash-low' });
    expect(out.changed).toBe(false);
    expect(out.command).toBe(`claude ${PROMPT_ARG}`);
    expect(out.note).toMatch(/"agy".*positional prompt/);
  });

  it('leaves the prompt argument byte-identical', () => {
    // The argument carries a quoted shell substitution; splicing must not
    // requote, reorder or normalize any of it.
    const out = applyRoleAgent(`claude ${PROMPT_ARG}`, { agent: 'codex' });
    expect(out.command.slice('codex '.length)).toBe(PROMPT_ARG);
  });

  it('lets the model flag apply afterwards — the two steps compose', () => {
    // The whole point: applyRoleBinding bails on a stem mismatch, so before the
    // swap a Reviewer→codex binding injected nothing at all.
    const binding: RoleBinding = { agent: 'codex', model: 'o3' };
    const before = applyRoleBinding(`claude ${PROMPT_ARG}`, binding, { spawnedProcess: true });
    expect(before.modelInjected).toBe(false);

    const swapped = applyRoleAgent(`claude ${PROMPT_ARG}`, binding);
    const after = applyRoleBinding(swapped.command, binding, { spawnedProcess: true });
    expect(after.modelInjected).toBe(true);
    expect(after.command).toContain('--model o3');
    expect(after.command.startsWith('codex')).toBe(true);
  });

  it('refuses when the command carries flags written for the other CLI', () => {
    // `codex --dangerously-skip-permissions` is not a launch anyone asked for.
    const out = applyRoleAgent('claude --dangerously-skip-permissions', { agent: 'codex' });
    expect(out.changed).toBe(false);
    expect(out.command).toBe('claude --dangerously-skip-permissions');
    expect(out.note).toMatch(/NOT swapped/);
  });

  it('refuses an agent wmux does not recognise, and says so', () => {
    const out = applyRoleAgent(`claude ${PROMPT_ARG}`, { agent: 'rm -rf /' as string });
    expect(out.changed).toBe(false);
    expect(out.note).toMatch(/does not recognise/);
  });

  it('never touches a non-agent command', () => {
    for (const cmd of ['npm test', 'git commit -m wip', 'ls']) {
      expect(applyRoleAgent(cmd, { agent: 'codex' })).toMatchObject({ command: cmd, changed: false });
    }
  });

  it('is a no-op when the binding names no agent, or the same one', () => {
    expect(applyRoleAgent('claude x', { model: 'o3' }).changed).toBe(false);
    expect(applyRoleAgent('claude x', { agent: 'claude' }).changed).toBe(false);
    expect(applyRoleAgent('claude x', undefined).changed).toBe(false);
  });
});

describe('role binding launch options (effort, skip permissions)', () => {
  it('splices claude effort and skip flags after the model', () => {
    const r = applyRoleBinding('claude', {
      agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', skipPermissions: true,
    });
    expect(r.command).toBe('claude --model claude-sonnet-5-5 --effort low --dangerously-skip-permissions');
    expect(r.modelInjected).toBe(true);
  });

  it('uses the codex -c grammar before a subcommand', () => {
    const r = applyRoleBinding('codex resume --last', { agent: 'codex', effort: 'high', skipPermissions: true });
    expect(r.command).toBe(
      'codex -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox resume --last',
    );
  });

  it('never emits an effort flag for agy (effort lives in the model id)', () => {
    const r = applyRoleBinding('agy', {
      agent: 'agy', model: 'gemini-3.8-flash-low', effort: 'low', skipPermissions: true,
    });
    expect(r.command).toBe('agy --model gemini-3.8-flash-low --dangerously-skip-permissions');
  });

  it('lets a flag already on the line win', () => {
    const b = { agent: 'claude', effort: 'low', skipPermissions: true };
    expect(applyRoleBinding('claude --effort max', b).command).toBe(
      'claude --dangerously-skip-permissions --effort max',
    );
    expect(applyRoleBinding('codex --yolo', { agent: 'codex', skipPermissions: true }).changed).toBe(false);
  });

  it('is idempotent', () => {
    const b = { agent: 'claude', model: 'opus', effort: 'low', skipPermissions: true };
    const once = applyRoleBinding('claude', b).command;
    expect(applyRoleBinding(once, b).command).toBe(once);
  });

  it('lets a flag in the binding\'s own args win over effort / skip (claude)', () => {
    expect(applyRoleBinding('claude', { agent: 'claude', effort: 'low', args: '--effort high' }).command).toBe(
      'claude --effort high',
    );
    expect(
      applyRoleBinding('claude', { agent: 'claude', skipPermissions: true, args: '--dangerously-skip-permissions' })
        .command,
    ).toBe('claude --dangerously-skip-permissions');
    // --effort=<level> spelling in args counts too.
    expect(applyRoleBinding('claude', { agent: 'claude', effort: 'low', args: '--effort=max' }).command).toBe(
      'claude --effort=max',
    );
  });

  it('lets a flag in the binding\'s own args win over effort / skip (codex)', () => {
    const b = {
      agent: 'codex', effort: 'low', skipPermissions: true,
      args: '-c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox',
    };
    const once = applyRoleBinding('codex', b).command;
    expect(once).toBe('codex -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox');
    expect(applyRoleBinding(once, b).command).toBe(once);
    expect(applyRoleBinding('codex', { agent: 'codex', skipPermissions: true, args: '--yolo' }).command).toBe(
      'codex --yolo',
    );
  });

  // `--allow-dangerously-skip-permissions` only makes bypass available; it does
  // not enable it, so it must not count as the skip flag already being there.
  it('does not treat --allow-dangerously-skip-permissions as skip', () => {
    expect(
      applyRoleBinding('claude --allow-dangerously-skip-permissions', { agent: 'claude', skipPermissions: true })
        .command,
    ).toBe('claude --dangerously-skip-permissions --allow-dangerously-skip-permissions');
  });

  it('suppressSkipPermissions withholds only the skip flag (explicit per-launch OFF)', () => {
    const b = { agent: 'claude', model: 'opus', effort: 'low', skipPermissions: true };
    // A fresh launch still gets the role's skip flag.
    expect(applyRoleBinding('claude', b).command).toBe(
      'claude --model opus --effort low --dangerously-skip-permissions',
    );
    expect(applyRoleBinding('claude --permission-mode plan', b, { suppressSkipPermissions: true }).command).toBe(
      'claude --model opus --effort low --permission-mode plan',
    );
    // Nothing else to apply → unchanged.
    expect(
      applyRoleBinding('claude', { agent: 'claude', skipPermissions: true }, { suppressSkipPermissions: true }).changed,
    ).toBe(false);
  });

  it('needs the agent named, like the model', () => {
    expect(applyRoleBinding('claude', { effort: 'low', skipPermissions: true }).changed).toBe(false);
  });

  it('normalizes the new fields strictly', () => {
    expect(
      normalizeRoleBinding({ agent: 'codex', effort: 'high; rm', skipPermissions: 'true' }),
    ).toEqual({ agent: 'codex' });
    expect(normalizeRoleBinding({ skipPermissions: true })).toEqual({ skipPermissions: true });
    expect(normalizeRoleBinding({ effort: 'medium' })).toEqual({ effort: 'medium' });
  });

});

// #1680 — fresh context per dispatched task: a strict-true opt-in, inert unless
// the bound agent has a verified fresh-context command.
describe('role binding freshContext (#1680)', () => {
  it('normalizes strictly: only a literal true is kept', () => {
    expect(normalizeRoleBinding({ agent: 'codex', effort: 'high', freshContext: true })).toEqual({
      agent: 'codex',
      effort: 'high',
      freshContext: true,
    });
    expect(normalizeRoleBinding({ agent: 'claude', freshContext: 'true' })).toEqual({ agent: 'claude' });
    expect(normalizeRoleBinding({ agent: 'claude', freshContext: 1 })).toEqual({ agent: 'claude' });
    expect(normalizeRoleBinding({ agent: 'claude', freshContext: false })).toEqual({ agent: 'claude' });
    // A binding holding only the flag is kept (Settings shows why it is inert).
    expect(normalizeRoleBinding({ freshContext: true })).toEqual({ freshContext: true });
    expect(normalizeRoleBindings({ Builder: { agent: 'claude', freshContext: true } })).toEqual({
      Builder: { agent: 'claude', freshContext: true },
    });
  });

  it('is enforced only for an agent with a verified command (claude, codex)', () => {
    expect(bindingEnforcesFreshContext({ agent: 'claude', freshContext: true })).toBe(true);
    expect(bindingEnforcesFreshContext({ agent: 'codex', freshContext: true })).toBe(true);
    expect(bindingEnforcesFreshContext({ agent: 'agy', freshContext: true })).toBe(false);
    expect(bindingEnforcesFreshContext({ agent: 'opencode', freshContext: true })).toBe(false);
    expect(bindingEnforcesFreshContext({ freshContext: true })).toBe(false);
    expect(bindingEnforcesFreshContext({ agent: 'claude' })).toBe(false);
    expect(bindingEnforcesFreshContext(undefined)).toBe(false);
  });

  it('is not a launch option: the launch rewrite ignores it', () => {
    expect(applyRoleBinding('claude', { agent: 'claude', freshContext: true })).toEqual({
      command: 'claude',
      changed: false,
      modelInjected: false,
    });
    expect(applyRoleBinding('claude', { agent: 'claude', model: 'haiku', freshContext: true }).command).toBe(
      'claude --model haiku',
    );
  });
});

// #1681 — owner decision: an explicit, user-stated permission choice wins over
// the role's skip, whether the skip comes from `skipPermissions` or `args`.
describe('role skip permissions versus an explicit permission choice (#1681)', () => {
  const fixpoint = (cmd: string, b: RoleBinding, opts?: Parameters<typeof applyRoleBinding>[2]): string => {
    const once = applyRoleBinding(cmd, b, opts).command;
    expect(applyRoleBinding(once, b, opts).command).toBe(once);
    return once;
  };

  it('still injects the role skip on a normal fresh launch', () => {
    expect(fixpoint('claude', { agent: 'claude', skipPermissions: true })).toBe(
      'claude --dangerously-skip-permissions',
    );
    expect(fixpoint('codex', { agent: 'codex', skipPermissions: true })).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
    expect(fixpoint('claude "fix the login flow"', { agent: 'claude', skipPermissions: true })).toBe(
      'claude --dangerously-skip-permissions "fix the login flow"',
    );
  });

  it('suppressSkipPermissions also drops the skip flag from the role args, keeping the rest', () => {
    const b: RoleBinding = { agent: 'claude', model: 'haiku', args: '--verbose --dangerously-skip-permissions --add-dir "/tmp/x"' };
    expect(fixpoint('claude --permission-mode plan --resume S', b, { suppressSkipPermissions: true })).toBe(
      'claude --model haiku --permission-mode plan --resume S --verbose --add-dir "/tmp/x"',
    );
    // Args that were only the skip flag leave nothing to append.
    expect(
      fixpoint('claude --continue', { agent: 'claude', skipPermissions: true, args: '--dangerously-skip-permissions' }, {
        suppressSkipPermissions: true,
      }),
    ).toBe('claude --continue');
    // Toggle ON (no suppression) keeps the args as written.
    expect(fixpoint('claude --continue', { agent: 'claude', args: '--dangerously-skip-permissions' })).toBe(
      'claude --continue --dangerously-skip-permissions',
    );
  });

  it('drops the args skip under suppression even when the binding names no agent', () => {
    expect(fixpoint('claude --continue', { args: '--dangerously-skip-permissions --verbose' }, {
      suppressSkipPermissions: true,
    })).toBe('claude --continue --verbose');
  });

  it('a --permission-mode typed on the line withholds the role skip (both spellings)', () => {
    const b: RoleBinding = { agent: 'claude', model: 'haiku', skipPermissions: true };
    for (const line of ['claude --permission-mode plan', 'claude --permission-mode=plan', 'claude "--permission-mode=plan"']) {
      const r = applyRoleBinding(line, b);
      expect(r.command).toBe(line.replace('claude', 'claude --model haiku'));
      expect(r.note).toMatch(/own permission choice/);
      expect(fixpoint(line, b)).toBe(r.command);
    }
  });

  it('a --permission-mode typed on the line also drops the skip from the role args', () => {
    const b: RoleBinding = { agent: 'claude', args: '--dangerously-skip-permissions --verbose' };
    const r = applyRoleBinding('claude --permission-mode plan', b);
    expect(r.command).toBe('claude --permission-mode plan --verbose');
    expect(r.note).toMatch(/own permission choice/);
    expect(fixpoint('claude --permission-mode plan', b)).toBe(r.command);
  });

  it('a --permission-mode in the role args is the role config: no injected skip, args kept', () => {
    const b: RoleBinding = { agent: 'claude', skipPermissions: true, args: '--permission-mode acceptEdits' };
    const r = applyRoleBinding('claude', b);
    expect(r.command).toBe('claude --permission-mode acceptEdits');
    expect(r.note).toBeUndefined();
    expect(fixpoint('claude', b)).toBe('claude --permission-mode acceptEdits');
  });

  it('a role-args run already on the line is not read as the user\'s choice (re-apply)', () => {
    const b: RoleBinding = { agent: 'claude', args: '--permission-mode acceptEdits --dangerously-skip-permissions' };
    expect(fixpoint('claude', b)).toBe('claude --permission-mode acceptEdits --dangerously-skip-permissions');
  });

  it('codex: the approval policy and sandbox flags are explicit choices', () => {
    const b: RoleBinding = { agent: 'codex', effort: 'high', skipPermissions: true };
    for (const flags of ['-a never', '-anever', '--ask-for-approval on-request', '--ask-for-approval=never', '-s read-only', '--sandbox=read-only', '--approve-for-me']) {
      const r = applyRoleBinding(`codex ${flags}`, b);
      expect(r.command).toBe(`codex -c model_reasoning_effort=high ${flags}`);
      expect(fixpoint(`codex ${flags}`, b)).toBe(r.command);
    }
    // ...and the codex skip spellings in the args are dropped for them.
    expect(fixpoint('codex -s workspace-write', { agent: 'codex', args: '--yolo --search' })).toBe(
      'codex -s workspace-write --search',
    );
  });

  it('codex: an unrelated flag or a quoted sentence is not a permission choice', () => {
    const b: RoleBinding = { agent: 'codex', skipPermissions: true };
    expect(applyRoleBinding('codex --search', b).command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox --search',
    );
    expect(applyRoleBinding('codex --add-dir /tmp', b).command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox --add-dir /tmp',
    );
    expect(applyRoleBinding('codex "use -s read-only here"', b).command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox "use -s read-only here"',
    );
  });

  it('claude: --permission-prompts is not a permission mode', () => {
    expect(applyRoleBinding('claude --permission-prompts none', { agent: 'claude', skipPermissions: true }).command).toBe(
      'claude --dangerously-skip-permissions --permission-prompts none',
    );
  });
});

// #1681 — the caller learns which launch options were really spliced in.
describe('applyRoleBinding — optionsInjected reports only what was added', () => {
  it('reports effort and skip when both were injected', () => {
    expect(applyRoleBinding('claude', { agent: 'claude', effort: 'low', skipPermissions: true }).optionsInjected)
      .toEqual({ effort: 'low', skipPermissions: true });
    expect(applyRoleBinding('codex', { agent: 'codex', effort: 'high' }).optionsInjected).toEqual({ effort: 'high' });
    expect(applyRoleBinding('codex', { agent: 'codex', skipPermissions: true }).optionsInjected)
      .toEqual({ skipPermissions: true });
  });

  it('is absent when nothing was injected', () => {
    for (const [cmd, b, opts] of [
      ['claude', { agent: 'claude', model: 'haiku' }, undefined],
      ['claude --effort max --dangerously-skip-permissions', { agent: 'claude', effort: 'low', skipPermissions: true }, undefined],
      ['claude', { agent: 'claude', skipPermissions: true, args: '--dangerously-skip-permissions' }, undefined],
      ['claude --permission-mode plan', { agent: 'claude', skipPermissions: true }, undefined],
      ['claude', { agent: 'claude', skipPermissions: true, args: '--verbose' }, { suppressSkipPermissions: true }],
      ['agy', { agent: 'agy', effort: 'low' }, undefined],
      ['claude', { effort: 'low', skipPermissions: true }, undefined],
    ] as const) {
      expect(applyRoleBinding(cmd, b as RoleBinding, opts).optionsInjected).toBeUndefined();
    }
  });

  it('reports the effort alone when the skip was withheld by a permission flag', () => {
    const r = applyRoleBinding('claude --permission-mode plan', { agent: 'claude', effort: 'low', skipPermissions: true });
    expect(r.command).toBe('claude --effort low --permission-mode plan');
    expect(r.optionsInjected).toEqual({ effort: 'low' });
  });
});

// #1681 — the pane badge and fleet chip gate on this, like bindingEnforcesModel.
describe('bindingEnforcesSkipPermissions / bindingSkipPermissionsFlag', () => {
  it('is true for a named agent with a verified skip grammar', () => {
    expect(bindingSkipPermissionsFlag({ agent: 'claude', skipPermissions: true })).toBe('--dangerously-skip-permissions');
    expect(bindingSkipPermissionsFlag({ agent: 'codex', skipPermissions: true }))
      .toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(bindingSkipPermissionsFlag({ agent: 'agy', skipPermissions: true })).toBe('--dangerously-skip-permissions');
    expect(bindingEnforcesSkipPermissions({ agent: 'claude', model: 'haiku', skipPermissions: true })).toBe(true);
  });

  it('counts a skip spelling in the role args', () => {
    expect(bindingSkipPermissionsFlag({ agent: 'claude', args: '--verbose --dangerously-skip-permissions' }))
      .toBe('--dangerously-skip-permissions');
    // The spelling the args actually use, so the tooltip names what runs.
    expect(bindingSkipPermissionsFlag({ agent: 'codex', args: '--yolo' })).toBe('--yolo');
    expect(bindingEnforcesSkipPermissions({ agent: 'claude', args: '--allow-dangerously-skip-permissions' })).toBe(false);
  });

  // Review of #1681: the badge said "bypass" on a launch the rewrite leaves in
  // the role's own permission mode.
  it('is undefined for a role skip when the role args make a permission choice', () => {
    expect(bindingSkipPermissionsFlag({ agent: 'claude', skipPermissions: true, args: '--permission-mode acceptEdits' }))
      .toBeUndefined();
    expect(bindingSkipPermissionsFlag({ agent: 'codex', skipPermissions: true, args: '-s workspace-write' }))
      .toBeUndefined();
    expect(bindingSkipPermissionsFlag({ agent: 'codex', skipPermissions: true, args: '-c approval_policy=never' }))
      .toBeUndefined();
    // ...but a skip spelling in the args still runs bypass beside that mode.
    expect(bindingSkipPermissionsFlag({
      agent: 'claude', skipPermissions: true, args: '--permission-mode acceptEdits --dangerously-skip-permissions',
    })).toBe('--dangerously-skip-permissions');
  });

  it('is false without an agent, without a skip grammar, or without a skip', () => {
    expect(bindingEnforcesSkipPermissions(undefined)).toBe(false);
    expect(bindingEnforcesSkipPermissions({ skipPermissions: true })).toBe(false);
    expect(bindingEnforcesSkipPermissions({ args: '--dangerously-skip-permissions' })).toBe(false);
    expect(bindingEnforcesSkipPermissions({ agent: 'gemini', skipPermissions: true })).toBe(false);
    expect(bindingEnforcesSkipPermissions({ agent: 'claude', model: 'haiku' })).toBe(false);
  });

  it('agrees with applyRoleBinding on a fresh launch', () => {
    const cases: RoleBinding[] = [
      { agent: 'claude', skipPermissions: true },
      { agent: 'codex', skipPermissions: true },
      { agent: 'claude', args: '--dangerously-skip-permissions' },
      { agent: 'codex', args: '--yolo' },
      { agent: 'claude', skipPermissions: true, args: '--permission-mode acceptEdits' },
      { agent: 'codex', skipPermissions: true, args: '-s workspace-write' },
      { agent: 'codex', skipPermissions: true, args: '--config sandbox_mode=read-only' },
      { agent: 'claude', skipPermissions: true, args: '--permission-mode acceptEdits --dangerously-skip-permissions' },
      { skipPermissions: true },
      { agent: 'gemini', skipPermissions: true },
      { agent: 'claude', model: 'haiku' },
    ];
    for (const binding of cases) {
      const stem = binding.agent ?? 'claude';
      const flag = bindingSkipPermissionsFlag(binding);
      const launched = applyRoleBinding(stem, binding).command.split(' ');
      expect(launched.includes(flag ?? '\u0000')).toBe(flag !== undefined);
    }
  });
});

// Review of #1681 — codex permission choices made through config count like
// `-a` / `-s`, in every spelling codex 0.158 accepts.
describe('codex config permission choices (-c approval_policy / sandbox_mode)', () => {
  const fixpoint = (cmd: string, b: RoleBinding): string => {
    const once = applyRoleBinding(cmd, b).command;
    expect(applyRoleBinding(once, b).command).toBe(once);
    return once;
  };
  const spellings = [
    '-c approval_policy=never', '-c=approval_policy=never', '-capproval_policy=never',
    '--config approval_policy=on-request', '--config=sandbox_mode=read-only', '-c sandbox_mode=workspace-write',
    '-c "approval_policy=never"',
  ];

  it('on the typed line: withholds the role bypass and drops the skip from the role args', () => {
    for (const flags of spellings) {
      const r = applyRoleBinding(`codex ${flags}`, { agent: 'codex', effort: 'high', skipPermissions: true });
      expect(r.command).toBe(`codex -c model_reasoning_effort=high ${flags}`);
      expect(r.optionsInjected).toEqual({ effort: 'high' });
      expect(fixpoint(`codex ${flags}`, { agent: 'codex', skipPermissions: true, args: '--yolo --search' }))
        .toBe(`codex ${flags} --search`);
    }
  });

  it('in the role args: the role config, so no injected bypass', () => {
    for (const flags of spellings) {
      const b: RoleBinding = { agent: 'codex', skipPermissions: true, args: flags };
      expect(fixpoint('codex', b)).toBe(`codex ${flags}`);
    }
  });

  it('other config keys are not permission choices', () => {
    for (const flags of ['-c model_reasoning_effort=high', '-c model="o3"', '--config features.x=true', '-c approval_policy_extra=1']) {
      expect(applyRoleBinding(`codex ${flags}`, { agent: 'codex', skipPermissions: true }).command)
        .toBe(`codex --dangerously-bypass-approvals-and-sandbox ${flags}`);
    }
  });
});

// Review of #1681 — a permission flag typed on the line beats one in the role
// args: the args are appended after it, and the last one wins.
describe('a typed permission flag drops the conflicting role-args permission flags', () => {
  const fixpoint = (cmd: string, b: RoleBinding, opts?: Parameters<typeof applyRoleBinding>[2]): string => {
    const once = applyRoleBinding(cmd, b, opts).command;
    expect(applyRoleBinding(once, b, opts).command).toBe(once);
    return once;
  };

  it('claude: --permission-mode in the args (both spellings) gives way, unrelated args stay', () => {
    for (const roleMode of ['--permission-mode acceptEdits', '--permission-mode=acceptEdits']) {
      const b: RoleBinding = { agent: 'claude', args: `--verbose ${roleMode} --dangerously-skip-permissions --add-dir /x` };
      const r = applyRoleBinding('claude --permission-mode plan', b);
      expect(r.command).toBe('claude --permission-mode plan --verbose --add-dir /x');
      expect(r.note).toMatch(/own permission choice/);
      expect(fixpoint('claude --permission-mode plan', b)).toBe(r.command);
    }
  });

  it('codex: -a / -s / --approve-for-me / -c permission keys in the args give way', () => {
    const b: RoleBinding = {
      agent: 'codex', effort: 'low',
      args: '-a on-request --search -s workspace-write --approve-for-me -c sandbox_mode=read-only -c model_verbosity=low',
    };
    expect(fixpoint('codex -a never', b)).toBe('codex -c model_reasoning_effort=low -a never --search -c model_verbosity=low');
    expect(fixpoint('codex --config=approval_policy=never', b))
      .toBe('codex -c model_reasoning_effort=low --config=approval_policy=never --search -c model_verbosity=low');
  });

  it('keeps the role args permission flags when the line makes no choice', () => {
    const b: RoleBinding = { agent: 'claude', args: '--permission-mode acceptEdits' };
    expect(fixpoint('claude', b)).toBe('claude --permission-mode acceptEdits');
    // The toggle-OFF fallback has no captured mode: nothing typed to beat it.
    expect(fixpoint('claude --continue', b, { suppressSkipPermissions: true }))
      .toBe('claude --continue --permission-mode acceptEdits');
  });

  it('the resume chip OFF path restores the captured mode over the role args mode', () => {
    const b: RoleBinding = { agent: 'claude', args: '--permission-mode acceptEdits --verbose' };
    expect(fixpoint('claude --permission-mode plan --resume S', b, { suppressSkipPermissions: true }))
      .toBe('claude --permission-mode plan --resume S --verbose');
  });
});
