/**
 * X6 ③ / U-PERM — permission-mode capture from the transcript tail.
 *
 * Incident (2026-07-02, U-PERM dogfood): a bypassPermissions session's resume
 * binding persisted with NO permissionMode, so the resume pill could not
 * re-offer bypass after the reboot. Two compounding causes:
 *   1. Inline `"permissionMode"` stamps ride USER turns only, and a single
 *      large attachment record (85KB observed) pushed the last stamped user
 *      turn out of the extractor's bounded 64KB tail read.
 *   2. Current Claude Code also writes a dedicated
 *      `{"type":"permission-mode","permissionMode":"..."}` record within a few
 *      KB of the tail on every prompt — but the extractor only recognized
 *      `type:"user"`, so it walked right past it.
 * The fix teaches the extractor the dedicated record. These tests run the REAL
 * bridge function: the CLI entrypoint is stripped (main() runs at module top
 * level and would read stdin) and the extractor re-exported from a temp copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let extract: (transcriptPath: string) => string | null;

function fixture(name: string, lines: unknown[]): string {
  const p = path.join(tmp, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-pm-'));
  const src = readFileSync(BRIDGE_PATH, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut).toBeGreaterThan(-1);
  // Strip the shebang — vite's transform (which intercepts even runtime
  // dynamic imports under vitest) rejects it with a SyntaxError on Windows.
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { extractPermissionModeFromTranscript };\n';
  const mod = path.join(tmp, 'bridge-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ extractPermissionModeFromTranscript: extract } = await import(pathToFileURL(mod).href));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('extractPermissionModeFromTranscript', () => {
  it('reads the dedicated permission-mode record (current Claude Code format)', () => {
    const p = fixture('dedicated.jsonl', [
      { type: 'mode', mode: 'normal', sessionId: 's1' },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's1' },
      { type: 'assistant', message: { usage: { input_tokens: 1 } } },
    ]);
    expect(extract(p)).toBe('bypassPermissions');
  });

  it('still reads the inline user-turn stamp (older format, back-compat)', () => {
    const p = fixture('inline.jsonl', [
      { type: 'user', permissionMode: 'acceptEdits', message: {} },
      { type: 'assistant', message: {} },
    ]);
    expect(extract(p)).toBe('acceptEdits');
  });

  it('most recent record wins across both shapes (mode changes mid-session)', () => {
    const p = fixture('both.jsonl', [
      { type: 'user', permissionMode: 'bypassPermissions', message: {} },
      { type: 'assistant', message: {} },
      { type: 'permission-mode', permissionMode: 'plan', sessionId: 's1' },
    ]);
    expect(extract(p)).toBe('plan');
  });

  it('incident shape: dedicated tail record survives a huge attachment that evicts the user stamp from the 64KB window', () => {
    // Mirrors the real 2026-07-02 transcript: stamped user turn at the file
    // start, an attachment record far larger than the tail window, then the
    // per-prompt metadata block (incl. the dedicated record) at the tail.
    const p = fixture('incident.jsonl', [
      { type: 'user', permissionMode: 'bypassPermissions', message: {} },
      { type: 'attachment', data: 'x'.repeat(80 * 1024) },
      { type: 'last-prompt', lastPrompt: 'hi', sessionId: 's1' },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's1' },
      { type: 'assistant', message: {} },
    ]);
    expect(extract(p)).toBe('bypassPermissions');
  });

  it('ignores unknown mode values and keeps walking to an older valid record', () => {
    const p = fixture('unknown.jsonl', [
      { type: 'permission-mode', permissionMode: 'default', sessionId: 's1' },
      { type: 'permission-mode', permissionMode: 'someFutureMode', sessionId: 's1' },
    ]);
    expect(extract(p)).toBe('default');
  });

  it('returns null when no recognizable record exists', () => {
    const p = fixture('none.jsonl', [
      { type: 'assistant', message: {} },
      { type: 'system', content: 'x' },
    ]);
    expect(extract(p)).toBeNull();
  });
});
