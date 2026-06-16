// Pure guard for the WMUX_DATA_SUFFIX userData-isolation invariant. Extracted so
// it is unit-testable without booting Electron (main/index.ts runs at module
// top-level and pulls in `app`).

export type IsolationCheck = { ok: true } | { ok: false; error: string };

/**
 * After applying WMUX_DATA_SUFFIX to userData, verify the isolation actually
 * took. A NON-EMPTY suffix MUST be reflected in the resolved userData path; if
 * setPath threw / silently no-op'd, userData stays at the PRODUCTION location and
 * an isolated instance would read prod's session.json — restoring the wrong
 * workspaces (the observed "a fresh suffix restored an old workspace" bug). Fail
 * ONLY on that precise mismatch.
 *
 * An EMPTY suffix is legitimate production (no isolation requested) and ALWAYS
 * passes — never fail just because userData equals the prod default. This is the
 * load-bearing distinction: the guard must not turn every normal production boot
 * into a crash.
 */
export function checkUserDataIsolation(
  suffix: string,
  resolvedUserData: string,
  originalUserData: string,
): IsolationCheck {
  if (!suffix) return { ok: true };
  // Exact-path comparison, NOT a tail substring (`endsWith`). A suffix that
  // coincidentally tails the production path — e.g. 'x' when userData already
  // ends in 'wmux' — would let endsWith() report success even after setPath
  // failed/no-op'd and the app is still pointed at production state, the exact
  // corruption this guard exists to catch.
  if (resolvedUserData === originalUserData + suffix) return { ok: true };
  return {
    ok: false,
    error:
      `data isolation broken: WMUX_DATA_SUFFIX="${suffix}" but userData resolved to ` +
      `"${resolvedUserData}" (expected "${originalUserData}${suffix}"). Refusing to boot ` +
      `onto the production data dir — an isolated instance would corrupt or restore ` +
      `production state.`,
  };
}
