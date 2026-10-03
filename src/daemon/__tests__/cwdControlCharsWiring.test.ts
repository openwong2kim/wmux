// #1729 — the daemon must never store a cwd carrying a control character: a
// wrapped prompt or a percent-decoded OSC 7 can deliver one, and a WSL pane
// whose stored cwd holds a line break cannot be recovered. The check sits in
// DaemonSessionManager's bridge 'cwd' handler, which a unit test cannot reach
// without a PTY; this asserts the guard runs before the value is stored.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('cwd control-character guard wiring (#1729)', () => {
  it('rejects a control-character cwd before storing it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'DaemonSessionManager.ts'), 'utf-8');
    const handler = src.indexOf("bridge.on('cwd'");
    expect(handler).toBeGreaterThan(-1);
    const guard = src.indexOf('if (containsControlChars(payload.cwd)) return;', handler);
    const store = src.indexOf('meta.cwd = payload.cwd;', handler);
    expect(guard).toBeGreaterThan(handler);
    expect(store).toBeGreaterThan(guard);
  });
});
