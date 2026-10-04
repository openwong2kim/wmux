// ─── Right-side dock (Approach A) ────────────────────────────────────────
//
// A collapsible flex column on the OPPOSITE edge from the workspace sidebar.
// It is Moa only (owner decision, 2026-10-04): the desktop Channels tab is
// gone; channel data, the MCP channel tools and the phone's /api/channels
// stay. This replaced the old `position: fixed` ChannelView overlay that
// covered the terminals — the dock is a flex sibling
// in AppLayout's root row, so it reflows the panes instead of floating over
// them. Mounted only when `channelDockVisible` (uiSlice); auto-opens when a
// channel is selected (channelsSlice.setActiveChannel), and opens AND closes
// from the titlebar's DeckToggle (2026-08-18) — this component carries no
// collapse control of its own, because one command deserves one button and a
// chevron here was that command a second time.
//
// Width: clamped (not a hard 320px) so a narrow window doesn't crush the
// terminals down to per-character wrapping. The dock gives back space when the
// viewport is small and grows to 320 when there's room.
//
// Edge mirroring: the workspace Sidebar sits on `sidebarPosition`; the dock
// sits opposite. AppLayout's root uses `flex-row-reverse` when the sidebar is
// docked right, so placing the dock as the last flex child puts it on the
// correct (opposite) edge automatically — we only flip the inner border side.

import { useState } from 'react';
import { useStore } from '../../stores';
import { DOCK_WIDTH_CSS } from '../Layout/dockLayout';
import { tokenAttrs } from '../../themes';
import { useT } from '../../hooks/useT';
import { isOurHandoffDrag, takeHandoffDrop } from '../Git/handoffDrag';
import { moaHqId } from '../../stores/slices/moaSlice';
import { DeckTabs } from '../Deck/DeckTabs';
import { CommanderView } from '../Deck/CommanderView';
import { MODEL_OPTIONS } from '../Deck/OrchestratorModelChip';
import { claudeModelLabel } from '../../../shared/claudeModels';
import { useCallback, useMemo } from 'react';
import { MoaMascot } from '../Moa/MoaMascot';
import { moaMascotState, resolveMoaPanelMode } from '../Moa/panel/moaPanelMode';
import { useMoaDecisions } from '../Moa/panel/useMoaPanelData';
import { MoaPanelTop, renderMoaChat } from '../Moa/panel/MoaPanelTop';
import { MoaHqProblemCard, MoaOffCard, MoaSetupHint } from '../Moa/panel/MoaPanelCards';
import { DeckLedgerPanel } from '../Deck/DeckLedgerPanel';
import { useShallow } from 'zustand/react/shallow';
import { findMission, selectMissionChannelIds } from '../../stores/selectors/missions';

// ─── Command Deck (Phase 1 P1a) ───────────────────────────────────────────────
//
// The dock is now a tabbed Command Deck. Its DEFAULT tab, `commander`, is the
// LLM-less command composer (fan-out @mentions to the fleet from one thread);
// the `channels` tab holds the classic list + conversation exactly as before
// (the code below is unchanged, just wrapped in a conditional). Phase 2's
// orchestrator chat reuses the Commander tab + composer skeleton wholesale.
//
// Moa (the HQ main bot): the Commander tab is ALWAYS Moa's conversation. The
// chat is pinned to the HQ while the active workspace only supplies context,
// so switching workspaces never switches who you are talking to. Moa off →
// a card that says how to turn it on; HQ gone or not seen yet → a card with
// the recovery; Moa on without an HQ (an install that kept its existing
// brains) → today's per-workspace chat plus a "Set up Moa" hint.

/**
 * The active workspace's delegated tasks, kept on screen while the panel is
 * only a Moa-off / HQ-problem card. The sidebar's Tasks line opens this panel;
 * without the ledger it landed on the card with no way on to the tasks. Rows
 * jump to a task's workspace or its mission channel, as in CommanderView; no
 * brain is involved. Renders nothing when there are no tasks.
 */
function CardModeLedger({ workspaceId, t }: { workspaceId: string; t: (key: string) => string }) {
  const channelByTaskId = useStore(useShallow((s) => selectMissionChannelIds(s.missionsByWorkspace)));
  const finishedExpanded = useStore((s) => s.deckLedgerFinishedExpanded);
  const setFinishedExpanded = useStore((s) => s.setDeckLedgerFinishedExpanded);
  // The mission channel reads in Fleet, as the task's conversation.
  const openChannel = useCallback((channelId: string) => {
    const st = useStore.getState();
    const task = findMission(st.missionsByWorkspace, (item) => item.missionChannelId === channelId);
    if (task) st.openTaskConversation(task.id);
  }, []);
  const jumpToWorkspace = useCallback((id: string) => useStore.getState().setActiveWorkspace(id), []);
  const onLedgerPush = useCallback(() => {
    if (workspaceId) void useStore.getState().refreshMissions(workspaceId);
  }, [workspaceId]);
  return (
    <DeckLedgerPanel
      t={t}
      workspaceId={workspaceId}
      channelByTaskId={channelByTaskId}
      onOpenChannel={openChannel}
      onJumpToTaskWorkspace={jumpToWorkspace}
      finishedExpanded={finishedExpanded}
      onToggleFinished={setFinishedExpanded}
      onLedgerPush={onLedgerPush}
    />
  );
}

