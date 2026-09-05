import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Workspace } from '../../../shared/types';
import { isSecretLikeEnvKey, isValidEnvKey } from '../../../shared/workspaceProfile';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal-top)] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        className="w-[460px] max-h-[80vh] overflow-y-auto rounded-[7px] shadow-2xl"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b" style={{ borderColor: 'var(--bg-overlay)' }}>
          <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>
            {t('workspaceProfile.title')}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-subtle)' }}>
            {t('workspaceProfile.subtitle', { name: workspace.name })}
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Env rows */}
          <div>
            <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-sub)' }}>
              {t('workspaceProfile.envHeading')}
            </div>
            <div className="space-y-1.5">
              {rows.map((row) => (
                <div key={row.id}>
                  <div className="flex items-center gap-1.5">
                    <input
                      className="ui-input flex-1 min-w-0 text-[11px] font-mono"
                      style={invalidIds.has(row.id) ? { borderColor: 'var(--accent-red)' } : undefined}
                      placeholder={t('workspaceProfile.keyPlaceholder')}
                      value={row.key}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(e) => updateRow(row.id, { key: e.target.value })}
                    />
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>=</span>
                    <input
                      className="ui-input flex-1 min-w-0 text-[11px] font-mono"
                      placeholder={t('workspaceProfile.valuePlaceholder')}
                      value={row.value}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    />
                    <button
                      className="text-[var(--text-subtle)] hover:text-[var(--accent-red)] text-[12px] px-1 flex-shrink-0"
                      title={t('workspaceProfile.removeRow')}
                      aria-label={t('workspaceProfile.removeRow')}
                      onClick={() => removeRow(row.id)}
                    >
                      ✕
                    </button>
                  </div>
                  {invalidIds.has(row.id) && (
                    <div className="text-[10px] mt-0.5 ml-0.5" style={{ color: 'var(--accent-red)' }}>
                      {t('workspaceProfile.invalidKey')}
                    </div>
                  )}
                  {secretIds.has(row.id) && !invalidIds.has(row.id) && (
                    <div className="text-[10px] mt-0.5 ml-0.5" style={{ color: 'var(--accent-yellow)' }}>
                      {t('workspaceProfile.secretKeyWarning')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Startup command */}
          <div>
            <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-sub)' }}>
              {t('workspaceProfile.commandHeading')}
            </div>
            <input
              className="ui-input text-[11px] font-mono"
              placeholder={t('workspaceProfile.commandPlaceholder')}
              value={command}
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>

          {/* Startup directory (issue #175) */}
          <div>
            <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-sub)' }}>
              {t('workspaceProfile.startupCwdHeading')}
            </div>
            <input
              className="ui-input text-[11px] font-mono"
              placeholder={t('workspaceProfile.startupCwdPlaceholder')}
              value={startupCwd}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setStartupCwd(e.target.value)}
            />
            <div className="text-[10px] mt-0.5 ml-0.5" style={{ color: 'var(--text-muted)' }}>
              {t('workspaceProfile.startupCwdHint')}
            </div>
          </div>

          {/* Warnings */}
          <div className="space-y-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            <div>⚠ {t('workspaceProfile.warningNewPanes')}</div>
            <div>{t('workspaceProfile.warningNotSandbox')}</div>
            <div>{t('workspaceProfile.warningPlaintext')}</div>
          </div>
        </div>

        <div
          className="px-5 py-3 flex justify-end gap-2 border-t"
          style={{ borderColor: 'var(--bg-overlay)' }}
        >
          <Button variant="secondary" onClick={onClose}>
            {t('workspaceProfile.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave}>
            {t('workspaceProfile.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
