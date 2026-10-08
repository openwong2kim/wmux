/**
 * Can this PC's Moa take cross-host work right now? The deck owns the answer
 * (Moa switched on, its HQ present and the one the link names, the wake
 * runtime started); main's RemoteA2aBridge asks before it marks anything for
 * Moa delivered, and retries what it held once the deck says the answer
 * changed. No probe registered = no.
 */
type Probe = (hqWorkspaceId: string) => boolean;

/** What the deck knows when the bridge asks. */
export interface BrainReceiverState {
  moaEnabled: boolean;
  /** The bus subscription that feeds the coalescer is running. */
  runtimeStarted: boolean;
  coalescerReady: boolean;
  /** The current HQ, and whether its workspace is there now. */
  hqWorkspaceId: string | null;
  hqPresent: boolean;
}

/** May work for the Moa of HQ `linkHq` be marked delivered now? */
export function brainReceiverReady(st: BrainReceiverState, linkHq: string): boolean {
  return st.moaEnabled && st.runtimeStarted && st.coalescerReady && st.hqWorkspaceId !== null && st.hqWorkspaceId === linkHq && st.hqPresent;
}

let probe: Probe | null = null;
const listeners = new Set<() => void>();

export function setBrainReceiver(next: Probe | null): void {
  probe = next;
  notifyBrainReceiverChanged();
}

export function brainCanReceive(hqWorkspaceId: string): boolean {
  try {
    return probe?.(hqWorkspaceId) === true;
  } catch {
    return false;
  }
}

/** Moa, its HQ or the wake runtime changed: held Moa work may go now. */
export function notifyBrainReceiverChanged(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // one listener must not stop the others
    }
  }
}

export function onBrainReceiverChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
