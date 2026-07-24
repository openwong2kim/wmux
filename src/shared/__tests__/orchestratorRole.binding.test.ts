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
    const r = applyRoleBinding('claude', { model: 'haiku' });
    expect(r.command).toBe('claude --model haiku');
    expect(r.changed).toBe(true);
  });

  it('injects --model for codex with a full model id', () => {
    const r = applyRoleBinding('codex', { model: 'gpt-5.5' });
    expect(r.command).toBe('codex --model gpt-5.5');
    expect(r.changed).toBe(true);
  });

  it('leaves an explicit --model untouched (manual override wins for this launch)', () => {
    const r = applyRoleBinding('claude --model opus', { model: 'haiku' });
    expect(r.command).toBe('claude --model opus');
    expect(r.changed).toBe(false);
  });

  it('treats --model=x form as an explicit flag (no second injection)', () => {
    const r = applyRoleBinding('claude --model=opus', { model: 'haiku' });
    expect(r.changed).toBe(false);
  });

  it('does NOT treat a --model inside a quoted prompt as explicit — injects once', () => {
    const r = applyRoleBinding('claude "explain the --model flag"', { model: 'haiku' });
    expect(r.command).toBe('claude --model haiku "explain the --model flag"');
    expect(r.changed).toBe(true);
  });

  it('is a no-op + note for an agent with no known model-flag grammar', () => {
    const r = applyRoleBinding('gemini', { model: 'flash' });
    expect(r.command).toBe('gemini');
    expect(r.changed).toBe(false);
    expect(r.note).toMatch(/no known --model flag/);
  });

  it('is unchanged for an undefined binding or a binding with no model/args', () => {
    expect(applyRoleBinding('claude', undefined).changed).toBe(false);
    expect(applyRoleBinding('claude', {}).changed).toBe(false);
    expect(applyRoleBinding('claude', { agent: 'claude' }).changed).toBe(false);
  });

  it('preserves the original trailing args when injecting the model', () => {
    const r = applyRoleBinding('claude --foo', { model: 'haiku' });
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
    const r = applyRoleBinding('C:\\tools\\claude.cmd', { model: 'haiku' });
    expect(r.command).toBe('C:\\tools\\claude.cmd --model haiku');
  });

  it('appends normalized binding.args at the end', () => {
    const r = applyRoleBinding('claude', { model: 'haiku', args: '--dangerously-skip-permissions' });
    expect(r.command).toBe('claude --model haiku --dangerously-skip-permissions');
  });

  it('is idempotent — re-applying is a fixpoint', () => {
    const binding: RoleBinding = { model: 'haiku', args: '--foo' };
    const once = applyRoleBinding('claude', binding).command;
    const twice = applyRoleBinding(once, binding).command;
    expect(twice).toBe(once);
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

describe('launcherSupportsModelFlag', () => {
  it('knows claude + codex, not gemini/aider', () => {
    expect(launcherSupportsModelFlag('claude')).toBe(true);
    expect(launcherSupportsModelFlag('codex')).toBe(true);
    expect(launcherSupportsModelFlag('gemini')).toBe(false);
    expect(launcherSupportsModelFlag('aider')).toBe(false);
  });
});
