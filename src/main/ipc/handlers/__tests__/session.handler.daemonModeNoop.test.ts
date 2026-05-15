import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase A — A6. session.handler must short-circuit scrollback:dump AND
// scrollback:load when the live `isDaemonConnected` getter returns true.
// We verify the contract at the source level — actually exercising the
// handler requires Electron's ipcMain and a real BrowserWindow, which a
// vitest process cannot bootstrap.
describe('A6 — session.handler daemon-mode short-circuit (source-level)', () => {
  const handlerPath = path.join(__dirname, '..', 'session.handler.ts');
  const src = fs.readFileSync(handlerPath, 'utf-8');

  it('registerSessionHandlers accepts an isDaemonConnected getter parameter', () => {
    expect(src).toMatch(
      /export function registerSessionHandlers\(\s*isDaemonConnected:\s*\(\s*\)\s*=>\s*boolean/,
    );
  });

  it('parameter defaults to () => false so local-only callers stay safe', () => {
    expect(src).toMatch(/isDaemonConnected:\s*\(\s*\)\s*=>\s*boolean\s*=\s*\(\s*\)\s*=>\s*false/);
  });

  it('scrollback:dump handler short-circuits when daemon is connected', () => {
    // Slice the dump handler body. The marker `// scrollback:dump` opens
    // the registration. The body extends until the next `// scrollback:load`
    // marker comment.
    const start = src.indexOf('// scrollback:dump');
    const end = src.indexOf('// scrollback:load');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // Guard must be the first behavioural branch (before validation, write).
    expect(body).toMatch(/if\s*\(\s*isDaemonConnected\(\)\s*\)\s*\{[\s\S]*?return\s*\{\s*success:\s*true[\s\S]*?skipped:\s*true/);
  });

  it('scrollback:load handler returns null when daemon is connected', () => {
    const start = src.indexOf('// scrollback:load');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    // The first guard in the load handler returns null on daemon mode so
    // the renderer skips its .txt restore branch.
    expect(body).toMatch(/if\s*\(\s*isDaemonConnected\(\)\s*\)\s*\{[\s\S]*?return\s+null/);
  });
});
