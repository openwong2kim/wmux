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
// This registry is the trust anchor for granting the brain terminal hands:
// main mints a random token per adapter spawn, injects it into ONLY the
// brain's MCP env (WMUX_COMMANDER_TOKEN), and the `deck.resolvePaneRoute`
// RPC resolves a pane's true owning workspace only for callers presenting a
// live token. Ordinary external MCP clients never see a token, so the #163
// fail-closed routing for them is unchanged.
//
// M1.5 (per-workspace orchestrator): a token is minted BOUND to the one
// workspace its brain serves, and route resolution is CONFINED to that
// workspace — a workspace's orchestrator cannot target another workspace's
// panes, so a misjudging brain's blast radius is its own workspace by
// construction (the §4.0 "structure is the security" decision; no capability
// lease system needed).
//
// Trust scope: same-user only (#113 ceiling — any same-user process already
// holds the pipe token). The commander token narrows, not widens: it marks
// the one subprocess the app itself launched as that workspace's hands
// (D2's tool allow-list still gates WHAT it may do — destructive tools stay
// denied).

//
// Agent factory: a token may instead be bound to a bot (`mintBotToken`), i.e.
// to {workspaceId, botId, role}. Such a token is a commander token for every
// existing check (same map, same envelope field, same workspace confinement)
// and additionally resolves to its BotBinding, which RpcRouter puts on
// RpcContext.bot and confines to the role's surface (shared/botSurface.ts).

import { randomUUID } from 'node:crypto';
import { isBotBinding, type BotBinding, type BotSurfaceNarrowing } from '../../shared/bot';

/** What a live token is bound to. */
export interface CommanderTokenBinding {
  /** The workspace the brain or bot serves. Empty = registered but
   *  unroutable (fail-closed everywhere). */
  workspaceId: string;
  /** Present only for a bot token. */
  bot?: BotBinding;
  /** A bot token's narrowed surface (shared/bot.ts BotSurfaceNarrowing);
   *  absent for every other token. */
  surface?: BotSurfaceNarrowing;
}

/** token → its binding. */
const live = new Map<string, CommanderTokenBinding>();

function newToken(): string {
  return `${randomUUID()}${randomUUID()}`;
}

/** Mint and register a commander token bound to `workspaceId` (one per brain
 *  adapter spawn). */
export function mintCommanderToken(workspaceId: string): string {
  const token = newToken();
  live.set(token, { workspaceId });
  return token;
}

/** Mint and register a bot token bound to `binding` (one per bot session
 *  spawn). Throws on a malformed binding: a bot token is never minted
 *  without a workspace, a bot id and a known role. */
export function mintBotToken(binding: BotBinding, surface?: BotSurfaceNarrowing): string {
  if (!isBotBinding(binding)) throw new Error('mintBotToken: malformed bot binding');
  const token = newToken();
  const bot: BotBinding = { workspaceId: binding.workspaceId, botId: binding.botId, role: binding.role };
  live.set(token, { workspaceId: bot.workspaceId, bot, ...(surface ? { surface } : {}) });
  return token;
}

/** token → when RpcRouter last accepted a call carrying it. */
const lastUse = new Map<string, number>();
/** token → callers waiting for its next accepted call. */
const useWaiters = new Map<string, Set<(at: number) => void>>();

/** Revoke a token — called from the adapter's dispose so a dead brain's
 *  token cannot be replayed by a later process. Idempotent. */
export function revokeCommanderToken(token: string): void {
  live.delete(token);
  lastUse.delete(token);
  for (const wake of useWaiters.get(token) ?? []) wake(-1);
  useWaiters.delete(token);
}

/** RpcRouter accepted a call carrying this live token (its MCP child is up
 *  and authenticated: every bot MCP child calls `mcp.identify` once its host
 *  initialises it). */
export function noteCommanderTokenUse(token: string, at: number = Date.now()): void {
  if (!live.has(token)) return;
  lastUse.set(token, at);
  const waiting = useWaiters.get(token);
  if (!waiting) return;
  useWaiters.delete(token);
  for (const wake of waiting) wake(at);
}

/** Resolves true once a call carrying `token` is accepted at or after
 *  `since` (ms), false after `timeoutMs` or when the token is revoked. */
export function waitForCommanderTokenUse(token: string, since: number, timeoutMs: number): Promise<boolean> {
  const seen = lastUse.get(token);
  if (seen !== undefined && seen >= since) return Promise.resolve(true);
  if (!live.has(token)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let waiting = useWaiters.get(token);
    if (!waiting) useWaiters.set(token, (waiting = new Set()));
    const set = waiting;
    const wake = (at: number) => {
      clearTimeout(timer);
      set.delete(wake);
      resolve(at >= since);
    };
    const timer = setTimeout(() => {
      set.delete(wake);
      resolve(false);
    }, timeoutMs);
    set.add(wake);
  });
}

/** Whether `token` is a live commander token. */
export function isCommanderToken(token: unknown): boolean {
  return typeof token === 'string' && token.length > 0 && live.has(token);
}

/** The workspace a live token is bound to, or null for a missing/stale token
 *  (and for a token minted with an empty binding — fail closed). */
export function commanderTokenWorkspace(token: unknown): string | null {
  return resolveCommanderToken(token)?.workspaceId ?? null;
}

/** The full binding of a live, routable token (a copy), or null for a
 *  missing/stale/unroutable one. RpcRouter's single lookup. */
export function resolveCommanderToken(token: unknown): CommanderTokenBinding | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const b = live.get(token);
  if (!b || !b.workspaceId) return null;
  return b.bot ? { workspaceId: b.workspaceId, bot: { ...b.bot }, ...(b.surface ? { surface: b.surface } : {}) } : { workspaceId: b.workspaceId };
}

/** The bot a live token is bound to, or null (also for a commander token). */
export function botTokenBinding(token: unknown): BotBinding | null {
  return resolveCommanderToken(token)?.bot ?? null;
}

/** Test-only: clear all registered tokens. */
export function __resetCommanderTrustForTesting(): void {
  live.clear();
  lastUse.clear();
  useWaiters.clear();
}
