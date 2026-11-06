/**
 * Why a native snapshot was not used, counted by reason for the memory
 * diagnostics (`wmux doctor`). A native refusal is keyed by its family, the
 * `unsupported-*` token before the colon, so the key set stays bounded.
 */
export type SnapshotReasons = Record<string, number>;

const FAMILY = /^unsupported-[a-z-]{1,40}/;

/** The key a native refusal's detail counts under; `fallback` when it has none. */
export function refusalFamily(detail: string | undefined, fallback: string): string {
  return (detail && FAMILY.exec(detail)?.[0]) || fallback;
}

export function countReason(reasons: SnapshotReasons, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}
