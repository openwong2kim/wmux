// OpenCode permissions and questions as `native-rpc` records. The wmux TUI
// plugin (integrations/opencode/plugins/wmux-chat-tui.mjs) lists what its TUI
// draws and answers a request through OpenCode's own server; this module turns
// that list into registry records and a registry answer into a plugin reply.
//
// Records follow what the desktop TUI shows (PR0, OpenCode 1.18.30): the
// route session's own requests and its direct children's, under the pane; the
// request's own session goes in `nativeSessionId`. A record is expired only
// when the plugin says its OWN session no longer holds it — never because the
// route moved, which would hide a request that is still open.

import type {
  OpenCodeDecision,
  OpenCodeDecisionOutcome,
  OpenCodeDecisionReply,
  OpenCodeDecisionsRead,
} from '../transcript/TerminalChatService';
import { boundRecordText } from './terminalPrompt';
import type { ApprovalRequest, DecisionForm, NativeDecisionOutcome, NativeDecisionRef, NativeDecisionReply } from './types';

/** The limit the registry's form bounds put on an option label. */
const LABEL_MAX = 200;

/**
 * The form and card text for one plugin-listed request, or null when it has
 * no answerable form: the plugin cut something to fit, or an option label
 * would not show as it is. Deterministic: the same request builds the same
 * form. A question's option keys are its 1-based positions in OpenCode's list.
 */
export function openCodeDecisionNote(d: OpenCodeDecision): { form: DecisionForm; question: string; toolName?: string; summary?: string } | null {
  if (d.truncated) return null;
  if (d.kind === 'permission') {
    const summary = d.patterns.filter(Boolean).join(', ');
    return {
      // OpenCode's third choice, "always", would widen what the agent may do: never offered.
      form: { v: 1, kind: 'permission', actions: [{ id: 'approve', label: 'Allow once' }, { id: 'deny', label: 'Reject' }] },
      question: `Allow ${d.permission || 'this action'}?`,
      ...(d.permission ? { toolName: d.permission } : {}),
      ...(summary ? { summary } : {}),
    };
  }
  if (d.questions.some((q) => q.options.some((o) => boundRecordText(o.label, LABEL_MAX) !== o.label))) return null;
  const questions = d.questions.map((q, i) => ({
    id: `q${i}`,
    ...(q.header ? { header: q.header } : {}),
    text: q.question,
    multiSelect: q.multiple,
    allowOther: q.custom,
    options: q.options.map((o, j) => ({ key: String(j + 1), label: o.label })),
  }));
  return {
    form: { v: 1, kind: 'questions', questions, actions: [{ id: 'submit', label: 'Submit' }, { id: 'deny', label: 'Dismiss' }] },
    question: questions[0]?.text ?? '',
  };
}

/** The plugin reply for a registry answer, or null when the record cannot name one. */
export function openCodeReply(native: NativeDecisionRef, reply: NativeDecisionReply): OpenCodeDecisionReply | null {
  const sessionId = native.nativeSessionId;
  if (native.adapter !== 'opencode' || !sessionId || !native.digest) return null;
  const base = { requestId: native.requestId, sessionId, digest: native.digest };
  if (reply.formKind === 'permission') return { kind: 'permission', ...base, reply: reply.decision === 'approve' ? 'once' : 'reject' };
  if (reply.formKind !== 'questions') return null;
  if (reply.decision === 'deny') return { kind: 'question', ...base, reject: true };
  if (!reply.answers?.length) return null;
  const answers: Array<{ options: number[]; other?: string }> = [];
  for (const a of reply.answers) {
    const options = a.keys.map((key) => (/^\d{1,2}$/.test(key) ? Number(key) - 1 : -1));
    if (options.some((i) => i < 0)) return null;
    answers.push({ options, ...(a.other !== undefined ? { other: a.other } : {}) });
  }
  return { kind: 'question', ...base, answers };
}

