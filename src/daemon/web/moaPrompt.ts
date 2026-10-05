// ─── Moa's own permission prompt as an approval record (#1772) ──────────────
//
// The HQ brain's hooks go to main, never to the daemon, so HookIngest raises no
// approval record for a brain pane (and keeps refusing to). For the ONE brain
// pane a phone may reach — the Moa pane, while Moa is on and its HQ present —
// main's push (`daemon.moa.set`, see moaPane.ts) carries the dialog and the
// PermissionRequest hook's evidence instead, and this module turns it into the
// same `terminal_prompt` record any other pane gets, with the same fences
// (bound to one tool call, reflex delay, re-proved on screen, one key, CAS).
//
// Lifecycle, all on the registry's own paths:
//   - a new dialog (none → A, or A → B) notes a record; A → B first expires A
//     and notes B only once that expiry is through and B is still current.
//     Creations run one at a time, and one that finds the dialog closed
//     while it read the screen checks its own card;
//   - Moa off, the pane unresolved, or another session expires the old
//     session's record (`pane-gone`), queued synchronously so an in-flight
//     creation (which awaits a screen read) is dropped by the sweep;
//   - main saying the dialog is gone is NOT enough to expire: a subagent's
//     PostToolUse can clear main's flag while the dialog is still up. The
//     screen decides (`screen-cleared`), checked a few times;
//   - a press (phone or desktop) and a press refused as `prompt-changed` look
//     at the screen too, so an answered or Esc-declined dialog does not leave
//     its card behind when no hook follows.
//
// `daemon.moa.answerPrompt` (the desktop's Moa chat, through main's renderer
// IPC only) answers through `answer` below.

import { ENV_KEYS } from '../../shared/constants';
import { boundRecordText, TERMINAL_PROMPT_TOOL_NAME_MAX } from '../approvals/terminalPrompt';
import { decisionForChoiceLabel } from '../approvals/terminalPromptParse';
import {
  isNativeDecision,
  TERMINAL_PROMPT_WEB_ANSWER,
  type ApprovalEvent,
  type ApprovalExpiryReason,
  type ApprovalRequest,
  type ApprovalResolveParams,
  type ApprovalResolveResult,
  type TerminalPromptNote,
} from '../approvals/types';
import type { MoaPaneFact } from './moaPane';

/** The registry calls this module makes. */
export interface MoaPromptRegistry {
  noteTerminalPrompt(note: TerminalPromptNote): Promise<void>;
  expireForSession(sessionId: string, reason: ApprovalExpiryReason, kind?: ApprovalRequest['kind']): Promise<void>;
  dialogGoneFromScreen(sessionId: string): Promise<boolean>;
  list(): { pending: ApprovalRequest[] };
  resolve(params: ApprovalResolveParams): Promise<ApprovalResolveResult>;
}

/** The slice of a daemon session read here. */
interface PaneLike {
  meta: { env?: Record<string, string> };
}

export interface MoaPromptDeps {
  registry: () => MoaPromptRegistry | null;
  /** The fact main last pushed (moaPane.ts). */
  current: () => MoaPaneFact | null;
  /** Does this fact still resolve to its live brain pane (resolveMoaPane)? */
  resolves: (fact: MoaPaneFact) => boolean;
  /** Injected in tests: the wait between screen checks. */
  delay?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/** Screen checks after main says the dialog closed. */
export const MOA_PROMPT_GONE_CHECKS = 3;
/** Screen checks after a press: the key's effect can take a moment to draw. */
export const MOA_PROMPT_PRESS_CHECKS = 5;
/** Consecutive reads with no dialog on them before the card is expired. */
export const MOA_PROMPT_GONE_STREAK = 2;
export const MOA_PROMPT_CHECK_GAP_MS = 1_000;

/** What the desktop's Moa chat shows for the pending record. */
export interface MoaPromptView {
  id: string;
  toolName?: string;
  summary?: string;
  question?: string;
  reason?: string;
  choices?: Array<{ key: string; label: string }>;
  /** Echoed back by an answer; the record's own. */
  promptFingerprint?: string;
  /** Whole parse, bound, not answered yet: the choices may be pressed. */
  answerable: boolean;
  /** The one remote answer was written; the record settles when the dialog closes. */
  answered: boolean;
  createdAt: number;
}

export type MoaAnswerResult =
  | { ok: true; state: ApprovalRequest['state'] }
  | { ok: false; reason: string };

export class MoaPromptSync {
  /** The pane and dialog the last push was acted on for. */
  private acted: { sessionId: string; fingerprint?: string } | null = null;
  /** The dialog the last card was noted for. */
  private noted: { sessionId: string; fingerprint: string } | null = null;
  /** Screen-check loops running, keyed by record and the dialog they began under. */
  private readonly checking = new Set<string>();
  /**
   * Card creations, one at a time. The registry ignores a note while it is
   * still reading the screen for the previous one, so a dialog B pushed during
   * A's read would otherwise never get its card.
   */
  private creating: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MoaPromptDeps) {}

