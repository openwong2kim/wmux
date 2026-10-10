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

  // The 2026-10-10 Windows dogfood (claude 2.1.296): these ran past the list.
  // `*` is matched here as "any text, or none", over the whole command — what
  // the dogfood observed (`Remove-Item * -Recurse*` caught both argument
  // orders, `git push*` the bare command). A model of the CLI's matcher, not
  // the matcher itself: the live run is still on the dogfood list.
  describe('the forms the dogfood got past the list', () => {
    const globMatch = (rule: string, cmd: string): boolean =>
      new RegExp(`^${rule.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's').test(cmd);
    const denied = (cmd: string): boolean => GOAL_WORKER_DENIED_COMMANDS.some((r) => globMatch(r, cmd));

    it.each([
      'ri .\\junk4 -r -fo',
      'ri -r -fo .\\junk4',
      'rm .\\junk -Recurse -Force',
      'del .\\junk -re',
      'erase -R junk',
      'rd junk -r',
      'rmdir junk -Recurse',
      'Remove-Item .\\junk -Rec -Force',
      'Remove-Item -r junk',
      'cmd /c "rd /s /q junk1"',
      'cmd.exe /c "rmdir /S /Q junk1"',
      'cmd /c del /s /q *.log',
      'cmd /c "erase /q /s junk"',
      'sh -c "git push origin HEAD"',
      'bash -c "git -C . push"',
      // still caught, as before
      'rm -rf junk',
      'git push origin main',
      'git -C . push',
    ])('denies %s', (cmd) => {
      expect(denied(cmd)).toBe(true);
    });

    it.each([
      'rm junk.txt',
      'ri junk.txt -Force',
      'del notes.txt',
      'cmd /c dir /s',
      'git status',
      'git log --grep=push',
      'sh -c "npm test"',
    ])('leaves %s alone', (cmd) => {
      expect(denied(cmd)).toBe(false);
    });

    it('keeps the launch line under cmd.exe\'s 8191-character limit', () => {
      expect(workerLaunchFlags('bypassPermissions', goalWorkerDenyRules()).length).toBeLessThan(8000);
    });
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

describe('goalWorkerPromptNote — goal terms', () => {
  it('without terms it stays the plain note', () => {
    expect(goalWorkerPromptNote('G-abc123')).not.toContain('Done when');
  });

  it('with terms it lists them and asks for evidence', () => {
    const note = goalWorkerPromptNote('G-abc123', { doneCriteria: ['npm test passes'], evidence: ['vitest output'], constraints: ['no new deps'] });
    expect(note).toContain('Done when: (1) npm test passes');
    expect(note).toContain('Evidence: vitest output');
    expect(note).toContain('Constraints: no new deps');
    expect(note).toMatch(/report the evidence/);
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
