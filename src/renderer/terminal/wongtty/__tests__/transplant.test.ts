// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { serializeForTransplant } from '../transplant';

vi.mock('../load', () => ({ isWongttyTerminal: () => false }));

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

describe('serializeForTransplant (xterm.js)', () => {
  it('carries the SGR mouse encoding a TUI asked for, which SerializeAddon leaves out', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[?1000h\x1b[?1006hTUI');
    const out = serializeForTransplant(terminal, 100) ?? '';
    expect(out).toContain('\x1b[?1000h');
    expect(out).toContain('\x1b[?1006h');

    // Replayed into a fresh terminal, the encoding is back.
    const fresh = new Terminal({ allowProposedApi: true });
    await write(fresh, out);
    expect((fresh as unknown as { _core: { mouseStateService: { activeEncoding: string } } })._core.mouseStateService.activeEncoding).toBe('SGR');
    terminal.dispose();
    fresh.dispose();
  });

  it('adds nothing for the default encoding', async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    await write(terminal, '\x1b[?1000hplain');
    const out = serializeForTransplant(terminal, 100) ?? '';
    expect(out).not.toContain('\x1b[?1006h');
    expect(out).not.toContain('\x1b[?1016h');
    terminal.dispose();
  });
});
