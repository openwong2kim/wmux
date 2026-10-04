import { useEffect } from 'react';
import { useStore } from '../stores';

/** Keep the store's Moa state in step with main: read once on mount, then
 *  again on every DECK_MOA_CHANGED (switch, settings, HQ presence). */
export function useMoaSync(): void {
  const refreshMoa = useStore((s) => s.refreshMoa);
  useEffect(() => {
    void refreshMoa();
    const off = window.electronAPI?.deck?.moa?.onChanged?.(() => { void refreshMoa(); });
    return () => off?.();
  }, [refreshMoa]);
}
