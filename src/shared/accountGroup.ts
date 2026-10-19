// ─── Account groups (work / personal / …) ───────────────────────────────────
//
// An account may name a group. Every automatic account pick stays inside the
// group of the account a workspace is bound to; accounts without a group form
// one implicit "ungrouped" pool, so a registry with no groups behaves exactly
// as before. Shared by main (store, rotation) and the renderer (Settings,
// account menus).

export const MAX_ACCOUNT_GROUP_CHARS = 40;

// eslint-disable-next-line no-control-regex -- a group name is a one-line label
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trimmed group name ('' = ungrouped), or null when it is not a valid one. */
export function normalizeAccountGroup(raw: unknown): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  const group = raw.trim();
  if (group.length > MAX_ACCOUNT_GROUP_CHARS || CONTROL.test(group)) return null;
  return group;
}

/** The group an account belongs to; '' for the ungrouped pool. */
export function accountGroupOf(account: { group?: string }): string {
  return account.group ?? '';
}

/** Accounts bucketed by group, named groups in name order, ungrouped last.
 *  Order inside a group is kept. */
export function groupAccounts<T extends { group?: string }>(accounts: readonly T[]): { group: string; accounts: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const a of accounts) {
    const g = accountGroupOf(a);
    const list = buckets.get(g);
    if (list) list.push(a);
    else buckets.set(g, [a]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([group, list]) => ({ group, accounts: list }));
}

/** {@link groupAccounts} with `boundGroup`'s bucket first (the pool the
 *  workspace rotates in); null keeps name order (nothing is bound). */
export function groupAccountsBoundFirst<T extends { group?: string }>(
  accounts: readonly T[],
  boundGroup: string | null,
): { group: string; accounts: T[] }[] {
  const buckets = groupAccounts(accounts);
  if (boundGroup === null) return buckets;
  return [...buckets.filter((b) => b.group === boundGroup), ...buckets.filter((b) => b.group !== boundGroup)];
}
