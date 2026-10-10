import type { Dialog, Page } from 'playwright-core';
import { taggedFailure } from './resultTrailer';
import { sendRpc } from '../wmux-client';

// ---------------------------------------------------------------------------
// Dialog notes for pages the agent writes to.
//
// Without a 'dialog' listener Playwright answers every dialog itself the
// moment it opens (dismiss; accept for beforeunload), and the agent never
// learns a confirm() was answered "no" for it. This module keeps exactly that
// behaviour — nothing is held open, nothing blocks, nothing is refused — and
// only RECORDS what happened, so the next tool result on that surface can say
// so in a [modal] note.
//
// The one exception is browser_dialog's pre-arm: an answer the agent gave in
// advance, used for the next dialog that opens while one of its own input
// dispatches is in flight on an agent-owned page, within ARMED_DIALOG_TTL_MS.
// beforeunload never consumes it and is always accepted, as before.
// ---------------------------------------------------------------------------

export type DialogOwner = 'agent' | 'borrowed' | 'user' | 'unknown';

export interface DialogNote {
  readonly type: string;
  /** Page-controlled text, capped. */
  readonly message: string;
  readonly at: number;
  readonly answer: 'dismissed' | 'accepted (pre-armed)' | 'dismissed (pre-armed)';
}

interface PageRecord {
  notes: DialogNote[];
  /** Input dispatches in flight on this page (beginDispatch). */
  dispatching: number;
  armed?: { accept: boolean; text?: string; expires: number };
}

/** How long a pre-armed answer waits for its dialog before it lapses. */
export const ARMED_DIALOG_TTL_MS = 30_000;
const MAX_MESSAGE_CHARS = 200;
const MAX_NOTES = 5;

const records = new WeakMap<Page, PageRecord>();
// Scope key -> page, so the lease (which holds a scope, not a Page) can drain
// notes. Strong refs (the MCP bundle targets ES2020, so no WeakRef), dropped
// when the page or its context closes.
const pagesByScope = new Map<string, Page>();
// One 'close' listener per context, however many of its pages are tracked.
const hookedContexts = new WeakSet<object>();

/** Same key shape as the engine's lifecycle mirror. */
export function modalScopeKey(workspaceId?: string, surfaceId?: string): string {
  return `ws:${workspaceId ?? ''}:surf:${surfaceId ?? ''}`;
}

function forgetPage(page: Page): void {
  for (const [key, p] of pagesByScope) if (p === page) pagesByScope.delete(key);
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function ignore(): void {
  /* the dialog was already handled, or the page is gone */
}

/**
 * Start recording dialogs on a page an agent writes to. Idempotent per Page.
 * Behaviour-neutral: every dialog is still answered at once, the way
 * Playwright answers it when nobody listens.
 */
export function attachModalTracking(page: Page, scopeKey: string): void {
  if (!records.has(page)) {
    const created: PageRecord = { notes: [], dispatching: 0 };
    records.set(page, created);
    page.on('dialog', (dialog: Dialog) => onDialog(created, dialog));
    page.on('close', () => {
      created.armed = undefined;
      forgetPage(page);
    });
    // A CDP disconnect closes the context without a page 'close'.
    const context = safeCall(() => page.context(), undefined);
    if (context && typeof context.on === 'function' && !hookedContexts.has(context)) {
      hookedContexts.add(context);
      context.on('close', () => {
        for (const [key, p] of pagesByScope) {
          if (safeCall(() => p.context() === context, true)) pagesByScope.delete(key);
        }
      });
    }
  }
  pagesByScope.set(scopeKey, page);
}

/** Point a scope at an already tracked page (read lookups), so the lease finds it. */
export function rememberModalScope(page: Page, scopeKey: string): void {
  if (records.has(page)) pagesByScope.set(scopeKey, page);
}

function onDialog(record: PageRecord, dialog: Dialog): void {
  const type = safeCall(() => dialog.type(), 'alert');
  // Playwright's default, kept, and never spends an armed answer: leaving a
  // page is not something the agent was asked about.
  if (type === 'beforeunload') {
    void dialog.accept().catch(ignore);
    return;
  }
  const armed = record.armed && record.armed.expires > Date.now() && record.dispatching > 0
    ? record.armed
    : undefined;
  if (armed) record.armed = undefined;
  void (armed?.accept ? dialog.accept(armed.text) : dialog.dismiss()).catch(ignore);

  const message = safeCall(() => dialog.message(), '');
  record.notes.push({
    type,
    message: message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message,
    at: Date.now(),
    answer: armed ? (armed.accept ? 'accepted (pre-armed)' : 'dismissed (pre-armed)') : 'dismissed',
  });
  if (record.notes.length > MAX_NOTES) record.notes.splice(0, record.notes.length - MAX_NOTES);
}

/**
 * Mark a real input dispatch on `page` (click, typing, a key, a select). Only
 * a dialog raised while one is in flight may use a pre-armed answer. Returns
 * the closer; call it exactly once.
 */
export function beginDispatch(page: Page): () => void {
  const record = records.get(page);
  if (!record) return ignore;
  record.dispatching++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    record.dispatching = Math.max(0, record.dispatching - 1);
  };
}

