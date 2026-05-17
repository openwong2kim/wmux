import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariants for the scrollback-restore latency / loss
// instrumentation added 2026-05-17 in response to user dogfood: after a
// wmux restart the previous session's xterm history is empty even though
// daemon-mode skips the .txt restore branch and relies on the daemon
// SessionPipe replay.
//
// The investigation has three measurement points along the chain:
//
//   shutdown:  Suspended session <id> (buffer: <bytes>)          (pre-existing)
//   startup:   [recovery] session <id> dump=<path> bytes=<bytes> (new)
//   attach:    [SessionPipe.flush] sessionId=<id> bytes=<bytes>  (new)
//
// All three printing bytes=N means the chain is intact and the renderer
// or terminal layer ate the bytes. If startup drops, the .buf file was
// missing or empty. If attach drops, the renderer attach raced the
// recovery write and we flushed before RingBuffer was repopulated.

describe('scrollback restore — chain instrumentation', () => {
  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
  const sessionPipePath = path.join(__dirname, '..', 'SessionPipe.ts');
  const daemonIndexSrc = fs.readFileSync(daemonIndexPath, 'utf-8');
  const sessionPipeSrc = fs.readFileSync(sessionPipePath, 'utf-8');

  it('logs recovery .buf bytes adjacent to the read so the size matches what becomes scrollbackData', () => {
    // The log must come AFTER the readFileSync that produced scrollbackData
    // and BEFORE the createSession call that consumes it — otherwise the
    // bytes we print are not the bytes we hand off.
    const readMatch = daemonIndexSrc.indexOf("fs.readFileSync(session.bufferDumpPath)");
    expect(readMatch).toBeGreaterThan(0);

    const recoveryLogMatch = daemonIndexSrc.indexOf("[recovery] session");
    expect(recoveryLogMatch).toBeGreaterThan(readMatch);

    const createSessionAfter = daemonIndexSrc.indexOf(
      'sessionManager.createSession(',
      recoveryLogMatch,
    );
    expect(createSessionAfter).toBeGreaterThan(recoveryLogMatch);

    // The log line must include the byte count of scrollbackData so a
    // size-0 dump shows up immediately.
    const recoverySnippet = daemonIndexSrc.slice(
      recoveryLogMatch,
      recoveryLogMatch + 400,
    );
    expect(recoverySnippet).toMatch(/bytes=\$\{scrollbackData\?\.length/);
    expect(recoverySnippet).toMatch(/exists=\$\{scrollbackData/);
  });

  it('logs SessionPipe flush bytes from the same readAll() result we send on the wire', () => {
    // The log must reference `buffered.length`, not `this.ringBuffer.size`,
    // so the printed number is what actually went down the socket — even
    // if a future refactor changes the readAll() path.
    const flushLog = sessionPipeSrc.indexOf('[SessionPipe.flush]');
    expect(flushLog).toBeGreaterThan(0);

    const readAllMatch = sessionPipeSrc.indexOf('this.ringBuffer.readAll()');
    expect(readAllMatch).toBeGreaterThan(0);
    // The log comes after we computed `buffered` from readAll() and
    // before the conditional socket.write that actually emits the bytes.
    expect(flushLog).toBeGreaterThan(readAllMatch);

    const flushSnippet = sessionPipeSrc.slice(flushLog, flushLog + 200);
    expect(flushSnippet).toMatch(/bytes=\$\{buffered\.length\}/);
    expect(flushSnippet).toMatch(/sessionId=\$\{this\.sessionId\}/);
  });

  it('keeps the shutdown-side buffer-bytes log intact (the chain depends on all three points)', () => {
    // Log format: 'Suspended session ${managed.meta.id} (buffer: ${N} bytes)'
    // where N is either ${managed.ringBuffer.size} (legacy) or ${sizeAtDump}
    // (Fix 0 round 3 — captured before dumpToFile to avoid TOCTOU). Either
    // expression is acceptable as long as the line carries the byte count
    // so it stays cross-checkable against the recovery + flush points.
    expect(daemonIndexSrc).toMatch(
      /Suspended session \$\{managed\.meta\.id\}[\s\S]*?buffer:\s*\$\{(managed\.ringBuffer\.size|sizeAtDump)\}\s*bytes/,
    );
  });
});
