import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  ProviderInventory,
  SurfaceApplyResult,
  SurfaceChange,
  SurfaceItem,
  SurfacePreview,
  SurfaceProviderId,
} from '../../../../../shared/tokenUsage/surfaceTypes';
import { SettingNote, SettingsSection } from '../../SettingsLayout';
import { useT } from '../../../../hooks/useT';
import Badge from '../../../ui/Badge';
import Button from '../../../ui/Button';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../../../ui/Dialog';
import { CustomBuiltinsGroup } from './custom/CustomBuiltinsGroup';
import { CustomControls } from './custom/CustomControls';
import { CustomHooksGroup } from './custom/CustomHooksGroup';
import { CustomMcpGroup } from './custom/CustomMcpGroup';
import { CustomPluginsGroup } from './custom/CustomPluginsGroup';
import { CustomSkillsGroup } from './custom/CustomSkillsGroup';
import { CustomWarnings } from './custom/CustomWarnings';
import { CustomWmuxToolsGroup } from './custom/CustomWmuxToolsGroup';
import type { SurfaceDriftedItem, SurfaceReconcileResult } from '../../../../../main/surfaces/reconcile/types';

export interface CustomPanelProps {
  t?: (key: string, vars?: Record<string, string | number>) => string;
  providers?: SurfaceProviderId[];
  onApplied?: () => void;
}

