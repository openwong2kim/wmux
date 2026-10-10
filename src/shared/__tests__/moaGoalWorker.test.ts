import { describe, expect, it } from 'vitest';
import {
  GOAL_WORKER_DENIED_COMMANDS,
  GOAL_WORKER_PUSH_URL,
  GOAL_WORKER_TOKEN_PLACEHOLDER,
  goalFanoutRefusal,
  goalWorkerDenyRules,
  goalWorkerEnv,
  goalWorkerPromptNote,
  isGoalWorkerLauncher,
} from '../moaGoalWorker';
import { FANOUT_WORKER_DISALLOWED_TOOLS, applyWorkerPermissionFlags, workerLaunchFlags } from '../workerLaunch';
import { buildMoaGoalCard } from '../moaGoal';

/**
 * How claude splits a `--disallowedTools` value: on commas and spaces OUTSIDE
 * parentheses. Mirrors the parser in the claude CLI (observed in the 2.x
 * native build); kept here so a rule with a space inside `Bash(…)` is proven
 * to survive as one rule.
 */
function claudeSplitToolList(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inParens = false;
  for (const ch of value) {
    if (ch === '(') {
      inParens = true;
      cur += ch;
    } else if (ch === ')') {
      inParens = false;
      cur += ch;
    } else if ((ch === ',' || ch === ' ') && !inParens) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function disallowedValue(line: string): string {
  const m = line.match(/--disallowedTools "([^"]*)"/);
  if (!m) throw new Error('no --disallowedTools on the line');
  return m[1];
}

describe('goal worker deny rules', () => {
  it('covers push, PR, release, tag, publish, recursive delete and credential dumps, for Bash and PowerShell', () => {
    const rules = goalWorkerDenyRules();
    for (const c of ['git push*', 'git * push', 'gh pr create*', 'gh pr merge*', 'gh release*', 'git tag*', 'npm publish*', 'rm -rf*', 'rm -r -f*', 'Remove-Item * -Recurse*', 'gh auth token*']) {
      expect(GOAL_WORKER_DENIED_COMMANDS).toContain(c);
      expect(rules).toContain(`Bash(${c})`);
      expect(rules).toContain(`PowerShell(${c})`);
    }
    expect(rules).toHaveLength(GOAL_WORKER_DENIED_COMMANDS.length * 2);
  });

  it('rides the same quoted list and survives claude\'s split as whole rules', () => {
    const line = workerLaunchFlags('auto', goalWorkerDenyRules());
    expect(line.match(/--disallowedTools/g)).toHaveLength(1);
    const parsed = claudeSplitToolList(disallowedValue(line));
    expect(parsed).toEqual([...FANOUT_WORKER_DISALLOWED_TOOLS, ...goalWorkerDenyRules()]);
    // No rule may close the quoted word or break the shell line.
    for (const r of goalWorkerDenyRules()) expect(r).not.toMatch(/["`$;&|\n]/);
  });

  it('is applied to a claude launch only, after the role rewrite, in every mode', () => {
    const line = `claude "$(cat '/meta/prompt.md')"`;
    for (const mode of ['auto', 'acceptEdits', 'bypassPermissions', 'manual'] as const) {
      const out = applyWorkerPermissionFlags(line, mode, goalWorkerDenyRules());
      expect(claudeSplitToolList(disallowedValue(out))).toContain('Bash(git push*)');
    }
    const agy = `agy "$(cat '/meta/prompt.md')"`;
    expect(applyWorkerPermissionFlags(agy, 'auto', goalWorkerDenyRules())).toBe(agy);
  });

  it('re-applying replaces the list instead of doubling it', () => {
    const once = applyWorkerPermissionFlags('claude', 'auto', goalWorkerDenyRules());
    const twice = applyWorkerPermissionFlags(once, 'auto', goalWorkerDenyRules());
    expect(twice.match(/--disallowedTools/g)).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('a fan-out outside a goal gets no extra rules (owner decision 2026-09-24)', () => {
    expect(workerLaunchFlags('auto')).not.toContain('Bash(');
  });

  it('only claude may run as a goal worker', () => {
    expect(isGoalWorkerLauncher('claude')).toBe(true);
    for (const s of ['agy', 'codex', 'gemini', '']) expect(isGoalWorkerLauncher(s)).toBe(false);
  });
});

describe('goal worker environment (friction, not a boundary)', () => {
  const env = goalWorkerEnv('/meta/goal-gh-config');

  it('puts a non-credential placeholder where gh and git look for a token', () => {
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(env[k]).toBe(GOAL_WORKER_TOKEN_PLACEHOLDER);
    }
    expect(env.GH_CONFIG_DIR).toBe('/meta/goal-gh-config');
  });

  it('resets git credential helpers and disables push to origin through command-line config', () => {
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('remote.origin.pushurl');
    expect(env.GIT_CONFIG_VALUE_1).toBe(GOAL_WORKER_PUSH_URL);
    // Every key the count promises is present (a missing one makes git fail).
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
      expect(typeof env[`GIT_CONFIG_KEY_${i}`]).toBe('string');
      expect(typeof env[`GIT_CONFIG_VALUE_${i}`]).toBe('string');
    }
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
  });

  it('never names a WMUX_* key (those are reserved and dropped at spawn)', () => {
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('WMUX_'))).toBe(false);
  });

  it('the prompt note names the goal and what stays with the operator', () => {
    const note = goalWorkerPromptNote('G-abc123');
    expect(note).toContain('G-abc123');
    expect(note).toMatch(/Push, pull requests, tags, releases/);
  });
});

describe('goalFanoutRefusal', () => {
  const ok = {
    goalId: 'G-abc123',
    repoRoot: '/repo',
    pinnedMode: 'auto',
    currentMode: 'auto',
    worktree: true,
    agents: [] as { agent: string }[],
    remoteWoken: false,
  };

  it('allows a claude worktree fan-out with the pinned mode', () => {
    expect(goalFanoutRefusal(ok)).toBeNull();
    expect(goalFanoutRefusal({ ...ok, agents: [{ agent: 'claude' }, { agent: 'claude' }] })).toBeNull();
  });

  it.each([
    ['a turn another PC\'s Moa woke (W5)', { remoteWoken: true }, /another PC's Moa/],
    ['a goal with no repository', { repoRoot: null }, /names no repository/],
    ['output folders instead of worktrees', { worktree: false }, /worktrees/],
    ['an agy worker', { agents: [{ agent: 'claude' }, { agent: 'agy' }] }, /task 2 asks for agy/],
    ['a codex worker', { agents: [{ agent: 'codex' }] }, /codex/],
    ['a changed worker permission mode', { currentMode: 'bypassPermissions' }, /bypassPermissions now, but goal G-abc123 was approved with auto/],
    ['an unpinned (old) record', { pinnedMode: undefined }, /no pinned worker permission mode/],
  ])('refuses %s', (_name, over, re) => {
    expect(goalFanoutRefusal({ ...ok, ...over })).toMatch(re as RegExp);
  });
});

describe('the goal card shows the worker profile', () => {
  it('names the pinned mode and the denied commands', () => {
    const card = buildMoaGoalCard(
      {
        id: 'G-abc123',
        goal: 'Fix the flaky login test',
        repoRoot: '/repo',
        workspaceIds: [],
        level: 2,
        budget: { maxTasks: 4, maxHours: 4, maxTurns: 40 },
        humanOnly: [],
        workerPermissionMode: 'acceptEdits',
      },
      () => undefined,
    );
    expect(card.context).toMatch(/Workers: Claude Code only, permission mode acceptEdits; push, PR, tag, release, publish and recursive-delete commands denied; GitHub credentials withheld\./);
  });
});

/**
 * Review follow-up (#2025): the deny rules against REAL command spellings.
 * `claudeRuleMatches` models claude's documented prefix/glob rule semantics as
 * this branch assumes them: the whole command must match, `*` spans any text
 * INCLUDING spaces. Whether the installed CLI really lets a mid-pattern `*`
 * span spaces is still on the live dogfood list; this test pins what the rule
 * set covers under that assumption, and what it knowingly does not.
 */
function claudeRuleMatches(rule: string, command: string): boolean {
  const m = rule.match(/^(?:Bash|PowerShell)\((.*)\)$/);
  if (!m) return false;
  const re = new RegExp(`^${m[1].split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(command.trim());
}
const denied = (command: string) => goalWorkerDenyRules().some((r) => r.startsWith('Bash(') && claudeRuleMatches(r, command));

describe('goal worker deny rules against real command spellings (review)', () => {
  it.each([
    'git push',
    'git push origin main',
    'git push --force-with-lease origin HEAD',
    'git -C . push',
    'git -C /repo/sub push origin HEAD',
    'git -c credential.helper= push',
    'gh pr create',
    'gh pr create --fill --base main',
    'gh pr merge 2025 --squash',
    'gh release create v1.0.0',
    'gh api repos/o/r/pulls -f title=x',
  ])('denies %j', (cmd) => {
    expect(denied(cmd)).toBe(true);
  });

  it.each(['git status', 'git log --grep=push', 'git commit -m "push later"', 'gh pr view 2025', 'gh pr list', 'npm test'])(
    'leaves %j alone', (cmd) => {
      expect(denied(cmd)).toBe(false);
    });

  it.each(['sh -c "git push"', 'bash ./scripts/release.sh', 'cd sub && git push'])(
    'documented gap: %j is NOT caught by literal rules (env friction / push URL is what remains)', (cmd) => {
      expect(denied(cmd)).toBe(false);
    });

  it('every rule survives claude\'s list split intact, so the matcher above sees the rule as written', () => {
    const line = workerLaunchFlags('bypassPermissions', goalWorkerDenyRules());
    const parsed = claudeSplitToolList(disallowedValue(line));
    for (const r of goalWorkerDenyRules()) expect(parsed).toContain(r);
  });
});
