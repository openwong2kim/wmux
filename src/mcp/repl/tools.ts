/**
 * The `repl_*` MCP tools.
 *
 * Registered through the typed catalog (`defineWmuxTool`/`registerWmuxTools`)
 * like the browser wait domain, so the specs stay frozen and profile selection
 * stays immutable at launch.
 *
 * Profile: `full` only. The commander surface is deliberately the brain's
 * narrow hands (no browser, no pane teardown); a general-purpose runtime does
 * not belong there.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
  type WmuxToolSpec,
} from '../toolCatalog';
import {
  DEFAULT_SESSION_NAME,
  IDLE_TIMEOUT_MS,
  MAX_SESSIONS_PER_CONNECTION,
  getReplRegistry,
  isValidSessionName,
} from './replRegistry';
import type { ReplEvalOutcome } from './ReplSession';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 300_000;

/** Clamp rather than reject: a caller asking for 10 minutes wants the ceiling. */
export function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(requested)));
}

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text' as const, text: body }], isError: isError || undefined };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** Render one eval into the block layout the agent reads. */
export function formatOutcome(
  sessionName: string,
  outcome: ReplEvalOutcome,
  notes: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(
    `session ${sessionName} · ${outcome.ok ? 'ok' : 'error'} · ${outcome.elapsedMs}ms`,
  );
  for (const note of notes) lines.push(`note: ${note}`);
  if (outcome.fatal) lines.push(`note: ${outcome.fatal}`);
  if (outcome.timedOut) {
    lines.push('note: the code was stopped by the timeout. Session state survived.');
  }
  if (outcome.remedy) lines.push(`note: ${outcome.remedy}`);

  if (outcome.background) {
    lines.push(
      '',
      '--- background output (from an earlier run still going) ---',
      outcome.background.replace(/\n$/, ''),
    );
  }
  if (outcome.stdout.text) {
    lines.push('', '--- stdout ---', outcome.stdout.text.replace(/\n$/, ''));
    if (outcome.stdout.truncated) {
      lines.push(`(stdout truncated: ${outcome.stdout.totalBytes} bytes total)`);
    }
  }
  if (outcome.stderr.text) {
    lines.push('', '--- stderr ---', outcome.stderr.text.replace(/\n$/, ''));
    if (outcome.stderr.truncated) {
      lines.push(`(stderr truncated: ${outcome.stderr.totalBytes} bytes total)`);
    }
  }
  if (outcome.ok && outcome.result) {
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

// Descriptions are deliberately tight: every byte here rides in tools/list on
// every session, and the protocol probe enforces a total budget for that view
// that the whole tool surface shares. Each sentence that survived earns its
// place — the persistence contract, the await caveat, and the two facts an
// agent would otherwise get wrong (no sandbox, no lifetime past the
// connection). The `let` re-declaration rule is deliberately NOT here: the
// session reports it as a remedy at the moment it bites, which reaches the
// caller when it matters instead of costing context on every session.
const REPL_RUN_DESCRIPTION =
  'Run JavaScript in a persistent Node runtime and get the return value back. ' +
  'State survives between calls: variables (including top-level let/const), required ' +
  'modules, and open handles are still there next call. Top-level await works, but ' +
  'declarations inside an awaiting snippet do not persist — assign to a global ' +
  '(x = await f()). Full fs/net/require access, NO sandbox. Lives only as long as your ' +
  'MCP connection: no wmux restart, no sharing with other panes or workspaces.';

const REPL_RESET_DESCRIPTION =
  'Throw away a REPL session and its state; the next repl_run starts a fresh runtime.';

const REPL_SESSIONS_DESCRIPTION =
  'List this connection\'s REPL sessions: cwd, pid, age, and current state.';

export function createReplToolCatalog(): readonly WmuxToolSpec[] {
  const replRun = defineWmuxTool({
    name: 'repl_run',
    description: REPL_RUN_DESCRIPTION,
    inputSchema: {
      code: z.string().describe('JavaScript to evaluate. The last expression is the return value.'),
      session: z
        .string()
        .optional()
        .describe(`Session name; defaults to "${DEFAULT_SESSION_NAME}". Letters, digits, . _ - only.`),
      timeout: z
        .number()
        .optional()
        .describe(
          `Milliseconds before the run is stopped; default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory, honoured only when the session is created. Defaults to the MCP " +
            "server's cwd, which is not necessarily your pane's — pass it explicitly.",
        ),
    },
    profiles: ['full', 'core'],
    invoke: async ({ code, session, timeout, cwd }) => {
      const name = session ?? DEFAULT_SESSION_NAME;
      if (!isValidSessionName(name)) {
        return text(`Invalid session name "${name}". Use 1-64 of: letters, digits, dot, underscore, hyphen.`, true);
      }
      const registry = getReplRegistry();
      const notes: string[] = [];
      let acquired;
      try {
        acquired = registry.acquire(name, cwd ?? process.cwd());
      } catch (error) {
        return text(String(error instanceof Error ? error.message : error), true);
      }
      if (acquired.created) {
        if (acquired.previousDeath) {
          notes.push(`the previous "${name}" runtime is gone (${acquired.previousDeath}); this is a fresh one with no state`);
        }
        notes.push(`started a new runtime in ${acquired.session.cwd}`);
        if (acquired.session.withheldCredentials.length > 0) {
          notes.push(
            `credential env vars are withheld from the REPL: ${acquired.session.withheldCredentials.join(', ')}`,
          );
        }
      } else if (cwd && cwd !== acquired.session.cwd) {
        notes.push(
          `cwd was ignored — session "${name}" is already running in ${acquired.session.cwd}. ` +
            'Call repl_reset first, or use a different session name.',
        );
      }

      try {
        const outcome = await acquired.session.run(code, clampTimeout(timeout));
        return text(formatOutcome(name, outcome, notes), !outcome.ok);
      } catch (error) {
        return text(
          `session ${name}: ${String(error instanceof Error ? error.message : error)}`,
          true,
        );
      }
    },
  });

  const replReset = defineWmuxTool({
    name: 'repl_reset',
    description: REPL_RESET_DESCRIPTION,
    inputSchema: {
      session: z
        .string()
        .optional()
        .describe(`Session name; defaults to "${DEFAULT_SESSION_NAME}".`),
    },
    profiles: ['full', 'core'],
    invoke: ({ session }) => {
      const name = session ?? DEFAULT_SESSION_NAME;
      if (!isValidSessionName(name)) {
        return text(`Invalid session name "${name}".`, true);
      }
      const existed = getReplRegistry().reset(name);
      return text(
        existed
          ? `Killed REPL session "${name}". The next repl_run starts a fresh runtime.`
          : `No REPL session "${name}" was running. The next repl_run starts a fresh runtime.`,
      );
    },
  });

  const replSessions = defineWmuxTool({
    name: 'repl_sessions',
    description: REPL_SESSIONS_DESCRIPTION,
    inputSchema: {},
    profiles: ['full', 'core'],
    invoke: () => {
      const sessions = getReplRegistry().list();
      const header =
        `REPL sessions are scoped to this MCP connection, capped at ${MAX_SESSIONS_PER_CONNECTION}, ` +
        `and reaped after ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes idle.`;
      if (sessions.length === 0) {
        return text(`No REPL sessions running.\n${header}`);
      }
      const now = Date.now();
      const rows = sessions.map((s) =>
        [
          s.name,
          `pid ${String(s.pid ?? '?')}`,
          // Report the real state: a session still coming up is not idle, and
          // saying so sends the agent looking for a runtime that is not ready.
          s.status,
          `${s.evals} run(s)`,
          `up ${formatDuration(now - s.createdAt)}`,
          `idle ${formatDuration(now - s.lastUsed)}`,
          // Runtime output, not schema: the countdown an agent needs to decide
          // whether its runtime will still be there costs nothing in tools/list.
          // Busy sessions are spared by the sweep, so no countdown applies.
          s.busy
            ? 'reclaim held while busy'
            : `reclaim in ${formatDuration(Math.max(0, IDLE_TIMEOUT_MS - (now - s.lastUsed)))}`,
          s.cwd,
        ].join(' · '),
      );
      return text([...rows, '', header].join('\n'));
    },
  });

  return Object.freeze([replRun, replReset, replSessions]);
}

/** Register the REPL catalog through the wire-neutral current-SDK adapter. */
export function registerReplTools(server: McpServer, options: RegisterWmuxToolsOptions): void {
  registerWmuxTools(server, createReplToolCatalog(), options);
}
