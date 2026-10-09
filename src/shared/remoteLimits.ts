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
   * The unterminated tail of a pane stream. The largest frame a host sends is
   * the attach snapshot: a 256 KiB window by default, base64 on the wire, so
   * this leaves wide headroom while still bounding a stream that never ends a
   * frame.
   */
  streamBufferBytes: 4 * 1024 * 1024,
  workspaces: PHONE_SIDEBAR_LIMITS.workspaces,
  /** Panes over the whole reply, not per workspace. */
  panes: PHONE_SIDEBAR_LIMITS.panes,
  id: PHONE_SIDEBAR_LIMITS.id,
  workspaceName: 256,
  shell: 256,
  cwd: 4096,
  agentName: 256,
  /** Same ceiling the host's resize route applies (WebTerminalServer). */
  geometryMax: 1000,
  layout: PHONE_SIDEBAR_LIMITS.layout,
} as const;

/** A bounded, non-empty id from another machine, or undefined. */
export function remoteId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= REMOTE_LIMITS.id ? value : undefined;
}

/** `value` cut to `max` characters, or undefined when it is not a string. */
export function boundedRemoteString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
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
