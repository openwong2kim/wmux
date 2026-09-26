// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { terms } = vi.hoisted(() => ({
  terms: new Map<string, { focus: () => void; modes: { bracketedPasteMode: boolean } }>(),
}));
vi.mock('../../hooks/useTerminal', () => ({ terminalRegistry: terms }));

import { focusMentionSource, insertMention } from '../agentMentionInsert';
import { registerChatInsertTarget } from '../../components/Chat/chatAttachments';

const write = vi.fn();
const chatSource = { workspaceId: 'ws-1', paneId: 'p', surfaceId: 's', ptyId: 'pty-1', chat: true };
const termSource = { ...chatSource, chat: false };

beforeEach(() => {
  write.mockReset();
  terms.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write } };
});
afterEach(() => { vi.useRealTimers(); });

describe('insertMention', () => {
  it('Chat view with no composer mounted: nothing goes to the hidden terminal', () => {
    const focus = vi.fn();
    terms.set('pty-1', { focus, modes: { bracketedPasteMode: true } });
    expect(insertMention(chatSource, '[ref]')).toBe('noComposer');
    expect(write).not.toHaveBeenCalled();
    focusMentionSource(chatSource);
    expect(focus).not.toHaveBeenCalled();
  });

  it('Chat view: the composer takes it, or refuses it when it does not fit', () => {
    let fits = true;
    const insert = vi.fn(() => fits);
    const unregister = registerChatInsertTarget('pty-1', { insert, focus: vi.fn() });
    expect(insertMention(chatSource, '[ref]')).toBe('inserted');
    fits = false;
    expect(insertMention(chatSource, '[ref]')).toBe('full');
    expect(write).not.toHaveBeenCalled();
    unregister();
  });

  it('terminal: bracketed paste into the pane, or `gone` when it closed meanwhile', async () => {
    expect(insertMention(termSource, '[ref]')).toBe('gone');
    const focus = vi.fn();
    terms.set('pty-1', { focus, modes: { bracketedPasteMode: true } });
    expect(insertMention(termSource, '[ref]')).toBe('inserted');
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls.map((c) => c[1]).join('')).toBe('\x1b[200~[ref]\x1b[201~');
    expect(focus).toHaveBeenCalled();
  });
});
