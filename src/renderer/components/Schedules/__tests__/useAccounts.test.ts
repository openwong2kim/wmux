import { describe, expect, it } from 'vitest';
import { accountOption } from '../useAccounts';

describe('accountOption', () => {
  it('marks an account that signs in only with a vault token, which a scheduled run cannot use', () => {
    const token = { createdAt: 1, usable: true };
    expect(accountOption({ id: 'a', name: 'Tok', vendor: 'claude', status: { loggedIn: false }, tokenSignIn: token }))
      .toEqual({ id: 'a', name: 'Tok', vendor: 'claude', tokenOnly: true });
    // Its folder has a login too, or it has no token: a schedule can run on it.
    expect(accountOption({ id: 'b', name: 'Both', vendor: 'claude', status: { loggedIn: true }, tokenSignIn: token }))
      .toEqual({ id: 'b', name: 'Both', vendor: 'claude' });
    expect(accountOption({ id: 'c', name: 'Browser', vendor: 'codex', status: { loggedIn: false } }))
      .toEqual({ id: 'c', name: 'Browser', vendor: 'codex' });
  });
});
