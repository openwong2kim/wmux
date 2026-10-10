// ─── The goal worker profile ────────────────────────────────────────────────
//
// What a fan-out worker started under an approved Moa goal contract
// (shared/moaGoal.ts) runs with, on top of the ordinary fan-out worker flags
// (shared/workerLaunch.ts). Only goal workers get it: fan-outs outside an
// active goal keep the operator's defaults (owner decision, 2026-09-24).
//
// Two parts, and neither is a sandbox:
//
//   1. DENY RULES — extra `--disallowedTools` entries for the commands a goal
//      leaves to the operator (push, PR, release, tag, publish, recursive
//      delete, credential dumps). Claude Code applies deny rules in every
//      permission mode, so they are the worker's first line. They match the
//      command AS WRITTEN. The 2026-10-10 Windows dogfood (claude 2.1.296,
//      bypassPermissions and auto) saw `git push`, `git -C . push`,
//      `cd . && git push`, `gh pr create` and `Remove-Item -Recurse` denied,
//      and `ri <dir> -r -fo`, `cmd /c "rd /s /q <dir>"` and
//      `sh -c "git push"` run past the list; rules for those forms were added
//      after it and are not yet re-run live. Any other wrapper (a script,
//      `env`, `xargs`, `Invoke-Expression`, another alias) still slips past,
//      so for push the disabled push URL below is the real stop and for
//      deletes there is none. An argv-normalising PreToolUse deny hook is the
//      follow-up that closes that.
//
//   2. CREDENTIAL FRICTION — the worker pane's environment:
//        - GH_TOKEN / GITHUB_TOKEN (and the enterprise pair) are set to a
//          placeholder that is not a credential. Agent panes already get no
//          inherited token (envFilter gates *_TOKEN), but `gh` with no token
//          in the environment falls back to the one in the OS keyring; a
//          non-empty placeholder wins over the keyring and fails auth.
//        - GH_CONFIG_DIR points at an empty directory: no stored hosts.yml.
//        - git: `credential.helper` is reset to an empty list through
//          GIT_CONFIG_COUNT (command-line scope, so Git Credential Manager
//          and `gh auth git-credential` are not consulted), `origin` gets a
//          push URL no transport understands (fetch is untouched), and
//          prompts are off (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never,
//          empty GIT_ASKPASS / SSH_ASKPASS).
//      This is friction, not a boundary: the launch is typed into a login
//      shell AFTER its rc files run, so the operator's own rc can re-export a
//      token; an SSH key in an agent, a remote other than `origin` or an
//      explicit URL still reach the network.
//
// A worker CLI that cannot carry the deny rules (agy and codex run
// skip-permissions with no deny list of their own) is not started under a
// goal at all: the fan-out is refused before anything spawns, and the
// renderer refuses again after a role binding has chosen the final launcher.

import { goalTermsLines, type MoaGoalTerms } from './moaGoal';

/** The launchers a goal worker may run on: the ones that honour the deny list. */
export const GOAL_WORKER_LAUNCHERS: readonly string[] = ['claude'];

export function isGoalWorkerLauncher(stem: string): boolean {
  return GOAL_WORKER_LAUNCHERS.includes(stem);
}

/**
 * Commands a goal worker may not run, as Claude Code permission patterns
 * (`*` = any text). Each becomes a `Bash(…)` and a `PowerShell(…)` rule.
 * A trailing `*` with no space also catches the bare command and its
 * arguments; mid-command wildcards use spaces so `git log --grep=push` is not
 * caught by `git * push`.
 */
export const GOAL_WORKER_DENIED_COMMANDS: readonly string[] = [
  // remote
  'git push*',
  'git * push',
  'git * push *',
  'gh pr create*',
  'gh pr merge*',
  'gh pr ready*',
  'gh api*',
  'gh repo create*',
  'gh repo delete*',
  // release
  'git tag*',
  'git * tag *',
  'gh release*',
  'npm publish*',
  'npm version*',
  'npm run release*',
  'pnpm publish*',
  'yarn publish*',
  'yarn npm publish*',
  'cargo publish*',
  'docker push*',
  // destructive
  'rm -rf*',
  'rm -fr*',
  'rm -Rf*',
  'rm -r -f*',
  'rm -f -r*',
  'rm --recursive*',
  'git reset --hard*',
  'git clean -f*',
  'git branch -D*',
  'Remove-Item * -Recurse*',
  'Remove-Item -Recurse*',
  'rmdir /s*',
  'rd /s*',
  // Remove-Item under its aliases and with -Recurse abbreviated, which
  // PowerShell accepts down to `-r` (`ri .\dir -r -fo` deleted a directory in
  // the 2026-10-10 dogfood). Both cases of the dash word: a rule is matched
  // as written. `rm -r*` also covers Bash's `rm -r`, `rm -R` and `rm -rf`.
  ...['Remove-Item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase'].flatMap((v) => [
    `${v} -r*`,
    `${v} -R*`,
    `${v} * -r*`,
    `${v} * -R*`,
  ]),
  // cmd's own recursive deletes run through `cmd /c "…"` (also `cmd.exe`):
  // the leading `*` takes the `/c` and the quote.
  ...['rd', 'rmdir', 'del', 'erase'].flatMap((v) => [`cmd*${v} */s*`, `cmd*${v} */S*`]),
  // A push wrapped in a shell's -c (`sh -c "git push"` in the dogfood; the
  // disabled push URL stopped it). Any other wrapper still slips past.
  'sh -c*git*push*',
  'bash -c*git*push*',
  // credentials
  'gh auth token*',
  'git credential*',
];

