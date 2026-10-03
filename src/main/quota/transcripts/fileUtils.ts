import * as path from 'path';
import * as fs from 'fs';
import type { FsStatLike, TranscriptScanDeps } from './types';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 20;
const MAX_DEPTH = 6;

export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
}

export class BoundedLineReader {
  public readonly maxLineBytes: number;
  public maxBufferedBytes = 0;
  public currentBufferedBytes = 0;

  constructor(maxLineBytes = 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
  }

  get maxBufferedLength(): number {
    return this.maxBufferedBytes;
  }

  async *readLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string, void, unknown> {
    let currentBuffers: Buffer[] = [];
    this.currentBufferedBytes = 0;
    let discardingCurrentLine = false;

    for await (const rawChunk of stream) {
      const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf8') : rawChunk;
      let offset = 0;

      while (offset < chunk.length) {
        if (discardingCurrentLine) {
          const newlineIndex = chunk.indexOf(0x0a, offset);
          if (newlineIndex === -1) {
            offset = chunk.length;
          } else {
            discardingCurrentLine = false;
            offset = newlineIndex + 1;
          }
          continue;
        }

        const newlineIndex = chunk.indexOf(0x0a, offset);
        if (newlineIndex === -1) {
          const sliceLen = chunk.length - offset;
          if (this.currentBufferedBytes + sliceLen > this.maxLineBytes) {
            discardingCurrentLine = true;
            currentBuffers = [];
            this.currentBufferedBytes = 0;
            offset = chunk.length;
          } else {
            const slice = chunk.subarray(offset, chunk.length);
            currentBuffers.push(slice);
            this.currentBufferedBytes += sliceLen;
            if (this.currentBufferedBytes > this.maxBufferedBytes) {
              this.maxBufferedBytes = this.currentBufferedBytes;
            }
            offset = chunk.length;
          }
        } else {
          const sliceLen = newlineIndex - offset;
          if (this.currentBufferedBytes + sliceLen > this.maxLineBytes) {
            currentBuffers = [];
            this.currentBufferedBytes = 0;
            discardingCurrentLine = false;
            offset = newlineIndex + 1;
          } else {
            const slice = chunk.subarray(offset, newlineIndex);
            currentBuffers.push(slice);
            this.currentBufferedBytes += sliceLen;
            if (this.currentBufferedBytes > this.maxBufferedBytes) {
              this.maxBufferedBytes = this.currentBufferedBytes;
            }

            let lineBuf = Buffer.concat(currentBuffers, this.currentBufferedBytes);
            if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
              lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
            }
            const line = lineBuf.toString('utf8');

            currentBuffers = [];
            this.currentBufferedBytes = 0;
            offset = newlineIndex + 1;

            yield line;
          }
        }
      }
    }

    if (!discardingCurrentLine && currentBuffers.length > 0) {
      if (this.currentBufferedBytes <= this.maxLineBytes) {
        let lineBuf = Buffer.concat(currentBuffers, this.currentBufferedBytes);
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        const line = lineBuf.toString('utf8');
        currentBuffers = [];
        this.currentBufferedBytes = 0;
        yield line;
      } else {
        currentBuffers = [];
        this.currentBufferedBytes = 0;
      }
    }
  }
}

export async function findRecentJsonlFiles(
  dir: string,
  deps: TranscriptScanDeps,
  startTime: number,
  budget: number,
): Promise<{ files: DiscoveredFile[]; timedOut: boolean }> {
  const nowFn = deps.now ?? Date.now;
  const readdirFn =
    deps.readdir ??
    (async (p: string) => fs.promises.readdir(p, { withFileTypes: true }));
  const lstatFn = deps.lstat ?? deps.stat ?? (async (p: string) => fs.promises.lstat(p));

  const files: DiscoveredFile[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  const nowMs = nowFn();
  const minMtime = nowMs - SEVEN_DAYS_MS;

  try {
    const rootSt = await lstatFn(dir);
    if (typeof rootSt.isSymbolicLink === 'function' && rootSt.isSymbolicLink()) {
      return { files: [], timedOut: false };
    }
  } catch {
    // If lstat fails, allow readdir to attempt reading or fail cleanly
  }

  while (queue.length > 0) {
    if (nowFn() - startTime >= budget) {
      return { files: sortAndLimitFiles(files), timedOut: true };
    }

    const item = queue.shift()!;
    let entries: (string | fs.Dirent)[] = [];
    try {
      entries = await readdirFn(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (nowFn() - startTime >= budget) {
        return { files: sortAndLimitFiles(files), timedOut: true };
      }

      if (
        typeof entry !== 'string' &&
        typeof entry.isSymbolicLink === 'function' &&
        entry.isSymbolicLink()
      ) {
        continue;
      }

      const name = typeof entry === 'string' ? entry : entry.name;
      const fullPath = path.join(item.dir, name);

      let st: FsStatLike;
      try {
        st = await lstatFn(fullPath);
      } catch {
        continue;
      }

      if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
        continue;
      }
      if (!st.isDirectory() && !st.isFile()) {
        continue;
      }

      if (st.isDirectory()) {
        if (item.depth < MAX_DEPTH) {
          queue.push({ dir: fullPath, depth: item.depth + 1 });
        }
      } else if (st.isFile() && name.endsWith('.jsonl')) {
        const mtimeMs =
          typeof st.mtimeMs === 'number'
            ? st.mtimeMs
            : st.mtime
              ? new Date(st.mtime).getTime()
              : 0;

        if (mtimeMs >= minMtime) {
          files.push({ path: fullPath, mtimeMs });
        }
      }
    }
  }

  return { files: sortAndLimitFiles(files), timedOut: false };
}

function sortAndLimitFiles(files: DiscoveredFile[]): DiscoveredFile[] {
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}
