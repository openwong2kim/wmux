// Bounds for everything this desktop reads from a paired remote host.
//
// A remote host is another machine: its answers are parsed here, in the main
// process, before anything reaches a store or the screen. Every body, frame,
// row count, id and geometry value is bounded so a misbehaving or older host
// costs at most these numbers in memory and work. Row and string bounds are
// the phone sidebar's (one allowlist for "rows another process produced"), so
// the desktop and the phone accept the same shapes.

import {
  PHONE_SIDEBAR_LIMITS,
  parsePhoneSidebarLayout,
  type PhoneSidebarLayout,
  type SidebarDropReporter,
} from './phoneFleetSidebar';

export const REMOTE_LIMITS = {
  /** `GET /api/workspaces`. A real reply is tens of KB; this leaves room for
   *  every row the bounds below allow. */
  workspacesBodyBytes: 4 * 1024 * 1024,
  /** Config probe, pair exchange, create/resize replies, error bodies. */
  smallBodyBytes: 64 * 1024,
  /**
   * One pane-stream frame, and the unterminated tail, in bytes. The largest
   * frame a host sends is the attach snapshot: a 256 KiB window by default,
   * base64 on the wire, so this leaves wide headroom while still bounding a
   * stream that never ends a frame.
   */
  streamBufferBytes: 4 * 1024 * 1024,
  /**
   * Pane output (base64, as sent to the viewer) the viewer may have
   * outstanding before the stream stops being read. Several seconds of a busy
   * pane; a viewer that keeps up never gets near it.
   */
  viewerWindowBytes: 8 * 1024 * 1024,
  /** A viewer that consumes nothing for this long ends its attach. */
  viewerStallMs: 30_000,
  /** The `/api/events` frame buffer; attention frames are small JSON. */
  attentionBufferBytes: 256 * 1024,
  /** Attention text shown in a notification. */
  attentionTitle: 120,
  attentionBody: 240,
  workspaces: PHONE_SIDEBAR_LIMITS.workspaces,
  /** Panes over the whole reply, not per workspace. */
  panes: PHONE_SIDEBAR_LIMITS.panes,
  id: PHONE_SIDEBAR_LIMITS.id,
  workspaceName: 256,
  shell: 256,
  cwd: 4096,
  agentName: 256,
  paneName: PHONE_SIDEBAR_LIMITS.paneName,
  surfaceTitle: PHONE_SIDEBAR_LIMITS.surfaceTitle,
  /** Same ceiling the host's resize route applies (WebTerminalServer). */
  geometryMax: 1000,
  layout: PHONE_SIDEBAR_LIMITS.layout,
} as const;

/**
 * Characters a host could use to restyle or reorder text this app shows as
 * its own: C0 and C1 controls (ESC, CR, LF, NUL and the rest), DEL, the
 * Unicode line and paragraph separators, and the bidi embedding, override and
 * isolate marks. Same reflex as the attention toast text (remoteAttention.ts).
 */
// eslint-disable-next-line no-control-regex
const REMOTE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;
// eslint-disable-next-line no-control-regex
const HAS_REMOTE_TEXT_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Display text from another machine: cut to `max` characters, each run of
 *  control characters replaced by one space. */
export function cleanRemoteText(value: string, max: number): string {
  return value.slice(0, max).replace(REMOTE_TEXT_CONTROLS, ' ');
}

/**
 * A bounded, non-empty id from another machine, or undefined. An id is sent
 * back to the host as is, so one carrying a control character is refused
 * rather than rewritten.
 */
export function remoteId(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= REMOTE_LIMITS.id
    && !HAS_REMOTE_TEXT_CONTROL.test(value)
    ? value
    : undefined;
}

/** `value` as display text (see cleanRemoteText), or undefined when it is not a string. */
export function boundedRemoteString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? cleanRemoteText(value, max) : undefined;
}

/**
 * One terminal dimension: a finite number, floored and clamped into
 * 1..geometryMax. Null when it is not a usable number at all.
 */
export function clampRemoteDimension(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(REMOTE_LIMITS.geometryMax, Math.max(1, Math.floor(value)));
}

/** Both dimensions clamped, or null when either is not a usable number. */
export function clampRemoteGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = clampRemoteDimension(cols);
  const r = clampRemoteDimension(rows);
  return c === null || r === null ? null : { cols: c, rows: r };
}

/**
 * A host's split tree for one workspace, under the phone sidebar's bounds
 * (depth, node and leaf counts, children per split, surfaces, unique pane,
 * surface and pty ids, bounded titles). All or nothing: undefined when any
 * bound is exceeded, so a caller never builds half a layout.
 */
export function parseRemoteLayout(value: unknown, onDrop?: SidebarDropReporter): PhoneSidebarLayout | undefined {
  return parsePhoneSidebarLayout(value, onDrop ?? (() => undefined));
}
