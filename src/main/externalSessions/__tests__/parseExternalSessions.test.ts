import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { parseExternalSessions } from '../externalSessions.handler';

const row = (patch: Record<string, unknown> = {}, where: Record<string, unknown> = {}) => ({
  id: 'claude:s1', agent: 'claude', agentSessionId: 's1', cwd: '/p', state: 'running',
  lastSignalAt: 1, startedAt: 1, where: { kind: 'tmux', ...where }, ...patch,
});

describe('parseExternalSessions', () => {
  it('keeps a well-formed row', () => {
    expect(parseExternalSessions([row({ title: 't' }, { session: 'api' })])).toHaveLength(1);
  });

  it('drops a row whose text field is not a string, or whose agent this app does not know', () => {
    expect(parseExternalSessions([
      row({ title: 42 }),
      row({}, { session: { x: 1 } }),
      row({ agent: 'future-agent' }),
    ])).toEqual([]);
  });
});
