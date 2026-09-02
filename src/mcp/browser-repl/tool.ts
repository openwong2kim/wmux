/**
 * The `browser_repl` MCP tool: one call runs a JavaScript snippet whose
 * `browser.*` calls go through this server's own `browser_*` handlers.
 *
 * Profile: `full` only, like the rest of the browser surface (the `browser_`
 * prefix is excluded from core by derivation, and the commander has no hands
 * in the browser at all).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ACTION_RING_CAPACITY } from '../../shared/browserReplay/actionTrace';
import { getConnectionScope } from '../connectionScope';
import { IDLE_SWEEP_INTERVAL_MS, IDLE_TIMEOUT_MS } from '../repl/replRegistry';
import { MAX_TIMEOUT_MS } from '../repl/tools';
import type { CollectedTool } from '../playwright/toolCollector';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
  type WmuxToolSpec,
} from '../toolCatalog';
import { BROWSER_REPL_TOOLS, createBrowserBridge } from './bridge';
import { BrowserReplSession, type BrowserReplRunOutcome } from './BrowserReplSession';

/** Longer than repl_run's 30s: a script here waits on real pages. */
export const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 100;

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(requested)));
}

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text' as const, text: body }], isError: isError || undefined };
}

// ── per-connection session registry ───────────────────────────────────────

/**
 * Sessions live on the connection scope under the broker (one agent's globals
 * must not become another's) and in this module global for the single-child
 * server, which belongs to exactly one agent already.
 */
let processSession: BrowserReplSession | null = null;
const liveSessions = new Set<BrowserReplSession>();
let sweepTimer: NodeJS.Timeout | null = null;
/**
 * True once this process hosts several agents' connections (set by the broker).
 * The process-wide fallback below is only right when the process belongs to
 * one agent; under the broker a call that lost its scope must fail rather than
 * land on a worker shared with everyone else — same rule as `getReplRegistry`.
 */
let brokerMode = false;

export function setBrowserReplBrokerMode(): void {
  brokerMode = true;
}

