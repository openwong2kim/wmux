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
  reconcileWorkspaceClaims,
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
  it('reports an ABSENT token as unclaimed', () => {
    // The distinction is the whole point: `unclaimed` is every caller that
    // never claimed and must keep working unchanged; `stale` must be refused.
    // Only absence qualifies — see the null case below.
    expect(lookupWorkspaceClaim(undefined)).toEqual({ kind: 'unclaimed' });
  });

  it('reports an explicit null as STALE, not unclaimed', () => {
    // The demotion this whole type exists to prevent, reached through data
    // rather than through code. A consumer gates on "the field is present and
    // not undefined", which `null` satisfies; if the lookup then answered
    // `unclaimed`, nothing would be stamped on the context and the caller would
    // fall through to the lane that lets it name any workspace. So a caller
    // whose token was revoked could send `workspaceToken: null` and be restored
    // to the freedom it just lost. JSON carries null freely, so this is a
    // one-word change away for anyone who tries it.
    expect(lookupWorkspaceClaim(null)).toEqual({ kind: 'stale' });
  });

  it.each(['not-a-real-token', '', 0, false, {}, [], NaN])(
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
    // `null` must land with `dead`, not with `none`.
    expect(lookupWorkspaceClaim(null)).toEqual(dead);
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

describe('workspaceClaimTrust — reconcile against the live workspace set', () => {
  // The `workspace.close` RPC is not how most workspaces die: the sidebar X,
  // the close keybinding and the settings reset all remove one through the
  // renderer store without reaching a main handler. The renderer's workspace
  // mirror push is the signal that does see those, and `bound` must not stay
  // true for a workspace that is gone — a scoping lane trusts `bound` to mean
  // "alive and owned by this holder".
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    __resetWorkspaceClaimTrustForTesting(() => clock);
  });

  /** Push a token past the grace window so reconcile may act on it. */
  const age = (ms = 120_000) => { clock += ms; };

  it('retires a claim whose workspace is no longer live', () => {
    const token = mintWorkspaceClaimToken('ws-closed-in-ui');
    age();

    expect(reconcileWorkspaceClaims(['ws-still-here'])).toBe(1);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'stale' });
  });

  it('leaves a claim whose workspace is still live', () => {
    const token = mintWorkspaceClaimToken('ws-alive');
    age();

    expect(reconcileWorkspaceClaims(['ws-alive', 'ws-other'])).toBe(0);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-alive' });
  });

  it('never retires a claim younger than the grace window', () => {
    // The race this guards: a mirror push already in flight when the claim
    // created its workspace describes the tree BEFORE that workspace existed,
    // and would arrive just after the mint. Retiring on it would kill a claim
    // that is perfectly live, one call after it was issued.
    const token = mintWorkspaceClaimToken('ws-brand-new');

    expect(reconcileWorkspaceClaims(['ws-something-else'])).toBe(0);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-brand-new' });
  });

  it('ignores an empty live set rather than retiring everything', () => {
    // The renderer store always keeps one workspace, so an empty set is far
    // more likely to be a bad frame than a real observation.
    const token = mintWorkspaceClaimToken('ws-alive');
    age();

    expect(reconcileWorkspaceClaims([])).toBe(0);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-alive' });
  });

  it('ignores junk ids in the live set without retiring good claims', () => {
    const token = mintWorkspaceClaimToken('ws-alive');
    age();

    expect(reconcileWorkspaceClaims(['ws-alive', '', '   '])).toBe(0);
    expect(lookupWorkspaceClaim(token)).toEqual({ kind: 'bound', workspaceId: 'ws-alive' });
  });

  it('retires several claims for one dead workspace in a single pass', () => {
    const a = mintWorkspaceClaimToken('ws-dead');
    const b = mintWorkspaceClaimToken('ws-dead');
    const keep = mintWorkspaceClaimToken('ws-alive');
    age();

    expect(reconcileWorkspaceClaims(['ws-alive'])).toBe(2);
    expect(lookupWorkspaceClaim(a)).toEqual({ kind: 'stale' });
    expect(lookupWorkspaceClaim(b)).toEqual({ kind: 'stale' });
    expect(lookupWorkspaceClaim(keep)).toEqual({ kind: 'bound', workspaceId: 'ws-alive' });
  });
});

describe('workspaceClaimTrust — bounded growth', () => {
  beforeEach(() => {
    __resetWorkspaceClaimTrustForTesting();
  });

  it('evicts the oldest claim past the cap so secrets cannot accumulate', () => {
    // Backstop for a main that never receives a mirror push. Claims need the
    // renderer to mint, so this should be unreachable — it exists so a
    // long-lived process cannot hold an unbounded set of live secrets.
    const first = mintWorkspaceClaimToken('ws-first');
    for (let i = 0; i < 512; i++) mintWorkspaceClaimToken(`ws-${i}`);

    expect(lookupWorkspaceClaim(first)).toEqual({ kind: 'stale' });
  });
});
