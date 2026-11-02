// #2398 — real ptys through node-pty's shared conout drain worker
// (patches/node-pty+1.2.0-beta.17.patch). One worker drains every pty. A pty
// whose reader is paused while it prints megabytes holds back only itself:
// the others finish meanwhile, each with all of its own output, in order, and
// none of anyone else's; resumed, the paused one gets all of its output too.
// When every shell has exited by itself, the worker ends. Windows only: the
// drain worker is the ConPTY path.

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pty from 'node-pty';

const COUNT = 6;
const LINES = 400;
// About 2.2 MB from pty 0: far more than its pipes and the drain hold in
// flight, so its shell blocks while its reader is paused.
const BIG_LINES = 25_000;
const FILLER = 'abcdefghijklmnopqrstuvwxyz'.repeat(3);

// node-pty takes Worker off the worker_threads module when it starts one, so a
// counting subclass put there sees every drain worker it starts.
const workerThreads = createRequire(__filename)('worker_threads') as { Worker: new (...args: never[]) => NodeJS.EventEmitter };
const RealWorker = workerThreads.Worker;
const started: Array<{ exited: boolean }> = [];

beforeAll(() => {
  workerThreads.Worker = class CountedWorker extends RealWorker {
    constructor(...args: never[]) {
      super(...args);
      const entry = { exited: false };
      started.push(entry);
      this.once('exit', () => { entry.exited = true; });
    }
  };
});

afterAll(() => {
  workerThreads.Worker = RealWorker;
});

function linesOf(output: string, index: number): { numbers: number[]; foreign: number } {
  const numbers: number[] = [];
  let foreign = 0;
  for (const match of output.matchAll(/P(\d+)x(\d+)y/g)) {
    if (Number(match[1]) === index) numbers.push(Number(match[2]));
    else foreign++;
  }
  return { numbers, foreign };
}

function count(lines: number): number[] {
  return Array.from({ length: lines }, (_, i) => i + 1);
}

describe.runIf(process.platform === 'win32')('node-pty shared conout drain on ConPTY', () => {
  it('drains every pty through one worker, holding back only the pty whose reader is paused', async () => {
    const outputs = Array.from({ length: COUNT }, () => '');
    const exits = outputs.map(() => {
      let settle!: () => void;
      const exited = new Promise<void>((resolve) => { settle = resolve; });
      return { done: false, exited, settle };
    });
    const ptys = outputs.map((_, index) => {
      const p = index === 0
        ? pty.spawn(process.execPath, ['-e', [
          `for (let i = 1; i <= ${BIG_LINES}; i += 500) {`,
          '  let s = \'\';',
          `  for (let n = i; n < i + 500 && n <= ${BIG_LINES}; n++) s += 'P0x' + n + 'y${FILLER}' + String.fromCharCode(10);`,
          '  process.stdout.write(s);',
          '}',
        ].join('\n')], { cols: 200, rows: 30, useConptyDll: true })
        : pty.spawn('cmd.exe', ['/d', '/c', `for /L %i in (1,1,${LINES}) do @echo P${index}x%iy`], {
          cols: 120,
          rows: 30,
          useConptyDll: true,
        });
      p.onData((data) => { outputs[index] += data; });
      // node-pty flushes the drain for a second after the exit.
      p.onExit(() => {
        exits[index].done = true;
        setTimeout(exits[index].settle, 1500);
      });
      return p;
    });
    ptys[0].pause();

    await Promise.all(exits.slice(1).map((exit) => exit.exited));
    // Every other pty finished while pty 0's shell is still blocked on output
    // nobody reads, and all of them went through one drain worker.
    expect(exits[0].done).toBe(false);
    expect(outputs[0]).toBe('');
    expect(started).toHaveLength(1);
    outputs.slice(1).forEach((output, i) => {
      const index = i + 1;
      const { numbers, foreign } = linesOf(output, index);
      expect(foreign, `pty ${index} got another pty's output`).toBe(0);
      expect(numbers, `pty ${index}`).toEqual(count(LINES));
    });

    ptys[0].resume();
    await exits[0].exited;
    const { numbers, foreign } = linesOf(outputs[0], 0);
    expect(foreign, 'pty 0 got another pty\'s output').toBe(0);
    expect(numbers.length, 'pty 0 lines').toBe(BIG_LINES);
    expect(numbers, 'pty 0').toEqual(count(BIG_LINES));
    expect(outputs[0].length).toBeGreaterThan(2 * 1024 * 1024);

    // Every shell exited by itself: the drain worker has let them all go.
    await vi.waitFor(() => expect(started.map((worker) => worker.exited)).toEqual([true]), { timeout: 10_000 });
  }, 120_000);
});
