import type { Dialog, FileChooser, Page } from 'playwright-core';
import { taggedFailure } from './resultTrailer';

// ---------------------------------------------------------------------------
// Pending-modal state for agent-owned pages.
//
// Without a 'dialog' listener Playwright answers every dialog itself the
// moment it opens (dismiss; accept for beforeunload), so an alert() the agent
// caused vanished without a trace and a confirm() silently answered "no". With
// a listener the dialog stays open and the page's JS stays blocked until
// someone answers it — which is why this module also owns the guarantees that
// keep that from hanging an agent:
//   - an in-flight action is raced against "a modal opened" (raceModal), so a
//     click whose dispatch cannot return until the alert closes returns now;
//   - a write while a modal is pending is refused with the exact call that
//     answers it (assertNoPendingModal), instead of queueing behind it;
//   - every tool result on that surface carries a [modal] block until it is
//     answered (renderModalBlock, prepended by the automation lease).
//
// Attached ONLY to pages the agent owns: a tab the user lent, or the user's own
// tab, keeps Playwright's previous default so their dialogs and uploads are
// never intercepted. beforeunload keeps that default everywhere (accept).
// ---------------------------------------------------------------------------

export type ModalType = 'alert' | 'confirm' | 'prompt' | 'filechooser';

export interface PendingModal {
  readonly type: ModalType;
  /** Page-controlled text, capped. Empty for a file chooser. */
  readonly message: string;
  readonly defaultValue?: string;
  readonly isMultiple?: boolean;
  readonly since: number;
  /** The scope key (modalScopeKey) of the surface the modal opened on. */
  readonly surface: string;
  /**
   * Whether an agent tool call on this surface was in flight (or had just
   * ended) when the modal opened. Only such a modal may be answered by the
   * agent; anything else is the person's to answer.
   */
  readonly causedByAgent: boolean;
}

interface ModalRecord {
  pending?: PendingModal & { dialog?: Dialog; chooser?: FileChooser };
  /** browser_dialog's pre-arm: the answer for the next dialog, until expiry. */
  armed?: { accept: boolean; text?: string; expires: number };
  fileChooser: boolean;
  /** Every scope key this page was resolved under, most recent last. */
  scopeKeys: Set<string>;
  waiters: Set<(modal: PendingModal) => void>;
}

/** How long a pre-armed answer waits for its dialog before it lapses. */
export const ARMED_DIALOG_TTL_MS = 30_000;
/** How long a stale-dialog probe may stall before the dialog counts as open. */
const STALE_PROBE_MS = 200;
const MAX_MESSAGE_CHARS = 500;

const records = new WeakMap<Page, ModalRecord>();
// Scope key -> page, so the lease (which holds a scope, not a Page) can render
// the block without resolving the page a second time. Strong refs (the MCP
// bundle targets ES2020, so no WeakRef), dropped when the page closes.
const pagesByScope = new Map<string, Page>();

function forgetPage(page: Page): void {
  for (const [key, p] of pagesByScope) if (p === page) pagesByScope.delete(key);
}
// Agent tool calls in flight per scope key, and when the last one ended.
const agentActivity = new Map<string, { active: number; lastEnd: number }>();
/** A modal opening this soon after an agent call ended still counts as its doing. */
export const CAUSE_GRACE_MS = 1_000;

/**
 * Mark an agent tool call on a surface (the automation lease brackets every
 * call with this). Returns the closer; call it exactly once.
 */
export function beginAgentWindow(workspaceId?: string, surfaceId?: string): () => void {
  const key = modalScopeKey(workspaceId, surfaceId);
  const entry = agentActivity.get(key) ?? { active: 0, lastEnd: 0 };
  entry.active++;
  agentActivity.set(key, entry);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    entry.active = Math.max(0, entry.active - 1);
    entry.lastEnd = Date.now();
  };
}

