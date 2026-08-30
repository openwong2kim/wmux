// #922 PR-A — the workspace claim registry.
//
// The behaviour worth pinning here is not "a map stores things"; it is the
// SHAPE of the lookup result. A nullable binding would let a consumer write
// `if (!binding) { /* carry on */ }` and silently demote a caller whose token
// was revoked into one free to name its own workspace — the fail-open the BYOB
// commander gate already had to close by hand. These tests fix the three-state
// contract that makes that unwritable.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceClaimTrustForTesting,
  lookupWorkspaceClaim,
  mintWorkspaceClaimToken,
  revokeWorkspaceClaimToken,
  revokeWorkspaceClaimTokensFor,
} from '../workspaceClaimTrust';

beforeEach(() => {
  __resetWorkspaceClaimTrustForTesting();
});

describe('workspaceClaimTrust — minting', () => {
  it('binds a minted token to the workspace it was minted for', () => {
    const token = mintWorkspaceClaimToken('ws-claimed');
    expect(token).toBeTruthy();
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-claimed' });
  });

  it('mints a distinct token per claim', () => {
    const a = mintWorkspaceClaimToken('ws-a');
    const b = mintWorkspaceClaimToken('ws-a');
    expect(a).not.toEqual(b);
    expect(lookupWorkspaceClaim(a)).toEqual({ kind: 'bound', workspaceId: 'ws-a' });
    expect(lookupWorkspaceClaim(b)).toEqual({ kind: 'bound', workspaceId: 'ws-a' });
  });

  it.each([undefined, null, '', '   ', 42, {}])(
    'issues nothing for a workspace it cannot bind to (%p)',
    (workspaceId) => {
      // An unbound token would be a secret that proves nothing, and its mere
      // presence would invite a consumer to read meaning into it.
      expect(mintWorkspaceClaimToken(workspaceId)).toBeNull();
    },
  );

  it('trims the binding so a padded id cannot mint a second, unmatchable one', () => {
    const token = mintWorkspaceClaimToken('  ws-padded  ');
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-padded' });
  });
});

describe('workspaceClaimTrust — lookup states', () => {
  it('reports an absent token as unclaimed, not as stale', () => {
    // The distinction is the whole point: `unclaimed` is every caller that
    // never claimed and must keep working unchanged; `stale` must be refused.
    expect(lookupWorkspaceClaim(undefined)).toEqual({ kind: 'unclaimed' });
    expect(lookupWorkspaceClaim(null)).toEqual({ kind: 'unclaimed' });
  });

  it.each(['not-a-real-token', '', 0, false, {}, []])(
    'reports a presented-but-unresolvable token as stale (%p)',
    (token) => {
      expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'stale' });
    },
  );

  it('never answers with a bare string or null, so demotion cannot be written', () => {
    // A consumer must switch on `kind`; there is no falsy value to shortcut on.
    const live = lookupWorkspaceClaim(mintWorkspaceClaimToken('ws-x'));
    const dead = lookupWorkspaceClaim('nope');
    const none = lookupWorkspaceClaim(undefined);
    for (const result of [live, dead, none]) {
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('kind');
    }
    expect(new Set([live.kind, dead.kind, none.kind])).toEqual(
      new Set(['bound', 'stale', 'unclaimed']),
    );
  });
});

describe('workspaceClaimTrust — revocation', () => {
  it('turns a revoked token stale rather than unclaimed', () => {
    const token = mintWorkspaceClaimToken('ws-gone');
    revokeWorkspaceClaimToken(token);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'stale' });
  });

  it('is idempotent and ignores junk', () => {
    const token = mintWorkspaceClaimToken('ws-gone');
    revokeWorkspaceClaimToken(token);
    revokeWorkspaceClaimToken(token);
    revokeWorkspaceClaimToken(undefined);
    revokeWorkspaceClaimToken('');
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'stale' });
  });

  it('revokes every token bound to a closed workspace, leaving others alone', () => {
    // A workspace id can be re-minted later, so a surviving binding would
    // point an old token at a workspace its holder never claimed.
    const a1 = mintWorkspaceClaimToken('ws-closing');
    const a2 = mintWorkspaceClaimToken('ws-closing');
    const other = mintWorkspaceClaimToken('ws-staying');

    expect(revokeWorkspaceClaimTokensFor('ws-closing')).toBe(2);

    expect(lookupWorkspaceClaim(a1)).toEqual({ kind: 'stale' });
    expect(lookupWorkspaceClaim(a2)).toEqual({ kind: 'stale' });
    expect(lookupWorkspaceClaim(other)).toEqual({ kind: 'bound', workspaceId: 'ws-staying' });
  });

  it.each([undefined, '', '   ', 7])('revokes nothing for a junk workspace id (%p)', (ws) => {
    const token = mintWorkspaceClaimToken('ws-safe');
    expect(revokeWorkspaceClaimTokensFor(ws)).toBe(0);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-safe' });
  });
});
