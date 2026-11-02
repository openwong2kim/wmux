import { describe, expect, it } from 'vitest';
import { shellChildAgent, type ShellChildReaders } from '../shellChildAgent';

const NPM_CLAUDE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"';
/** 2026-11-02T00:00:00Z, in epoch ms. */
const STARTED_MS = 1_793_577_600_000;
/** The shell's latest command start, a moment before the agent started. */
const SINCE = STARTED_MS - 100;
const filetime = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 10_000n;

/**
 * A shell (pid 100) and the children `family` lists, with these command lines;
 * `exited` pids have ended, `startedMs` overrides a pid's start (default STARTED_MS).
 */
function readers(
  family: Array<{ pid: number; ppid: number; name: string }> | null,
  cmdlines: Record<number, string> = {},
  exited: number[] = [],
  startedMs: Record<number, number> = {},
): ShellChildReaders {
  return {
    family: () => family,
    commandLine: (pid) => cmdlines[pid] ?? null,
    createdAt: (pid) => filetime(startedMs[pid] ?? STARTED_MS),
    exitState: (pid) => (exited.includes(pid) ? 'exited' : 'running'),
  };
}
const shell = { pid: 100, ppid: 1, name: 'pwsh.exe' };
const SHELL_STARTED = { 100: STARTED_MS - 60_000 };

describe('shellChildAgent', () => {
  it('names an agent the shell runs as its child, with its start time: a native binary, or a runtime by its script', () => {
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }], {}, [], SHELL_STARTED)))
      .toEqual({ slug: 'claude', pid: 200, startedAt: STARTED_MS });
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'node.exe' }], { 200: NPM_CLAUDE }, [], SHELL_STARTED))?.slug)
      .toBe('claude');
  });

  it('names the shell itself when the pane runs the agent as its root', () => {
    expect(shellChildAgent(100, SINCE, readers([{ pid: 100, ppid: 1, name: 'claude.exe' }]))?.slug).toBe('claude');
  });

  it('names nothing for a shell running no agent: a cmdlet or builtin (`cat`), or another program', () => {
    expect(shellChildAgent(100, SINCE, readers([shell]))).toBeUndefined();
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'node.exe' }], { 200: 'node C:\\work\\server.js' }))).toBeUndefined();
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'more.com' }]))).toBeUndefined();
  });

  it('names nothing for an agent that has exited but is still listed, or one started before `since`', () => {
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }], {}, [200]))).toBeUndefined();
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }], {}, [], { 200: SINCE - 1 }))).toBeUndefined();
  });

  it('names the agent the latest command started past a same-named sibling that exited or started earlier', () => {
    const family = [shell, { pid: 200, ppid: 100, name: 'claude.exe' }, { pid: 300, ppid: 100, name: 'claude.exe' }];
    expect(shellChildAgent(100, SINCE, readers(family, {}, [200], SHELL_STARTED))?.pid).toBe(300);
    expect(shellChildAgent(100, SINCE, readers(family, {}, [], { ...SHELL_STARTED, 200: STARTED_MS - 30_000 }))?.pid).toBe(300);
  });

  it('names nothing when two different agents are children, or the table cannot be read', () => {
    expect(shellChildAgent(100, SINCE, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }, { pid: 300, ppid: 100, name: 'codex.exe' }])))
      .toBeUndefined();
    expect(shellChildAgent(100, SINCE, readers(null))).toBeUndefined();
  });
});
