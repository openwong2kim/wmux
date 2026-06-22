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
// (`resolveRecipient`, `formatMessage`, `formatNudge`, `writePty`) so it
// can be unit-tested without a live renderer. Production wiring injects
// the real renderer-side helpers (U6 / channelsSlice).
//
// Plan reference: U2 (a2a-channels). Pattern source:
// `src/renderer/hooks/useRpcBridge.ts:186-251` (the `deliverPtyNotification`
// / `deliverPtyNudge` / `isLiveTuiAgent` triplet).

import type {
  ChannelDelivery,
  ChannelMessage,
  ChannelRecipientStatus,
  DeliveryResult,
} from '../../shared/channels';
import { sanitizeA2aName } from '../utils/a2aFormat';

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
   * one-line nudge; non-live recipients get the full message body.
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
 * Dependencies for `LocalPtyDelivery`. Production wiring passes the real
 * renderer helpers (resolve from `surfaceSlice` / `paneSlice`, format
 * via `formatA2aMessage`-style helper, write via `submitBracketedPasteToPty`).
 * Tests inject fakes.
 */
export interface LocalPtyDeps {
  /** Resolve a recipient's PTY target. `null` means target_gone. */
  resolveRecipient: ResolveRecipient;
  /** Format the full message body for non-live-TUI recipients. */
  formatMessage: FormatChannelMessage;
  /** Format the one-line nudge for live-TUI recipients. */
  formatNudge: FormatChannelNudge;
  /** Write text to a PTY (typically via bracketed-paste wrapping). */
  writePty: WritePty;
}

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
  const shortChannel = (message.channelId || '').replace(/^ch-/, '').slice(0, 8);
  const shortMember = sanitizeA2aName(message.memberName || '').slice(0, 32);
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
 * text is sanitized inline: ESC stripped, CR removed, NUL removed.
 * LF is preserved so multi-line messages render as multi-line pasted
 * data — the bracketed-paste wrapper in the production `writePty`
 * keeps the LFs from being executed as keystrokes.
 */
export const defaultChannelMessage: FormatChannelMessage = (message) => {
  const shortChannel = (message.channelId || '').replace(/^ch-/, '').slice(0, 32);
  const safeName = sanitizeA2aName(message.memberName || '');
  const safeText = (message.text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI escapes
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, '')                 // other ESC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b/g, '')                      // lone ESC (defensive — no opener)
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, '')                      // NUL
    .replace(/\r/g, '');                       // CR (LF preserved)
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
 *     full message envelope.
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
        const body = resolved.isLiveTui
          ? this.deps.formatNudge(message)
          : this.deps.formatMessage(message);
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