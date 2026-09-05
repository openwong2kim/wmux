// ─── Command Deck renderer state (Command Deck Phase 1, per-ws M1.5) ─────────
//
// The right-side dock is being re-framed from a pure "channel viewer" into a
// Command Deck: a tabbed surface whose DEFAULT tab (`commander`) is an
// LLM-less command composer — @-mention several agent panes at once and watch
// their replies land in one thread — and whose second tab (`channels`) holds
// the existing channel list + conversation exactly as before.
//
// This slice owns the deck's chrome state (which tab is active) and the
// Commander BRAIN threads. M1.5: one orchestrator per workspace → the brain
// conversation is a wsId-keyed map of independent threads, each with its own
// busy state. The deck shows the ACTIVE workspace's thread; a turn streaming
// in a background workspace keeps landing in ITS thread (events arrive
// enveloped with their workspaceId), so switching back shows the complete
// transcript — and the active workspace's composer is never blocked by
// another workspace's turn (the parallelism that motivated M1.5).
//
// Pattern mirrors the other thin UI slices (uiSlice's dock/panel toggles):
// enum fields + setters, no async, no bridge.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { BrainEvent } from '../../../main/deck/BrainAdapter';
import {
  applyBrainEvent,
  type DeckBrainMessage,
} from '../../components/Deck/deckBrain';
import { generateId, type BrainVendor } from '../../../shared/types';

/** Which dock tab is showing. `commander` is the default (the LLM-less
 *  command composer); `channels` is the classic channel list + conversation.
 *  git — 오너 결정(2026-07-20): 좌측 푸터/중앙 표면 시안을 원복하고 우측 덱의
 *  탭으로 복귀. Review는 별도 탭이 아니라 Git 탭 하단 섹션으로 병합(전 ws 집계). */
export type DeckTab = 'commander' | 'git' | 'channels';

/** One workspace orchestrator's turn state. Distinct from the Phase 1 fan-out
 *  threads (which live in the `#commander` channel): the brain stream is an
 *  orchestrator turn, not channel semantics, so it is deck-owned state. */
export type DeckBrainStatus = 'idle' | 'busy';

export interface DeckBrainThread {
  messages: DeckBrainMessage[];
  /** `busy` while a brain turn streams in THIS workspace; the composer
   *  disables to enforce the per-workspace one-turn-at-a-time contract the
   *  session manager also guards. */
  status: DeckBrainStatus;
}

export const EMPTY_DECK_BRAIN_THREAD: DeckBrainThread = { messages: [], status: 'idle' };

export interface DeckSlice {
  /** Active dock tab. Defaults to `commander` — the deck opens on the command
   *  composer, and the channel list is one tab over. Transient UI state (not
   *  persisted): the deck always opens on Commander on a fresh load. */
  activeDeckTab: DeckTab;
  setActiveDeckTab: (tab: DeckTab) => void;

  /**
   * Whether the ledger panel's finished-tasks disclosure is open. Store state
   * rather than panel-local because the sidebar's "N finished" line navigates
   * INTO it — a click on the sidebar has to be able to open it. Transient (not
   * persisted): finished tasks are history, and the deck opens on the work.
   */
  deckLedgerFinishedExpanded: boolean;
  setDeckLedgerFinishedExpanded: (expanded: boolean) => void;

  /** Per-workspace orchestrator conversations (this-session only — the
   *  transcript itself resumes SDK-side via the persisted session id). */
  brainThreads: Record<string, DeckBrainThread>;

  /** Open a new brain turn on one workspace's thread: push the human message
   *  + a streaming assistant placeholder, and mark that workspace busy. */
  startDeckBrainTurn: (workspaceId: string, text: string) => void;
  /** Apply one normalized brain stream event to the given workspace's open
   *  turn. `turn-end` / `error` flip that workspace back to idle. */
  applyDeckBrainEvent: (workspaceId: string, event: BrainEvent) => void;
  /** Mark the given workspace's open turn failed (used when deck.send is
   *  REJECTED before any stream event — e.g. a busy race). */
  failDeckBrainTurn: (workspaceId: string, message: string) => void;

  /** `claude-pty` brain only: the daemon session id of each workspace's
   *  embedded Claude Code TUI, pushed by main when the adapter spawns it.
   *  Transient — a fresh launch re-learns it on the next turn. */
  brainPtyIds: Record<string, string | null>;
  setBrainPtyId: (workspaceId: string, ptyId: string | null) => void;
  /** Replace the whole map from main's snapshot (mount-time hydration — a
   *  reloaded renderer missed every push that came before it subscribed). */
  hydrateBrainPtyIds: (ptyIds: Record<string, string>) => void;

