// ─── Bot commands — the deterministic allowlist ────────────────────────────
//
// After the floor (botCommandFloor.ts), a command line runs only when every
// command in it is on the bot's list: the built-in read-only set below, or
// a rule the owner saved for this bot (botCommandRules.ts). The list is
// matched on parsed words, never on the raw text:
//   - a built-in command is named bare (`ls`, never `./ls` or `/bin/ls`, which
//     could be a file the bot wrote) and its arguments pass that command's
//     check (no option that writes a file, runs a program or changes state);
//   - an owner rule matches when the command's words start with the rule's
//     words, and either match them exactly or the rule takes any arguments;
//   - in a pipeline, each command after the first is a stdin filter from
//     STDIN_FILTERS, named bare, with no input redirection.
// A built-in command (or a pipe filter) whose own check refuses its
// arguments is refused as `floor`: the reviewer never overturns a check.
// Only a line whose every command is listed, or not a built-in at all, gets
// further: a command not on the list makes it `unlisted`, with the line as
// it would run and its words, for the reviewer (botCommandReviewer.ts).

import { commandFloor, commandLineToRun, normalizeCommand, parseCommandLine, type FloorContext, type SimpleCommand } from './botCommandFloor';

/** One owner rule: the command's leading words, and whether more may follow. */
export interface BotCommandRule {
  argv: string[];
  anyArgs?: boolean;
}

type ArgCheck = (args: readonly string[]) => string | null;

const anyArgs: ArgCheck = () => null;

/** The operands of `args`: words that are not options (`valued` options
 *  take the next word as their value). */
function operands(args: readonly string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return [...out, ...args.slice(k + 1)];
    if (a.startsWith('-') && a !== '-') {
      if (valued.has(a)) k++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Whether option word `a` is one of the refused options in any form:
 *  a short letter anywhere in a short-option word (`-o`, `-oFILE`, `-uo`),
 *  or a long option or any prefix of one the program would accept as its
 *  abbreviation (`--output`, `--output=FILE`, `--out`). Errs to refusing. */
export function hitsOption(a: string, refused: { short?: string; long?: readonly string[] }): boolean {
  if (a.startsWith('--')) {
    const name = a.slice(2).split('=')[0];
    return name.length > 0 && (refused.long ?? []).some((l) => l.startsWith(name));
  }
  return a.length > 1 && a.startsWith('-') && [...a.slice(1)].some((ch) => (refused.short ?? '').includes(ch));
}

/** Options that write a file or run a program, refused in every form. */
function refuseOptions(name: string, refused: { short?: string; long?: readonly string[] }): ArgCheck {
  return (args) => {
    for (const a of args) {
      if (a === '--') return null;
      if (hitsOption(a, refused)) return `${name} ${a} is not on the built-in list`;
    }
    return null;
  };
}

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'show', 'branch']);

/** `git branch` that only lists: listing options, and names only after --list. */
const GIT_BRANCH_LIST_OPTIONS = /^(-a|-r|-v|-vv|-l|--all|--remotes|--verbose|--list|--show-current|--no-color|--color(=.*)?|--column(=.*)?|--no-column|--sort=.*|--format=.*|--contains(=.*)?|--no-contains(=.*)?|--merged(=.*)?|--no-merged(=.*)?|--points-at=.*|--abbrev=.*|--no-abbrev|-i|--ignore-case|--omit-empty)$/;

function gitCheck(args: readonly string[]): string | null {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    const a = args[k];
    if (a === '-C') {
      if (args[k + 1] === undefined) return 'git -C needs a folder';
      k += 2;
      continue;
    }
    if (a === '--no-pager') {
      k++;
      continue;
    }
    return `git ${a} is not on the built-in list`;
  }
  const sub = args[k];
  if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return `git ${sub ?? ''} is not on the built-in list`.trim();
  const rest = args.slice(k + 1);
  for (const a of rest) {
    if (a === '--') break;
    if (hitsOption(a, { long: ['output', 'ext-diff', 'textconv'] })) return `git ${sub} ${a} is not on the built-in list`;
  }
  if (sub === 'branch') {
    const listing = rest.some((a) => a === '--list' || a === '-l');
    for (const a of rest) {
      if (a.startsWith('-')) {
        if (!GIT_BRANCH_LIST_OPTIONS.test(a)) return `git branch ${a} is not on the built-in list`;
      } else if (!listing) {
        return 'git branch with a name creates a branch';
      }
    }
  }
  return null;
}

/** The built-in read-only commands and their argument checks. */
export const BUILTIN_COMMANDS: ReadonlyMap<string, ArgCheck> = new Map<string, ArgCheck>([
  ['ls', anyArgs],
  ['cat', anyArgs],
  ['head', anyArgs],
  ['tail', anyArgs],
  ['wc', anyArgs],
  ['cut', anyArgs],
  ['tr', anyArgs],
  ['stat', anyArgs],
  ['du', anyArgs],
  ['df', anyArgs],
  ['pwd', anyArgs],
  ['echo', anyArgs],
  ['which', anyArgs],
  ['grep', anyArgs],
  ['egrep', anyArgs],
  ['fgrep', anyArgs],
  // The floor already refuses -exec, -execdir, -ok, -delete and -fprint*.
  ['find', anyArgs],
  ['file', refuseOptions('file', { short: 'C', long: ['compile'] })],
  ['date', refuseOptions('date', { short: 's', long: ['set'] })],
  ['sort', refuseOptions('sort', { short: 'oT', long: ['output', 'compress-program', 'temporary-directory'] })],
  ['uniq', (args) => (operands(args, new Set(['-f', '-s', '-w'])).length > 1 ? 'uniq with an output file is not on the built-in list' : null)],
  ['rg', refuseOptions('rg', { long: ['pre', 'pre-glob', 'hostname-bin'] })],
  ['git', gitCheck],
]);

