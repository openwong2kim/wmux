import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { JevConfigurePatch, JevSessionStatus } from '../../../shared/jev';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Switch from '../ui/Switch';
import { SettingNote, SettingRow, SettingsSection } from './SettingsLayout';

/** Session-only controls: no store hydration, key readback or automatic opt-in. */
export default function JevSettings() {
  const t = useT();
  const disclosureId = useId();
  const [status, setStatus] = useState<JevSessionStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<'read' | 'update' | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const operation = useRef(0);

  const run = useCallback(async (patch?: JevConfigurePatch) => {
    // A ref closes the gap before React renders disabled controls, including
    // Enter + click in one event batch. Requests are never retried implicitly.
    if (busyRef.current) return;
    busyRef.current = true;
    const token = ++operation.current;
    const current = () => mounted.current && token === operation.current;
    setBusy(true);
    setError(null);
    const api = window.electronAPI?.deck?.jev;
    try {
      if (!api) throw new Error('Jev bridge unavailable');
      const next = patch ? await api.configure(patch) : await api.status();
      if (current()) setStatus(next);
    } catch {
      if (!current()) return;
      // Never render an IPC error: it could include sensitive request data.
      setError(patch ? 'update' : 'read');
      setStatus(null);
      if (patch && api) {
        // A lost response may follow a successful write. Reconcile without
        // repeating the mutation or making an optimistic enabled-state claim.
        try {
          const next = await api.status();
          if (current()) setStatus(next);
        } catch { /* The explicit Refresh action can recover this read. */ }
      }
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => {
      mounted.current = false;
      operation.current++;
      busyRef.current = false;
    };
  }, [run]);

  const saveKey = () => {
    if (busyRef.current || !status || !keyDraft.trim()) return;
    const apiKey = keyDraft.trim();
    // Do not retain or restore the submitted secret, even after a failed IPC.
    setKeyDraft('');
    void run({ apiKey });
  };
  const cancelKey = () => {
    if (!busyRef.current) setKeyDraft('');
  };
  const clearKey = () => {
    if (busyRef.current) return;
    setKeyDraft('');
    void run({ clearKey: true });
  };

  return (
    <SettingsSection
      id="jev"
      title={t('jev.settings.title')}
      data-testid="jev-settings"
      action={(
        <Button size="md" variant="ghost" disabled={busy} onClick={() => { void run(); }}>
          {t('jev.settings.refresh')}
        </Button>
      )}
    >
      <SettingNote id={disclosureId}>{t('jev.settings.disclosure')}</SettingNote>
      <SettingRow label={t('jev.settings.allow')} description={t('jev.settings.allowDesc')}>
        <Switch
          checked={status?.enabled ?? false}
          disabled={busy || !status?.hasKey}
          onCheckedChange={(enabled) => { void run({ enabled }); }}
          aria-label={t('jev.settings.allow')}
          aria-describedby={disclosureId}
          data-testid="jev-enable"
        />
      </SettingRow>
      <SettingRow label={t('jev.settings.key')} description={t('jev.settings.keyDesc')} layout="stacked">
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => { event.preventDefault(); saveKey(); }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            disabled={busy || !status}
            className="settings-input w-full"
            data-testid="jev-key"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="md" disabled={busy || !status || !keyDraft.trim()}>
              {t('jev.settings.useKey')}
            </Button>
            <Button size="md" variant="ghost" disabled={busy || !keyDraft} onClick={cancelKey}>
              {t('jev.settings.cancel')}
            </Button>
          </div>
        </form>
      </SettingRow>
      <SettingRow label={t('jev.settings.state')}>
        <div className="flex flex-wrap items-center gap-2" role="status" data-testid="jev-status">
          <Badge>
            {busy ? t('jev.settings.checking') : !status ? t('jev.settings.unknown')
              : status.enabled ? t('jev.settings.on') : t('jev.settings.off')}
          </Badge>
          {status && <Badge>{t(status.hasKey ? 'jev.settings.keyPresent' : 'jev.settings.keyMissing')}</Badge>}
          <Button size="md" variant="ghost" disabled={busy || !status?.hasKey} onClick={clearKey}>
            {t('jev.settings.clearKey')}
          </Button>
        </div>
      </SettingRow>
      {error && (
        <SettingNote tone="danger" role="alert">
          {t(error === 'read' ? 'jev.settings.readFailed' : 'jev.settings.updateFailed')}
        </SettingNote>
      )}
    </SettingsSection>
  );
}
