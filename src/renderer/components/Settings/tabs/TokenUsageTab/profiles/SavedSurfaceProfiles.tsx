import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProfileApplyAggregateResult,
  ProfilePreviewResult,
  SurfaceProfile,
} from '../../../../../../shared/tokenUsage/profileTypes';
import type { SurfaceProviderId } from '../../../../../../shared/tokenUsage/surfaceTypes';
import Button from '../../../../ui/Button';
import Input from '../../../../ui/Input';
import Badge from '../../../../ui/Badge';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../../../../ui/Dialog';
import { useT } from '../../../../../hooks/useT';

const PROVIDER_NAMES: Record<SurfaceProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Agy',
};

export interface SavedSurfaceProfilesProps {
  onApplied?: () => void;
  t?: (key: string, vars?: Record<string, string | number>) => string;
}

export function SavedSurfaceProfiles({ onApplied, t: tProp }: SavedSurfaceProfilesProps = {}) {
  const hookT = useT();
  const t = tProp ?? hookT;
  const [profiles, setProfiles] = useState<SurfaceProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [previewProfileTarget, setPreviewProfileTarget] = useState<SurfaceProfile | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<ProfilePreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [applyTarget, setApplyTarget] = useState<SurfaceProfile | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ProfileApplyAggregateResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<SurfaceProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const listReqIdRef = useRef(0);
  const previewReqIdRef = useRef(0);
  const applyReqIdRef = useRef(0);
  const deleteReqIdRef = useRef(0);
  const saveReqIdRef = useRef(0);

  const loadProfiles = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.listProfiles) {
      return;
    }
    const reqId = ++listReqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.tokenUsage.listProfiles();
      if (reqId === listReqIdRef.current) {
        setProfiles(Array.isArray(res) ? res : []);
      }
    } catch (err) {
      if (reqId === listReqIdRef.current) {
        setError((err as Error).message || t('settings.tokenUsage.failedLoadProfiles'));
      }
    } finally {
      if (reqId === listReqIdRef.current) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleSave = async () => {
    const trimmed = saveName.trim();
    if (!trimmed) {
      setSaveError(t('settings.tokenUsage.nameEmpty'));
      return;
    }
    if (trimmed.length > 40) {
      setSaveError(t('settings.tokenUsage.nameTooLong'));
      return;
    }
    if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.saveProfile) {
      return;
    }

    const reqId = ++saveReqIdRef.current;
    setSaving(true);
    setSaveError(null);

    try {
      const res = await window.electronAPI.tokenUsage.saveProfile({ name: trimmed });
      if (reqId === saveReqIdRef.current) {
        if (res.ok) {
          setSaveName('');
          await loadProfiles();
        } else {
          setSaveError(res.error || t('settings.tokenUsage.failedSave'));
        }
      }
    } catch (err) {
      if (reqId === saveReqIdRef.current) {
        setSaveError((err as Error).message || t('settings.tokenUsage.failedSave'));
      }
    } finally {
      if (reqId === saveReqIdRef.current) {
        setSaving(false);
      }
    }
  };

  const closePreview = () => {
    ++previewReqIdRef.current;
    setPreviewProfileTarget(null);
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const handlePreview = async (profile: SurfaceProfile) => {
    if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.previewProfile) {
      return;
    }

    setPreviewProfileTarget(profile);
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(true);

    const reqId = ++previewReqIdRef.current;

    try {
      const res = await window.electronAPI.tokenUsage.previewProfile(profile.id);
      if (reqId === previewReqIdRef.current) {
        setPreviewData(res);
      }
    } catch (err) {
      if (reqId === previewReqIdRef.current) {
        setPreviewError((err as Error).message || t('settings.tokenUsage.failedPreviewProfile'));
      }
    } finally {
      if (reqId === previewReqIdRef.current) {
        setPreviewLoading(false);
      }
    }
  };

  const handleConfirmApply = async () => {
    if (!applyTarget || typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.applyProfile) {
      return;
    }

    const reqId = ++applyReqIdRef.current;
    setApplying(true);
    setApplyError(null);
    setApplyResult(null);

    try {
      const res = await window.electronAPI.tokenUsage.applyProfile(applyTarget.id);
      if (reqId === applyReqIdRef.current) {
        setApplyResult(res);
        if (res.ok) {
          onApplied?.();
        }
        await loadProfiles();
      }
    } catch (err) {
      if (reqId === applyReqIdRef.current) {
        setApplyError((err as Error).message || t('settings.tokenUsage.failedApplyProfile'));
      }
    } finally {
      if (reqId === applyReqIdRef.current) {
        setApplying(false);
      }
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.deleteProfile) {
      return;
    }

    const reqId = ++deleteReqIdRef.current;
    setDeleting(true);
    setDeleteError(null);

    try {
      await window.electronAPI.tokenUsage.deleteProfile(deleteTarget.id);
      if (reqId === deleteReqIdRef.current) {
        setDeleteTarget(null);
        await loadProfiles();
      }
    } catch (err) {
      if (reqId === deleteReqIdRef.current) {
        setDeleteError((err as Error).message || t('settings.tokenUsage.failedDeleteProfile'));
      }
    } finally {
      if (reqId === deleteReqIdRef.current) {
        setDeleting(false);
      }
    }
  };

  const allBackups = applyResult
    ? Object.values(applyResult.providers).flatMap((p) => p?.backups ?? [])
    : [];

  const safeProfiles = Array.isArray(profiles) ? profiles : [];

  return (
    <div className="mt-4 pt-4 border-t border-[var(--color-border)]" data-testid="saved-surface-profiles">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-[13px] font-medium text-[var(--text-main)] m-0">
            {t('settings.tokenUsage.savedProfilesTitle')}
          </h4>
          <p className="text-[11px] text-[var(--text-sub)] m-0">
            {t('settings.tokenUsage.savedProfilesDesc')}
          </p>
        </div>
      </div>

      <div className="flex gap-2 mb-3">
        <Input
          placeholder={t('settings.tokenUsage.newProfilePlaceholder')}
          value={saveName}
          onChange={(e) => {
            setSaveName(e.target.value);
            if (saveError) setSaveError(null);
          }}
          onInput={(e) => {
            setSaveName((e.target as HTMLInputElement).value);
            if (saveError) setSaveError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleSave();
            }
          }}
          maxLength={40}
          className="flex-1 text-[13px]"
          data-testid="saved-profile-save-input"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSave}
          disabled={saving || !saveName.trim()}
          data-testid="saved-profile-save-btn"
        >
          {saving ? t('settings.tokenUsage.saving') : t('settings.tokenUsage.saveCurrentAs')}
        </Button>
      </div>

      {saveError && (
        <p className="text-[11px] text-[var(--color-danger)] mb-3" data-testid="saved-profile-save-error">
          {saveError}
        </p>
      )}

      {loading && safeProfiles.length === 0 ? (
        <p className="text-[11px] text-[var(--text-sub)]" data-testid="saved-profiles-loading">
          {t('settings.tokenUsage.loadingProfiles')}
        </p>
      ) : error ? (
        <p className="text-[11px] text-[var(--color-danger)]" data-testid="saved-profiles-error">
          {error}
        </p>
      ) : safeProfiles.length === 0 ? (
        <p className="text-[11px] text-[var(--text-muted)] italic" data-testid="saved-profiles-empty">
          {t('settings.tokenUsage.noSavedProfiles')}
        </p>
      ) : (
        <div className="flex flex-col gap-2" data-testid="saved-profiles-list">
          {safeProfiles.map((profile) => {
            const providerEntries = Object.entries(profile?.providers ?? {}) as [
              SurfaceProviderId,
              { knownItemIds: string[]; disabledItemIds: string[] },
            ][];

            return (
              <div
                key={profile.id}
                className="flex items-center justify-between p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--bg-surface)] text-[13px]"
                data-testid={`saved-profile-row-${profile.id}`}
              >
                <div className="flex flex-col gap-1 min-w-0 pr-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-main)] truncate" data-testid="saved-profile-name">
                      {profile.name}
                    </span>
                    <span className="text-[11px] text-[var(--text-sub)]" data-testid="saved-profile-date">
                      {new Date(profile.createdAt).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5" data-testid="saved-profile-disabled-counts">
                    {providerEntries.length === 0 ? (
                      <span className="text-[11px] text-[var(--text-muted)]">{t('settings.tokenUsage.noProvidersCaptured')}</span>
                    ) : (
                      providerEntries.map(([providerId, state]) => (
                        <Badge key={providerId} className="text-[11px]">
                          {t('settings.tokenUsage.providerDisabledCount', {
                            provider: PROVIDER_NAMES[providerId] || providerId,
                            count: state.disabledItemIds.length,
                          })}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handlePreview(profile)}
                    data-testid={`saved-profile-preview-btn-${profile.id}`}
                  >
                    {t('settings.tokenUsage.preview')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setApplyTarget(profile);
                      setApplyResult(null);
                      setApplyError(null);
                    }}
                    data-testid={`saved-profile-apply-btn-${profile.id}`}
                  >
                    {t('settings.tokenUsage.apply')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setDeleteTarget(profile);
                      setDeleteError(null);
                    }}
                    data-testid={`saved-profile-delete-btn-${profile.id}`}
                  >
                    {t('settings.tokenUsage.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Preview Dialog */}
      {previewProfileTarget && (
        <Dialog onClose={closePreview} width={560}>
          <DialogHeader title={t('settings.tokenUsage.previewProfileTitle', { name: previewProfileTarget.name })} />
          <DialogBody>
            {previewLoading ? (
              <p className="text-[13px] text-[var(--text-sub)]" data-testid="saved-profile-preview-loading">
                {t('settings.tokenUsage.calcPreview')}
              </p>
            ) : previewError ? (
              <p className="text-[13px] text-[var(--color-danger)]" data-testid="saved-profile-preview-error">
                {previewError}
              </p>
            ) : previewData ? (
              <div className="flex flex-col gap-4 text-[13px]" data-testid="saved-profile-preview-content">
                <div className="flex gap-4 p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--bg-surface)]">
                  <div>
                    <span className="text-[11px] text-[var(--text-sub)] block">
                      {t('settings.tokenUsage.missingItems')}
                    </span>
                    <span className="font-medium text-[var(--text-main)]" data-testid="preview-missing-count">
                      {previewData.missing.count}
                    </span>
                    {previewData.missing.firstFewIds.length > 0 && (
                      <span className="block text-[11px] text-[var(--text-sub)] mt-0.5 ui-code truncate max-w-xs">
                        {previewData.missing.firstFewIds.join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="border-l border-[var(--color-border)] pl-4">
                    <span className="text-[11px] text-[var(--text-sub)] block">
                      {t('settings.tokenUsage.newItemsSinceCapture')}
                    </span>
                    <span className="font-medium text-[var(--text-main)]" data-testid="preview-new-count">
                      {previewData.newItems}
                    </span>
                  </div>
                </div>

                {Object.entries(previewData.providers).map(([providerId, provPreview]) => (
                  <div
                    key={providerId}
                    className="p-3 rounded-lg border border-[var(--color-border)] flex flex-col gap-2"
                    data-testid={`preview-provider-${providerId}`}
                  >
                    <div className="flex items-center justify-between">
                      <h5 className="font-medium text-[var(--text-main)] m-0">
                        {PROVIDER_NAMES[providerId as SurfaceProviderId] || providerId}
                      </h5>
                      <span className="text-[11px] text-[var(--text-sub)]">
                        {t('settings.tokenUsage.provStats', {
                          rejected: provPreview?.rejected.length ?? 0,
                          missing: provPreview?.missingCount ?? 0,
                          newCount: provPreview?.newItemsCount ?? 0,
                        })}
                      </span>
                    </div>

                    {provPreview && provPreview.edits.length > 0 ? (
                      <div className="flex flex-col gap-1.5 mt-1">
                        <span className="text-[11px] text-[var(--text-sub)] font-medium">
                          {t('settings.tokenUsage.fileEditsLabel')}
                        </span>
                        {provPreview.edits.map((edit, idx) => (
                          <div
                            key={idx}
                            className="ui-code text-[11px] p-1.5 rounded bg-[var(--bg-surface)] text-[var(--text-sub)] border border-[var(--color-border)]"
                          >
                            <span className="text-[var(--text-main)] block">{edit.path}</span>
                            <span>{edit.summary}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-[var(--text-muted)] italic m-0">
                        {t('settings.tokenUsage.noEditsNeeded')}
                      </p>
                    )}

                    {provPreview && provPreview.rejected.length > 0 && (
                      <div className="flex flex-col gap-1 mt-1 text-[var(--color-danger)] text-[11px]">
                        <span className="font-medium">{t('settings.tokenUsage.rejectedChangesLabel')}</span>
                        {provPreview.rejected.map((r, idx) => (
                          <span key={idx}>
                            {r.itemId}: {r.reason}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={closePreview}>
              {t('settings.close')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {/* Apply Confirmation Dialog */}
      {applyTarget && (
        <Dialog onClose={() => { if (!applying) setApplyTarget(null); }} width={480}>
          <DialogHeader title={t('settings.tokenUsage.applyProfileTitle', { name: applyTarget.name })} />
          <DialogBody>
            {applyResult ? (
              <div className="flex flex-col gap-2 text-[13px]" data-testid="saved-profile-apply-result">
                {applyResult.ok ? (
                  applyResult.nothingToChange ? (
                    <>
                      <p className="text-[var(--text-main)] font-medium m-0">{t('settings.tokenUsage.alreadyUpToDate')}</p>
                      <p className="text-[11px] text-[var(--text-sub)] m-0">{t('settings.tokenUsage.noChangesNeeded')}</p>
                    </>
                  ) : (
                    <>
                      <p className="text-[var(--text-main)] font-medium m-0">{t('settings.tokenUsage.profileAppliedSuccess')}</p>
                      <p className="text-[11px] text-[var(--text-sub)] m-0">{t('settings.tokenUsage.nextSessionNoticeShort')}</p>
                      {allBackups.length > 0 && (
                        <div className="mt-2 text-[11px] text-[var(--text-sub)]">
                          <span className="font-medium block text-[var(--text-main)]">{t('settings.tokenUsage.backupsCreated')}</span>
                          <ul className="list-disc list-inside m-0 pl-1 ui-code">
                            {allBackups.map((b, idx) => (
                              <li key={idx}>{b}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )
                ) : (
                  <div>
                    <p className="text-[var(--color-danger)] m-0">{t('settings.tokenUsage.failedApplySome')}</p>
                    {Object.entries(applyResult.providers).map(([pId, pRes]) => (
                      <p key={pId} className="text-[11px] text-[var(--color-danger)] m-0 mt-1">
                        {PROVIDER_NAMES[pId as SurfaceProviderId] || pId}: {pRes?.error || t('settings.tokenUsage.failed')}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[13px]">
                <p className="text-[var(--text-main)] m-0">
                  {t('settings.tokenUsage.confirmApplyPrompt', { name: applyTarget.name })}
                </p>
                <p className="text-[11px] text-[var(--text-sub)] mt-1 mb-0">
                  {t('settings.tokenUsage.confirmApplySubtext')}
                </p>
                {applyError && <p className="text-[11px] text-[var(--color-danger)] mt-2 mb-0">{applyError}</p>}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            {applyResult ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setApplyTarget(null);
                  setApplyResult(null);
                }}
              >
                {t('settings.tokenUsage.done')}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setApplyTarget(null)} disabled={applying}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleConfirmApply}
                  disabled={applying}
                  data-testid="saved-profile-confirm-apply-btn"
                >
                  {applying ? t('settings.tokenUsage.applying') : t('settings.tokenUsage.applyProfileBtn')}
                </Button>
              </>
            )}
          </DialogFooter>
        </Dialog>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <Dialog onClose={() => { if (!deleting) setDeleteTarget(null); }} width={420}>
          <DialogHeader title={t('settings.tokenUsage.deleteProfileTitle')} />
          <DialogBody>
            <div className="text-[13px]">
              <p className="text-[var(--text-main)] m-0">
                {t('settings.tokenUsage.confirmDeletePrompt', { name: deleteTarget.name })}
              </p>
              <p className="text-[11px] text-[var(--text-sub)] mt-1 mb-0">{t('settings.tokenUsage.cannotBeUndone')}</p>
              {deleteError && <p className="text-[11px] text-[var(--color-danger)] mt-2 mb-0">{deleteError}</p>}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmDelete}
              disabled={deleting}
              data-testid="saved-profile-confirm-delete-btn"
            >
              {deleting ? t('settings.tokenUsage.deleting') : t('settings.tokenUsage.delete')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
