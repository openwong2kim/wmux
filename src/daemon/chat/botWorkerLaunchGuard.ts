// ─── A phone's agent launch into a bot's fan-out worker pane ───────────────
//
// The daemon types a launch line into an existing pane when a phone starts or
// resumes the pane's agent (nativeChatBridge `launch`). A pane that is a
// bot's fan-out worker merges only through the agent factory's merge lane, so
// a claude line typed there carries the same `--settings` file main's own
// launches carry (shared/botWorkerGuard.ts), or nothing is typed. Which panes
// are a bot's workers comes from main's record, read fresh on every launch:
// main writes it while the daemon runs. A record that exists but cannot be
// read guards every pane. A codex line is refused there (main launches a bot's
// codex worker only as the fan-out's own first launch). A line that starts no
// claude or codex passes unchanged, as main's own resume guard passes it.
//
// A session main recorded with its launch files (the worker's MCP config and
// rules, shared/botWorkerMcp.ts) gets those, with `--strict-mcp-config`, when
// they hold no connection and the folders it may start in have no project
// settings a worker does not start with (shared/botWorkerGuard.ts). A
// WSL session gets the worker settings file alone, as before. Any other
// session (recorded without its files, or a record that cannot be read) gets
// nothing typed.

import fs from 'node:fs';
import { getWmuxDir } from '../config';
import { namesClaude, readBotWorkerSessions, spliceSettingsFlag, workerProjectSettingsRefusal, writeBotWorkerSettings } from '../../shared/botWorkerGuard';
import { spliceWorkerLaunch } from '../../shared/botWorkerMcp';
import { namesCodex } from '../../shared/codexWorkerGuard';

/** The first message as terminalLaunchCommand appends it: ` -- '<text>'`,
 *  each `'` written `'\''`. */
const QUOTED_FIRST_MESSAGE = /^ -- '(?:[^']|'\\'')*'$/;

/**
 * The line to type into pane `sessionId`: `line` itself for a pane that is
 * not a bot's worker; for one that is, the line with the worker settings
 * right after the launcher, or null (type nothing). `head` is `line` up to
 * the first message: the launcher and its flags, which the guard reads; the
 * rest must be exactly the quoted first message, and is kept as it is.
 */
export function guardBotWorkerLaunch(
  sessionId: string,
  line: string,
  head: string,
  dir: string = getWmuxDir(),
  /** The folders the line may start claude in (the pane's, a resume's). */
  folders: readonly string[] = [],
): string | null {
  const read = readBotWorkerSessions(dir);
  if ('sessions' in read && !read.sessions.has(sessionId)) return line;
  // A codex worker starts only as main's fan-out launch (codexWorkerGuard).
  if (namesCodex(line)) return null;
  if (!namesClaude(line)) return line;
  if (!line.startsWith(head)) return null;
  const tail = line.slice(head.length);
  if (tail && !QUOTED_FIRST_MESSAGE.test(tail)) return null;
  const rec = 'sessions' in read ? read.sessions.get(sessionId) : undefined;
  if (rec?.launch && !rec.wsl) {
    if (!rec.cwd || [rec.cwd, ...folders].some((f) => workerProjectSettingsRefusal(f) !== null)) return null;
    if (!fs.existsSync(rec.launch.settingsFile) || !fs.existsSync(rec.launch.mcpConfigFile)) return null;
    // The daemon cannot tell whether a recorded connection is still the
    // bot's: a launch with connections starts only from main.
    if (carriesConnections(rec.launch.mcpConfigFile)) return null;
    const strict = spliceWorkerLaunch(head, rec.launch.settingsFile, rec.launch.mcpConfigFile, rec.launch.settingSources);
    return strict === null ? null : strict + tail;
  }
  // Only a WSL pane launches with the settings file alone. Any other record
  // without its files (an older main's, or one that cannot be read) types
  // nothing: the daemon cannot write the worker's MCP config.
  if (!rec?.wsl) return null;
  let settingsPath: string;
  try {
    settingsPath = writeBotWorkerSettings(dir);
  } catch {
    return null;
  }
  const guarded = spliceSettingsFlag(head, settingsPath);
  return guarded === null ? null : guarded + tail;
}

/** Does a recorded MCP config name any server but wmux (or not parse)? */
function carriesConnections(file: string): boolean {
  try {
    const servers = (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    return Object.keys(servers).some((k) => k !== 'wmux');
  } catch {
    return true;
  }
}