  /** The Moa pane's session while the fact resolves to its live pane, else null. */
  moaSessionId(): string | null {
    const fact = this.deps.current();
    return fact && this.deps.resolves(fact) ? fact.sessionId : null;
  }

  /**
   * A push changed the fact (MoaPaneRpc.onChanged, a publisher's disconnect
   * included). `pane` is the live pane `next` resolves to, if any. Every
   * expiry is queued before this returns.
   */
  onChanged(next: MoaPaneFact | null, pane: PaneLike | undefined): void {
    const registry = this.deps.registry();
    const acted = this.acted;
    const target = next && pane ? { sessionId: next.sessionId, ...(next.dialog ? { fingerprint: next.dialog.fingerprint } : {}) } : null;
    this.acted = target;
    if (!registry) return;
    // Moa off, the HQ changed, or the pane no longer resolves: no card may
    // stand on the pane that is no longer the Moa pane.
    if (acted && acted.sessionId !== target?.sessionId) this.expire(registry, acted.sessionId, 'pane-gone');
    if (next && !pane && next.sessionId !== acted?.sessionId) this.expire(registry, next.sessionId, 'pane-gone');
    if (!target || !next || !pane) return;
    const before = acted?.sessionId === target.sessionId ? acted.fingerprint : undefined;
    if (before === target.fingerprint) return;
    const dialog = next.dialog;
    if (!dialog) {
      void this.confirmGone(target.sessionId, MOA_PROMPT_GONE_CHECKS);
      return;
    }
    const workspaceId = pane.meta.env?.[ENV_KEYS.WORKSPACE_ID];
    const toolName = boundRecordText(dialog.toolName, TERMINAL_PROMPT_TOOL_NAME_MAX);
    const note: TerminalPromptNote = {
      sessionId: target.sessionId,
      agent: 'claude',
      ...(workspaceId ? { workspaceId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(dialog.toolInput ? { toolInput: dialog.toolInput } : {}),
      ...(dialog.toolUseId ? { toolUseId: dialog.toolUseId } : {}),
      ...(dialog.hookSessionId ? { hookSessionId: dialog.hookSessionId } : {}),
      ...(dialog.promptId ? { promptId: dialog.promptId } : {}),
      source: 'hook',
    };
    // A card still standing for another dialog — A → B, or A kept by the
    // screen check when main's flag cleared early and then answered in the
    // terminal with no push since — goes first: the registry creates nothing
    // while a record is pending on the pane. The expiry is only queued until
    // the chain runs it, so B is noted once it is through.
    const standing = pendingPrompt(registry, target.sessionId);
    if (standing && this.noted?.sessionId === target.sessionId && this.noted.fingerprint === dialog.fingerprint) return;
    const ready = before !== undefined || standing ? this.expire(registry, target.sessionId, 'prompt-gone') : Promise.resolve();
    this.creating = this.creating
      .then(() => this.raise(registry, target.sessionId, dialog.fingerprint, note, ready))
      .catch((err: unknown) => {
        this.deps.log?.('warn', `[moa] could not raise the Moa prompt on ${target.sessionId}: ${String(err)}`);
      });
  }

  /**
   * One creation step, run after the ones queued before it. Everything is
   * re-read here, at run time: the push that queued it is old by now.
   */
  private async raise(
    registry: MoaPromptRegistry,
    sessionId: string,
    fingerprint: string,
    note: TerminalPromptNote,
    ready: Promise<void>,
  ): Promise<void> {
    await ready;
    // Moa off, another pane or another dialog since this push: not this
    // card's to raise any more.
    const stillCurrent = (): boolean => {
      const fact = this.deps.current();
      return !!fact && fact.sessionId === sessionId && fact.dialog?.fingerprint === fingerprint && this.deps.resolves(fact);
    };
    if (!stillCurrent()) return;
    // A card an earlier step finished after this push looked: this dialog's
    // own stays; another dialog's goes first.
    if (pendingPrompt(registry, sessionId)) {
      if (this.noted?.sessionId === sessionId && this.noted.fingerprint === fingerprint) return;
      await this.expire(registry, sessionId, 'prompt-gone');
      if (!stillCurrent()) return;
    }
    this.noted = { sessionId, fingerprint };
    await registry.noteTerminalPrompt(note);
    // The dialog closed while the screen was read: the push that said so found
    // no card to check yet, so the card just made is checked now.
    const fact = this.deps.current();
    if (fact && fact.sessionId === sessionId && !fact.dialog && this.deps.resolves(fact)) {
      void this.confirmGone(sessionId, MOA_PROMPT_GONE_CHECKS);
    }
  }

  /** A registry event: a press on the Moa pane's record looks at the screen. */
  onApprovalEvent(event: ApprovalEvent): void {
    if (event.type !== 'press' || event.request.kind !== 'terminal_prompt') return;
    const sessionId = this.moaSessionId();
    if (sessionId === null || event.request.sessionId !== sessionId) return;
    void this.confirmGone(sessionId, MOA_PROMPT_PRESS_CHECKS);
  }

  /**
   * An answer to the Moa pane's record was refused as `prompt-changed` (the
   * phone's route or the desktop's): one look at the screen, so a dialog
   * declined in the terminal (Esc sends no hook) does not keep its card.
   */
  noteRefusedPress(sessionId: string): void {
    if (sessionId !== this.moaSessionId()) return;
    void this.confirmGone(sessionId, MOA_PROMPT_GONE_STREAK);
  }

  /** The Moa pane's pending `terminal_prompt`, for the desktop's Moa chat. */
  view(): MoaPromptView | null {
    const registry = this.deps.registry();
    const sessionId = this.moaSessionId();
    if (!registry || sessionId === null) return null;
    const record = pendingPrompt(registry, sessionId);
    if (!record) return null;
    return {
      id: record.id,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
      ...(record.question ? { question: record.question } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.choices?.length ? { choices: record.choices.map((c) => ({ key: c.key, label: c.label })) } : {}),
      ...(record.promptFingerprint ? { promptFingerprint: record.promptFingerprint } : {}),
      answerable: !!record.promptFingerprint && !!record.choices?.length && record.pressedAt === undefined,
      answered: record.pressedAt !== undefined,
      createdAt: record.createdAt,
    };
  }

  /**
   * `daemon.moa.answerPrompt` — the desktop's answer, a person at this
   * machine. Only the Moa pane's pending `terminal_prompt`; the decision comes
   * from the option's own label, `resolvedBy` is fixed here, and every fence a
   * phone answer meets applies (reflex delay, re-proof, one key, CAS). The
   * Moa pane is re-checked from inside the registry right before the key.
   */
  async answer(params: unknown): Promise<MoaAnswerResult> {
    const sessionId = this.moaSessionId();
    if (sessionId === null) return { ok: false, reason: 'not-pending' };
    return this.press(params, sessionId, () => this.moaSessionId() === sessionId);
  }

  /**
   * `daemon.moa.answerDelegatedPrompt` — the desktop's answer to the prompt
   * of an agent Moa delegated work to, from Moa's "Waiting on you". Main
   * decides which panes are delegated (only it knows the hand-offs) and names
   * the pane; here the record must be that pane's pending `terminal_prompt`,
   * never the Moa pane's own (that one has `answer`). Every fence of a phone
   * answer applies, the same as `answer`.
   */
  async answerDelegated(params: unknown): Promise<MoaAnswerResult> {
    const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    const sessionId = typeof p.sessionId === 'string' && p.sessionId.length > 0 && p.sessionId.length <= 128 ? p.sessionId : null;
    if (!sessionId) return { ok: false, reason: 'invalid' };
    if (sessionId === this.moaSessionId()) return { ok: false, reason: 'not-pending' };
    return this.press(params, sessionId, () => sessionId !== this.moaSessionId());
  }

  /** Press one choice of `sessionId`'s pending `terminal_prompt` as a person
   *  at this machine; `stillOk` is re-checked inside the registry before the key. */
  private async press(params: unknown, sessionId: string, stillOk: () => boolean): Promise<MoaAnswerResult> {
    const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    const id = typeof p.approvalId === 'string' && p.approvalId.length > 0 && p.approvalId.length <= 128 ? p.approvalId : null;
    const choiceKey = typeof p.choiceKey === 'string' && /^\d{1,2}$/.test(p.choiceKey) ? p.choiceKey : null;
    const promptFingerprint = typeof p.promptFingerprint === 'string' && /^[0-9a-f]{32}$/.test(p.promptFingerprint)
      ? p.promptFingerprint : null;
    if (!id || !choiceKey || !promptFingerprint) return { ok: false, reason: 'invalid' };
    const registry = this.deps.registry();
    if (!registry) return { ok: false, reason: 'not-pending' };
    const record = registry.list().pending.find((r) => r.id === id);
    if (!record || record.kind !== 'terminal_prompt' || isNativeDecision(record) || record.sessionId !== sessionId) {
      return { ok: false, reason: 'not-pending' };
    }
    const choice = record.choices?.find((c) => c.key === choiceKey);
    const decision = choice ? decisionForChoiceLabel(choice.label) : null;
    if (!decision) return { ok: false, reason: 'invalid-choice' };
    const result = await registry.resolve({
      id,
      decision,
      choiceKey,
      promptFingerprint,
      resolvedBy: 'desktop',
      resolver: 'human',
      terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
      // The pane stopped being this answer's to press while it waited
      // (Moa switched off, the HQ changed, it became the Moa pane): no key.
      authorize: async (r) => (r.sessionId === sessionId && stillOk() ? 'ok' : 'expired'),
    });
    if (result.ok) return { ok: true, state: result.request.state };
    if (result.reason === 'prompt-changed') this.noteRefusedPress(sessionId);
    return { ok: false, reason: result.reason };
  }

  private expire(registry: MoaPromptRegistry, sessionId: string, reason: ApprovalExpiryReason): Promise<void> {
    return registry.expireForSession(sessionId, reason, 'terminal_prompt').catch((err: unknown) => {
      this.deps.log?.('warn', `[moa] could not expire the Moa prompt on ${sessionId}: ${String(err)}`);
    });
  }

  /**
   * Expire the pane's record once MOA_PROMPT_GONE_STREAK reads in a row show
   * no dialog on the screen. Gives up when the record or the dialog main
   * reports changes in between (that is a newer push's to handle), or after
   * `attempts` reads without that streak.
   */
  private async confirmGone(sessionId: string, attempts: number): Promise<void> {
    const registry = this.deps.registry();
    if (!registry) return;
    const record = pendingPrompt(registry, sessionId);
    if (!record) return;
    const dialogNow = (): string | undefined => (this.acted?.sessionId === sessionId ? this.acted.fingerprint : undefined);
    const dialog = dialogNow();
    const key = `${record.id}|${dialog ?? ''}`;
    if (this.checking.has(key)) return;
    this.checking.add(key);
    const delay = this.deps.delay
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    const unchanged = (): boolean => pendingPrompt(registry, sessionId)?.id === record.id && dialogNow() === dialog;
    try {
      let streak = 0;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await delay(MOA_PROMPT_CHECK_GAP_MS);
        if (!unchanged()) return;
        const gone = await registry.dialogGoneFromScreen(sessionId);
        if (!unchanged()) return;
        streak = gone ? streak + 1 : 0;
        if (streak >= MOA_PROMPT_GONE_STREAK) {
          await this.expire(registry, sessionId, 'screen-cleared');
          return;
        }
      }
    } catch (err) {
      this.deps.log?.('warn', `[moa] the Moa prompt screen check failed on ${sessionId}: ${String(err)}`);
    } finally {
      this.checking.delete(key);
    }
  }
}

function pendingPrompt(registry: MoaPromptRegistry, sessionId: string): ApprovalRequest | undefined {
  return registry.list().pending.find((r) => r.sessionId === sessionId && r.kind === 'terminal_prompt' && !isNativeDecision(r));
}
