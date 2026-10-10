/**
 * The store a sidebar row reads. By default it is the app store; under a
 * `RowStoreContext.Provider` it is another store of the same shape, so the
 * very same row components (WorkspaceItem and its pane rows) can draw rows
 * that are not this computer's: the PC rail's host list provides a read-only
 * projection of one paired computer (see hostRowStore.ts).
 *
 * Only reads go through it. Imperative calls in handlers keep using the app
 * store, which is why the projection sets `readOnly`: the rows then offer no
 * local action at all.
 */
import { createContext, useContext } from 'react';
import { useStore as useZustandStore, type StoreApi } from 'zustand';
import { useStore, type StoreState } from './index';

export const RowStoreContext = createContext<StoreApi<StoreState> | null>(null);

/** The row's store: the provided one, else the app store. */
export function useRowStoreApi(): StoreApi<StoreState> {
  return useContext(RowStoreContext) ?? useStore;
}

/** `useStore(selector)`, read from the row's store. */
export function useRowStore<T>(selector: (state: StoreState) => T): T {
  return useZustandStore(useRowStoreApi(), selector);
}

/**
 * Under a provided row store: what a pane row's click does instead of
 * focusing a local pane (the host list opens the shadow at that tab).
 */
export const RowOpenSurfaceContext = createContext<((surfaceId: string) => void) | null>(null);
