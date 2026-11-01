import { describe, expect, it, vi } from 'vitest';
import { ShellMarkIngress, type ShellMarkState } from '../shellMarkIngress';

const ESC = '\x1b';
const BEL = '\x07';
const mark = (kind: string) => `${ESC}]133;${kind}${BEL}`;

/** Feed `parts` as separate reads; returns the joined output. */
function viaText(ingress: ShellMarkIngress, parts: string[]): string {
  return parts.map((part) => ingress.apply(part)).join('');
}

/** Every split of `input` into two reads. */
function splits(input: string): string[][] {
  const out: string[][] = [];
  for (let at = 0; at <= input.length; at++) out.push([input.slice(0, at), input.slice(at)]);
  return out;
}

describe('ShellMarkIngress transitions', () => {
  it('reads every mark as the shell\'s at the prompt, and C starts a command', () => {
    const ingress = new ShellMarkIngress();
    const input = mark('D;0') + mark('A') + 'PS> ' + mark('B') + mark('C');
    expect(viaText(ingress, [input])).toBe(input);
    expect(ingress.state).toBe('running');
  });

  it('lowercases A, B and C while a command runs, and the shell\'s D;<n> ends it', () => {
    const ingress = new ShellMarkIngress('running');
    const program = mark('A') + 'kimi> ' + mark('B') + mark('C') + 'reply' + mark('B') + mark('C');
    expect(viaText(ingress, [program])).toBe(program.replace(/133;([ABC])/g, (_m, k: string) => `133;${k.toLowerCase()}`));
    expect(ingress.state).toBe('running');
    const shell = mark('D;0') + mark('A') + '$ ' + mark('B');
    expect(viaText(ingress, [shell])).toBe(shell);
    expect(ingress.state).toBe('idle');
  });

  it('takes a negative exit code as the shell\'s (pwsh after Ctrl+C on a native program)', () => {
    const ingress = new ShellMarkIngress('running');
    const shell = mark('D;-1073741510') + mark('A');
    expect(viaText(ingress, [shell])).toBe(shell);
    expect(ingress.state).toBe('idle');
  });

  it('lowercases a bare D, and a D; with no number, while running', () => {
    for (const d of ['D', 'D;', 'D;x', 'D;-', 'D;-x']) {
      const ingress = new ShellMarkIngress('running');
      expect(viaText(ingress, [mark(d) + mark('A')]), d).toBe(`${ESC}]133;d${d.slice(1)}${BEL}${ESC}]133;a${BEL}`);
      expect(ingress.state, d).toBe('running');
    }
  });

  it('a D at the prompt is the shell\'s in any shape', () => {
    const ingress = new ShellMarkIngress();
    expect(viaText(ingress, [mark('D')])).toBe(mark('D'));
    expect(ingress.state).toBe('idle');
  });

  it('leaves other OSC 133 kinds, lowercase kinds and other sequences alone', () => {
    const ingress = new ShellMarkIngress('running');
    const input = mark('P;k=i') + mark('a') + `${ESC}]1337;File=inline=1:QUJD${BEL}` + `${ESC}]7;file://h/p${BEL}` + `${ESC}[1;31mC${ESC}[0m`;
    expect(viaText(ingress, [input])).toBe(input);
    expect(ingress.state).toBe('running');
  });

  it('a shell that never writes C never leaves the prompt state', () => {
    const ingress = new ShellMarkIngress();
    const input = mark('A') + 'PS> ' + mark('B') + 'out' + mark('D;0') + mark('A') + mark('B');
    expect(viaText(ingress, [input])).toBe(input);
    expect(ingress.state).toBe('idle');
  });

  it('a second C while a command runs is the program\'s', () => {
    // wmux's pwsh integration writes C only for a line PSReadLine runs, so a
    // second C before the shell's D;<n> came from the running program.
    const ingress = new ShellMarkIngress();
    const input = mark('C') + mark('C') + mark('D;0') + mark('A') + mark('B');
    expect(viaText(ingress, [input])).toBe(mark('C') + mark('c') + mark('D;0') + mark('A') + mark('B'));
    expect(ingress.state).toBe('idle');
  });

  it('a nested ssh prompt inside a running command is foreign until the remote\'s own D;<n>', () => {
    // Documented behavior change (#2771): while `ssh` runs under the outer
    // shell, the remote shell's first prompt marks read as foreign. After the
    // remote's first `D;<n>` they are the shell's again, as before.
    const ingress = new ShellMarkIngress();
    viaText(ingress, [mark('C')]); // the outer shell runs `ssh`
    const remoteFirst = mark('A') + 'remote$ ' + mark('B');
    expect(viaText(ingress, [remoteFirst])).toBe(mark('a') + 'remote$ ' + mark('b'));
    const remoteLater = mark('C') + 'ls' + mark('D;0') + mark('A') + 'remote$ ' + mark('B');
    expect(viaText(ingress, [remoteLater])).toBe(mark('c') + 'ls' + mark('D;0') + mark('A') + 'remote$ ' + mark('B'));
    expect(ingress.state).toBe('idle');
  });

  it('changes only the kind byte around multi-byte text and a lone surrogate', () => {
    const input = '한글🙂' + mark('A') + '\ud800' + mark('B') + 'é' + mark('D;0');
    expect(new ShellMarkIngress('running').apply(input)).toBe('한글🙂' + mark('a') + '\ud800' + mark('b') + 'é' + mark('D;0'));
  });

  it('returns the same string when nothing is lowered, and reports only the first read that lowers', () => {
    const reported = vi.fn();
    const ingress = new ShellMarkIngress('running', reported);
    const input = 'out' + mark('D;0') + mark('A') + 'PS> ';
    expect(ingress.apply(input)).toBe(input);
    expect(reported).not.toHaveBeenCalled();
    ingress.apply(mark('C') + mark('A'));
    ingress.apply(mark('A'));
    expect(reported).toHaveBeenCalledOnce();
  });
});

