import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../stores';
import { LOCALE_OPTIONS, type Locale } from '../../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';
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
      style={{ backgroundColor: checked ? '#89b4fa' : '#45475a' }}
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
      style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
    >
      <div className="min-w-0 mr-3">
        <p className="text-sm text-[#cdd6f4]">{label}</p>
        {description && <p className="text-[11px] text-[#585b70] mt-0.5">{description}</p>}
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
      className="text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#89b4fa] font-mono"
      style={{
        backgroundColor: '#313244',
        color: '#cdd6f4',
        border: '1px solid #45475a',
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
      className="text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#89b4fa] font-mono text-center"
      style={{
        backgroundColor: '#313244',
        color: '#cdd6f4',
        border: '1px solid #45475a',
        width: 64,
      }}
    />
  );
}

// ─── Section divider label ────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-[#585b70] mb-2 mt-1 px-1">
      {label}
    </p>
  );
}

// ─── Keyboard shortcut badge ──────────────────────────────────────────────────

function KbdRow({ keys, description }: { keys: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-3 rounded-lg hover:bg-[#181825] transition-colors">
      <span className="text-[12px] text-[#bac2de]">{description}</span>
      <span
        className="text-[10px] font-mono px-2 py-0.5 rounded"
        style={{ backgroundColor: '#313244', color: '#89b4fa', border: '1px solid #45475a' }}
      >
        {keys}
      </span>
    </div>
  );
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'general',       label: 'General',       icon: '⚙' },
  { id: 'appearance',    label: 'Appearance',     icon: '◑' },
  { id: 'notifications', label: 'Notifications',  icon: '◎' },
  { id: 'shortcuts',     label: 'Shortcuts',      icon: '⌨' },
  { id: 'about',         label: 'About',          icon: 'ℹ' },
];

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

const KEYBOARD_SHORTCUTS = [
  { keys: 'Ctrl+B',         description: 'Toggle sidebar' },
  { keys: 'Ctrl+D',         description: 'Split pane horizontal' },
  { keys: 'Ctrl+Shift+D',   description: 'Split pane vertical' },
  { keys: 'Ctrl+T',         description: 'New workspace' },
  { keys: 'Ctrl+W',         description: 'Close pane / workspace' },
  { keys: 'Ctrl+F',         description: 'Search in terminal' },
  { keys: 'Ctrl+K',         description: 'Command palette' },
  { keys: 'Ctrl+I',         description: 'Toggle notification panel' },
  { keys: 'Ctrl+Shift+L',   description: 'Vi copy mode' },
  { keys: 'Ctrl+Shift+X',   description: 'Rename workspace' },
  { keys: 'Ctrl+Shift+H',   description: 'Highlight active pane' },
];

// ─── Tab content components ───────────────────────────────────────────────────

