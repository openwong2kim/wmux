// ─── Per-agent launch option grammar (verified entries only) ─────────────────
//
// Neutral launch options a role binding can turn on, mapped to each agent
// CLI's own spelling. Sibling of MODEL_FLAG_BY_LAUNCHER (orchestratorRole):
// an agent or option missing here is simply not offered — never guessed.
//
// Verified 2026-09-30:
//   claude 2.1.285  `--effort <level>` runs (modelUsage reported);
//                   `--dangerously-skip-permissions` listed in --help.
//   codex 0.159.2   `codex -c model_reasoning_effort=high exec …` prints
//                   "reasoning effort: high" over a config default of low;
//                   `--dangerously-bypass-approvals-and-sandbox` in --help.
//   agy 1.2.x       `--dangerously-skip-permissions` in --help. Effort is part
//                   of the model id (`gemini-3.8-flash-low`); wmux never emits
//                   agy's own `--effort`, so the two can never disagree.
//
// Verified 2026-10-01 (permission choices, #1681):
//   claude 2.1.285  `--permission-mode <mode>` in --help (acceptEdits, auto,
//                   bypassPermissions, manual, dontAsk, plan).
//   codex 0.158.0   `-a, --ask-for-approval <policy>`, `-s, --sandbox <mode>`
//                   and `--approve-for-me` in --help; `-a never`, `-anever`,
//                   `--ask-for-approval=never` and `--sandbox=read-only` all
//                   parse. `--full-auto` is rejected ("unexpected argument"),
//                   so it is not listed.

export interface AgentLaunchGrammar {
  /** Tokens that set the effort, or absent when effort is not a flag. */
  effortFlag?: (effort: string) => string[];
  /** Does this token already set the effort? (a manual flag wins) */
  hasEffort?: (token: string) => boolean;
  /** The agent's own skip-all-permission-prompts flag. */
  skipPermissionsFlag?: string;
  /** Other spellings that already mean "skip permissions" on this CLI. */
  skipPermissionsAliases?: readonly string[];
  /** Flags that make a permission choice of their own (a mode, an approval
   *  policy, a sandbox). Typed on a launch line, they are the user's explicit
   *  choice and win over a role's skip permissions. */
  permissionFlags?: readonly string[];
  /** Effort is encoded in the model id suffix (agy). */
  effortInModelId?: boolean;
}

export const LAUNCH_GRAMMAR_BY_AGENT: Readonly<Record<string, AgentLaunchGrammar>> = {
  claude: {
    effortFlag: (e) => ['--effort', e],
    hasEffort: (t) => t === '--effort' || t.startsWith('--effort='),
    // No alias: `--allow-dangerously-skip-permissions` only makes bypass
    // available as an option (claude --help), it does not switch it on.
    skipPermissionsFlag: '--dangerously-skip-permissions',
    permissionFlags: ['--permission-mode'],
  },
  codex: {
    effortFlag: (e) => ['-c', `model_reasoning_effort=${e}`],
    hasEffort: (t) => t.includes('model_reasoning_effort'),
    skipPermissionsFlag: '--dangerously-bypass-approvals-and-sandbox',
    skipPermissionsAliases: ['--yolo'],
    permissionFlags: ['-a', '--ask-for-approval', '-s', '--sandbox', '--approve-for-me'],
  },
  agy: {
    skipPermissionsFlag: '--dangerously-skip-permissions',
    effortInModelId: true,
  },
};

// hasOwnProperty, not Object.hasOwn: orchestratorRole imports this file and is
// compiled into the MCP bundle, whose tsconfig targets ES2020.
export function launchGrammarFor(agent: string | undefined): AgentLaunchGrammar | undefined {
  return agent && Object.prototype.hasOwnProperty.call(LAUNCH_GRAMMAR_BY_AGENT, agent)
    ? LAUNCH_GRAMMAR_BY_AGENT[agent]
    : undefined;
}

/** Is this argument one of the agent's skip-permissions spellings? */
export function isSkipPermissionsToken(grammar: AgentLaunchGrammar, value: string): boolean {
  if (!grammar.skipPermissionsFlag) return false;
  return value === grammar.skipPermissionsFlag || (grammar.skipPermissionsAliases ?? []).indexOf(value) !== -1;
}

/**
 * Does this argument make a permission choice (see
 * {@link AgentLaunchGrammar.permissionFlags})?
 *
 * Decided on the value alone, like the model flag: `--permission-mode plan`,
 * `--permission-mode=plan`, and clap's attached short form `-anever`. A value
 * with whitespace is a sentence inside a quoted prompt, never a flag.
 */
export function isPermissionFlagToken(grammar: AgentLaunchGrammar, value: string): boolean {
  if (!grammar.permissionFlags || /\s/.test(value)) return false;
  return grammar.permissionFlags.some((flag) => {
    if (value === flag || value.startsWith(`${flag}=`)) return true;
    const shortFlag = flag.length === 2 && flag[0] === '-' && flag[1] !== '-';
    return shortFlag && value.length > 2 && value.startsWith(flag);
  });
}

/** Effort levels that are safe as a single CLI token. */
export const EFFORT_TOKEN_RE = /^[a-z]{1,16}$/;
