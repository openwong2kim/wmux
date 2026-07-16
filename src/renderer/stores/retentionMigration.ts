// One-shot migration ledger for the hidden-pane-retention default flip
// (plans/app-weight-reduction-2026-07-16.md P0-1).
//
// Why localStorage and not a SessionData field: every build persists the
// retention flag into session.json unconditionally, so a pre-flip profile
// carries `false` that is indistinguishable from a deliberate OFF. A marker
// stored INSIDE session.json cannot survive a downgrade — an old build
// rewrites the file without the unknown field, and re-upgrading would flip a
// deliberate OFF back ON (the "ping-pong" the DX review flagged). localStorage
// lives in the same userData partition but is never rewritten by old builds,
// so the ledger survives downgrade/re-upgrade cycles.
//
// Semantics: the marker means "this profile has been through the default-ON
// migration OR the user has expressed explicit intent". Once set, a persisted
// `false` is always respected.

const KEY = 'wmux.retentionMigratedV1';

export function retentionMigrationDone(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // localStorage unavailable → fail closed: claim "done" so we never flip a
    // user's persisted choice without a durable record that we did.
    return true;
  }
}

export function markRetentionMigrationDone(): void {
  try {
    window.localStorage.setItem(KEY, '1');
  } catch { /* ignore — next boot retries */ }
}

/** Test seam. */
export function __clearRetentionMigrationForTests(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
