// ─── Fan-out presets — operator-defined agent lists for fanout_start ─────────
// Main owns the list (a missing file reads as the shipped templates) and
// validates every save strictly; this section edits a draft, checks it with
// the same normalizer before sending, and shows main's refusal verbatim.
// Settings is a quiet surface: nothing here is a primary button.

import { useEffect, useId, useState } from 'react';
import {
  FANOUT_AGENTS,
  FANOUT_MODEL_RE,
  FANOUT_PRESETS_MAX,
  FANOUT_PRESET_DESCRIPTION_MAX,
  FANOUT_PRESET_NAME_MAX,
  FANOUT_PRESET_TEMPLATES,
  fanoutAgentSpec,
  fanoutPresetFolderSlug,
  fanoutPresetOutputFolder,
  type FanoutIssue,
  type FanoutPreset,
  type FanoutPresetDropped,
} from '../../../shared/fanoutPreset';
import { ROLE_BINDING_MODEL_MAX } from '../../../shared/orchestratorRole';
import { FANOUT_MAX_TASKS } from '../../../shared/workTask';
import { useT } from '../../hooks/useT';
import { IconX } from '../icons';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Switch from '../ui/Switch';
import { SettingsSection, SettingNote } from './SettingsLayout';
import {
  addDraftRow,
  applyDraft,
  draftFromPreset,
  emptyFanoutPresetDraft,
  hasFanoutPresetNamed,
  removeDraftRow,
  setRowAgent,
  summarizeFanoutPresetAgents,
  type FanoutPresetDraft,
  type FanoutPresetDraftRow,
} from './fanoutPresetDraft';

type Translate = ReturnType<typeof useT>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A validator issue in the UI language (the English `error` is wire-only). */
function issueText(t: Translate, issue: FanoutIssue): string {
  const text = t(`settings.fanoutPresetsIssue.${issue.code}`, issue.params);
  return issue.params.row ? t('settings.fanoutPresetsIssueRow', { row: issue.params.row, issue: text }) : text;
}

