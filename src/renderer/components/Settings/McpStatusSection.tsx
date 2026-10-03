import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { useStore } from '../../stores';
import { IconCheck } from '../icons';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { SettingsSection, SettingNote } from './SettingsLayout';
import { MCP_STATUS_CHANGED_EVENT } from './IntegrationSetupSection';
import type {
  McpStatusPayload,
  McpTargetStatusPayload,
  McpRegisterTargetResult,
} from '../../../preload/preload';

export interface ElectronMcpApi {
  check: () => Promise<McpStatusPayload>;
  reregister: () => Promise<McpStatusPayload>;
  unregister: () => Promise<McpStatusPayload>;
  registerTarget?: (targetId: string) => Promise<McpRegisterTargetResult>;
}

export const KNOWN_MCP_REGISTRATION_ERRORS: readonly string[] = [
  'The CLI config file was not found',
  'The config file could not be updated',
  'Registration is unavailable right now',
];

export function sanitizeRegistrationError(error: string): string {
  if (KNOWN_MCP_REGISTRATION_ERRORS.includes(error)) {
    return error;
  }
  // Keep the existing fixed sentences already used for "isolated instance"
  if (error.startsWith('WMUX_DATA_SUFFIX=') && error.includes('skipping external agent config registration')) {
    return error;
  }
  return 'Registration failed';
}

export function announceMcpChange(): void {
  window.dispatchEvent(new CustomEvent(MCP_STATUS_CHANGED_EVENT));
}

export function McpStatusSection({ api }: { api?: ElectronMcpApi } = {}) {
  const t = useT();
  const [status, setStatus] = useState<McpStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingUnregister, setConfirmingUnregister] = useState(false);
  const [pending, setPending] = useState<'reregister' | 'unregister' | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN'] });

  const mcpApi = api ?? (window.electronAPI as unknown as { mcp?: ElectronMcpApi })?.mcp;

  const refresh = useCallback(async () => {
    if (!mcpApi) {
      setLoading(false);
      return;
    }
    const result = await ipcInvoke(() => mcpApi.check());
    if (result.ok) setStatus(result.data);
    setLoading(false);
  }, [ipcInvoke, mcpApi]);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(MCP_STATUS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MCP_STATUS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const handleReregister = useCallback(async () => {
    if (!mcpApi) return;
    setPending('reregister');
    const result = await ipcInvoke(() => mcpApi.reregister());
    if (result.ok) setStatus(result.data);
    setPending(null);
    announceMcpChange();
  }, [ipcInvoke, mcpApi]);

  const handleUnregister = useCallback(async () => {
    if (!mcpApi) return;
    setPending('unregister');
    const result = await ipcInvoke(() => mcpApi.unregister());
    if (result.ok) setStatus(result.data);
    setPending(null);
    announceMcpChange();
    setConfirmingUnregister(false);
  }, [ipcInvoke, mcpApi]);

  const handleRegisterTarget = useCallback(
    async (targetId: string, displayName: string) => {
      if (!mcpApi?.registerTarget) return;
      setPendingTarget(targetId);
      try {
        const result = await ipcInvoke(() => mcpApi.registerTarget!(targetId));
        if (result.ok) {
          const res = result.data;
          if (res.status) setStatus(res.status);
          announceMcpChange();
          if (res.success) {
            useStore.getState().pushToast?.({
              level: 'info',
              message: t('settings.mcpTargetRegistered', { name: displayName }),
            });
          } else if (res.error) {
            useStore.getState().pushToast?.({
              level: 'error',
              message: sanitizeRegistrationError(res.error),
            });
          }
        }
      } finally {
        setPendingTarget(null);
      }
    },
    [ipcInvoke, mcpApi, t],
  );

  if (!mcpApi && !loading) return null;

  const isBusy = pending !== null || pendingTarget !== null;

  const renderTarget = (target: McpTargetStatusPayload) => {
    const isTargetPending = pendingTarget === target.id;
    const isRegistered = target.wmux?.registered === true;
    const actionLabel = isTargetPending
      ? '…'
      : isRegistered
        ? t('settings.mcpReregister')
        : t('settings.mcpRegister');

    return (
      <div key={target.id} className="settings-row" data-mcp-target={target.id}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="ui-field-label">{target.displayName}</span>
              {!target.verified && (
                <Badge title={t('settings.mcpExperimentalTitle')}>{t('settings.mcpExperimental')}</Badge>
              )}
            </span>
            {target.configExists ? (
              <span className="ui-field-description font-mono truncate" title={target.configPath}>
                {target.configPath}
                {target.configModified ? ` ${t('settings.mcpModified', { date: new Date(target.configModified).toLocaleString() })}` : ''}
              </span>
            ) : (
              <span className="ui-field-description">
                {t('settings.mcpNotDetected')}<span className="font-mono">{target.configPath}</span>
              </span>
            )}
            {target.configExists && target.wmux.path && (
              <span className="ui-field-description font-mono truncate" title={target.wmux.path}>
                {target.wmux.path}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {target.configExists && (
              <Badge tone={isRegistered ? 'success' : 'neutral'}>
                {isRegistered && <span aria-hidden="true" className="inline-flex"><IconCheck size={12} /></span>}
                {isRegistered ? t('settings.mcpRegistered') : t('settings.mcpNotRegistered')}
              </Badge>
            )}
            <Button
              variant="secondary"
              size="sm"
              data-mcp-action={target.id}
              onClick={() => void handleRegisterTarget(target.id, target.displayName)}
              disabled={isBusy}
            >
              {actionLabel}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const actions = status ? (
    <div className="flex items-center gap-2 shrink-0">
      <Button
        variant="secondary"
        onClick={() => void handleReregister()}
        disabled={isBusy}
      >
        {pending === 'reregister' ? '…' : t('settings.mcpReregister')}
      </Button>
      {confirmingUnregister ? (
        <>
          <Button
            variant="ghost"
            onClick={() => setConfirmingUnregister(false)}
            disabled={isBusy}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleUnregister()}
            disabled={isBusy}
          >
            {pending === 'unregister' ? '…' : t('settings.mcpConfirm')}
          </Button>
        </>
      ) : (
        <Button
          variant="destructive"
          onClick={() => setConfirmingUnregister(true)}
          disabled={isBusy}
        >
          {t('settings.mcpUnregister')}
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <SettingsSection id="mcp" title={t('settings.mcpServers')}>
      {loading ? (
        <SettingNote>{t('settings.mcpChecking')}</SettingNote>
      ) : status ? (
        <>
          {status.targets.map((target: McpTargetStatusPayload) => renderTarget(target))}
          <div className="settings-row">
            <div className="flex justify-end">{actions}</div>
          </div>
        </>
      ) : (
        <SettingNote>{t('settings.mcpUnavailable')}</SettingNote>
      )}
    </SettingsSection>
  );
}