/** Commands that may read a pipe's output (`... | sort | head -5`). */
export const STDIN_FILTERS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'grep', 'egrep', 'fgrep', 'rg']);

function builtinRefusal(cmd: SimpleCommand): string | null {
  const name = cmd.argv[0];
  const check = BUILTIN_COMMANDS.get(name);
  if (!check) return `${name} is not on the built-in list`;
  return check(cmd.argv.slice(1));
}

/** Whether an owner rule matches the command's words. Pure. */
export function ruleMatches(rule: BotCommandRule, argv: readonly string[]): boolean {
  if (rule.argv.length === 0 || argv.length < rule.argv.length) return false;
  if (!rule.argv.every((w, k) => argv[k] === w)) return false;
  return rule.anyArgs === true || argv.length === rule.argv.length;
}

/** A known pipe filter's refusal of its arguments or input, or null. */
function filterRefusal(cmd: SimpleCommand): string | null {
  const name = cmd.argv[0];
  if (cmd.redirects.some((r) => r.op === '<' || r.op === '<&')) return `${name} after a pipe reads the pipe, not a file`;
  return builtinRefusal(cmd);
}

export type CommandDecision =
  /** `run`: the line as it runs (commandLineToRun). */
  | { ok: true; layer: 'allowlist'; command: string; run: string; matched: 'builtin' | 'rule' }
  | { ok: false; layer: 'parse' | 'floor'; command: string; reason: string }
  /** Past the floor but not on the list: `run` is the line as it would run,
   *  `argv` each command's words, and `offList` the words of the commands
   *  neither the built-in list nor an owner rule allowed, for the reviewer. */
  | { ok: false; layer: 'unlisted'; command: string; reason: string; run: string; argv: string[][]; offList: string[][] };

/**
 * Main's decision on one Bash command line of a bot: parse, the floor, then
 * the list. Pure apart from the floor's path checks. `unlisted` is the one
 * branch the reviewer may take up (botExec.ts reviewUnlistedCommand); on
 * its own it is a refusal.
 */
export function decideBotCommand(line: unknown, ctx: FloorContext & { rules: readonly BotCommandRule[] }): CommandDecision {
  const parsed = parseCommandLine(line);
  const raw = typeof line === 'string' ? line.slice(0, 200) : '';
  if (!parsed.ok) return { ok: false, layer: 'parse', command: raw, reason: parsed.reason };
  const command = normalizeCommand(parsed.pipelines, parsed.joins);
  const floor = commandFloor(parsed.pipelines, ctx);
  if (floor) return { ok: false, layer: 'floor', command, reason: floor };
  const offListCommands: string[][] = [];
  const unlisted = (reason: string): CommandDecision => ({
    ok: false, layer: 'unlisted', command, reason,
    run: commandLineToRun(parsed.pipelines, parsed.joins),
    argv: parsed.pipelines.flatMap((p) => p.map((c) => [...c.argv])),
    offList: offListCommands,
  });
  // The whole line is read first: a refused built-in anywhere in it is the
  // floor's, even after a command that is merely not on the list.
  let viaRule = false;
  let offList: string | null = null;
  for (const p of parsed.pipelines) {
    for (let k = 0; k < p.length; k++) {
      const cmd = p[k];
      const name = cmd.argv[0];
      if (k > 0) {
        if (STDIN_FILTERS.has(name)) {
          const r = filterRefusal(cmd);
          if (r) return { ok: false, layer: 'floor', command, reason: r };
          continue;
        }
        if (BUILTIN_COMMANDS.has(name)) {
          const r = builtinRefusal(cmd);
          if (r) return { ok: false, layer: 'floor', command, reason: r };
        }
        offList ??= `${name} cannot read a pipe here (only ${[...STDIN_FILTERS].join(', ')})`;
        offListCommands.push([...cmd.argv]);
        continue;
      }
      if (ctx.rules.some((rule) => ruleMatches(rule, cmd.argv))) {
        viaRule = true;
        continue;
      }
      if (!BUILTIN_COMMANDS.has(name)) {
        offList ??= `${name} is not on the built-in list`;
        offListCommands.push([...cmd.argv]);
        continue;
      }
      const r = builtinRefusal(cmd);
      if (r) return { ok: false, layer: 'floor', command, reason: r };
    }
  }
  if (offList) return unlisted(offList);
  return { ok: true, layer: 'allowlist', command, run: commandLineToRun(parsed.pipelines, parsed.joins), matched: viaRule ? 'rule' : 'builtin' };
}
