// Pane actions menu → "Browser protection…" (src/shared/browserPolicy.ts).
//
// The operator's editor for one pane's site policy. Main owns the store and
// re-validates every write; this dialog only reads the pane's policy, lets the
// operator edit it, and writes it back naming the epoch it read. A write that
// lost a race (another window, a profile rebind) is refused by main as stale:
// the dialog then reloads what is there now instead of overwriting it.
//
// A pane that was rebound to another profile or moved to another workspace
// stays protected with every site refused until the operator confirms the
// list again — the notice says so, and Save is that confirmation.
//
// Recently blocked (#2063): the hosts the pane's proxy refused since its
// Chrome started or the policy last changed, each with an Allow. Allow is an
// ordinary write through the same `set` path, naming the epoch it read: it
// adds that one host to the STORED allow list (unsaved edits stay unsaved,
// the textarea gains the host too) and, being a policy change, empties the
// list on main.

import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Field, { useFieldWiring } from '../ui/Field';
import Switch from '../ui/Switch';
import SegmentedControl from '../ui/SegmentedControl';
import { IconLock } from '../icons';
import { allowableBlockedHosts, paneProtection, type AllowableBlockedHost } from './usePaneBrowserPolicyMenu';
import type { BlockedHost, PaneConsentGrants } from '../../../shared/browserPolicy';
import { parseHostRule, type HostPolicy, type HostPolicyMode } from '../../../shared/browserHostPolicy';

/** One host rule per line: trimmed, empty lines dropped. */
export function hostLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const isValidRule = (rule: string): boolean => !('error' in parseHostRule(rule));

/** The rules main would refuse, with their 1-based line in the textarea. */
export function invalidHostLines(text: string): Array<{ line: number; rule: string }> {
  return text.split(/\r?\n/)
    .map((raw, i) => ({ line: i + 1, rule: raw.trim() }))
    .filter(({ rule }) => rule.length > 0 && !isValidRule(rule));
}

/** Only the valid rules — for a list the operator cannot see right now. */
function validHostLines(text: string): string[] {
  return hostLines(text).filter(isValidRule);
}

interface Loaded {
  epoch: number;
  currentProfile: string | undefined;
  /** A write is needed even to leave protection off: a stored entry exists,
   *  or the pane is refused without one (its panes stay refused until written). */
  mustWrite: boolean;
  /** Refused, and its stored policy is gone (unreadable or lost file). */
  lost: boolean;
  /** Protected, but rebound / moved / pending: every host refused until saved. */
  needsConfirm: boolean;
  /** The pane's Chrome runs protected now (a change restarts it). */
  running: boolean;
  /** The stored site list, while it is the one the pane runs under
   *  (protected and confirmed) — what an Allow adds to. */
  stored: HostPolicy | null;
}

/** The textarea text with `rule` on a line of its own, unless it has it. */
export function withHostLine(text: string, rule: string): string {
  if (hostLines(text).includes(rule)) return text;
  const kept = text.replace(/\s+$/, '');
  return kept ? `${kept}\n${rule}` : rule;
}

