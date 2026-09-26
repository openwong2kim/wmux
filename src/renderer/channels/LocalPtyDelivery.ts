// ─── LocalPtyDelivery ──────────────────────────────────────────────────
// Local fanout transport for A2A channels. Wraps the existing PTY write
// path (`submitBracketedPasteToPty` in `src/renderer/utils/ptyMessageDelivery.ts`)
// with the per-recipient live-TUI nudge split that the existing A2A task
// delivery already uses (see `src/renderer/hooks/useRpcBridge.ts:186-251`).
//
// Plan KTD-A: this is the local implementation of the `ChannelDelivery`
// interface. A LAN transport (or headless / archive transports) ships as
// a sibling that satisfies the same interface — `ChannelService.post`
// stays unchanged.
//
// The transport is pure logic: it takes injected dependencies
// (`resolveRecipient`, `formatNudge`, `writePty`) so it
// can be unit-tested without a live renderer. This transport is not wired
// into production; live delivery uses mention nudges and the daemon wake worker.
//
// Plan reference: U2 (a2a-channels). Pattern source:
// `src/renderer/hooks/useRpcBridge.ts:186-251` (the `deliverPtyNotification`
// / `deliverPtyNudge` / `isLiveTuiAgent` triplet).

import { sanitizePtyText } from '../../shared/types';

import type {
  ChannelDelivery,
  ChannelMessage,
  ChannelRecipientStatus,
  DeliveryResult,
} from '../../shared/channels';
import { sanitizeA2aName, stripEscapes } from '../utils/a2aFormat';

/**
 * Resolved PTY target for a recipient. The renderer injects the
 * `resolveRecipient` dependency that produces one of these per
 * (workspaceId, memberId) pair.
 */
export interface ResolvedRecipient {
  /** The PTY id to write to. Stable for the lifetime of the surface. */
  ptyId: string;
  /**
   * True when the recipient's resolved PTY is hosting a live TUI agent
   * (running / waiting / awaiting_input). Live recipients get a
   * one-line nudge; non-live recipients receive no PTY input.
   * Mirrors the `isLiveTuiAgent` semantics from `useRpcBridge.ts:233-236`.
   */
  isLiveTui: boolean;
}

/**
 * Function signature for resolving a recipient to a PTY target.
 * Returns `null` when the recipient has no resolvable PTY (workspace
 * is offline, member has no surface, etc.) — the transport marks such
 * recipients `target_gone`.
 */
export type ResolveRecipient = (
  workspaceId: string,
  memberId: string,
) => ResolvedRecipient | null;

/** Format a channel message into the text body the recipient sees. */
export type FormatChannelMessage = (message: ChannelMessage) => string;

/** Format a channel message into a one-line nudge for live-TUI recipients. */
export type FormatChannelNudge = (message: ChannelMessage) => string;

/** Write `text` to `ptyId`. */
export type WritePty = (ptyId: string, text: string) => void;

/**
 * Dependencies for the unused local transport seam. Tests inject fakes.
 */
export interface LocalPtyDeps {
  /** Resolve a recipient's PTY target. `null` means target_gone. */
  resolveRecipient: ResolveRecipient;
  /** Format the one-line nudge for live-TUI recipients. */
  formatNudge: FormatChannelNudge;
  /** Write text to a PTY (typically via bracketed-paste wrapping). */
  writePty: WritePty;
}

// Preserve name spacing while removing remaining control and line separators.
const safeChannelName = (value: string): string => sanitizeA2aName(value)
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '');

/**
 * Default nudge formatter. One line, no body — the recipient runs
 * `channel.history` (or whatever U2 ships) to fetch the message. The
 * 8-char seq prefix is enough to disambiguate posts within a session.
 *
 * CRITICAL: a nudge is delivered to a live TUI agent's input box
 * (see `deliverPtyNudge` in `src/renderer/hooks/useRpcBridge.ts:207`).
 * Embedded CR/LF/TAB would corrupt the input, and raw ESC could forge
 * terminal control sequences or break out of a bracketed-paste run.
 * The formatter delegates to `sanitizeA2aName` (see
 * `src/renderer/utils/a2aFormat.ts:30`) which strips ESC + NUL,
 * collapses CR/LF/TAB to spaces, and caps the result length. The
 * output has NO trailing newline — single line, period.
 */
