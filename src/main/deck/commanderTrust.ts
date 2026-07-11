// ─── Command Deck — commander brain trust registry (P3b, codex P1) ──────────
//
// The commander brain's MCP subprocess has no pane ancestry, so the terminal
// routing treats it as a confirmed-external caller: explicit-ptyId terminal
// ops fail closed (no pin) or are confined to its claimed "MCP" workspace
// (pin ≠ the target pane's owner). That was invisible in the P2 E2E — the
// brain only ever drove panes inside its own claimed workspace — but fleet
// recovery (P3b) targets EXISTING panes across workspaces, which is the whole
// point of a commander.
//
// This registry is the trust anchor for granting the brain fleet-wide
// terminal hands: main mints a random token per adapter spawn, injects it
// into ONLY the brain's MCP env (WMUX_COMMANDER_TOKEN), and the
// `deck.resolvePaneRoute` RPC resolves a pane's true owning workspace only
// for callers presenting a live token. Ordinary external MCP clients never
// see a token, so the #163 fail-closed routing for them is unchanged.
//
// Trust scope: same-user only (#113 ceiling — any same-user process already
// holds the pipe token). The commander token narrows, not widens: it marks
// the one subprocess the app itself launched as the fleet's hands, per the
// deck design (the brain commands the fleet; D2's tool allow-list still
// gates WHAT it may do — destructive tools stay denied).

import { randomUUID } from 'node:crypto';

const live = new Set<string>();

/** Mint and register a commander token (one per brain adapter spawn). */
export function mintCommanderToken(): string {
  const token = `${randomUUID()}${randomUUID()}`;
  live.add(token);
  return token;
}

/** Revoke a token — called from the adapter's dispose so a dead brain's
 *  token cannot be replayed by a later process. Idempotent. */
export function revokeCommanderToken(token: string): void {
  live.delete(token);
}

/** Whether `token` is a live commander token. */
export function isCommanderToken(token: unknown): boolean {
  return typeof token === 'string' && token.length > 0 && live.has(token);
}

/** Test-only: clear all registered tokens. */
export function __resetCommanderTrustForTesting(): void {
  live.clear();
}
