/**
 * Deliveries wait for a verified agent process: the daemon's answer to
 * "is this pane's foreground an agent?", asked right before any text typed on
 * someone's behalf (an A2A message, a mention nudge, a hand-off, a channel
 * nudge) and again before its Enter.
 *
 * - `process`: a tracked agent process that is running (not stopped, not a
 *   reused pid: the same check as the scheduled-prompt delivery) and holds
 *   the terminal's foreground (macOS and Linux; Windows and WSL have no such
 *   read). An exec unit's agent is the session itself.
 * - `screen`: no process could be attributed (a remote/SSH pane, an agent
 *   behind an unknown wrapper, an attribution that failed), the shell is not
 *   known to be at its prompt, and the current frame shows the agent's
 *   composer (or its dialog) at the bottom of the grid with no shell row under
 *   it. Never the title or the detector's last agent alone: both outlive a
 *   killed agent.
 * - `none`: everything else. A tracked process that ended always wins over
 *   the screen.
 */

import type { AgentSlug } from '../shared/events';
import type { DeliveryPresence, DeliveryPresenceReason } from '../shared/deliveryPresence';
import { DELIVERY_PRESENCE_PROBE_MS } from '../shared/deliveryPresence';
import { isScreenReadAgent, screenShowsLiveAgent } from './recoveryHint';

export interface PresenceSession {
  shellPid: number;
  /** An exec unit: the session's own process is the agent. */
  exec: boolean;
  /** The shell's command state from OSC 133: false = at its prompt, undefined = unknown. */
  commandRunning: boolean | undefined;
  /** The agent the daemon names for the pane (any tier), as a slug. */
  namedSlug: AgentSlug | undefined;
}

export interface DeliveryPresenceDeps {
  /** A live (attached or detached) session, or undefined. */
  session(id: string): PresenceSession | undefined;
  /** The tracker's attributed process: undefined when none was. */
  tracked(id: string): { alive: boolean; slug?: AgentSlug } | undefined;
  /** Run the tracker's named-agent probe and wait for it, bounded. */
  probe(id: string, shellPid: number, timeoutMs: number): Promise<void>;
  /** The tracked agent is still this pane's `slug` agent and running. */
  agentRunning(id: string, slug: AgentSlug): Promise<boolean>;
  /** The tracked agent's pid (not for a WSL agent). */
  agentPid(id: string): number | undefined;
  /** Whether a process holds its terminal's foreground; undefined = no answer. */
  holdsForeground(pid: number): Promise<boolean | undefined>;
  /** The pane's current visible grid, or null. */
  screenRows(id: string): Promise<readonly string[] | null>;
  platform: NodeJS.Platform;
}

export async function deliveryPresence(deps: DeliveryPresenceDeps, id: string, expectAgent: AgentSlug | undefined): Promise<DeliveryPresence> {
  const none = (reason: DeliveryPresenceReason): DeliveryPresence => ({ tier: 'none', reason });
  const session = id ? deps.session(id) : undefined;
  if (!session) return none('no-session');
  if (session.exec) {
    if (!session.namedSlug) return none('no-agent');
    if (expectAgent && session.namedSlug !== expectAgent) return none('other-agent');
    return { tier: 'process', slug: session.namedSlug };
  }
  // Not known alive: probe once (it also records the death of a tracked agent
  // the process monitor has not polled yet, and names a new one).
  if (deps.tracked(id)?.alive !== true) await deps.probe(id, session.shellPid, DELIVERY_PRESENCE_PROBE_MS);
  const tracked = deps.tracked(id);
  if (tracked && !tracked.alive) return none('agent-ended');
  if (tracked?.slug) {
    if (expectAgent && tracked.slug !== expectAgent) return none('other-agent');
    if (!(await deps.agentRunning(id, tracked.slug).catch(() => false))) return none('not-running');
    const pid = deps.agentPid(id);
    if (deps.platform !== 'win32' && pid !== undefined && (await deps.holdsForeground(pid).catch(() => undefined)) !== true) {
      return none('not-foreground');
    }
    return { tier: 'process', slug: tracked.slug };
  }
  // Never attributed, or an unnamed (wrapper) process: only the screen can tell.
  if (session.commandRunning === false) return none('shell-at-prompt');
  const slug = session.namedSlug ?? expectAgent;
  if (!slug || !isScreenReadAgent(slug)) return none('no-screen-proof');
  if (expectAgent && slug !== expectAgent) return none('other-agent');
  const rows = await deps.screenRows(id).catch(() => null);
  if (!rows || !screenShowsLiveAgent(rows, slug)) return none('no-screen-proof');
  return { tier: 'screen', slug };
}