function HostList({
  value,
  onChange,
  invalid,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid: Array<{ line: number; rule: string }>;
  testId: string;
}) {
  const t = useT();
  const errorsId = useId();
  const wiring = useFieldWiring(undefined, invalid.length > 0 ? errorsId : undefined);
  return (
    <div className="flex flex-col gap-1 w-full">
      <textarea
        id={wiring.id}
        aria-describedby={wiring['aria-describedby']}
        aria-invalid={invalid.length > 0 ? true : undefined}
        className="ui-input resize-y font-mono w-full"
        style={{ fontSize: 12, padding: '8px 10px' }}
        rows={4}
        spellCheck={false}
        placeholder="example.com"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
      {invalid.length > 0 && (
        <ul id={errorsId} className="text-[11px] leading-4 text-[var(--accent-red)]" data-testid={`${testId}-errors`}>
          {invalid.map(({ line, rule }) => (
            <li key={line}>{t('pane.browserPolicyInvalidLine', { line, rule })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface BrowserPolicyDialogProps {
  workspaceId: string;
  paneId: string;
  onClose: () => void;
  /** After a successful write, with the protection it now has. */
  onSaved?: (isProtected: boolean) => void;
}

export default function BrowserPolicyDialog({ workspaceId, paneId, onClose, onSaved }: BrowserPolicyDialogProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [isProtected, setIsProtected] = useState(false);
  const [mode, setMode] = useState<HostPolicyMode>('off');
  const [allowText, setAllowText] = useState('');
  const [blockText, setBlockText] = useState('');
  const [grants, setGrants] = useState<PaneConsentGrants>({});
  const [blocked, setBlocked] = useState<BlockedHost[]>([]);
  const [busy, setBusy] = useState(false);

  const toast = useCallback((level: 'info' | 'error', message: string) => {
    useStore.getState().pushToast({ level, message });
  }, []);

  // What the pane's proxy refused recently. Best effort: an older main (or a
  // failed read) just shows no list.
  const loadBlocked = useCallback(async () => {
    const api = window.electronAPI?.browser?.policy;
    try {
      const res = api?.blocked ? await api.blocked(workspaceId, paneId) : undefined;
      setBlocked(res?.ok ? res.hosts ?? [] : []);
    } catch {
      setBlocked([]);
    }
  }, [workspaceId, paneId]);

  const load = useCallback(async (): Promise<boolean> => {
    const api = window.electronAPI?.browser?.policy;
    try {
      const res = api ? await api.get(workspaceId, paneId) : undefined;
      if (!res?.ok) {
        toast('error', res?.error || t('pane.browserPolicyLoadFailed'));
        return false;
      }
      const epoch = res.epoch ?? 0;
      const entry = res.policy ?? undefined;
      const protection = paneProtection(res, workspaceId);
      const refused = protection.kind === 'refused';
      const lost = refused && !entry?.protected;
      setLoaded({
        epoch,
        currentProfile: res.currentProfile,
        mustWrite: !!entry || lost,
        lost,
        needsConfirm: refused && !!entry?.protected,
        running: protection.kind !== 'off',
        stored: protection.kind === 'protected' && entry?.hosts
          ? { ...entry.hosts, allow: [...entry.hosts.allow], block: [...entry.hosts.block] }
          : null,
      });
      setIsProtected(!!entry?.protected);
      setMode(entry?.hosts.mode ?? 'off');
      setAllowText((entry?.hosts.allow ?? []).join('\n'));
      setBlockText((entry?.hosts.block ?? []).join('\n'));
      setGrants(entry?.grants ?? {});
      return true;
    } catch {
      toast('error', t('pane.browserPolicyLoadFailed'));
      return false;
    }
  }, [workspaceId, paneId, toast, t]);

  useEffect(() => {
    void load().then((ok) => {
      if (!ok) onClose();
      else void loadBlocked();
    });
    // Mount only: the dialog edits one pane.
  }, []);

  // Only what is on screen is validated; a hidden list is sent without its
  // invalid lines, so an edit the operator can no longer see never blocks Save.
  const allowShown = isProtected && mode === 'allowlist';
  const allowInvalid = invalidHostLines(allowText);
  const blockInvalid = invalidHostLines(blockText);
  const valid = (!allowShown || allowInvalid.length === 0) && (!isProtected || blockInvalid.length === 0);
  const canSave = !!loaded && !!loaded.currentProfile && !busy && valid;

  const save = useCallback(async () => {
    const api = window.electronAPI?.browser?.policy;
    if (!api || !loaded?.currentProfile) return;
    // Never protected and staying off: nothing to write, the pane stays legacy.
    if (!isProtected && !loaded.mustWrite) { onClose(); return; }
    setBusy(true);
    try {
      const res = await api.set({
        workspaceId,
        paneId,
        profileId: loaded.currentProfile,
        protected: isProtected,
        hosts: {
          mode,
          allow: allowShown ? hostLines(allowText) : validHostLines(allowText),
          block: isProtected ? hostLines(blockText) : validHostLines(blockText),
        },
        expectedEpoch: loaded.epoch,
      });
      if (res.ok) {
        onSaved?.(isProtected);
        onClose();
        return;
      }
      // Lost the epoch race (another write, a profile rebind): show what is there now.
      if (res.code === 'stale') {
        toast('info', t('pane.browserPolicyStale'));
        await load();
        return;
      }
      toast('error', res.error || t('pane.browserPolicySaveFailed'));
    } catch {
      toast('error', t('pane.browserPolicySaveFailed'));
    } finally {
      setBusy(false);
    }
  }, [loaded, isProtected, mode, allowShown, allowText, blockText, workspaceId, paneId, onClose, onSaved, load, toast, t]);

  const emptyAllowlist = mode === 'allowlist' && hostLines(allowText).length === 0;

  // Standing consent ("Always on this pane"), revocable one at a time. Revoking
  // bumps the epoch; the editor keeps its unsaved edits and adopts the new one.
  const revoke = useCallback(async (next: PaneConsentGrants) => {
    const api = window.electronAPI?.browser?.policy;
    if (!api?.grants || !loaded?.currentProfile) return;
    setBusy(true);
    try {
      const res = await api.grants({
        workspaceId,
        paneId,
        profileId: loaded.currentProfile,
        grants: next,
        expectedEpoch: loaded.epoch,
      });
      if (res.ok && typeof res.epoch === 'number') {
        const epoch = res.epoch;
        setLoaded((l) => (l ? { ...l, epoch } : l));
        setGrants(next);
        return;
      }
      if (res.code === 'stale') {
        toast('info', t('pane.browserPolicyStale'));
        await load();
        return;
      }
      toast('error', res.error || t('pane.browserPolicyRevokeFailed'));
    } catch {
      toast('error', t('pane.browserPolicyRevokeFailed'));
    } finally {
      setBusy(false);
    }
  }, [loaded, workspaceId, paneId, load, toast, t]);
  // Allow one recently blocked host: the stored policy plus that host, written
  // now with the epoch the dialog read. The editor's unsaved edits are kept
  // (and the host joins the textarea, so a later Save keeps it).
  const allowHost = useCallback(async (row: AllowableBlockedHost) => {
    const api = window.electronAPI?.browser?.policy;
    const stored = loaded?.stored;
    if (!api || !loaded?.currentProfile || !stored) return;
    setBusy(true);
    try {
      const res = await api.set({
        workspaceId,
        paneId,
        profileId: loaded.currentProfile,
        protected: true,
        hosts: { mode: stored.mode, allow: row.nextAllow, block: stored.block },
        expectedEpoch: loaded.epoch,
      });
      if (res.ok && typeof res.epoch === 'number') {
        const epoch = res.epoch;
        setLoaded((l) => (l ? { ...l, epoch, stored: { ...stored, allow: row.nextAllow } } : l));
        setAllowText((text) => withHostLine(text, row.rule));
        onSaved?.(true);
        // A policy change empties main's list; show what is there now.
        await loadBlocked();
        return;
      }
      if (res.code === 'stale') {
        toast('info', t('pane.browserPolicyStale'));
        if (await load()) await loadBlocked();
        return;
      }
      toast('error', res.error || t('pane.browserPolicySaveFailed'));
    } catch {
      toast('error', t('pane.browserPolicySaveFailed'));
    } finally {
      setBusy(false);
    }
  }, [loaded, workspaceId, paneId, onSaved, load, loadBlocked, toast, t]);
  // Offered only while the pane runs the stored "Only these sites" list and the
  // editor still shows that mode: on a pane awaiting confirmation every host is
  // refused, and an Allow there would quietly stand in for the confirming Save.
  const blockedRows = loaded?.stored && !loaded.needsConfirm && isProtected && mode === 'allowlist'
    ? allowableBlockedHosts(loaded.stored, blocked)
    : [];

  const grantRows: Array<{ key: string; label: string; next: PaneConsentGrants }> = [
    ...(grants.evaluate ? [{ key: 'evaluate', label: t('pane.browserPolicyGrantEvaluate'), next: { ...grants, evaluate: false } }] : []),
    ...(grants.download ? [{ key: 'download', label: t('pane.browserPolicyGrantDownload'), next: { ...grants, download: false } }] : []),
    ...(grants.sensitiveHosts ?? []).map((host) => ({
      key: `sensitive:${host}`,
      label: t('pane.browserPolicyGrantSensitive', { host }),
      next: { ...grants, sensitiveHosts: (grants.sensitiveHosts ?? []).filter((h) => h !== host) },
    })),
  ];

  // Portalled: a pane root is its own stacking context (Pane.tsx `isolate`),
  // so a dialog left inside it would sit under the panes painted after it.
  return createPortal(
    <Dialog onClose={onClose} width={460} data-testid="browser-policy-dialog">
      <DialogHeader title={t('pane.browserPolicyTitle')} description={t('pane.browserPolicyDescription')} />
      {/* Fields keep their height so a long body scrolls instead of the
          fields shrinking over one another (.ui-dialog-body only pins a
          direct .ui-group; these groups sit inside a Field). */}
      <DialogBody className="flex flex-col gap-3 [&>*]:shrink-0">
        {loaded?.needsConfirm && (
          <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3" data-testid="browser-policy-rebound">
            <span className="shrink-0 mt-0.5 text-[var(--text-muted)]" aria-hidden="true"><IconLock size={12} /></span>
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] text-[var(--text-main)]">{t('pane.browserPolicyRebound')}</span>
              <span className="text-[11px] text-[var(--text-sub)]">{t('pane.browserPolicyReboundDetail')}</span>
            </div>
          </div>
        )}
        {loaded?.lost && (
          <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3" data-testid="browser-policy-unreadable">
            <span className="shrink-0 mt-0.5 text-[var(--text-muted)]" aria-hidden="true"><IconLock size={12} /></span>
            <span className="text-[13px] text-[var(--text-main)]">{t('pane.browserPolicyUnreadable')}</span>
          </div>
        )}
        <Field
          label={t('pane.browserPolicyProtect')}
          description={t(isProtected
            ? 'pane.browserPolicyProtectDescOn'
            : loaded?.lost ? 'pane.browserPolicyProtectDescRefused' : 'pane.browserPolicyProtectDesc')}
        >
          <Switch
            checked={isProtected}
            onCheckedChange={setIsProtected}
            disabled={!loaded}
            data-testid="browser-policy-protect"
          />
        </Field>
        {isProtected && (
          <>
            <Field
              label={t('pane.browserPolicyMode')}
              description={mode === 'allowlist' ? t('pane.browserPolicyModeOnlyDesc') : t('pane.browserPolicyModeAnyDesc')}
              layout="stacked"
            >
              <SegmentedControl<HostPolicyMode>
                value={mode}
                options={[
                  { value: 'off', label: t('pane.browserPolicyModeAny') },
                  { value: 'allowlist', label: t('pane.browserPolicyModeOnly') },
                ]}
                onValueChange={setMode}
                data-testid="browser-policy-mode"
              />
            </Field>
            {mode === 'allowlist' && (
              <Field label={t('pane.browserPolicyAllowed')} description={t('pane.browserPolicyHostsHint')} layout="stacked">
                <HostList value={allowText} onChange={setAllowText} invalid={allowInvalid} testId="browser-policy-allow" />
              </Field>
            )}
            {emptyAllowlist && (
              <p className="text-[11px] leading-4 text-[var(--text-sub)]" data-testid="browser-policy-empty-allowlist">
                {t('pane.browserPolicyEmptyAllowlist')}
              </p>
            )}
            {blockedRows.length > 0 && (
              <Field
                label={t('pane.browserPolicyRecentlyBlocked')}
                description={t('pane.browserPolicyRecentlyBlockedDesc')}
                layout="stacked"
              >
                {/* Up to 20 hosts, Chrome's own background hosts among them:
                    the list scrolls on its own so the fields below stay near. */}
                <div className="ui-group w-full max-h-[240px] overflow-y-auto" data-testid="browser-policy-recently-blocked">
                  {blockedRows.map((row) => (
                    <div key={row.rule} className="ui-row" data-blocked-host={row.rule}>
                      <div className="ui-row-text">
                        <p className="ui-row-title font-mono truncate" title={row.rule}>{row.rule}</p>
                        <p className="ui-row-detail tabular-nums">
                          {t('pane.browserPolicyRecentlyBlockedCount', { count: row.count })}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || !loaded?.currentProfile}
                        onClick={() => { void allowHost(row); }}
                        aria-label={t('pane.browserPolicyAllowHost', { host: row.rule })}
                        data-testid={`browser-policy-allow-host-${row.rule}`}
                      >
                        {t('pane.browserPolicyAllow')}
                      </Button>
                    </div>
                  ))}
                </div>
              </Field>
            )}
            <Field label={t('pane.browserPolicyBlocked')} description={t('pane.browserPolicyBlockedDesc')} layout="stacked">
              <HostList value={blockText} onChange={setBlockText} invalid={blockInvalid} testId="browser-policy-block" />
            </Field>
            {grantRows.length > 0 && !loaded?.needsConfirm && (
              <Field label={t('pane.browserPolicyGrants')} description={t('pane.browserPolicyGrantsDesc')} layout="stacked">
                <div className="ui-group w-full" data-testid="browser-policy-grants">
                  {grantRows.map((row) => (
                    <div key={row.key} className="ui-row" data-grant={row.key}>
                      <div className="ui-row-text">
                        <p className="ui-row-title">{row.label}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => { void revoke(row.next); }}
                        data-testid={`browser-policy-revoke-${row.key}`}
                      >
                        {t('pane.browserPolicyRevoke')}
                      </Button>
                    </div>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}
        {loaded && isProtected !== loaded.running && (
          <p className="text-[11px] leading-4 text-[var(--text-sub)]" data-testid="browser-policy-restart">
            {t('pane.browserPolicyRestart')}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant={canSave ? 'primary' : 'secondary'}
          disabled={!canSave}
          onClick={() => { void save(); }}
          data-testid="browser-policy-save"
        >
          {t('pane.browserPolicySave')}
        </Button>
      </DialogFooter>
    </Dialog>,
    document.body,
  );
}
