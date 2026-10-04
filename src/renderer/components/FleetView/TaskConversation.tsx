// A fan-out task's Conversation: its mission channel (worker reports,
// orchestrator instructions, ledger transitions, questions), read-only,
// oldest first, live. It reads the same store the channel event subscription
// fills, so new posts arrive without polling; opening it loads the recent
// history once, as the human seat (the daemon lets the human observe every
// mission channel with its full history). No composer, no ack.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import type { ChannelMember, ChannelMessage } from '../../../shared/channels';
import { HUMAN_MEMBER_ID, HUMAN_WORKSPACE_ID } from '../../../shared/channels';
import type { WorkTask } from '../../../shared/workTask';
import { hydrateChannelsCatalog, loadChannelHistory } from '../../hooks/useChannelsHydration';
import { paneNameForAuthor, paneNamesKey, parsePaneNamesKey } from '../../channels/paneMemberNames';
import { ChannelMessageRow } from '../Channels/ChannelMessageRow';
import { TASK_WORKSPACE_PREFIX } from '../../utils/fanoutProvenance';
import { SCROLLBACK_PAGE, sortMessagesBySeq, isMessageVisibleToViewer } from '../Channels/ChannelView';

// Module-level empties: a selector returning a fresh [] re-renders forever.
const EMPTY_MESSAGES: ChannelMessage[] = [];
const EMPTY_MEMBERS: ChannelMember[] = [];

/** How close to the end counts as "reading the latest" (px). */
const STICK_TO_END_PX = 24;

export default function TaskConversation({
  task,
  now,
  t,
}: {
  task: WorkTask;
  now: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement {
  const channelId = task.missionChannelId;
  const known = useStore((s) => !!s.channels[channelId]);
  const messages = useStore((s) => s.channelMessages[channelId] ?? EMPTY_MESSAGES);
  const members = useStore((s) => s.channelMembers[channelId] ?? EMPTY_MEMBERS);
  // Read-only: the human's own row when seated, else the whole history.
  const viewer = useMemo<ChannelMember>(
    () => members.find((m) => m.workspaceId === HUMAN_WORKSPACE_ID)
      ?? { workspaceId: HUMAN_WORKSPACE_ID, memberId: HUMAN_MEMBER_ID, joinedAt: 0, historyFromSeq: 0 },
    [members],
  );
  const visible = useMemo(() => {
    const sorted = sortMessagesBySeq(messages).filter((m) => isMessageVisibleToViewer(m, viewer));
    return sorted.length > SCROLLBACK_PAGE ? sorted.slice(sorted.length - SCROLLBACK_PAGE) : sorted;
  }, [messages, viewer]);

  // Names for the author chips, as the channel view builds them (string
  // projections, so terminal churn does not repaint the transcript).
  const workspaceNamesKey = useStore((s) => s.workspaces.map((w) => `${w.id}\u0000${w.name}`).join('\u0001'));
  const workspaceName = useMemo(() => {
    const names = new Map(workspaceNamesKey ? workspaceNamesKey.split('\u0001').map((p) => p.split('\u0000') as [string, string]) : []);
    return (id: string) => names.get(id);
  }, [workspaceNamesKey]);
  const paneNameSources = useStore(useShallow((s) => ({ workspaces: s.workspaces, surfaceAgent: s.surfaceAgent, paneLabel: s.paneLabel })));
  const paneNamesProjection = useMemo(() => paneNamesKey(paneNameSources), [paneNameSources]);
  const paneNameFor = useMemo(() => {
    const names = parsePaneNamesKey(paneNamesProjection);
    return (workspaceId: string, memberId: string) => paneNameForAuthor({ members, names, workspaceId, memberId });
  }, [paneNamesProjection, members]);

  // The daemon's own posts (ledger transitions, fan-out notes) and posts
  // made as a whole workspace carry the workspace id as the author. Shown as
  // that workspace's name instead (a task workspace without its prefix).
  const rows = useMemo(() => visible.map((m) => {
    if ((m.memberName || m.memberId) !== m.workspaceId) return m;
    const name = workspaceName(m.workspaceId)?.replace(TASK_WORKSPACE_PREFIX, '');
    return name ? { ...m, memberName: name, memberId: name } : m;
  }), [visible, workspaceName]);

  // Load the recent history. A channel missing from the catalog would get no
  // live posts (the subscription appends a private channel only for a member
  // or an observed catalog row), so the catalog is re-read first.
  useEffect(() => {
    const bridge = useStore.getState().channelsRpc();
    if (!bridge) return undefined;
    let disposed = false;
    const load = async () => {
      if (!useStore.getState().channels[channelId]) {
        await hydrateChannelsCatalog({
          rpc: bridge.rpc,
          workspaceId: HUMAN_WORKSPACE_ID,
          setChannels: useStore.getState().setChannels,
          isCurrent: () => !disposed,
        });
      }
      if (disposed) return;
      await loadChannelHistory({
        rpc: bridge.rpc,
        channelId,
        nextSeq: useStore.getState().channels[channelId]?.nextSeq ?? 1,
        workspaceId: HUMAN_WORKSPACE_ID,
        apply: useStore.getState().hydrateChannelMessages,
        isCurrent: () => !disposed,
      });
    };
    void load();
    return () => { disposed = true; };
  }, [channelId]);

  // On screen means read: no unread count piles up behind it.
  const lastSeq = visible.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (known && lastSeq > 0) useStore.getState().markChannelRead(channelId);
  }, [channelId, known, lastSeq]);

  // Opens at the newest post; follows new posts only while the reader is at
  // the end, so scrolling back to read is never yanked away.
  const logRef = useRef<HTMLDivElement>(null);
  const atEndRef = useRef(true);
  useEffect(() => { atEndRef.current = true; }, [channelId]);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && atEndRef.current) el.scrollTop = el.scrollHeight;
  }, [channelId, lastSeq]);

  return (
    <section className="wmux-board-conversation" data-fleet-conversation data-channel-id={channelId}
      aria-label={t('fleetBoard.conversationLabel', { title: task.title })}>
      <span className="wmux-board-preview-head">{t('fleetBoard.conversation', { title: task.title })}</span>
      <div
        ref={logRef}
        role="log"
        tabIndex={0}
        className="wmux-board-conversation-log"
        data-fleet-conversation-log
        onScroll={(e) => {
          const el = e.currentTarget;
          atEndRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_END_PX;
        }}
      >
        {visible.length === 0 ? (
          <p className="wmux-board-conversation-empty">{t('fleetBoard.conversationEmpty')}</p>
        ) : rows.map((m) => (
          <ChannelMessageRow
            key={`${channelId}:${m.seq}`}
            message={m}
            viewer={viewer}
            now={now}
            t={t}
            workspaceName={workspaceName}
            paneNameFor={paneNameFor}
          />
        ))}
      </div>
    </section>
  );
}
