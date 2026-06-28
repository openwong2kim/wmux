// @vitest-environment jsdom
//
// DOM glue harness for `useTerminalCopyShortcut` — the thin document-level
// capture-phase Ctrl+C listener around the pure, separately-tested
// `resolveCopyTarget`. The pure verdict logic is exhaustively covered in
// utils/__tests__/resolveCopyTarget.test.ts; this file pins the parts that ONLY
// live in the hook and have no node-level test:
//   • the visibility gate that excludes offscreen/unmounted terminals whose
//     xterm selection is stale (consensus P2 — copying an unseen selection
//     clobbered the clipboard + toasted),
//   • the `e.repeat` auto-repeat guard (a held Ctrl+C must act once),
//   • the live DOM → snapshot wiring and the act/yield side effects
//     (copySelectionWithFeedback + preventDefault) that prove the glue reaches
//     the copy path at all — the previously untested "hook glue" gap.
//
// `@testing-library/react` is not a dependency, so the hook is mounted via a
// trivial harness component through react-dom/client createRoot + React.act,
// matching the repo's existing jsdom tests (see Browser/__tests__).
//
// `terminalRegistry` / `copySelectionWithFeedback` / `resolveActivePanePtyId`
// are stubbed via vi.mock so the test owns the live "DOM" the hook reads:
// fake terminals carry a real <div> whose checkVisibility() we drive directly
// (jsdom has no layout — offsetParent is always null and checkVisibility is
// absent — so we stub it to exercise the visible/hidden branches deterministically).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** xterm `Terminal` stand-in: only the members the hook actually touches. */
interface FakeTerminal {
  getSelection: () => string;
  element?: HTMLElement;
}

// Hoisted mock state, shared with the vi.mock factories (which run before the
// regular imports below). `activePtyId` is mutated per test to drive the
// active-pane branch without standing up the real store.
const mocks = vi.hoisted(() => ({
  terminalRegistry: new Map<string, { getSelection: () => string; element?: HTMLElement }>(),
  copySelectionWithFeedback: vi.fn(),
  activePtyId: null as string | null,
}));

vi.mock('../useTerminal', () => ({
  terminalRegistry: mocks.terminalRegistry,
  copySelectionWithFeedback: mocks.copySelectionWithFeedback,
}));

vi.mock('../useActivePaneFocus', () => ({
  resolveActivePanePtyId: () => mocks.activePtyId,
}));

// Imported AFTER the mocks so the hook binds to the stubbed modules.
// eslint-disable-next-line import/first
import { useTerminalCopyShortcut } from '../useTerminalCopyShortcut';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts the hook (its useEffect installs the document listener). */
function Harness(): null {
  useTerminalCopyShortcut();
  return null;
}

let container: HTMLDivElement;
let root: Root;

function mountHook(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(Harness));
  });
}

/** Register a fake terminal with a controllable selection + visibility. */
function addTerminal(ptyId: string, selection: string, visible: boolean): FakeTerminal {
  const el = document.createElement('div');
  // jsdom has no layout (offsetParent === null) and no checkVisibility, so we
  // stub checkVisibility to drive the hook's visibility gate directly.
  el.checkVisibility = (() => visible) as Element['checkVisibility'];
  document.body.appendChild(el);
  const term: FakeTerminal = { getSelection: () => selection, element: el };
  mocks.terminalRegistry.set(ptyId, term);
  return term;
}

/** Focus an empty composer (textarea ⇒ editable, no own selection). */
function focusComposer(): void {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.focus();
}

/** Focus a terminal's own xterm helper textarea (xterm owns copy/SIGINT). */
function focusXtermTextarea(): void {
  const ta = document.createElement('textarea');
  ta.classList.add('xterm-helper-textarea');
  document.body.appendChild(ta);
  ta.focus();
}

/** Dispatch a Ctrl+C keydown the hook's capture listener will see. */
function pressCtrlC(init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    ctrlKey: true,
    key: 'c',
    code: 'KeyC',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  mocks.terminalRegistry.clear();
  mocks.copySelectionWithFeedback.mockReset();
  mocks.activePtyId = null;
  mountHook();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('useTerminalCopyShortcut — DOM glue', () => {
  it('copies a VISIBLE terminal selection when an empty composer holds focus [regression]', () => {
    // The reported bug: composer focused (empty), terminal text selected. The
    // hook must reach the copy path and consume the key.
    const term = addTerminal('pty-term', 'hello world', true);
    mocks.activePtyId = 'pty-term';
    focusComposer();

    const ev = pressCtrlC();

    expect(mocks.copySelectionWithFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.copySelectionWithFeedback).toHaveBeenCalledWith(term, 'hello world');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('yields to a NATIVE selection of non-terminal text — no stale-terminal copy, native copy preserved [P1 review]', () => {
    // User drag-selected a channel message (native DOM selection) while a
    // terminal still holds a leftover xterm selection. The hook must yield so
    // the message's native copy wins — it must NOT copy the stale terminal text
    // nor preventDefault. (xterm's WebGL selection never appears in
    // window.getSelection(), so a non-empty native selection is non-terminal.)
    addTerminal('pty-term', 'stale terminal selection', true);
    mocks.activePtyId = 'pty-term';
    focusComposer();
    const realGetSelection = window.getSelection;
    window.getSelection = (() => ({
      isCollapsed: false,
      toString: () => 'a selected channel message',
    })) as typeof window.getSelection;
    try {
      const ev = pressCtrlC();
      expect(mocks.copySelectionWithFeedback).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      window.getSelection = realGetSelection;
    }
  });

  it('does NOT copy a HIDDEN terminal’s stale selection (visibility gate) [consensus P2]', () => {
    // The terminal is mounted in the registry but offscreen (tab/workspace
    // switch). Its old selection must not be copied; with no visible candidate
    // the keystroke falls through to SIGINT untouched.
    addTerminal('pty-hidden', 'stale offscreen selection', false);
    mocks.activePtyId = 'pty-hidden';
    focusComposer();

    const ev = pressCtrlC();

    expect(mocks.copySelectionWithFeedback).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores OS auto-repeat keydowns (e.repeat) so a held Ctrl+C acts at most once', () => {
    addTerminal('pty-term', 'hello', true);
    mocks.activePtyId = 'pty-term';
    focusComposer();

    const ev = pressCtrlC({ repeat: true });

    expect(mocks.copySelectionWithFeedback).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('yields when focus is on the terminal’s own xterm helper textarea (xterm owns copy/SIGINT)', () => {
    addTerminal('pty-term', 'hello', true);
    mocks.activePtyId = 'pty-term';
    focusXtermTextarea();

    const ev = pressCtrlC();

    expect(mocks.copySelectionWithFeedback).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
