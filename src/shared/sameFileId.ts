import type { BigIntStats } from 'node:fs';

/** Device and file ID from a bigint stat: a 64-bit file ID (NTFS) loses its
 *  low bits as a Number, so two different files could compare equal. */
export type FileId = Pick<BigIntStats, 'dev' | 'ino'>;

/** Whether two stats name the same file, at full precision. */
export function sameFileId(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
