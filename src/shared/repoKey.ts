// ─── Repo keys — the factory's one spelling of a repository ───────────────
//
// A repo key names a repository as `host/owner/repo`, lowercased
// (parseRemoteKey's form, the verdict store's and the merge lane's); a GitLab
// project in a subgroup keeps its whole path, `host/group/sub/repo`. Callers
// may also spell it `owner/repo`, which means github.com, in any case, with
// a trailing `.git` or `/`. Every entry that takes a repo key (thread ids,
// fact.emit, bot profiles, repo watch) normalizes through this one function,
// so one PR is one thread and one dedupe key however it was spelled.

const SEGMENT_RE = /^[\w.-]+$/;
const REPO_KEY_MAX = 255;
/** host + up to 21 path segments (GitLab nests groups 20 deep). */
const REPO_KEY_MAX_PARTS = 22;

/** `host/owner/repo` (or `host/group/…/repo`) lowercased, or null when the
 *  value is not a repo key. */
export function normalizeRepoKey(key: unknown): string | null {
  if (typeof key !== 'string' || key.length > REPO_KEY_MAX) return null;
  let k = key.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  if (k.split('/').length === 2) k = `github.com/${k}`;
  const parts = k.split('/');
  // The canonical form is bounded too, so a stored key normalizes again.
  if (k.length > REPO_KEY_MAX || parts.length < 3 || parts.length > REPO_KEY_MAX_PARTS || parts.some((p) => !p || !SEGMENT_RE.test(p))) return null;
  return k;
}
