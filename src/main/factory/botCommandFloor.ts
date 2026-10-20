// ─── Bot commands — the parser and the hard floor ──────────────────────────
//
// A bot runs a shell command only after main has read it (botExec.ts). This
// module turns the command line into words the way the shell would see them
// and refuses, before any allowlist is consulted, everything that hides what
// runs or reaches past the bot's own folder. It is deliberately small and
// strict: anything it cannot read with certainty is refused.
//
// The parser takes one line of simple commands joined by `|`, `&&`, `||` and
// `;`, with single and double quotes and backslash escapes, and redirections
// (`>`, `>>`, `<`, `2>&1`). It refuses outright: a newline, a backtick, any
// `$` outside single quotes (variable, command and arithmetic expansion),
// here-documents and here-strings, process substitution, subshells and
// brace groups, background `&`, and comments. Outside quotes a word holds
// only literal characters (letters, digits and `_ . / : @ % + , = -`, no `=`
// first): a glob, brace, tilde or any other character the shell (bash or
// zsh, with whatever options the owner's shell snapshot sets) could expand
// must be quoted, so the words checked are the words that run.
//
// The floor (`commandFloor`) then refuses, whatever the owner allowed:
// environment assignments; commands that run, wrap or re-read other
// commands (eval, exec, source, xargs, env, sudo, ...); interpreters given
// inline code or reading code from stdin, and a pipe into any shell or
// interpreter; `find` actions that run or delete; git configuration, push,
// history rewrites and transport helpers; recursive or forced `rm`;
// permission changes; remote shells; the wmux CLI; and output redirected to
// a path outside the bot's folder (botFolderPath.ts).

import fs from 'node:fs';
import path from 'node:path';
import { checkBotFolderPath, type BotFolderDeps } from './botFolderPath';

export interface Redirect {
  /** `>`, `>>`, `>|`, `&>`, `&>>`, `<`, or a descriptor copy `>&` / `<&`. */
  op: string;
  /** The redirected descriptor when one was written (`2>`). */
  fd?: number;
  /** The target word, quotes removed. */
  target: string;
}

export interface SimpleCommand {
  /** `NAME=value` words before the command name. */
  assignments: string[];
  argv: string[];
  redirects: Redirect[];
}

/** One pipeline: its commands, left to right. */
export type Pipeline = SimpleCommand[];

/** `pipelines` joined by `joins` (`&&`, `||` or `;`; one fewer than pipelines). */
export type ParseResult = { ok: true; pipelines: Pipeline[]; joins: string[] } | { ok: false; reason: string };

type Token =
  | { kind: 'word'; value: string; quoted: boolean; assignment: boolean; glued: boolean }
  | { kind: 'op'; op: string };

const MAX_COMMAND_LENGTH = 8_000;

/** Characters a word may hold outside quotes: none of them expands. */
const LITERAL_UNQUOTED = /^[A-Za-z0-9_./:@%+,=-]$/;

