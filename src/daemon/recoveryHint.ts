import { agentDisplayToSlug, type AgentSlug } from '../shared/agentIdentity';
import type { ResumeBinding } from '../shared/agentResume';
import { isWslShell } from '../shared/wslTarget';
import { screenShowsActiveDialog, screenShowsAgentDialog } from './transcript/chatScreenGate';
import { transcriptTurnState } from './transcript/chatAgentStatus';
import { fileTranscriptProvider } from './transcript/providers';
import { readTranscriptPage } from './transcript/readTail';

/**
 * The recovery hint for a pane, or undefined once process truth shows the
 * pane's agent alive again.
 *
 * A banner clears the hint, but an agent that prints none after it was resumed
 * would otherwise keep it for as long as the daemon lives. A daemon that
 * outlives app quits then hands every new app session a resume hint for a pane
 * whose agent is running, and the renderer offers (or auto-types) the resume
 * into that agent's own input box. A stale hint is dropped together with its
 * recovery binding, the same pair the banner path clears.
 */
export function liveRecoveryHint<S, B>(
  id: string,
  agentAlive: (id: string) => boolean | undefined,
  hints: Map<string, S>,
  bindings: Map<string, B>,
): S | undefined {
  const slug = hints.get(id);
  if (slug !== undefined && agentAlive(id) === true) {
    hints.delete(id);
    bindings.delete(id);
    return undefined;
  }
  return slug;
}

/**
 * The binding a person-driven pane lists, marked `cwdMissing` when the folder
 * its conversation ran in is gone (a removed worktree) while the transcript
 * still exists. `--resume <id>` runs only from that folder, so the pane names
 * the conversation and its folder instead of opening a picker that cannot list
 * it. Read on a copy: the stored binding never carries the mark. Exec and
 * supervised panes resume on their own and are not marked; a WSL pane's folder
 * is in the distro and a network, device or WSL share path is not probed, so
 * neither is.
 */
export function markCwdMissing(
  binding: ResumeBinding,
  pane: { exec?: unknown; supervision?: unknown; wslTarget?: unknown; cmd?: string },
  transcriptLives: (binding: ResumeBinding) => boolean,
  folderExists: (dir: string) => boolean,
): ResumeBinding {
  if (pane.exec || pane.supervision || pane.wslTarget || isWslShell(pane.cmd)) return binding;
  // A network, device or WSL share path (`\\server`, `\\?\`, `\\wsl.localhost`)
  // is not probed: a stat there can stall every listing on a host or a distro.
  if (!binding.cwd || /^[\\/]{2}/.test(binding.cwd) || folderExists(binding.cwd)) return binding;
  return transcriptLives(binding) ? { ...binding, cwdMissing: true } : binding;
}

/** How recent a recovered pane's last output must be for its turn to be continued. */
export const RESUME_CONTINUE_MAX_QUIET_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the persisted record of a pane says its agent was mid-turn when the
 * daemon that wrote it died (`turnRunningSince`, see DaemonPTYBridge
 * isAgentMidTurn). A running agent paints all the time, so the record's last
 * output is close to that death; when it is older than a day the machine sat
 * off for that long or the pane was silent with a turn left open, and neither
 * is work to pick up again on its own.
 */
export function recordWasMidTurn(record: { turnRunningSince?: unknown; resumeContinuePending?: unknown; lastActivity?: unknown }, now: number): boolean {
  const since = record.turnRunningSince;
  const midTurn = typeof since === 'number' && Number.isFinite(since) && since > 0;
  // A continue owed by an earlier recovery and not yet spent counts the same.
  if (!midTurn && record.resumeContinuePending !== true) return false;
  const lastOutput = typeof record.lastActivity === 'string' ? Date.parse(record.lastActivity) : NaN;
  if (!Number.isFinite(lastOutput)) return false;
  return now - lastOutput <= RESUME_CONTINUE_MAX_QUIET_MS;
}

/**
 * Whether the agent's own transcript still shows open the turn the daemon saw
 * running when it died: no interrupt and no finished reply after its last
 * work or prompt. The daemon's mid-turn mark says an agent was in a turn; only
 * the transcript says the user did not stop it (an interrupt fires no hook,
 * and the daemon may have had no reader of the transcript's end). Anything
 * unknown (no transcript, outside the account's sessions, unreadable) is no.
 */
export function recordedTurnStillOpen(binding: ResumeBinding | undefined, env?: Record<string, string>): boolean {
  const file = binding?.transcriptPath;
  const provider = binding ? fileTranscriptProvider(binding.agent) : undefined;
  if (!binding || !file || !provider) return false;
  if (!provider.check(file, binding.sessionId, env).ok) return false;
  const page = readTranscriptPage(file, { parseLine: (line, offset) => provider.parse(line, offset).events });
  return transcriptTurnState(page?.events) === 'open';
}

/**
 * The liveness `liveRecoveryHint` may consume a hint on: a live process the
 * tracker attributed to a named agent. A slugless pick (an unknown wrapper,
 * or any direct child the probe found) is not evidence of an agent: a
 * `tail -f` printing a quoted banner arms the tracker and is picked as alive,
 * and consuming on it would drop the offer and its binding for good.
 */
export function namedAgentAlive(identity: { slug?: string; alive: boolean } | undefined): boolean | undefined {
  if (identity?.slug === undefined) return undefined;
  return identity.alive;
}

/**
 * The agent a recovered pane's screen tier has sighted since recovery, when
 * its live chrome can be read off the screen (Claude Code, Codex). The
 * pane's detector is new with the respawned shell and is fed only live
 * output, so a name here was drawn after the restart, never by the dead
 * session.
 *
 * A sighting only hides the recovery pill. It never consumes the offer: that
 * takes a hook or a live process (see the `session:agent` handler).
 */
