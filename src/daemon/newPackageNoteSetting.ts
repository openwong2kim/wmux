import path from 'node:path';
import { atomicReadJSONSync } from './util/atomicWrite';
import { NEW_PACKAGE_NOTE_FILENAME } from '../shared/newPackageNote';

/** Where the new-package note setting (shared/newPackageNote.ts) is kept. */
export function newPackageNotePath(wmuxDir: string): string {
  return path.join(wmuxDir, NEW_PACKAGE_NOTE_FILENAME);
}

/** Whether the setting is on. On by default: only a stored `false` turns it off. */
export function readNewPackageNote(wmuxDir: string): boolean {
  try {
    return atomicReadJSONSync<{ enabled?: unknown }>(newPackageNotePath(wmuxDir))?.enabled !== false;
  } catch {
    return true;
  }
}
