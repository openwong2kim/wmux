// F26 — `daemon.writeIfUnchanged`: the compare against the live session and
// the PTY write are one synchronous step.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PromptEventLog } from '../PromptEventLog';
import { parseWriteExpectation, writeIfUnchanged, type WriteExpectation } from '../writeIfUnchanged';

function session() {
  const ring = { totalBytesWritten: 180 };
  const promptLog = new PromptEventLog();
  promptLog.append({ type: 'command_end', ts: 1, byteOffset: 40, exitCode: 0 });
  promptLog.append({ type: 'prompt_start', ts: 1, byteOffset: 40 });
  promptLog.append({ type: 'prompt_end', ts: 1, byteOffset: 180 });
  const write = vi.fn();
  return { ring, promptLog, write, live: { ringBuffer: ring, promptLog, write } };
}

/** What main took from its snapshot of the pane. */
function snapshot(s: ReturnType<typeof session>): WriteExpectation {
  const last = s.promptLog.recent(1)[0];
  return {
    outputBytes: s.ring.totalBytesWritten,
    markerCount: s.promptLog.size,
    lastPromptMarker: last ? { type: last.type, byteOffset: last.byteOffset } : null,
  };
}

describe('writeIfUnchanged', () => {
  it('writes when the session is as the caller saw it', () => {
    const s = session();
    expect(writeIfUnchanged(s.live, 'claude\r', snapshot(s))).toBe(true);
    expect(s.write).toHaveBeenCalledWith('claude\r');
  });

  it('does not write when output arrived after the snapshot (the echo of the first line)', () => {
    const s = session();
    const expectation = snapshot(s);
    s.ring.totalBytesWritten += 60;
    expect(writeIfUnchanged(s.live, 'claude\r', expectation)).toBe(false);
    expect(s.write).not.toHaveBeenCalled();
  });

  it('does not write when a marker arrived after the snapshot, the output size unchanged', () => {
    const s = session();
    const expectation = snapshot(s);
    s.promptLog.append({ type: 'command_start', ts: 2, byteOffset: 180 });
    expect(writeIfUnchanged(s.live, 'claude\r', expectation)).toBe(false);
    expect(s.write).not.toHaveBeenCalled();
  });

  it('does not write on a different last marker', () => {
    const s = session();
    expect(writeIfUnchanged(s.live, 'x\r', { ...snapshot(s), lastPromptMarker: { type: 'prompt_end', byteOffset: 120 } })).toBe(false);
    expect(writeIfUnchanged(s.live, 'x\r', { ...snapshot(s), lastPromptMarker: null })).toBe(false);
    expect(s.write).not.toHaveBeenCalled();
  });

  it('parses only a well-formed expectation', () => {
    expect(parseWriteExpectation({ outputBytes: 1, markerCount: 0, lastPromptMarker: null })).toEqual({
      outputBytes: 1,
      markerCount: 0,
      lastPromptMarker: null,
    });
    expect(parseWriteExpectation({ outputBytes: 1, markerCount: 3, lastPromptMarker: { type: 'prompt_end', byteOffset: 9 } })).not.toBeNull();
    expect(parseWriteExpectation(null)).toBeNull();
    expect(parseWriteExpectation({ outputBytes: '1', markerCount: 0, lastPromptMarker: null })).toBeNull();
    expect(parseWriteExpectation({ outputBytes: 1, markerCount: 0 })).toBeNull();
    expect(parseWriteExpectation({ outputBytes: 1, markerCount: 0, lastPromptMarker: { type: 1, byteOffset: 9 } })).toBeNull();
  });
});

// Source-shape guard: the handler is a closure inside the daemon's RPC
// registration (same pattern as launchPresence.test.ts).
describe('daemon.writeIfUnchanged wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');
  const at = src.indexOf("pipeServer.onRpc('daemon.writeIfUnchanged'");
  const body = src.slice(at, src.indexOf('\n  });', at));

  it('compares the live session and writes to its PTY in the same call', () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toMatch(/ringBuffer: managed\.ringBuffer,\s*promptLog: managed\.promptLog,/);
    expect(body).toMatch(/managed\.ptyProcess\.write\(input\);\s*managed\.bridge\.noteInput\(input\);/);
    // Nothing awaited between the session lookup and the write.
    expect(body.slice(body.indexOf('const managed'))).not.toMatch(/await /);
  });
});