  /** P3b: the reboot-recovery greeting card was dismissed (or its recovery was
   *  launched) this session. Transient — a fresh launch re-evaluates from the
   *  resume hints, which self-clear as agents come back. */
  recoveryCardDismissed: boolean;
  dismissRecoveryCard: () => void;

  /** diff→오케스트레이터 질문 릴레이. DiffPanel(다른 표면)이 질문을 실어 두고
   *  Orchestrator 탭으로 전환하면, CommanderView가 마운트/변경 시 집어
   *  handleBrainSend로 발사한다 — fleet context·optimistic 버블·모델 오버라이드
   *  조립을 한 곳(CommanderView)에 유지하기 위한 우회로. transient(비영속). */
  pendingBrainPrompt: string | null;
  setPendingBrainPrompt: (prompt: string | null) => void;
}

function threadOf(state: StoreState, workspaceId: string): DeckBrainThread {
  const existing = state.brainThreads[workspaceId];
  if (existing) return existing;
  const fresh: DeckBrainThread = { messages: [], status: 'idle' };
  state.brainThreads[workspaceId] = fresh;
  return fresh;
}

// The brain vendor is a live setting, so a thread can hold turns from two
// different brains — which share no transcript, no tool surface and no session.
// Stamping the vendor at turn-open is what lets the log show the break instead
// of implying a continuity that does not exist.
//
// `vendor` is OPTIONAL and never inferred here: a main-originated turn carries
// the vendor that actually served it on the event, and reading the store's live
// global instead would stamp a turn the OLD brain produced with the vendor the
// operator has just switched to — a false label AND a false boundary. Absent
// vendor ⇒ no stamp, which the log renders as no tag rather than a guess.
function openTurn(thread: DeckBrainThread, text: string, vendor?: BrainVendor): void {
  thread.messages.push({ id: generateId('dbu'), role: 'user', text, ts: Date.now(), vendor });
  thread.messages.push({
    id: generateId('dba'),
    role: 'assistant',
    text: '',
    ts: Date.now(),
    vendor,
    tools: [],
    status: 'streaming',
  });
  thread.status = 'busy';
}

export const createDeckSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  DeckSlice
> = (set) => ({
  activeDeckTab: 'commander',

  deckLedgerFinishedExpanded: false,

  setDeckLedgerFinishedExpanded: (expanded) =>
    set((state) => {
      state.deckLedgerFinishedExpanded = expanded;
    }),


  setActiveDeckTab: (tab) =>
    set((state: StoreState) => {
      state.activeDeckTab = tab;
    }),

  brainThreads: {},

  pendingBrainPrompt: null,

  setPendingBrainPrompt: (prompt) =>
    set((state: StoreState) => {
      state.pendingBrainPrompt = prompt;
    }),

  startDeckBrainTurn: (workspaceId, text) =>
    set((state: StoreState) => {
      openTurn(threadOf(state, workspaceId), text, state.deckBrainVendor);
    }),

  applyDeckBrainEvent: (workspaceId, event) =>
    set((state: StoreState) => {
      const thread = threadOf(state, workspaceId);
      // A main-originated turn (P3d scheduled run) announces itself with
      // `turn-start` — open the turn exactly like startDeckBrainTurn so the
      // scheduled run renders as visibly as a typed one (in ITS workspace's
      // thread, which may be a background one).
      if (event.type === 'turn-start') {
        openTurn(thread, event.prompt, event.vendor);
        return;
      }
      thread.messages = applyBrainEvent(thread.messages, event);
      if (event.type === 'turn-end' || event.type === 'error') {
        thread.status = 'idle';
      }
    }),

  failDeckBrainTurn: (workspaceId, message) =>
    set((state: StoreState) => {
      const thread = threadOf(state, workspaceId);
      thread.messages = applyBrainEvent(thread.messages, { type: 'error', message });
      thread.status = 'idle';
    }),

  brainPtyIds: {},

  setBrainPtyId: (workspaceId, ptyId) =>
    set((state: StoreState) => {
      state.brainPtyIds[workspaceId] = ptyId;
    }),

  hydrateBrainPtyIds: (ptyIds) =>
    set((state: StoreState) => {
      state.brainPtyIds = { ...ptyIds };
    }),

  recoveryCardDismissed: false,
  dismissRecoveryCard: () =>
    set((state: StoreState) => {
      state.recoveryCardDismissed = true;
    }),
});
