import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconComputer, IconPlus } from '../icons';
import { PopoverSection } from '../ui/Popover';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { pairReasonMessage } from '../Sidebar/AttachRemoteModal';
import { maskPairInput, parseRemotePairInput, type RemotePairInputError } from '../../../shared/remotePairInput';
import type { RemoteHostPublic, RemoteHostStatus } from '../../../shared/remoteHosts';

/**
 * The Remote hub's "Other computers": this machine → the hosts it has paired
 * with, each with a status (dot + text), and one field to pair a new one.
 *
 * Rows come from the host list immediately; statuses fill in when the probe
 * answers ("Checking…" until then), so an offline host never holds the list
 * up. Clicking a host hands it to the attach dialog, which lists and attaches
 * its workspaces; a host that needs re-pairing opens the field instead, and
 * the new credential replaces the rejected one in place.
 */

type T = ReturnType<typeof useT>;

/** Status → dot colour. Connected is "alive" (warm); a refused credential is
 *  the warning hue; reachable is success green; unreachable stays muted. */
const STATUS_DOT: Record<RemoteHostStatus, string> = {
  connected: 'bg-[var(--accent)]',
  reachable: 'bg-[var(--accent-green)]',
  unreachable: 'bg-[var(--text-muted)]',
  'needs-repair': 'bg-[var(--accent-yellow)]',
  insecure: 'bg-[var(--text-muted)]',
};

const STATUS_LABEL: Record<RemoteHostStatus, string> = {
  connected: 'remote.hubStatusConnected',
  reachable: 'remote.hubStatusReachable',
  unreachable: 'remote.hubStatusUnreachable',
  'needs-repair': 'remote.hubStatusNeedsRepair',
  insecure: 'remote.hubStatusInsecure',
};

export const INPUT_ERROR: Record<RemotePairInputError, string> = {
  empty: 'remote.hubInputEmpty',
  'not-a-link': 'remote.hubInputNotALink',
  'missing-code': 'remote.hubInputMissingCode',
  'bad-code': 'remote.hubInputBadCode',
  insecure: 'remote.hubInputInsecure',
  userinfo: 'remote.hubInputUserinfo',
};

export function hostStatusText(t: T, status: RemoteHostStatus | undefined): string {
  return status ? t(STATUS_LABEL[status]) : t('remote.hubStatusChecking');
}

export interface OtherComputersSectionProps {
  /** Hand a host to the attach dialog to list and attach its workspaces. */
  onOpenHost: (hostId: string) => void;
}