export interface OpenCodeDecisionsDeps {
  read(paneId: string, known: Array<{ requestId: string; sessionId: string }>): Promise<OpenCodeDecisionsRead>;
  reply(paneId: string, reply: OpenCodeDecisionReply): Promise<OpenCodeDecisionOutcome>;
  registry: {
    list(): { pending: ApprovalRequest[] };
    noteNativeDecision(input: {
      sessionId: string; agent: string; workspaceId?: string; native: NativeDecisionRef;
      form: DecisionForm; question?: string; toolName?: string; summary?: string;
    }): Promise<string | null>;
    expireNativeRequests(sessionId: string, adapter: 'opencode', requestIds: readonly string[]): Promise<number>;
    /** Informational cards now stood for by native records (see ApprovalRegistry.expireHookAwaiting). */
    expireHookAwaiting(sessionId: string, requestIds: readonly string[], unkeyed?: boolean): Promise<number>;
  };
  workspaceOf?(paneId: string): string | undefined;
  log?(level: 'info' | 'warn', message: string): void;
}

type ReconcileState = 'native' | 'unsupported' | 'unavailable';
interface Reconciled { state: ReconcileState; recorded: Set<string> }

/**
 * `reconcile(pane)`: `native` when the plugin answered (records made or
 * expired to match), `unsupported` for a plugin that predates decisions,
 * `unavailable` when nothing usable was read. One run per pane at a time; a
 * call during a run queues exactly one more.
 *
 * `covers(pane, requestId?)`: whether a native record now stands for this
 * request (without an id, for every request the plugin listed). Anything else
 * — a request the TUI does not draw, one with no answerable form, a record
 * the registry refused — is `missing`, and the caller keeps the
 * informational card so a blocked pane is never left without one.
 */
export function createOpenCodeDecisions(deps: OpenCodeDecisionsDeps) {
  const running = new Map<string, { promise: Promise<Reconciled>; again: boolean }>();
  const once = async (paneId: string): Promise<Reconciled> => {
    const recorded = new Set<string>();
    const known = deps.registry.list().pending.flatMap((r) =>
      r.sessionId === paneId && r.native?.adapter === 'opencode' && r.native.nativeSessionId
        ? [{ requestId: r.native.requestId, sessionId: r.native.nativeSessionId }]
        : []);
    const read = await deps.read(paneId, known);
    if (read.state !== 'ok') return { state: read.state, recorded };
    if (read.gone.length > 0) await deps.registry.expireNativeRequests(paneId, 'opencode', read.gone);
    const workspaceId = deps.workspaceOf?.(paneId);
    for (const decision of read.decisions) {
      const note = openCodeDecisionNote(decision);
      if (!note) continue;
      const id = await deps.registry.noteNativeDecision({
        sessionId: paneId,
        agent: 'opencode',
        ...(workspaceId ? { workspaceId } : {}),
        native: { adapter: 'opencode', requestId: decision.requestId, nativeSessionId: decision.sessionId, digest: decision.digest },
        ...note,
      });
      if (id) recorded.add(decision.requestId);
    }
    // The informational card for a request a native record now stands for.
    // An id-less card (an older bridge) goes only when every listed request
    // got a record, so it cannot be one for a request that got none.
    if (recorded.size > 0) {
      await deps.registry.expireHookAwaiting(paneId, [...recorded], recorded.size === read.decisions.length);
    }
    return { state: 'native', recorded };
  };
  const reconcile = (paneId: string): Promise<Reconciled> => {
    const current = running.get(paneId);
    if (current) {
      current.again = true;
      return current.promise;
    }
    const entry = { promise: Promise.resolve<Reconciled>({ state: 'unavailable', recorded: new Set() }), again: false };
    entry.promise = (async () => {
      try {
        let result = await once(paneId);
        while (entry.again) {
          entry.again = false;
          result = await once(paneId);
        }
        return result;
      } catch (err) {
        deps.log?.('warn', `[approvals] OpenCode decisions reconcile failed for ${paneId}: ${String(err)}`);
        return { state: 'unavailable' as const, recorded: new Set<string>() };
      } finally {
        running.delete(paneId);
      }
    })();
    running.set(paneId, entry);
    return entry.promise;
  };
  const covers = async (paneId: string, requestId?: string): Promise<ReconcileState | 'missing'> => {
    const result = await reconcile(paneId);
    if (result.state !== 'native') return result.state;
    return (requestId ? result.recorded.has(requestId) : result.recorded.size > 0) ? 'native' : 'missing';
  };
  const answer = async (native: NativeDecisionRef, reply: NativeDecisionReply, paneId: string): Promise<NativeDecisionOutcome> => {
    const request = openCodeReply(native, reply);
    return request ? deps.reply(paneId, request) : 'unavailable';
  };
  return { reconcile: async (paneId: string) => (await reconcile(paneId)).state, covers, answer };
}
