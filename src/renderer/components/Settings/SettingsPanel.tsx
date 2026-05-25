import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { LOCALE_OPTIONS, type Locale } from '../../i18n';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { THEME_OPTIONS, XTERM_PALETTE_OPTIONS, XTERM_PALETTES, builtinToCustom, DEFAULT_CUSTOM_THEME, type BuiltinThemeId, type ThemeId, type XtermPaletteId } from '../../themes';
import {
  TAILWIND_PALETTE,
  TAILWIND_SHADES,
  TAILWIND_HUES,
  TAILWIND_NEUTRAL_HUES,
  TAILWIND_COLOR_HUES,
  nearestTailwindSwatch,
  type TailwindHue,
} from '../../tailwindPalette';
import type { CustomThemeColors, XtermThemeColors } from '../../../shared/types';
import type { FirstRunCheckResult } from '../../../shared/firstRun';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { ClaudeIntegrationSection } from './ClaudeIntegrationSection';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = 'general' | 'appearance' | 'notifications' | 'shortcuts' | 'claude-integration' | 'first-run-setup' | 'about';
type ShellInfo = { name: string; path: string; args?: string[] };

// ─── Icon components ──────────────────────────────────────────────────────────

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12" y1="2" x2="2" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1.5 7a5.5 5.5 0 1 0 1.1-3.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <polyline points="1.5,2 1.5,4.5 4,4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Toggle switch ─────────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none shrink-0"
      style={{ backgroundColor: checked ? 'var(--accent-blue)' : 'var(--bg-overlay)' }}
    >
      <span
        className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

// ─── Row layout helper ────────────────────────────────────────────────────────

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between px-3 py-2.5 rounded-lg"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
    >
      <div className="min-w-0 mr-3">
        <p className="text-sm text-[color:var(--text-main)]">{label}</p>
        {description && <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── Select dropdown ──────────────────────────────────────────────────────────

function SettingSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)] font-mono"
      style={{
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-main)',
        border: '1px solid var(--bg-overlay)',
        minWidth: 130,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ─── Number input ─────────────────────────────────────────────────────────────

function SettingNumberInput({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label: string;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && n >= min && n <= max) onChange(n);
      }}
      className="text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)] font-mono text-center"
      style={{
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-main)',
        border: '1px solid var(--bg-overlay)',
        width: 64,
      }}
    />
  );
}

// ─── Section divider label ────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2 mt-1 px-1">
      {label}
    </p>
  );
}

// ─── Keyboard shortcut badge ──────────────────────────────────────────────────

function KbdRow({ keys, description }: { keys: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-3 rounded-lg hover:bg-[color:var(--bg-mantle)] transition-colors">
      <span className="text-[12px] text-[color:var(--text-sub)]">{description}</span>
      <span
        className="text-[10px] font-mono px-2 py-0.5 rounded"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-blue)', border: '1px solid var(--bg-overlay)' }}
      >
        {keys}
      </span>
    </div>
  );
}

// ─── Static config (product names — no translation needed) ───────────────────

function resolveDefaultShellPath(current: string, shells: ShellInfo[]): string {
  const existing = shells.find((shell) => shell.path === current);
  if (existing) return existing.path;

  const lower = current.toLowerCase();
  const basename = (shell: ShellInfo) => shell.path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';

  if (lower === 'powershell') {
    return shells.find((shell) => basename(shell) === 'powershell.exe')?.path || shells[0].path;
  }
  if (lower === 'cmd') {
    return shells.find((shell) => basename(shell) === 'cmd.exe')?.path || shells[0].path;
  }
  if (lower === 'gitbash') {
    return shells.find((shell) => shell.name === 'Git Bash')?.path || shells[0].path;
  }
  if (lower === 'wsl') {
    return shells.find((shell) => basename(shell) === 'wsl.exe')?.path || shells[0].path;
  }

  return shells[0].path;
}

const FONT_FAMILY_OPTIONS = [
  { value: 'Cascadia Code',    label: 'Cascadia Code' },
  { value: 'Consolas',         label: 'Consolas' },
  { value: 'Fira Code',        label: 'Fira Code' },
  { value: 'JetBrains Mono',   label: 'JetBrains Mono' },
];

// ─── Reset section ───────────────────────────────────────────────────────────

function ResetSection() {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const setVisible = useStore((s) => s.setSettingsPanelVisible);
  const [confirming, setConfirming] = useState(false);
  const { invoke: ipcInvoke } = useIpc();

  const handleReset = useCallback(async () => {
    // Dispose all PTYs across all workspaces
    for (const ws of workspaces) {
      disposePaneTree(ws.rootPane);
    }

    // Remove all workspaces except the last one (store requires at least 1)
    const ids = workspaces.map((w) => w.id);
    // Add a fresh workspace first
    addWorkspace('Workspace 1');
    // Then remove all old ones
    for (const id of ids) {
      removeWorkspace(id);
    }

    // Save the clean session — surface IPC errors via toast (daemon may be down).
    const state = useStore.getState();
    await ipcInvoke(() => window.electronAPI.session.save({
      workspaces: state.workspaces,
      activeWorkspaceId: state.activeWorkspaceId,
    }));

    setConfirming(false);
    setVisible(false);
  }, [workspaces, removeWorkspace, addWorkspace, setVisible, ipcInvoke]);

  return (
    <div>
      <SectionLabel label={t('settings.reset')} />
      <div
        className="px-3 py-2.5 rounded-lg flex items-center justify-between"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        <div>
          <p className="text-sm text-[color:var(--text-main)]">{t('settings.resetWorkspaces')}</p>
          <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">{t('settings.resetWorkspacesDesc')}</p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <button
              onClick={handleReset}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: 'var(--accent-red)', color: 'var(--bg-base)' }}
            >
              {t('settings.resetButton')}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)' }}
            >
              {t('settings.close')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ml-3"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-red)' }}
          >
            {t('settings.resetButton')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Recursively dispose all PTYs in a pane tree */
function disposePaneTree(pane: { type: string; surfaces?: Array<{ ptyId?: string }>; children?: Array<typeof pane> }) {
  if (pane.type === 'leaf' && pane.surfaces) {
    for (const s of pane.surfaces) {
      if (s.ptyId) window.electronAPI.pty.dispose(s.ptyId);
    }
  } else if (pane.children) {
    for (const child of pane.children) disposePaneTree(child);
  }
}

// ─── MCP integration status ──────────────────────────────────────────────────

/** Mirror of McpStatusPayload in main/ipc/handlers/mcp.handler.ts. */
interface McpStatusPayload {
  wmux: { registered: boolean; path: string | null };
  wmuxA2a: { registered: boolean; path: string | null };
  configPath: string;
  configExists: boolean;
  configModified: string | null;
}

interface ElectronMcpApi {
  check: () => Promise<McpStatusPayload>;
  reregister: () => Promise<McpStatusPayload>;
  unregister: () => Promise<McpStatusPayload>;
}

/**
 * MCP servers panel in Settings → General. Surfaces whether `~/.claude.json`
 * has the wmux + wmux-a2a MCP entries, plus Re-register / Unregister buttons.
 *
 * Mirrors the `wmux mcp check` CLI output so users have a one-stop way to
 * verify Claude Code can discover the wmux MCP bridge — DX D4 decision.
 */
function McpStatusSection() {
  const [status, setStatus] = useState<McpStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingUnregister, setConfirmingUnregister] = useState(false);
  const [pending, setPending] = useState<'reregister' | 'unregister' | null>(null);
  // NOT_FOUND is expected when running the dev shell with no main wired up;
  // silence those toasts so the empty state renders cleanly.
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN'] });

  // Lazily access the API so this component is safe to render in tests where
  // the preload has not exposed mcp yet.
  const mcpApi = (window.electronAPI as unknown as { mcp?: ElectronMcpApi }).mcp;

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
  }, [refresh]);

  const handleReregister = useCallback(async () => {
    if (!mcpApi) return;
    setPending('reregister');
    const result = await ipcInvoke(() => mcpApi.reregister());
    if (result.ok) setStatus(result.data);
    setPending(null);
  }, [ipcInvoke, mcpApi]);

  const handleUnregister = useCallback(async () => {
    if (!mcpApi) return;
    setPending('unregister');
    const result = await ipcInvoke(() => mcpApi.unregister());
    if (result.ok) setStatus(result.data);
    setPending(null);
    setConfirmingUnregister(false);
  }, [ipcInvoke, mcpApi]);

  // Section is hidden entirely when the preload doesn't expose the API —
  // keeps older dev builds clean and avoids "phantom" buttons that error.
  if (!mcpApi && !loading) return null;

  const renderRow = (
    label: string,
    server: { registered: boolean; path: string | null },
  ) => (
    <div
      className="px-3 py-2 rounded-lg flex items-center justify-between gap-3"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-mono w-3 text-center"
            style={{ color: server.registered ? 'var(--accent-green, #a6e3a1)' : 'var(--accent-red, #f38ba8)' }}
          >
            {server.registered ? '✓' : '✗'}
          </span>
          <span className="text-sm text-[color:var(--text-main)] font-mono">{label}</span>
        </div>
        {server.path && (
          <p
            className="text-[10px] text-[color:var(--text-muted)] mt-0.5 font-mono truncate"
            title={server.path}
          >
            {server.path}
          </p>
        )}
        {!server.registered && (
          <p className="text-[10px] text-[color:var(--text-muted)] mt-0.5">
            Not registered in Claude Code config
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel label="MCP Servers" />
      {loading ? (
        <div
          className="px-3 py-2 rounded-lg text-[11px] text-[color:var(--text-muted)]"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          Checking ~/.claude.json…
        </div>
      ) : status ? (
        <>
          {renderRow('wmux', status.wmux)}
          {renderRow('wmux-a2a', status.wmuxA2a)}
          <div
            className="px-3 py-2 rounded-lg flex items-center justify-between gap-3"
            style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-[color:var(--text-sub)] font-mono truncate" title={status.configPath}>
                {status.configPath}
              </p>
              <p className="text-[10px] text-[color:var(--text-muted)] mt-0.5">
                {status.configExists
                  ? status.configModified
                    ? `modified ${new Date(status.configModified).toLocaleString()}`
                    : 'config file present'
                  : 'config file does not exist'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void handleReregister()}
                disabled={pending !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--accent-blue)',
                  border: '1px solid var(--bg-overlay)',
                  opacity: pending ? 0.5 : 1,
                }}
              >
                {pending === 'reregister' ? '…' : 'Re-register'}
              </button>
              {confirmingUnregister ? (
                <>
                  <button
                    onClick={() => void handleUnregister()}
                    disabled={pending !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{ backgroundColor: 'var(--accent-red)', color: 'var(--bg-base)' }}
                  >
                    {pending === 'unregister' ? '…' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmingUnregister(false)}
                    disabled={pending !== null}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)' }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmingUnregister(true)}
                  disabled={pending !== null}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--accent-red)',
                    border: '1px solid var(--bg-overlay)',
                  }}
                >
                  Unregister
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        <div
          className="px-3 py-2 rounded-lg text-[11px] text-[color:var(--text-muted)]"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          MCP status unavailable. Restart wmux and try again.
        </div>
      )}
    </div>
  );
}

