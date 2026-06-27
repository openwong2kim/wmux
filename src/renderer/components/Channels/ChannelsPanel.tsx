// ─── A2A Channels sidebar panel ─────────────────────────────────────────────
//
// Always-visible channels section in the sidebar, mounted from
// `Sidebar.tsx` between the workspace list and the `<PluginPanels />`
// block. Renders an `active` / `archived` grouped channel list with a
// `+ New channel` affordance and unread badges (U7 — plan §U7).
//
// State ownership:
//   - The panel is a thin orchestrator over `channelsSlice` — every
//     field (channels, members, active id, unread) is read from the
//     store via `useStore`. Channel creation round-trips through the
//     slice's `createChannelDaemon` thunk (U4, R4), which wraps the
//     `a2a.channel.create` RPC and applies the authoritative row on
//     success. On failure the thunk returns a structured
//     `ChannelError`; the panel logs and the modal stays open (so
//     the user can retry).
//
// Grouping:
//   - `active` channels are sorted by name (case-insensitive) and
//     shown open.
//   - `archived` channels are sorted by `archivedAt` descending and
//     shown inside a collapsible disclosure (collapsed by default —
//     archived rooms are read-only and rarely useful in the sidebar).
//
// Company decoupling:
//   - Channels are NOT gated on in-app Company mode. The daemon scopes
//     every channel to `DEFAULT_COMPANY_ID` until multi-company lands, and
//     the renderer mirrors that catalog (hydrated by useChannelsHydration)
//     regardless of `state.company`. When no in-app company exists, the
//     active workspace stands in as the creator identity so `+ New channel`
//     still works. `data-company-state` is a diagnostic attribute, not a
//     render gate.
//
// Empty state:
//   - When the channel catalog is empty, we render a friendly "no channels
//     yet" prompt with the same `+ New channel` action (whether or not an
//     in-app company exists).
//
// New-channel flow:
//   - Clicking `+ New channel` opens the inline `CreateChannelModal`
//     below.
//   - On submit, the panel calls `createChannelDaemon` with a
//     synthesized channel row as the input shape. The thunk awaits
//     the daemon's authoritative row and applies it through
//     `createChannelOptimistic` on success. On failure, the modal
//     stays open and the synthesized row is discarded.
//
// Plan ref: U4 (wire-path entry), U7 (UI surface), R20 (grouping),
// R23 (creation modal), R29 (channel scope to company).

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { Channel, ChannelVisibility } from '../../../shared/channels';
import {
  canonicalizeChannelName,
  isValidChannelName,
  CHANNEL_NAME_MAX,
  DEFAULT_COMPANY_ID,
} from '../../../shared/channels';
import type { Company } from '../../../company/types';
import { useStore } from '../../stores';
import ChannelItem from './ChannelItem';
import { IconPlus, IconChevron, IconChevronDir } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { tokenAttrs } from '../../themes';
import { useT } from '../../hooks/useT';

// ─── Grouping / aggregation helpers (pure, exported for unit tests) ──────────

/** Pure grouping helper. Sorted by name (active) or archivedAt
 *  descending (archived). */
export function groupChannels(channels: Channel[]): {
  active: Channel[];
  archived: Channel[];
} {
  const active: Channel[] = [];
  const archived: Channel[] = [];
  for (const c of channels) {
    if (c.status === 'archived') archived.push(c);
    else active.push(c);
  }
  active.sort((a, b) => a.name.localeCompare(b.name));
  archived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return { active, archived };
}

/** Aggregated unread count across every channel. Mirrors the slice's
 *  `channelUnread` map but summed here for the MiniSidebar's badge slot. */
export function sumUnread(
  unreadByChannel: Record<string, number>,
): number {
  let n = 0;
  for (const k of Object.keys(unreadByChannel)) {
    const v = unreadByChannel[k];
    if (typeof v === 'number' && v > 0) n += v;
  }
  return n;
}

// ─── Inline create-channel modal (no separate file — U7 scope) ────────────────

interface CreateChannelModalProps {
  onClose: () => void;
  onCreate: (params: {
    name: string;
    visibility: ChannelVisibility;
  }) => boolean | Promise<boolean>;
}

/** Side-effect-free: derive a `FieldState` from raw input. Lives at
 *  module scope so the test can call it without rendering anything. */