const OtherComputersSection = forwardRef<HTMLDivElement, OtherComputersSectionProps>(function OtherComputersSection(
  { onOpenHost },
  ref,
) {
  const t = useT();
  const setRemoteHostAuthRejected = useStore((s) => s.setRemoteHostAuthRejected);
  const [hosts, setHosts] = useState<RemoteHostPublic[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, RemoteHostStatus>>({});
  const [pairOpen, setPairOpen] = useState(false);
  /** The host whose rejected credential a successful pairing replaces. */
  const [repairTarget, setRepairTarget] = useState<RemoteHostPublic | null>(null);
  /**
   * The real field value. What the field SHOWS is `maskPairInput(input)`
   * while it came from a paste — the address in the clear, the code or token
   * as dots — and the typed text as-is otherwise (the person typing it has
   * it in front of them anyway).
   */
  const [input, setInput] = useState('');
  const [masked, setMasked] = useState(false);
  /** Where the last pairing went, said in plain text once it succeeded. */
  const [pairedWith, setPairedWith] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refreshStatuses = useCallback(async (force = false) => {
    const remote = window.electronAPI?.remote;
    if (!remote?.hostsStatus) return;
    try {
      const next = await remote.hostsStatus(force);
      if (mounted.current) setStatuses(next);
    } catch {
      /* statuses stay "Checking…"; the rows are still usable */
    }
  }, []);

  const refreshHosts = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    try {
      const list = await remote.hostsList();
      if (mounted.current) setHosts(list);
    } catch {
      if (mounted.current) setHosts((prev) => prev ?? []);
    }
  }, []);

  // The hub opened: list first (instant, local), then ask how each host is.
  useEffect(() => {
    void refreshHosts().then(() => refreshStatuses());
  }, [refreshHosts, refreshStatuses]);

  useEffect(() => {
    if (pairOpen) inputRef.current?.focus();
  }, [pairOpen, repairTarget]);

  const openPair = useCallback((target: RemoteHostPublic | null) => {
    setRepairTarget(target);
    setInput('');
    setMasked(false);
    setError(null);
    setPairedWith(null);
    setPairOpen(true);
  }, []);

  const closePair = useCallback(() => {
    setPairOpen(false);
    setRepairTarget(null);
    setInput('');
    setMasked(false);
    setError(null);
  }, []);

  const parsed = input.trim() ? parseRemotePairInput(input) : null;
  const destination = parsed && parsed.kind !== 'error' ? parsed.origin : null;
  /** A re-pair renews one host; a link for any other address is refused. */
  const originMismatch = !!(repairTarget && destination && destination !== repairTarget.origin);

  /**
   * Read the clipboard ONLY here, on this click. Never on open, never on
   * focus, never persisted and never logged: what the clipboard holds is the
   * operator's, and a pairing link in it is a credential.
   */
  const handlePaste = useCallback(async () => {
    try {
      const text = await window.clipboardAPI?.readText();
      if (typeof text === 'string' && mounted.current) {
        setInput(text.trim());
        setMasked(true);
        setError(null);
      }
    } catch {
      /* clipboard busy — the field still takes a normal paste */
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    const remote = window.electronAPI?.remote;
    if (!remote || pairing) return;
    const parsed = parseRemotePairInput(input);
    if (parsed.kind === 'error') {
      setError(t(INPUT_ERROR[parsed.reason]));
      return;
    }
    // Never rebind a host to another machine: a re-pair must come from the
    // same address the host was paired at.
    if (repairTarget && parsed.origin !== repairTarget.origin) {
      setError(t('remote.hubRepairOriginMismatch', { origin: parsed.origin, name: repairTarget.label }));
      return;
    }
    // A token URL registers a NEW host; it cannot stand in for a re-pair,
    // which replaces one host's credential in place.
    if (parsed.kind === 'token' && repairTarget) {
      setError(t('remote.hubRepairNeedsLink'));
      return;
    }
    setPairing(true);
    setError(null);
    const replacing = repairTarget;
    try {
      if (parsed.kind === 'pair') {
        const res = await remote.hostsPair(
          parsed.origin,
          parsed.code,
          undefined,
          ...(replacing ? [replacing.id] : []),
        );
        if (!mounted.current) return;
        if (!res.ok) {
          setError(pairReasonMessage(t, res.reason, res.attemptsLeft));
          return;
        }
        if (replacing) setRemoteHostAuthRejected(res.host.id, false);
      } else {
        const res = await remote.hostsAdd(parsed.url);
        if (!mounted.current) return;
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      closePair();
      setPairedWith(parsed.origin);
      // The form is free at once; statuses fill in behind it.
      void refreshHosts().then(() => refreshStatuses(true));
    } catch {
      if (mounted.current) setError(t('remote.pairFailed'));
    } finally {
      if (mounted.current) setPairing(false);
    }
  }, [input, pairing, repairTarget, t, setRemoteHostAuthRejected, closePair, refreshHosts, refreshStatuses]);

  const insecureHost = (status: RemoteHostStatus | undefined) => status === 'insecure';

  return (
    <PopoverSection
      title={t('remote.hubOthers')}
      data-testid="remote-hub-others"
      action={
        <button
          type="button"
          onClick={() => (pairOpen && !repairTarget ? closePair() : openPair(null))}
          aria-label={t('remote.hubPairNew')}
          title={t('remote.hubPairNew')}
          aria-expanded={pairOpen && !repairTarget}
          className={`inline-flex h-5 w-5 items-center justify-center rounded-[6px] text-[var(--text-sub)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        >
          <IconPlus size={12} />
        </button>
      }
    >
      <div ref={ref} className="flex flex-col gap-2">
        {hosts === null ? null : hosts.length === 0 && !pairOpen ? (
          <p className="ui-note">{t('remote.hubEmpty')}</p>
        ) : hosts.length > 0 ? (
          <div className="ui-group" role="list">
            {hosts.map((host) => {
              const status = statuses[host.id];
              const needsRepair = status === 'needs-repair';
              return (
                <div key={host.id} role="listitem" className="ui-row flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="remote-hub-host"
                    data-status={status ?? 'checking'}
                    // A host on plain http is not opened: listing its
                    // workspaces would send this computer's token in the clear.
                    disabled={insecureHost(status)}
                    onClick={() => (needsRepair ? openPair(host) : onOpenHost(host.id))}
                    title={
                      insecureHost(status)
                        ? t('remote.hubInsecureHint')
                        : needsRepair
                          ? t('remote.hubPairAgain')
                          : t('remote.hubOpenHost', { name: host.label })
                    }
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-[6px] text-left ${FOCUS_RING}`}
                  >
                    <span className="shrink-0 text-[var(--text-sub)]" aria-hidden="true">
                      <IconComputer size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="ui-row-title block truncate">{host.label}</span>
                      <span className="ui-row-detail flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={`h-[6px] w-[6px] shrink-0 rounded-full ${
                            status ? STATUS_DOT[status] : 'border border-[var(--text-muted)]'
                          }`}
                        />
                        <span
                          data-testid="remote-hub-host-status"
                          className={needsRepair ? 'text-[var(--accent-yellow)]' : undefined}
                        >
                          {hostStatusText(t, status)}
                        </span>
                      </span>
                    </span>
                  </button>
                  {needsRepair ? (
                    <Button size="sm" onClick={() => openPair(host)} className="shrink-0">
                      {t('remote.hubPairAgain')}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {pairOpen ? (
          <div className="flex flex-col gap-2" data-testid="remote-hub-pair-form">
            <p className="ui-note">
              {repairTarget ? t('remote.hubRepairHint', { name: repairTarget.label }) : t('remote.hubPairHint')}
            </p>
            {/* Plain text, so the address is readable; a pasted secret (the
                code, a `wmux web` token) shows as dots. Editing a masked value
                starts over rather than splicing into text that is not shown. */}
            <Input
              ref={inputRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={masked ? maskPairInput(input) : input}
              onPaste={(e) => {
                const text = e.clipboardData?.getData('text') ?? '';
                if (!text) return;
                e.preventDefault();
                setInput(text.trim());
                setMasked(true);
                setError(null);
              }}
              onChange={(e) => {
                const next = e.target.value;
                if (masked) {
                  setInput(next.includes('•') ? '' : next);
                  setMasked(false);
                } else {
                  setInput(next);
                }
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && input.trim() && !pairing) void handleSubmit();
              }}
              placeholder={t('remote.hubPairPlaceholder')}
              aria-label={t('remote.hubPairPlaceholder')}
              className="w-full text-[13px]"
            />
            {destination ? (
              <p className="ui-note" data-testid="remote-hub-destination">
                {t('remote.hubDestination', { origin: destination })}
              </p>
            ) : null}
            {originMismatch && repairTarget && destination ? (
              <p className="ui-row-error" role="alert" data-testid="remote-hub-origin-mismatch">
                {t('remote.hubRepairOriginMismatch', { origin: destination, name: repairTarget.label })}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void handlePaste()} disabled={pairing}>
                {t('remote.hubPasteLink')}
              </Button>
              <Button size="sm" onClick={() => void handleSubmit()} disabled={pairing || !input.trim() || originMismatch}>
                {pairing ? t('remote.hubPairing') : t('remote.hubPair')}
              </Button>
              <Button variant="ghost" size="sm" onClick={closePair} disabled={pairing} className="ml-auto">
                {t('remote.hubCancel')}
              </Button>
            </div>
            {error && !originMismatch ? (
              <p className="ui-row-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
        {!pairOpen && pairedWith ? (
          <p className="ui-note" data-testid="remote-hub-paired-with">
            {t('remote.hubPairedWith', { origin: pairedWith })}
          </p>
        ) : null}
      </div>
    </PopoverSection>
  );
});

export default OtherComputersSection;
