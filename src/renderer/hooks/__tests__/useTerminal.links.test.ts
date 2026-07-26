import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf8');

describe('useTerminal hyperlink routing', () => {
  it('routes OSC 8 and detected text URLs through the same wmux activator', () => {
    expect(source).toContain('activate: activateTerminalUrl');
    expect(source).toContain('new WebLinksAddon(activateTerminalUrl)');
  });

  it('binds detected filesystem paths to the terminal PTY identity', () => {
    expect(source).toContain('bindPathOpenToPty(');
    expect(source).toContain('ptyId,');
    expect(source).toContain('window.electronAPI.shell.openPath');
  });
});
