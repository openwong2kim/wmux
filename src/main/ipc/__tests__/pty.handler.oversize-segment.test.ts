import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regression test for the chronic "front of paste disappears" bug.
 *
 * Symptom (reported repeatedly across releases, finally diagnosed v2.9.1):
 *   Pasting multi-line text into a PTY pane lost the leading portion of
 *   the paste — typically the first few lines vanished and the remainder
 *   appeared on a fresh prompt. Right-click paste and Shift+Insert paste
 *   were also affected. The corruption was non-deterministic and worse on
 *   PowerShell / Claude Code TUI panes.
 *
 * Root cause:
 *   Three compounding bugs in the renderer paste pipeline, plus one in
 *   main. The main-side bug — the only one this test guards — was that
 *   `pty:write` silently dropped any payload over 100KB:
 *
 *     if (data.length > 100_000) {
 *       console.warn(...);
 *       return;   // ← silent drop, renderer never knows
 *     }
 *
 *   Renderer-side chunking (`clipboardChunk.ts`) kept normal paste under
 *   the limit, but any code path that bypassed the chunker — drag-drop
 *   joins, command palette replay of pasted history, xterm's native
 *   paste path via `terminal.onData`, future MCP write paths — could
 *   hit the silent drop and lose user data. The renderer used
 *   `ipcRenderer.send` (fire-and-forget), so there was no error surfaced
 *   either.
 *
 * Fix:
 *   Main now segments oversize payloads locally and forwards every byte.
 *   The 100KB threshold becomes a "warn-and-segment" boundary, not a
 *   drop boundary. A separate 10MB hard limit guards against true
 *   denial-of-service payloads (those still get refused, but logged
 *   loudly via console.error so the caller is visible). Renderer
 *   chunking remains the primary path; main-side segmentation is
 *   defense-in-depth for callers that bypass it.
 *
 * This test is structural: it scans `pty.handler.ts` and fails if a
 * future refactor reintroduces the silent drop. Behavioral coverage of
 * the segment math itself lives in `clipboardChunk.test.ts`
 * (`splitSurrogateSafe`); main and renderer share the same surrogate-
 * safety invariant, but the runtime path is hard to exercise without a
 * mocked DaemonClient + PTYManager.
 */
describe('pty.handler PTY_WRITE oversize segmentation (paste-truncation fix)', () => {
  const handlerPath = path.join(__dirname, '..', 'handlers', 'pty.handler.ts');
  const source = fs.readFileSync(handlerPath, 'utf-8');

  /**
   * Narrow to the PTY_WRITE handler region so assertions don't match
   * unrelated text elsewhere in the file (e.g. similarly-named PTY_RESIZE
   * retry constants, comments referencing prior fixes).
   */
  function writeBlock(): string {
    const match = source.match(
      /\/\/\s*pty:write[\s\S]*?ipcMain\.removeHandler\(IPC\.PTY_RESIZE\)/,
    );
    if (!match) {
      throw new Error(
        'pty:write handler region not found in pty.handler.ts. ' +
          'If the file layout changed, update the regex above before assuming ' +
          'the segmentation logic is gone.',
      );
    }
    return match[0];
  }

  it('declares the segmentation constants at module scope', () => {
    // If this fires, a future change removed or renamed the constants.
    // Without them the handler reverts to silent drops on oversize
    // writes — the exact regression that caused "front of paste
    // disappears" across multiple releases.
    expect(source).toMatch(/const\s+PTY_WRITE_BACKSTOP\s*=\s*100_?000\b/);
    expect(source).toMatch(/const\s+PTY_WRITE_BACKSTOP_CHUNK_SIZE\s*=\s*8_?192\b/);
    expect(source).toMatch(/const\s+PTY_WRITE_HARD_LIMIT\s*=\s*10_?000_?000\b/);
  });

  it('defines a segmentOversize helper that returns chunks instead of dropping', () => {
    expect(source).toMatch(/function\s+segmentOversize\s*\(/);
    // The helper must produce an array — single-item for payloads at or
    // under the backstop, multi-item for oversize. Returning `void` or
    // `undefined` would mean we dropped data.
    expect(source).toMatch(/function\s+segmentOversize[\s\S]+?return\s+out\s*;/);
    // And the short-circuit return for under-backstop payloads must
    // also return the data as a single-element array — not drop it.
    expect(source).toMatch(/return\s+\[data\]/);
  });

  it('segmentOversize avoids splitting UTF-16 surrogate pairs', () => {
    // Surrogate-safe boundary backoff: if the last code unit in a chunk
    // is a high surrogate (0xD800-0xDBFF) AND there is more data after,
    // back the boundary off by one so the pair stays whole. Without this
    // an emoji at the boundary turns into U+FFFD on the wire — visually
    // indistinguishable from "the paste lost characters".
    expect(source).toMatch(/0xd800/i);
    expect(source).toMatch(/0xdbff/i);
  });

  it('local-mode handler segments oversize payloads instead of dropping', () => {
    const block = writeBlock();
    // The local-mode path (no daemon) must call segmentOversize and
    // iterate. A bare `if (data.length > 100_000) return;` shape would
    // re-introduce the silent drop.
    expect(block).toMatch(/segmentOversize\(data\)/);
    // No early return on the backstop length any more — only on the
    // hard limit and on the type guard.
    expect(block).not.toMatch(/data\.length\s*>\s*100_?000\s*\)\s*\{\s*console\.warn[\s\S]{0,200}return;/);
  });

  it('daemon-mode handler segments oversize payloads instead of dropping', () => {
    const block = writeBlock();
    // The daemon-mode branch (writeToSession) must also segment — it was
    // the path taken when running with the v2.9.0 daemon, so a fix that
    // only covered local-mode would still leak the bug in production.
    expect(block).toMatch(/daemonClient\.writeToSession\(id,\s*sanitizePtyText\(segment\)\)/);
  });

  it('warns on oversize but does not drop until the hard limit', () => {
    const block = writeBlock();
    // The backstop should produce a warn line — devs need to know that
    // a renderer path is bypassing chunking — but the data still flows
    // through segmentOversize. The hard limit error message must use
    // console.error (louder than warn) since that genuinely drops data.
    expect(block).toMatch(/console\.warn\([^)]*oversize payload/);
    expect(block).toMatch(/console\.error\([^)]*hard limit/);
  });

  it('hard-limit guard refuses payloads above PTY_WRITE_HARD_LIMIT', () => {
    const block = writeBlock();
    // The 10MB ceiling is a denial-of-service guard, not a paste guard.
    // It must still drop (and log loudly) — keeping it lets the handler
    // resist a misbehaving MCP or bug that loops a write call.
    expect(block).toMatch(/data\.length\s*>\s*PTY_WRITE_HARD_LIMIT/);
  });

});
