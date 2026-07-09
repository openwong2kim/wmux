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
import { HUMAN_WORKSPACE_ID, HUMAN_MEMBER_ID } from '../../../shared/channels';
import {
  canonicalizeChannelName,
  isValidChannelName,
  CHANNEL_NAME_MAX,
  DEFAULT_COMPANY_ID,
} from '../../../shared/channels';
import type { Company } from '../../../company/types';
import { useStore } from '../../stores';
import ChannelItem from './ChannelItem';
import { IconPlus, IconChevron, IconChevronDir, IconRefresh } from '../icons';
import { hydrateChannelsCatalog } from '../../hooks/useChannelsHydration';
import { FOCUS_RING } from '../focusRing';
import { tokenAttrs } from '../../themes';
import { useT } from '../../hooks/useT';

// ─── Grouping / aggregation helpers (pure, exported for unit tests) ──────────

/** Pure grouping helper. Sorted by name (active / discoverable) or
 *  archivedAt descending (archived).
 *
 *  `isMember` (optional) splits non-archived channels into "joined" (active)
 *  vs "joinable" (discoverable): a public channel the caller is NOT a member
 *  of goes to `discoverable` so the panel can surface a Join affordance
 *  instead of mixing it into the member list. A private channel the caller
 *  isn't in is omitted (it isn't readable, so we never leak it into a group).
 *  When `isMember` is omitted, every non-archived channel stays in `active`
 *  — the pre-discovery behaviour, so existing callers/tests are unaffected. */