function tokenize(line: string): { ok: true; tokens: Token[] } | { ok: false; reason: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '|' || c === '&' || c === ';') {
      const two = line.slice(i, i + 2);
      if (two === '||' || two === '&&') {
        tokens.push({ kind: 'op', op: two });
        i += 2;
        continue;
      }
      if (two === '&>') {
        const three = line.slice(i, i + 3);
        tokens.push({ kind: 'op', op: three === '&>>' ? '&>>' : '&>' });
        i += three === '&>>' ? 3 : 2;
        continue;
      }
      if (c === '&') return { ok: false, reason: 'background commands (&) are not run' };
      if (two === ';;' || two === '|&') return { ok: false, reason: `"${two}" is not supported` };
      tokens.push({ kind: 'op', op: c });
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      const rest = line.slice(i);
      if (rest.startsWith('<<')) return { ok: false, reason: 'here-documents and here-strings are not run' };
      if (rest.startsWith('<(') || rest.startsWith('>(')) return { ok: false, reason: 'process substitution is not run' };
      if (rest.startsWith('<>')) return { ok: false, reason: 'read-write redirection is not supported' };
      const op = rest.startsWith('>>') ? '>>' : rest.startsWith('>|') ? '>|' : rest.startsWith('>&') ? '>&' : rest.startsWith('<&') ? '<&' : c;
      tokens.push({ kind: 'op', op });
      i += op.length;
      continue;
    }
    if (c === '(' || c === ')') return { ok: false, reason: 'subshells are not run' };
    if (c === '#') return { ok: false, reason: 'comments are not supported' };
    // A word: runs until unquoted whitespace or an operator character.
    let value = '';
    let quoted = false;
    let unquotedPrefix = '';
    let sawQuote = false;
    while (i < n) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';' || ch === '<' || ch === '>' || ch === '(' || ch === ')') break;
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) return { ok: false, reason: 'an unterminated quote' };
        value += line.slice(i + 1, end);
        quoted = true;
        sawQuote = true;
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const d = line[i];
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === '$' || d === '`') return { ok: false, reason: 'variables and command substitution are not run' };
          if (d === '\\' && i + 1 < n && '"\\'.includes(line[i + 1])) {
            value += line[i + 1];
            i += 2;
            continue;
          }
          value += d;
          i++;
        }
        if (!closed) return { ok: false, reason: 'an unterminated quote' };
        quoted = true;
        sawQuote = true;
        continue;
      }
      if (ch === '\\') {
        if (i + 1 >= n) return { ok: false, reason: 'a trailing backslash' };
        value += line[i + 1];
        quoted = true;
        sawQuote = true;
        i += 2;
        continue;
      }
      if (ch === '$' || ch === '`') return { ok: false, reason: 'variables and command substitution are not run' };
      if (!LITERAL_UNQUOTED.test(ch) || (ch === '=' && value === '' && !sawQuote)) {
        return { ok: false, reason: `an unquoted "${ch}" may expand (globs, braces, ~ and the like are not run; quote the word)` };
      }
      if (!sawQuote) unquotedPrefix += ch;
      value += ch;
      i++;
    }
    tokens.push({
      kind: 'word', value, quoted,
      assignment: /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(unquotedPrefix),
      // Written right against a redirection (`2>`): a descriptor number.
      glued: i < n && (line[i] === '<' || line[i] === '>'),
    });
  }
  return { ok: true, tokens };
}

/**
 * Parse one command line. Pure; refuses (ok: false) anything outside the
 * small grammar above, so a caller never acts on a line it misread.
 */
