import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { bindPathOpenToPty, createPathLinkProvider } from '../../terminal/pathLinkProvider';

const source = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf8');

/** Minimal xterm Terminal stub — the provider only reads one buffer line. */
function terminalShowing(line: string): Terminal {
  return {
    buffer: {
      active: {
        getLine: (i: number) =>
          (i === 0 ? { translateToString: () => line, isWrapped: false } : undefined),
      },
    },
  } as unknown as Terminal;
}

/** Activate the first path link the provider offers for row 1. */
function activateFirstLink(terminal: Terminal, open: (filePath: string) => void): void {
  let links: { activate: (e: MouseEvent, text: string) => void }[] | undefined;
  createPathLinkProvider(terminal, open, 'linux')
    .provideLinks(1, (result) => { links = result as typeof links; });
  if (!links?.length) throw new Error('no path link produced');
  // The provider ignores the event; this suite runs in the repo's node env
  // where MouseEvent does not exist.
  links[0].activate(undefined as never, '');
}

describe('useTerminal hyperlink routing', () => {
  it('routes OSC 8 and detected text URLs through the same wmux activator', () => {
    expect(source).toContain('activate: activateTerminalUrl');
    expect(source).toContain('new WebLinksAddon(activateTerminalUrl)');
  });

  // The path text a terminal prints is meaningless without the domain that
  // printed it — `/home/me/proj` is a host path from bash and a guest path
  // from WSL. Main resolves that domain from the PTY identity, so the ptyId
  // has to ride along with every activation.
  it('carries the PTY identity into every path activation', () => {
    const openPath = vi.fn();
    const bound = bindPathOpenToPty('pty-42', openPath);

    activateFirstLink(terminalShowing('built /home/me/proj/out.log'), bound);

    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith('/home/me/proj/out.log', 'pty-42');
  });

  // The behavioural test above pins `bindPathOpenToPty`'s contract; this pins
  // that useTerminal actually binds the pane's OWN ptyId to the shell bridge.
  // The pattern must name all three parts — a bare `ptyId,` occurs ~37 times
  // in the file and could never fail.
  it('binds the pane ptyId to shell.openPath for its link provider', () => {
    expect(source).toMatch(
      /bindPathOpenToPty\(\s*ptyId,\s*window\.electronAPI\.shell\.openPath,?\s*\)/,
    );
    expect(source).toMatch(/registerLinkProvider\(\s*createPathLinkProvider\(/);
  });
});
