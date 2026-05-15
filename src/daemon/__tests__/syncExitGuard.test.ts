import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A4 — precise sync exit guard.
//
// The Windows process.on('exit') handler used to gate on `shuttingDown`
// (set on entry to async shutdown), which would skip the sync save even if
// the async path was interrupted before its dumps completed — a silent
// data-loss path. A4 replaces that with `dumpsCompleted`, flipped to true
// only after the async shutdown body's Promise.all(dumpToFile) resolves.
//
// We assert these invariants at the source level rather than spawning a
// real daemon (codex P1 from A1b — importing src/daemon/index.ts triggers
// main() at module load, which would lock the test process).
describe('A4 — sync exit handler guard (source-level invariants)', () => {
  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(daemonIndexPath, 'utf-8');

  it('declares the dumpsCompleted module flag', () => {
    expect(src).toMatch(/let dumpsCompleted = false;/);
  });

  it('flips dumpsCompleted=true after Promise.all(dumpPromises) in shutdown()', () => {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => /^async function shutdown\(/.test(l));
    expect(start, 'shutdown() definition not found').toBeGreaterThanOrEqual(0);
    const body = lines.slice(start, start + 200).join('\n');
    // Pattern: `await Promise.all(dumpPromises);` followed by the flip.
    expect(body).toMatch(/await\s+Promise\.all\(dumpPromises\);[\s\S]*?dumpsCompleted\s*=\s*true/);
  });

  it('Windows exit handler short-circuits when dumpsCompleted is true', () => {
    // Locate the actual process.on('exit') call site (the only one in the
    // file); slicing from a generic win32 platform check would catch the
    // first of five hits.
    const exitIdx = src.indexOf("process.on('exit',");
    expect(exitIdx, "process.on('exit') not found").toBeGreaterThanOrEqual(0);
    const exitBlock = src.slice(exitIdx, exitIdx + 2000);
    expect(exitBlock).toMatch(/if\s*\(\s*dumpsCompleted\s*\)\s*return;/);
  });

  it('Windows exit handler uses dumpToFileSyncAtomic (replaced bare writeFileSync)', () => {
    const exitIdx = src.indexOf("process.on('exit',");
    const exitBlock = src.slice(exitIdx, exitIdx + 2000);
    expect(exitBlock).toMatch(/m\.ringBuffer\.dumpToFileSyncAtomic\(dumpPath\)/);
    // Negative: no leftover bare writeFileSync on dumpPath inside the block.
    expect(exitBlock).not.toMatch(/fs\.writeFileSync\(\s*dumpPath/);
  });

  it('main() sweeps stale tmp dumps via RingBuffer.cleanupStaleTmpFiles at startup', () => {
    expect(src).toMatch(/RingBuffer\.cleanupStaleTmpFiles\(\s*stateWriter\.getBufferDir\(\)\s*\)/);
  });
});