export function parseCommandLine(line: unknown): ParseResult {
  if (typeof line !== 'string' || line.trim() === '') return { ok: false, reason: 'an empty command' };
  if (line.length > MAX_COMMAND_LENGTH) return { ok: false, reason: 'the command is too long' };
  if (/[\r\n\0]/.test(line)) return { ok: false, reason: 'multi-line commands are not run' };
  if (line.includes('`')) return { ok: false, reason: 'variables and command substitution are not run' };
  const t = tokenize(line);
  if (!t.ok) return t;
  const pipelines: Pipeline[] = [];
  const joins: string[] = [];
  let pipeline: Pipeline = [];
  let cmd: SimpleCommand = { assignments: [], argv: [], redirects: [] };
  const closeCommand = (): boolean => {
    if (cmd.argv.length === 0 && cmd.assignments.length === 0 && cmd.redirects.length === 0) return false;
    pipeline.push(cmd);
    cmd = { assignments: [], argv: [], redirects: [] };
    return true;
  };
  const toks = t.tokens;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.kind === 'word') {
      // A word of digits glued to a redirection names its descriptor (2>).
      const next = toks[k + 1];
      if (!tok.quoted && tok.glued && /^\d$/.test(tok.value) && next?.kind === 'op' && /^(>|>>|>\||>&|<|<&)$/.test(next.op)) {
        const target = toks[k + 2];
        if (target?.kind !== 'word') return { ok: false, reason: 'a redirection without a target' };
        cmd.redirects.push({ op: next.op, fd: Number(tok.value), target: target.value });
        k += 2;
        continue;
      }
      if (cmd.argv.length === 0 && tok.assignment) cmd.assignments.push(tok.value);
      else cmd.argv.push(tok.value);
      continue;
    }
    if (['>', '>>', '>|', '>&', '<', '<&', '&>', '&>>'].includes(tok.op)) {
      const target = toks[k + 1];
      if (target?.kind !== 'word') return { ok: false, reason: 'a redirection without a target' };
      cmd.redirects.push({ op: tok.op, target: target.value });
      k++;
      continue;
    }
    if (!closeCommand()) return { ok: false, reason: `"${tok.op}" without a command before it` };
    if (tok.op !== '|') {
      pipelines.push(pipeline);
      pipeline = [];
      if (k < toks.length - 1) joins.push(tok.op);
    }
    if (k === toks.length - 1 && tok.op !== ';') return { ok: false, reason: `"${tok.op}" without a command after it` };
  }
  if (!closeCommand() && pipeline.length > 0) return { ok: false, reason: 'a pipe without a command after it' };
  if (pipeline.length > 0) pipelines.push(pipeline);
  if (pipelines.length === 0) return { ok: false, reason: 'an empty command' };
  return { ok: true, pipelines, joins };
}

/** A command name as the floor compares it: the last path segment, lower case. */
export function commandName(argv0: string): string {
  return path.posix.basename(argv0.replace(/\\/g, '/')).toLowerCase();
}

/** Commands that run, wrap or re-read other commands, change who runs them
 *  or how the shell behaves, reach another machine, or are wmux itself. */
const FLOOR_COMMANDS: ReadonlySet<string> = new Set([
  'eval', 'exec', 'source', '.', 'xargs', 'env', 'printenv', 'sudo', 'su', 'doas', 'pkexec', 'runuser',
  'chmod', 'chown', 'chgrp', 'chflags', 'xattr', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'ncat', 'socat',
  'wmux', 'osascript', 'open', 'security', 'launchctl', 'crontab', 'at', 'batch',
  'cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'unset', 'alias', 'unalias',
  'builtin', 'command', 'trap', 'enable', 'hash', 'shopt', 'ulimit', 'umask', 'fc', 'history',
  'nohup', 'nice', 'renice', 'timeout', 'gtimeout', 'time', 'stdbuf', 'watch', 'script', 'caffeinate', 'chroot',
  'unbuffer', 'parallel', 'strace', 'dtruss', 'ltrace', 'gdb', 'lldb',
  'kill', 'pkill', 'killall',
  'awk', 'gawk', 'nawk', 'mawk',
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx',
]);

/** Shells: inline code with `-c`, a script from stdin with `-s` or none. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'pwsh', 'powershell']);

/** Interpreters and the short options that take inline code. */
const INTERPRETER_INLINE: ReadonlyArray<{ match: (name: string) => boolean; letters: string; long: readonly string[] }> = [
  { match: (n) => SHELLS.has(n), letters: 'cs', long: ['--command', '--init-command'] },
  { match: (n) => /^python[0-9.]*$/.test(n) || n === 'pypy' || n === 'pypy3', letters: 'c', long: [] },
  { match: (n) => ['node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx'].includes(n), letters: 'ep', long: ['--eval', '--print'] },
  { match: (n) => n === 'perl', letters: 'eE', long: [] },
  { match: (n) => n === 'ruby' || n === 'irb', letters: 'e', long: [] },
  { match: (n) => n === 'php', letters: 'ra', long: ['--run'] },
  { match: (n) => n === 'lua' || n === 'luajit', letters: 'e', long: [] },
  { match: (n) => n === 'rscript', letters: 'e', long: [] },
  { match: (n) => n === 'tclsh' || n === 'wish' || n === 'expect', letters: 'c', long: [] },
];