// ─── Update status widget ─────────────────────────────────────────────────────

type UpdateState = 'idle' | 'checking' | 'available' | 'downloaded' | 'not-available' | 'error';

function UpdateStatus() {
  const t = useT();
  const [state, setState] = useState<UpdateState>('idle');
  const [releaseName, setReleaseName] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // Updater-not-configured in dev is expected; don't spam toasts for UNKNOWN.
  const { invoke: ipcInvoke } = useIpc({ silent: ['UNKNOWN'] });

  useEffect(() => {
    const removeAvailable = window.electronAPI.updater.onUpdateAvailable((data) => {
      if (data.status === 'downloaded') {
        setState('downloaded');
        if (data.releaseName) setReleaseName(data.releaseName);
      } else {
        setState('available');
      }
    });
    const removeNotAvailable = window.electronAPI.updater.onUpdateNotAvailable(() => {
      setState('not-available');
    });
    const removeError = window.electronAPI.updater.onUpdateError((data) => {
      setState('error');
      setErrorMsg(data.message || '');
    });
    return () => { removeAvailable(); removeNotAvailable(); removeError(); };
  }, []);

  const handleCheck = async () => {
    setState('checking');
    const result = await ipcInvoke(() => window.electronAPI.updater.checkForUpdates());
    if (!result.ok) setState('error');
  };

  const handleInstall = () => {
    window.electronAPI.updater.installUpdate().catch(() => {});
  };

  const statusText = (() => {
    switch (state) {
      case 'checking': return t('settings.checkUpdate') + '...';
      case 'available': return t('settings.updateAvailable');
      case 'downloaded': return t('settings.updateReady') + (releaseName ? ` (${releaseName})` : '');
      case 'not-available': return t('settings.upToDate');
      case 'error': return t('settings.updateFailed');
      default: return '';
    }
  })();

  const statusColor = (() => {
    switch (state) {
      case 'available':
      case 'downloaded': return 'var(--accent-green, #a6e3a1)';
      case 'error': return 'var(--accent-red, #f38ba8)';
      default: return 'var(--text-muted)';
    }
  })();

  return (
    <div
      className="px-3 py-2.5 rounded-lg flex items-center justify-between"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
    >
      <div>
        <p className="text-sm text-[color:var(--text-main)]">{t('settings.wmuxUpdates')}</p>
        <p className="text-[11px] mt-0.5" style={{ color: statusText ? statusColor : 'var(--text-muted)' }}>
          v{__APP_VERSION__}{statusText ? ` — ${statusText}` : ''}
        </p>
        {state === 'error' && errorMsg && (
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{errorMsg}</p>
        )}
      </div>
      <div className="flex gap-2 shrink-0 ml-3">
        {state === 'downloaded' ? (
          <button
            onClick={handleInstall}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
            style={{ backgroundColor: 'var(--accent-green)', color: 'var(--bg-base)', border: 'none' }}
          >
            {t('settings.updateReady')}
          </button>
        ) : (
          <button
            onClick={handleCheck}
            disabled={state === 'checking'}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
            style={{
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-main)',
              border: 'none',
              opacity: state === 'checking' ? 0.5 : 1,
            }}
          >
            {t('settings.checkUpdate')}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Tab content components ───────────────────────────────────────────────────

function TabGeneral() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);

  const defaultShell = useStore((s) => s.defaultShell);
  const setDefaultShell = useStore((s) => s.setDefaultShell);
  const scrollbackLines = useStore((s) => s.scrollbackLines);
  const setScrollbackLines = useStore((s) => s.setScrollbackLines);
  const scrollbackRestoreEnabled = useStore((s) => s.scrollbackRestoreEnabled);
  const setScrollbackRestoreEnabled = useStore((s) => s.setScrollbackRestoreEnabled);
  const autoUpdateEnabled = useStore((s) => s.autoUpdateEnabled);
  const [detectedShells, setDetectedShells] = useState<ShellInfo[]>([]);
  const storeSetAutoUpdate = useStore((s) => s.setAutoUpdateEnabled);
  const setAutoUpdateEnabled = (enabled: boolean) => {
    storeSetAutoUpdate(enabled);
    window.electronAPI.settings.setAutoUpdateEnabled(enabled);
  };
  const shellOptions = detectedShells.map((shell) => ({ value: shell.path, label: shell.name }));

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.shell.list()
      .then((shells) => {
        if (cancelled) return;
        setDetectedShells(shells);
        const shellPaths = new Set(shells.map((shell) => shell.path));
        if (shells.length > 0 && !shellPaths.has(useStore.getState().defaultShell)) {
          setDefaultShell(resolveDefaultShellPath(useStore.getState().defaultShell, shells));
        }
      })
      .catch(() => {
        if (!cancelled) setDetectedShells([]);
      });
    return () => { cancelled = true; };
  }, [setDefaultShell]);

  return (
    <div className="flex flex-col gap-4">
      {/* Language */}
      <div>
        <SectionLabel label={t('settings.language')} />
        <div className="grid grid-cols-2 gap-2">
          {LOCALE_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setLocale(value as Locale)}
              className="px-3 py-2 rounded-lg text-sm transition-colors text-left"
              style={{
                backgroundColor: locale === value ? 'var(--bg-surface)' : 'transparent',
                color: locale === value ? 'var(--text-main)' : 'var(--text-subtle)',
                border: `1px solid ${locale === value ? 'var(--accent-blue)' : 'var(--bg-surface)'}`,
              }}
            >
              <span className="mr-2">{localeFlag(value as Locale)}</span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Shell & scrollback */}
      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.terminal')} />
        <SettingRow label={t('settings.defaultShell')}>
          <SettingSelect
            label={t('settings.defaultShell')}
            value={defaultShell}
            onChange={setDefaultShell}
            options={shellOptions}
          />
        </SettingRow>
        <SettingRow label={t('settings.scrollbackLines')} description={t('settings.scrollbackDesc')}>
          <SettingNumberInput
            label={t('settings.scrollbackLines')}
            value={scrollbackLines}
            onChange={setScrollbackLines}
            min={1000}
            max={100000}
          />
        </SettingRow>
        <SettingRow label={t('settings.scrollbackRestore')} description={t('settings.scrollbackRestoreDesc')}>
          <Toggle
            checked={scrollbackRestoreEnabled}
            onChange={setScrollbackRestoreEnabled}
            label={t('settings.scrollbackRestore')}
          />
        </SettingRow>
      </div>

      {/* Updates */}
      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.updates')} />
        <SettingRow label={t('settings.autoUpdate')} description={t('settings.autoUpdateDesc')}>
          <Toggle
            checked={autoUpdateEnabled}
            onChange={setAutoUpdateEnabled}
            label={t('settings.autoUpdate')}
          />
        </SettingRow>
        <UpdateStatus />
      </div>

      {/* Tutorial */}
      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.tutorial')} />
        <SettingRow label={t('settings.restartTutorial')} description={t('settings.restartTutorialDesc')}>
          <button
            onClick={() => {
              useStore.getState().startOnboarding();
              useStore.getState().setSettingsPanelVisible(false);
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)', border: '1px solid var(--bg-overlay)' }}
          >
            {t('settings.restartTutorial')}
          </button>
        </SettingRow>
      </div>

      {/* MCP integration */}
      <McpStatusSection />

      {/* Reset */}
      <ResetSection />
    </div>
  );
}

