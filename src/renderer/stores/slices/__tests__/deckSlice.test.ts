import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';
import { createDeckSlice } from '../deckSlice';

describe('deckSlice', () => {
  it('defaults to the Commander tab', () => {
    // Observe the slice INITIALIZER, not the store singleton (CodeRabbit #396):
    // a beforeEach reset-to-'commander' would keep this test green even if the
    // slice's actual default changed.
    const slice = createDeckSlice(
      (() => undefined) as never,
      (() => useStore.getState()) as never,
      undefined as never,
    );
    expect(slice.activeDeckTab).toBe('commander');
  });

  describe('transitions', () => {
    beforeEach(() => {
      useStore.setState({ activeDeckTab: 'commander' });
    });

    it('switches the active deck tab', () => {
      useStore.getState().setActiveDeckTab('channels');
      expect(useStore.getState().activeDeckTab).toBe('channels');
      useStore.getState().setActiveDeckTab('commander');
      expect(useStore.getState().activeDeckTab).toBe('commander');
    });
  });

  describe('commander brain (Phase 2)', () => {
    beforeEach(() => {
      useStore.setState({ brainMessages: [], brainStatus: 'idle' });
    });

    it('starts a turn: pushes human + streaming assistant, marks busy', () => {
      useStore.getState().startDeckBrainTurn('spawn a worker');
      const s = useStore.getState();
      expect(s.brainStatus).toBe('busy');
      expect(s.brainMessages).toHaveLength(2);
      expect(s.brainMessages[0]).toMatchObject({ role: 'user', text: 'spawn a worker' });
      expect(s.brainMessages[1]).toMatchObject({ role: 'assistant', status: 'streaming' });
    });

    it('streams events into the open turn and returns to idle on turn-end', () => {
      const st = useStore.getState();
      st.startDeckBrainTurn('go');
      st.applyDeckBrainEvent({ type: 'text-delta', text: 'working' });
      st.applyDeckBrainEvent({ type: 'tool-start', name: 'mcp__wmux__pane_list', inputSummary: '' });
      st.applyDeckBrainEvent({ type: 'tool-end', name: 'mcp__wmux__pane_list', ok: true });
      expect(useStore.getState().brainStatus).toBe('busy');
      st.applyDeckBrainEvent({ type: 'turn-end', sessionId: 'sess-1' });

      const s = useStore.getState();
      expect(s.brainStatus).toBe('idle');
      const assistant = s.brainMessages[1];
      expect(assistant.text).toBe('working');
      expect(assistant.tools?.[0]).toMatchObject({ name: 'pane_list', ok: true });
      expect(assistant.status).toBe('done');
    });

    it('failDeckBrainTurn closes the open turn with an error and idles', () => {
      const st = useStore.getState();
      st.startDeckBrainTurn('go');
      st.failDeckBrainTurn('busy');
      const s = useStore.getState();
      expect(s.brainStatus).toBe('idle');
      expect(s.brainMessages[1].status).toBe('error');
      expect(s.brainMessages[1].errorText).toBe('busy');
    });
  });
});
