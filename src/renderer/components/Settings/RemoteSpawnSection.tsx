import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultSpawnPolicy,
  isSpawnableAgent,
  SPAWN_LIMIT_KEYS,
  SPAWN_LIMIT_MAX,
  SPAWN_ROOTS_MAX,
  type A2aSpawnLimitKey,
  type A2aSpawnApproval,
  type A2aSpawnFollowUps,
  type A2aSpawnPermissionMode,
  type A2aSpawnPolicyV1,
} from '../../../shared/a2aSpawn';
import { AGENT_ROWS, type AgentSlug } from '../../../shared/agentIdentity';
import { FANOUT_WORKER_PERMISSION_MODES, isFanoutWorkerPermissionMode } from '../../../shared/workerLaunch';
import { useT } from '../../hooks/useT';
import UiButton from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import SegmentedControl from '../ui/SegmentedControl';
import Select from '../ui/Select';
import Switch from '../ui/Switch';
import { REMOTE_SPAWN_UI_ENABLED } from '../Remote/remoteSpawnFlag';
import { readSpawnPolicy, rootFromPath, saveSpawnPolicy } from '../Remote/remoteSpawnPolicy';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';
import { SettingLimitInput } from './SettingLimitInput';

// ─── Starting new agents from another PC ────────────────────────────────────
//
// Settings › LAN: whether paired PCs may ask this PC to start a new agent,
// in which folders, with which agents, and in which permission mode. Edits
// stay a draft until Save; the daemon checks every folder and answers with
// the policy it stored (or why it refused). Each PC is opted in on its own
// row of the Remote page.

/** The app's folder picker: the first folder chosen, or null. */
async function pickFolderDialog(): Promise<string | null> {
  const picked = await window.electronAPI?.dialog?.pickFolder?.();
  return picked && picked.length > 0 ? picked[0] : null;
}

export interface RemoteSpawnSectionProps {
  /** Defaults to the feature flag; tests pass it. */
  enabled?: boolean;
  /** Defaults to the app's folder dialog; tests pass it. */
  pickFolder?: () => Promise<string | null>;
}

export function RemoteSpawnSection({ enabled = REMOTE_SPAWN_UI_ENABLED, pickFolder = pickFolderDialog }: RemoteSpawnSectionProps) {
  if (!enabled) return null;
  return <SpawnPolicyEditor pickFolder={pickFolder} />;
}

