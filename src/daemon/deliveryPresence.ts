/**
 * Deliveries wait for a verified agent in plain input mode: the daemon's answer
 * to "may text typed on someone's behalf go into this pane now?", asked before
 * anything is written and again as the last step before the Enter (and before
 * a fresh-context command or a retried Enter).
 *
 * - `process`: a tracked agent process that is running now (a fresh process
 *   read, not the cached state: not stopped, not a reused pid) and holds the
 *   terminal's foreground (macOS and Linux; Windows consoles and WSL have no
 *   such read). An exec unit counts only when its root is verified to be that
 *   agent.
 * - `screen`: no process could be attributed, the shell is not known to be at
 *   its prompt, and the current frame shows the agent's plain prompt with the
 *   cursor on it. Never the title or the detector's last agent alone.
 * - `none`: everything else. A tracked process that ended always wins.
 *
 * On either tier, an agent whose plain prompt is known (deliveryComposer.ts)
 * gets the full text only while its current frame shows that prompt (empty at
 * the paste); every other agent gets wmux's own one-line pointer, and only on
 * the process tier.
 */

import type { AgentSlug } from '../shared/events';
import type { DeliveryCheck, DeliveryPresence, DeliveryPresenceReason } from '../shared/deliveryPresence';
import { DELIVERY_PRESENCE_PROBE_MS } from '../shared/deliveryPresence';
import { cursorInComposer, frameShowsPaste, hasPlainPrompt, readComposer, type DeliveryFrame } from './deliveryComposer';

export interface PresenceSession {
  shellPid: number;
  /** An exec unit: the session's own process may be the agent. */
  exec: boolean;
  /** The shell's command state from OSC 133: false = at its prompt, undefined = unknown. */
  commandRunning: boolean | undefined;
  /** The agent the daemon names for the pane (any tier), as a slug. */
  namedSlug: AgentSlug | undefined;
  /** The pane has enabled bracketed paste (DECSET 2004). */
  bracketedPaste: boolean;
}

export interface DeliveryPresenceDeps {
  /** A live (attached or detached) session, or undefined. */
  session(id: string): PresenceSession | undefined;
  /** The tracker's attributed process: undefined when none was. */
  tracked(id: string): { alive: boolean; slug?: AgentSlug } | undefined;
  /** Run the tracker's named-agent probe and wait for it, bounded: false while it still runs. */
  probe(id: string, shellPid: number, timeoutMs: number): Promise<boolean>;
  /** Fresh: the tracked agent is still this pane's `slug` agent and running. */
  agentRunning(id: string, slug: AgentSlug): Promise<boolean>;
  /** Fresh: an exec unit's root process is the `slug` agent. */
  ownedRoot(id: string, pid: number, slug: AgentSlug): Promise<boolean>;
  /** Fresh: a process is running (not stopped, not a zombie). */
  processRunning(pid: number): Promise<boolean>;
  /** The tracked agent's pid (not for a WSL agent). */
  agentPid(id: string): number | undefined;
  /** Whether a process holds its terminal's foreground; undefined = no answer. */
  holdsForeground(pid: number): Promise<boolean | undefined>;
  /** The pane's current visible grid and cursor row, or null. */
  frame(id: string): Promise<DeliveryFrame | null>;
  platform: NodeJS.Platform;
}

/** Agents a screen alone may verify (no attributed process): their prompt and
 *  where they keep the cursor are both known. */
const SCREEN_TIER_AGENTS: ReadonlySet<AgentSlug> = new Set(['claude']);

const none = (reason: DeliveryPresenceReason, pasteShown?: boolean): DeliveryPresence =>
  ({ tier: 'none', reason, ...(pasteShown !== undefined ? { pasteShown } : {}) });

