import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';
import { createDeckSlice, EMPTY_DECK_BRAIN_THREAD } from '../deckSlice';

const WS_A = 'ws-a';
const WS_B = 'ws-b';

const threadOf = (ws: string) => useStore.getState().brainThreads[ws] ?? EMPTY_DECK_BRAIN_THREAD;

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
    expect(slice.brainThreads).toEqual({});
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

    it('hiding the Channels tab while on it snaps the deck back to the orchestrator', () => {
      useStore.setState({ channelsTabVisible: true, activeDeckTab: 'channels' });
      useStore.getState().setChannelsTabVisible(false);
      expect(useStore.getState().channelsTabVisible).toBe(false);
      expect(useStore.getState().activeDeckTab).toBe('commander');
      // Re-enabling does not yank the user anywhere.
      useStore.getState().setChannelsTabVisible(true);
      expect(useStore.getState().activeDeckTab).toBe('commander');
    });
  });

  describe('per-workspace commander brain (Phase 2, M1.5)', () => {
    beforeEach(() => {
      useStore.setState({ brainThreads: {} });
    });

    it('starts a turn: pushes human + streaming assistant, marks THAT workspace busy', () => {
      useStore.getState().startDeckBrainTurn(WS_A, 'spawn a worker');
      const a = threadOf(WS_A);
      expect(a.status).toBe('busy');
      expect(a.messages).toHaveLength(2);
      expect(a.messages[0]).toMatchObject({ role: 'user', text: 'spawn a worker' });
      expect(a.messages[1]).toMatchObject({ role: 'assistant', status: 'streaming' });
      // The OTHER workspace is untouched and not busy — the M1.5 parallelism.
      expect(threadOf(WS_B).status).toBe('idle');
      expect(threadOf(WS_B).messages).toHaveLength(0);
    });

    it('routes events by workspace: a background turn never leaks into another thread', () => {
      const st = useStore.getState();
      st.startDeckBrainTurn(WS_A, 'long job');
      st.startDeckBrainTurn(WS_B, 'quick job');
      // Interleaved streams — each event lands in ITS workspace's thread.
      st.applyDeckBrainEvent(WS_A, { type: 'text-delta', text: 'A-progress' });
      st.applyDeckBrainEvent(WS_B, { type: 'text-delta', text: 'B-progress' });
      st.applyDeckBrainEvent(WS_B, { type: 'turn-end', sessionId: 'sess-b' });
      st.applyDeckBrainEvent(WS_A, { type: 'text-delta', text: ' more' });

      const a = threadOf(WS_A);
      const b = threadOf(WS_B);
      expect(a.messages[1].text).toBe('A-progress more');
      expect(a.status).toBe('busy'); // A still streams…
      expect(b.messages[1]).toMatchObject({ text: 'B-progress', status: 'done' });
      expect(b.status).toBe('idle'); // …while B already finished.
    });

    it('turn-start (P3d scheduled run) opens a turn in its OWN workspace thread', () => {
      const st = useStore.getState();
      st.applyDeckBrainEvent(WS_B, { type: 'turn-start', prompt: '[Scheduled task] check PRs' });
      let b = threadOf(WS_B);
      expect(b.status).toBe('busy');
      expect(b.messages[0]).toMatchObject({ role: 'user', text: '[Scheduled task] check PRs' });
      expect(b.messages[1]).toMatchObject({ role: 'assistant', status: 'streaming' });
      expect(threadOf(WS_A).messages).toHaveLength(0);
      // The scheduled turn's stream lands in that open turn.
      st.applyDeckBrainEvent(WS_B, { type: 'text-delta', text: 'on it' });
      st.applyDeckBrainEvent(WS_B, { type: 'turn-end', sessionId: 'sess-s' });
      b = threadOf(WS_B);
      expect(b.status).toBe('idle');
      expect(b.messages[1]).toMatchObject({ text: 'on it', status: 'done' });
    });

    // The event carries the vendor that ACTUALLY served the turn. Reading the
    // store's live global instead stamped a turn the old brain produced with
    // the vendor the operator had just switched to — a false label, and a
    // false "the brain changed here" break in the log.
    it('stamps a main-originated turn with the vendor ON THE EVENT, not the live global', () => {
      useStore.setState({ deckBrainVendor: 'hermes' });
      const st = useStore.getState();
      st.applyDeckBrainEvent(WS_A, {
        type: 'turn-start',
        prompt: 'scheduled sweep',
        vendor: 'claude',
      });
      const a = threadOf(WS_A);
      expect(a.messages[0]).toMatchObject({ role: 'user', vendor: 'claude' });
      expect(a.messages[1]).toMatchObject({ role: 'assistant', vendor: 'claude' });
    });

    it('leaves a turn unstamped when the event names no vendor', () => {
      useStore.setState({ deckBrainVendor: 'hermes' });
      const st = useStore.getState();
      st.applyDeckBrainEvent(WS_B, { type: 'turn-start', prompt: 'legacy turn' });
      const b = threadOf(WS_B);
      expect(b.messages[0].vendor).toBeUndefined();
      expect(b.messages[1].vendor).toBeUndefined();
    });

    it('streams events into the open turn and returns to idle on turn-end', () => {
      const st = useStore.getState();
      st.startDeckBrainTurn(WS_A, 'go');
      st.applyDeckBrainEvent(WS_A, { type: 'text-delta', text: 'working' });
      st.applyDeckBrainEvent(WS_A, { type: 'tool-start', name: 'mcp__wmux__pane_list', inputSummary: '' });
      st.applyDeckBrainEvent(WS_A, { type: 'tool-end', name: 'mcp__wmux__pane_list', ok: true });
      expect(threadOf(WS_A).status).toBe('busy');
      st.applyDeckBrainEvent(WS_A, { type: 'turn-end', sessionId: 'sess-1' });

      const a = threadOf(WS_A);
      expect(a.status).toBe('idle');
      const assistant = a.messages[1];
      expect(assistant.text).toBe('working');
      expect(assistant.tools?.[0]).toMatchObject({ name: 'pane_list', ok: true });
      expect(assistant.status).toBe('done');
    });

    it('failDeckBrainTurn closes the open turn with an error and idles that workspace only', () => {
      const st = useStore.getState();
      st.startDeckBrainTurn(WS_A, 'go');
      st.startDeckBrainTurn(WS_B, 'also go');
      st.failDeckBrainTurn(WS_A, 'busy');
      const a = threadOf(WS_A);
      expect(a.status).toBe('idle');
      expect(a.messages[1].status).toBe('error');
      expect(a.messages[1].errorText).toBe('busy');
      expect(threadOf(WS_B).status).toBe('busy');
    });

    it('hydrateBrainPtyIds replaces the map with main\'s snapshot', () => {
      const st = useStore.getState();
      // A stale id from before a reload must not survive the hydration —
      // main is the authority on which terminals actually exist.
      st.setBrainPtyId(WS_A, 'brain-old');
      st.hydrateBrainPtyIds({ [WS_B]: 'brain-live' });
      expect(useStore.getState().brainPtyIds).toEqual({ [WS_B]: 'brain-live' });
    });
  });
});
