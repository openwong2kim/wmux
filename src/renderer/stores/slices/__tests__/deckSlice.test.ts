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
});
