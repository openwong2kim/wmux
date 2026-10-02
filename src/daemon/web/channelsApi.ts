// ─── Phone channel Inbox — web seam adapter (contract §9) ─────────────────
// The interface WebTerminalServer's `channels?` seam consumes, and its
// production implementation. Same shape as the approvals seam
// (approvals?: ApprovalRegistryApi): when the daemon injects this object the
// four routes are live; without it every one of them answers
// 503 {error: 'channels-unavailable'} (see the §9 response table for the
// "do not retry in a loop" guidance).
//
// The identity mapping is why this file exists: the authenticated principal
// (operator token or paired device) is mapped SERVER-SIDE to the reserved
// human workspace (ws-human, P5). No identity field exists in a request body
// or query, and none may — the client cannot claim a different identity, and
// no parallel synthetic "__operator" row is ever created. Phone and desktop
// are the same human principal, so read cursors and mentions cannot fork
// between the two surfaces.
//
// The work is delegated to ChannelService's *ForPhone methods. This layer owns
// only HTTP parameter validation (400 invalid-cursor / invalid-body) and the
// service-error → HTTP-status mapping, so a test can check a route's status
// mapping without a service (the web unit tests fake this interface).

import {
  PHONE_MESSAGES_DEFAULT_LIMIT,
  PHONE_MESSAGES_MAX_LIMIT,
  type ChannelError,
  type ChannelMentionNotification,
  type ChannelService,
  type PhoneChannelMessage,
  type PhoneChannelRow,
} from '../channels/ChannelService';

// The payload the web server promotes into a `channel.mention` attention event —
// exposed here beside the seam interface (re-exported from the service barrel).
export type { ChannelMentionNotification };

/** The error a route sends over HTTP: the 400/404/500 rows of the §9 response table. */
export type PhoneChannelsError =
  | { status: 400; error: 'invalid-cursor' | 'invalid-body' | 'no-seat' | 'archived'; detail?: string }
  | { status: 404; error: 'not-found'; detail?: string }
  | { status: 500; error: 'internal'; detail?: string };

/** Success/failure union. A route handler only translates it to a status + JSON. */
export type PhoneChannelsResult<T> = ({ ok: true } & T) | { ok: false; error: PhoneChannelsError };

/**
 * The phone channel seam WebTerminalServer consumes. `onMention` follows the
 * approvals `onEvent(listener) → unsubscribe` shape: the web server subscribes
 * in start(), promotes each notification to a recorded `channel.mention`
 * attention event (§4/§9), and unsubscribes in stop().
 */
export interface ChannelPhoneApi {
  /** The `GET /api/channels` body. */
  list(): { channels: PhoneChannelRow[] };
  /**
   * `GET /api/channels/<id>/messages`. `since`/`limit` are the raw query
   * strings (null when absent) — parsing and validation live here, so the
   * route only translates the result. Malformed → 400 invalid-cursor.
   */
  messages(
    channelId: string,
    since: string | null,
    limit: string | null,
  ): PhoneChannelsResult<{ messages: PhoneChannelMessage[]; nextSince: number }>;
  /**
   * `POST /api/channels/<id>/ack`. `body` is the parsed JSON as-is and is
   * validated here (anything but a non-negative integer lastReadSeq → 400
   * invalid-body).
   */
  ack(channelId: string, body: unknown): Promise<PhoneChannelsResult<{ lastReadSeq: number }>>;
  /** `POST /api/channels/<id>/join`. No body. Idempotent (alreadyMember). */
  join(
    channelId: string,
  ): Promise<PhoneChannelsResult<{ lastReadSeq: number; alreadyMember: boolean }>>;
  /** Subscribe to human-mention promotion (the approvals onEvent shape). */
  onMention(listener: (n: ChannelMentionNotification) => void): () => void;
}

/** Parse one query string as a non-negative integer: null when absent, 'invalid' (→ invalid-cursor) when malformed. */
function parseNonNegativeInt(raw: string | null): number | null | 'invalid' {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  return Number(trimmed);
}

/** Service error code → its §9 HTTP row. */
function mapServiceError(error: ChannelError): PhoneChannelsError {
  switch (error.code) {
    case 'CHANNEL_NOT_FOUND':
      // Unobservable and missing are indistinguishable (the same collapse get() applies).
      return { status: 404, error: 'not-found' };
    case 'NO_SEAT':
      return { status: 400, error: 'no-seat' };
    case 'CHANNEL_ARCHIVED':
      return { status: 400, error: 'archived' };
    default:
      // PERSIST_FAILED and the like — 500. Not a row in the contract table, but
      // the phone treats it like any other 500 (surface it, do not retry).
      return { status: 500, error: 'internal' };
  }
}

/** Production adapter: wraps ChannelService as a ChannelPhoneApi. */
export function makeChannelPhoneApi(service: ChannelService): ChannelPhoneApi {
  return {
    list: () => ({ channels: service.listForPhone() }),

    messages: (channelId, since, limit) => {
      const sinceSeq = parseNonNegativeInt(since);
      if (sinceSeq === 'invalid') {
        return {
          ok: false,
          error: { status: 400, error: 'invalid-cursor', detail: 'since must be a non-negative integer seq' },
        };
      }
      const parsedLimit = parseNonNegativeInt(limit);
      if (parsedLimit === 'invalid' || (parsedLimit !== null && (parsedLimit < 1 || parsedLimit > PHONE_MESSAGES_MAX_LIMIT))) {
        return {
          ok: false,
          error: {
            status: 400,
            error: 'invalid-cursor',
            detail: `limit must be an integer between 1 and ${PHONE_MESSAGES_MAX_LIMIT}`,
          },
        };
      }
      const res = service.messagesForPhone(
        channelId,
        sinceSeq ?? undefined,
        parsedLimit ?? PHONE_MESSAGES_DEFAULT_LIMIT,
      );
      if (!res.ok) return { ok: false, error: mapServiceError(res.error) };
      return { ok: true, messages: res.messages, nextSince: res.nextSince };
    },

    ack: async (channelId, body) => {
      const lastReadSeq =
        body !== null && typeof body === 'object' && 'lastReadSeq' in body
          ? (body as { lastReadSeq?: unknown }).lastReadSeq
          : undefined;
      if (typeof lastReadSeq !== 'number' || !Number.isInteger(lastReadSeq) || lastReadSeq < 0) {
        return {
          ok: false,
          error: { status: 400, error: 'invalid-body', detail: 'lastReadSeq must be a non-negative integer' },
        };
      }
      // Advancing the seat cursor takes the channel mutex, hence async.
      return service.ackAsPhone(channelId, lastReadSeq).then((res) =>
        res.ok
          ? { ok: true as const, lastReadSeq: res.lastReadSeq }
          : { ok: false as const, error: mapServiceError(res.error) },
      );
    },

    join: (channelId) =>
      service.joinAsPhone(channelId).then((res) =>
        res.ok
          ? { ok: true as const, lastReadSeq: res.lastReadSeq, alreadyMember: res.alreadyMember }
          : { ok: false as const, error: mapServiceError(res.error) },
      ),

    onMention: (listener) => service.onMention(listener),
  };
}
