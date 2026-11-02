/** The last two segments of a directory, for a chip or a line where the
 *  folder's own name matters most (the full path is its tooltip). */
export function shortDir(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? dir : `…/${parts.slice(-2).join('/')}`;
}
