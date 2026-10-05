// Per-delivery checks main registers for one gated A2A delivery (Moa's auto
// hand-off re-checks both workspaces' modes). The key rides the send to the
// renderer and back on GATED_SUBMIT; input.rpc runs the check right before
// the paste and right before the Enter. A key with nothing registered refuses:
// the caller asked for a check that is no longer there.

export interface DeliveryCheck {
  /** null = go on; a string = refuse, with this detail. */
  beforePaste: () => Promise<string | null> | string | null;
  beforeEnter: () => Promise<string | null> | string | null;
}

const checks = new Map<string, DeliveryCheck>();

/** Register a check under `key`. Returns the unregister. */
export function registerDeliveryCheck(key: string, check: DeliveryCheck): () => void {
  checks.set(key, check);
  return () => {
    if (checks.get(key) === check) checks.delete(key);
  };
}

export function getDeliveryCheck(key: string): DeliveryCheck | null {
  return checks.get(key) ?? null;
}
