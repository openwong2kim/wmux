import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source locks for the two useTerminal branches only the browser build takes.
// Both are keyed on something the desktop never has (the clipboard bridge's
// `nativePaste`, the `fixedGeometry` option), which is what keeps the desktop
// unchanged; these pin that keying.
// Checked out with CRLF on Windows runners: compare with LF.
const src = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8').replace(/\r\n/g, '\n');

describe('browser build: paste through the browser', () => {
  it('each clipboard-reading paste chord steps aside when the bridge pastes natively', () => {
    const branches = [
      "(e.key === 'v' || e.code === 'KeyV')) {\n        if (nativePaste) return false;\n        e.preventDefault();",
      "resolveCtrlLetterByte(e) === '\\x16') {\n        if (nativePaste) return false;\n        e.preventDefault();",
      "(e.key === 'V' || e.code === 'KeyV')) {\n        if (nativePaste) return false;\n        e.preventDefault();",
    ];
    for (const b of branches) expect(src).toContain(b);
    expect(src).toMatch(/const nativePaste = \(window\.clipboardAPI as \{ nativePaste\?: boolean \} \| undefined\)\?\.nativePaste === true;/);
  });
});

describe('browser build: a snapshot replay is the keyboard negotiation to fold', () => {
  it('folds replays only for a fixedGeometry viewer, from the initial state', () => {
    const start = src.indexOf('if (!payload.replay) noteKeyboard(payload.data);');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 500);
    expect(block).toMatch(/else if \(fixedGeometryRef\.current\) \{/);
    expect(block).toMatch(/keyboardRef\.current = INITIAL_REMOTE_KEYBOARD_STATE;\s*\n\s*noteKeyboard\(payload\.data\);/);
  });

  it('the win32-input trust follows the pane host, falling back to the local platform', () => {
    expect(src).toMatch(/hostPlatform\?\.\(\) \?\? window\.electronAPI\.platform/);
    expect(src).toMatch(/foldRemoteKeyboardState\(keyboardRef\.current, data, foldOpts\(\)\)/);
  });
});