/** The tool rules for {@link GOAL_WORKER_DENIED_COMMANDS}: Bash and PowerShell. */
export function goalWorkerDenyRules(): string[] {
  const out: string[] = [];
  for (const c of GOAL_WORKER_DENIED_COMMANDS) {
    out.push(`Bash(${c})`, `PowerShell(${c})`);
  }
  return out;
}

/** Not a credential: what gh and git see as the token in a goal worker. */
export const GOAL_WORKER_TOKEN_PLACEHOLDER = 'wmux-goal-worker-no-github-credentials';

/** A push URL no git transport understands: `git push origin` fails before
 *  any network, `git fetch origin` keeps the real URL. */
export const GOAL_WORKER_PUSH_URL = 'wmux-goal-push-disabled://ask-the-operator';

/**
 * The goal worker's environment overlay. `emptyGhConfigDir` must exist and
 * be empty. Pane env only — the worktree setup hook keeps the plain task env.
 */
export function goalWorkerEnv(emptyGhConfigDir: string): Record<string, string> {
  return {
    GH_TOKEN: GOAL_WORKER_TOKEN_PLACEHOLDER,
    GITHUB_TOKEN: GOAL_WORKER_TOKEN_PLACEHOLDER,
    GH_ENTERPRISE_TOKEN: GOAL_WORKER_TOKEN_PLACEHOLDER,
    GITHUB_ENTERPRISE_TOKEN: GOAL_WORKER_TOKEN_PLACEHOLDER,
    GH_CONFIG_DIR: emptyGhConfigDir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    // An empty value resets git's credential.helper list (git 2.31+ reads
    // GIT_CONFIG_* as command-line config, after system and global).
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_1: GOAL_WORKER_PUSH_URL,
  };
}

/**
 * Why a fan-out from the HQ under an active goal is refused, or null. Pure:
 * fanout.rpc.ts passes what it read once for this call. Every refusal happens
 * before the goal's budget is reserved and before anything is asked or spawned.
 */
export function goalFanoutRefusal(args: {
  goalId: string;
  repoRoot: string | null;
  /** The mode the operator saw on the card (absent: an old record). */
  pinnedMode: string | undefined;
  /** The fan-out worker permission mode Settings holds now. */
  currentMode: string;
  /** false = the preset chose output folders instead of worktrees. */
  worktree: boolean;
  /** The CLI each task asked for (preset rows / `agents`); empty = default. */
  agents: ReadonlyArray<{ agent: string }>;
  /** The HQ's current turn was woken by another PC's Moa. */
  remoteWoken: boolean;
}): string | null {
  const g = `goal ${args.goalId}`;
  if (args.remoteWoken) {
    return `this turn was woken by another PC's Moa, and ${g} does not fan out work a remote Moa sent. Answer it, or ask the operator with deck_ask_decision.`;
  }
  if (!args.repoRoot) {
    return `${g} names no repository, so it cannot fan out. Hand work to its workspaces with moa_propose_handoff instead.`;
  }
  if (!args.worktree) {
    return `under ${g} a fan-out runs in git worktrees; this preset uses output folders.`;
  }
  const other = args.agents.findIndex((a) => !isGoalWorkerLauncher(a.agent));
  if (other >= 0) {
    return `under ${g} workers run only on claude (task ${other + 1} asks for ${args.agents[other].agent}): agy and codex workers skip permissions and take no deny rules.`;
  }
  if (!args.pinnedMode) {
    return `${g} has no pinned worker permission mode; end it and propose it again.`;
  }
  if (args.pinnedMode !== args.currentMode) {
    return `the fan-out worker permission mode is ${args.currentMode} now, but ${g} was approved with ${args.pinnedMode}. Ask the operator to set it back, or end the goal and propose a new one.`;
  }
  return null;
}

/** The note appended to a goal worker's prompt, so the refusals it meets are
 *  not a surprise and its report says what is left for the operator. */
export function goalWorkerPromptNote(goalId: string, terms?: MoaGoalTerms): string {
  const t = terms ? `\n\n${goalTermsLines(terms).join('\n')}\nVerify your part against these and report the evidence (commands run, their results, logs or screenshots) with what is ready.` : '';
  return `\n\n---\n\nThis task runs under Moa goal ${goalId}, which the operator approved. Push, pull requests, tags, releases, publishing and deleting data stay with the operator: commands for them are denied in this session and GitHub credentials are withheld. Commit on your branch, report what is ready, and leave those steps to the operator.${t}`;
}