describe('ShellMarkIngress across reads', () => {
  const states = (initial: ShellMarkState, parts: string[]) => {
    const ingress = new ShellMarkIngress(initial);
    return { out: viaText(ingress, parts), state: ingress.state };
  };

  it('a foreign mark split at any byte is still lowercased once its kind arrives', () => {
    const input = 'x' + mark('A') + 'y';
    for (const parts of splits(input)) {
      const { out, state } = states('running', parts);
      expect(out, JSON.stringify(parts)).toBe('x' + mark('a') + 'y');
      expect(state).toBe('running');
    }
  });

  it('the shell\'s D;0 then A, split at every byte, ends running', () => {
    const input = mark('D;0') + mark('A');
    for (const parts of splits(input)) {
      const { out, state } = states('running', parts);
      expect(out, JSON.stringify(parts)).toBe(input);
      expect(state, JSON.stringify(parts)).toBe('idle');
    }
  });

  it('a bare D split right after its kind byte keeps its case and keeps running', () => {
    // The kind byte already went out with the first read: it cannot be
    // lowercased later, and the state waits for the bytes after it.
    const first = `${ESC}]133;D`;
    const ingress = new ShellMarkIngress('running');
    expect(viaText(ingress, [first])).toBe(first);
    expect(ingress.state).toBe('running');
    expect(ingress.wants('no mark here')).toBe(true);
    expect(viaText(ingress, [BEL + mark('A')])).toBe(BEL + mark('a'));
    expect(ingress.state).toBe('running');
  });

  it('ESC]1337 split at every byte is never a mark', () => {
    const input = `${ESC}]1337;File=inline=1:QUJD${BEL}` + `${ESC}]133` + `7;SetMark${BEL}`;
    for (const parts of splits(input)) {
      const { out, state } = states('running', parts);
      expect(out, JSON.stringify(parts)).toBe(input);
      expect(state).toBe('running');
    }
  });

  it('a read with no mark in it needs no scan unless one is part-way through', () => {
    const ingress = new ShellMarkIngress('running');
    expect(ingress.wants('plain output')).toBe(false);
    expect(ingress.wants(`out${ESC}[0m`)).toBe(false);
    expect(ingress.wants(`out${ESC}]13`)).toBe(true);
    viaText(ingress, [`out${ESC}]13`]);
    expect(ingress.wants('plain output')).toBe(true);
  });
});