function areStagedMapsEqual(a: Map<string, boolean>, b: Map<string, boolean>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

/**
 * Asserts that an item's provider matches the expected provider.
 */
export function assertProviderMatches(
  itemId: string,
  actualProvider: string | null | undefined,
  expectedProvider: SurfaceProviderId,
): void {
  if (actualProvider !== expectedProvider) {
    throw new Error(
      `Assertion failed: staged change for ${itemId} has provider "${actualProvider}", expected "${expectedProvider}"`,
    );
  }
}

/**
 * Builds the list of changes for a preview or apply payload.
 * Only staged entries whose provider equals requestProvider are included.
 * Asserts that every change in the payload strictly belongs to requestProvider.
 */
export function buildPayloadChanges(
  stagedChanges: Map<string, boolean> | Iterable<[string, boolean]>,
  requestProvider: SurfaceProviderId,
  inventory?: { items?: Array<{ id: string; provider: SurfaceProviderId }> } | null,
): SurfaceChange[] {
  const entries = stagedChanges instanceof Map ? stagedChanges.entries() : stagedChanges;
  const changes: SurfaceChange[] = [];

  for (const [itemId, enabled] of entries) {
    const item = inventory?.items?.find((i) => i.id === itemId);
    const itemProvider =
      item?.provider ?? (itemId.includes(':') ? (itemId.split(':')[0] as SurfaceProviderId) : null);

    if (itemProvider === requestProvider) {
      changes.push({ itemId, enabled });
    }
  }

  // Pure helper assertion: verify every built payload entry equals the request provider
  for (const change of changes) {
    const item = inventory?.items?.find((i) => i.id === change.itemId);
    const itemProvider =
      item?.provider ?? (change.itemId.includes(':') ? (change.itemId.split(':')[0] as SurfaceProviderId) : null);
    assertProviderMatches(change.itemId, itemProvider, requestProvider);
  }

  return changes;
}

export interface ProviderInventoryState {
  provider: SurfaceProviderId;
  inventory: ProviderInventory;
}

const ALL_SURFACE_PROVIDERS: readonly SurfaceProviderId[] = ['claude', 'codex', 'agy'] as const;

export function CustomPanel(props: CustomPanelProps): ReactElement {
  const fallbackT = useT();
  const t = props?.t ?? fallbackT;
  const { providers: propsProviders, onApplied } = props || {};
  const title = t('settings.tokenProfileCustom');
  const initialProvider: SurfaceProviderId =
    propsProviders && propsProviders.length > 0 && !propsProviders.includes('claude')
      ? propsProviders[0]
      : 'claude';
  const [provider, setProvider] = useState<SurfaceProviderId>(initialProvider);
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [inventoryState, setInventoryState] = useState<ProviderInventoryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInventoryLoaded = inventoryState !== null && inventoryState.provider === provider;
  const inventory = isInventoryLoaded ? inventoryState.inventory : null;

  const [stagedChanges, setStagedChanges] = useState<Map<string, boolean>>(new Map());
  const [rejectedFlags, setRejectedFlags] = useState<Map<string, string>>(new Map());
  const [pendingProvider, setPendingProvider] = useState<SurfaceProviderId | null>(null);

  const [reconcileResult, setReconcileResult] = useState<SurfaceReconcileResult | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [couldNotReapplyCount, setCouldNotReapplyCount] = useState(0);
  const reconcileReqIdRef = useRef(0);
  const latestReconcileReqRef = useRef<{ id: number; provider: SurfaceProviderId }>({
    id: 0,
    provider: initialProvider,
  });

  const baseProviders =
    propsProviders && propsProviders.length > 0 ? propsProviders : ALL_SURFACE_PROVIDERS;
  const visibleSet = new Set(baseProviders);
  if (stagedChanges.size > 0) {
    visibleSet.add(provider);
  }
  const effectiveProviders = ALL_SURFACE_PROVIDERS.filter((p) => visibleSet.has(p));

  useEffect(() => {
    if (!effectiveProviders.includes(provider) && effectiveProviders.length > 0) {
      setProvider(effectiveProviders[0]);
    }
  }, [effectiveProviders, provider]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<SurfacePreview | null>(null);
  // The staged set the shown preview was made for. Apply sends exactly this, and only while it still
  // equals what is staged, so a change the user never previewed cannot be written.
  const [previewedStaged, setPreviewedStaged] = useState<{
    provider: SurfaceProviderId;
    staged: Map<string, boolean>;
  } | null>(null);
  const [confirmingWmux, setConfirmingWmux] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<SurfaceApplyResult | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const providerRef = useRef(provider);
  providerRef.current = provider;

  const stagedChangesRef = useRef(stagedChanges);
  stagedChangesRef.current = stagedChanges;

  const inventoryReqIdRef = useRef(0);
  const latestInventoryReqRef = useRef<{ id: number; provider: SurfaceProviderId }>({
    id: 0,
    provider: 'claude',
  });

  const previewReqIdRef = useRef(0);
  const latestPreviewReqRef = useRef<{ id: number; provider: SurfaceProviderId } | null>(null);

  const applyingProviderRef = useRef<SurfaceProviderId | null>(null);
  const applyingItemIdsRef = useRef<Set<string>>(new Set());

  const fetchInventory = useCallback(async (p: SurfaceProviderId) => {
    if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.readInventory) {
      return;
    }
    const reqId = ++inventoryReqIdRef.current;
    if (p === providerRef.current) {
      latestInventoryReqRef.current = { id: reqId, provider: p };
      setLoading(true);
      setError(null);
    }
    try {
      const res = await window.electronAPI.tokenUsage.readInventory({ provider: p });
      if (!isMountedRef.current) return;
      if (
        latestInventoryReqRef.current.id !== reqId ||
        latestInventoryReqRef.current.provider !== p ||
        providerRef.current !== p
      ) {
        return;
      }
      setInventoryState({ provider: p, inventory: res });
      setError(null);
      setNoticeDismissed(false);
      setCouldNotReapplyCount(0);

      if (window.electronAPI?.tokenUsage?.reconcileSurface) {
        const recId = ++reconcileReqIdRef.current;
        latestReconcileReqRef.current = { id: recId, provider: p };
        window.electronAPI.tokenUsage
          .reconcileSurface(p)
          .then((recRes) => {
            if (!isMountedRef.current) return;
            if (
              latestReconcileReqRef.current.id !== recId ||
              latestReconcileReqRef.current.provider !== p ||
              providerRef.current !== p
            ) {
              return;
            }
            setReconcileResult(recRes);
          })
          .catch(() => {
            // ignore reconcile error
          });
      }
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (
        latestInventoryReqRef.current.id !== reqId ||
        latestInventoryReqRef.current.provider !== p ||
        providerRef.current !== p
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (
        isMountedRef.current &&
        latestInventoryReqRef.current.id === reqId &&
        latestInventoryReqRef.current.provider === p &&
        providerRef.current === p
      ) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setReconcileResult(null);
    setNoticeDismissed(false);
    setCouldNotReapplyCount(0);
    latestReconcileReqRef.current = { id: ++reconcileReqIdRef.current, provider };
    void fetchInventory(provider);
  }, [provider, fetchInventory]);

  const handleToggle = useCallback(
    (itemId: string) => {
      if (
        applying &&
        applyingProviderRef.current === provider &&
        applyingItemIdsRef.current.has(itemId)
      ) {
        return;
      }
      if (!isInventoryLoaded || !inventory || inventory.provider !== provider) return;
      const item = inventory.items.find((i) => i.id === itemId);
      if (!item || !item.toggleable || item.provider !== provider) return;
      const originalEnabled = item.enabled !== false;
      const current = stagedChanges.has(itemId) ? stagedChanges.get(itemId)! : originalEnabled;
      const next = !current;
      setStagedChanges((prev) => {
        const copy = new Map(prev);
        if (next === originalEnabled) {
          copy.delete(itemId);
        } else {
          copy.set(itemId, next);
        }
        return copy;
      });
    },
    [applying, inventory, isInventoryLoaded, provider, stagedChanges],
  );

  const handleBatchToggle = useCallback(
    (updates: Array<{ itemId: string; next: boolean }>) => {
      if (applying) return;
      if (!isInventoryLoaded || !inventory || inventory.provider !== provider) return;
      setStagedChanges((prev) => {
        const copy = new Map(prev);
        for (const { itemId, next } of updates) {
          if (
            applyingProviderRef.current === provider &&
            applyingItemIdsRef.current.has(itemId)
          ) {
            continue;
          }
          const item = inventory.items.find((i) => i.id === itemId);
          if (!item || !item.toggleable || item.provider !== provider) continue;
          const originalEnabled = item.enabled !== false;
          if (next === originalEnabled) {
            copy.delete(itemId);
          } else {
            copy.set(itemId, next);
          }
        }
        return copy;
      });
    },
    [applying, inventory, isInventoryLoaded, provider],
  );

  const handleDiscard = useCallback(() => {
    if (applying) return;
    setStagedChanges(new Map());
    setRejectedFlags(new Map());
  }, [applying]);

  const handleProviderChange = useCallback(
    (newProvider: SurfaceProviderId) => {
      if (newProvider === provider) return;
      if (stagedChanges.size > 0) {
        setPendingProvider(newProvider);
      } else {
        setReconcileResult(null);
        setNoticeDismissed(false);
        setCouldNotReapplyCount(0);
        latestReconcileReqRef.current = { id: ++reconcileReqIdRef.current, provider: newProvider };
        setProvider(newProvider);
        setPreviewOpen(false);
        setApplyResult(null);
      }
    },
    [provider, stagedChanges.size],
  );

  const handleConfirmProviderSwitch = useCallback(() => {
    if (pendingProvider) {
      setStagedChanges(new Map());
      setRejectedFlags(new Map());
      setReconcileResult(null);
      setNoticeDismissed(false);
      setCouldNotReapplyCount(0);
      latestReconcileReqRef.current = { id: ++reconcileReqIdRef.current, provider: pendingProvider };
      setProvider(pendingProvider);
      setPendingProvider(null);
      setPreviewOpen(false);
      setApplyResult(null);
    }
  }, [pendingProvider]);

  const handleCancelProviderSwitch = useCallback(() => {
    setPendingProvider(null);
  }, []);

  const handlePreviewClick = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.previewChanges) {
      return;
    }
    if (applying) return;

    const reqId = ++previewReqIdRef.current;
    const requestProvider = provider;
    latestPreviewReqRef.current = { id: reqId, provider: requestProvider };
    const stagedSnapshot = new Map(stagedChanges);

    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewData(null);
    setPreviewedStaged(null);
    setPreviewError(null);
    setConfirmingWmux(false);
    setApplyResult(null);

    const changes: SurfaceChange[] = buildPayloadChanges(stagedSnapshot, requestProvider, inventory);

    try {
      const preview = await window.electronAPI.tokenUsage.previewChanges({
        provider: requestProvider,
        changes,
      });

      if (!isMountedRef.current) return;
      if (
        !latestPreviewReqRef.current ||
        latestPreviewReqRef.current.id !== reqId ||
        latestPreviewReqRef.current.provider !== providerRef.current ||
        !areStagedMapsEqual(stagedSnapshot, stagedChangesRef.current)
      ) {
        return;
      }

      setPreviewData(preview);
      const previewed = new Map(stagedSnapshot);
      for (const rej of preview.rejected ?? []) previewed.delete(rej.itemId);
      setPreviewedStaged({ provider: requestProvider, staged: previewed });
      if (preview.rejected && preview.rejected.length > 0) {
        setStagedChanges((prev) => {
          const next = new Map(prev);
          for (const rej of preview.rejected) {
            next.delete(rej.itemId);
          }
          return next;
        });
        setRejectedFlags((prev) => {
          const next = new Map(prev);
          for (const rej of preview.rejected) {
            next.set(rej.itemId, rej.reason);
          }
          return next;
        });
      }
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      if (
        !latestPreviewReqRef.current ||
        latestPreviewReqRef.current.id !== reqId ||
        latestPreviewReqRef.current.provider !== providerRef.current ||
        !areStagedMapsEqual(stagedSnapshot, stagedChangesRef.current)
      ) {
        return;
      }
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMountedRef.current && latestPreviewReqRef.current?.id === reqId) {
        setPreviewLoading(false);
      }
    }
  }, [applying, inventory, provider, stagedChanges]);

  const canApply =
    !previewLoading &&
    !applying &&
    previewData !== null &&
    previewedStaged !== null &&
    previewedStaged.provider === provider &&
    previewedStaged.staged.size > 0 &&
    areStagedMapsEqual(previewedStaged.staged, stagedChanges);

  const executeApply = useCallback(
    async (allowWmux: boolean) => {
      if (typeof window === 'undefined' || !window.electronAPI?.tokenUsage?.applyChanges) {
        return;
      }
      if (applying || !canApply || !previewedStaged) return;

      const applyProvider = previewedStaged.provider;
      const changes: SurfaceChange[] = buildPayloadChanges(previewedStaged.staged, applyProvider, inventory);
      const requestItemIds = changes.map((c) => c.itemId);

      setApplying(true);
      applyingProviderRef.current = applyProvider;
      applyingItemIdsRef.current = new Set(requestItemIds);
      setPreviewError(null);

      try {
        const result = await window.electronAPI.tokenUsage.applyChanges({
          provider: applyProvider,
          changes,
          allowWmuxRequired: allowWmux ? true : undefined,
        });

        if (!isMountedRef.current) return;

        const providerChanged = providerRef.current !== applyProvider;

        if (result.ok) {
          if (!providerChanged) {
            const appliedIds =
              result.appliedItemIds && result.appliedItemIds.length > 0
                ? result.appliedItemIds
                : requestItemIds;
            const appliedSet = new Set(appliedIds);

            setStagedChanges((prev) => {
              const next = new Map(prev);
              for (const id of appliedSet) {
                next.delete(id);
              }
              return next;
            });
            setRejectedFlags((prev) => {
              const next = new Map(prev);
              for (const id of appliedSet) {
                next.delete(id);
              }
              return next;
            });
            setConfirmingWmux(false);
            setPreviewedStaged(null);
            setApplyResult(result);
            onApplied?.();
          }
        } else {
          if (!providerChanged) {
            setApplyResult(result);
          }
        }

        // always trigger an inventory reload for the provider the request was for (guarded by rule 1)
        void fetchInventory(applyProvider);
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        const providerChanged = providerRef.current !== applyProvider;
        if (!providerChanged) {
          setApplyResult({
            provider: applyProvider,
            ok: false,
            appliedItemIds: [],
            backups: [],
            error: errMsg,
          });
        }
        // always trigger an inventory reload for the provider the request was for (guarded by rule 1)
        void fetchInventory(applyProvider);
      } finally {
        if (isMountedRef.current) {
          setApplying(false);
          applyingProviderRef.current = null;
          applyingItemIdsRef.current.clear();
        }
      }
    },
    [applying, canApply, fetchInventory, inventory, onApplied, previewedStaged],
  );

  const handleApplyClick = useCallback(() => {
    if (!canApply || !previewedStaged) return;
    const changes = buildPayloadChanges(previewedStaged.staged, previewedStaged.provider, inventory);
    const stagedItems = changes
      .map((c) => inventory?.items.find((i) => i.id === c.itemId))
      .filter((i): i is SurfaceItem => i !== undefined);

    const hasWmux = stagedItems.some((i) => i.wmuxRequired);
    if (hasWmux && !confirmingWmux) {
      setConfirmingWmux(true);
      return;
    }
    void executeApply(hasWmux && confirmingWmux);
  }, [canApply, confirmingWmux, executeApply, inventory, previewedStaged]);

  const filteredItems = useMemo(() => {
    if (!inventory) return [];
    return inventory.items.filter((item) => {
      const isStaged = stagedChanges.has(item.id);
      const effectiveEnabled = isStaged ? stagedChanges.get(item.id)! : item.enabled !== false;
      if (onlyChanged && effectiveEnabled) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = item.name.toLowerCase().includes(q);
        const matchesParent = item.parent ? item.parent.toLowerCase().includes(q) : false;
        const matchesOrigin = item.originPath ? item.originPath.toLowerCase().includes(q) : false;
        if (!matchesName && !matchesParent && !matchesOrigin) return false;
      }
      return true;
    });
  }, [inventory, onlyChanged, searchQuery, stagedChanges]);

  const mcpServers = useMemo(
    () => filteredItems.filter((i) => i.kind === 'mcp-server'),
    [filteredItems],
  );
  const allMcpServers = useMemo(
    () => (inventory ? inventory.items.filter((i) => i.kind === 'mcp-server') : []),
    [inventory],
  );
  const mcpTools = useMemo(
    () => filteredItems.filter((i) => i.kind === 'mcp-tool' && i.parent !== 'wmux'),
    [filteredItems],
  );
  const allMcpTools = useMemo(
    () => (inventory ? inventory.items.filter((i) => i.kind === 'mcp-tool' && i.parent !== 'wmux') : []),
    [inventory],
  );
  const wmuxTools = useMemo(
    () => filteredItems.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux'),
    [filteredItems],
  );
  const allWmuxTools = useMemo(
    () => (inventory ? inventory.items.filter((i) => i.kind === 'mcp-tool' && i.parent === 'wmux') : []),
    [inventory],
  );
  const skills = useMemo(
    () => filteredItems.filter((i) => i.kind === 'skill'),
    [filteredItems],
  );
  const plugins = useMemo(
    () => filteredItems.filter((i) => i.kind === 'plugin'),
    [filteredItems],
  );
  const hooks = useMemo(
    () => filteredItems.filter((i) => i.kind === 'hook'),
    [filteredItems],
  );
  const builtins = useMemo(
    () => filteredItems.filter((i) => i.kind === 'builtin-tool' || i.kind === 'context-setting'),
    [filteredItems],
  );

  const totalReconcileChanged =
    (reconcileResult?.driftedCount ?? reconcileResult?.driftedItems.length ?? 0) +
    (reconcileResult?.newItems ?? 0) +
    (reconcileResult?.removedItems ?? 0);

  const showReconcileNotice = isInventoryLoaded && !noticeDismissed && totalReconcileChanged > 0;
  const displayedNames = (reconcileResult?.driftedItems.map((d: SurfaceDriftedItem) => d.name) ?? []).slice(0, 5);
  const truncatedCount =
    (reconcileResult?.driftedCount ?? 0) - (reconcileResult?.driftedItems.length ?? 0);

  const handleReapplyChoices = useCallback(() => {
    if (!reconcileResult || reconcileResult.driftedItems.length === 0) return;
    if (!isInventoryLoaded || !inventory || inventory.provider !== provider) return;

    let unstageableCount = 0;
    const stageableUpdates: Array<{ id: string; wanted: boolean; originalEnabled: boolean }> = [];

    for (const d of reconcileResult.driftedItems) {
      const item = inventory.items.find((i) => i.id === d.itemId);
      if (!item || item.provider !== provider || !item.toggleable || item.wmuxRequired) {
        unstageableCount++;
      } else {
        const originalEnabled = item.enabled !== false;
        stageableUpdates.push({ id: d.itemId, wanted: d.wanted, originalEnabled });
      }
    }

    setCouldNotReapplyCount(unstageableCount);

    if (stageableUpdates.length > 0) {
      setStagedChanges((prev) => {
        const copy = new Map(prev);
        for (const { id, wanted, originalEnabled } of stageableUpdates) {
          if (wanted === originalEnabled) {
            copy.delete(id);
          } else {
            copy.set(id, wanted);
          }
        }
        return copy;
      });
    }
  }, [inventory, isInventoryLoaded, provider, reconcileResult]);

  return (
    <SettingsSection
      id="tokencustom"
      title={title}
      data-testid="token-custom-panel"
    >
      <CustomControls
        provider={provider}
        onProviderChange={handleProviderChange}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onlyChanged={onlyChanged}
        onOnlyChangedChange={setOnlyChanged}
        onRefresh={() => void fetchInventory(provider)}
        loading={loading || !isInventoryLoaded}
        providers={effectiveProviders}
      />

      {inventory && (
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-sub)] my-2 flex-wrap">
          <span>{t('settings.tokenUsage.cliVersion')}</span>
          <span className="ui-code text-[var(--text-main)]">
            {inventory.cliVersion ?? t('settings.tokenUsage.notDetected')}
          </span>
          {inventory.cliVersion && (
            <Badge tone={inventory.versionSupported ? 'success' : 'warning'}>
              {inventory.versionSupported ? t('settings.tokenUsage.versionSupported') : t('settings.tokenUsage.versionUnsupported')}
            </Badge>
          )}
        </div>
      )}

      <SettingNote>{t('settings.tokenUsage.nextSessionNotice')}</SettingNote>

      {showReconcileNotice && (
        <div
          className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 my-2 flex flex-col gap-2"
          data-testid="token-custom-reconcile-notice"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-[var(--text-main)]">
                {totalReconcileChanged === 1
                  ? t('settings.tokenUsage.reconcileChangedOne')
                  : t('settings.tokenUsage.reconcileChangedMany', { count: totalReconcileChanged })}
              </span>
              {displayedNames.length > 0 && (
                <span className="text-[11px] text-[var(--text-sub)]" data-testid="token-custom-reconcile-names">
                  {reconcileResult?.truncated && truncatedCount > 0
                    ? t('settings.tokenUsage.reconcileDriftSummary', {
                        names: displayedNames.join(', '),
                        count: truncatedCount,
                      })
                    : t('settings.tokenUsage.reconcileDriftList', {
                        names: displayedNames.join(', '),
                      })}
                </span>
              )}
              {couldNotReapplyCount > 0 && (
                <span className="text-[11px] text-[var(--danger)]" data-testid="token-custom-reconcile-unapplied">
                  {t('settings.tokenUsage.reconcileCouldNotReapply', { count: couldNotReapplyCount })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {reconcileResult && reconcileResult.driftedItems.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleReapplyChoices}
                  data-testid="token-custom-reapply-choices"
                >
                  {t('settings.tokenUsage.reapplyChoices')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNoticeDismissed(true);
                  setCouldNotReapplyCount(0);
                }}
                data-testid="token-custom-reconcile-dismiss"
              >
                {t('settings.tokenUsage.dismiss')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {inventory && <CustomWarnings warnings={inventory.warnings ?? []} />}

      {(!isInventoryLoaded || (loading && !inventory)) && !error && (
        <div className="text-[12px] text-[var(--text-sub)] py-4 text-center">
          {t('settings.tokenUsage.loadingInventory')}
        </div>
      )}

      {error && (
        <div className="text-[12px] text-[var(--danger)] py-3">
          {t('settings.tokenUsage.failedToLoadInventory', { error })}
        </div>
      )}

      {inventory && filteredItems.length === 0 && (
        <div className="text-[12px] text-[var(--text-sub)] py-4 text-center">
          {t('settings.tokenUsage.noMatchingItems')}
        </div>
      )}

      {inventory && (
        <>
          <CustomMcpGroup
            servers={mcpServers}
            tools={mcpTools}
            allServers={allMcpServers}
            allTools={allMcpTools}
            onToggle={handleToggle}
            stagedChanges={stagedChanges}
            rejectedFlags={rejectedFlags}
          />
          {allWmuxTools.length > 0 && (
            <CustomWmuxToolsGroup
              tools={wmuxTools}
              allTools={allWmuxTools}
              onToggle={handleToggle}
              onBatchToggle={handleBatchToggle}
              stagedChanges={stagedChanges}
              rejectedFlags={rejectedFlags}
            />
          )}
          <CustomSkillsGroup
            skills={skills}
            onToggle={handleToggle}
            stagedChanges={stagedChanges}
            rejectedFlags={rejectedFlags}
          />
          <CustomPluginsGroup
            plugins={plugins}
            onToggle={handleToggle}
            stagedChanges={stagedChanges}
            rejectedFlags={rejectedFlags}
          />
          <CustomHooksGroup
            hooks={hooks}
            onToggle={handleToggle}
            stagedChanges={stagedChanges}
            rejectedFlags={rejectedFlags}
          />
          <CustomBuiltinsGroup
            items={builtins}
            onToggle={handleToggle}
            stagedChanges={stagedChanges}
            rejectedFlags={rejectedFlags}
          />
        </>
      )}

      {stagedChanges.size > 0 && (
        <div
          className="sticky bottom-0 z-10 flex items-center justify-between p-3 mt-4 rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] shadow-md"
          data-testid="token-custom-action-bar"
        >
          <div className="flex items-center gap-2">
            <span
              className="text-[13px] font-medium text-[var(--text-main)]"
              data-testid="token-custom-staged-count"
            >
              {stagedChanges.size === 1
                ? t('settings.tokenUsage.stagedCountOne')
                : t('settings.tokenUsage.stagedCountMany', { count: stagedChanges.size })}
            </span>
            <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDiscard}
              disabled={applying}
              data-testid="token-custom-discard"
            >
              {t('settings.tokenUsage.discard')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handlePreviewClick}
              disabled={applying}
              data-testid="token-custom-preview"
            >
              {t('settings.tokenUsage.preview')}
            </Button>
          </div>
        </div>
      )}

      {pendingProvider && (
        <Dialog
          onClose={handleCancelProviderSwitch}
          width={440}
          data-testid="token-custom-discard-dialog"
        >
          <DialogHeader
            title={t('settings.tokenUsage.discardDialogTitle')}
            description={t('settings.tokenUsage.discardDialogDesc')}
            closeLabel={t('settings.close')}
          />
          <DialogBody>
            <p className="text-[13px] text-[var(--text-sub)] m-0">
              {stagedChanges.size === 1
                ? t('settings.tokenUsage.discardDialogBodyOne')
                : t('settings.tokenUsage.discardDialogBodyMany', { count: stagedChanges.size })}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={handleCancelProviderSwitch}
              data-testid="token-custom-stay-btn"
            >
              {t('settings.tokenUsage.stay')}
            </Button>
            <Button
              variant="dangerTinted"
              onClick={handleConfirmProviderSwitch}
              data-testid="token-custom-discard-confirm-btn"
            >
              {t('settings.tokenUsage.discardAndSwitch')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {previewOpen && (
        <Dialog
          onClose={() => {
            setPreviewOpen(false);
            setConfirmingWmux(false);
            setApplyResult(null);
          }}
          width={560}
          data-testid="token-custom-preview-dialog"
        >
          <DialogHeader
            title={t('settings.tokenUsage.previewTitle')}
            description={t('settings.tokenUsage.previewDesc')}
            closeLabel={t('settings.close')}
          />
          <DialogBody className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
            {previewLoading && (
              <div className="text-[12px] text-[var(--text-sub)] py-4 text-center">
                {t('settings.tokenUsage.loadingPreview')}
              </div>
            )}

            {previewError && (
              <div className="text-[12px] text-[var(--danger)] py-2">
                {t('settings.tokenUsage.failedPreview', { error: previewError })}
              </div>
            )}

            {previewData && !applyResult && (
              <>
                {previewData.edits.length === 0 && previewData.rejected.length === 0 && (
                  <div className="text-[12px] text-[var(--text-sub)] py-2">
                    {t('settings.tokenUsage.noEditsToPreview')}
                  </div>
                )}

                {previewData.edits.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-sub)]">
                      {t('settings.tokenUsage.fileEditsHeader', { count: previewData.edits.length })}
                    </span>
                    <div className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-base)] divide-y divide-[var(--border-hairline)] overflow-hidden">
                      {previewData.edits.map((edit, idx) => (
                        <div key={idx} className="p-2.5 flex flex-col gap-1 text-[12px]" data-testid={`preview-edit-${idx}`}>
                          <span className="ui-code text-[11px] text-[var(--text-main)] font-medium">
                            {edit.path}
                          </span>
                          <span className="text-[var(--text-sub)]">
                            {edit.summary}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {previewData.rejected.length > 0 && (
                  <div className="flex flex-col gap-2" data-testid="token-custom-preview-rejected">
                    <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--danger)]">
                      {t('settings.tokenUsage.rejectedChangesHeader', { count: previewData.rejected.length })}
                    </span>
                    <div className="rounded-[10px] border border-[var(--danger)] bg-[var(--bg-base)] divide-y divide-[var(--border-hairline)] overflow-hidden">
                      {previewData.rejected.map((rej, idx) => (
                        <div key={idx} className="p-2.5 flex flex-col gap-0.5 text-[12px]">
                          <span className="font-medium text-[var(--danger)]">
                            {rej.itemId}
                          </span>
                          <span className="text-[var(--text-sub)]">
                            {rej.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                    <span className="text-[11px] text-[var(--text-sub)]">
                      {t('settings.tokenUsage.rejectedUnstaged')}
                    </span>
                  </div>
                )}

                {previewData.requiresNewSession && (
                  <div className="text-[11px] text-[var(--text-sub)]">
                    {t('settings.tokenUsage.nextSessionNoticeShort')}
                  </div>
                )}

                {confirmingWmux && (
                  <div
                    className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[12px] flex flex-col gap-1.5"
                    data-testid="token-custom-wmux-confirm"
                  >
                    <span className="font-semibold text-[var(--accent)]">
                      {t('settings.tokenUsage.wmuxWarningTitle')}
                    </span>
                    <p className="text-[var(--text-main)] m-0">
                      {t('settings.tokenUsage.wmuxWarningDesc')}
                    </p>
                  </div>
                )}
              </>
            )}

            {applyResult && (
              <div className="flex flex-col gap-3 py-2" data-testid="token-custom-apply-result">
                {applyResult.ok ? (
                  <>
                    <div className="text-[13px] font-medium text-[var(--success)]">
                      {t('settings.tokenUsage.applySuccess')}
                    </div>
                    {applyResult.backups.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-semibold text-[var(--text-sub)] uppercase tracking-wider">
                          {t('settings.tokenUsage.backupsCreated')}
                        </span>
                        <ul className="list-disc pl-5 m-0 text-[11px] ui-code text-[var(--text-sub)] space-y-1">
                          {applyResult.backups.map((b, i) => (
                            <li key={i}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="text-[12px] text-[var(--text-sub)]">
                      {t('settings.tokenUsage.nextSessionNoticeShort')}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="text-[13px] font-medium text-[var(--danger)]">
                      {t('settings.tokenUsage.applyFailed', { error: applyResult.error ?? '' })}
                    </div>
                    <div className="text-[12px] text-[var(--text-sub)]">
                      {t('settings.tokenUsage.applyFailedCheck')}
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            {!applyResult ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (confirmingWmux) {
                      setConfirmingWmux(false);
                    } else {
                      setPreviewOpen(false);
                    }
                  }}
                  disabled={applying}
                  data-testid="token-custom-preview-back"
                >
                  {confirmingWmux ? t('common.cancel') : t('settings.tokenUsage.back')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleApplyClick}
                  disabled={!canApply}
                  data-testid="token-custom-apply"
                >
                  {applying
                    ? t('settings.tokenUsage.applying')
                    : confirmingWmux
                    ? t('settings.tokenUsage.confirmAndApply')
                    : t('settings.tokenUsage.apply')}
                </Button>
              </>
            ) : (
              <>
                {!applyResult.ok && (
                  <Button
                    variant="secondary"
                    onClick={() => setApplyResult(null)}
                    data-testid="token-custom-apply-back"
                  >
                    {t('settings.tokenUsage.back')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => {
                    if (applyResult.ok) {
                      setPreviewOpen(false);
                      setApplyResult(null);
                    } else {
                      handleApplyClick();
                    }
                  }}
                  disabled={!applyResult.ok && !canApply}
                  data-testid={applyResult.ok ? 'token-custom-apply-done' : 'token-custom-apply-retry'}
                >
                  {applyResult.ok ? t('settings.tokenUsage.done') : t('settings.tokenUsage.retry')}
                </Button>
              </>
            )}
          </DialogFooter>
        </Dialog>
      )}
    </SettingsSection>
  );
}
