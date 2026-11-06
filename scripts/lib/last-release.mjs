// The downgrade test's release (scripts/fetch-last-release-cli.mjs), apart
// from the script so a test can import it.

/** The newest stable release among `tags`, as `X.Y.Z`, or null. */
export function latestRelease(tags) {
  const releases = tags
    .map((tag) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim()))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  releases.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const last = releases.at(-1);
  return last ? last.join('.') : null;
}
