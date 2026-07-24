import { describe, expect, it } from 'vitest';
import {
  applyRoleBinding,
  launcherSupportsModelFlag,
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

describe('launcherSupportsModelFlag', () => {
  it('knows claude + codex, not gemini/aider', () => {
    expect(launcherSupportsModelFlag('claude')).toBe(true);
    expect(launcherSupportsModelFlag('codex')).toBe(true);
    expect(launcherSupportsModelFlag('gemini')).toBe(false);
    expect(launcherSupportsModelFlag('aider')).toBe(false);
  });
});
