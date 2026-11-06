import * as path from 'path';

/**
 * `file` spelled from the home directory (`~/…`, `/`-separated) when it is
 * inside it, else unchanged, so a displayed path does not carry the login
 * name. Uses the platform's own path rules, which compare Windows paths
 * without regard to case. A root or empty home relativizes nothing: every
 * path would otherwise read as `~/…`.
 */
export function homeRelative(file: string, home: string, p: path.PlatformPath = path): string {
  if (!home || p.parse(p.resolve(home)).root === p.resolve(home)) return file;
  const rel = p.relative(home, file);
  if (rel === '') return '~';
  if (rel.startsWith('..') || p.isAbsolute(rel)) return file;
  return `~/${rel.split(p.sep).join('/')}`;
}