function TabGeneral({
  updateStatus,
  updateMessage,
  onCheckUpdate,
  onInstallUpdate,
}: {
  updateStatus: UpdateStatus;
  updateMessage: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);

  const [defaultShell, setDefaultShell] = useState('powershell');
  const [scrollbackLines, setScrollbackLines] = useState(10000);

  const updateButtonLabel = () => {
    switch (updateStatus) {
      case 'checking':  return 'Checking...';
      case 'up-to-date': return 'Up to date';
      case 'available': return 'Install update';
      case 'error':     return 'Retry check';
      default:          return 'Check for updates';
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Language */}
      <div>
        <SectionLabel label="Language" />
        <div className="grid grid-cols-2 gap-2">
          {LOCALE_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setLocale(value as Locale)}
              className="px-3 py-2 rounded-lg text-sm transition-colors text-left"
              style={{
                backgroundColor: locale === value ? '#313244' : 'transparent',
                color: locale === value ? '#cdd6f4' : '#6c7086',
                border: `1px solid ${locale === value ? '#89b4fa' : '#313244'}`,
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
        <SectionLabel label="Terminal" />
        <SettingRow label="Default shell" description="Shell used for new terminals">
          <SettingSelect
            label="Default shell"
            value={defaultShell}
            onChange={setDefaultShell}
            options={SHELL_OPTIONS}
          />
        </SettingRow>
        <SettingRow label="Scrollback lines" description="Lines retained in terminal buffer">
          <SettingNumberInput
            label="Scrollback lines"
            value={scrollbackLines}
            onChange={setScrollbackLines}
            min={1000}
            max={100000}
          />
        </SettingRow>
      </div>

      {/* Updates */}
      <div>
        <SectionLabel label="Updates" />
        <div
          className="px-3 py-2.5 rounded-lg flex items-center justify-between"
          style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
        >
          <div>
            <p className="text-sm text-[#cdd6f4]">wmux updates</p>
            {updateStatus === 'up-to-date' && (
              <p className="text-[11px] text-[#a6e3a1] mt-0.5">You are on the latest version</p>
            )}
            {updateStatus === 'available' && (
              <p className="text-[11px] text-[#89b4fa] mt-0.5">{updateMessage || 'A new version is available'}</p>
            )}
            {updateStatus === 'error' && (
              <p className="text-[11px] text-[#f38ba8] mt-0.5">{updateMessage || 'Failed to check for updates'}</p>
            )}
            {updateStatus === 'idle' && (
              <p className="text-[11px] text-[#585b70] mt-0.5">Last checked: never</p>
            )}
          </div>
          <button
            onClick={updateStatus === 'available' ? onInstallUpdate : onCheckUpdate}
            disabled={updateStatus === 'checking'}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ml-3"
            style={{
              backgroundColor: updateStatus === 'available' ? '#a6e3a1' : '#313244',
              color: updateStatus === 'available' ? '#1e1e2e' : '#cdd6f4',
            }}
          >
            {updateStatus === 'checking'
              ? (
                <span className="flex items-center gap-1.5">
                  <span className="animate-spin inline-block w-3 h-3 border border-current border-t-transparent rounded-full" />
                  Checking...
                </span>
              )
              : updateButtonLabel()
            }
          </button>
        </div>
      </div>
    </div>
  );
}

function TabAppearance() {
  const terminalFontSize    = useStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useStore((s) => s.setTerminalFontSize);
  const terminalFontFamily    = useStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = useStore((s) => s.setTerminalFontFamily);

  const [sidebarPosition, setSidebarPosition] = useState<'left' | 'right'>('left');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SectionLabel label="Terminal" />
        <SettingRow label="Font size" description={`${terminalFontSize}px — range 12~24`}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={12}
              max={24}
              value={terminalFontSize}
              onChange={(e) => setTerminalFontSize(Number(e.target.value))}
              aria-label="Terminal font size"
              className="w-24 accent-[#89b4fa]"
            />
            <span className="text-xs font-mono text-[#bac2de] w-6 text-right">{terminalFontSize}</span>
          </div>
        </SettingRow>
        <SettingRow label="Font family" description="Monospace font for terminal">
          <SettingSelect
            label="Terminal font family"
            value={terminalFontFamily}
            onChange={setTerminalFontFamily}
            options={FONT_FAMILY_OPTIONS}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel label="Layout" />
        <SettingRow label="Sidebar position" description="Left or right of the terminal area">
          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid #45475a' }}>
            {(['left', 'right'] as const).map((pos) => (
              <button
                key={pos}
                onClick={() => setSidebarPosition(pos)}
                className="px-3 py-1 text-xs font-mono capitalize transition-colors"
                style={{
                  backgroundColor: sidebarPosition === pos ? '#89b4fa' : '#313244',
                  color: sidebarPosition === pos ? '#1e1e2e' : '#6c7086',
                }}
              >
                {pos}
              </button>
            ))}
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

function TabNotifications() {
  const notificationSoundEnabled  = useStore((s) => s.notificationSoundEnabled);
  const toggleNotificationSound   = useStore((s) => s.toggleNotificationSound);
  const toastEnabled              = useStore((s) => s.toastEnabled);
  const setToastEnabled           = useStore((s) => s.setToastEnabled);
  const notificationRingEnabled   = useStore((s) => s.notificationRingEnabled);
  const setNotificationRingEnabled = useStore((s) => s.setNotificationRingEnabled);

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel label="Notification behavior" />
      <SettingRow label="Sound" description="Web Audio API — no external file required">
        <Toggle
          checked={notificationSoundEnabled}
          onChange={() => toggleNotificationSound()}
          label="Toggle notification sound"
        />
      </SettingRow>
      <SettingRow label="Toast notifications" description="Show overlay toast when agent completes">
        <Toggle
          checked={toastEnabled}
          onChange={setToastEnabled}
          label="Toggle toast notifications"
        />
      </SettingRow>
      <SettingRow label="Ring animation" description="Pulse border on panes with unread notifications">
        <Toggle
          checked={notificationRingEnabled}
          onChange={setNotificationRingEnabled}
          label="Toggle notification ring animation"
        />
      </SettingRow>
    </div>
  );
}

function TabShortcuts() {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Keyboard shortcuts (reference)" />
      <div
        className="rounded-lg overflow-hidden py-1"
        style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
      >
        {KEYBOARD_SHORTCUTS.map((s) => (
          <KbdRow key={s.keys} keys={s.keys} description={s.description} />
        ))}
      </div>
      <p className="text-[10px] text-[#585b70] mt-2 px-1">
        Shortcut customization is not yet available.
      </p>
    </div>
  );
}

function TabAbout() {
  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-col items-center gap-3 py-6 rounded-lg"
        style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
      >
        <span className="text-3xl font-bold font-mono tracking-widest text-[#cdd6f4]">WMUX</span>
        <div className="flex flex-col items-center gap-1">
          <span
            className="text-xs font-mono px-2 py-0.5 rounded"
            style={{ backgroundColor: '#313244', color: '#89b4fa', border: '1px solid #45475a' }}
          >
            v1.0.0
          </span>
          <p className="text-[11px] text-[#585b70] mt-1">
            Windows native AI agent terminal
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel label="Built with" />
        <div
          className="px-3 py-2.5 rounded-lg flex flex-col gap-1.5"
          style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
        >
          {[
            'Electron 41',
            'React 19 + TypeScript 5.9',
            'xterm.js 6 + node-pty',
            'Vite 5 + Tailwind CSS 3',
            'Zustand 5 + Immer',
          ].map((item) => (
            <div key={item} className="flex items-center gap-2">
              <span className="text-[#a6e3a1] text-[10px]">▸</span>
              <span className="text-[12px] text-[#bac2de] font-mono">{item}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel label="Links" />
        <a
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-[#89b4fa] hover:text-[#cdd6f4] transition-colors"
          style={{ backgroundColor: '#181825', border: '1px solid #313244' }}
        >
          <span>⎋</span>
          <span>GitHub Repository</span>
        </a>
      </div>
    </div>
  );
}

// ─── SettingsPanel ─────────────────────────────────────────────────────────────

export default function SettingsPanel() {
  const visible   = useStore((s) => s.settingsPanelVisible);
  const setVisible = useStore((s) => s.setSettingsPanelVisible);

  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateMessage, setUpdateMessage] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Listen for update events from main process
  useEffect(() => {
    const unsubAvailable = window.electronAPI.updater.onUpdateAvailable((data) => {
      if (data.status === 'downloaded') {
        setUpdateStatus('available');
        setUpdateMessage(data.releaseName ?? 'Update ready');
      } else {
        setUpdateStatus('available');
        setUpdateMessage(data.releaseName ?? 'Update available');
      }
    });

    const unsubNotAvail = window.electronAPI.updater.onUpdateNotAvailable(() => {
      setUpdateStatus('up-to-date');
      setUpdateMessage('');
    });

    const unsubError = window.electronAPI.updater.onUpdateError((data) => {
      setUpdateStatus('error');
      setUpdateMessage(data.message ?? 'Unknown error');
    });

    return () => {
      unsubAvailable();
      unsubNotAvail();
      unsubError();
    };
  }, []);

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

  const handleCheckUpdate = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateMessage('');
    try {
      const result = await window.electronAPI.updater.checkForUpdates();
      if (result.status === 'not-available') {
        setUpdateStatus('up-to-date');
      }
    } catch {
      setUpdateStatus('error');
      setUpdateMessage('Check failed');
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    await window.electronAPI.updater.installUpdate();
  }, []);

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
      {/* Panel — 600x450 */}
      <div
        ref={panelRef}
        className="flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: 600,
          height: 450,
          backgroundColor: '#1e1e2e',
          border: '1px solid #313244',
          boxShadow: '0 25px 60px rgba(0,0,0,0.75)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: '1px solid #313244' }}
        >
          <span className="text-sm font-semibold text-[#cdd6f4] font-mono tracking-wide">Settings</span>
          <button
            className="text-[#6c7086] hover:text-[#cdd6f4] transition-colors"
            onClick={() => setVisible(false)}
            aria-label="Close settings"
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
              width: 140,
              borderRight: '1px solid #313244',
              backgroundColor: '#181825',
            }}
          >
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-[12px]"
                  style={{
                    backgroundColor: isActive ? '#313244' : 'transparent',
                    color: isActive ? '#cdd6f4' : '#6c7086',
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  <span className="text-[13px] leading-none" style={{ color: isActive ? '#89b4fa' : '#585b70' }}>
                    {tab.icon}
                  </span>
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeTab === 'general' && (
              <TabGeneral
                updateStatus={updateStatus}
                updateMessage={updateMessage}
                onCheckUpdate={handleCheckUpdate}
                onInstallUpdate={handleInstallUpdate}
              />
            )}
            {activeTab === 'appearance'    && <TabAppearance />}
            {activeTab === 'notifications' && <TabNotifications />}
            {activeTab === 'shortcuts'     && <TabShortcuts />}
            {activeTab === 'about'         && <TabAbout />}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-2.5 shrink-0"
          style={{ borderTop: '1px solid #313244', backgroundColor: '#181825' }}
        >
          <span className="text-[10px] text-[#585b70] font-mono">Ctrl+, to toggle</span>
          <button
            className="text-xs text-[#6c7086] hover:text-[#cdd6f4] transition-colors"
            onClick={() => setVisible(false)}
          >
            Close
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
