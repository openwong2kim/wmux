/**
 * A git bundle of an agent's work handed back to the PC that asked for it
 * (bring-back): its id, the limits on its bytes, and how long it is kept for
 * the asking PC to fetch. The transfer is daemon/a2aRemote/bundleOutbox.ts
 * (the PC that made it serves it) and bundleIntake.ts (the asking PC takes it).
 */

/** A bundle's id: `bd-` and a UUID, minted by the PC that made it. */
const BUNDLE_ID_RE = /^bd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isBundleId(v: unknown): v is string {
  return typeof v === 'string' && BUNDLE_ID_RE.test(v);
}

/** The largest bundle taken when no setting says otherwise. */
export const BUNDLE_BYTES_DEFAULT = 64 * 1024 * 1024;
/** How long a made bundle waits for its fetch when no setting says otherwise. */
export const BUNDLE_TTL_DEFAULT_MS = 60 * 60 * 1000;

/**
 * The largest bundle any setting may allow: the most bytes whose transfer
 * budget (30 s plus 1 Mbit/s, server.ts continueTransferBudgetMs) still fits
 * under its 10-minute ceiling, so a bundle is never cut by its own budget.
 */
export const BUNDLE_BYTES_CEILING = Math.floor(((10 * 60_000 - 30_000) * 1_000) / 8);

/** A size setting as taken: a whole number of bytes from 1 to the ceiling, else the default. */
export function bundleBytesMax(setting: unknown): number {
  return typeof setting === 'number' && Number.isInteger(setting) && setting >= 1 ? Math.min(setting, BUNDLE_BYTES_CEILING) : BUNDLE_BYTES_DEFAULT;
}

/** What the asking PC is told it may fetch: one file, its size and hash. */
export interface A2aBundleManifestV1 {
  bundleId: string;
  sha256: string;
  bytes: number;
}
