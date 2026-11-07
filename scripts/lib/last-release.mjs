// The downgrade test's release (scripts/fetch-last-release-cli.mjs), apart
// from the script so a test can import it.

/** The stable releases among `tags`, as `X.Y.Z`, newest first. */
export function stableReleases(tags) {
  const releases = tags
    .map((tag) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim()))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  releases.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return [...new Set(releases.map((r) => r.join('.')))];
}

/** A release asset that is not there (HTTP 404). */
export class AssetNotFound extends Error {}

/**
 * `fetchRelease(releases[0])`, or, when that release has no assets yet (its
 * tag is pushed before its installers are built and uploaded), the release
 * before it. Only an AssetNotFound falls back, and only once.
 */
export async function fetchNewestPublished(releases, fetchRelease, log) {
  const [newest, previous] = releases;
  try {
    return await fetchRelease(newest);
  } catch (error) {
    if (!(error instanceof AssetNotFound) || !previous) throw error;
    log(`last release: v${newest} has no assets yet (${error.message}), using v${previous}`);
    return fetchRelease(previous);
  }
}