function agentCaused(record: ModalRecord): boolean {
  const now = Date.now();
  for (const key of record.scopeKeys) {
    const a = agentActivity.get(key);
    if (a && (a.active > 0 || now - a.lastEnd <= CAUSE_GRACE_MS)) return true;
  }
  return false;
}

function latestScope(record: ModalRecord): string {
  let last = '';
  for (const key of record.scopeKeys) last = key;
  return last;
}

/** Same key shape as the engine's lifecycle mirror. */
export function modalScopeKey(workspaceId?: string, surfaceId?: string): string {
  return `ws:${workspaceId ?? ''}:surf:${surfaceId ?? ''}`;
}

function capText(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function publicView(p: ModalRecord['pending']): PendingModal | undefined {
  if (!p) return undefined;
  const { dialog: _d, chooser: _c, ...rest } = p;
  return rest;
}

function setPending(record: ModalRecord, pending: NonNullable<ModalRecord['pending']>): void {
  record.pending = pending;
  const view = publicView(pending) as PendingModal;
  for (const w of [...record.waiters]) w(view);
}

/**
 * Start tracking modals on an agent-owned page. Idempotent per Page; a second
 * call may only ADD file-chooser interception (never remove it), so a page
 * first seen through a lookup that could not prove ownership can still be
 * upgraded later.
 */
export function attachModalTracking(
  page: Page,
  opts: { scopeKey: string; fileChooser: boolean },
): void {
  pagesByScope.set(opts.scopeKey, page);
  let record = records.get(page);
  if (!record) {
    const created: ModalRecord = { fileChooser: false, scopeKeys: new Set(), waiters: new Set() };
    record = created;
    records.set(page, created);
    page.on('dialog', (dialog: Dialog) => onDialog(created, dialog));
    // A navigation or a close ends whatever was pending: Chromium closes an
    // open dialog on both, and a file chooser belongs to the document it was
    // opened from. Also the cheap half of stale-state clearing.
    page.on('framenavigated', (frame) => {
      try {
        if (frame === page.mainFrame()) created.pending = undefined;
      } catch {
        /* page torn down mid-event */
      }
    });
    page.on('close', () => {
      created.pending = undefined;
      created.armed = undefined;
      forgetPage(page);
    });
  }
  record.scopeKeys.delete(opts.scopeKey);
  record.scopeKeys.add(opts.scopeKey);
  if (opts.fileChooser && !record.fileChooser) {
    const target = record;
    target.fileChooser = true;
    page.on('filechooser', (chooser: FileChooser) => {
      setPending(target, {
        type: 'filechooser',
        message: '',
        isMultiple: safeCall(() => chooser.isMultiple(), false),
        since: Date.now(),
        surface: latestScope(target),
        causedByAgent: agentCaused(target),
        chooser,
      });
    });
  }
}

/**
 * The pre-arm on a page this module does not track (a tab the user or a lent
 * tab's owner keeps): one Playwright listener for the next dialog, gone after
 * the expiry so Playwright's own default handling resumes. A dialog arriving
 * after the expiry still gets that default from this listener.
 */
function armUntracked(page: Page, accept: boolean, text?: string): void {
  const expires = Date.now() + ARMED_DIALOG_TTL_MS;
  const handler = (dialog: Dialog) => {
    clearTimeout(timer);
    const live = Date.now() < expires;
    const answerYes = live ? accept : safeCall(() => dialog.type(), '') === 'beforeunload';
    void (answerYes ? dialog.accept(live ? text : undefined) : dialog.dismiss()).catch(() => {});
  };
  page.once('dialog', handler);
  const timer = setTimeout(() => {
    try {
      page.off('dialog', handler);
    } catch {
      /* page already closed */
    }
  }, ARMED_DIALOG_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function onDialog(record: ModalRecord, dialog: Dialog): void {
  const armed = record.armed;
  if (armed) {
    record.armed = undefined;
    if (armed.expires > Date.now()) {
      void (armed.accept ? dialog.accept(armed.text) : dialog.dismiss()).catch(() => {});
      return;
    }
  }
  const type = safeCall(() => dialog.type(), 'alert');
  // Playwright's old default, kept: leaving a page is never held up.
  if (type === 'beforeunload') {
    void dialog.accept().catch(() => {});
    return;
  }
  const modalType: ModalType = type === 'confirm' || type === 'prompt' ? type : 'alert';
  setPending(record, {
    type: modalType,
    message: capText(safeCall(() => dialog.message(), '')),
    ...(modalType === 'prompt' && { defaultValue: capText(safeCall(() => dialog.defaultValue(), '')) }),
    since: Date.now(),
    surface: latestScope(record),
    causedByAgent: agentCaused(record),
    dialog,
  });
}

/** Point a scope at a tracked page (read lookups too), so the lease finds it. */
export function rememberModalScope(page: Page, scopeKey: string): void {
  const record = records.get(page);
  if (!record) return;
  pagesByScope.set(scopeKey, page);
  record.scopeKeys.delete(scopeKey);
  record.scopeKeys.add(scopeKey);
}

export function pendingModal(page: Page | null | undefined): PendingModal | undefined {
  if (!page) return undefined;
  return publicView(records.get(page)?.pending);
}

export function pendingModalForScope(workspaceId?: string, surfaceId?: string): PendingModal | undefined {
  const page = pagesByScope.get(modalScopeKey(workspaceId, surfaceId));
  if (!page) return undefined;
  return pendingModal(page);
}

export type RaceOutcome<T> =
  | { readonly interrupted: false; readonly value: T }
  | { readonly interrupted: true; readonly modal: PendingModal };

/**
 * Settle `work` or the first modal on `page`, whichever comes first. The
 * losing promise keeps running; its rejection is swallowed, since the action
 * it belongs to has already been reported.
 */
export async function raceModal<T>(page: Page, work: Promise<T>): Promise<RaceOutcome<T>> {
  const record = records.get(page);
  if (!record) return { interrupted: false, value: await work };
  if (record.pending) {
    work.catch(() => {});
    return { interrupted: true, modal: publicView(record.pending) as PendingModal };
  }
  let waiter: ((m: PendingModal) => void) | undefined;
  const opened = new Promise<RaceOutcome<T>>((resolve) => {
    waiter = (modal) => resolve({ interrupted: true, modal });
    record.waiters.add(waiter);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ interrupted: false as const, value })),
      opened,
    ]);
  } finally {
    if (waiter) record.waiters.delete(waiter);
    work.catch(() => {});
  }
}

