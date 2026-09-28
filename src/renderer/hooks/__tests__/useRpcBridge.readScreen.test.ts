// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { generateTextSnapshot } from '../../../daemon/HeadlessSnapshot';
import { terminalRegistry } from '../useTerminal';
import { handleRpcMethod } from '../useRpcBridge';
import { useStore } from '../../stores';

// The read path uses headless buffers; browser canvas rendering is unused.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
});

it('returns honest coverage for live and parked reads, including full_scrollback', async () => {
  const ptyId = 'pty-read-coverage';
  const lines = Array.from({ length: 40 }, (_, i) => `answer line ${i}`);
  const normal = lines.join('\r\n');
  const alternate = `\x1b[?1049h${normal}\x1b[?2026h\x1b[H\x1b[Jcurrent viewport\r\nprompt\x1b[?2026l`;
  const previousAPI = window.electronAPI;
  const previousGate = useStore.getState().paneGate;
  useStore.setState({ paneGate: 'ready' });
  const readText = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText } };
  try {
    for (const raw of [normal, alternate]) {
      const terminal = new Terminal({ cols: 80, rows: 6, scrollback: 100, allowProposedApi: true });
      const snapshot = await generateTextSnapshot({ cols: 80, rows: 6, scrollback: 100, initial: Buffer.from(raw) });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw new Error('snapshot unavailable');
      try {
        await new Promise<void>((resolve) => terminal.write(raw, resolve));
        const expectedText = raw === normal ? lines.join('\n') : 'current viewport\nprompt';
        for (const options of [{}, { full_scrollback: true }, { tail_lines: 300 }]) {
          (terminalRegistry as Map<string, unknown>).set(ptyId, terminal);
          const live = await handleRpcMethod('input.readScreen', { ptyId, ...options });
          terminalRegistry.delete(ptyId);
          readText.mockResolvedValue({ success: true, rows: snapshot.rows, bufferType: snapshot.bufferType });
          const parked = await handleRpcMethod('input.readScreen', { ptyId, ...options });
          expect(parked).toEqual(live);
          if (raw === normal) {
            expect(live).toEqual({ ptyId, text: expectedText });
          } else {
            expect(live).toMatchObject({ ptyId, text: expectedText, alternateScreen: true, historyIncomplete: true });
            expect(live).toHaveProperty('hint', expect.stringContaining('full_scrollback cannot recover it'));
          }
        }
        readText.mockResolvedValue({ success: true, rows: snapshot.rows, bufferType: snapshot.bufferType, truncated: true });
        expect(await handleRpcMethod('input.readScreen', { ptyId, full_scrollback: true })).toHaveProperty('truncated', true);
      } finally {
        terminalRegistry.delete(ptyId);
        terminal.dispose();
      }
    }
  } finally {
    window.electronAPI = previousAPI;
    useStore.setState({ paneGate: previousGate });
  }
});

it('returns the rows a TUI draws below the cursor, live and parked (#1595)', async () => {
  const ptyId = 'pty-read-picker';
  const picker = [
    'Which color?',
    '',
    '❯ 1. Red',
    '  2. Green',
    '  3. Blue',
    '  4. Type something.',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ];
  // Both renderers park the cursor on the highlighted option, above the rest.
  const variants = [
    { raw: `earlier output\r\n${picker.join('\r\n')}\x1b[5A\r`, top: ['earlier output'] },
    { raw: `\x1b[?1049h\x1b[H\x1b[J${picker.join('\r\n')}\x1b[3;3H`, top: [] },
  ];
  const previousAPI = window.electronAPI;
  const previousGate = useStore.getState().paneGate;
  useStore.setState({ paneGate: 'ready' });
  const readText = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { readText } };
  try {
    for (const { raw, top } of variants) {
      const terminal = new Terminal({ cols: 60, rows: 14, scrollback: 100, allowProposedApi: true });
      const snapshot = await generateTextSnapshot({ cols: 60, rows: 14, scrollback: 100, initial: Buffer.from(raw) });
      if (!snapshot.ok) throw new Error('snapshot unavailable');
      try {
        await new Promise<void>((resolve) => terminal.write(raw, resolve));
        expect(terminal.buffer.active.cursorY).toBe(top.length + 2);
        const cases: Array<[Record<string, unknown>, string[]]> = [
          [{}, [...top, ...picker]],
          [{ full_scrollback: true }, [...top, ...picker]],
          [{ tail_lines: 3 }, picker.slice(-3)],
        ];
        for (const [options, expected] of cases) {
          (terminalRegistry as Map<string, unknown>).set(ptyId, terminal);
          const live = await handleRpcMethod('input.readScreen', { ptyId, ...options });
          terminalRegistry.delete(ptyId);
          readText.mockResolvedValue({ success: true, rows: snapshot.rows, bufferType: snapshot.bufferType });
          const parked = await handleRpcMethod('input.readScreen', { ptyId, ...options });
          expect(live).toMatchObject({ ptyId, text: expected.join('\n') });
          expect(parked).toEqual(live);
        }
      } finally {
        terminalRegistry.delete(ptyId);
        terminal.dispose();
      }
    }
  } finally {
    window.electronAPI = previousAPI;
    useStore.setState({ paneGate: previousGate });
  }
});