function forgetSession(session: BrowserReplSession): void {
  liveSessions.delete(session);
  if (processSession === session) processSession = null;
  if (liveSessions.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Terminate every session idle past the REPL threshold; returns how many. */
export function reclaimIdleBrowserRepls(now: number = Date.now()): number {
  let reclaimed = 0;
  for (const session of [...liveSessions]) {
    if (session.busy || now - session.lastUsed < IDLE_TIMEOUT_MS) continue;
    session.dispose();
    forgetSession(session);
    reclaimed++;
  }
  return reclaimed;
}

function trackSession(session: BrowserReplSession): void {
  liveSessions.add(session);
  if (!sweepTimer) {
    sweepTimer = setInterval(() => reclaimIdleBrowserRepls(), IDLE_SWEEP_INTERVAL_MS);
    // An idle worker waiting to be reaped must not keep the server alive.
    sweepTimer.unref?.();
  }
}

function getSession(create: () => BrowserReplSession): BrowserReplSession {
  const scope = getConnectionScope();
  if (scope) {
    let session = scope.browserRepl as BrowserReplSession | undefined;
    if (!session || !liveSessions.has(session)) {
      session = create();
      scope.browserRepl = session;
      trackSession(session);
    }
    return session;
  }
  if (brokerMode) {
    throw new Error(
      'internal: no MCP connection scope is active, so this browser_repl call cannot be attributed ' +
        "to a caller. Refusing rather than risking another agent's runtime.",
    );
  }
  if (!processSession || !liveSessions.has(processSession)) {
    processSession = create();
    trackSession(processSession);
  }
  return processSession;
}

/**
 * Tear down the calling connection's session. Tolerant on purpose: this runs
 * on the connection-close path beside `disposeReplRegistry`, where throwing
 * would abandon the rest of the teardown.
 */
export function disposeBrowserRepl(): void {
  const scope = getConnectionScope();
  const session = scope
    ? (scope.browserRepl as BrowserReplSession | undefined)
    : processSession ?? undefined;
  if (scope) scope.browserRepl = undefined;
  if (!session) return;
  session.dispose();
  forgetSession(session);
}

// ── output ────────────────────────────────────────────────────────────────

export function formatBrowserReplOutcome(outcome: BrowserReplRunOutcome): string {
  const lines: string[] = [];
  lines.push(
    `browser_repl · ${outcome.ok ? 'ok' : 'error'} · ${outcome.elapsedMs}ms · ${outcome.ledger.length} browser call(s)`,
  );
  if (outcome.freshRuntime) {
    lines.push(
      outcome.previousDeath
        ? `note: the previous runtime is gone (${outcome.previousDeath}); this run started a fresh one with no variables`
        : 'note: started a new runtime',
    );
  }
  if (outcome.timedOut) {
    lines.push('note: the runtime was terminated. Variables are cleared; the next call starts fresh.');
  }
  if (outcome.ledger.length > ACTION_RING_CAPACITY) {
    lines.push(
      `note: ${outcome.ledger.length} calls exceed the ${ACTION_RING_CAPACITY}-step action ring; ` +
        'only the last steps are available to browser_replay save.',
    );
  }
  if (outcome.ledger.length > 0) {
    lines.push('', '--- calls ---', ...outcome.ledger.map((l, i) => `${i + 1}. ${l}`));
  }
  if (outcome.console.text) {
    lines.push('', '--- console ---', outcome.console.text.replace(/\n$/, ''));
    if (outcome.console.truncated) {
      lines.push(`(console truncated: ${outcome.console.totalBytes} bytes total)`);
    }
  }
  if (outcome.ok && outcome.result && outcome.result.text !== 'undefined') {
    lines.push('', '--- result ---', outcome.result.text);
    if (outcome.result.truncated) {
      lines.push(`(result truncated: ${outcome.result.totalBytes} bytes total)`);
    }
  }
  if (!outcome.ok && outcome.error) {
    lines.push('', '--- error ---', outcome.error);
  }
  return lines.join('\n');
}

// ── catalog ───────────────────────────────────────────────────────────────

// Tight on purpose: this rides in tools/list for every full-profile session,
// and the probe's byte budget is nearly spent. The whitelist is the one list
// worth its bytes — it is the permission boundary this tool moves.
const BROWSER_REPL_DESCRIPTION =
  'Run a JavaScript snippet that drives the browser through many steps in ONE call. ' +
  'Each allowed browser_X tool is `await browser.X(args)` with the same args, resolving to ' +
  '{text, events} (+ refs:[{ref,param,role,name}] for snapshot/smart_snapshot, full listing by default; ' +
  'pass refs[i].ref as the arg named refs[i].param). A failed step throws (catchable). ' +
  `Allowed: ${BROWSER_REPL_TOOLS.join(', ')}. ` +
  'Other browser_* tools stay separate calls. Top-level await works; state persists between calls ' +
  'until a timeout kills the runtime, but let/const inside an awaiting snippet do not — assign to ' +
  'globalThis to keep a value. console.log is captured; sleep(ms) is available. ' +
  'Every step still records to the action trace for browser_replay.';

export function createBrowserReplCatalog(
  tools: ReadonlyMap<string, CollectedTool>,
): readonly WmuxToolSpec[] {
  const browserRepl = defineWmuxTool({
    name: 'browser_repl',
    description: BROWSER_REPL_DESCRIPTION,
    inputSchema: {
      code: z.string().describe('JavaScript. The last expression is the return value.'),
      timeout: z
        .number()
        .optional()
        .describe(`Milliseconds before the runtime is killed; default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
      surfaceId: z
        .string()
        .optional()
        .describe('Default surfaceId for every browser.* call in this snippet.'),
    },
    profiles: ['full'],
    invoke: async ({ code, timeout, surfaceId }) => {
      // Captured HERE, inside the MCP dispatch, and re-entered per call: the
      // worker's messages arrive outside this AsyncLocalStorage context.
      const scope = getConnectionScope();
      const bridge = createBrowserBridge(tools, { surfaceId, scope });
      const session = getSession(() => new BrowserReplSession(BROWSER_REPL_TOOLS));
      try {
        const outcome = await session.run(code, clampTimeout(timeout), bridge);
        return text(formatBrowserReplOutcome(outcome), !outcome.ok);
      } catch (error) {
        return text(`browser_repl: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });
  return Object.freeze([browserRepl]);
}

export function registerBrowserReplTool(
  server: McpServer,
  tools: ReadonlyMap<string, CollectedTool>,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createBrowserReplCatalog(tools), options);
}
