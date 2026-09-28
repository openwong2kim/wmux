// ─── Fan-out requester origin ────────────────────────────────────────────────
//
// Who asked for a fan-out task, recorded on the task's lineage stamp (main,
// `fanout-lineage.json`) at the moment the task pane is created. It holds
// stable ids — the calling pane's paneId and surfaceId, never its ptyId, which
// changes when a surface is rebound to a new PTY after daemon recovery — and a
// snapshot of the pane's display name, so the sidebar can still say who asked
// after that pane is closed.
//
// Display data only, never an authority: the depth-1 check reads the owner,
// not this.

export type FanoutOriginKind = 'pane' | 'orchestrator' | 'gui';

export interface FanoutOrigin {
  kind: FanoutOriginKind;
  /** kind 'pane': the calling pane (stable across PTY rebinds). */
  paneId?: string;
  /** kind 'pane': the calling surface inside that pane. */
  surfaceId?: string;
  /** kind 'pane': the pane's display name when the task launched. */
  label?: string;
}

const ID_MAX = 128;
const LABEL_MAX = 200;

function boundedString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * Validate an origin read from disk or handed over IPC. Unknown kinds and
 * non-objects yield undefined; oversized or non-string fields are dropped
 * rather than failing the whole origin. A pane origin with neither a paneId
 * nor a surfaceId can never name its pane, so it yields undefined too — the
 * task then reads as "requester unknown" instead of carrying a dead stamp.
 */
export function sanitizeFanoutOrigin(raw: unknown): FanoutOrigin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];
  if (kind !== 'pane' && kind !== 'orchestrator' && kind !== 'gui') return undefined;
  if (kind !== 'pane') return { kind };
  const paneId = boundedString(r['paneId'], ID_MAX);
  const surfaceId = boundedString(r['surfaceId'], ID_MAX);
  const label = boundedString(r['label'], LABEL_MAX);
  if (!paneId && !surfaceId) return undefined;
  return {
    kind,
    ...(paneId ? { paneId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(label ? { label } : {}),
  };
}

export function sameFanoutOrigin(a: FanoutOrigin | undefined, b: FanoutOrigin | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.paneId === b.paneId && a.surfaceId === b.surfaceId && a.label === b.label;
}
