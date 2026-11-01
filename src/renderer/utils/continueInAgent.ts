// "Continue in <agent>", from the usage-limit card or the pane menu's dialog:
// a pane's work goes on in another installed, signed-in agent. A new tab in
// the same pane starts that agent in the pane's folder; once its prompt is up,
// the handoff note (utils/handoffNote.ts) is pasted into its input and never
// submitted, so the owner reads it before sending. The source tab stays as it
// was; the two tabs name each other in their tooltips.

import { useStore } from '../stores';
import { t } from '../i18n';
import { terminalRegistry } from '../hooks/useTerminal';
import { agentRow } from '../../shared/agentIdentity';
import type { AgentId } from '../../shared/agentSetup';
import type { AgentStatus } from '../../shared/types';
import { classifyLaunchScreen } from '../../shared/agentFirstRun';
import type { TranscriptPage, TurnEvent } from '../../shared/transcript/turnEvents';
import { chatComposerDraft } from '../components/Chat/chatDrafts';
import { openTerminalTab } from './accountLogin';
import { pastePtyChunked } from './clipboardChunk';
import { handoffNoteText, transcriptHandoff, type HandoffFacts } from './handoffNote';

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

/** The branch and uncommitted changes of `cwd` (the pane's folder), and the
 *  repository's top folder, which git's paths are given from. */
async function gitOf(ptyId: string, cwd: string | undefined): Promise<Pick<HandoffFacts, 'repo' | 'branch' | 'files'> & { root: string | null }> {
  const reported = useStore.getState().surfaceGitBranch[ptyId] ?? null;
  const folder = cwd ? baseName(cwd) : null;
  if (!cwd) return { repo: null, branch: reported, files: [], root: null };
  try {
    const diff = await window.electronAPI?.diff?.read?.(cwd, '', 'workspace');
    if (diff?.ok) {
      const root = diff.snapshot.targetRepoPath || null;
      return { repo: (root && baseName(root)) || folder, branch: diff.snapshot.targetBranch || reported, files: diff.numstat, root };
    }
  } catch { /* not a repository, or unreadable: the branch the pane reported */ }
  return { repo: folder, branch: reported, files: [], root: null };
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
function agentReady(ptyId: string, agent: AgentId, timeoutMs: number): Promise<boolean> {
  const ready = (): boolean => {
    const a = useStore.getState().surfaceAgent[ptyId];
    return !!a && a.slug === agent && READY.includes(a.status) && takesBracketedPaste(ptyId) && !onLaunchScreen(ptyId);
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
}, timeoutMs = AGENT_READY_TIMEOUT_MS): Promise<boolean> {
  if (inFlight.has(req.heldPtyId)) return false;
  inFlight.add(req.heldPtyId);
  try {
    return await handOff(req, timeoutMs);
  } finally {
    inFlight.delete(req.heldPtyId);
  }
}

async function handOff(req: Parameters<typeof continueInAgent>[0], timeoutMs: number): Promise<boolean> {
  const row = agentRow(req.agent);
  const name = row?.display ?? req.agent;
  const note = req.note ?? handoffNoteText(req.fromAgent, await handoffFacts(req.heldPtyId, req.cwd));
  const tab = await openTerminalTab({
    initialCommand: row?.launcher ?? req.agent,
    title: name,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    target: { workspaceId: req.workspaceId, paneId: req.paneId },
  });
  if (!tab) return false;
  useStore.getState().linkContinuedSurfaces(req.heldPtyId, tab.ptyId);
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