function interpreterOf(name: string): (typeof INTERPRETER_INLINE)[number] | null {
  return INTERPRETER_INLINE.find((f) => f.match(name)) ?? null;
}

/** Whether `name` is a shell or an interpreter (a pipe into one runs its input). */
export function isShellOrInterpreter(name: string): boolean {
  return interpreterOf(name) !== null;
}

/** Whether an option word of `family` may carry inline code: a long form
 *  (or its `=` value), or a short option word holding an inline-code
 *  letter anywhere, attached value included (`-c"code"`, `-Bc`). Errs to
 *  refusing. Pure. */
function inlineCodeOption(family: (typeof INTERPRETER_INLINE)[number], a: string): boolean {
  if (a.startsWith('--')) return family.long.some((l) => a === l || a.startsWith(`${l}=`));
  return a.length > 1 && a.startsWith('-') && [...a.slice(1)].some((ch) => family.letters.includes(ch));
}

function interpreterRefusal(name: string, args: readonly string[]): string | null {
  const family = interpreterOf(name);
  if (!family) return null;
  let operand = false;
  for (const a of args) {
    if (a === '-') return `${name} reading code from stdin is not run`;
    if (inlineCodeOption(family, a)) return `${name} with inline code is not run`;
    if (!a.startsWith('-')) {
      operand = true;
      break;
    }
  }
  if (name === 'deno' && args[0] === 'eval') return `${name} with inline code is not run`;
  if (!operand) return `${name} without a script file reads code from stdin, which is not run`;
  return null;
}

const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

const GIT_FLOOR_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'config', 'push', 'rebase', 'reset', 'filter-branch', 'filter-repo', 'replace', 'update-ref', 'reflog', 'gc', 'prune',
  'credential', 'credential-store', 'credential-cache', 'daemon', 'submodule', 'hook',
]);

/** Whether `dir` (relative to the bot folder) is the bot folder itself or
 *  the bot's repository itself, by text and with symlinks followed — never
 *  a folder inside them, where the bot could have built a repository with
 *  its own config. A missing folder, or one named with `..`, is not. */
function gitDirAllowed(dir: string, ctx: FloorContext): boolean {
  if (dir.split(/[\\/]+/).includes('..')) return false;
  const realpath = ctx.fs?.realpath ?? ((p: string) => fs.realpathSync.native(p));
  const same = (root: string, target: string): boolean => path.relative(root, target) === '';
  const target = path.resolve(ctx.botDir, dir);
  let real: string;
  try {
    real = realpath(target);
  } catch {
    return false;
  }
  return [ctx.botDir, ctx.repoRoot].some((root) => {
    if (!root || !same(root, target)) return false;
    try {
      return same(realpath(root), real);
    } catch {
      return false;
    }
  });
}

function gitRefusal(args: readonly string[], ctx: FloorContext): string | null {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    const a = args[k];
    if (a === '-c' || a.startsWith('-c') || a.startsWith('--config-env') || a.startsWith('--exec-path')) return `git ${a} changes git's configuration for the command`;
    if (a.startsWith('--git-dir') || a.startsWith('--work-tree')) return `git ${a} names another repository; use -C with the bot folder or its repository`;
    if (a === '-C') {
      const dir = args[k + 1];
      if (dir === undefined || !gitDirAllowed(dir, ctx)) return `git -C ${dir ?? ''} is neither the bot folder nor its repository`.trim();
      k++;
    } else if (a === '--namespace') {
      k++;
    }
    k++;
  }
  const sub = args[k];
  if (sub === undefined) return null;
  if (GIT_FLOOR_SUBCOMMANDS.has(sub)) return `git ${sub} is not run`;
  const rest = args.slice(k + 1);
  if (sub === 'commit' && rest.some((a) => a === '--amend' || a.startsWith('--amend='))) return 'git commit --amend rewrites history';
  for (const a of args) {
    if (/^--(upload-pack|receive-pack|exec)(=|$)/.test(a)) return `git ${a} runs another program`;
    if (/(^|[^A-Za-z])(ext|fd)::/.test(a)) return 'git remote helpers that run commands are not used';
  }
  return null;
}

