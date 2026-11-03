import { useEffect } from 'react';
import { useStore } from '../stores';

// ─── Computer-use marker bridge ──────────────────────────────────────────────
//
// The single owner of the `computerUse.onAgentMarkers` subscription, mounted
// once in AppLayout. Reads main's list once, then takes every pushed list
// whole (agentMarkerSlice). Main keeps the colours, not the daemon, so a
// daemon reconnect needs no re-read.

export function useAgentMarkersBridge(): void {
  useEffect(() => {
    const api = window.electronAPI?.computerUse;
    if (!api?.agentMarkers || !api.onAgentMarkers) return; // older preload bundles

    let pushed = false;
    const off = api.onAgentMarkers((entries) => {
      pushed = true;
      useStore.getState().setAgentMarkers(entries ?? []);
    });
    void api.agentMarkers().then((entries) => {
      // A push that landed first is newer than this read.
      if (!pushed) useStore.getState().setAgentMarkers(entries ?? []);
    }).catch(() => { /* best-effort — the next push brings the list */ });

    return off;
  }, []);
}
