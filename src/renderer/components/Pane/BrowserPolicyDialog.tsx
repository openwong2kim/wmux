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

import { useCallback, useEffect, useId, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import Field, { useFieldWiring } from '../ui/Field';
import Switch from '../ui/Switch';
import SegmentedControl from '../ui/SegmentedControl';
import { IconLock } from '../icons';
import { resolvePanePolicy } from '../../../shared/browserPolicy';
import { parseHostRule, type HostPolicyMode } from '../../../shared/browserHostPolicy';

/** One host rule per line: trimmed, empty lines dropped. */
export function hostLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The 1-based line numbers (of the non-empty lines) main would refuse. */
export function invalidHostLines(text: string): Array<{ line: number; rule: string }> {
  return hostLines(text)
    .map((rule, i) => ({ line: i + 1, rule }))
    .filter(({ rule }) => 'error' in parseHostRule(rule));
}

/** Whether a refused write lost the epoch race (re-read and try again). */
function isStale(res: { error?: string; code?: string }): boolean {
  return res.code === 'stale' || /re-read/i.test(res.error ?? '');
}

interface Loaded {
  epoch: number;
  currentProfile: string | undefined;
  /** A stored entry exists (a write is needed even to turn protection off). */
  hasEntry: boolean;
  /** Protected, but rebound / moved / pending: every host refused until saved. */
  needsConfirm: boolean;
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
  const [busy, setBusy] = useState(false);

  const toast = useCallback((level: 'info' | 'error', message: string) => {
    useStore.getState().pushToast({ level, message });
  }, []);

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
      const decision = resolvePanePolicy(entry, { workspaceId, currentProfile: res.currentProfile }, epoch);
      setLoaded({
        epoch,
        currentProfile: res.currentProfile,
        hasEntry: !!entry,
        needsConfirm: decision.kind === 'protected' && !decision.confirmed,
      });
      setIsProtected(!!entry?.protected);
      setMode(entry?.hosts.mode ?? 'off');
      setAllowText((entry?.hosts.allow ?? []).join('\n'));
      setBlockText((entry?.hosts.block ?? []).join('\n'));
      return true;
    } catch {
      toast('error', t('pane.browserPolicyLoadFailed'));
      return false;
    }
  }, [workspaceId, paneId, toast, t]);

  useEffect(() => {
    void load().then((ok) => { if (!ok) onClose(); });
    // Mount only: the dialog edits one pane.
  }, []);

  const allowInvalid = invalidHostLines(allowText);
  const blockInvalid = invalidHostLines(blockText);
  const valid = allowInvalid.length === 0 && blockInvalid.length === 0;
  const canSave = !!loaded && !!loaded.currentProfile && !busy && (!isProtected || valid);

  const save = useCallback(async () => {
    const api = window.electronAPI?.browser?.policy;
    if (!api || !loaded?.currentProfile) return;
    // Never protected and staying off: nothing to write, the pane stays legacy.
    if (!isProtected && !loaded.hasEntry) { onClose(); return; }
    setBusy(true);
    try {
      const res = await api.set({
        workspaceId,
        paneId,
        profileId: loaded.currentProfile,
        protected: isProtected,
        hosts: { mode, allow: hostLines(allowText), block: hostLines(blockText) },
        expectedEpoch: loaded.epoch,
      });
      if (res.ok) {
        onSaved?.(isProtected);
        onClose();
        return;
      }
      if (isStale(res)) {
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
  }, [loaded, isProtected, mode, allowText, blockText, workspaceId, paneId, onClose, onSaved, load, toast, t]);

  const emptyAllowlist = mode === 'allowlist' && hostLines(allowText).length === 0;

  return (
    <Dialog onClose={onClose} width={460} data-testid="browser-policy-dialog">
      <DialogHeader title={t('pane.browserPolicyTitle')} description={t('pane.browserPolicyDescription')} />
      <DialogBody className="flex flex-col gap-3">
        {loaded?.needsConfirm && (
          <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3" data-testid="browser-policy-rebound">
            <span className="shrink-0 mt-0.5 text-[var(--text-muted)]" aria-hidden="true"><IconLock size={12} /></span>
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] text-[var(--text-main)]">{t('pane.browserPolicyRebound')}</span>
              <span className="text-[11px] text-[var(--text-sub)]">{t('pane.browserPolicyReboundDetail')}</span>
            </div>
          </div>
        )}
        <Field label={t('pane.browserPolicyProtect')} description={t('pane.browserPolicyProtectDesc')}>
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
            <Field label={t('pane.browserPolicyBlocked')} description={t('pane.browserPolicyBlockedDesc')} layout="stacked">
              <HostList value={blockText} onChange={setBlockText} invalid={blockInvalid} testId="browser-policy-block" />
            </Field>
          </>
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
    </Dialog>
  );
}
