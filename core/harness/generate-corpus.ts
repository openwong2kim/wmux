// E0 conformance harness — corpus generation (spec: engine-core-decision-2026-07-09.md §5-1)
//
// Records 5 synthetic workloads to produce core/harness/corpus/{name}/{recording.bin,events.jsonl,meta.json}.
// Deterministic — reruns yield the same bytes (verify via meta.json workloadHash).
//
// Run: npm run harness:gen-corpus (vitest runner calls generateCorpus in this module).
// Committed corpus is synthetic 5 only (D4 governance). Real CLI workloads are not committed.
//
// Reuses vitest as the runner to avoid adding a tsx dependency (tsconfig.harness + vitest run in
// a CJS context where __dirname exists). Do not use import.meta.

import path from 'node:path';
import { record, writeRecording } from './recorder';
import { WORKLOADS } from './workloads';

/** Committed corpus directory (corpus/ relative to this file). */
export const CORPUS_DIR = path.join(__dirname, 'corpus');

/** Record 5 synthetic workloads into CORPUS_DIR. Returns list of created case directories. */
export async function generateCorpus(outDir: string = CORPUS_DIR): Promise<string[]> {
  const seed = 0; // Synthetic workloads are seed-independent but record seed in meta for reproducibility.
  const dirs: string[] = [];
  for (const w of WORKLOADS) {
    const result = await record(w, seed);
    const dir = writeRecording(outDir, result);
    dirs.push(dir);
    // eslint-disable-next-line no-console
    console.log(
      `[gen-corpus] ${w.name}: ${result.bytes.length}B → ${path.relative(process.cwd(), dir)} (sha256=${result.meta.workloadHash.slice(0, 16)}…)`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[gen-corpus] done — generated ${WORKLOADS.length} corpus cases.`);
  return dirs;
}
