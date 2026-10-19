// One counter every store the holder set reads bumps when it changes
// (workerHolders.ts): a look at the holder set is reused only while this
// counter has not moved, within one turn of the event loop.

let revision = 0;

/** A record the holder set reads changed (a booking, a grant, a launch, a
 *  reclaim record, a verdict, a gone fact). */
export function holderInputsChanged(): void {
  revision++;
}

/** Moves on every change above. */
export function holderInputsRevision(): number {
  return revision;
}
