/**
 * Whether a wmux browser profile is signed in to a Microsoft or work account by
 * Edge, read from a profile folder's own `Preferences` text.
 *
 * Edge signed wmux's profiles in by itself before it was started with
 * msImplicitSignin off (#3203). A profile signed in that way keeps the account
 * after the fix, so `wmux doctor` says so. Read only: nothing is changed, and
 * no email or account id leaves this function.
 *
 * Signed in = an `account_info` entry that Edge wrote (it carries
 * `edge_account_*` keys) with a non-empty `account_id` or `email`. A Chrome
 * profile signed in to Google has no `edge_account_*` keys and is not counted.
 */
export function edgeAccountSignedIn(preferencesText: string | null): boolean {
  if (!preferencesText) return false;
  let prefs: unknown;
  try {
    prefs = JSON.parse(preferencesText);
  } catch {
    return false;
  }
  const accounts = (prefs as { account_info?: unknown } | null)?.account_info;
  if (!Array.isArray(accounts)) return false;
  return accounts.some((a) => {
    if (!a || typeof a !== 'object') return false;
    const entry = a as Record<string, unknown>;
    const byEdge = Object.keys(entry).some((k) => k.startsWith('edge_account_'));
    const named = (typeof entry.account_id === 'string' && entry.account_id !== '') || (typeof entry.email === 'string' && entry.email !== '');
    return byEdge && named;
  });
}

/**
 * The profile folders inside one user-data-dir, from its `Local State`
 * (`profile.info_cache` keys: `Default`, `Profile 1`, …), so an account in a
 * profile Edge added is found too. `Default` when Local State can't be read.
 */
export function edgeProfileDirs(localStateText: string | null): string[] {
  try {
    const cache = (JSON.parse(localStateText ?? '') as { profile?: { info_cache?: unknown } })?.profile?.info_cache;
    if (cache && typeof cache === 'object') {
      // Folder names only: no path separators or parent references from the file.
      const names = Object.keys(cache).filter((k) => k !== '' && !/[\\/]|^\.\.?$/.test(k));
      if (names.length > 0) return names;
    }
  } catch { /* unreadable */ }
  return ['Default'];
}

/** The `wmux doctor` hint for a signed-in profile. Names no email and no account id. */
export const EDGE_SIGNED_IN_HINT =
  "wmux's Edge profile is signed in to a Microsoft account, so agents using it carry that sign-in. " +
  "If you didn't sign it in yourself, sign it out in edge://settings/profiles.";
