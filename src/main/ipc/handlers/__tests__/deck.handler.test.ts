// What is left of the deck's IPC: the pending bot questions Fleet and the
// phone sidebar list (DECK_MOA_DECISIONS), and the removed brains' cards
// expired at startup (DECK_EXPIRED_DECISIONS).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, fn); }),
    removeHandler: vi.fn((channel: string) => { ipcHandlers.delete(channel); }),
  },
  app: { once: vi.fn(), removeListener: vi.fn() },
}));

import { IPC } from '../../../../shared/constants';
import { GENERAL_THREAD } from '../../../../shared/room';
import { registerDeckHandler } from '../deck.handler';
import { loadWorkspaceDecision, raiseDecision, raiseThreadDecisionIfFree } from '../../../deck/deckDecisionStore';

let dir: string;
let dispose: () => void;

const call = async (channel: string): Promise<unknown> =>
  (ipcHandlers.get(channel) as (e: unknown) => Promise<unknown>)({});

beforeEach(() => {
  ipcHandlers.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp10-deck-ipc-'));
  dispose = registerDeckHandler(() => null, { dir });
});

afterEach(() => {
  dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DECK_MOA_DECISIONS', () => {
  it('lists a pending question a bot asked, and leaves a removed brain\'s card unlisted but on disk', async () => {
    await raiseDecision('ws-legacy', { question: 'Old brain card?', options: ['a', 'b'] }, dir);
    await raiseThreadDecisionIfFree('ws-bot', GENERAL_THREAD, { question: 'Merge it?', options: ['Yes', 'No'], origin: 'ask_person' }, dir);

    const r = await call(IPC.DECK_MOA_DECISIONS) as { decisions: Array<{ workspaceId: string; decision: { question: string } }> };
    expect(r.decisions.map((d) => [d.workspaceId, d.decision.question])).toEqual([['ws-bot', 'Merge it?']]);
    expect(fs.readFileSync(path.join(dir, 'deck-decisions.json'), 'utf8')).toContain('Old brain card?');
  });
});

describe('DECK_EXPIRED_DECISIONS', () => {
  it('removes a removed brain\'s pending card at registration and hands it over once', async () => {
    dispose();
    const brain = await raiseDecision('ws-legacy', { question: 'Resume it, or drop it?' }, dir);
    await raiseThreadDecisionIfFree('ws-bot', GENERAL_THREAD, { question: 'Merge it?', origin: 'ask_person' }, dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      dispose = registerDeckHandler(() => null, { dir });
      expect(await call(IPC.DECK_EXPIRED_DECISIONS)).toEqual({
        decisions: [{ workspaceId: 'ws-legacy', id: brain!.id, question: 'Resume it, or drop it?' }],
      });
      // Taken: a renderer reload asks again and gets nothing.
      expect(await call(IPC.DECK_EXPIRED_DECISIONS)).toEqual({ decisions: [] });
      expect(loadWorkspaceDecision('ws-legacy', dir)).toBeNull();
      expect(loadWorkspaceDecision('ws-bot', dir)?.status).toBe('pending');
      expect(log.mock.calls.some(([line]) => String(line).includes(`expired decision ${brain!.id} of workspace ws-legacy`))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('lists nothing when nothing was expired', async () => {
    expect(await call(IPC.DECK_EXPIRED_DECISIONS)).toEqual({ decisions: [] });
  });
});
