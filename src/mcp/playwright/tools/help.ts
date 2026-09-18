import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withAutomationLease } from '../automationLease';
import { sendScopedBrowserRpc, type BrowserToolDeps } from '../browserScope';
import { describeToolError } from '../toolError';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
} from '../../toolCatalog';
import {
  BROWSER_HELP_DEFAULT_TIMEOUT_MS,
  BROWSER_HELP_MAX_TIMEOUT_MS,
  BROWSER_HELP_PROMPT_MAX_CHARS,
  sanitizeHelpPrompt,
  type BrowserHelpState,
} from '../../../shared/browserHelp';

// ---------------------------------------------------------------------------
// browser_request_help — hand one blocked step back to the human.
//
// Every browser flow ends the same way at a login wall, a CAPTCHA, an OTP field,
// a payment confirmation or a consent screen: the agent cannot proceed and, until
// now, had no way to ask. The orchestrator's `deck_ask_decision` is a different
// surface (it asks the BRAIN a question about the work); this asks the OPERATOR
// to do something in a specific page, and resumes when they say so.
// ---------------------------------------------------------------------------

/** How often the tool asks main whether the request has settled. */
const STATUS_POLL_MS = 1_000;

/**
 * Machine-readable markers main puts at the front of its two contract refusals.
 * Matched by substring rather than prefix because the message reaches here
 * through the RPC transport, which may still carry a method tag.
 */
const NOT_SUPPORTED_MARKER = 'not_supported:';
const ALREADY_PENDING_MARKER = 'help_already_pending:';

