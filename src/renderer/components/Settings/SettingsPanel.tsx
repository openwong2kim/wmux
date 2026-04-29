import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { LOCALE_OPTIONS, type Locale } from '../../i18n';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { THEME_OPTIONS, builtinToCustom, DEFAULT_CUSTOM_THEME, type BuiltinThemeId, type ThemeId } from '../../themes';
import type { CustomThemeColors } from '../../../shared/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = 'general' | 'appearance' | 'notifications' | 'shortcuts' | 'about';

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

const SHELL_OPTIONS = [
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd',        label: 'Command Prompt' },
  { value: 'gitbash',   label: 'Git Bash' },
  { value: 'wsl',        label: 'WSL' },
];

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
  const autoUpdateEnabled = useStore((s) => s.autoUpdateEnabled);
  const storeSetAutoUpdate = useStore((s) => s.setAutoUpdateEnabled);
  const setAutoUpdateEnabled = (enabled: boolean) => {
    storeSetAutoUpdate(enabled);
    window.electronAPI.settings.setAutoUpdateEnabled(enabled);
  };

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
            options={SHELL_OPTIONS}
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

      {/* Reset */}
      <ResetSection />
    </div>
  );
}

// ─── Color picker row ────────────────────────────────────────────────────────

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const handleChange = useCallback((hex: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(hex), 50);
  }, [onChange]);

  return (
    <div className="flex items-center justify-between py-1 px-2">
      <span className="text-[11px] text-[color:var(--text-sub)] font-mono">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[color:var(--text-muted)] font-mono">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer border-0 p-0"
          style={{ backgroundColor: 'transparent' }}
        />
      </div>
    </div>
  );
}

// ─── Custom theme editor ─────────────────────────────────────────────────────

const UI_COLOR_GROUPS: { label: string; keys: { key: keyof CustomThemeColors; label: string }[] }[] = [
  {
    label: 'Background',
    keys: [
      { key: 'bgBase', label: 'Base' },
      { key: 'bgMantle', label: 'Mantle' },
      { key: 'bgSurface', label: 'Surface' },
      { key: 'bgOverlay', label: 'Overlay' },
    ],
  },
  {
    label: 'Text',
    keys: [
      { key: 'textMain', label: 'Main' },
      { key: 'textSub', label: 'Sub' },
      { key: 'textSub2', label: 'Sub2' },
      { key: 'textSubtle', label: 'Subtle' },
      { key: 'textMuted', label: 'Muted' },
    ],
  },
  {
    label: 'Accent',
    keys: [
      { key: 'accentBlue', label: 'Blue' },
      { key: 'accentGreen', label: 'Green' },
      { key: 'accentRed', label: 'Red' },
      { key: 'accentYellow', label: 'Yellow' },
      { key: 'accentPink', label: 'Pink' },
      { key: 'accentTeal', label: 'Teal' },
      { key: 'accentPurple', label: 'Purple' },
      { key: 'accentCursor', label: 'Cursor' },
    ],
  },
  {
    label: 'Terminal',
    keys: [
      { key: 'xtermBackground', label: 'Background' },
      { key: 'xtermForeground', label: 'Foreground' },
      { key: 'xtermCursor', label: 'Cursor' },
      { key: 'xtermSelection', label: 'Selection' },
      { key: 'xtermBlack', label: 'Black' },
      { key: 'xtermRed', label: 'Red' },
      { key: 'xtermGreen', label: 'Green' },
      { key: 'xtermYellow', label: 'Yellow' },
      { key: 'xtermBlue', label: 'Blue' },
      { key: 'xtermMagenta', label: 'Magenta' },
      { key: 'xtermCyan', label: 'Cyan' },
      { key: 'xtermWhite', label: 'White' },
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

function CustomThemeEditor() {
  const t = useT();
  const customThemeColors = useStore((s) => s.customThemeColors) ?? DEFAULT_CUSTOM_THEME;
  const setCustomThemeColors = useStore((s) => s.setCustomThemeColors);
  const updateCustomThemeColor = useStore((s) => s.updateCustomThemeColor);
  const [expandedGroup, setExpandedGroup] = useState<string | null>('Accent');

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

      {/* Color groups (accordion) */}
      {UI_COLOR_GROUPS.map((group) => (
        <div
          key={group.label}
          className="rounded-lg overflow-hidden"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          <button
            className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold text-[color:var(--text-sub)] uppercase tracking-wider"
            onClick={() => setExpandedGroup(expandedGroup === group.label ? null : group.label)}
          >
            <span>{group.label}</span>
            <span className="text-[10px] text-[color:var(--text-muted)]">
              {expandedGroup === group.label ? '▾' : '▸'}
            </span>
          </button>
          {expandedGroup === group.label && (
            <div className="pb-1">
              {group.keys.map(({ key, label }) => (
                <ColorRow
                  key={key}
                  label={label}
                  value={customThemeColors[key]}
                  onChange={(v) => updateCustomThemeColor(key, v)}
                />
              ))}
            </div>
          )}
        </div>
      ))}
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

function TabNotifications() {
  const t = useT();
  const notificationSoundEnabled  = useStore((s) => s.notificationSoundEnabled);
  const toggleNotificationSound   = useStore((s) => s.toggleNotificationSound);
  const toastEnabled              = useStore((s) => s.toastEnabled);
  const setToastEnabled           = useStore((s) => s.setToastEnabled);
  const notificationRingEnabled   = useStore((s) => s.notificationRingEnabled);
  const setNotificationRingEnabled = useStore((s) => s.setNotificationRingEnabled);

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel label={t('settings.notificationBehavior')} />
      <SettingRow label={t('settings.sound')} description={t('settings.soundDesc')}>
        <Toggle
          checked={notificationSoundEnabled}
          onChange={() => toggleNotificationSound()}
          label={t('settings.sound')}
        />
      </SettingRow>
      <SettingRow label={t('settings.toast')} description={t('settings.toastDesc')}>
        <Toggle
          checked={toastEnabled}
          onChange={setToastEnabled}
          label={t('settings.toast')}
        />
      </SettingRow>
      <SettingRow label={t('settings.ring')} description={t('settings.ringDesc')}>
        <Toggle
          checked={notificationRingEnabled}
          onChange={setNotificationRingEnabled}
          label={t('settings.ring')}
        />
      </SettingRow>
    </div>
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
    'Ctrl+Shift+]', 'Ctrl+Shift+[', 'Ctrl+Shift+M',
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
    { keys: shortcutLabel('Ctrl+W'),         description: t('settings.sc.closePane') },
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
    { id: 'general',       label: t('settings.tabGeneral'),       icon: '⚙' },
    { id: 'appearance',    label: t('settings.tabAppearance'),    icon: '◑' },
    { id: 'notifications', label: t('settings.tabNotifications'), icon: '◎' },
    { id: 'shortcuts',     label: t('settings.tabShortcuts'),     icon: '⌨' },
    { id: 'about',         label: t('settings.tabAbout'),         icon: 'ℹ' },
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
            {activeTab === 'general' && <TabGeneral />}
            {activeTab === 'appearance'    && <TabAppearance />}
            {activeTab === 'notifications' && <TabNotifications />}
            {activeTab === 'shortcuts'     && <TabShortcuts />}
            {activeTab === 'about'         && <TabAbout />}
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
  }
}