export function computeNameFieldState(raw: string): {
  raw: string;
  canonical: string;
  valid: boolean;
} {
  const canonical = canonicalizeChannelName(raw);
  return {
    raw,
    canonical,
    valid: isValidChannelName(canonical),
  };
}

function CreateChannelModal({
  onClose,
  onCreate,
}: CreateChannelModalProps): React.ReactElement {
  const [name, setName] = useState('');
  const [visibility] = useState<ChannelVisibility>('public');
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const field = computeNameFieldState(name);
  const showInlineError = submitAttempted && !field.valid;
  const errorMessage = !field.canonical
    ? 'Name is required.'
    : field.canonical.length > CHANNEL_NAME_MAX
      ? `Name is longer than ${CHANNEL_NAME_MAX} characters.`
      : 'Use lowercase letters, digits, and hyphens (must start with a letter or digit).';

  // Close on outside click — same delayed mousedown pattern as PresetPicker.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  // Escape dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitAttempted(true);
      if (!field.valid) return;
      // The panel-level `handleCreate` is async (it round-trips to
      // the daemon via `createChannelDaemon`); we await so the modal
      // stays open on failure and only closes on confirmed success.
      const ok = await onCreate({ name: field.canonical, visibility });
      if (ok) onClose();
    },
    [field.canonical, field.valid, onCreate, onClose, visibility],
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Create a new channel"
      data-create-channel-modal
      className="absolute right-2 top-7 z-50 w-64 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-3 px-3 text-xs font-mono"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[var(--text-muted)]">Channel name</span>
          <input
            type="text"
            autoFocus
            data-create-channel-name
            className={`bg-[var(--bg-base)] text-[var(--text-main)] text-[11px] px-2 py-1 rounded border outline-none ${FOCUS_RING} ${
              showInlineError
                ? 'border-[var(--accent-red)]'
                : 'border-[var(--bg-surface)]'
            }`}
            placeholder="release-notes"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={CHANNEL_NAME_MAX + 16}
            aria-invalid={showInlineError || undefined}
          />
          {field.raw && field.canonical !== field.raw.trim().toLowerCase() && (
            <span className="text-[var(--text-muted)] text-[10px]">
              Will be saved as <span className="text-[var(--text-main)]">#{field.canonical}</span>
            </span>
          )}
        </label>

        {showInlineError && (
          <div
            data-create-channel-error
            className="text-[var(--accent-red)] text-[10px]"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            className={`px-2 py-0.5 text-[11px] rounded text-[var(--text-subtle)] hover:bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-create-channel-submit
            className={`px-2 py-0.5 text-[11px] rounded bg-[var(--accent-green)] text-[var(--bg-base)] hover:opacity-90 transition-opacity ${FOCUS_RING}`}
            disabled={!field.valid && submitAttempted}
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Synthesized channel row for the optimistic local insert ─────────────────

/** Synthesize a channel row for the optimistic-local insert. The
 *  daemon will overwrite this with the authoritative row once the
 *  `channel.message` / `setChannels` refresh arrives; the synthesis
 *  here exists so the UI shows the new channel immediately on click
 *  rather than waiting for the round-trip.
 *
 *  U7's job is the UI shell — the transport wiring that produces the
 *  authoritative `Channel` is the caller's concern (MCP tool → slice
 *  → state mirror). When that wiring lands, the synthesis can be
 *  removed and the `onCreate` callback can pass through the daemon's
 *  resolved row directly. */
export function synthesizeChannel(params: {
  companyId: string;
  name: string;
  visibility: ChannelVisibility;
}): Channel {
  return {
    id: `ch-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    companyId: params.companyId,
    name: params.name,
    visibility: params.visibility,
    status: 'active',
    createdAt: Date.now(),
    createdBy: 'local-ui',
    nextSeq: 1,
  };
}

// ─── Main panel (pure view — props-driven, store-agnostic) ────────────────────

export interface ChannelsPanelViewProps {
  channels: Record<string, Channel>;
  channelUnread: Record<string, number>;
  channelMentions: Record<string, number>;
  activeChannelId: string | null;
  company: Company | null;
  /** Translates `channels.*` keys; defaults to identity if omitted so
   *  tests can pass a stub. */
  t?: (key: string) => string;
  onSelect: (channelId: string) => void;
  onCreate: (params: {
    name: string;
    visibility: ChannelVisibility;
  }) => boolean | Promise<boolean>;
  /** When provided, render a collapse affordance in the header. The dock host
   *  passes this to fold the whole dock away — it lives here (not in a separate
   *  dock header) so the "Channels" title shows ONCE, not twice. */
  onCollapse?: () => void;
  /** Direction the collapse chevron points — toward the screen edge the dock
   *  tucks into. Defaults to 'right' (sidebar-left / dock-right layout). */
  collapseDir?: 'left' | 'right';
}

export function ChannelsPanelView(props: ChannelsPanelViewProps): React.ReactElement {
  const {
    channels,
    channelUnread,
    channelMentions,
    activeChannelId,
    company,
    onSelect,
    onCreate,
    onCollapse,
    collapseDir = 'right',
  } = props;
  const t = props.t ?? ((k: string) => k);

  const [creatorOpen, setCreatorOpen] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const channelList = useMemo(() => Object.values(channels), [channels]);
  const { active, archived } = useMemo(
    () => groupChannels(channelList),
    [channelList],
  );
  const totalUnread = useMemo(
    () => sumUnread(channelUnread),
    [channelUnread],
  );

  // Channels are decoupled from in-app Company mode (the daemon scopes every
  // channel to DEFAULT_COMPANY_ID until multi-company lands). The panel always
  // renders so the daemon's authoritative catalog is visible and the `+`
  // affordance works without a company — `data-company-state` is now a
  // diagnostic attribute, not a render gate. Empty catalog falls through to the
  // friendly empty prompt below.
  return (
    <div
      data-channels-panel
      data-company-state={company ? 'present' : 'absent'}
      data-channel-count={channelList.length}
      data-total-unread={totalUnread}
      className="border-t border-[var(--bg-surface)] py-2"
      style={{ borderColor: 'var(--border-soft)' }}
    >
      {/* Header row — section title + actions (new-channel + collapse).
            The collapse button is merged here from the old ChannelDock header
            so the "Channels" title renders once, not twice. */}
      <div className="relative flex items-center justify-between px-4 pb-1">
        <span
          className="text-[10px] font-mono tracking-widest uppercase text-[var(--text-muted)]"
          {...tokenAttrs('textMuted', 'text')}
        >
          {t('channels.title') ?? 'Channels'}
          {totalUnread > 0 && (
            <span
              className="ml-1 text-[var(--accent-blue)]"
              data-channels-total-unread
              {...tokenAttrs('accent', 'text')}
            >
              ({totalUnread > 99 ? '99+' : totalUnread})
            </span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-subtle)] hover:text-[var(--accent-green)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
            onClick={() => setCreatorOpen((v) => !v)}
            title={t('channels.newChannelTooltip') || 'New channel'}
            aria-label={t('channels.newChannelTooltip') || 'New channel'}
            data-channels-new
            {...tokenAttrs('textSub', 'text')}
            {...tokenAttrs('success', 'accent')}
            data-derived="textSubtle"
          >
            <IconPlus size={11} />
          </button>
          {onCollapse && (
            <button
              type="button"
              className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
              onClick={onCollapse}
              title={t('channels.dockCollapse') || 'Collapse channels'}
              aria-label={t('channels.dockCollapse') || 'Collapse channels'}
              data-channel-dock-collapse
            >
              <IconChevronDir dir={collapseDir} />
            </button>
          )}
        </div>
        {creatorOpen && (
          <CreateChannelModal
            onClose={() => setCreatorOpen(false)}
            onCreate={onCreate}
          />
        )}
      </div>

      {/* Empty catalog prompt — friendly nudge, same `+ New channel`
            affordance lives in the header so the user has a way out. */}
      {channelList.length === 0 ? (
        <div
          className="px-4 py-1 text-[10px] font-mono text-[var(--text-muted)]"
          data-channels-empty
          {...tokenAttrs('textMuted', 'text')}
        >
          {t('channels.empty') || 'No channels yet — click + to create one.'}
        </div>
      ) : (
        <>
          {/* Active group — flat list, no disclosure. */}
          <div className="space-y-0.5" data-channels-active-group>
            {active.map((ch) => (
              <ChannelItem
                key={ch.id}
                channel={ch}
                isActive={activeChannelId === ch.id}
                unreadCount={channelUnread[ch.id] ?? 0}
                mentioned={(channelMentions[ch.id] ?? 0) > 0}
                onSelect={onSelect}
              />
            ))}
          </div>

          {/* Archived group — collapsible disclosure, collapsed by
                default. Sort is `archivedAt` descending (most recently
                archived first). */}
          {archived.length > 0 && (
            <div className="mt-1" data-channels-archived-group>
              <button
                type="button"
                className={`w-full flex items-center gap-1 px-4 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-subtle)] transition-colors ${FOCUS_RING}`}
                onClick={() => setArchivedExpanded((v) => !v)}
                aria-expanded={archivedExpanded}
                data-channels-archived-toggle
                {...tokenAttrs('textMuted', 'text')}
              >
                <span
                  className={`transition-transform ${archivedExpanded ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                >
                  <IconChevron size={9} />
                </span>
                <span>
                  {t('channels.archived') || 'Archived'} ({archived.length})
                </span>
              </button>
              {archivedExpanded && (
                <div className="space-y-0.5 opacity-60">
                  {archived.map((ch) => (
                    <ChannelItem
                      key={ch.id}
                      channel={ch}
                      isActive={activeChannelId === ch.id}
                      unreadCount={channelUnread[ch.id] ?? 0}
                      mentioned={(channelMentions[ch.id] ?? 0) > 0}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Container — wires the store to the view ─────────────────────────────────

export function ChannelsPanel(): React.ReactElement {
  const channels = useStore((s) => s.channels);
  const channelUnread = useStore((s) => s.channelUnread);
  const channelMentions = useStore((s) => s.channelMentions);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const company = useStore((s) => s.company);
  // Channels are decoupled from in-app Company mode: when no company is set,
  // the active workspace stands in as the creator identity so the `+` button
  // works without one (mirrors useChannelsHydration's identity resolution).
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveChannel = useStore((s) => s.setActiveChannel);
  const createChannelDaemon = useStore((s) => s.createChannelDaemon);
  // Dock host wiring: the panel's collapse affordance folds the whole dock
  // away (the panel is the dock's only host — the old separate dock header
  // was removed to drop the duplicate title). The chevron mirrors the dock's
  // edge so it points toward the screen edge it tucks into.
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const t = useT();

  const handleCreate = useCallback(
    async (params: { name: string; visibility: ChannelVisibility }) => {
      // companyId matches the daemon's DEFAULT_COMPANY_ID when no in-app
      // company exists, so the optimistic row's companyId agrees with the
      // daemon's authoritative row (the daemon ignores any client companyId
      // and stamps its own — keeping them equal avoids a flicker on refresh).
      const companyId = company?.id ?? DEFAULT_COMPANY_ID;
      // Sender identity: the CEO workspace when Company mode is active, else
      // the active workspace. The daemon pins `createdBy` to the verified
      // (renderer-supplied, process-boundary-trusted) workspace anyway; this
      // is the value it pins to. Bail only if there is no workspace at all.
      const selfWorkspaceId = company?.ceoWorkspaceId ?? activeWorkspaceId;
      if (!selfWorkspaceId) return false;
      // Synthesize the row the slice would use as the optimistic
      // insert. The `*Daemon` thunk will overwrite this with the
      // daemon's authoritative row on success — the synthesized row
      // is only used as the input shape so the thunk can call the
      // matching `*Optimistic` primitive with the right field set.
      const channel = synthesizeChannel({
        companyId,
        name: params.name,
        visibility: params.visibility,
      });
      const result = await createChannelDaemon({
        name: params.name,
        visibility: params.visibility,
        createdBy: {
          workspaceId: selfWorkspaceId,
          memberId: 'local-ui',
          memberName: 'local-ui',
        },
        channel,
      });
      if (!result.ok) {
        // U4 (R4) failure surfacing: log the structured error so the
        // developer can see the daemon's reason in the console. The
        // modal stays open (handleCreate returns false), so the user
        // can retry. The slice never throws on a failed mutation;
        // we branch on the structured `error.code` here so the U2
        // maintainer directive on PERSIST_FAILED is preserved (no
        // swallowing).
        console.warn(
          `[ChannelsPanel] createChannel failed: ${result.error.code}: ${result.error.message}`,
        );
      }
      return result.ok;
    },
    [company, createChannelDaemon],
  );

  return (
    <ChannelsPanelView
      channels={channels}
      channelUnread={channelUnread}
      channelMentions={channelMentions}
      activeChannelId={activeChannelId}
      company={company}
      onSelect={setActiveChannel}
      onCreate={handleCreate}
      onCollapse={() => setChannelDockVisible(false)}
      collapseDir={sidebarPosition !== 'right' ? 'right' : 'left'}
      t={t}
    />
  );
}

export default ChannelsPanel;