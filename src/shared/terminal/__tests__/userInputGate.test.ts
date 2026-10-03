import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { gateUserInput } from '../userInputGate';

function wired() {
  const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  const raw: string[] = [];
  const sent: string[] = [];
  term.onData((d) => raw.push(d));
  const gate = gateUserInput(term as never, (d) => sent.push(d));
  term.onData(gate);
  const write = (s: string) => new Promise<void>((resolve) => term.write(s, resolve));
  return { term, raw, sent, gate, write };
}

describe('gateUserInput', () => {
  it('forwards nothing xterm answers to queries in the output', async () => {
    const { term, raw, sent, gate, write } = wired();
    expect(gate.gated).toBe(true);
    // DA1, DA2, CPR, DSR, DECRQM for an ANSI mode and a DEC private mode,
    // XTWINOPS size, OSC 11 colour.
    await write('out\x1b[c\x1b[>c\x1b[6n\x1b[5n\x1b[4$p\x1b[?2004$p\x1b[18t\x1b]11;?\x07put\r\n');
    expect(raw).toContain('\x1b[4;2$y'); // the ANSI DECRPM a shape list missed
    expect(raw.length).toBeGreaterThan(5);
    expect(sent).toEqual([]);
    term.dispose();
  });

  it('forwards a modified F3 that is byte for byte a cursor report', () => {
    const { term, sent } = wired();
    for (const key of ['\x1b[1;2R', '\x1b[1;5R', '\x1b[1;3R', 'ls\r', '\x1b[A', '\x03']) term.input(key, true);
    expect(sent).toEqual(['\x1b[1;2R', '\x1b[1;5R', '\x1b[1;3R', 'ls\r', '\x1b[A', '\x03']);
    term.dispose();
  });

  it('a reply right after a keystroke is still dropped', async () => {
    const { term, sent, write } = wired();
    term.input('x', true);
    await write('\x1b[6n');
    expect(sent).toEqual(['x']);
    term.dispose();
  });

  it('passes focus reports, which follow a real focus change', () => {
    const sent: string[] = [];
    const gate = gateUserInput({ _core: { coreService: { onUserInput: () => ({ dispose: () => undefined }) } } }, (d) => sent.push(d));
    gate('\x1b[I');
    gate('\x1b[O');
    gate('\x1b[0n');
    expect(sent).toEqual(['\x1b[I', '\x1b[O']);
  });

  it('forwards everything when the terminal has no user-input signal', () => {
    const sent: string[] = [];
    const gate = gateUserInput({}, (d) => sent.push(d));
    expect(gate.gated).toBe(false);
    gate('a');
    gate('\x1b[1;1R');
    expect(sent).toEqual(['a', '\x1b[1;1R']);
  });
});
