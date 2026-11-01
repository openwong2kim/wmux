// "Continue in <agent>", from the usage-limit card or the pane menu's dialog:
// a pane's work goes on in another installed, signed-in agent. A new tab in
// the same pane starts that agent in the pane's folder; once its prompt is up,
// the handoff note (utils/handoffNote.ts) is pasted into its input and never
// submitted, so the owner reads it before sending. The source tab stays as it
// was; the two tabs name each other in their tooltips.
//
// A handoff from a pane at or close to its usage limit is recorded on the
// source tab (when, the commit checked out, when the limit resets). Once the
// limit has reset the tab offers to bring the work back (`bringBack`): a note
// from the other agent's own transcript, typed into the source tab, unsent.

import { useStore } from '../stores';
import { t } from '../i18n';
import { terminalRegistry } from '../hooks/useTerminal';
import { agentRow } from '../../shared/agentIdentity';
import type { AgentId } from '../../shared/agentSetup';
import type { AgentStatus, Surface, SurfaceHandoff } from '../../shared/types';
import { classifyLaunchScreen } from '../../shared/agentFirstRun';
import type { TranscriptPage, TurnEvent } from '../../shared/transcript/turnEvents';
import { chatComposerDraft } from '../components/Chat/chatDrafts';
import { openTerminalTab } from './accountLogin';
import { pastePtyChunked } from './clipboardChunk';
import { updateUsageLimit } from '../hooks/useUsageLimitBridge';
import { closeTabNow } from '../components/Pane/CloseTabConfirm';
import { nearLimitWindow, USAGE_LIMIT_UNKNOWN_HOLD_MS } from '../../shared/usageLimit';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { bringBackNoteText, handoffNoteText, transcriptCommits, transcriptHandoff, type BringBackFacts, type HandoffFacts } from './handoffNote';

/** How long the new agent has to show its prompt. */
export const AGENT_READY_TIMEOUT_MS = 60_000;

/** How often the wait re-reads the terminal's paste mode and screen, which no store event reports. */
const READY_POLL_MS = 250;

/** Agent states with its prompt up and waiting for input. Not
 *  `awaiting_input`: that is a confirm or trust dialog, not the prompt. */
const READY: readonly AgentStatus[] = ['idle', 'waiting', 'complete'];

/** Held panes with a handoff under way, so a second click opens no second tab. */
const inFlight = new Set<string>();

/** Older transcript pages read back looking for the first request and earlier files. */
const HANDOFF_PAGES_MAX = 8;

/** The pane's conversation events, from `chat.snapshot` (any agent the
 *  daemon projects), oldest first: the tail page, then older pages (bounded)
 *  for the first request and files written earlier. */
async function conversationOf(ptyId: string): Promise<TurnEvent[]> {
  const snapshot = window.electronAPI?.chat?.snapshot;
  if (!snapshot) return [];
  try {
    let page = await snapshot(ptyId);
    if (!page) return [];
    const pages: TurnEvent[][] = [page.events];
    for (let n = 0; page.hasMore && n < HANDOFF_PAGES_MAX; n++) {
      const older: TranscriptPage | null = await snapshot(ptyId, page.cursor.headOffset).catch(() => null);
      if (!older || older.cursor.headOffset >= page.cursor.headOffset) break;
      page = older;
      pages.unshift(page.events);
    }
    return pages.flat();
  } catch {
    return [];
  }
}

/** The branch, checked-out commit and changes of `cwd` (the pane's folder),
 *  and the repository's top folder, which git's paths are given from. The
 *  changes are the uncommitted ones, or with `since` (a commit) everything
 *  since it, committed or not. */
async function gitOf(ptyId: string, cwd: string | undefined, since?: string | null): Promise<Pick<HandoffFacts, 'repo' | 'branch' | 'files' | 'head'> & { root: string | null }> {
  const reported = useStore.getState().surfaceGitBranch[ptyId] ?? null;
  const folder = cwd ? baseName(cwd) : null;
  if (!cwd) return { repo: null, branch: reported, files: [], head: null, root: null };
  try {
    const diff = await window.electronAPI?.diff?.read?.(cwd, since ?? '', since ? 'since' : 'workspace');
    if (diff?.ok) {
      const root = diff.snapshot.targetRepoPath || null;
      return { repo: (root && baseName(root)) || folder, branch: diff.snapshot.targetBranch || reported, files: diff.numstat, head: diff.snapshot.targetHeadOid || null, root };
    }
  } catch { /* not a repository, or unreadable: the branch the pane reported */ }
  return { repo: folder, branch: reported, files: [], head: null, root: null };
}

