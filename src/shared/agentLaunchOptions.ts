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
//                   so it is not listed. The same choices made through config
//                   — `-c approval_policy=…` / `-c sandbox_mode=…` — reach the
//                   config in every spelling clap takes: `-c k=v`, `-c=k=v`,
//                   `-ck=v`, `--config k=v`, `--config=k=v` (a bogus value in
//                   each one fails with "unknown variant … in `approval_policy`").

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
   *  policy, a sandbox) and take a value. Typed on a launch line, they are the
   *  user's explicit choice and win over a role's skip permissions. */
  permissionFlags?: readonly string[];
  /** Permission choices that take no value (codex `--approve-for-me`). */
  permissionSwitches?: readonly string[];
  /** Permission choices made through a config override: `flags` set a
   *  `key=value`, and a key in `keys` is a permission choice. */
  permissionConfig?: { flags: readonly string[]; keys: readonly string[] };
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
    permissionFlags: ['-a', '--ask-for-approval', '-s', '--sandbox'],
    permissionSwitches: ['--approve-for-me'],
    permissionConfig: { flags: ['-c', '--config'], keys: ['approval_policy', 'sandbox_mode'] },
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

/** `-a` style: a single dash and one letter, which clap also takes glued to
 *  its value (`-anever`). */
function isShortFlag(flag: string): boolean {
  return flag.length === 2 && flag[0] === '-' && flag[1] !== '-';
}

/** The value `value` gives `flag` inline (`--flag=v`, `-fv`, `-f=v`), `''`
 *  when it IS the bare flag (its value is the next argument), or undefined when
 *  it is not this flag at all. */
function inlineValue(flag: string, value: string): string | undefined {
  if (value === flag) return '';
  if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
  if (isShortFlag(flag) && value.length > 2 && value.startsWith(flag)) return value.slice(2);
  return undefined;
}

/**
 * Which of these arguments make a permission choice (see
 * {@link AgentLaunchGrammar.permissionFlags}, `permissionSwitches` and
 * `permissionConfig`)? Returns the indexes of every argument that belongs to
 * one: the flag, and its value when that is the next argument
 * (`--permission-mode plan` is two, `--permission-mode=plan` one,
 * `-c approval_policy=never` two, `-capproval_policy=never` one).
 *
 * Decided on the values alone, like the model flag. A value with whitespace is
 * a sentence inside a quoted prompt, never a flag; a next argument that starts
 * with `-` is another flag, not this one's value.
 */
export function permissionChoiceIndexes(grammar: AgentLaunchGrammar, values: readonly string[]): number[] {
  const out: number[] = [];
  const isConfigKey = (kv: string): boolean => {
    const eq = kv.indexOf('=');
    return eq > 0 && !!grammar.permissionConfig && grammar.permissionConfig.keys.indexOf(kv.slice(0, eq).trim()) !== -1;
  };
  const nextValue = (i: number): string | undefined => {
    const next = values[i + 1];
    return next !== undefined && !next.startsWith('-') ? next : undefined;
  };
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (/\s/.test(value)) continue;
    if ((grammar.permissionSwitches ?? []).indexOf(value) !== -1) {
      out.push(i);
      continue;
    }
    let matched = false;
    for (const flag of grammar.permissionFlags ?? []) {
      const inline = inlineValue(flag, value);
      if (inline === undefined) continue;
      out.push(i);
      if (inline === '' && nextValue(i) !== undefined) out.push(++i);
      matched = true;
      break;
    }
    if (matched) continue;
    for (const flag of grammar.permissionConfig?.flags ?? []) {
      const inline = inlineValue(flag, value);
      if (inline === undefined) continue;
      if (inline !== '') {
        if (isConfigKey(inline)) out.push(i);
      } else {
        const next = nextValue(i);
        if (next !== undefined && isConfigKey(next)) out.push(i, ++i);
      }
      break;
    }
  }
  return out;
}

/** Does any of these arguments make a permission choice? */
export function hasPermissionChoice(grammar: AgentLaunchGrammar, values: readonly string[]): boolean {
  return permissionChoiceIndexes(grammar, values).length > 0;
}

/** Effort levels that are safe as a single CLI token. */
export const EFFORT_TOKEN_RE = /^[a-z]{1,16}$/;
