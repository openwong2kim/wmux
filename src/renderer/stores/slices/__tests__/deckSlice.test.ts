import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

describe('deckSlice', () => {
  beforeEach(() => {
    useStore.setState({ activeDeckTab: 'commander' });
  });

  it('defaults to the Commander tab', () => {
    expect(useStore.getState().activeDeckTab).toBe('commander');
  });

  it('switches the active deck tab', () => {
    useStore.getState().setActiveDeckTab('channels');
    expect(useStore.getState().activeDeckTab).toBe('channels');
    useStore.getState().setActiveDeckTab('commander');
    expect(useStore.getState().activeDeckTab).toBe('commander');
  });
});