/** Take (and clear) the notes recorded for the page a scope last resolved to. */
export function drainDialogNotes(workspaceId?: string, surfaceId?: string): DialogNote[] {
  const page = pagesByScope.get(modalScopeKey(workspaceId, surfaceId));
  const record = page && records.get(page);
  if (!record || record.notes.length === 0) return [];
  return record.notes.splice(0);
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/** The [modal] note the lease prepends to a result (error results included). */
export function renderModalBlock(notes: readonly DialogNote[]): string {
  const lines = notes.map(
    (n) => `- ${/^[aeiou]/.test(n.type) ? 'an' : 'a'} ${n.type} appeared and was ${n.answer} (${ago(n.at)}); page text: ${JSON.stringify(n.message)}`,
  );
  const hint = notes.some((n) => n.answer === 'dismissed')
    ? '\n- To accept the next one, call browser_dialog({accept:true}) before the action that opens it.'
    : '';
  return `[modal]\n${lines.join('\n')}${hint}\n`;
}

interface OwnerInfo {
  workspaceBackend?: string;
  targets?: Array<{ targetId?: string; surfaceId?: string; owner?: 'agent' | 'borrowed' | 'user' }>;
}

/**
 * Who owns this tab, asked of main fresh: browser_dialog may arm an answer only
 * on a tab the agent opened. Anything it cannot establish is 'unknown', which
 * the caller treats as "no". A main that reports no backend at all is the
 * builtin webview (the codebase's existing reading of an older main), where
 * every target is wmux's own; Live Chrome always reports its backend and
 * per-tab owner.
 */
export async function resolveDialogOwner(page: Page, workspaceId: string): Promise<DialogOwner> {
  let info: OwnerInfo | undefined;
  try {
    info = (await sendRpc('browser.cdp.info', { workspaceId })) as OwnerInfo | undefined;
  } catch {
    return 'unknown';
  }
  if (!info) return 'unknown';
  if (!info.workspaceBackend || info.workspaceBackend === 'builtin') return 'agent';
  let targetId: string | undefined;
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const res = (await session.send('Target.getTargetInfo')) as { targetInfo?: { targetId?: string } };
      targetId = res.targetInfo?.targetId;
    } finally {
      await session.detach().catch(ignore);
    }
  } catch {
    return 'unknown';
  }
  if (!targetId) return 'unknown';
  const row = info.targets?.find((t) => t.targetId === targetId || t.surfaceId === targetId);
  return row?.owner ?? 'unknown';
}

/**
 * browser_dialog: arm the answer for the next dialog an input dispatch of the
 * agent raises on this page, for ARMED_DIALOG_TTL_MS or one use. Refused on
 * any page not proven to be the agent's own — a lent or user tab's dialogs are
 * the person's.
 */
export function armDialogAnswer(
  page: Page,
  scopeKey: string,
  owner: DialogOwner,
  accept: boolean,
  text?: string,
): void {
  if (owner !== 'agent') {
    throw taggedFailure(
      'scope_refused',
      owner === 'unknown'
        ? 'Could not confirm this tab is one the agent opened, so no answer was armed; its dialogs keep their default handling (dismissed).'
        : 'This tab is not one the agent opened, so its dialogs are left to the person using it; no answer was armed.',
      'none',
    );
  }
  attachModalTracking(page, scopeKey);
  const record = records.get(page) as PageRecord;
  record.armed = { accept, ...(text !== undefined && { text }), expires: Date.now() + ARMED_DIALOG_TTL_MS };
}
