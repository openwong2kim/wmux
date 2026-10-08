// Name for the Chrome profile "New profile for this pane" creates.
//
// Derived from the pane's display name so the profile list reads as the panes
// that own them. Main validates every name (validateBrowserProfileName in
// src/main/browser-session/ProfileManager.ts) and the renderer cannot import
// main, so the rule is mirrored here: 1-64 chars, first one alphanumeric, the
// rest alphanumeric, `_` or `-`.
//
// De-duplication is not optional: main's create() is idempotent on an existing
// name, so a collision would not fail — it would silently bind the pane to a
// profile (and its logins) that already belongs to something else.

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
const MAX_LEN = 64;
const FALLBACK = 'pane';

/** Profiles a pane can never be bound to: the shared default, and the user's
 *  own live Chrome (a workspace-level grant, never a per-pane one). */
export const PANE_UNBINDABLE_PROFILES: ReadonlySet<string> = new Set(['default', 'live']);

function sanitize(raw: string, max: number): string {
  return raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, max)
    .replace(/[-_]+$/, '');
}

/**
 * A valid, unused profile name for a pane labelled `label`. `taken` is every
 * registered profile; comparison is case-insensitive because the profile's
 * user-data-dir lands on a case-insensitive filesystem on macOS and Windows.
 */
export function paneProfileNameFrom(label: string, taken: readonly string[]): string {
  // A label with nothing ASCII in it (a Korean pane name) sanitizes to empty.
  const base = sanitize(label, MAX_LEN) || FALLBACK;
  const used = new Set([...taken, ...PANE_UNBINDABLE_PROFILES].map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const stem = sanitize(base, MAX_LEN - suffix.length) || FALLBACK;
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Exported for tests: the mirrored main-side rule. */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name);
}