/** A path's last part (either separator), or null. */
function baseName(path: string): string | null {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null;
}

/** Text typed into `ptyId`'s agent input and never sent: the Chat view
 *  composer's draft, else the terminal's cursor row after the agent's prompt
 *  glyph (`>` `❯` `›`), dimmed suggestion text left out. Only that row: a
 *  multi-line draft is read from its last line. */
export function unsentDraftOf(ptyId: string): string | null {
  const chat = chatComposerDraft(ptyId)?.trim();
  if (chat) return chat;
  const term = terminalRegistry.get(ptyId);
  const buf = term?.buffer?.active;
  const line = buf?.getLine(buf.baseY + buf.cursorY);
  if (!line) return null;
  let row = '';
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    row += cell.isDim() ? ' ' : (cell.getChars() || ' ');
  }
  const typed = /^[\s│┃|]*[>❯›»]\s(.*?)[\s│┃|]*$/.exec(row)?.[1]?.trim();
  return typed || null;
}

/** Everything the handoff note is built from, for the held pane `ptyId`. */
export async function handoffFacts(ptyId: string, cwd: string | undefined): Promise<HandoffFacts> {
  const [events, { root, ...git }] = await Promise.all([conversationOf(ptyId), gitOf(ptyId, cwd)]);
  // Below the repository's top folder, as git gives the uncommitted files.
  const conversation = transcriptHandoff(events, root ?? cwd);
  const transcriptPath = useStore.getState().resumeBindingByPtyId[ptyId]?.transcriptPath ?? null;
  return { ...conversation, ...git, transcriptPath, draft: unsentDraftOf(ptyId) };
}

/** What the agent in `ptyId` did since it took the work over: its requests
 *  after the handoff note (the first one), the commits it made, the files it
 *  wrote with their line counts since `head` (the commit checked out at the
 *  handoff), and its last reply. */
export async function bringBackFacts(ptyId: string, cwd: string | undefined, head: string | null | undefined): Promise<BringBackFacts> {
  const [events, { root, repo, branch, files }] = await Promise.all([conversationOf(ptyId), gitOf(ptyId, cwd, head)]);
  const { requests, reply, filesTouched } = transcriptHandoff(events, root ?? cwd);
  const transcriptPath = useStore.getState().resumeBindingByPtyId[ptyId]?.transcriptPath ?? null;
  return { repo, branch, files, requests: requests.slice(1), reply, filesTouched, commits: transcriptCommits(events), transcriptPath };
}

/** True when `ptyId`'s terminal is mounted and takes a bracketed paste. An
 *  unbracketed paste turns every line break into Enter, sending the note line by line. */
function takesBracketedPaste(ptyId: string): boolean {
  const term = terminalRegistry.get(ptyId) as unknown as { modes?: { bracketedPasteMode?: boolean } } | undefined;
  return term?.modes?.bracketedPasteMode === true;
}

/** True when `ptyId`'s visible screen shows an agent launch screen: a trust
 *  dialog, a first-run prompt or any other menu. Pane status can read such a
 *  screen as idle, and the agent may turn bracketed paste on before drawing it. */
function onLaunchScreen(ptyId: string): boolean {
  const term = terminalRegistry.get(ptyId);
  if (!term) return true;
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) rows.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
  return classifyLaunchScreen(rows.join('\n')) !== null;
}

/** Resolves true once `ptyId` shows `agent` with its prompt up, no launch
 *  screen, and a terminal that takes a bracketed paste; false on timeout. The
 *  status arrives over metadata IPC and the screen over the pty stream, in no
 *  fixed order. */