const BROWSER_REQUEST_HELP_SHAPE = {
  prompt: z
    .string()
    .min(1)
    .max(BROWSER_HELP_PROMPT_MAX_CHARS)
    .describe('One sentence, e.g. "Sign in and solve the CAPTCHA, then press Done."'),
  ref: z
    .string()
    .optional()
    .describe('Snapshot ref to outline while you wait.'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Default 300000, max 900000.'),
  completion: z
    .object({
      urlIncludes: z.string().optional().describe('Substring the top-frame URL must contain.'),
      selector: z
        .string()
        .optional()
        .describe('CSS selector that must be present in the TOP frame (not inside an iframe).'),
    })
    .optional()
    .describe('Auto-finish when this holds for 1s (polled every 500ms). Builtin backend only.'),
  surfaceId: z
    .string()
    .optional()
    .describe('Omit for the surface you opened last.'),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The marker-and-remainder of a contract refusal, or null. */
function markerTail(message: string, marker: string): string | null {
  const at = message.indexOf(marker);
  return at === -1 ? null : message.slice(at);
}

/**
 * The result the agent reads, with the two machine-readable lines last.
 *
 * Last on purpose: a client that truncates a long result keeps its tail far more
 * often than its head is kept, and `help_state` is the only line a caller has to
 * branch on.
 */
function helpResult(state: BrowserHelpState, url: string | undefined, notes: string[]) {
  const lines = [...notes, `help_state: ${state}`, `url: ${url ?? '(unknown)'}`];
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

/** Human-readable lead-in for each terminal state. */
const STATE_SUMMARY: Record<Exclude<BrowserHelpState, 'pending'>, string> = {
  completed: 'Help request completed: the completion criteria you gave were met.',
  continued: 'Help request completed: the human pressed Done.',
  cancelled: 'Help request cancelled by the human — do not retry the same step unchanged.',
  timed_out: 'Help request timed out — nobody answered before the deadline.',
};

/**
 * Build the help catalog for one server instance.
 *
 * Tools:
 *  - browser_request_help — ask the operator to finish a step, then wait
 */
export function createHelpToolCatalog(deps: BrowserToolDeps) {
  const tool = defineWmuxTool({
    name: 'browser_request_help',
    // Kept tight on purpose: every profile pays this text in its tools/list
    // budget (scripts/mcp-protocol-baseline.json). The machine-readable contract
    // stays, the prose does not.
    description:
      'Ask the human to finish one step in the page (sign in, CAPTCHA, OTP, payment or consent) and WAIT, instead of looping on a page you cannot get past. Opens a Done/Cancel bar on the browser pane plus a Fleet inbox row; blocks until one is pressed, your completion criteria hold, or the deadline passes. Ends with two machine-readable lines: "help_state: completed | continued | cancelled | timed_out" and "url: <page url>".',
    inputSchema: BROWSER_REQUEST_HELP_SHAPE,
    profiles: ['full'],
    invoke: async ({ prompt, ref, timeoutMs, completion, surfaceId }) =>
      withAutomationLease(deps, surfaceId, async (scope) => {
        // Sanitized here as well as in main: the agent should be told its prompt
        // was unusable by the tool it called, not by a wire error.
        const cleanPrompt = sanitizeHelpPrompt(prompt);
        if (!cleanPrompt) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `prompt must contain 1-${BROWSER_HELP_PROMPT_MAX_CHARS} printable characters.`,
              },
            ],
            isError: true,
          };
        }
        const budget = Math.min(
          typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.floor(timeoutMs)
            : BROWSER_HELP_DEFAULT_TIMEOUT_MS,
          BROWSER_HELP_MAX_TIMEOUT_MS,
        );

        let opened: { requestId?: unknown; highlighted?: unknown };
        try {
          opened = await sendScopedBrowserRpc<{ requestId?: unknown; highlighted?: unknown }>(
            'browser.help.request',
            scope,
            {
              prompt: cleanPrompt,
              ...(ref !== undefined && { ref }),
              timeoutMs: budget,
              ...(completion !== undefined && { completion }),
            },
          );
        } catch (error) {
          const message = describeToolError(error);
          // The two contract refusals are reported with their marker leading the
          // text, so a caller can branch on the first characters without parsing
          // prose. Everything else is an ordinary tool error.
          const notSupported = markerTail(message, NOT_SUPPORTED_MARKER);
          const alreadyPending = markerTail(message, ALREADY_PENDING_MARKER);
          return {
            content: [{ type: 'text' as const, text: notSupported ?? alreadyPending ?? message }],
            isError: true,
          };
        }

        const requestId = typeof opened?.requestId === 'string' ? opened.requestId : '';
        if (!requestId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'browser_request_help: wmux accepted the request but returned no requestId, so the wait cannot be tracked.',
              },
            ],
            isError: true,
          };
        }

        const notes: string[] = [];
        // A ref that could not be resolved is REPORTED, not swallowed: the agent
        // believes it pointed the human at something, and a silent miss leaves a
        // prompt like "click the highlighted button" with nothing highlighted.
        if (ref !== undefined && opened.highlighted !== true) {
          notes.push(`Note: ref "${ref}" could not be resolved, so nothing was highlighted.`);
        }

        // The wait is a POLL, never one long RPC: the client's default request
        // timeout is 10s (src/mcp/wmux-client.ts), and a five-minute call would
        // be dropped by the transport long before the human answered. Each poll
        // also keeps the automation lease renewing through withAutomationLease.
        //
        // The local deadline is a backstop only — main owns the real one and
        // answers `timed_out` — so it is given a generous margin rather than
        // racing main's clock and reporting a timeout main disagrees with.
        const localDeadline = Date.now() + budget + 30_000;
        let lastUrl: string | undefined;
        for (;;) {
          await sleep(STATUS_POLL_MS);
          let status: { state?: unknown; url?: unknown };
          try {
            status = await sendScopedBrowserRpc<{ state?: unknown; url?: unknown }>(
              'browser.help.status',
              scope,
              { requestId },
            );
          } catch (error) {
            // A poll that failed says nothing about the request. Keep polling
            // until the local backstop: the row is still on the operator's
            // screen, and giving up here would abandon a request nobody
            // cancelled. Past the backstop, report the last thing we knew.
            if (Date.now() < localDeadline) continue;
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `browser_request_help: lost track of request ${requestId} — ` +
                    `${describeToolError(error)}. Cancel it from the wmux window if it is still open.`,
                },
              ],
              isError: true,
            };
          }
          if (typeof status?.url === 'string') lastUrl = status.url;
          const state = status?.state;
          if (state !== 'pending') {
            const settled = (typeof state === 'string' ? state : 'timed_out') as Exclude<
              BrowserHelpState,
              'pending'
            >;
            const summary = STATE_SUMMARY[settled] ?? `Help request ended: ${String(state)}.`;
            return helpResult(settled, lastUrl, [summary, ...notes]);
          }
          if (Date.now() >= localDeadline) {
            // Main should have settled it already; withdraw so the operator is
            // not left holding a row for a caller that has stopped listening.
            await sendScopedBrowserRpc('browser.help.cancel', scope, { requestId }).catch(() => {
              /* already settled, or main is unreachable — nothing to add */
            });
            return helpResult('timed_out', lastUrl, [STATE_SUMMARY.timed_out, ...notes]);
          }
        }
      }),
  });

  return Object.freeze([tool]);
}

/** Register the help catalog through the wire-neutral current-SDK adapter. */
export function registerHelpTools(
  server: McpServer,
  deps: BrowserToolDeps,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createHelpToolCatalog(deps), options);
}