function rmRefusal(args: readonly string[]): string | null {
  for (const a of args) {
    if (a === '--') break;
    if (a === '--recursive' || a === '--force') return `rm ${a} is not run`;
    if (/^-[A-Za-z]+$/.test(a) && /[rRf]/.test(a)) return `rm ${a} is not run`;
  }
  return null;
}

export interface FloorContext {
  /** The bot's own folder (its session cwd): every relative path resolves here. */
  botDir: string;
  /** The repository the bot reads, if any (`git -C` may name it). */
  repoRoot?: string;
  fs?: BotFolderDeps;
}

/** The floor's refusal for one simple command, or null. Pure apart from
 *  the path checks of an output redirection. */
function simpleCommandRefusal(cmd: SimpleCommand, ctx: FloorContext): string | null {
  if (cmd.assignments.length > 0) return 'environment assignments are not run';
  if (cmd.argv.length === 0) return 'a redirection without a command';
  const name = commandName(cmd.argv[0]);
  const args = cmd.argv.slice(1);
  if (name === '') return 'an empty command name';
  if (FLOOR_COMMANDS.has(name)) return `${name} is not run`;
  const interp = interpreterRefusal(name, args);
  if (interp) return interp;
  if (name === 'find') {
    const hit = args.find((a) => FIND_ACTIONS.has(a));
    if (hit) return `find ${hit} is not run`;
  }
  if (name === 'git') {
    const g = gitRefusal(args, ctx);
    if (g) return g;
  }
  if (name === 'rm') {
    const r = rmRefusal(args);
    if (r) return r;
  }
  for (const r of cmd.redirects) {
    if (r.op === '<') continue;
    if (r.op === '<&' || r.op === '>&') {
      if (/^(\d|-)$/.test(r.target)) continue;
      if (r.op === '<&') return 'that redirection is not supported';
    }
    if (r.target === '/dev/null') continue;
    const check = checkBotFolderPath(r.target, ctx.botDir, ctx.fs);
    if (!check.ok) return `output to ${r.target}: ${check.reason}`;
  }
  return null;
}

/**
 * The hard floor over a parsed line: the first refusal, or null when no
 * command in it hits the floor. The owner's allowlist never overrides it.
 */
export function commandFloor(pipelines: readonly Pipeline[], ctx: FloorContext): string | null {
  for (const p of pipelines) {
    for (let k = 0; k < p.length; k++) {
      const refusal = simpleCommandRefusal(p[k], ctx);
      if (refusal) return refusal;
      if (k > 0 && p[k].argv.length > 0 && isShellOrInterpreter(commandName(p[k].argv[0]))) {
        return `piping into ${commandName(p[k].argv[0])} runs its input as code`;
      }
    }
  }
  return null;
}

