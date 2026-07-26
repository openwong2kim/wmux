import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';

const { readLastAssistantMessageMock } = vi.hoisted(() => ({
  readLastAssistantMessageMock: vi.fn(),
}));

vi.mock('../../../claude/lastAssistantMessage', () => ({
  readLastAssistantMessage: readLastAssistantMessageMock,
}));

import { readStopMessage } from '../hooks.rpc';

function stop(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    ptyId: 'pty-1',
    cwd: '/work/repo',
    payload: { transcript_path: '/home/me/session.jsonl' },
    ts: 1,
    ...overrides,
  };
}

describe('readStopMessage location attribution', () => {
  beforeEach(() => {
    readLastAssistantMessageMock.mockReset();
    readLastAssistantMessageMock.mockReturnValue({ text: 'Done.', endsWithQuestion: false });
  });

  it('binds a WSL transcript read to the verified PTY location and distro', () => {
    const signal = stop();
    expect(readStopMessage(signal, {
      ptyId: 'pty-1',
      location: {
        domain: 'wsl',
        cwd: '/initial',
        shell: 'wsl.exe',
        distro: 'Ubuntu-24.04',
      },
    })).toEqual({ text: 'Done.', endsWithQuestion: false });

    expect(readLastAssistantMessageMock).toHaveBeenCalledWith(
      '/home/me/session.jsonl',
      {
        location: {
          domain: 'wsl',
          cwd: '/initial',
          shell: 'wsl.exe',
          distro: 'Ubuntu-24.04',
        },
        activeSession: {
          sessionId: 'pty-1',
          active: true,
          distro: 'Ubuntu-24.04',
        },
      },
    );
  });

  it('rejects a PTY mismatch before reading the transcript', () => {
    expect(readStopMessage(stop(), {
      ptyId: 'pty-other',
      location: { domain: 'host', cwd: 'C:\\repo', shell: 'pwsh.exe' },
    })).toBeNull();
    expect(readLastAssistantMessageMock).not.toHaveBeenCalled();
  });

  it('rejects WSL attribution without a distro', () => {
    expect(readStopMessage(stop(), {
      ptyId: 'pty-1',
      location: { domain: 'wsl', cwd: '/work/repo', shell: 'wsl.exe' },
    })).toBeNull();
    expect(readLastAssistantMessageMock).not.toHaveBeenCalled();
  });
});