/** Resolve after `ms`, or as soon as a modal opens on `page`. */
export function delayUnlessModal(page: Page, ms: number): Promise<void> {
  return raceModal(page, new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  })).then(() => undefined);
}

/**
 * A dialog the user answered in the browser window leaves no client-side
 * event, so a pending dialog is confirmed before it is allowed to refuse
 * anything: an open dialog stalls an evaluation, a closed one does not.
 */
async function dialogStillOpen(page: Page): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = page.evaluate('1').then(() => false, () => true);
    const stalled = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(true), STALE_PROBE_MS);
    });
    return await Promise.race([probe, stalled]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function answerHint(modal: PendingModal): string {
  if (!modal.causedByAgent) {
    return 'It did not open from an agent action, so it is left for the person at the browser to answer.';
  }
  if (modal.type === 'filechooser') {
    return 'Answer with browser_file_upload({paths}) to choose files, or browser_dialog({accept:false}) to cancel.';
  }
  if (modal.type === 'prompt') {
    return 'Answer with browser_dialog({accept:true, text}) or browser_dialog({accept:false}).';
  }
  if (modal.type === 'confirm') {
    return 'Answer with browser_dialog({accept:true}) or browser_dialog({accept:false}).';
  }
  return 'Close it with browser_dialog({accept:true}).';
}

function describeModal(modal: PendingModal): string {
  if (modal.type === 'filechooser') {
    return `file chooser (${modal.isMultiple ? 'multiple files' : 'one file'})`;
  }
  const value = modal.type === 'prompt' && modal.defaultValue ? ` (default: ${JSON.stringify(modal.defaultValue)})` : '';
  return `${modal.type}: ${JSON.stringify(modal.message)}${value}`;
}

/** The block the lease prepends to every result while a modal is pending. */
export function renderModalBlock(modal: PendingModal): string {
  return `[modal]\n- ${describeModal(modal)}\n- ${answerHint(modal)} Other page actions are refused until then.\n`;
}

/**
 * Refuse a write while a modal is pending on `page`. A dialog the user already
 * closed by hand is cleared here instead of refusing.
 */
export async function assertNoPendingModal(page: Page): Promise<void> {
  const record = records.get(page);
  const pending = record?.pending;
  if (!record || !pending) return;
  if (pending.dialog && !(await dialogStillOpen(page))) {
    if (record.pending === pending) record.pending = undefined;
    return;
  }
  const view = publicView(pending) as PendingModal;
  throw taggedFailure(
    'dialog_blocked',
    `A ${describeModal(view)} is open on this page. ${answerHint(view)}`,
    'none',
  );
}

export type DialogAnswer =
  | { readonly kind: 'answered'; readonly modal: PendingModal }
  | { readonly kind: 'already_closed'; readonly modal: PendingModal }
  | { readonly kind: 'armed' };

/**
 * browser_dialog. Answers the pending dialog when there is one. Otherwise
 * arms the answer for the next dialog — the old behaviour — with an expiry, so
 * an answer nobody needed cannot surprise a later, unrelated dialog. A pending
 * file chooser is cancelled by accept:false (dropping an intercepted chooser
 * leaves the page as if it had been dismissed).
 */
export async function answerModal(page: Page, accept: boolean, text?: string): Promise<DialogAnswer> {
  const record = records.get(page);
  if (!record) {
    armUntracked(page, accept, text);
    return { kind: 'armed' };
  }
  const pending = record.pending;
  if (!pending) {
    record.armed = { accept, ...(text !== undefined && { text }), expires: Date.now() + ARMED_DIALOG_TTL_MS };
    return { kind: 'armed' };
  }
  const view = publicView(pending) as PendingModal;
  if (!pending.causedByAgent) {
    throw taggedFailure(
      'dialog_blocked',
      `A ${describeModal(view)} is open on this page, but it did not open from an agent action. Leave it for the person at the browser; it is not answered for them.`,
      'none',
    );
  }
  if (pending.chooser) {
    if (accept) {
      throw taggedFailure(
        'invalid_params',
        'A file chooser is open: pick files with browser_file_upload({paths}), or cancel it with browser_dialog({accept:false}).',
        'none',
      );
    }
    record.pending = undefined;
    return { kind: 'answered', modal: view };
  }
  record.pending = undefined;
  try {
    if (accept) await pending.dialog?.accept(text);
    else await pending.dialog?.dismiss();
    return { kind: 'answered', modal: view };
  } catch {
    // Already handled, or the page closed it (navigation, a person in the
    // window). Either way nothing is pending any more.
    return { kind: 'already_closed', modal: view };
  }
}

/** Hand a pending file chooser to browser_file_upload, clearing it. */
export function takeFileChooser(page: Page): FileChooser | undefined {
  const record = records.get(page);
  const chooser = record?.pending?.chooser;
  if (!record || !chooser) return undefined;
  if (!record.pending?.causedByAgent) {
    throw taggedFailure(
      'dialog_blocked',
      'A file chooser is open on this page, but it did not open from an agent action. Leave it for the person at the browser.',
      'none',
    );
  }
  record.pending = undefined;
  return chooser;
}
