import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * #1256 — live terminal binding for the floating overlay consumers.
 *
 * ScrollToBottomButton and BookmarkIndicator receive the xterm instance as a
 * prop and subscribe (onScroll/onWriteParsed/onResize) against whatever they
 * were handed at render time. useTerminal populates its ref by mutation
 * inside the mount effect — fresh creation and adoption both — with no
 * re-render to follow, so a render-time `terminalRef.current` snapshot stays
 * null (button never mounts its subscriptions, clicks no-op) or goes stale
 * (subscriptions target a detached instance). The fix publishes the instance
 * as state (`terminalInstance`); this pins that Terminal.tsx binds the state,
 * not the ref snapshot.
 */
describe('Terminal.tsx — overlay consumers bind the state-published instance (#1256)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Terminal.tsx'), 'utf-8');

  it('ScrollToBottomButton receives terminalInstance, never a ref snapshot', () => {
    expect(src).toMatch(/<ScrollToBottomButton terminal=\{terminalInstance\} \/>/);
    expect(src).not.toMatch(/<ScrollToBottomButton terminal=\{terminalRef\.current\}/);
  });

  it('BookmarkIndicator receives terminalInstance, never a ref snapshot', () => {
    expect(src).toMatch(/<BookmarkIndicator\s+terminal=\{terminalInstance\}/);
    expect(src).not.toMatch(/<BookmarkIndicator\s+terminal=\{terminalRef\.current\}/);
  });

  it('the instance comes from useTerminal state and the vi-copy gate uses it too', () => {
    expect(src).toMatch(/const \{ terminal: terminalRef, terminalInstance,/);
    expect(src).toMatch(/showViCopyMode = viCopyModeActive && isActive && terminalInstance !== null/);
    expect(src).not.toMatch(/terminalRef\.current !== null/);
  });
});