/** One line for logs: the parsed words, quoted where needed. Pure. */
export function normalizeCommand(pipelines: readonly Pipeline[], joins: readonly string[] = []): string {
  const q = (w: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
  return pipelines
    .map((p) => p.map((c) => [...c.assignments.map(q), ...c.argv.map(q), ...c.redirects.map((r) => `${r.fd ?? ''}${r.op}${q(r.target)}`)].join(' ')).join(' | '))
    .reduce((line, part, k) => (k === 0 ? part : `${line} ${joins[k - 1] ?? ';'} ${part}`), '');
}

/** Set for every git a bot runs: no system or global git config is read,
 *  and no missing object is fetched (a partial clone's lazy fetch runs the
 *  repository's upload-pack; git 2.45 and later, older ones ignore it). */
const GIT_RUN_ENV: readonly string[] = ['GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_NO_LAZY_FETCH=1'];

/** Config main sets on every git a bot runs, over the repository's own:
 *  nothing it reads may start a program. An empty core.fsmonitor is off in
 *  every git (a boolean false since 2.36, an unset hook before); the gpg
 *  programs are `false`, so a signature format or log.showSignature checks
 *  nothing. */
const GIT_RUN_CONFIG: readonly string[] = [
  // A bare repository the bot wrote into its folder (its own config, filter
  // drivers and all) is not used unless named with --git-dir, which is refused.
  'safe.bareRepository=explicit',
  'core.fsmonitor=',
  'core.hooksPath=/dev/null',
  'core.pager=cat',
  'core.editor=false',
  'core.sshCommand=false',
  'log.showSignature=false',
  'gpg.program=false',
  'gpg.ssh.program=false',
  'gpg.x509.program=false',
];

/** Subcommands that diff, and so take --no-ext-diff and --no-textconv. */
const GIT_DIFFING: ReadonlySet<string> = new Set(['diff', 'log', 'show']);

/** `git <globals> <sub> <args>` as it runs: main's globals first, and for
 *  a diffing subcommand the external diff and textconv drivers off, placed
 *  after the bot's own options (before any `--`), so they win. Pure. */
export function hardenedGitArgv(argv: readonly string[]): string[] {
  const globals = ['--no-pager', '--no-optional-locks', ...GIT_RUN_CONFIG.flatMap((c) => ['-c', c])];
  let k = 1;
  while (k < argv.length && argv[k].startsWith('-')) k += argv[k] === '-C' ? 2 : 1;
  const own = argv.slice(1, k);
  const sub = argv[k];
  if (sub === undefined) return [argv[0], ...globals, ...own];
  const rest = argv.slice(k + 1);
  if (!GIT_DIFFING.has(sub)) return [argv[0], ...globals, ...own, sub, ...rest];
  const dash = rest.indexOf('--');
  const off = ['--no-ext-diff', '--no-textconv'];
  const after = dash < 0 ? [...rest, ...off] : [...rest.slice(0, dash), ...off, ...rest.slice(dash)];
  return [argv[0], ...globals, ...own, sub, ...after];
}

/** A word as the shell reads it literally: single-quoted. Pure. */
function shellQuote(w: string): string {
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line as it runs: rebuilt from the parsed words, every word
 * single-quoted (the parse already refused anything that would expand) and
 * every command run as `\command <name>`, which skips the owner's aliases
 * and shell functions that claude's shell snapshot restores (bash and zsh
 * alike), so the program that runs is the one the list approved. A shell
 * function the owner named `command` itself would still run. Every git
 * runs with no system or global config and main's overrides
 * (hardenedGitArgv). Built only from a line that passed the floor, and runs
 * only once the list or the reviewer allowed it. Pure.
 */
export function commandLineToRun(pipelines: readonly Pipeline[], joins: readonly string[]): string {
  const simple = (c: SimpleCommand): string => {
    const git = commandName(c.argv[0] ?? '') === 'git';
    const argv = git ? hardenedGitArgv(c.argv) : c.argv;
    // `\command`: the backslash skips an alias named `command` too.
    const words = [...(git ? GIT_RUN_ENV : []), '\\command', ...argv.map(shellQuote)];
    for (const r of c.redirects) {
      const target = (r.op === '>&' || r.op === '<&') && /^(\d|-)$/.test(r.target) ? r.target : shellQuote(r.target);
      words.push(`${r.fd ?? ''}${r.op}${target}`);
    }
    return words.join(' ');
  };
  return pipelines
    .map((p) => p.map(simple).join(' | '))
    .reduce((line, part, k) => (k === 0 ? part : `${line} ${joins[k - 1] ?? ';'} ${part}`), '');
}