export default function ChannelDock(): React.ReactElement {
  // Orchestrator 모델 — 컨트롤 바 칩에서 Agent 탭 인라인 드롭다운으로 이동.
  // DeckTabs는 순수 컴포넌트이므로 라벨·옵션·선택 콜백을 여기서 store와 잇는다.
  const t = useT();
  const deckBrainModel = useStore((s) => s.deckBrainModel);
  const setDeckBrainModel = useStore((s) => s.setDeckBrainModel);
  const commanderModelLabel =
    deckBrainModel === '' ? t('deck.orchestratorModelDefault') : claudeModelLabel(deckBrainModel);

  const moa = useStore((s) => s.moa);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId) || '';
  const mode = useMemo(() => resolveMoaPanelMode(moa, activeWorkspaceId), [moa, activeWorkspaceId]);
  const moaOwnsTab = mode.kind !== 'legacy';
  const { decisions, refresh: refreshDecisions } = useMoaDecisions(mode.kind === 'moa');
  const hqBusy = useStore((s) => mode.kind === 'moa' && s.brainThreads[mode.hqId]?.status === 'busy');
  const mascot = moaMascotState({ busy: hqBusy, pendingDecisions: decisions.length });
  const openMoaSettings = useCallback(() => useStore.getState().openSettingsTab('moa'), []);
  const moaSlots = useMemo(
    () => (mode.kind === 'moa'
      ? { top: <MoaPanelTop decisions={decisions} onResolved={refreshDecisions} t={t} />, renderChat: renderMoaChat }
      : undefined),
    [mode.kind, decisions, refreshDecisions, t],
  );

  const commander = (() => {
    switch (mode.kind) {
      // The ledger sits where CommanderView pins it (above the content), so
      // the tasks the sidebar line points at are reachable here too.
      case 'off':
        return (
          <>
            <CardModeLedger workspaceId={activeWorkspaceId} t={t} />
            <MoaOffCard onOpenSettings={openMoaSettings} t={t} />
          </>
        );
      case 'hq-problem':
        return (
          <>
            <CardModeLedger workspaceId={activeWorkspaceId} t={t} />
            <MoaHqProblemCard state={mode.state} onOpenSettings={openMoaSettings} t={t} />
          </>
        );
      case 'moa':
        return <CommanderView chatWorkspaceId={mode.chatWorkspaceId} viewedWorkspaceId={activeWorkspaceId} moa={moaSlots} />;
      default:
        return (
          <>
            {mode.setupHint && <MoaSetupHint onOpenSettings={openMoaSettings} t={t} />}
            <CommanderView chatWorkspaceId={mode.chatWorkspaceId} viewedWorkspaceId={activeWorkspaceId} />
          </>
        );
    }
  })();

  // The dock is a floating panel (ui.css .wmux-dock), so it needs no edge
  // border facing the workspace; the shell gap separates them.

  // An issue or PR dragged from the Git page onto the dock goes to Moa: the
  // hand-off popover opens on Moa's HQ workspace and lists its agents (the
  // same fixed reference, gated delivery and work link as any drop).
  const [handoffOver, setHandoffOver] = useState(false);
  const moaAccepts = (dt: DataTransfer) => isOurHandoffDrag(dt) && !!moaHqId(useStore.getState());
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!moaAccepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!handoffOver) setHandoffOver(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setHandoffOver(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!moaAccepts(e.dataTransfer)) return;
    e.preventDefault();
    setHandoffOver(false);
    const st = useStore.getState();
    const hq = moaHqId(st);
    const taken = takeHandoffDrop(e.dataTransfer);
    if (taken && hq) st.setGitHandoff({ item: taken.item, workspaceId: hq, repo: taken.repo, anchor: { x: e.clientX, y: e.clientY } });
  };

  return (
    <div
      className="wmux-dock flex flex-col h-full bg-[var(--bg-base)]"
      style={{ width: DOCK_WIDTH_CSS, maxWidth: '100%', borderColor: 'var(--border-soft)' }}
      id="wmux-tools-panel"
      data-channel-dock
      data-handoff-over={handoffOver ? 'true' : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      <DeckTabs
        // The right panel is Moa only: no Channels tab, so nothing to select.
        active="commander"
        showChannels={false}
        onSelect={() => undefined}
        commanderModelLabel={commanderModelLabel}
        commanderModelOptions={MODEL_OPTIONS}
        commanderModelValue={deckBrainModel}
        onCommanderModelSelect={setDeckBrainModel}
        {...(moaOwnsTab
          ? {
              commanderTitle: t('moa.panel.title'),
              commanderSubtitle: t('moa.panel.subtitle'),
              commanderIcon: <MoaMascot state={mascot} size={28} />,
              commanderStatusLabel: mascot === 'idle' ? undefined : t(`moa.panel.mascot.${mascot}`),
            }
          : {})}
        /* No collapse button here any more. The titlebar's DeckToggle closes
           the deck as well as opening it (2026-08-18), so a second chevron in
           this header was the same command twice, ~30px apart. One control in
           one fixed place beats two that move depending on whether the deck
           happens to be open. */
        t={t}
      />

      {commander}
    </div>
  );
}
