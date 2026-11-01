import { launchGrammarFor } from './agentLaunchOptions';
import { launcherStem, tokenize } from './agentResume';
import { splitModelEnvMarker } from './workerLaunch';

/**
 * A launch line with the agent's own screen-reader flag (claude
 * `--ax-screen-reader`, gemini `--screen-reader`; agentLaunchOptions.ts) right
 * after the launcher token, when a screen reader is `on`. Applied only to the
 * text typed into a pane, never to a line stored for resume, replay or display,
 * so the flag goes away with the screen reader. Unchanged when:
 *   - `on` is false, or the launcher has no verified flag;
 *   - the flag is already there;
 *   - the run is headless (claude `-p`/`--print`, gemini `-p`/`--prompt`);
 *   - an unquoted word follows the launcher: a subcommand (`claude auth
 *     login`) or shell syntax, as for withLaunchSessionId.
 * Only unquoted words before an unquoted `--` count. A leading worker
 * model-env marker is kept. Pure.
 */
export function withScreenReaderFlag(line: string, on: boolean): string {
  if (!on) return line;
  const { marker, command } = splitModelEnvMarker(line);
  const tokens = tokenize(command);
  if (tokens.length === 0 || tokens[0].quoted) return line;
  const grammar = launchGrammarFor(launcherStem(tokens[0].value))?.screenReader;
  if (!grammar) return line;
  const next = tokens[1];
  if (next && !next.quoted && !next.value.startsWith('-')) return line;
  const isFlag = (value: string, flag: string): boolean => value === flag || (flag.startsWith('--') && value.startsWith(`${flag}=`));
  for (const t of tokens.slice(1)) {
    if (t.quoted) continue;
    if (t.value === '--') break;
    if (isFlag(t.value, grammar.flag) || grammar.headlessFlags.some((f) => isFlag(t.value, f))) return line;
  }
  const at = tokens[0].end;
  return `${marker}${command.slice(0, at)} ${grammar.flag}${command.slice(at)}`;
}
