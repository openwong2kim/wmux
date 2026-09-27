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
