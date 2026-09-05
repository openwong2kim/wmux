import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useStore } from '../../stores';
import { InterruptKeystrokeDetector } from '../../../shared/hooks/interruptKeystroke';

/**
 * The interrupt edge, renderer half. Live finding (Claude Code 2.1.236): Ctrl+C
 * / ESC ESC ends the turn with NO Stop hook, and `claude` remains the pane's
 * foreground command so OSC 133 never reports the shell back at its prompt.
 * Main settles the pane from the same bytes; the renderer drops its own latch
 * on the spot so the dot flips without waiting for the round-trip.
 *
 * The wiring assertion is source-level for the same reason the OSC 52 lock in
 * this directory is: onData only fires from a real xterm driving real input,
 * which jsdom cannot faithfully reproduce. The BEHAVIOR either side of that
 * seam — which bytes count, and what the store does with the verdict — is
 * exercised for real below.
 */
const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

describe('useTerminal interrupt → turn-latch clear', () => {
  it('clears the latch from the onData input seam (source-level lock)', () => {
    expect(SRC).toMatch(
      /if \(interruptKeystrokes\.observe\(ptyId, data\)\) \{\s*\n\s*useStore\.getState\(\)\.clearSurfaceTurnOpen\(ptyId\);/,
    );
    expect(SRC).toMatch(
      /import \{ InterruptKeystrokeDetector \} from '\.\.\/\.\.\/shared\/hooks\/interruptKeystroke'/,
    );
    // One detector per renderer, not per mount: the ESC-pair state is keyed by
    // ptyId and must survive a remount between the two taps.
    expect(SRC).toMatch(/^const interruptKeystrokes = new InterruptKeystrokeDetector\(\);$/m);
  });

  describe('the seam it locks, run for real', () => {
    const detector = new InterruptKeystrokeDetector();
    /** Exactly the two lines the lock above pins, over one written chunk. */
    const onDataChunk = (ptyId: string, data: string) => {
      if (detector.observe(ptyId, data)) useStore.getState().clearSurfaceTurnOpen(ptyId);
    };

    beforeEach(() => {
      useStore.setState((state) => { state.surfaceTurnOpenAt = {}; });
      detector.forget('pty-a');
    });

    it('Ctrl+C clears the pane latch', () => {
      useStore.getState().markSurfaceTurnOpen('pty-a');
      expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeGreaterThan(0);

      onDataChunk('pty-a', '\x03');

      expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeUndefined();
    });

    it('ESC ESC clears the pane latch', () => {
      useStore.getState().markSurfaceTurnOpen('pty-a');

      onDataChunk('pty-a', '\x1b\x1b');

      expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeUndefined();
    });

    it('a lone ESC and an arrow key leave the latch alone', () => {
      useStore.getState().markSurfaceTurnOpen('pty-a');

      onDataChunk('pty-a', '\x1b');
      onDataChunk('pty-a', '\x1b[A');

      expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeGreaterThan(0);
    });

    it('touches only the pane that was interrupted', () => {
      useStore.getState().markSurfaceTurnOpen('pty-a');
      useStore.getState().markSurfaceTurnOpen('pty-b');

      onDataChunk('pty-a', '\x03');

      expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeUndefined();
      expect(useStore.getState().surfaceTurnOpenAt['pty-b']).toBeGreaterThan(0);
    });
  });
});
