import { useCallback, useMemo, useState } from 'react';
import type { Workspace } from '../../../shared/types';
import { isSecretLikeEnvKey, isValidEnvKey } from '../../../shared/workspaceProfile';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Field from '../ui/Field';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { IconWarning, IconX } from '../icons';

interface WorkspaceProfileModalProps {
  workspace: Workspace;
  onClose: () => void;
}

interface EnvRow {
  id: number;
  key: string;
  value: string;
}

let rowSeq = 0;
const nextRowId = (): number => ++rowSeq;

function rowsFromProfile(workspace: Workspace): EnvRow[] {
  const env = workspace.profile?.env ?? {};
  const rows = Object.entries(env).map(([key, value]) => ({ id: nextRowId(), key, value }));
  // Always leave one blank row to type into.
  rows.push({ id: nextRowId(), key: '', value: '' });
  return rows;
}

/**
 * Editor for a workspace's process profile (env vars + optional startup
 * command) applied to NEW panes. Values are shown because the local user is
 * editing them; they are never logged and never published over the metadata
 * bus (setWorkspaceProfile is a plain state write).
 */
export default function WorkspaceProfileModal({ workspace, onClose }: WorkspaceProfileModalProps) {
  const t = useT();
  const setWorkspaceProfile = useStore((s) => s.setWorkspaceProfile);
  const [rows, setRows] = useState<EnvRow[]>(() => rowsFromProfile(workspace));
  const [command, setCommand] = useState<string>(workspace.profile?.defaultPaneCommand ?? '');
  const [startupCwd, setStartupCwd] = useState<string>(workspace.profile?.startupCwd ?? '');

  const updateRow = useCallback((id: number, patch: Partial<EnvRow>) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
      // Keep a trailing blank row so there's always somewhere to type.
      const last = next[next.length - 1];
      if (!last || last.key.trim() !== '' || last.value.trim() !== '') {
        next.push({ id: nextRowId(), key: '', value: '' });
      }
      return next;
    });
  }, []);

  const removeRow = useCallback((id: number) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (next.length === 0) next.push({ id: nextRowId(), key: '', value: '' });
      return next;
    });
  }, []);

  const handleSave = useCallback(() => {
    const env: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key === '') continue;
      env[key] = row.value;
    }
    // setWorkspaceProfile normalizes (drops invalid/reserved AND secret-named
    // keys, collapses an empty profile to undefined) — it is the single
    // enforcing boundary, so we just hand it the raw rows.
    setWorkspaceProfile(workspace.id, { env, defaultPaneCommand: command, startupCwd });
    onClose();
  }, [rows, command, startupCwd, setWorkspaceProfile, workspace.id, onClose]);

  // A key is flagged invalid (red, dropped on save) when non-empty but not a
  // valid, non-reserved name.
  const invalidIds = useMemo(() => {
    const set = new Set<number>();
    for (const row of rows) {
      const key = row.key.trim();
      if (key !== '' && !isValidEnvKey(key)) set.add(row.id);
    }
    return set;
  }, [rows]);

  // A key is flagged secret-looking when it's a valid name that matches the
  // inherited-env denylist (e.g. *_KEY, *_TOKEN). By policy these are NOT
  // persisted in plaintext — normalizeEnv drops them on save — so the editor
  // tells the user the key won't be saved and to point at a config directory
  // instead. (Reserved/invalid keys are already covered by `invalidIds`.)
  const secretIds = useMemo(() => {
    const set = new Set<number>();
    for (const row of rows) {
      const key = row.key.trim();
      if (key !== '' && isValidEnvKey(key) && isSecretLikeEnvKey(key)) set.add(row.id);
    }
    return set;
  }, [rows]);

  // Escape and the backdrop close it without saving (ui/Dialog).
  return (
    <Dialog onClose={onClose} closeOnBackdrop width={480} zIndexClassName="z-[var(--z-modal-top)]">
      <DialogHeader
        title={t('workspaceProfile.title')}
        description={t('workspaceProfile.subtitle', { name: workspace.name })}
      />
      <DialogBody>
        {/* Env rows */}
        <section>
          <p className="ui-group-label">{t('workspaceProfile.envHeading')}</p>
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <div key={row.id}>
                <div className="flex items-center gap-2">
                  <Input
                    className="flex-1 min-w-0 text-[12px] font-mono"
                    style={invalidIds.has(row.id) ? { borderColor: 'var(--accent-red)' } : undefined}
                    placeholder={t('workspaceProfile.keyPlaceholder')}
                    value={row.key}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(e) => updateRow(row.id, { key: e.target.value })}
                  />
                  <span className="text-[13px] text-[var(--text-sub)]" aria-hidden="true">=</span>
                  <Input
                    className="flex-1 min-w-0 text-[12px] font-mono"
                    placeholder={t('workspaceProfile.valuePlaceholder')}
                    value={row.value}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                  />
                  <Button
                    variant="icon"
                    className="w-7 h-7 flex-shrink-0"
                    title={t('workspaceProfile.removeRow')}
                    aria-label={t('workspaceProfile.removeRow')}
                    onClick={() => removeRow(row.id)}
                  >
                    <IconX size={12} />
                  </Button>
                </div>
                {invalidIds.has(row.id) && (
                  <p className="ui-row-error">{t('workspaceProfile.invalidKey')}</p>
                )}
                {secretIds.has(row.id) && !invalidIds.has(row.id) && (
                  <p className="m-0 mt-0.5 text-[11px] leading-4" style={{ color: 'var(--accent-yellow)' }}>
                    {t('workspaceProfile.secretKeyWarning')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        <Field label={t('workspaceProfile.commandHeading')} layout="stacked">
          <Input
            className="w-full text-[12px] font-mono"
            placeholder={t('workspaceProfile.commandPlaceholder')}
            value={command}
            spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
          />
        </Field>

        {/* Startup directory (issue #175) */}
        <Field
          label={t('workspaceProfile.startupCwdHeading')}
          description={t('workspaceProfile.startupCwdHint')}
          layout="stacked"
        >
          <Input
            className="w-full text-[12px] font-mono"
            placeholder={t('workspaceProfile.startupCwdPlaceholder')}
            value={startupCwd}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setStartupCwd(e.target.value)}
          />
        </Field>

        {/* Warnings */}
        <div className="ui-notice flex items-start gap-2.5 px-3.5 py-3">
          <span className="shrink-0 pt-0.5 text-[var(--text-sub)]" aria-hidden="true">
            <IconWarning size={12} />
          </span>
          <div className="flex flex-col gap-1 text-[11px] leading-4 text-[var(--text-sub)]">
            <p className="m-0 text-[var(--text-main)]">{t('workspaceProfile.warningNewPanes')}</p>
            <p className="m-0">{t('workspaceProfile.warningNotSandbox')}</p>
            <p className="m-0">{t('workspaceProfile.warningPlaintext')}</p>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" onClick={onClose}>
          {t('workspaceProfile.cancel')}
        </Button>
        <Button size="md" variant="primary" onClick={handleSave}>
          {t('workspaceProfile.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
