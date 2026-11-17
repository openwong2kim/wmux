// ─── Moa transcript rows — how the HQ brain's transcript reads as a chat ─────
//
// Pure row transforms shared by main's right-panel chat (main/deck/
// moaTranscript.ts), the renderer (Moa/panel/MoaTranscriptChat.tsx) and the
// daemon's phone `/turns` route, which serves the same brain transcript.

import type { TurnEvent } from './transcript/turnEvents';

/** How many recent prompts Moa remembers for the chat view. */
export const PROMPT_MEMORY = 50;
/** How long after main noted a prompt its transcript entry may land: a cold
 *  start waits for the TUI (up to 20 s) and a turn can wait for a slot. */
const PROMPT_MATCH_WINDOW_MS = 120_000;
/** How many entry → prompt assignments are kept so a re-read stays stable. */
const ASSIGNED_MEMORY = 200;
/** Where main keeps the remembered prompts (wmux data dir), so a restart keeps
 *  the questions earlier turns showed and the daemon can read them too. */
export const MOA_PROMPTS_FILE = 'moa-prompts.json';

/** A prompt main sent to an HQ brain. */
export interface NotedPrompt { at: number; text: string; hq: string }

/** The remembered prompts on disk, or [] (none yet, unreadable, foreign). */
export function parseNotedPrompts(raw: unknown): NotedPrompt[] {
  const list = (raw as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is NotedPrompt =>
      !!p && typeof p === 'object'
      && typeof (p as NotedPrompt).at === 'number' && Number.isFinite((p as NotedPrompt).at)
      && typeof (p as NotedPrompt).text === 'string'
      && typeof (p as NotedPrompt).hq === 'string')
    .slice(-PROMPT_MEMORY);
}

/**
 * The terminal brain types each turn as one paste — the context blocks main
 * builds (rules, policy, decision, active work) with the prompt at the end —
 * so Claude records the whole wire as the user's message, capped by the
 * parser. Shown as-is, the chat would display Moa's instructions as if the
 * operator had typed them. Main knows what was actually asked, so such an
 * entry is shown as the prompt main sent for it:
 *  - an entry that ends with a prompt is that prompt's (a wire typed into a
 *    TUI that is still starting can lose its paste markers and its start);
 *  - else a pasted entry takes the latest prompt noted before it, within
 *    PROMPT_MATCH_WINDOW_MS. Never a prompt noted after it.
 * Each prompt is used once, and `assigned` remembers which entry took which
 * prompt across calls (snapshots and appends see the same entries again).
 * A prompt is known by its time and text, not its object, so a caller that
 * re-reads the prompts from disk on every call still uses each one once.
 */
export function rewritePastedPrompts<P extends { at: number; text: string }>(
  events: readonly TurnEvent[],
  prompts: readonly P[],
  assigned: Map<string, P> = new Map(),
): TurnEvent[] {
  if (prompts.length === 0 && assigned.size === 0) return [...events];
  const keyOf = (p: P) => `${p.at}\u0000${p.text}`;
  const used = new Set<string>([...assigned.values()].map(keyOf));
  return events.map((e) => {
    if (e.kind !== 'user_text') return e;
    const known = assigned.get(e.id);
    if (known) return asPrompt(e, known.text);
    const ts = typeof e.ts === 'number' ? e.ts : null;
    const before = (p: P) => ts !== null && p.at <= ts && ts - p.at <= PROMPT_MATCH_WINDOW_MS;
    const tail = e.text.trimEnd();
    let match: P | undefined;
    for (const p of prompts) {
      const text = p.text.trim();
      if (used.has(keyOf(p)) || !text || !tail.endsWith(text) || (ts !== null && !before(p))) continue;
      if (!match || p.at > match.at) match = p;
    }
    if (!match && e.pasted === true) {
      for (const p of prompts) {
        if (!used.has(keyOf(p)) && before(p) && (!match || p.at > match.at)) match = p;
      }
    }
    if (!match) return e;
    used.add(keyOf(match));
    assigned.set(e.id, match);
    if (assigned.size > ASSIGNED_MEMORY) assigned.delete(assigned.keys().next().value as string);
    return asPrompt(e, match.text);
  });
}

/** A row shown as the prompt main sent: that text, and no longer a paste of Moa's (moaPhoneRows hides those). */
function asPrompt(e: Extract<TurnEvent, { kind: 'user_text' }>, text: string): TurnEvent {
  if (e.text === text && e.pasted !== true) return e;
  const { pasted: _pasted, ...rest } = e;
  return { ...rest, text };
}

/**
 * The operator reads Moa's replies, not its working: text Moa wrote between
 * tool calls (its turn went on: no end_turn) and every tool call it made,
 * failed ones included, are marked to fold into the activity view. Only the
 * text that ended a turn stays in the conversation.
 */
export function foldMoaInternals(events: readonly TurnEvent[]): TurnEvent[] {
  return events.map((e) => {
    const internal = e.kind === 'tool_use' || e.kind === 'tool_result'
      || (e.kind === 'assistant_text' && !e.thinking && !e.turnComplete);
    return internal && !e.folded ? { ...e, folded: true as const } : e;
  });
}

/**
 * The prompts main types for Moa itself (pane events, a fleet snapshot, the
 * decision resume lines, Wake, a loop's kickoff, the startup reconcile) are not
 * the operator's words: they never draw as a user bubble. Each becomes an
 * invisible turn start, so the turn still begins there.
 */
// Start-anchored, and only openings main itself writes: an operator prompt
// (even one main prefixed with context blocks) never matches.
export const MOA_WAKE_TEXT = new RegExp('^\\s*(?:' + [
  String.raw`\[pane-events\]`,
  String.raw`\[fleet-snapshot\]`,
  String.raw`The operator (?:just resolved|DISMISSED) the decision you raised`,
  String.raw`A decision you (?:SELF-RESOLVED|raised has been pending too long)`,
  String.raw`The operator pressed the Wake button`,
  String.raw`The loop above has just started`,
  String.raw`A human request is still active after wmux startup`,
].join('|') + ')');
export const WAKE_PREFIX = 'moa-wake:';

/** A user row as the invisible turn start it stands for. */
function asTurnStart(e: TurnEvent): TurnEvent {
  return { id: `${WAKE_PREFIX}${e.id}`, kind: 'meta' as const, subtype: 'turn_started' as const, label: '', ...(e.ts !== undefined ? { ts: e.ts } : {}) };
}

export function hideMoaWakes(events: readonly TurnEvent[]): TurnEvent[] {
  return events.map((e) => (e.kind === 'user_text' && MOA_WAKE_TEXT.test(e.text) ? asTurnStart(e) : e));
}

/**
 * The HQ brain's transcript as the phone's `/turns` serves it: each pasted
 * prompt shown as what main sent, main's own wake prompts and any pasted entry
 * main has no record of (Moa's context blocks, never the operator's words) as
 * invisible turn starts, and Moa's working folded.
 */
export function moaPhoneRows<P extends { at: number; text: string }>(
  events: readonly TurnEvent[],
  prompts: readonly P[],
  assigned: Map<string, P>,
): TurnEvent[] {
  const shown = hideMoaWakes(rewritePastedPrompts(events, prompts, assigned))
    .map((e) => (e.kind === 'user_text' && e.pasted === true ? asTurnStart(e) : e));
  return foldMoaInternals(shown);
}
