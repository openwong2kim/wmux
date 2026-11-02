import { describe, expect, it } from 'vitest';
import { shellChildAgent, type ShellChildReaders } from '../shellChildAgent';

const NPM_CLAUDE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"';
/** 2026-11-02T00:00:00Z as a FILETIME (100 ns since 1601). */
const STARTED_FILETIME = (1_793_577_600_000n + 11_644_473_600_000n) * 10_000n;

/** A shell (pid 100) and the children `family` lists, with these command lines; `exited` pids have ended. */
function readers(family: Array<{ pid: number; ppid: number; name: string }> | null, cmdlines: Record<number, string> = {}, exited: number[] = []): ShellChildReaders {
  return {
    family: () => family,
    commandLine: (pid) => cmdlines[pid] ?? null,
    createdAt: () => STARTED_FILETIME,
    exitState: (pid) => (exited.includes(pid) ? 'exited' : 'running'),
  };
}
const shell = { pid: 100, ppid: 1, name: 'pwsh.exe' };

describe('shellChildAgent', () => {
  it('names an agent the shell runs as its child, with its start time: a native binary, or a runtime by its script', () => {
    expect(shellChildAgent(100, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }])))
      .toEqual({ slug: 'claude', pid: 200, startedAt: 1_793_577_600_000 });
    expect(shellChildAgent(100, readers([shell, { pid: 200, ppid: 100, name: 'node.exe' }], { 200: NPM_CLAUDE }))?.slug).toBe('claude');
  });

  it('names the shell itself when the pane runs the agent as its root', () => {
    expect(shellChildAgent(100, readers([{ pid: 100, ppid: 1, name: 'claude.exe' }]))?.slug).toBe('claude');
  });

  it('names nothing for a shell running no agent: a cmdlet or builtin (`cat`), or another program', () => {
    expect(shellChildAgent(100, readers([shell]))).toBeUndefined();
    expect(shellChildAgent(100, readers([shell, { pid: 200, ppid: 100, name: 'node.exe' }], { 200: 'node C:\\work\\server.js' }))).toBeUndefined();
    expect(shellChildAgent(100, readers([shell, { pid: 200, ppid: 100, name: 'more.com' }]))).toBeUndefined();
  });

  it('names nothing for an agent that has exited but is still listed', () => {
    expect(shellChildAgent(100, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }], {}, [200]))).toBeUndefined();
  });

  it('names nothing when two different agents are children, or the table cannot be read', () => {
    expect(shellChildAgent(100, readers([shell, { pid: 200, ppid: 100, name: 'claude.exe' }, { pid: 300, ppid: 100, name: 'codex.exe' }])))
      .toBeUndefined();
    expect(shellChildAgent(100, readers(null))).toBeUndefined();
  });
});