export function groupChannels(
  channels: Channel[],
  isMember?: (channel: Channel) => boolean,
): {
  active: Channel[];
  archived: Channel[];
  discoverable: Channel[];
} {
  const active: Channel[] = [];
  const archived: Channel[] = [];
  const discoverable: Channel[] = [];
  for (const c of channels) {
    if (c.status === 'archived') {
      archived.push(c);
      continue;
    }
    if (isMember && !isMember(c)) {
      if (c.visibility === 'public') discoverable.push(c);
      // private non-member → omit (unreadable; never leak into a group)
      continue;
    }
    active.push(c);
  }
  active.sort((a, b) => a.name.localeCompare(b.name));
  archived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  discoverable.sort((a, b) => a.name.localeCompare(b.name));
  return { active, archived, discoverable };
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
  /** The "+" trigger button. The modal anchors to it as a viewport-fixed
   *  popover so the dock's `overflow-y-auto` wrapper can't clip it. */
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
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
  anchorRef,
}: CreateChannelModalProps): React.ReactElement {
  const [name, setName] = useState('');
  const [visibility] = useState<ChannelVisibility>('public');
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Viewport-fixed position anchored to the "+" button. `fixed` (not `absolute`)
  // is required: ChannelDock wraps the panel in an `overflow-y-auto` box, which
  // clips an absolutely-positioned child (the modal's right edge + Cancel/Create
  // buttons got cut off). Anchor + clamp keeps it on-screen for left/right docks.
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 28, right: 8 });
  useEffect(() => {
    const el = anchorRef?.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const MODAL_W = 256; // w-64
    let right = W - r.right;
    right = Math.min(right, W - (MODAL_W + 8)); // keep the left edge ≥ 8px on-screen
    right = Math.max(8, right);
    let top = r.bottom + 4;
    top = Math.min(top, H - 170); // keep the Cancel/Create buttons on-screen
    top = Math.max(8, top);
    setPos({ top: Math.round(top), right: Math.round(right) });
  }, [anchorRef]);

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

  const doSubmit = useCallback(async () => {
    setSubmitAttempted(true);
    setSubmitError(null);
    // In-flight guard: the create round-trips to the daemon; a second submit
    // (double-click / repeat Enter) before it resolves would create a duplicate.
    if (!field.valid || creating) return;
    setCreating(true);
    try {
      // The panel-level `handleCreate` is async (it round-trips to the daemon
      // via `createChannelDaemon`); we await so the modal stays open on failure
      // and only closes on confirmed success.
      const ok = await onCreate({ name: field.canonical, visibility });
      if (ok) {
        onClose();
      } else {
        // Don't fail silently — the daemon rejected it (most often the name is
        // already taken). Surface it so the user knows the click did something.
        setSubmitError('Could not create the channel — that name may already be taken.');
      }
    } finally {
      setCreating(false);
    }
  }, [field.canonical, field.valid, onCreate, onClose, visibility, creating]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void doSubmit();
    },
    [doSubmit],
  );

  // Enter-to-create. The native form submit doesn't reliably reach this modal
  // (the app's global capture-phase key handler + the focused pane), so submit
  // explicitly on Enter and stop the keystroke from leaking to the terminal.
  // `isComposing` guard: don't fire mid-Hangul/IME composition (Enter there
  // commits the composition, it is not a submit).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        void doSubmit();
      }
    },
    [doSubmit],
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Create a new channel"
      data-create-channel-modal
      className="fixed z-50 w-64 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-3 px-3 text-xs font-mono"
      style={{ top: pos.top, right: pos.right }}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[var(--text-muted)]">Channel name</span>
          <input
            type="text"
            autoFocus
            data-create-channel-name
            className={`bg-[var(--bg-base)] text-[var(--text-main)] text-caption px-2 py-1 rounded border outline-none ${FOCUS_RING} ${
              showInlineError
                ? 'border-[var(--accent-red)]'
                : 'border-[var(--bg-surface)]'
            }`}
            placeholder="release-notes"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            onKeyDown={handleKeyDown}
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

        {submitError && !showInlineError && (
          <div
            data-create-channel-submit-error
            className="text-[var(--accent-red)] text-[10px]"
            role="alert"
          >
            {submitError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            className={`px-2 py-0.5 text-caption rounded text-[var(--text-subtle)] hover:bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-create-channel-submit
            className={`px-2 py-0.5 text-caption rounded bg-[var(--accent-green)] text-[var(--bg-base)] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
            disabled={!field.valid || creating}
          >
            {creating ? 'Creating…' : 'Create'}
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
    createdBy: HUMAN_MEMBER_ID,
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
  /** Channel ids the current (self) workspace is a member of. When provided,
   *  the panel splits non-member public channels into a "Discover" group with
   *  a Join affordance. Omit (undefined) to keep the flat member-less list. */
  memberChannelIds?: Set<string>;
  /** Translates `channels.*` keys; defaults to identity if omitted so
   *  tests can pass a stub. */
  t?: (key: string) => string;
  onSelect: (channelId: string) => void;
  /** Join a discoverable (public, not-yet-joined) channel as the self
   *  workspace. Only wired when membership info is available. */
  onJoinDiscoverable?: (channelId: string) => void;
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
  /** When provided, render a refresh button that re-pulls the channel catalog +
   *  members from the daemon (manual re-sync for when a workspace/agent that
   *  came online isn't reflected yet). */
  onRefresh?: () => void;
  /** Ship review C1 — the attached daemon predates the channels migration this
   *  renderer requires (it survived the app upgrade). Renders a "restart wmux"
   *  banner; posting/joining may fail with NOT_A_MEMBER until the restart. */
  daemonStale?: boolean;
}

export function ChannelsPanelView(props: ChannelsPanelViewProps): React.ReactElement {
  const {
    channels,
    channelUnread,
    channelMentions,
    activeChannelId,
    company,
    memberChannelIds,
    onSelect,
    onCreate,
    onJoinDiscoverable,
    onCollapse,
    collapseDir = 'right',
    onRefresh,
    daemonStale = false,
  } = props;
  const t = props.t ?? ((k: string) => k);

  const [creatorOpen, setCreatorOpen] = useState(false);
  const newBtnRef = useRef<HTMLButtonElement | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [discoverExpanded, setDiscoverExpanded] = useState(false);

  const channelList = useMemo(() => Object.values(channels), [channels]);
  const isMember = useMemo(
    () =>
      memberChannelIds
        ? (ch: Channel): boolean => memberChannelIds.has(ch.id)
        : undefined,
    [memberChannelIds],
  );
  const { active, archived, discoverable } = useMemo(
    () => groupChannels(channelList, isMember),
    [channelList, isMember],
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
      {/* Ship review C1 — stale-daemon banner. The long-lived daemon survived
            the app upgrade without the channels migration this renderer needs;
            channels may look missing and posts may fail until it restarts.
            Informational only (no auto-kill: the daemon holds live sessions). */}
      {daemonStale && (
        <div
          data-channels-daemon-stale
          className="mx-3 mb-1.5 px-2.5 py-1.5 rounded text-[10px] font-mono leading-snug text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.7)]"
          style={{ border: '1px solid var(--border-soft)' }}
          {...tokenAttrs('textSub', 'text')}
        >
          <span aria-hidden="true">⚠ </span>
          {t('channels.daemonStaleBanner') ||
            'Channels were updated, but the background daemon is still on the old version. Quit wmux fully and start it again to finish.'}
        </div>
      )}

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
          {onRefresh && (
            <button
              type="button"
              className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-subtle)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
              onClick={onRefresh}
              title={t('channels.refreshTooltip') || 'Refresh channels'}
              aria-label={t('channels.refreshTooltip') || 'Refresh channels'}
              data-channels-refresh
              {...tokenAttrs('textSub', 'text')}
            >
              <IconRefresh size={11} />
            </button>
          )}
          <button
            ref={newBtnRef}
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
            anchorRef={newBtnRef}
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

          {/* Discover group — public channels the self workspace hasn't
                joined yet. Collapsible (like archived), each row previews on
                name-click and joins via the Join button. Only renders when
                membership info is available (onJoinDiscoverable wired). */}
          {discoverable.length > 0 && (
            <div className="mt-1" data-channels-discover-group>
              <button
                type="button"
                className={`w-full flex items-center gap-1 px-4 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-subtle)] transition-colors ${FOCUS_RING}`}
                onClick={() => setDiscoverExpanded((v) => !v)}
                aria-expanded={discoverExpanded}
                data-channels-discover-toggle
                {...tokenAttrs('textMuted', 'text')}
              >
                <span
                  className={`transition-transform ${discoverExpanded ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                >
                  <IconChevron size={9} />
                </span>
                <span>
                  {t('channels.discover') || 'Discover'} ({discoverable.length})
                </span>
              </button>
              {discoverExpanded && (
                <div className="space-y-0.5">
                  {discoverable.map((ch) => (
                    <div
                      key={ch.id}
                      className="flex items-center gap-1 px-4 py-0.5"
                      data-channels-discover-item
                      data-channel-id={ch.id}
                    >
                      <button
                        type="button"
                        className={`flex-1 min-w-0 text-left truncate text-caption font-mono text-[var(--text-subtle)] hover:text-[var(--text-main)] transition-colors ${FOCUS_RING}`}
                        onClick={() => onSelect(ch.id)}
                        title={`#${ch.name}`}
                      >
                        #{ch.name}
                      </button>
                      {onJoinDiscoverable && (
                        <button
                          type="button"
                          className={`shrink-0 px-1.5 py-0.5 text-[10px] rounded text-[var(--accent-green)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors ${FOCUS_RING}`}
                          onClick={() => onJoinDiscoverable(ch.id)}
                          data-channels-discover-join
                          aria-label={`${t('channels.join') || 'Join'} #${ch.name}`}
                          {...tokenAttrs('success', 'accent')}
                        >
                          {t('channels.join') || 'Join'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
  const channelsDaemonStale = useStore((s) => s.channelsDaemonStale);
  const company = useStore((s) => s.company);
  // P5: the human's creator identity is the reserved ws-human seat (see
  // selfWorkspaceId below), independent of which workspace is active.
  // A1: 이전 `workspaces` 통구독은 아래 handleJoinDiscoverable의 stale dep로만
  // 남아 있었고 실제로 참조되지 않았다 — 구독과 dep를 함께 제거(동작 불변).
  const channelMembers = useStore((s) => s.channelMembers);
  const setActiveChannel = useStore((s) => s.setActiveChannel);
  const createChannelDaemon = useStore((s) => s.createChannelDaemon);
  const joinChannelDaemon = useStore((s) => s.joinChannelDaemon);
  const pushToast = useStore((s) => s.pushToast);
  // Dock host wiring: the panel's collapse affordance folds the whole dock
  // away (the panel is the dock's only host — the old separate dock header
  // was removed to drop the duplicate title). The chevron mirrors the dock's
  // edge so it points toward the screen edge it tucks into.
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const t = useT();

  // P5 (unified human identity): the human's channel identity is the reserved
  // virtual workspace — membership, join, post, and "my channels" no longer
  // depend on which workspace is active.
  const selfWorkspaceId: string | null = HUMAN_WORKSPACE_ID;

  // Channel ids the self workspace is a member of — drives the joined vs
  // discoverable split in the view. O(channels) but the catalog is small.
  const memberChannelIds = useMemo<Set<string> | undefined>(() => {
    // Until identity resolves, return undefined (NOT an empty set): the view's
    // isMember then falls back to "every channel is joined" (the old flat list).
    // An empty set instead would misclassify every public channel as discoverable
    // and hide private ones entirely on the boot/no-workspace render, and
    // handleJoinDiscoverable bails in that same state — a broken Discover view
    // (CodeRabbit review).
    if (!selfWorkspaceId) return undefined;
    const ids = new Set<string>();
    for (const [cid, members] of Object.entries(channelMembers)) {
      if (members.some((m) => m.workspaceId === selfWorkspaceId)) ids.add(cid);
    }
    return ids;
  }, [channelMembers, selfWorkspaceId]);

  const handleJoinDiscoverable = useCallback(
    (channelId: string) => {
      if (!selfWorkspaceId) return;
      // P5: the unified human seat joins — the row is workspace-independent and
      // renders as the localized "Me"; no workspace label is involved anymore.
      const label = t('channels.me') || 'Me';
      const channelName = channels[channelId]?.name ?? channelId;
      void joinChannelDaemon(
        channelId,
        { workspaceId: selfWorkspaceId, memberId: HUMAN_MEMBER_ID, memberName: HUMAN_MEMBER_ID },
        selfWorkspaceId,
      ).then((result) => {
        if (result.ok) {
          pushToast({
            level: 'info',
            message: t('channels.joinedToast', { workspace: label, channel: channelName }),
          });
        } else if (result.error.message.includes('DUPLICATE')) {
          pushToast({
            level: 'info',
            message: t('channels.alreadyMemberToast', { workspace: label, channel: channelName }),
          });
        } else {
          pushToast({
            level: 'error',
            message: t('channels.joinFailedToast', { workspace: label }),
          });
        }
      });
    },
    [selfWorkspaceId, channels, joinChannelDaemon, pushToast, t],
  );

  const handleCreate = useCallback(
    async (params: { name: string; visibility: ChannelVisibility }) => {
      // companyId matches the daemon's DEFAULT_COMPANY_ID when no in-app
      // company exists, so the optimistic row's companyId agrees with the
      // daemon's authoritative row (the daemon ignores any client companyId
      // and stamps its own — keeping them equal avoids a flicker on refresh).
      const companyId = company?.id ?? DEFAULT_COMPANY_ID;
      // P5: the creator identity is the reserved ws-human seat; the daemon
      // re-pins `createdBy` to the verified workspace anyway.
      const selfWorkspaceId = HUMAN_WORKSPACE_ID;
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
          memberId: HUMAN_MEMBER_ID,
          memberName: HUMAN_MEMBER_ID,
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

  // Manual re-sync: re-pull the channel catalog + per-channel members from the
  // daemon. For when something that came online (a workspace, an agent that
  // joined) isn't reflected yet — the live event stream can miss/lag, so give
  // the user an explicit refresh instead of only an automatic one.
  const handleRefresh = useCallback(() => {
    const bridge = useStore.getState().channelsRpc();
    if (!bridge) return;
    const s = useStore.getState();
    const wsId = HUMAN_WORKSPACE_ID;
    void hydrateChannelsCatalog({
      rpc: bridge.rpc,
      workspaceId: wsId,
      setChannels: s.setChannels,
    }).then(() => {
      pushToast({ level: 'info', message: t('channels.refreshedToast') || 'Channels refreshed.' });
    });
  }, [pushToast, t]);

  return (
    <ChannelsPanelView
      channels={channels}
      channelUnread={channelUnread}
      channelMentions={channelMentions}
      activeChannelId={activeChannelId}
      company={company}
      memberChannelIds={memberChannelIds}
      onSelect={setActiveChannel}
      onCreate={handleCreate}
      onJoinDiscoverable={handleJoinDiscoverable}
      onCollapse={() => setChannelDockVisible(false)}
      collapseDir={sidebarPosition !== 'right' ? 'right' : 'left'}
      onRefresh={handleRefresh}
      daemonStale={channelsDaemonStale}
      t={t}
    />
  );
}

export default ChannelsPanel;