export async function deliveryPresence(
  deps: DeliveryPresenceDeps,
  id: string,
  expectAgent: AgentSlug | undefined,
  check: DeliveryCheck = { phase: 'paste' },
): Promise<DeliveryPresence> {
  let frame: DeliveryFrame | null | undefined;
  const readFrame = async (): Promise<DeliveryFrame | null> => (frame === undefined ? (frame = await deps.frame(id).catch(() => null)) : frame);
  // At the Enter, a refusal says whether the frame still shows this
  // delivery's paste: only then may main take it back.
  const session = id ? deps.session(id) : undefined;
  if (!session) return none('no-session');

  const shown = async (): Promise<boolean | undefined> =>
    check.phase === 'enter' && check.shownProbe
      ? frameShowsPaste(await readFrame(), { probe: check.shownProbe, lines: check.shownLines, chars: check.shownChars })
      : undefined;
  const refuse = async (reason: DeliveryPresenceReason): Promise<DeliveryPresence> => none(reason, await shown());
  // A yes at the Enter says it too: a guard that refuses the Enter after this
  // answer takes the paste back only on it.
  const pass = async (tier: 'process' | 'screen', slug: AgentSlug, input: 'full' | 'pointer'): Promise<DeliveryPresence> => {
    const pasteShown = await shown();
    return { tier, slug, input, bracketedPaste: session.bracketedPaste, ...(pasteShown !== undefined ? { pasteShown } : {}) };
  };

  /** A verified agent process: the composer decides what may be typed. */
  const verified = async (tier: 'process' | 'screen', slug: AgentSlug): Promise<DeliveryPresence> => {
    if (!hasPlainPrompt(slug)) {
      // No known plain prompt: wmux's own pointer line, on the process tier only.
      return tier === 'process' ? pass(tier, slug, 'pointer') : refuse('no-screen-proof');
    }
    const current = await readFrame();
    const read = readComposer(current, slug, check.phase);
    if (read.verdict === 'mode') return refuse('composer-mode');
    if (read.verdict === 'busy') return refuse('composer-busy');
    if (read.verdict !== 'plain') return refuse('composer-unknown');
    // A screen alone proves the agent only with the cursor on its prompt: a
    // frame being drawn now, not a leftover. Codex's cursor was not measured,
    // so its screen tier holds; its process tier reads the signature alone.
    if (tier === 'screen' && !(SCREEN_TIER_AGENTS.has(slug) && current && cursorInComposer(current, read))) return refuse('no-screen-proof');
    // At the Enter the input box must hold this delivery's paste and only it:
    // anything else in it (someone's own paste or keys) is not ours to submit.
    if (check.phase === 'enter' && check.shownProbe && (await shown()) !== true) return refuse('composer-busy');
    return pass(tier, slug, 'full');
  };

  /** A verified process, as the tracked path below asks: running, and in the terminal's foreground. */
  const runningInForeground = async (pid: number): Promise<DeliveryPresence | null> => {
    if (deps.platform === 'win32') return null;
    const foreground = await deps.holdsForeground(pid).catch(() => undefined);
    if (foreground === undefined) return refuse('foreground-unknown');
    return foreground ? null : refuse('not-foreground');
  };

  // An exec unit whose root is verified to be the named agent, running in the foreground.
  if (session.exec && session.namedSlug && (!expectAgent || session.namedSlug === expectAgent)
    && await deps.ownedRoot(id, session.shellPid, session.namedSlug).catch(() => false)) {
    if (!(await deps.processRunning(session.shellPid).catch(() => false))) return refuse('not-running');
    return (await runningInForeground(session.shellPid)) ?? verified('process', session.namedSlug);
  }

  // Not known alive: probe once (it also records the death of a tracked agent
  // the process monitor has not polled yet, and names a new one).
  const settled = deps.tracked(id)?.alive === true || await deps.probe(id, session.shellPid, DELIVERY_PRESENCE_PROBE_MS);
  const tracked = deps.tracked(id);
  if (tracked && !tracked.alive) return refuse('agent-ended');
  // A probe still running is not "nothing to attribute": the screen does not decide yet.
  if (!tracked && !settled) return refuse('attribution-pending');
  if (tracked?.slug) {
    if (expectAgent && tracked.slug !== expectAgent) return refuse('other-agent');
    if (!(await deps.agentRunning(id, tracked.slug).catch(() => false))) return refuse('not-running');
    const pid = deps.agentPid(id);
    const notForeground = pid === undefined ? null : await runningInForeground(pid);
    return notForeground ?? verified('process', tracked.slug);
  }

  // Never attributed, or an unnamed (wrapper) process: only the screen can tell.
  if (session.commandRunning === false) return refuse('shell-at-prompt');
  const slug = session.namedSlug ?? expectAgent;
  if (!slug) return refuse('no-screen-proof');
  if (expectAgent && slug !== expectAgent) return refuse('other-agent');
  return verified('screen', slug);
}

/** Who wrote a prompt the daemon types: the owner (a schedule, an automation
 *  run), wmux itself (a fixed line of words and ids), or a peer (another PC). */
export type PromptAuthor = 'owner' | 'wmux' | 'peer';

/**
 * A daemon-typed prompt's answer from the presence check. A peer's text needs
 * the agent's plain prompt on screen (`full`); the owner's own prompt, or
 * wmux's own line, also goes to an agent wmux has no plain-prompt reader for,
 * on the process tier, as before. A refusal is `unavailable` when there is no
 * agent to deliver to, else `busy`: one that may take it later.
 */
export function promptGrant(presence: DeliveryPresence, author: PromptAuthor): true | 'busy' | 'unavailable' {
  if (presence.tier !== 'none') return presence.input === 'full' || author !== 'peer' ? true : 'busy';
  switch (presence.reason) {
    case 'not-foreground':
    case 'foreground-unknown':
    case 'attribution-pending':
    case 'composer-mode':
    case 'composer-busy':
    case 'composer-unknown':
      return 'busy';
    default:
      return 'unavailable';
  }
}