export function FanoutPresetsSection(): React.ReactElement {
  const t = useT();
  const [presets, setPresets] = useState<FanoutPreset[] | null>(null);
  const [loadError, setLoadError] = useState('');
  // Entries main could not keep. The save replaces the whole file, so they are
  // shown until the operator saves (after which the backup holds them).
  const [dropped, setDropped] = useState<{ items: FanoutPresetDropped[]; unreadable: boolean }>({ items: [], unreadable: false });
  // index null = a new preset appended at the end.
  const [editing, setEditing] = useState<{ index: number | null; draft: FanoutPresetDraft } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.fanout?.getPresets?.()
      .then((report) => {
        if (cancelled || !report || !Array.isArray(report.presets)) return;
        setPresets(report.presets);
        setDropped({ items: Array.isArray(report.dropped) ? report.dropped : [], unreadable: report.unreadable === true });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(t('settings.fanoutPresetsLoadError', { error: errorText(err) }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (next: FanoutPreset[]): Promise<boolean> => {
    setBusy(true);
    try {
      const out = await window.electronAPI.fanout.setPresets(next);
      if (!out.ok) {
        setError(t('settings.fanoutPresetsSaveError', { error: issueText(t, out) }));
        return false;
      }
      setPresets(out.presets);
      setDropped({ items: [], unreadable: false });
      setError('');
      return true;
    } catch (err) {
      setError(t('settings.fanoutPresetsSaveError', { error: errorText(err) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (index: number | null, draft: FanoutPresetDraft) => {
    setError('');
    setEditing({ index, draft });
  };

  const onSave = async () => {
    if (!editing || !presets) return;
    const r = applyDraft(presets, editing.draft, editing.index);
    if (!r.ok) {
      setError(t('settings.fanoutPresetsInvalid', { error: issueText(t, r.issue) }));
      return;
    }
    if (await persist(r.next)) setEditing(null);
  };

  const onCancel = () => {
    setEditing(null);
    setError('');
  };

  const editor = (draft: FanoutPresetDraft) => (
    <PresetEditor
      t={t}
      draft={draft}
      error={error}
      busy={busy}
      onChange={(next) => setEditing((cur) => (cur ? { ...cur, draft: next } : cur))}
      onSave={() => void onSave()}
      onCancel={onCancel}
    />
  );

  const missingTemplates = presets
    ? FANOUT_PRESET_TEMPLATES.filter((tpl) => !hasFanoutPresetNamed(presets, tpl.name))
    : [];
  const atCap = (presets?.length ?? 0) >= FANOUT_PRESETS_MAX;

  return (
    <SettingsSection
      id="fanoutpresets"
      title={t('settings.fanoutPresets')}
      description={t('settings.fanoutPresetsDesc')}
      data-testid="fanout-presets-section"
    >
      {loadError && <SettingNote tone="danger" role="alert">{loadError}</SettingNote>}
      {dropped.unreadable && (
        <SettingNote tone="warning" data-testid="fanout-presets-unreadable">{t('settings.fanoutPresetsUnreadable')}</SettingNote>
      )}
      {dropped.items.length > 0 && (
        <SettingNote tone="warning" data-testid="fanout-presets-dropped">
          {t('settings.fanoutPresetsDropped', { count: String(dropped.items.length) })}
          {dropped.items.map((d, k) => (
            <span key={k} className="block">
              {t('settings.fanoutPresetsDroppedItem', { name: d.name ?? '?', issue: issueText(t, d.issue) })}
            </span>
          ))}
        </SettingNote>
      )}
      {!presets && !loadError && <SettingNote>{t('settings.fanoutPresetsLoading')}</SettingNote>}
      {presets && presets.length === 0 && editing?.index !== null && (
        <SettingNote>{t('settings.fanoutPresetsEmpty')}</SettingNote>
      )}
      {presets?.map((preset, k) =>
        editing?.index === k ? (
          <div key={preset.name}>{editor(editing.draft)}</div>
        ) : (
          <PresetRow
            key={preset.name}
            t={t}
            preset={preset}
            disabled={busy || editing !== null}
            onEdit={() => startEdit(k, draftFromPreset(preset))}
            onDelete={() => void persist(presets.filter((_, i) => i !== k))}
          />
        ),
      )}
      {editing && editing.index === null && editor(editing.draft)}
      {!editing && error && <SettingNote tone="danger" role="alert">{error}</SettingNote>}
      {presets && !editing && (
        <div className="ui-row">
          <div className="flex flex-wrap gap-2">
            {!atCap && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                data-testid="fanout-preset-add"
                onClick={() => startEdit(null, emptyFanoutPresetDraft())}
              >
                {t('settings.fanoutPresetsAdd')}
              </Button>
            )}
            {!atCap && missingTemplates.map((tpl) => (
              <Button
                key={tpl.name}
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid={`fanout-preset-add-template-${tpl.name.toLowerCase()}`}
                onClick={() => void persist([...presets, tpl])}
              >
                {t('settings.fanoutPresetsAddTemplate', { name: tpl.name })}
              </Button>
            ))}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function PresetRow({
  t,
  preset,
  disabled,
  onEdit,
  onDelete,
}: {
  t: Translate;
  preset: FanoutPreset;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const storage = preset.worktree
    ? t('settings.fanoutPresetsStorageWorktree')
    : t('settings.fanoutPresetsStorageOutputs', { folder: fanoutPresetOutputFolder(preset) });
  return (
    <div className="ui-row" data-testid="fanout-preset-row" data-preset-name={preset.name}>
      <div className="ui-row-text">
        <p className="ui-row-title truncate">{preset.name}</p>
        {preset.description && <p className="ui-row-detail truncate">{preset.description}</p>}
        {/* The agent list is what gets launched: machine evidence, mono. */}
        <p className="ui-row-detail truncate font-mono">{summarizeFanoutPresetAgents(preset)}</p>
        <p className="ui-row-detail truncate">{storage}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" disabled={disabled} data-testid="fanout-preset-edit" onClick={onEdit}>
          {t('settings.fanoutPresetsEdit')}
        </Button>
        <Button variant="destructive" size="sm" disabled={disabled} data-testid="fanout-preset-delete" onClick={onDelete}>
          {t('settings.fanoutPresetsDelete')}
        </Button>
      </div>
    </div>
  );
}

function PresetEditor({
  t,
  draft,
  error,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  t: Translate;
  draft: FanoutPresetDraft;
  error: string;
  busy: boolean;
  onChange: (next: FanoutPresetDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const updateRow = (k: number, row: FanoutPresetDraftRow) =>
    onChange({ ...draft, items: draft.items.map((r, i) => (i === k ? row : r)) });
  const agentsLabelId = useId();
  const agentsDescId = useId();
  const slug = fanoutPresetFolderSlug(draft.name.trim());
  const folder = draft.outputFolder.trim() || slug;

  return (
    <div className="settings-block" data-testid="fanout-preset-editor">
      <Field label={t('settings.fanoutPresetsName')} description={t('settings.fanoutPresetsNameDesc')} layout="stacked">
        <Input
          className="settings-input"
          value={draft.name}
          maxLength={FANOUT_PRESET_NAME_MAX}
          data-testid="fanout-preset-name"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </Field>
      <Field label={t('settings.fanoutPresetsDescription')} layout="stacked">
        <Input
          className="settings-input"
          value={draft.description}
          maxLength={FANOUT_PRESET_DESCRIPTION_MAX}
          placeholder={t('settings.fanoutPresetsDescriptionPlaceholder')}
          data-testid="fanout-preset-description"
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </Field>
      {/* Not a Field: Field hands its one control id to every control inside,
          so several rows would share an id. A labelled group instead; each
          control carries its own per-row aria-label. */}
      <div className="ui-field" data-layout="stacked">
        <div className="ui-field-text">
          <span id={agentsLabelId} className="ui-field-label">{t('settings.fanoutPresetsAgents')}</span>
          <span id={agentsDescId} className="ui-field-description">{t('settings.fanoutPresetsAgentsDesc')}</span>
        </div>
        <div className="flex w-full flex-col gap-2" role="group" aria-labelledby={agentsLabelId} aria-describedby={agentsDescId}>
          {draft.items.map((row, k) => (
            <AgentRow
              key={k}
              t={t}
              index={k}
              row={row}
              canRemove={draft.items.length > 1}
              onChange={(next) => updateRow(k, next)}
              onRemove={() => onChange(removeDraftRow(draft, k))}
            />
          ))}
          {draft.items.length < FANOUT_MAX_TASKS && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                data-testid="fanout-preset-add-agent"
                onClick={() => onChange(addDraftRow(draft))}
              >
                {t('settings.fanoutPresetsAddAgent')}
              </Button>
            </div>
          )}
        </div>
      </div>
      <Field label={t('settings.fanoutPresetsWorktree')} description={t('settings.fanoutPresetsWorktreeDesc')}>
        <Switch
          checked={draft.worktree}
          aria-label={t('settings.fanoutPresetsWorktree')}
          data-testid="fanout-preset-worktree"
          onCheckedChange={(v) => onChange({ ...draft, worktree: v })}
        />
      </Field>
      {!draft.worktree && (
        <Field label={t('settings.fanoutPresetsOutputFolder')} layout="stacked">
          <div className="flex w-full flex-col gap-1">
            <Input
              className="settings-input font-mono"
              value={draft.outputFolder}
              placeholder={slug}
              maxLength={64 /* the normalizer's one-segment folder cap */}
              data-testid="fanout-preset-output-folder"
              onChange={(e) => onChange({ ...draft, outputFolder: e.target.value })}
            />
            <SettingNote className="!p-0">
              {t('settings.fanoutPresetsOutputPath', { path: `<wmux data>/outputs/${folder}/<batch>/<k>-<agent>-<id>/` })}
            </SettingNote>
          </div>
        </Field>
      )}
      {error && <SettingNote tone="danger" role="alert" className="!p-0" data-testid="fanout-preset-error">{error}</SettingNote>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="md" disabled={busy} data-testid="fanout-preset-cancel" onClick={onCancel}>
          {t('settings.fanoutPresetsCancel')}
        </Button>
        <Button variant="secondary" size="md" disabled={busy} data-testid="fanout-preset-save" onClick={onSave}>
          {t('settings.fanoutPresetsSave')}
        </Button>
      </div>
    </div>
  );
}

function AgentRow({
  t,
  index,
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  t: Translate;
  index: number;
  row: FanoutPresetDraftRow;
  canRemove: boolean;
  onChange: (next: FanoutPresetDraftRow) => void;
  onRemove: () => void;
}) {
  const spec = fanoutAgentSpec(row.agent);
  const modelOk = spec?.modelFlag === true;
  const hasUnattended = !!spec && spec.unattendedFlags.length > 0;
  const n = String(index + 1);
  const model = row.model.trim();
  return (
    <div className="flex flex-col gap-1" data-testid="fanout-preset-agent-row">
      <div className="flex items-center gap-2">
        {/* Fixed width: the Select fills its container, and unwrapped it
            squeezed the model input to a sliver. */}
        <div className="w-[168px] shrink-0">
        <Select
          aria-label={t('settings.fanoutPresetsAgentLabel', { index: n })}
          value={row.agent}
          data-testid="fanout-preset-agent"
          onChange={(e) => onChange(setRowAgent(row, e.target.value))}
        >
          {FANOUT_AGENTS.map((a) => (
            <option key={a.stem} value={a.stem} disabled={!a.selectable}>
              {a.selectable
                ? a.label
                : t('settings.fanoutPresetsAgentUnavailable', {
                    label: a.label,
                    reason: t(`settings.fanoutPresetsDisabled.${a.disabledCode ?? 'unverified'}`),
                  })}
            </option>
          ))}
        </Select>
        </div>
        <Input
          className="settings-input min-w-0 flex-1 font-mono"
          aria-label={t('settings.fanoutPresetsModelLabel', { index: n })}
          value={modelOk ? row.model : ''}
          disabled={!modelOk}
          placeholder={modelOk ? t('settings.fanoutPresetsModelPlaceholder') : t('settings.fanoutPresetsModelUnsupported')}
          title={modelOk ? undefined : t('settings.fanoutPresetsModelUnsupported')}
          maxLength={ROLE_BINDING_MODEL_MAX}
          aria-invalid={model !== '' && !FANOUT_MODEL_RE.test(model)}
          data-testid="fanout-preset-model"
          onChange={(e) => onChange({ ...row, model: e.target.value })}
        />
        {hasUnattended && (
          <>
            <span className="ui-row-detail shrink-0">{t('settings.fanoutPresetsUnattended')}</span>
            <Switch
              checked={row.unattended}
              aria-label={t('settings.fanoutPresetsUnattendedLabel', { index: n })}
              data-testid="fanout-preset-unattended"
              onCheckedChange={(v) => onChange({ ...row, unattended: v })}
            />
          </>
        )}
        <Button
          variant="icon"
          aria-label={t('settings.fanoutPresetsRemoveRow', { index: n })}
          title={t('settings.fanoutPresetsRemoveRow', { index: n })}
          disabled={!canRemove}
          data-testid="fanout-preset-remove-agent"
          onClick={onRemove}
        >
          <IconX size={12} />
        </Button>
      </div>
      {hasUnattended && row.unattended && (
        <SettingNote tone="warning" className="!p-0" data-testid="fanout-preset-unattended-warning">
          {t('settings.fanoutPresetsUnattendedWarning', { cli: row.agent, flags: spec.unattendedFlags })}
        </SettingNote>
      )}
    </div>
  );
}