// ─── Tailwind swatch picker (popover) ────────────────────────────────────────

interface TailwindSwatchPickerProps {
  value: string;
  onChange: (hex: string) => void;
  // Restrict hue set per token category. Default = all hues.
  hueScope?: 'neutral' | 'color' | 'all';
}

function TailwindSwatchPicker({ value, onChange, hueScope = 'all' }: TailwindSwatchPickerProps) {
  const visibleHues = useMemo<readonly TailwindHue[]>(() => {
    if (hueScope === 'neutral') return TAILWIND_NEUTRAL_HUES;
    if (hueScope === 'color') return TAILWIND_COLOR_HUES;
    return TAILWIND_HUES;
  }, [hueScope]);

  // Pick the active hue tab — nearest Tailwind hue to current value, falling
  // back to the first hue in scope so the picker always opens on something.
  const nearest = nearestTailwindSwatch(value);
  const initialHue: TailwindHue = nearest && visibleHues.includes(nearest.hue)
    ? nearest.hue
    : visibleHues[0];
  const [activeHue, setActiveHue] = useState<TailwindHue>(initialHue);

  return (
    <div
      className="w-full rounded-lg p-2 flex flex-col gap-2"
      style={{ backgroundColor: 'var(--bg-base)', border: '1px solid var(--bg-overlay)' }}
    >
      {/* Hue tabs */}
      <div className="flex flex-wrap gap-0.5">
        {visibleHues.map((hue) => (
          <button
            key={hue}
            onClick={() => setActiveHue(hue)}
            className="px-1.5 py-0.5 text-[10px] rounded transition-colors"
            style={{
              backgroundColor: activeHue === hue ? 'var(--bg-surface)' : 'transparent',
              color: activeHue === hue ? 'var(--text-main)' : 'var(--text-subtle)',
              border: '1px solid transparent',
            }}
            title={hue}
          >
            {hue}
          </button>
        ))}
      </div>

      {/* Shade row */}
      <div className="flex gap-1">
        {TAILWIND_SHADES.map((shade) => {
          const hex = TAILWIND_PALETTE[activeHue][shade];
          const selected = hex.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={shade}
              onClick={() => onChange(hex)}
              className="flex-1 aspect-square rounded transition-transform hover:scale-110"
              style={{
                backgroundColor: hex,
                boxShadow: selected ? '0 0 0 2px var(--accent-blue)' : 'inset 0 0 0 1px rgba(128,128,128,0.25)',
              }}
              title={`${activeHue}-${shade} ${hex}`}
            />
          );
        })}
      </div>

      {/* Custom hex input */}
      <div className="flex items-center gap-2 pt-1" style={{ borderTop: '1px solid var(--bg-surface)' }}>
        <span className="text-[10px] text-[color:var(--text-muted)] font-mono">HEX</span>
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
          }}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-1"
          style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--bg-overlay)' }}
          spellCheck={false}
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-5 h-5 rounded cursor-pointer border-0 p-0"
          style={{ backgroundColor: 'transparent' }}
        />
      </div>
    </div>
  );
}

// ─── Token row — label + swatch button that toggles the picker ──────────────

interface TokenRowProps {
  label: string;
  description?: string;
  value: string;
  hueScope?: 'neutral' | 'color' | 'all';
  onChange: (hex: string) => void;
}

