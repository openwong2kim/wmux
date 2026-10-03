import type { Readable } from 'stream';
import type * as fs from 'fs';

export interface FsStatLike {
  mtimeMs?: number;
  mtime?: Date | number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink?: () => boolean;
}

export interface TranscriptScanDeps {
  now?: () => number;
  readdir?: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<(string | fs.Dirent)[]>;
  stat?: (filePath: string) => Promise<FsStatLike>;
  lstat?: (filePath: string) => Promise<FsStatLike>;
  createReadStream?: (filePath: string) => Readable;
  budget?: number;
  budgetMs?: number;
}

export interface TranscriptScanResult {
  average: number | null;
  sampleSize: number;
  partial: boolean;
}