function agentReady(ptyId: string, agent: AgentId, timeoutMs: number, statuses: readonly AgentStatus[] = READY): Promise<boolean> {
  const ready = (): boolean => {
    const a = useStore.getState().surfaceAgent[ptyId];
    return !!a && a.slug === agent && statuses.includes(a.status) && takesBracketedPaste(ptyId) && !onLaunchScreen(ptyId);
  };
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      unsubscribe();
      resolve(ok);
    };
    const check = () => { if (ready()) finish(true); };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    const poll = window.setInterval(check, READY_POLL_MS);
    const unsubscribe = useStore.subscribe(check);
  });
}

/**
 * Open `agent` in a new tab of the held pane and type the handoff note into
 * its input without sending it. False when the tab could not open, the
 * agent never showed its prompt (the owner is told; nothing is typed), or a
 * handoff from this pane is already under way.
 */
export async function continueInAgent(req: {
  heldPtyId: string;
  fromAgent: string;
  agent: AgentId;
  workspaceId: string;
  paneId: string;
  cwd?: string;
  /** The note as the card previewed it; built here when absent. */
  note?: string;
  /** The commit checked out when that note was read. */
  head?: string | null;
}, timeoutMs = AGENT_READY_TIMEOUT_MS): Promise<boolean> {
  if (inFlight.has(req.heldPtyId)) return false;
  inFlight.add(req.heldPtyId);
  try {
    return await handOff(req, timeoutMs);
  } finally {
    inFlight.delete(req.heldPtyId);
  }
}

/** The record of a handoff from `ptyId` when it is at or close to its usage
 *  limit (when that limit resets, the work can come back), else null. A
 *  limit with no known reset is held at most USAGE_LIMIT_UNKNOWN_HOLD_MS. */
export function handoffRecord(ptyId: string, head: string | null | undefined, now = Date.now()): SurfaceHandoff | null {
  const state = useStore.getState();
  const limit = state.usageLimits[ptyId];
  const resetsAt = limit
    ? (limit.resetsAt ?? limit.detectedAt + USAGE_LIMIT_UNKNOWN_HOLD_MS)
    : nearLimitWindow(state.usageWindows[ptyId], now)?.resetsAt;
  return resetsAt === undefined ? null : { at: now, resetsAt, ...(head ? { head } : {}) };
}

async function handOff(req: Parameters<typeof continueInAgent>[0], timeoutMs: number): Promise<boolean> {
  const row = agentRow(req.agent);
  const name = row?.display ?? req.agent;
  let head = req.head;
  let note = req.note;
  if (note === undefined) {
    const facts = await handoffFacts(req.heldPtyId, req.cwd);
    note = handoffNoteText(req.fromAgent, facts);
    head = facts.head;
  }
  const tab = await openTerminalTab({
    initialCommand: row?.launcher ?? req.agent,
    title: name,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    target: { workspaceId: req.workspaceId, paneId: req.paneId },
  });
  if (!tab) return false;
  const record = handoffRecord(req.heldPtyId, head);
  useStore.getState().linkContinuedSurfaces(req.heldPtyId, tab.ptyId, record ?? undefined);
  // The work goes on over there: a held pane must not also carry on by
  // itself at the reset. Bringing it back is the owner's call.
  if (useStore.getState().usageLimits[req.heldPtyId]?.autoResume === true) void updateUsageLimit(req.heldPtyId, { autoResume: false });
  const ready = await agentReady(tab.ptyId, req.agent, timeoutMs);
  const term = terminalRegistry.get(tab.ptyId);
  if (!ready || !term || !takesBracketedPaste(tab.ptyId) || onLaunchScreen(tab.ptyId)) {
    useStore.getState().pushToast({ level: 'warn', message: t('usageLimit.continueInAgentNotReady', { agent: name }) });
    return false;
  }
  await pastePtyChunked((d) => window.electronAPI.pty.write(tab.ptyId, d), note, { bracketedPasteMode: true });
  term.focus();
  return true;
}

/** A tab holding a handoff record and the tab its work went on in, found by
 *  the source's ptyId. Both must still be open. */
export interface BringBackPair {
  workspaceId: string;
  paneId: string;
  source: Surface & { ptyId: string; handoff: SurfaceHandoff };
  other: Surface & { ptyId: string };
}