function TokenRow({ label, description, value, hueScope, onChange }: TokenRowProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <button
        className="flex items-center justify-between w-full"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex flex-col items-start">
          <span className="text-[11px] text-[color:var(--text-sub)] font-medium">{label}</span>
          {description && (
            <span className="text-[10px] text-[color:var(--text-muted)]">{description}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[color:var(--text-muted)] font-mono">{value.toUpperCase()}</span>
          <span
            className="w-6 h-6 rounded"
            style={{ backgroundColor: value, border: '1px solid var(--bg-overlay)' }}
          />
        </div>
      </button>
      {open && (
        <TailwindSwatchPicker
          value={value}
          onChange={onChange}
          hueScope={hueScope}
        />
      )}
    </div>
  );
}

// ─── Custom theme editor — 10 manual tokens + xterm palette preset ──────────

interface UITokenSpec {
  key: Exclude<keyof CustomThemeColors, 'xtermPaletteId' | 'xtermOverrides'>;
  labelKey: string;
  hueScope: 'neutral' | 'color' | 'all';
}

const UI_TOKEN_GROUPS: { label: string; tokens: UITokenSpec[] }[] = [
  {
    label: 'Background',
    tokens: [
      { key: 'bgBase',    labelKey: 'settings.token.bgBase',    hueScope: 'neutral' },
      { key: 'bgSurface', labelKey: 'settings.token.bgSurface', hueScope: 'neutral' },
      { key: 'bgMantle',  labelKey: 'settings.token.bgMantle',  hueScope: 'neutral' },
    ],
  },
  {
    label: 'Text',
    tokens: [
      { key: 'textMain',  labelKey: 'settings.token.textMain',  hueScope: 'neutral' },
      { key: 'textSub',   labelKey: 'settings.token.textSub',   hueScope: 'neutral' },
      { key: 'textMuted', labelKey: 'settings.token.textMuted', hueScope: 'neutral' },
    ],
  },
  {
    label: 'Accents',
    tokens: [
      { key: 'accent',  labelKey: 'settings.token.accent',  hueScope: 'color' },
      { key: 'success', labelKey: 'settings.token.success', hueScope: 'color' },
      { key: 'danger',  labelKey: 'settings.token.danger',  hueScope: 'color' },
      { key: 'warning', labelKey: 'settings.token.warning', hueScope: 'color' },
    ],
  },
];

const BASE_ON_OPTIONS: { value: BuiltinThemeId; label: string }[] = [
  { value: 'catppuccin-mocha', label: 'Catppuccin' },
  { value: 'stars-and-stripes', label: 'Stars & Stripes' },
  { value: 'red-dynasty', label: 'Red Dynasty' },
  { value: 'nightowl', label: 'Nightowl' },
  { value: 'void', label: 'Void' },
  { value: 'monochrome', label: 'Monochrome' },
  { value: 'hinomaru', label: 'Hinomaru' },
  { value: 'taegeuk', label: 'Taegeuk' },
];

// Per-token short hint shown under the label. Static English fallback; the
// real label comes from i18n via labelKey. Description keeps it discoverable.
const TOKEN_DESCRIPTIONS: Record<UITokenSpec['key'], string> = {
  bgBase: 'Main window background',
  bgSurface: 'Sidebar / cards / panels',
  bgMantle: 'Headers / recessed areas',
  textMain: 'Primary text',
  textSub: 'Secondary text / labels',
  textMuted: 'Disabled / hints',
  accent: 'Selection / focus / brand',
  success: 'OK / running / complete',
  danger: 'Errors / destructive',
  warning: 'Waiting / caution',
};

function CustomThemeEditor() {
  const t = useT();
  const customThemeColors = useStore((s) => s.customThemeColors) ?? DEFAULT_CUSTOM_THEME;
  const setCustomThemeColors = useStore((s) => s.setCustomThemeColors);
  const updateCustomThemeColor = useStore((s) => s.updateCustomThemeColor);

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel label={t('settings.customTheme')} />

      {/* Base on preset */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-lg"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        <span className="text-[11px] text-[color:var(--text-sub)]">{t('settings.baseOnPreset')}</span>
        <select
          className="text-[11px] rounded px-2 py-0.5 font-mono"
          style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--bg-overlay)' }}
          onChange={(e) => {
            setCustomThemeColors(builtinToCustom(e.target.value as BuiltinThemeId));
          }}
          defaultValue=""
        >
          <option value="" disabled>{t('settings.selectPreset')}</option>
          {BASE_ON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* UI token groups (always expanded — only 3-4 tokens each) */}
      {UI_TOKEN_GROUPS.map((group) => (
        <div
          key={group.label}
          className="rounded-lg overflow-hidden"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          <div
            className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {t(`settings.tokenGroup.${group.label.toLowerCase()}`) || group.label}
          </div>
          <div className="pb-1">
            {group.tokens.map(({ key, labelKey, hueScope }) => (
              <TokenRow
                key={key}
                label={t(labelKey) || key}
                description={TOKEN_DESCRIPTIONS[key]}
                value={customThemeColors[key]}
                hueScope={hueScope}
                onChange={(v) => updateCustomThemeColor(key, v)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Terminal palette preset */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-lg"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        <div className="flex flex-col">
          <span className="text-[11px] text-[color:var(--text-sub)]">{t('settings.xtermPalette') || 'Terminal Palette'}</span>
          <span className="text-[10px] text-[color:var(--text-muted)]">
            {t('settings.xtermPaletteDesc') || '16-color ANSI palette for terminal output'}
          </span>
        </div>
        <select
          className="text-[11px] rounded px-2 py-0.5 font-mono"
          style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--bg-overlay)' }}
          value={customThemeColors.xtermPaletteId}
          onChange={(e) => updateCustomThemeColor('xtermPaletteId', e.target.value as XtermPaletteId)}
        >
          {XTERM_PALETTE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Per-slot terminal color overrides on top of the preset */}
      <XtermOverrideEditor />
    </div>
  );
}

// ─── xterm per-slot override editor ─────────────────────────────────────────

interface XtermSlotSpec {
  key: keyof XtermThemeColors;
  labelKey: string;
  fallback: string;
}

const XTERM_SLOT_GROUPS: { labelKey: string; fallback: string; slots: XtermSlotSpec[] }[] = [
  {
    labelKey: 'settings.xtermGroup.surface', fallback: 'Surface',
    slots: [
      { key: 'background',          labelKey: 'settings.xtermSlot.background',          fallback: 'Background' },
      { key: 'foreground',          labelKey: 'settings.xtermSlot.foreground',          fallback: 'Foreground' },
      { key: 'cursor',              labelKey: 'settings.xtermSlot.cursor',              fallback: 'Cursor' },
      { key: 'selectionBackground', labelKey: 'settings.xtermSlot.selectionBackground', fallback: 'Selection' },
    ],
  },
  {
    labelKey: 'settings.xtermGroup.ansi', fallback: 'ANSI 8',
    slots: [
      { key: 'black',   labelKey: 'settings.xtermSlot.black',   fallback: 'Black' },
      { key: 'red',     labelKey: 'settings.xtermSlot.red',     fallback: 'Red' },
      { key: 'green',   labelKey: 'settings.xtermSlot.green',   fallback: 'Green' },
      { key: 'yellow',  labelKey: 'settings.xtermSlot.yellow',  fallback: 'Yellow' },
      { key: 'blue',    labelKey: 'settings.xtermSlot.blue',    fallback: 'Blue' },
      { key: 'magenta', labelKey: 'settings.xtermSlot.magenta', fallback: 'Magenta' },
      { key: 'cyan',    labelKey: 'settings.xtermSlot.cyan',    fallback: 'Cyan' },
      { key: 'white',   labelKey: 'settings.xtermSlot.white',   fallback: 'White' },
    ],
  },
  {
    labelKey: 'settings.xtermGroup.ansiBright', fallback: 'ANSI Bright',
    slots: [
      { key: 'brightBlack',   labelKey: 'settings.xtermSlot.brightBlack',   fallback: 'Bright Black' },
      { key: 'brightRed',     labelKey: 'settings.xtermSlot.brightRed',     fallback: 'Bright Red' },
      { key: 'brightGreen',   labelKey: 'settings.xtermSlot.brightGreen',   fallback: 'Bright Green' },
      { key: 'brightYellow',  labelKey: 'settings.xtermSlot.brightYellow',  fallback: 'Bright Yellow' },
      { key: 'brightBlue',    labelKey: 'settings.xtermSlot.brightBlue',    fallback: 'Bright Blue' },
      { key: 'brightMagenta', labelKey: 'settings.xtermSlot.brightMagenta', fallback: 'Bright Magenta' },
      { key: 'brightCyan',    labelKey: 'settings.xtermSlot.brightCyan',    fallback: 'Bright Cyan' },
      { key: 'brightWhite',   labelKey: 'settings.xtermSlot.brightWhite',   fallback: 'Bright White' },
    ],
  },
];

function XtermOverrideEditor() {
  const t = useT();
  const customThemeColors = useStore((s) => s.customThemeColors) ?? DEFAULT_CUSTOM_THEME;
  const setXtermOverride = useStore((s) => s.setXtermOverride);
  const clearXtermOverrides = useStore((s) => s.clearXtermOverrides);
  const [expanded, setExpanded] = useState(false);

  const presetId = (customThemeColors.xtermPaletteId as XtermPaletteId);
  const preset = XTERM_PALETTES[presetId] ?? XTERM_PALETTES['catppuccin-mocha'];
  const overrides = customThemeColors.xtermOverrides ?? {};
  const overrideCount = Object.keys(overrides).length;

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-[color:var(--bg-surface)] transition-colors"
      >
        <div className="flex flex-col">
          <span className="text-[11px] text-[color:var(--text-sub)]">
            {t('settings.xtermOverrides') || 'Customize terminal colors'}
          </span>
          <span className="text-[10px] text-[color:var(--text-muted)]">
            {overrideCount > 0
              ? (t('settings.xtermOverridesActive') || `${overrideCount} slot(s) overriding preset`).replace('{n}', String(overrideCount))
              : (t('settings.xtermOverridesIdle') || 'Override individual ANSI colors on top of the preset')}
          </span>
        </div>
        <span className="text-[11px] text-[color:var(--text-muted)] font-mono">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="pb-1">
          {XTERM_SLOT_GROUPS.map((group) => (
            <div key={group.labelKey}>
              <div
                className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                {t(group.labelKey) || group.fallback}
              </div>
              {group.slots.map(({ key, labelKey, fallback }) => {
                const overrideVal = overrides[key];
                const effective = overrideVal ?? preset[key];
                const isOverridden = typeof overrideVal === 'string';
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-[color:var(--bg-surface)] transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-[color:var(--text-sub)] truncate">
                          {t(labelKey) || fallback}
                        </span>
                        {isOverridden && (
                          <span
                            className="text-[8px] uppercase tracking-wider rounded px-1"
                            style={{ color: 'var(--accent-cursor)', border: '1px solid var(--accent-cursor)' }}
                          >
                            {t('settings.xtermSlotOverridden') || 'custom'}
                          </span>
                        )}
                      </div>
                      <span className="text-[9px] text-[color:var(--text-muted)] font-mono">{effective.toUpperCase()}</span>
                    </div>
                    <span
                      className="w-5 h-5 rounded shrink-0"
                      style={{ backgroundColor: effective, border: '1px solid var(--bg-overlay)' }}
                    />
                    <input
                      type="color"
                      value={effective}
                      onChange={(e) => setXtermOverride(key, e.target.value)}
                      className="w-6 h-6 rounded cursor-pointer shrink-0"
                      style={{ backgroundColor: 'transparent' }}
                    />
                    {isOverridden && (
                      <button
                        type="button"
                        onClick={() => setXtermOverride(key, null)}
                        className="text-[9px] text-[color:var(--text-subtle)] hover:text-[color:var(--accent-red)] transition-colors shrink-0"
                        title={t('settings.xtermSlotReset') || 'Reset to preset'}
                      >
                        ↺
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {overrideCount > 0 && (
            <div className="px-3 py-2 flex justify-end">
              <button
                type="button"
                onClick={clearXtermOverrides}
                className="px-2 py-1 rounded text-[10px] font-medium transition-colors"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-red)', border: '1px solid var(--bg-overlay)' }}
              >
                {t('settings.xtermResetAll') || 'Reset all to preset'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Theme preview swatch ────────────────────────────────────────────────────

function ThemeSwatch({ colors }: { colors: [string, string, string, string] }) {
  return (
    <div className="flex gap-0.5 justify-center mb-1.5">
      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: colors[0], border: '1px solid rgba(128,128,128,0.3)' }} />
      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: colors[1] }} />
      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: colors[2] }} />
      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: colors[3] }} />
    </div>
  );
}

function TabAppearance() {
  const t = useT();
  const terminalFontSize    = useStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useStore((s) => s.setTerminalFontSize);
  const terminalFontFamily    = useStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = useStore((s) => s.setTerminalFontFamily);

  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const setSidebarPosition = useStore((s) => s.setSidebarPosition);

  const currentTheme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  return (
    <div className="flex flex-col gap-4">
      {/* Theme */}
      <div className="flex flex-col gap-2">
        <SectionLabel label="Theme" />
        <div className="grid grid-cols-5 gap-1.5">
          {THEME_OPTIONS.map(({ value, label, preview }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className="px-2 py-2 rounded-lg text-[11px] transition-colors text-center flex flex-col items-center"
              style={{
                backgroundColor: currentTheme === value ? 'var(--bg-surface)' : 'transparent',
                color: currentTheme === value ? 'var(--text-main)' : 'var(--text-subtle)',
                border: `1px solid ${currentTheme === value ? 'var(--accent-blue)' : 'var(--bg-surface)'}`,
              }}
            >
              <ThemeSwatch colors={preview} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom theme editor — shown when custom theme selected */}
      {currentTheme === 'custom' && <CustomThemeEditor />}

      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.terminal')} />
        <SettingRow label={t('settings.fontSize')} description={`${terminalFontSize}px — ${t('settings.fontSizeRange')}`}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={12}
              max={24}
              value={terminalFontSize}
              onChange={(e) => setTerminalFontSize(Number(e.target.value))}
              aria-label={t('settings.fontSize')}
              className="w-24 accent-[color:var(--accent-blue)]"
            />
            <span className="text-xs font-mono text-[color:var(--text-sub)] w-6 text-right">{terminalFontSize}</span>
          </div>
        </SettingRow>
        <SettingRow label={t('settings.fontFamily')} description={t('settings.fontFamilyDesc')}>
          <SettingSelect
            label={t('settings.fontFamily')}
            value={terminalFontFamily}
            onChange={setTerminalFontFamily}
            options={FONT_FAMILY_OPTIONS}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.layout')} />
        <SettingRow label={t('settings.sidebarPosition')} description={t('settings.sidebarPositionDesc')}>
          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--bg-overlay)' }}>
            {(['left', 'right'] as const).map((pos) => (
              <button
                key={pos}
                onClick={() => setSidebarPosition(pos)}
                className="px-3 py-1 text-xs font-mono transition-colors"
                style={{
                  backgroundColor: sidebarPosition === pos ? 'var(--accent-blue)' : 'var(--bg-surface)',
                  color: sidebarPosition === pos ? 'var(--bg-base)' : 'var(--text-subtle)',
                }}
              >
                {pos === 'left' ? t('settings.sidebarLeft') : t('settings.sidebarRight')}
              </button>
            ))}
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

// ─── Notifications tab (pure presentational + container) ────────────────────
//
// The view is split into a pure `NotificationsView` component (props in, JSX
// out) and a `TabNotifications` container that wires the view to the store.
//
// Why split? The repo's vitest config runs in a `node` env without a DOM
// library, so the existing test pattern (see SettingsPanel.firstRunSection
// test) drives presentational components through `renderToStaticMarkup` and
// exercises handlers directly. Extracting the view keeps that test surface.

/** Minimal workspace summary the notifications view needs — name + mute flag. */
export interface NotificationsViewWorkspaceRow {
  id: string;
  name: string;
  muted: boolean;
}

export interface NotificationsViewProps {
  // Existing notification toggles
  notificationSoundEnabled: boolean;
  onToggleNotificationSound: () => void;
  toastEnabled: boolean;
  onChangeToastEnabled: (v: boolean) => void;
  notificationRingEnabled: boolean;
  onChangeNotificationRingEnabled: (v: boolean) => void;

  // T12 — 4 new toggles
  paneRingEnabled: boolean;
  onChangePaneRingEnabled: (v: boolean) => void;
  paneFlashEnabled: boolean;
  onChangePaneFlashEnabled: (v: boolean) => void;
  taskbarFlashEnabled: boolean;
  onChangeTaskbarFlashEnabled: (v: boolean) => void;
  notificationSoundChoice: 'default' | 'none';
  onChangeNotificationSoundChoice: (choice: 'default' | 'none') => void;

  // T12 — per-workspace mute list
  workspaces: NotificationsViewWorkspaceRow[];
  onChangeWorkspaceMuted: (workspaceId: string, muted: boolean) => void;

  // Translator — injected so the pure view can render with the live
  // `useT()` translator in production and a static stub in tests.
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/**
 * Pure presentational notifications settings block.
 *
 * Renders the global notification toggles (sound, toast, ring + 3 new T12
 * toggles + 1 sound-choice radio group) followed by the per-workspace mute
 * list. Exported so tests can drive it through `renderToStaticMarkup`.
 */
export function NotificationsView(props: NotificationsViewProps) {
  const {
    notificationSoundEnabled, onToggleNotificationSound,
    toastEnabled, onChangeToastEnabled,
    notificationRingEnabled, onChangeNotificationRingEnabled,
    paneRingEnabled, onChangePaneRingEnabled,
    paneFlashEnabled, onChangePaneFlashEnabled,
    taskbarFlashEnabled, onChangeTaskbarFlashEnabled,
    notificationSoundChoice, onChangeNotificationSoundChoice,
    workspaces, onChangeWorkspaceMuted,
    t,
  } = props;

  return (
    <div className="flex flex-col gap-4" data-testid="notifications-settings-section">
      {/* Global behavior */}
      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.notificationBehavior')} />
        <SettingRow label={t('settings.sound')} description={t('settings.soundDesc')}>
          <Toggle
            checked={notificationSoundEnabled}
            onChange={() => onToggleNotificationSound()}
            label={t('settings.sound')}
          />
        </SettingRow>
        <SettingRow label={t('settings.toast')} description={t('settings.toastDesc')}>
          <Toggle
            checked={toastEnabled}
            onChange={onChangeToastEnabled}
            label={t('settings.toast')}
          />
        </SettingRow>
        <SettingRow label={t('settings.ring')} description={t('settings.ringDesc')}>
          <Toggle
            checked={notificationRingEnabled}
            onChange={onChangeNotificationRingEnabled}
            label={t('settings.ring')}
          />
        </SettingRow>

        {/* T12 — Pane ring */}
        <SettingRow label={t('settings.paneRing')} description={t('settings.paneRingDesc')}>
          <Toggle
            checked={paneRingEnabled}
            onChange={onChangePaneRingEnabled}
            label={t('settings.paneRing')}
          />
        </SettingRow>

        {/* T12 — Pane flash */}
        <SettingRow label={t('settings.paneFlash')} description={t('settings.paneFlashDesc')}>
          <Toggle
            checked={paneFlashEnabled}
            onChange={onChangePaneFlashEnabled}
            label={t('settings.paneFlash')}
          />
        </SettingRow>

        {/* T12 — Taskbar flash */}
        <SettingRow label={t('settings.taskbarFlash')} description={t('settings.taskbarFlashDesc')}>
          <Toggle
            checked={taskbarFlashEnabled}
            onChange={onChangeTaskbarFlashEnabled}
            label={t('settings.taskbarFlash')}
          />
        </SettingRow>

        {/* T12 — Notification sound choice (radio group, not a toggle) */}
        <div
          className="px-3 py-2.5 rounded-lg"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
          data-testid="notification-sound-choice-row"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 mr-3">
              <p className="text-sm text-[color:var(--text-main)]" id="notification-sound-choice-label">
                {t('settings.notificationSoundChoice')}
              </p>
              <p
                className="text-[11px] text-[color:var(--text-muted)] mt-0.5"
                id="notification-sound-choice-desc"
              >
                {t('settings.notificationSoundChoiceDesc')}
              </p>
            </div>
            <div
              role="radiogroup"
              aria-labelledby="notification-sound-choice-label"
              aria-describedby="notification-sound-choice-desc"
              className="flex items-center gap-3 shrink-0"
            >
              <label className="flex items-center gap-1.5 text-xs text-[color:var(--text-sub)] cursor-pointer">
                <input
                  type="radio"
                  name="notification-sound-choice"
                  value="default"
                  checked={notificationSoundChoice === 'default'}
                  aria-describedby="notification-sound-choice-desc"
                  onChange={() => onChangeNotificationSoundChoice('default')}
                />
                {t('settings.notificationSoundChoiceDefault')}
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[color:var(--text-sub)] cursor-pointer">
                <input
                  type="radio"
                  name="notification-sound-choice"
                  value="none"
                  checked={notificationSoundChoice === 'none'}
                  aria-describedby="notification-sound-choice-desc"
                  onChange={() => onChangeNotificationSoundChoice('none')}
                />
                {t('settings.notificationSoundChoiceNone')}
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* T12 — Per-workspace mute list */}
      <div className="flex flex-col gap-2" data-testid="per-workspace-mute-section">
        <SectionLabel label={t('settings.perWorkspaceNotifications')} />
        <p className="text-[11px] text-[color:var(--text-muted)] px-1">
          {t('settings.perWorkspaceNotificationsDesc')}
        </p>
        {workspaces.length === 0 ? (
          <p
            className="text-[11px] text-[color:var(--text-muted)] px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
            data-testid="per-workspace-mute-empty"
          >
            {t('settings.perWorkspaceNotificationsEmpty')}
          </p>
        ) : (
          <div
            className="rounded-lg overflow-hidden flex flex-col"
            style={{
              backgroundColor: 'var(--bg-mantle)',
              border: '1px solid var(--bg-surface)',
              maxHeight: 240,
              overflowY: 'auto',
            }}
          >
            {workspaces.map((ws, idx) => {
              const labelId = `workspace-mute-label-${ws.id}`;
              const descId = `workspace-mute-desc-${ws.id}`;
              return (
                <label
                  key={ws.id}
                  htmlFor={`workspace-mute-${ws.id}`}
                  className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[color:var(--bg-surface)] transition-colors"
                  style={{
                    borderTop: idx === 0 ? 'none' : '1px solid var(--bg-surface)',
                  }}
                  data-testid={`per-workspace-mute-row-${ws.id}`}
                >
                  <div className="min-w-0 mr-3">
                    <p className="text-sm text-[color:var(--text-main)] truncate" id={labelId}>
                      {t('settings.muteWorkspace', { name: ws.name })}
                    </p>
                    <p className="text-[10px] text-[color:var(--text-muted)] font-mono truncate" id={descId}>
                      {ws.name}
                    </p>
                  </div>
                  <input
                    id={`workspace-mute-${ws.id}`}
                    type="checkbox"
                    checked={ws.muted}
                    aria-labelledby={labelId}
                    aria-describedby={descId}
                    onChange={(e) => onChangeWorkspaceMuted(ws.id, e.target.checked)}
                    data-testid={`per-workspace-mute-checkbox-${ws.id}`}
                    className="shrink-0 accent-[color:var(--accent-blue)] cursor-pointer"
                    style={{ width: 16, height: 16 }}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TabNotifications() {
  const t = useT();
  const notificationSoundEnabled  = useStore((s) => s.notificationSoundEnabled);
  const toggleNotificationSound   = useStore((s) => s.toggleNotificationSound);
  const toastEnabled              = useStore((s) => s.toastEnabled);
  const setToastEnabled           = useStore((s) => s.setToastEnabled);
  const notificationRingEnabled   = useStore((s) => s.notificationRingEnabled);
  const setNotificationRingEnabled = useStore((s) => s.setNotificationRingEnabled);

  // T12 fields
  const paneRingEnabled          = useStore((s) => s.paneRingEnabled);
  const setPaneRingEnabled       = useStore((s) => s.setPaneRingEnabled);
  const paneFlashEnabled         = useStore((s) => s.paneFlashEnabled);
  const setPaneFlashEnabled      = useStore((s) => s.setPaneFlashEnabled);
  const taskbarFlashEnabled      = useStore((s) => s.taskbarFlashEnabled);
  const setTaskbarFlashEnabled   = useStore((s) => s.setTaskbarFlashEnabled);
  const notificationSoundChoice  = useStore((s) => s.notificationSoundChoice);
  const setNotificationSoundChoice = useStore((s) => s.setNotificationSoundChoice);

  const workspaces = useStore((s) => s.workspaces);
  const updateWorkspaceMetadata = useStore((s) => s.updateWorkspaceMetadata);

  const workspaceRows: NotificationsViewWorkspaceRow[] = useMemo(
    () => workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      muted: ws.metadata?.notificationsMuted ?? false,
    })),
    [workspaces],
  );

  return (
    <NotificationsView
      t={t}
      notificationSoundEnabled={notificationSoundEnabled}
      onToggleNotificationSound={toggleNotificationSound}
      toastEnabled={toastEnabled}
      onChangeToastEnabled={setToastEnabled}
      notificationRingEnabled={notificationRingEnabled}
      onChangeNotificationRingEnabled={setNotificationRingEnabled}
      paneRingEnabled={paneRingEnabled}
      onChangePaneRingEnabled={setPaneRingEnabled}
      paneFlashEnabled={paneFlashEnabled}
      onChangePaneFlashEnabled={setPaneFlashEnabled}
      taskbarFlashEnabled={taskbarFlashEnabled}
      onChangeTaskbarFlashEnabled={setTaskbarFlashEnabled}
      notificationSoundChoice={notificationSoundChoice}
      onChangeNotificationSoundChoice={setNotificationSoundChoice}
      workspaces={workspaceRows}
      onChangeWorkspaceMuted={(id, muted) => updateWorkspaceMetadata(id, { notificationsMuted: muted })}
    />
  );
}

// ─── Key capture overlay ──────────────────────────────────────────────────────

function KeyCaptureOverlay({ label, onCapture, onCancel }: { label: string; onCapture: (key: string, code: string) => void; onCancel: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { onCancel(); return; }

      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      let k = e.key;
      if (k.length === 1) k = k.toUpperCase();
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(k)) {
        parts.push(k);
        onCapture(parts.join('+'), e.code);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCapture, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="px-8 py-6 rounded-xl text-center"
        style={{ backgroundColor: 'var(--bg-base)', border: '2px solid var(--accent-blue)', boxShadow: '0 0 30px rgba(137,180,250,0.3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg text-[color:var(--text-main)] font-mono mb-2">{label}</p>
        <p className="text-xs text-[color:var(--text-muted)]">ESC to cancel</p>
      </div>
    </div>
  );
}

// ─── Prefix key code to display name ─────────────────────────────────────────

const KEY_CODE_DISPLAY: Record<string, string> = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F',
  KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L',
  KeyM: 'M', KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R',
  KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X',
  KeyY: 'Y', KeyZ: 'Z',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

function keyCodeToDisplay(code: string): string {
  return KEY_CODE_DISPLAY[code] || code;
}

/**
 * Render a "Ctrl+…" key combo using the host OS convention.
 *
 * On macOS most shortcuts are mapped to ⌘ in {@link useKeyboard}; mirror that
 * here so the catalog shows what the user actually has to press.
 *
 * tmux-convention combos (Ctrl+B prefix, Ctrl+M / Ctrl+Shift+M bookmark family)
 * stay on literal Ctrl across every OS, so we never substitute ⌘ for those.
 */
function shortcutLabel(combo: string): string {
  const isMac = window.electronAPI.platform === 'darwin';
  if (!isMac) return combo;
  // Preserve tmux/bookmark conventions (must match useKeyboard.ts literalCtrl branches).
  if (combo === 'Ctrl+B' || combo === 'Ctrl+M' || combo === 'Ctrl+Shift+M') return combo;
  return combo.replace(/Ctrl/g, '⌘');
}

const PREFIX_ACTION_IDS = [
  'splitHorizontal', 'splitVertical', 'closePane',
  'newWorkspace', 'nextWorkspace', 'prevWorkspace',
  'hideWindow', 'toggleZoom', 'commandPalette',
  'renameWorkspace', 'killWorkspace', 'showCheatSheet',
  'focusUp', 'focusDown', 'focusLeft', 'focusRight',
] as const;

function prefixActionLabel(actionId: string, t: (key: string) => string): string {
  return t(`settings.prefix.${actionId}` as Parameters<typeof t>[0]) || actionId;
}

// ─── Shortcuts tab ────────────────────────────────────────────────────────────

function TabShortcuts() {
  const t = useT();

  const customKeybindings = useStore((s) => s.customKeybindings);
  const addKeybinding = useStore((s) => s.addKeybinding);
  const updateKeybinding = useStore((s) => s.updateKeybinding);
  const removeKeybinding = useStore((s) => s.removeKeybinding);
  const prefixConfig = useStore((s) => s.prefixConfig);
  const setPrefixKey = useStore((s) => s.setPrefixKey);
  const setPrefixBinding = useStore((s) => s.setPrefixBinding);
  const removePrefixBinding = useStore((s) => s.removePrefixBinding);
  const resetPrefixConfig = useStore((s) => s.resetPrefixConfig);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [capturingPrefixKey, setCapturingPrefixKey] = useState(false);
  const [capturingBindingKey, setCapturingBindingKey] = useState<string | null>(null);
  const [addingBinding, setAddingBinding] = useState(false);

  const BUILTIN_KEYS = new Set([
    'Ctrl+B', 'Ctrl+N', 'Ctrl+D', 'Ctrl+T', 'Ctrl+W', 'Ctrl+F',
    'Ctrl+K', 'Ctrl+I', 'Ctrl+,',
    'Ctrl+Shift+W', 'Ctrl+Shift+D', 'Ctrl+Shift+L', 'Ctrl+Shift+X',
    'Ctrl+Shift+H', 'Ctrl+Shift+R', 'Ctrl+Shift+U', 'Ctrl+Shift+O',
    'Ctrl+Shift+]', 'Ctrl+Shift+[', 'Ctrl+Shift+M', 'Ctrl+Shift+Q',
  ]);

  const prefixKeyDisplay = `Ctrl+${keyCodeToDisplay(prefixConfig.key)}`;
  const bindingEntries = Object.entries(prefixConfig.bindings);

  // OS-aware labels — macOS shows ⌘ for the cmdOrCtrl family, literal Ctrl for
  // tmux/bookmark family. prefixKeyDisplay always renders as literal Ctrl
  // because the prefix combo stays on Ctrl across every OS.
  const shortcuts = [
    { keys: prefixKeyDisplay,                description: t('settings.prefixMode') },
    { keys: shortcutLabel('Ctrl+D'),         description: t('settings.sc.splitHorizontal') },
    { keys: shortcutLabel('Ctrl+Shift+D'),   description: t('settings.sc.splitVertical') },
    { keys: shortcutLabel('Ctrl+T'),         description: t('settings.sc.newWorkspace') },
    { keys: shortcutLabel('Ctrl+W'),         description: t('settings.sc.closeSurface') },
    { keys: shortcutLabel('Ctrl+Shift+Q'),   description: t('settings.sc.closePane') },
    { keys: shortcutLabel('Ctrl+F'),         description: t('settings.sc.searchTerminal') },
    { keys: shortcutLabel('Ctrl+K'),         description: t('settings.sc.commandPalette') },
    { keys: shortcutLabel('Ctrl+I'),         description: t('settings.sc.toggleNotifications') },
    { keys: shortcutLabel('Ctrl+Shift+X'),   description: t('settings.sc.viCopyMode') },
    { keys: shortcutLabel('Ctrl+Shift+R'),   description: t('settings.sc.renameWorkspace') },
    { keys: shortcutLabel('Ctrl+Shift+H'),   description: t('settings.sc.highlightPane') },
    { keys: shortcutLabel('Ctrl+`'),         description: t('settings.sc.floatingPane') },
  ];

  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label={t('settings.shortcuts')} />
      <div
        className="rounded-lg overflow-hidden py-1"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        {shortcuts.map((s) => (
          <KbdRow key={s.keys} keys={s.keys} description={s.description} />
        ))}
      </div>
      {/* Prefix mode configuration */}
      <SectionLabel label={t('settings.prefixMode')} />

      {/* Prefix trigger key */}
      <div
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        <span className="text-[11px] text-[color:var(--text-sub)] font-mono flex-1">
          {t('settings.prefixKey')}
        </span>
        <span className="text-[10px] text-[color:var(--text-muted)]">{t('settings.prefixKeyDesc')}</span>
        <button
          className="text-[11px] font-mono px-3 py-1 rounded shrink-0"
          style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-blue)', border: '1px solid var(--bg-overlay)', minWidth: 50, textAlign: 'center' }}
          onClick={() => setCapturingPrefixKey(true)}
        >
          {keyCodeToDisplay(prefixConfig.key)}
        </button>
      </div>

      {/* Prefix bindings list */}
      <div className="text-[10px] text-[color:var(--text-muted)] mt-1 mb-1 px-1 flex items-center justify-between">
        <span>{t('settings.prefixBindings')}</span>
        <button
          className="text-[10px] text-[color:var(--accent-yellow)] hover:text-[color:var(--text-main)] transition-colors"
          onClick={() => { if (confirm(t('settings.prefixResetConfirm'))) resetPrefixConfig(); }}
        >
          {t('settings.prefixReset')}
        </button>
      </div>
      <div
        className="rounded-lg overflow-hidden"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        {bindingEntries.length === 0 ? (
          <p className="text-[11px] text-[color:var(--text-muted)] px-3 py-2">{t('settings.kb.noBindings')}</p>
        ) : (
          bindingEntries.map(([key, actionId]) => (
            <div key={key} className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: '1px solid var(--bg-surface)' }}>
              <button
                className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-green)', border: '1px solid var(--bg-overlay)', minWidth: 50, textAlign: 'center' }}
                onClick={() => setCapturingBindingKey(key)}
              >
                {key}
              </button>
              <span className="text-[10px] text-[color:var(--text-muted)]">&rarr;</span>
              <select
                className="flex-1 bg-transparent text-[11px] text-[color:var(--text-sub)] font-mono outline-none cursor-pointer"
                value={actionId}
                onChange={(e) => {
                  removePrefixBinding(key);
                  setPrefixBinding(key, e.target.value);
                }}
              >
                {PREFIX_ACTION_IDS.map((aid) => (
                  <option key={aid} value={aid}>{prefixActionLabel(aid, t)}</option>
                ))}
              </select>
              <button
                className="text-[color:var(--text-subtle)] hover:text-[color:var(--accent-red)] text-xs transition-colors shrink-0"
                onClick={() => removePrefixBinding(key)}
                title={t('settings.kb.delete')}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add prefix binding */}
      <button
        className="mt-1 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-green)', border: '1px solid var(--bg-overlay)' }}
        onClick={() => setAddingBinding(true)}
      >
        + {t('settings.prefixAddBinding')}
      </button>

      {/* Prefix key capture overlay */}
      {capturingPrefixKey && (
        <KeyCaptureOverlay
          label={t('settings.prefixKey')}
          onCapture={(_key, code) => {
            setPrefixKey(code);
            setCapturingPrefixKey(false);
          }}
          onCancel={() => setCapturingPrefixKey(false)}
        />
      )}

      {/* Binding key capture overlay (re-assign existing binding to new key) */}
      {capturingBindingKey && (
        <KeyCaptureOverlay
          label={t('settings.prefixTrigger')}
          onCapture={(captured) => {
            const rawKey = captured.split('+').pop() || captured;
            const oldAction = prefixConfig.bindings[capturingBindingKey];
            if (oldAction) {
              removePrefixBinding(capturingBindingKey);
              setPrefixBinding(rawKey, oldAction);
            }
            setCapturingBindingKey(null);
          }}
          onCancel={() => setCapturingBindingKey(null)}
        />
      )}

      {/* Add new binding: capture key then pick action */}
      {addingBinding && (
        <KeyCaptureOverlay
          label={t('settings.prefixTrigger')}
          onCapture={(captured) => {
            const rawKey = captured.split('+').pop() || captured;
            const usedActions = new Set(Object.values(prefixConfig.bindings));
            const firstUnused = PREFIX_ACTION_IDS.find((a) => !usedActions.has(a)) || PREFIX_ACTION_IDS[0];
            setPrefixBinding(rawKey, firstUnused);
            setAddingBinding(false);
          }}
          onCancel={() => setAddingBinding(false)}
        />
      )}

      {/* Custom keybindings */}
      <SectionLabel label={t('settings.customKeybindings')} />

      {customKeybindings.length === 0 ? (
        <p className="text-[11px] text-[color:var(--text-muted)] px-1">{t('settings.kb.noBindings')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {customKeybindings.map((kb) => (
            <div
              key={kb.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
            >
              {/* Key badge */}
              <button
                className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-blue)', border: '1px solid var(--bg-overlay)', minWidth: 60, textAlign: 'center' }}
                onClick={() => setCapturingFor(kb.id)}
              >
                {kb.key}
              </button>

              {/* Conflict warning */}
              {BUILTIN_KEYS.has(kb.key) && (
                <span className="text-[9px] text-[color:var(--accent-yellow)] shrink-0" title={t('settings.kb.conflict')}>!</span>
              )}

              {/* Label */}
              <input
                className="flex-1 bg-transparent text-xs text-[color:var(--text-main)] outline-none min-w-0 font-mono"
                style={{ maxWidth: 100 }}
                value={kb.label}
                onChange={(e) => updateKeybinding(kb.id, { label: e.target.value })}
                placeholder={t('settings.kb.label')}
                onClick={(e) => e.stopPropagation()}
              />

              {/* Command */}
              <input
                className="flex-[2] bg-transparent text-xs text-[color:var(--text-sub2)] outline-none min-w-0 font-mono"
                value={kb.command}
                onChange={(e) => updateKeybinding(kb.id, { command: e.target.value })}
                placeholder={t('settings.kb.command')}
                onClick={(e) => e.stopPropagation()}
              />

              {/* Send Enter toggle */}
              <Toggle
                checked={kb.sendEnter}
                onChange={(v) => updateKeybinding(kb.id, { sendEnter: v })}
                label={t('settings.kb.sendEnter')}
              />

              {/* Delete */}
              <button
                className="text-[color:var(--text-subtle)] hover:text-[color:var(--accent-red)] text-xs transition-colors shrink-0"
                onClick={() => removeKeybinding(kb.id)}
                title={t('settings.kb.delete')}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add button */}
      <button
        className="mt-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-green)', border: '1px solid var(--bg-overlay)' }}
        onClick={() => setCapturingFor('new')}
      >
        + {t('settings.kb.add')}
      </button>

      {/* Key capture overlay */}
      {capturingFor && (
        <KeyCaptureOverlay
          label={t('settings.kb.pressKey')}
          onCapture={(key, _code) => {
            if (capturingFor === 'new') {
              addKeybinding({ key, label: '', command: '', sendEnter: true });
            } else {
              updateKeybinding(capturingFor, { key });
            }
            setCapturingFor(null);
          }}
          onCancel={() => setCapturingFor(null)}
        />
      )}
    </div>
  );
}

// ─── First-run setup tab (T8b) ────────────────────────────────────────────────
//
// Surfaces the first-run wizard status (Claude detected? wmux MCP registered?
// last-completed timestamp) plus two action buttons:
//   - "Open setup wizard"  → dispatches FIRST_RUN_REOPEN_EVENT window event
//                            (T8a's AppLayout listens and re-mounts the wizard
//                            in mode='reopen').
//   - "Show keyboard cheat sheet" → flips `cheatSheetDismissed` to false in
//                            uiSlice; T8a's effect remounts the cheat sheet.
//
// Section name is "First-run setup" (D7-C4 — avoids collision with the
// existing "Onboarding" spotlight tutorial).
//
// Pure helpers are exported for unit tests (mirrors FirstRunWizard pattern —
// vitest runs in a `node` env without a DOM library, so we test via
// renderToStaticMarkup + pure helpers).

/** Format an ISO timestamp as YYYY-MM-DD. Returns '' for undefined / invalid. */
export function formatFirstRunDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Locally-narrowed view of the firstRun preload bridge (matches T1 freeze). */
interface FirstRunBridge {
  check: () => Promise<FirstRunCheckResult>;
}

function firstRunBridgeOrNull(): FirstRunBridge | null {
  const api = (window as unknown as {
    electronAPI?: { firstRun?: FirstRunBridge };
  }).electronAPI;
  return api?.firstRun ?? null;
}

interface FirstRunStatusViewProps {
  status: FirstRunCheckResult | null;
  onOpenWizard: () => void;
  onShowCheatSheet: () => void;
}

/**
 * Pure presentational block exported for renderToStaticMarkup tests.
 *
 * Renders the four status rows + the two action buttons. State + event wiring
 * lives in {@link TabFirstRunSetup}; this component just receives the data.
 */
export function FirstRunStatusView({ status, onOpenWizard, onShowCheatSheet }: FirstRunStatusViewProps) {
  const t = useT();

  const lastCompleted = status?.completedAt
    ? t('settings.firstRunSetup.lastCompleted', { date: formatFirstRunDate(status.completedAt) })
    : t('settings.firstRunSetup.notCompleted');

  const claudeFound = !!status?.status.claudeFound;
  const mcpRegistered = !!status?.status.mcpRegistered;

  const claudeStatusText = t('settings.firstRunSetup.claudeStatus', {
    status: claudeFound
      ? t('settings.firstRunSetup.statusDetected')
      : t('settings.firstRunSetup.statusNotDetected'),
  });
  const mcpStatusText = t('settings.firstRunSetup.mcpStatus', {
    status: mcpRegistered
      ? t('settings.firstRunSetup.statusRegistered')
      : t('settings.firstRunSetup.statusNotRegistered'),
  });

  return (
    <div className="flex flex-col gap-4" data-testid="first-run-setup-section">
      {/* Status */}
      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.firstRunSetup')} />

        <div
          className="px-3 py-2.5 rounded-lg"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
          data-testid="first-run-setup-last-completed"
        >
          <p className="text-sm text-[color:var(--text-main)]">{lastCompleted}</p>
          <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">
            {t('settings.firstRunSetupDesc')}
          </p>
        </div>

        <div
          className="px-3 py-2 rounded-lg flex items-center gap-2"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
          data-testid="first-run-setup-claude-row"
        >
          <span
            className="text-[10px] font-mono w-3 text-center"
            style={{ color: claudeFound ? 'var(--accent-green, #a6e3a1)' : 'var(--accent-red, #f38ba8)' }}
          >
            {claudeFound ? '✓' : '✗'}
          </span>
          <span className="text-sm text-[color:var(--text-main)] font-mono">{claudeStatusText}</span>
        </div>

        <div
          className="px-3 py-2 rounded-lg flex items-center gap-2"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
          data-testid="first-run-setup-mcp-row"
        >
          <span
            className="text-[10px] font-mono w-3 text-center"
            style={{ color: mcpRegistered ? 'var(--accent-green, #a6e3a1)' : 'var(--accent-red, #f38ba8)' }}
          >
            {mcpRegistered ? '✓' : '✗'}
          </span>
          <span className="text-sm text-[color:var(--text-main)] font-mono">{mcpStatusText}</span>
        </div>

        {status?.status.claudeJsonPath && (
          <p
            className="text-[10px] text-[color:var(--text-muted)] mt-0.5 font-mono truncate px-3"
            title={status.status.claudeJsonPath}
            data-testid="first-run-setup-claude-path"
          >
            {status.status.claudeJsonPath}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenWizard}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--accent-blue)',
            border: '1px solid var(--bg-overlay)',
          }}
          data-testid="first-run-setup-open-wizard"
        >
          {t('settings.firstRunSetup.openWizard')}
        </button>
        <button
          onClick={onShowCheatSheet}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-main)',
            border: '1px solid var(--bg-overlay)',
          }}
          data-testid="first-run-setup-show-cheat-sheet"
        >
          {t('settings.firstRunSetup.showCheatSheet')}
        </button>
      </div>
    </div>
  );
}

function TabFirstRunSetup() {
  const [status, setStatus] = useState<FirstRunCheckResult | null>(null);
  const setCheatSheetDismissed = useStore((s) => s.setCheatSheetDismissed);

  useEffect(() => {
    const api = firstRunBridgeOrNull();
    if (!api) return;
    let cancelled = false;
    api.check()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        // Silent — dev shells without preload should render the empty state.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenWizard = useCallback(() => {
    // Cross-component contract with T8a: AppLayout listens for this event and
    // mounts <FirstRunWizard mode='reopen' />. Zero-payload CustomEvent.
    window.dispatchEvent(new CustomEvent(FIRST_RUN_REOPEN_EVENT));
  }, []);

  const handleShowCheatSheet = useCallback(() => {
    // Approach A (per task brief): flip uiSlice flag back to false. T8a's
    // AppLayout effect on cheatSheetDismissed → false re-mounts the cheat sheet.
    setCheatSheetDismissed(false);
  }, [setCheatSheetDismissed]);

  return (
    <FirstRunStatusView
      status={status}
      onOpenWizard={handleOpenWizard}
      onShowCheatSheet={handleShowCheatSheet}
    />
  );
}

function TabAbout() {
  const t = useT();

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-col items-center gap-3 py-6 rounded-lg"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        <span className="text-3xl font-bold font-mono tracking-widest text-[color:var(--text-main)]">WMUX</span>
        <div className="flex flex-col items-center gap-1">
          <span
            className="text-xs font-mono px-2 py-0.5 rounded"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-blue)', border: '1px solid var(--bg-overlay)' }}
          >
            v{__APP_VERSION__}
          </span>
          <p className="text-[11px] text-[color:var(--text-muted)] mt-1">
            {t('settings.aboutTagline')}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.builtWith')} />
        <div
          className="px-3 py-2.5 rounded-lg flex flex-col gap-1.5"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          {[
            'Electron 41',
            'React 19 + TypeScript 5.9',
            'xterm.js 6 + node-pty',
            'Vite 5 + Tailwind CSS 3',
            'Zustand 5 + Immer',
          ].map((item) => (
            <div key={item} className="flex items-center gap-2">
              <span className="text-[color:var(--accent-green)] text-[10px]">▸</span>
              <span className="text-[12px] text-[color:var(--text-sub)] font-mono">{item}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel label={t('settings.links')} />
        <a
          href="https://github.com/openwong2kim/wmux"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-[color:var(--accent-blue)] hover:text-[color:var(--text-main)] transition-colors"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          <span>⎋</span>
          <span>{t('settings.githubRepo')}</span>
        </a>
      </div>
    </div>
  );
}

// ─── SettingsPanel ─────────────────────────────────────────────────────────────

export default function SettingsPanel() {
  const t = useT();
  const visible   = useStore((s) => s.settingsPanelVisible);
  const setVisible = useStore((s) => s.setSettingsPanelVisible);

  const [activeTab, setActiveTab] = useState<TabId>('general');
  const panelRef = useRef<HTMLDivElement>(null);

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'general',            label: t('settings.tabGeneral'),         icon: '⚙' },
    { id: 'appearance',         label: t('settings.tabAppearance'),      icon: '◑' },
    { id: 'notifications',      label: t('settings.tabNotifications'),   icon: '◎' },
    { id: 'shortcuts',          label: t('settings.tabShortcuts'),       icon: '⌨' },
    { id: 'claude-integration', label: t('claudeIntegration.tab'),       icon: '◈' },
    { id: 'first-run-setup',    label: t('settings.firstRunSetup'),      icon: '◇' },
    { id: 'about',              label: t('settings.tabAbout'),           icon: 'ℹ' },
  ];

  // Close on Escape
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setVisible(false);
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [visible, setVisible]);

  if (!visible) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setVisible(false);
      }}
    >
      {/* Panel — 800x560 */}
      <div
        ref={panelRef}
        className="flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: 800,
          height: 560,
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.75)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--bg-surface)' }}
        >
          <span className="text-sm font-semibold text-[color:var(--text-main)] font-mono tracking-wide">{t('settings.title')}</span>
          <button
            className="text-[color:var(--text-subtle)] hover:text-[color:var(--text-main)] transition-colors"
            onClick={() => setVisible(false)}
            aria-label={t('settings.close')}
          >
            <IconX />
          </button>
        </div>

        {/* Body: left nav + right content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab navigation */}
          <nav
            className="flex flex-col gap-0.5 py-3 px-2 shrink-0"
            style={{
              width: 160,
              borderRight: '1px solid var(--bg-surface)',
              backgroundColor: 'var(--bg-mantle)',
            }}
          >
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-[12px]"
                  style={{
                    backgroundColor: isActive ? 'var(--bg-surface)' : 'transparent',
                    color: isActive ? 'var(--text-main)' : 'var(--text-subtle)',
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  <span className="text-[13px] leading-none" style={{ color: isActive ? 'var(--accent-blue)' : 'var(--text-muted)' }}>
                    {tab.icon}
                  </span>
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeTab === 'general'            && <TabGeneral />}
            {activeTab === 'appearance'         && <TabAppearance />}
            {activeTab === 'notifications'      && <TabNotifications />}
            {activeTab === 'shortcuts'          && <TabShortcuts />}
            {activeTab === 'claude-integration' && <ClaudeIntegrationSection />}
            {activeTab === 'first-run-setup'    && <TabFirstRunSetup />}
            {activeTab === 'about'              && <TabAbout />}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-2.5 shrink-0"
          style={{ borderTop: '1px solid var(--bg-surface)', backgroundColor: 'var(--bg-mantle)' }}
        >
          <span className="text-[10px] text-[color:var(--text-muted)] font-mono">{t('settings.toggleHint')}</span>
          <button
            className="text-xs text-[color:var(--text-subtle)] hover:text-[color:var(--text-main)] transition-colors"
            onClick={() => setVisible(false)}
          >
            {t('settings.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Locale flag helper ───────────────────────────────────────────────────────

function localeFlag(locale: Locale): string {
  switch (locale) {
    case 'en': return '🇺🇸';
    case 'ko': return '🇰🇷';
    case 'ja': return '🇯🇵';
    case 'zh': return '🇨🇳';
    case 'zh-TW': return '🇹🇼';
    case 'ar': return '🇸🇦';
    case 'bs': return '🇧🇦';
    case 'da': return '🇩🇰';
    case 'de': return '🇩🇪';
    case 'es': return '🇪🇸';
    case 'fr': return '🇫🇷';
    case 'hi': return '🇮🇳';
    case 'id': return '🇮🇩';
    case 'it': return '🇮🇹';
    case 'ms': return '🇲🇾';
    case 'nb': return '🇳🇴';
    case 'pl': return '🇵🇱';
    case 'pt-BR': return '🇧🇷';
    case 'ru': return '🇷🇺';
    case 'th': return '🇹🇭';
    case 'tr': return '🇹🇷';
    case 'uk': return '🇺🇦';
    case 'vi': return '🇻🇳';
  }
}
