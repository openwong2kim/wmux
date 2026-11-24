import { describe, expect, it } from 'vitest';
import { appliedDefaultShell, getDefaultShellMirror, setDefaultShellMirror } from '../defaultShellMirror';

describe('the default shell mirror', () => {
  it('keeps only the value the renderer applies to a new pane', () => {
    expect(appliedDefaultShell('C:\\Windows\\System32\\wsl.exe')).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(appliedDefaultShell('/bin/zsh')).toBe('/bin/zsh');
    // Legacy names and anything else are not applied by withDefaultShell either.
    for (const v of ['wsl', 'powershell', '', null, 7, 'bash']) expect(appliedDefaultShell(v)).toBeNull();
    setDefaultShellMirror('C:\\Windows\\System32\\wsl.exe');
    expect(getDefaultShellMirror()).toBe('C:\\Windows\\System32\\wsl.exe');
    setDefaultShellMirror('wsl');
    expect(getDefaultShellMirror()).toBeNull();
  });
});