/** The pair `ptyId` belongs to, as the source tab or as the tab the work went on in. */
export function findBringBackPair(state: Pick<ReturnType<typeof useStore.getState>, 'workspaces'>, ptyId: string): BringBackPair | null {
  for (const ws of state.workspaces) {
    // Read on every chip render: a workspace without its tree yet is skipped, not thrown on.
    if (!ws.rootPane) continue;
    const panes = getWorkspaceLeafPanes(ws);
    const tab = panes.flatMap((p) => p.surfaces).find((s) => s.ptyId === ptyId);
    if (!tab) continue;
    const sourceId = tab.handoff ? tab.id : tab.continuedFrom;
    const pane = sourceId ? panes.find((p) => p.surfaces.some((s) => s.id === sourceId)) : undefined;
    const source = pane?.surfaces.find((s) => s.id === sourceId);
    if (!pane || !source?.ptyId || !source.handoff || !source.continuedIn) return null;
    const other = panes.flatMap((p) => p.surfaces).find((s) => s.id === source.continuedIn);
    // On the other tab, only the tab this source's work went on in.
    if (!other?.ptyId || (tab !== source && other !== tab)) return null;
    return { workspaceId: ws.id, paneId: pane.id, source: source as BringBackPair['source'], other: other as BringBackPair['other'] };
  }
  return null;
}

/** When the work can come back to the source tab: its limit's reset (the one
 *  it still shows, else the one recorded at the handoff). */
export function bringBackAt(pair: BringBackPair, state: Pick<ReturnType<typeof useStore.getState>, 'usageLimits'>): number {
  return state.usageLimits[pair.source.ptyId]?.resetsAt ?? pair.source.handoff.resetsAt;
}

/** Holds source ptyIds with a bring-back under way, so a second click types nothing twice. */
const bringing = new Set<string>();

/**
 * Bring the work back to the source tab of `pair`: type `note` (what the
 * other agent did) into its agent's input without sending it, show that tab,
 * and drop the handoff record. With `closeOther` the other tab is then closed
 * as its × would close it, without the confirm (the owner ticked it). False when
 * the source's agent never showed its prompt (the owner is told; nothing is
 * typed, the record stays) or a bring-back is already under way.
 */
export async function bringBack(pair: BringBackPair, note: string, opts: { closeOther?: boolean } = {}, timeoutMs = AGENT_READY_TIMEOUT_MS): Promise<boolean> {
  const ptyId = pair.source.ptyId;
  if (bringing.has(ptyId)) return false;
  bringing.add(ptyId);
  try {
    const store = useStore.getState();
    const slug = store.surfaceAgent[ptyId]?.slug;
    const name = (slug && agentRow(slug)?.display) || slug || t('surface.terminal');
    store.setActiveSurface(pair.paneId, pair.source.id, pair.workspaceId);
    // A turn that ended on the usage limit reads as an error, with the prompt back up.
    const ready = !!slug && await agentReady(ptyId, slug as AgentId, timeoutMs, [...READY, 'error']);
    const term = terminalRegistry.get(ptyId);
    if (!ready || !term) {
      useStore.getState().pushToast({ level: 'warn', message: t('usageLimit.continueInAgentNotReady', { agent: name }) });
      return false;
    }
    await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), note, { bracketedPasteMode: true });
    term.focus();
    useStore.getState().clearSurfaceHandoff(pair.source.id);
    // Ticked in the card: that is the owner's word to close it, so no second ask.
    if (opts.closeOther) closeTabNow({ workspaceId: pair.workspaceId, paneId: pair.paneId, surfaceId: pair.other.id });
    return true;
  } finally {
    bringing.delete(ptyId);
  }
}

/** The note that brings the work back, from the other tab's transcript. */
export async function bringBackNote(pair: BringBackPair): Promise<string> {
  const otherSlug = useStore.getState().surfaceAgent[pair.other.ptyId]?.slug;
  const byAgent = (otherSlug && agentRow(otherSlug)?.display) || otherSlug || pair.other.title || t('surface.terminal');
  return bringBackNoteText(byAgent, await bringBackFacts(pair.other.ptyId, pair.other.cwd ?? pair.source.cwd, pair.source.handoff.head));
}