export const defaultChannelNudge: FormatChannelNudge = (message) => {
  const shortChannel = safeChannelName(message.channelId || '').replace(/^ch-/, '').slice(0, 8);
  const shortMember = safeChannelName(message.memberName || '').slice(0, 32);
  return `[wmux-channel #${shortChannel} from ${shortMember} — see channel history (seq ${message.seq})]`;
};

/**
 * Default message-body formatter. Bracketed-paste-friendly envelope:
 *
 *   ━━━ WMUX CHANNEL #general ━━━
 *   [Alice] hello world
 *   ━━ END ━━
 *
 * Name is sanitized via `sanitizeA2aName` (strips ESC + NUL, collapses
 * CR/LF/TAB to spaces — the name appears on a single line). The body
 * text strips escapes and NUL, drops CR, and folds LF into ␤ so a
 * sender cannot forge additional envelope headers or delimiters.
 */
export const defaultChannelMessage: FormatChannelMessage = (message) => {
  const shortChannel = safeChannelName(message.channelId || '').replace(/^ch-/, '').slice(0, 32);
  const safeName = safeChannelName(message.memberName || '');
  const safeText = stripEscapes(sanitizePtyText(message.text || '').replace(/\r/g, ''))
    .replace(/\n/g, '␤')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '');
  return [
    '',
    `━━━ WMUX CHANNEL #${shortChannel} ━━━`,
    `[${safeName}] ${safeText}`,
    `━━━ END ━━━`,
    '',
  ].join('\n');
};

/**
 * Local fanout transport. Wraps `writePty` (typically
 * `submitBracketedPasteToPty`) with the per-recipient live-TUI check.
 *
 * Behaviour per recipient:
 *   - `resolveRecipient` returns `null` → mark `target_gone`, skip write.
 *   - `resolveRecipient` returns `{ ptyId, isLiveTui: true }` → write the
 *     nudge (one line, no body).
 *   - `resolveRecipient` returns `{ ptyId, isLiveTui: false }` → write the
 *     no input, marked policy_refused (the post remains in history).
 *
 * The transport never throws. A `writePty` that throws is caught per
 * recipient and the recipient is marked `target_gone` so a single bad
 * PTY does not poison the whole delivery (we still attempt every
 * recipient).
 */
export class LocalPtyDelivery implements ChannelDelivery {
  constructor(private readonly deps: LocalPtyDeps) {}

  async deliver(
    message: ChannelMessage,
    snapshot: ChannelRecipientStatus[],
  ): Promise<DeliveryResult> {
    const now = Date.now();
    const updated = snapshot.map((entry) => {
      // Wrap the entire per-recipient operation. A bad PTY lookup, a
      // formatter throw, OR a write throw must not abort the rest of
      // the fanout — every recipient gets an independent verdict so
      // one bad row cannot poison the whole delivery.
      let resolvedPtyId: string | undefined;
      try {
        const resolved = this.deps.resolveRecipient(
          entry.workspaceId,
          entry.memberId,
        );
        if (resolved === null) {
          return {
            ...entry,
            status: 'target_gone' as const,
            lastAttemptAt: now,
          };
        }
        resolvedPtyId = resolved.ptyId;
        if (!resolved.isLiveTui) {
          // Submitting even a folded message to a shell can execute it.
          // Keep the post in history; only confirmed live TUIs receive input.
          return {
            ...entry,
            ptyId: resolved.ptyId,
            status: 'policy_refused' as const,
            lastAttemptAt: now,
          };
        }
        const body = this.deps.formatNudge(message);
        this.deps.writePty(resolved.ptyId, body);
        return {
          ...entry,
          ptyId: resolved.ptyId,
          status: 'delivered' as const,
          lastAttemptAt: now,
        };
      } catch {
        // Resolution / format / write failure all collapse to
        // `target_gone` for this recipient. If resolution succeeded
        // before the throw, the resolved `ptyId` is preserved so the
        // snapshot keeps a stable handle on the surface for the next
        // delivery attempt.
        return {
          ...entry,
          ptyId: resolvedPtyId ?? entry.ptyId,
          status: 'target_gone' as const,
          lastAttemptAt: now,
        };
      }
    });
    const ok = updated.some((entry) => entry.status === 'delivered');
    return { snapshot: updated, ok };
  }
}