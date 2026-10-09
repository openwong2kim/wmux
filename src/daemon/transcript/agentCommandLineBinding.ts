// Bind a pane to the exact conversation its agent's command line names.
//
// A person who types `claude --resume <uuid>` or `codex resume <uuid>` in a
// pane, and a fresh Claude that wmux pinned with `--session-id <uuid>`, name
// the conversation on the agent's own command line. Read it from the process
// table on the agent's launch edge, so the pane holds its exact id without
// waiting for a hook (Codex has none; its notify arrives only when a turn ends,
// and its cwd binder only adopts threads STARTED after the launch, so an old
// thread resumed by hand never bound — #1891).
//
// It never guesses: only an id written on the command line counts. `--last`,
// `--continue` and the bare session pickers name no id and are skipped. A
// resumed id binds only when its transcript is on disk now (exact-id lookup,
// containment-checked); a pinned fresh id binds without a path, like a
// SessionStart, and transcript discovery adopts the file once it exists.

import type { ResumeBinding } from '../../shared/agentResume';
import { resumeGrammarFor } from '../../shared/agentResume';
import { findCodexTranscript } from './codexCapture';
import { checkNativeTranscriptPath } from './providers';
import { scanForTranscript } from './TranscriptDiscovery';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** What an agent's command line says about its conversation. */
export interface CommandLineSession {
  sessionId: string;
  /** `resume`: an existing conversation. `pin`: a new one started under this id. */
  kind: 'resume' | 'pin';
}

/** Words of a process command line. Quotes are dropped rather than honoured:
 *  Windows nests them (`cmd /c "…\codex.cmd" resume <id>`), ps prints none, and
 *  an id, flag or subcommand never contains a space. */
function words(cmdline: string): string[] {
  return cmdline.replace(/["']/g, ' ').split(/\s+/).filter(Boolean);
}

/** `C:\…\codex.cmd` → `codex`, `/…/codex.js` → `codex`. */
function stemOf(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');
}

/** The id after `flag` (`flag <id>` or `flag=<id>`), when it is a UUID. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === flag && UUID.test(argv[i + 1] ?? '')) return argv[i + 1].toLowerCase();
    if (w.startsWith(`${flag}=`) && UUID.test(w.slice(flag.length + 1))) return w.slice(flag.length + 1).toLowerCase();
  }
  return undefined;
}

/** Codex global options that take a value; their value is not the subcommand. */
const CODEX_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox',
  '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--remote', '--local-provider',
]);

/**
 * The conversation id `cmdline` names for `agent` (a registry slug), or
 * undefined when it names none. Grammar comes from the registry row:
 *   - flag form (Claude `--resume {id}`): `--resume <uuid>` / `--resume=<uuid>`;
 *     its pin flag (`--session-id <uuid>`) is a `pin`. `--fork-session` starts
 *     a new id the line does not name, so it names nothing.
 *   - subcommand form (Codex `resume {id}`): the first word after the launcher
 *     that is not a global option must be `resume`; the first UUID after it is
 *     the id (so `resume --remote … --cd … <uuid>` works). `--last` names none.
 * Pure — exported for tests.
 */
export function sessionFromCommandLine(agent: string, cmdline: string | undefined): CommandLineSession | undefined {
  const grammar = resumeGrammarFor(agent);
  if (!grammar || !cmdline) return undefined;
  const argv = words(cmdline);
  const [head] = grammar.withId('{id}').split(' ');
  if (head.startsWith('-')) {
    if (argv.includes('--fork-session')) return undefined;
    const resumed = flagValue(argv, head);
    if (resumed) return { sessionId: resumed, kind: 'resume' };
    const pinned = grammar.pin ? flagValue(argv, grammar.pin) : undefined;
    return pinned ? { sessionId: pinned, kind: 'pin' } : undefined;
  }
  const launcher = argv.findIndex((w) => stemOf(w) === agent);
  if (launcher < 0) return undefined;
  let i = launcher + 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    i += CODEX_VALUE_FLAGS.has(argv[i]) ? 2 : 1;
  }
  if (argv[i] !== head) return undefined;
  const rest = argv.slice(i + 1);
  if (rest.includes('--last')) return undefined;
  const id = rest.find((w) => UUID.test(w));
  return id ? { sessionId: id.toLowerCase(), kind: 'resume' } : undefined;
}

/** Exact-id transcript lookups, per agent with a file transcript. */
const FIND_TRANSCRIPT: Readonly<Record<string, (id: string, env?: Record<string, string>) => string | undefined>> = {
  claude: (id, env) => scanForTranscript(id, env).find((file) => checkNativeTranscriptPath('claude', file, id, env).ok),
  codex: (id, env) => findCodexTranscript(id, env),
};

/**
 * The binding `cmdline` proves for a pane whose agent runs in `cwd`, or
 * undefined. A resumed id must have its transcript on disk now; a pinned id
 * binds without one (its transcript is written on the first turn).
 */
export function commandLineBinding(
  agent: string,
  cmdline: string | undefined,
  cwd: string,
  env?: Record<string, string>,
  now = Date.now(),
): ResumeBinding | undefined {
  const found = sessionFromCommandLine(agent, cmdline);
  if (!found || !cwd || !Object.hasOwn(FIND_TRANSCRIPT, agent)) return undefined;
  const transcriptPath = FIND_TRANSCRIPT[agent](found.sessionId, env);
  if (!transcriptPath && found.kind === 'resume') return undefined;
  return { agent, sessionId: found.sessionId, cwd, ...(transcriptPath ? { transcriptPath } : {}), ts: now };
}
