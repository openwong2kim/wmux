/**
 * Codex approval requests (app-server ServerRequests) a phone may answer.
 * Shapes: src/daemon/web/__tests__/fixtures/codex-server-requests.json.
 *
 * Only a command approval that lists its own choices, including both `accept`
 * and `cancel`, is offered: Yes = `accept`, No = `cancel` (what the TUI sends
 * for Esc, which interrupts the turn). Choices that grant lasting permission
 * (`acceptForSession`, `acceptWithExecpolicyAmendment`) are never offered.
 * A file change stays in the terminal: its request carries neither the files
 * nor the diff, so a phone would approve changes it cannot see. Elicitation,
 * `requestUserInput` and the legacy approval methods stay there too.
 */

export const CODEX_DECISION_METHODS = [
  'item/commandExecution/requestApproval',
] as const;
export type CodexDecisionMethod = typeof CODEX_DECISION_METHODS[number];
export type CodexDecisionAnswer = 'accept' | 'cancel';

export interface CodexDecisionRequest {
  method: CodexDecisionMethod;
  threadId: string;
  question: string;
  toolName: string;
  summary?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The phone-answerable decision a server request asks for, or undefined. */
export function codexDecisionFromRequest(message: unknown): CodexDecisionRequest | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const {method, params} = message as {method?: unknown; params?: unknown};
  if (!CODEX_DECISION_METHODS.includes(method as CodexDecisionMethod)) return undefined;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const p = params as Record<string, unknown>;
  const threadId = text(p.threadId);
  if (!threadId) return undefined;
  if (!Array.isArray(p.availableDecisions)) return undefined;
  if (!p.availableDecisions.includes('accept') || !p.availableDecisions.includes('cancel')) return undefined;
  const command = text(p.command);
  if (!command) return undefined;
  return {method: 'item/commandExecution/requestApproval', threadId, question: text(p.reason) ?? 'Run this command?', toolName: 'command', summary: command};
}