export function sightedRecoveredAgent(screenAgent: string | null | undefined): ScreenReadAgent | undefined {
  const slug = agentDisplayToSlug(screenAgent ?? '');
  return slug && Object.hasOwn(COMPOSER_AT_BOTTOM, slug) ? slug as ScreenReadAgent : undefined;
}

/** A rule Claude draws above and below its prompt row (labeled or not). */
const CLAUDE_RULE_ROW = /^─{8,}/;
/** Codex's footer under its composer: the model/cwd row or the shortcut hint. */
const CODEX_FOOTER_ROW = /^\s+(?:\S.+ · (?:[A-Za-z]:[\\/]|\/|~)|(?:← for agents · )?\? for shortcuts?\b)/;

/** A row an agent draws last on its screen: indented, one of Claude's rules
 *  (a session's name rule under a picker), or a dialog's key hints
 *  (`Enter to select · … · Esc to cancel`, drawn from column 0). */
const AGENT_BOTTOM_ROW = /^\s|^─{8,}|\b(?:esc|enter) to\b/i;

/**
 * A dialog of the agent's owns the bottom of the screen: the last row is one
 * the agent draws, and the awaiting verifier's strict test or, past it, any
 * dialog sign on the screen holds (plan approvals, narrow or wrapped
 * pickers). A shell row at the bottom (its prompt, `Killed`) means the
 * dialog's rows were left behind.
 */
function dialogAtBottom(rows: readonly string[]): boolean {
  let last = rows.length - 1;
  while (last >= 0 && rows[last].trim().length === 0) last--;
  if (last < 0) return false;
  // A narrow pane wraps the key hints and leaves their last word alone on the
  // bottom row (`… · Esc to` / `cancel`, captured at 44 and 80 columns), or
  // their last two (`… · Esc` / `to cancel`: the preview picker's longer
  // hint at 57 columns, captured on Claude Code 2.1.311).
  const above = last > 0 ? rows[last - 1].trimEnd() : '';
  const wrapped = last > 0 && (
    (/^\S+$/.test(rows[last]) && /\b(?:esc|enter) to$/i.test(above))
    || (/^to \S+$/i.test(rows[last]) && /\b(?:esc|enter)$/i.test(above)));
  const grid = wrapped ? [...rows.slice(0, last - 1), `${above} ${rows[last]}`] : rows.slice(0, last + 1);
  if (!AGENT_BOTTOM_ROW.test(grid[grid.length - 1])) return false;
  return screenShowsActiveDialog(grid) || screenShowsAgentDialog(grid);
}

/**
 * Is the sighted agent still on the visible screen? Its composer, empty or
 * holding a draft, at the bottom of the grid, or a dialog it owns there.
 *
 * Claude and Codex draw every row under their prompt row indented (a draft's
 * continuation, the footer, the status line; captured on Claude Code 2.1 and
 * Codex 0.157), so a row at column 0 below it is the shell's: its prompt, or
 * `Killed` after the agent was stopped from outside. Once the agent exits its
 * composer is erased (captured on Claude Code's classic and fullscreen
 * renderers) or left above that shell row, and the sighting is stale. The
 * grid is read in an alternate screen too: an agent killed without leaving it
 * must not read as live for good. Not the chat-send gates' composer checks:
 * those refuse a whole screen that mentions `Esc to cancel` anywhere, which
 * here would show the pill over a live agent.
 */
export function screenShowsLiveAgent(rows: readonly string[], slug: ScreenReadAgent): boolean {
  return dialogAtBottom(rows) || COMPOSER_AT_BOTTOM[slug](rows);
}

/** The last row matching `isPrompt`, and the non-blank rows under it. */
function lastPromptRow(rows: readonly string[], isPrompt: RegExp): { at: number; below: string[] } | undefined {
  let at = rows.length - 1;
  while (at >= 0 && !isPrompt.test(rows[at])) at--;
  return at < 0 ? undefined : { at, below: rows.slice(at + 1).filter((row) => row.trim().length > 0) };
}

/**
 * Per agent, its composer at the bottom of the grid: the agents whose live
 * chrome a recovered pane's screen read knows. An adapter table, like the
 * chat-send composer checks in deliverChatPrompt.ts.
 */
const COMPOSER_AT_BOTTOM = {
  // The prompt row between two rules, and only indented rows under them.
  claude: (rows: readonly string[]): boolean => {
    const prompt = lastPromptRow(rows, /^❯(?:\s|$)/);
    if (!prompt || prompt.at === 0) return false;
    const close = prompt.below.findIndex((row) => CLAUDE_RULE_ROW.test(row));
    return CLAUDE_RULE_ROW.test(rows[prompt.at - 1].trim()) && close >= 0
      && prompt.below.every((row, i) => i === close || /^\s/.test(row));
  },
  // The prompt row over its footer, and only indented rows under it.
  codex: (rows: readonly string[]): boolean => {
    const prompt = lastPromptRow(rows, /^\s*›(?:\s|$)/);
    return !!prompt && prompt.below.some((row) => CODEX_FOOTER_ROW.test(row)) && prompt.below.every((row) => /^\s/.test(row));
  },
} satisfies Partial<Record<AgentSlug, (rows: readonly string[]) => boolean>>;

/** An agent whose live chrome the recovered-pane screen read knows. */
export type ScreenReadAgent = keyof typeof COMPOSER_AT_BOTTOM;
