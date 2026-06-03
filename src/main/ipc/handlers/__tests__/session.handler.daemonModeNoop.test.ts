import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Daemon scrollback restore (commit "Fix daemon scrollback restore for TUI
// redraws"). The earlier A6 design short-circuited scrollback:dump AND
// scrollback:load whenever the live `isDaemonConnected` getter returned true,
// leaving daemon RingBuffer replay as the sole restore path. Dogfooding showed
// raw daemon bytes do not reliably repaint full-screen TUIs (Codex, Claude
// Code, vim), so the rendered snapshot is now the UI recovery source and the
// daemon replay is the fallback. These source-level assertions lock the
// short-circuit OUT so it cannot silently return — actually exercising the
// handler needs Electron's ipcMain + a real BrowserWindow, which a vitest
// process cannot bootstrap.
describe('session.handler daemon-mode scrollback (short-circuit removed)', () => {
  const handlerPath = path.join(__dirname, '..', 'session.handler.ts');
  const src = fs.readFileSync(handlerPath, 'utf-8');

  it('keeps the daemon getter param for register-site compatibility but leaves it unused', () => {
    // The param is retained so callers in main/index.ts need no change, but it
    // is underscore-prefixed to mark it intentionally unused.
    expect(src).toMatch(
      /export function registerSessionHandlers\(\s*_isDaemonConnected:\s*\(\s*\)\s*=>\s*boolean/,
    );
  });

  it('param defaults to () => false so local-only callers stay safe', () => {
    expect(src).toMatch(/_isDaemonConnected:\s*\(\s*\)\s*=>\s*boolean\s*=\s*\(\s*\)\s*=>\s*false/);
  });

  it('scrollback:dump no longer short-circuits when daemon is connected', () => {
    const start = src.indexOf('// scrollback:dump');
    const end = src.indexOf('// scrollback:load');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // No daemon-mode bail-out: the snapshot must still be written so the
    // rendered transcript survives across restarts.
    expect(body).not.toMatch(/if\s*\(\s*isDaemonConnected\(\)\s*\)/);
    expect(body).not.toMatch(/skipped:\s*true/);
    // First behavioural branch is the path-traversal guard on surfaceId.
    expect(body).toMatch(/if\s*\(!\/\^\[a-zA-Z0-9-\]\+\$\/\.test\(surfaceId\)\)\s*return\s*\{\s*success:\s*false/);
  });

  it('scrollback:load no longer returns null when daemon is connected', () => {
    const start = src.indexOf('// scrollback:load');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    // No daemon-mode bail-out: the load handler must surface the rendered
    // snapshot so the renderer can repaint TUIs from it.
    expect(body).not.toMatch(/if\s*\(\s*isDaemonConnected\(\)\s*\)\s*\{[\s\S]*?return\s+null/);
    expect(body).toMatch(/if\s*\(!\/\^\[a-zA-Z0-9-\]\+\$\/\.test\(surfaceId\)\)\s*return\s*null/);
  });
});
