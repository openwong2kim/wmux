// ─── Moa's own permission prompt, for the desktop's Moa chat (#1772) ────────
//
// The HQ brain's permission dialog is a `terminal_prompt` record in the daemon
// (web/moaPrompt.ts). The desktop reads it and presses one of its choices over
// two first-party daemon RPCs, called ONLY from the renderer IPC handlers
// (DECK_MOA_APPROVAL / _ANSWER): they are not registered in main's pipe router,
// the MCP capability map or the CLI, so no agent — Moa included — can answer
// Moa's own prompt. The daemon checks that the record is the Moa pane's,
// fixes `resolvedBy` to 'desktop' and keeps every fence a phone answer meets.

import type { MoaApproval, MoaApprovalAnswerResult } from '../../shared/moa';

/** The daemon client calls this module makes. */
export interface MoaApprovalClient {
  rpc(method: string, params?: unknown): Promise<unknown>;
}

export const MOA_PROMPT_RPC = 'daemon.moa.prompt';
export const MOA_ANSWER_PROMPT_RPC = 'daemon.moa.answerPrompt';
/** The same desktop answer for a delegated agent's prompt (main scopes it). */
export const MOA_ANSWER_DELEGATED_PROMPT_RPC = 'daemon.moa.answerDelegatedPrompt';

/** Refusals that mean "answered or gone elsewhere": the card just leaves. */
const NOT_PENDING = new Set(['not-pending', 'not-found', 'already-resolved', 'already-answered', 'expired', 'prompt-gone', 'unauthorized']);

function choicesOf(value: unknown): Array<{ key: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((c): c is { key: string; label: string } =>
    !!c && typeof c === 'object' && typeof (c as { key?: unknown }).key === 'string' && typeof (c as { label?: unknown }).label === 'string')
    .map((c) => ({ key: c.key, label: c.label }));
  return out.length > 0 ? out : undefined;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** The Moa pane's pending prompt, or null (none, Moa off, no daemon). */
export async function readMoaApproval(client: MoaApprovalClient | null): Promise<MoaApproval | null> {
  if (!client) return null;
  let answer: unknown;
  try {
    answer = await client.rpc(MOA_PROMPT_RPC, {});
  } catch {
    return null;
  }
  const raw = (answer as { ok?: unknown; prompt?: unknown } | null);
  if (!raw || raw.ok !== true || !raw.prompt || typeof raw.prompt !== 'object') return null;
  const p = raw.prompt as Record<string, unknown>;
  const id = text(p.id);
  if (!id) return null;
  const choices = choicesOf(p.choices);
  const toolName = text(p.toolName);
  const summary = text(p.summary);
  const question = text(p.question);
  const reason = text(p.reason);
  const promptFingerprint = text(p.promptFingerprint);
  return {
    id,
    ...(toolName ? { toolName } : {}),
    ...(summary ? { summary } : {}),
    ...(question ? { question } : {}),
    ...(reason ? { reason } : {}),
    ...(choices ? { choices } : {}),
    ...(promptFingerprint ? { promptFingerprint } : {}),
    answerable: p.answerable === true && !!choices && !!promptFingerprint,
    answered: p.answered === true,
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
  };
}

/** Press one of the prompt's choices from the desktop: Moa's own (default), or
 *  a delegated agent's (`method` MOA_ANSWER_DELEGATED_PROMPT_RPC, `sessionId`
 *  in `args`, set by main). */
export async function answerMoaApproval(
  client: MoaApprovalClient | null,
  args: unknown,
  method: typeof MOA_ANSWER_PROMPT_RPC | typeof MOA_ANSWER_DELEGATED_PROMPT_RPC = MOA_ANSWER_PROMPT_RPC,
): Promise<MoaApprovalAnswerResult> {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const approvalId = text(a.approvalId);
  const choiceKey = text(a.choiceKey);
  const promptFingerprint = text(a.promptFingerprint);
  if (!approvalId || !choiceKey || !promptFingerprint) return { ok: false, code: 'invalid' };
  if (!client) return { ok: false, code: 'error', reason: 'daemon-unavailable' };
  let answer: unknown;
  try {
    const sessionId = text(a.sessionId);
    if (method === MOA_ANSWER_DELEGATED_PROMPT_RPC && !sessionId) return { ok: false, code: 'invalid' };
    answer = await client.rpc(method, { approvalId, choiceKey, promptFingerprint, ...(method === MOA_ANSWER_DELEGATED_PROMPT_RPC ? { sessionId } : {}) });
  } catch (err) {
    return { ok: false, code: 'error', reason: String(err) };
  }
  const r = (answer ?? {}) as { ok?: unknown; reason?: unknown };
  if (r.ok === true) return { ok: true };
  const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
  if (NOT_PENDING.has(reason)) return { ok: false, code: 'not_pending', reason };
  if (reason === 'answer-too-soon') return { ok: false, code: 'answer_too_soon', reason };
  if (reason === 'invalid' || reason === 'invalid-choice') return { ok: false, code: 'invalid', reason };
  return { ok: false, code: 'error', reason };
}
