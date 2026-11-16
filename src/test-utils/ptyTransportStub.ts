/**
 * For tests whose `vi.mock('node-pty')` fake stands in for the PTY.
 *
 * Panes spawn on the Rust core only (shared/terminalPty.ts spawnTerminalPty):
 * the Node engine is removed, and the unit lane has no native module. The
 * session logic these tests exercise (env, cwd, pid, persistence, secrets) does
 * not depend on which transport the fake PTY came from, so the Rust spawn is
 * routed to the file's node-pty mock. Use it next to that mock:
 *
 *   vi.mock('<rel>/shared/terminalPty', async (importOriginal) =>
 *     (await import('<rel>/test-utils/ptyTransportStub')).routeSpawnToNodePtyMock(importOriginal));
 */
import type { IPty } from 'node-pty';

type TerminalPtyModule = typeof import('../shared/terminalPty');

export async function routeSpawnToNodePtyMock(importOriginal: () => Promise<unknown>): Promise<TerminalPtyModule> {
  const actual = await importOriginal() as TerminalPtyModule;
  const pty = await import('node-pty');
  const spawn = (pty as { spawn?: typeof pty.spawn }).spawn ?? (pty as unknown as { default: typeof pty }).default.spawn;
  return {
    ...actual,
    spawnTerminalPty: (command: string, args: string[], options: Parameters<TerminalPtyModule['spawnTerminalPty']>[2]): IPty =>
      spawn(command, args, options),
  };
}
