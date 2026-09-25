import { describe, it, expect } from 'vitest';
import { agentSurfaceTitle, isBareShellTitle } from '../workspaceAgentRoster';

describe('isBareShellTitle', () => {
  it('recognises a tab still named after its shell', () => {
    for (const t of ['Bash', 'zsh', '-zsh', 'Zsh', 'sh', 'fish', 'pwsh', 'pwsh.exe', 'PowerShell', 'Windows PowerShell', 'cmd.exe', ' bash ', 'PowerShell 7', 'WSL', 'Terminal', '/bin/zsh', 'C:\\Windows\\System32\\cmd.exe']) {
      expect(isBareShellTitle(t)).toBe(true);
    }
  });

  it('keeps real titles, including ones that mention a shell', () => {
    for (const t of ['✳ Fix login flow', 'bash script review', 'zshrc cleanup', 'Claude Code', 'npm test']) {
      expect(isBareShellTitle(t)).toBe(false);
    }
  });
});

describe('agentSurfaceTitle', () => {
  it('drops a bare shell title so the row falls back to the agent name', () => {
    expect(agentSurfaceTitle({ title: 'Bash' })).toBeUndefined();
    expect(agentSurfaceTitle({ title: '✳ Fix login' })).toBe('✳ Fix login');
  });

  it('keeps a title the user typed, even if it spells a shell name', () => {
    expect(agentSurfaceTitle({ title: 'Bash', titleLocked: true })).toBe('Bash');
  });
});