function SpawnPolicyEditor({ pickFolder }: { pickFolder: () => Promise<string | null> }) {
  const t = useT();
  const [saved, setSaved] = useState<A2aSpawnPolicyV1 | null>(null);
  const [draft, setDraft] = useState<A2aSpawnPolicyV1>(defaultSpawnPolicy);
  const [unavailable, setUnavailable] = useState(false);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    void readSpawnPolicy().then((p) => {
      if (!mounted.current) return;
      if (!p) { setUnavailable(true); return; }
      setSaved(p);
      setDraft(p);
    });
  }, []);

  const dirty = useMemo(() => saved !== null && JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  const edit = useCallback((patch: Partial<A2aSpawnPolicyV1>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setJustSaved(false);
  }, []);

  const onMode = (v: string) => {
    if (!isFanoutWorkerPermissionMode(v)) return;
    // Bypass is never taken from the select alone: it waits for the confirm below.
    if (v === 'bypassPermissions' && draft.permissionMode !== 'bypassPermissions') { setConfirmBypass(true); return; }
    setConfirmBypass(false);
    edit({ permissionMode: v as A2aSpawnPermissionMode });
  };

  const addFolder = async () => {
    const path = await pickFolder();
    if (!path || !mounted.current) return;
    setDraft((d) => {
      if (d.roots.length >= SPAWN_ROOTS_MAX || d.roots.some((r) => r.path === path)) return d;
      return { ...d, roots: [...d.roots, rootFromPath(path, d.roots)] };
    });
    setJustSaved(false);
  };

  /** One limit set or cleared (null: none); an empty set is dropped. */
  const setLimit = (key: A2aSpawnLimitKey, v: number | null) => {
    const next = { ...(draft.limits ?? {}) };
    if (v === null) delete next[key];
    else next[key] = v;
    const { limits: _old, ...rest } = draft;
    void _old;
    setDraft(Object.keys(next).length > 0 ? { ...rest, limits: next } : rest);
    setJustSaved(false);
  };

  const toggleAgent = (slug: AgentSlug, on: boolean) => {
    edit({ agents: on ? [...draft.agents.filter((a) => a !== slug), slug] : draft.agents.filter((a) => a !== slug) });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await saveSpawnPolicy(draft, t('remoteSpawn.saveFailed'));
      if (!mounted.current) return;
      if (!r.ok && r.conflict) {
        // Changed elsewhere meanwhile: show what is saved now, and say so.
        const fresh = await readSpawnPolicy();
        if (!mounted.current) return;
        if (fresh) { setSaved(fresh); setDraft(fresh); }
        setError(t('remoteSpawn.conflict'));
        return;
      }
      if (!r.ok) { setError(r.error); return; }
      setSaved(r.policy);
      setDraft(r.policy);
      setJustSaved(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (unavailable || !saved) {
    return (
      <SettingsSection title={t('remoteSpawn.title')} data-testid="remote-spawn-section">
        <SettingNote>{unavailable ? t('remoteSpawn.unavailable') : t('remoteSpawn.loading')}</SettingNote>
      </SettingsSection>
    );
  }

  const approvalOptions: { value: A2aSpawnApproval; label: string }[] = [
    { value: 'ask', label: t('remoteSpawn.approval.ask') },
    { value: 'allow-list', label: t('remoteSpawn.approval.allowList') },
  ];
  const followUpOptions: { value: A2aSpawnFollowUps; label: string }[] = [
    { value: 'ask', label: t('remoteSpawn.followUps.ask') },
    { value: 'direct', label: t('remoteSpawn.followUps.direct') },
  ];

  return (
    <SettingsSection title={t('remoteSpawn.title')} data-testid="remote-spawn-section">
      <SettingRow label={t('remoteSpawn.enable')} description={t('remoteSpawn.enableDesc')}>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(v) => edit({ enabled: v })}
          aria-label={t('remoteSpawn.enable')}
          data-testid="remote-spawn-enabled"
        />
      </SettingRow>
      {draft.enabled && (
        <>
          <SettingRow label={t('remoteSpawn.mode')} description={t('remoteSpawn.modeDesc')}>
            <Select
              aria-label={t('remoteSpawn.mode')}
              value={draft.permissionMode}
              onChange={(e) => onMode(e.target.value)}
              className="settings-select"
              data-testid="remote-spawn-mode"
            >
              {FANOUT_WORKER_PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>{t(`settings.fanoutWorkerMode.${m}`)}</option>
              ))}
            </Select>
          </SettingRow>
          {confirmBypass && (
            <SettingNote tone="warning" role="alert" className="flex items-center justify-between gap-3" data-testid="remote-spawn-bypass-confirm">
              <span>{t('remoteSpawn.bypassWarning')}</span>
              <span className="flex shrink-0 gap-2">
                <UiButton variant="ghost" size="sm" onClick={() => setConfirmBypass(false)}>{t('remoteSpawn.cancel')}</UiButton>
                <UiButton
                  variant="secondary"
                  size="sm"
                  data-testid="remote-spawn-bypass-ok"
                  onClick={() => { setConfirmBypass(false); edit({ permissionMode: 'bypassPermissions' }); }}
                >
                  {t('remoteSpawn.bypassUse')}
                </UiButton>
              </span>
            </SettingNote>
          )}
          <SettingRow label={t('remoteSpawn.approval')} description={t('remoteSpawn.approvalDesc')}>
            <SegmentedControl
              value={draft.approval}
              options={approvalOptions}
              onValueChange={(v) => edit({ approval: v })}
              ariaLabel={t('remoteSpawn.approval')}
            />
          </SettingRow>
          <SettingRow label={t('remoteSpawn.followUps')} description={t('remoteSpawn.followUpsDesc')}>
            <SegmentedControl
              value={draft.followUps}
              options={followUpOptions}
              onValueChange={(v) => edit({ followUps: v })}
              ariaLabel={t('remoteSpawn.followUps')}
            />
          </SettingRow>
          <SettingRow label={t('remoteSpawn.folders')} description={t('remoteSpawn.foldersDesc')}>
            <UiButton
              variant="secondary"
              size="md"
              disabled={draft.roots.length >= SPAWN_ROOTS_MAX}
              onClick={() => void addFolder()}
              data-testid="remote-spawn-add-folder"
            >
              {t('remoteSpawn.addFolder')}
            </UiButton>
          </SettingRow>
          {draft.roots.length === 0
            ? <SettingNote>{t('remoteSpawn.noFolders')}</SettingNote>
            : draft.roots.map((r) => (
              <div key={r.id} className="settings-row" data-remote-spawn-root={r.id}>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px]">{r.label}</span>
                    <span className="ui-code truncate text-[11px]" style={{ color: 'var(--text-sub)' }} title={r.path}>{r.path}</span>
                  </div>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('remoteSpawn.removeFolderLabel', { name: r.label })}
                    onClick={() => edit({ roots: draft.roots.filter((x) => x.id !== r.id) })}
                  >
                    {t('remoteSpawn.removeFolder')}
                  </UiButton>
                </div>
              </div>
            ))}
          <SettingRow label={t('remoteSpawn.agents')} description={t('remoteSpawn.agentsDesc')} layout="stacked">
            <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1" role="group" aria-label={t('remoteSpawn.agents')}>
              {AGENT_ROWS.filter((a) => isSpawnableAgent(a.slug)).map((a) => (
                <label key={a.slug} className="inline-flex items-center gap-1.5 text-[13px]">
                  <Checkbox
                    checked={draft.agents.includes(a.slug)}
                    onCheckedChange={(v) => toggleAgent(a.slug, v)}
                    data-remote-spawn-agent={a.slug}
                  />
                  <span>{a.display}</span>
                </label>
              ))}
            </div>
          </SettingRow>
          {SPAWN_LIMIT_KEYS.map((key) => (
            <SettingRow key={key} label={t(`remoteSpawn.limit.${key}`)} description={t(`remoteSpawn.limit.${key}Desc`)}>
              <SettingLimitInput
                value={draft.limits?.[key]}
                max={SPAWN_LIMIT_MAX[key]}
                label={t(`remoteSpawn.limit.${key}`)}
                noLimitLabel={key === 'pendingPerPc' ? t('remoteSpawn.limit.pendingDefault') : key === 'maxPromptKiB' || key === 'maxWaitHours' ? String(SPAWN_LIMIT_MAX[key]) : t('settings.noLimit')}
                onCommit={(v) => setLimit(key, v)}
                testId={`remote-spawn-limit-${key}`}
              />
            </SettingRow>
          ))}
          <SettingNote>{t('remoteSpawn.risk')}</SettingNote>
        </>
      )}
      {error && <SettingNote tone="danger" role="alert" data-testid="remote-spawn-error">{error}</SettingNote>}
      <div className="settings-row">
        <div className="flex items-center justify-end gap-3">
          {justSaved && !dirty && <span className="text-[12px]" style={{ color: 'var(--text-sub)' }} role="status">{t('remoteSpawn.saved')}</span>}
          <UiButton variant={dirty && !busy ? 'primary' : 'secondary'} size="md" disabled={!dirty || busy} onClick={() => void save()} data-testid="remote-spawn-save">
            {t('remoteSpawn.save')}
          </UiButton>
        </div>
      </div>
    </SettingsSection>
  );
}
