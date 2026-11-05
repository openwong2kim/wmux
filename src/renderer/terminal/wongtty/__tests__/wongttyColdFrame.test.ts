import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Every terminal here stands for a wongtty one (uiSlice.terminalWongtty).
vi.mock('../load', () => ({ isWongttyTerminal: () => true }));

describe('cold frames of wongtty terminals', () => {
  it('come from ansiSnapshot with the serialize addon\'s options', async () => {
    const { captureColdFrame, takeColdFrame } = await import('../../coldFrame');
    const ansiSnapshot = vi.fn(() => ({ ok: true as const, payload: new TextEncoder().encode('\x1b[1mhi\x1b[0m 한글') }));
    captureColdFrame('p1', { ansiSnapshot, cols: 40, rows: 6 } as unknown as Terminal);
    expect(ansiSnapshot).toHaveBeenCalledWith({ scrollback: 0, excludeModes: true });
    expect(takeColdFrame('p1')).toMatchObject({ frame: '\x1b[1mhi\x1b[0m 한글', cols: 40, rows: 6 });

    // A screen the engine cannot rebuild leaves no frame, like a failed serialize.
    captureColdFrame('p2', { ansiSnapshot: () => ({ ok: false, reason: 'margins' }), cols: 40, rows: 6 } as unknown as Terminal);
    expect(takeColdFrame('p2')).toBeNull();
  });
});
