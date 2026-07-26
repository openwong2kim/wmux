/**
 * Persist a rare late distro enrichment synchronously before publication.
 * A single immediate retry covers transient replace/lock races.
 */
export function persistLocationEnrichment(
  save: () => boolean,
  rollback: () => void = () => {},
): boolean {
  if (save() || save()) return true;
  rollback();
  return false;
}
