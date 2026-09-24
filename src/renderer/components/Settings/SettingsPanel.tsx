import { QuickCommandsSection } from './QuickCommandsSection';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { BROWSER_BACKENDS, isBrowserBackend } from '../../../shared/browserBackend';
import { isWslShellPath } from '../../../shared/wslDistro';
import type { ImagePasteMode } from '../../../shared/imagePaste';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceMuteRows } from '../../stores/selectors/workspaceProjections';
import { LOCALE_OPTIONS, type Locale } from '../../i18n';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { THEME_OPTIONS, XTERM_PALETTE_OPTIONS, XTERM_PALETTES, builtinToCustom, DEFAULT_CUSTOM_THEME, deriveBuiltinPalette, deriveFullPalette, tokenAttrs, type BuiltinThemeId, type ThemeId, type XtermPaletteId, type UIThemeTokenKey, type TokenRole, type FullCssPalette } from '../../themes';
import {
  TAILWIND_PALETTE,
  TAILWIND_SHADES,
  TAILWIND_HUES,
  TAILWIND_NEUTRAL_HUES,
  TAILWIND_COLOR_HUES,
  nearestTailwindSwatch,
  type TailwindHue,
} from '../../tailwindPalette';
import {
  evaluateToken,
  nudgeForReport,
  type ForegroundTokenKey,
  type ContrastReport,
} from '../../contrastSafety';
import type { CustomThemeColors, NotificationCategory, Workspace, XtermThemeColors } from '../../../shared/types';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import { destroyWorkspaceRemoteSessions } from '../../utils/remoteSessionTeardown';
import type { ChromePreset } from '../../../shared/chromePresets';
import { NOTIFICATION_CATEGORIES } from '../../../shared/types';
import { ORCH_ROLES, launcherSupportsModelFlag } from '../../../shared/orchestratorRole';
import {
  DEFAULT_FANOUT_WORKER_PERMISSION_MODE,
  FANOUT_WORKER_PERMISSION_MODES,
  isFanoutWorkerPermissionMode,
  type FanoutWorkerPermissionMode,
} from '../../../shared/workerLaunch';
import { ADVERTISED_SHORTCUTS, builtinCombosFor, macDisplayCombo, type KeymapEntry } from '../../../shared/keymap';
import { MODEL_OPTIONS } from '../Deck/OrchestratorModelChip';
import { MULTIVIEW_ARRANGEMENTS } from '../../utils/multiviewGrid';
import type { NicInfo, LanLinkNic, LanLinkStatus, LanLinkPeerSummary } from '../../../shared/lanlink';
import type { FirstRunCheckResult } from '../../../shared/firstRun';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { notifyBriefingConfigChanged } from '../Deck/deckBriefingConfigBus';
import { ClaudeIntegrationSection } from './ClaudeIntegrationSection';
import { IntegrationSetupSectionContainer, MCP_STATUS_CHANGED_EVENT } from './IntegrationSetupSection';
import { AccountsSection } from './AccountsSection';
import { terminalFontFamilyCss } from '../../utils/terminalFont';
import { hasBareFunctionKeyBinding } from '../../utils/functionKeyBinding';
import { Icon, IconX, IconCheck, IconChevron, IconExternalLink, IconBrowser, IconUsers, IconRobot, IconRemoteDevices, IconPlus, IconWarning } from '../icons';
import PairedDevicesModal from '../StatusBar/PairedDevicesModal';
import { FOCUS_RING } from '../focusRing';
import { SETTINGS_CATALOG, SETTINGS_NAV_GROUPS, resolveSettingsTab, type SettingsTabId } from '../../settings/catalog';
import { matchSettings, tabHitCount } from '../../settings/searchSettings';
import { CursorShapePicker } from './CursorShapePicker';
import { SettingsSearchResults } from './SettingsSearchResults';
import UiButton from '../ui/Button';
import Switch from '../ui/Switch';
import Checkbox from '../ui/Checkbox';
import Select from '../ui/Select';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import Badge from '../ui/Badge';
import './settings.css';
import { SettingsSection, SettingRow, SettingNote } from './SettingsLayout';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = SettingsTabId;
type ShellInfo = { name: string; path: string; args?: string[] };

// ─── Card primitive ────────────────────────────────────────────────────────────
//
// A free-form quiet container (12px radius, surface hairline + fill) for the
// few blocks that are not a list of rows: the About header, the role-binding
// grid, the custom theme editor's panels. Lists of settings use
// SettingsSection, which draws ONE container around its rows.

function Card({
  className = '',
  style,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[12px] ${className}`}
      style={{ backgroundColor: 'var(--surface-fill)', border: '1px solid var(--surface-hairline)', ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ─── Button primitive ──────────────────────────────────────────────────────────
//
// The shared ui/Button at the row size (32px, 13px). Settings is a quiet
// surface: secondary is flat, and a tab carries at most one primary — the
// action that unblocks the user first (DESIGN.md "One primary per surface").

type ButtonVariant = 'secondary' | 'primary' | 'destructive' | 'ghost';

function Button({
  variant = 'secondary',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <UiButton variant={variant} size="md" {...rest} />;
}

// ─── Status badge ──────────────────────────────────────────────────────────────
//
// A check (ok) / cross (fail) status mark. Carries an aria-label so the state
// is exposed to assistive tech.

function StatusBadge({ ok, okLabel = 'OK', failLabel = 'Not OK' }: { ok: boolean; okLabel?: string; failLabel?: string }) {
  return (
    <span
      role="img"
      aria-label={ok ? okLabel : failLabel}
      className="shrink-0 inline-flex items-center justify-center"
      style={{ color: ok ? 'var(--accent-green)' : 'var(--text-muted)', width: 14, height: 14 }}
    >
      {ok ? <IconCheck /> : <IconX />}
    </span>
  );
}

// ─── Contrast safety badge (custom theme editor, PR1) ───────────────────────
//
// Fixed high-contrast styling on purpose: this badge warns when the user's
// chosen colors are hard to read, so it must stay legible even if the live
// theme tokens are broken. It therefore NEVER uses var(--*) — every color here
// is a hardcoded, self-sufficient pair (dark glyphs on light chips). See
// plans/color-customization-inspect-mode.md §4.4.

// Self-contained palettes (no theme tokens). amber = warning, red = severe.
const CONTRAST_BADGE_STYLE = {
  ok:     { bg: '#0B3D1E', fg: '#7DE6A3', border: '#1F7A45' }, // green on near-black
  warn:   { bg: '#3D2A00', fg: '#FFC247', border: '#A06A00' }, // amber on dark amber
  severe: { bg: '#4A0F0F', fg: '#FF8A80', border: '#B02A2A' }, // red on dark red
} as const;

/**
 * Live WCAG badge for one foreground token. Renders an OK check when every
 * background pair clears AA, otherwise an amber (or red, if any pair is below
 * the 3:1 floor) warning chip describing the worst pair. Severe cases announce
 * via aria-live="assertive". Warning only — no clamping happens here.
 */
export function ContrastBadge({
  report,
  t,
  surfaceLabel,
}: {
  report: ContrastReport;
  t: (key: string, vars?: Record<string, string | number>) => string;
  surfaceLabel: (bg: string) => string;
}) {
  if (report.allPass) {
    const s = CONTRAST_BADGE_STYLE.ok;
    return (
      <span
        role="img"
        aria-label={t('settings.contrast.ok')}
        data-testid={`contrast-badge-${report.token}`}
        data-contrast-state="ok"
        className="shrink-0 inline-flex items-center justify-center rounded"
        style={{ backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}`, width: 16, height: 16 }}
      >
        <IconCheck />
      </span>
    );
  }

  const severe = report.anySevere;
  const s = severe ? CONTRAST_BADGE_STYLE.severe : CONTRAST_BADGE_STYLE.warn;
  const ratio = report.worstRatio.toFixed(1);
  const surface = surfaceLabel(report.worstBg);
  const msg = t(severe ? 'settings.contrast.severe' : 'settings.contrast.warn', { ratio, surface });

  return (
    <span
      role="img"
      aria-label={msg}
      // Severe failures (<3:1) are announced assertively; AA misses stay polite.
      aria-live={severe ? 'assertive' : 'polite'}
      data-testid={`contrast-badge-${report.token}`}
      data-contrast-state={severe ? 'severe' : 'warn'}
      className="shrink-0 inline-flex items-center gap-1 rounded px-1 font-mono tabular-nums"
      style={{ backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}`, height: 18, fontSize: 10, lineHeight: '16px' }}
    >
      <span aria-hidden="true" style={{ width: 10, height: 10, display: 'inline-flex' }}><IconX /></span>
      <span aria-hidden="true">{ratio}:1</span>
    </span>
  );
}

// ─── Tab icons (stroke line icons — 14px, currentColor) ───────────────────────

function IconGeneral() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="4.5" cy="3.5" r="1.6" fill="currentColor" />
      <circle cx="9.5" cy="7" r="1.6" fill="currentColor" />
      <circle cx="5.5" cy="10.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

function IconAppearance() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 2a5 5 0 0 1 0 10z" fill="currentColor" />
    </svg>
  );
}

function IconNotifications() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.5 9.5c.7-.7.9-1.7.9-2.9a2.6 2.6 0 0 1 5.2 0c0 1.2.2 2.2.9 2.9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.9 11.2a1.2 1.2 0 0 0 2.2 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconShortcuts() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="3.5" width="11" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="3.7" y1="5.9" x2="3.7" y2="5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="5.7" y1="5.9" x2="5.7" y2="5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="7.7" y1="5.9" x2="7.7" y2="5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="9.7" y1="5.9" x2="9.7" y2="5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="4.5" y1="8.3" x2="9.5" y2="8.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconClaude() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 1.5 8.3 5.7 12.5 7 8.3 8.3 7 12.5 5.7 8.3 1.5 7 5.7 5.7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.5 5.8 7 4 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="7.2" y1="8.7" x2="10" y2="8.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconAgents() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <line x1="7" y1="4.2" x2="4" y2="9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="7" y1="4.2" x2="10" y2="9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="7" cy="3.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.5" cy="10.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.5" cy="10.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconAbout() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="7" y1="6.4" x2="7" y2="9.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="7" y1="4.3" x2="7" y2="4.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconLanLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="2.2" width="5" height="3.4" rx="0.6" stroke="currentColor" strokeWidth="1.2" />
      <rect x="7.5" y="8.4" width="5" height="3.4" rx="0.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.6v1.7h6V8.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Toggle switch ─────────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Inert + dimmed. For a setting the CURRENT vendor/mode ignores, so the row
   *  explains itself instead of silently doing nothing when clicked. */
  disabled?: boolean;
}

/** ui/Switch with an explicit name, so a switch outside a SettingRow (a
 *  keybinding row) is still named. Inside a row the Field label names it too. */
function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />;
}

// ─── Select dropdown ──────────────────────────────────────────────────────────

function SettingSelect({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="settings-select"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
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
    <Input
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n) && n >= min && n <= max) onChange(n);
      }}
      className="settings-input tabular-nums text-center"
      style={{ width: 96 }}
    />
  );
}

// ─── Path text input (commit on blur/Enter so typing isn't trimmed live) ─────

function SettingPathInput({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <Input
      type="text"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => { if (e.key === 'Enter') onCommit(draft); }}
      // A path is machine evidence: mono, per DESIGN.md Type.
      className="settings-input font-mono"
      style={{ width: 240 }}
    />
  );
}

// ─── Keyboard shortcut badge ──────────────────────────────────────────────────

function KbdRow({ keys, description, disabled, onToggleDisabled, toggleTitle }: {
  keys: string;
  description: string;
  /** #1152 — undefined hides the toggle (rows that cannot be disabled). */
  disabled?: boolean;
  onToggleDisabled?: () => void;
  toggleTitle?: string;
}) {
  return (
    <div className="settings-row settings-kbd-row">
      <span
        className="settings-kbd-desc"
        style={disabled ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}
      >
        {description}
      </span>
      <span className="flex items-center gap-3">
        <kbd className="ui-kbd settings-kbd-hint" data-disabled={disabled || undefined}>
          {keys}
        </kbd>
        {onToggleDisabled !== undefined && (
          <Checkbox
            checked={!disabled}
            onCheckedChange={() => onToggleDisabled()}
            title={toggleTitle}
            // Unique per row — thirteen checkboxes all reading the same hint
            // would be indistinguishable to a screen reader.
            aria-label={`${description} (${keys})`}
          />
        )}
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
  { value: 'Cascadia Code',       label: 'Cascadia Code' },
  { value: 'JetBrainsMonoHangul', label: 'JetBrainsMonoHangul' },
  { value: 'Consolas',            label: 'Consolas' },
  { value: 'Fira Code',           label: 'Fira Code' },
  { value: 'JetBrains Mono',      label: 'JetBrains Mono' },
];

// Fonts shipped inside the app via @font-face (see styles/globals.css). They
// render correctly even when not installed on the machine, so the picker must
// never tag them "not installed" — unlike a system-only font like Consolas,
// which falls back to another face when absent. Keep in sync with the
// @font-face declarations in globals.css.
const BUNDLED_FONTS = new Set([
  'Cascadia Code',
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'JetBrainsMonoHangul',
]);

// ─── Reset section ───────────────────────────────────────────────────────────

function ResetSection() {
  const t = useT();
  // A1: workspaces는 이 콜백 안에서만 명령형으로 쓰인다(렌더에 미사용) — 구독을
  // 없애고 getState()로 읽어 불필요한 리렌더를 제거한다.
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const setVisible = useStore((s) => s.setSettingsPanelVisible);
  const [confirming, setConfirming] = useState(false);
  const { invoke: ipcInvoke } = useIpc();

  const handleReset = useCallback(async () => {
    const workspaces = useStore.getState().workspaces;
    // Dispose all PTYs across all workspaces
    for (const ws of workspaces) {
      disposeWorkspacePtys(ws);
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
  }, [removeWorkspace, addWorkspace, setVisible, ipcInvoke]);

  return (
    <SettingsSection id="reset" title={t('settings.reset')}>
      <SettingRow label={t('settings.resetWorkspaces')} description={t('settings.resetWorkspacesDesc')}>
        {confirming ? (
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('settings.close')}
            </Button>
            {/* The final confirm of a destructive flow: solid red. */}
            <UiButton variant="danger" size="md" onClick={handleReset}>
              {t('settings.resetButton')}
            </UiButton>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            {t('settings.resetButton')}
          </Button>
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/** Dispose every PTY a workspace owns — visible tree AND stash (#977).
 *  (traversal is the shared canonical walk; the dispose policy stays local)
 *  "Reset everything" that quietly spares stashed sessions would leave orphans
 *  behind the one action whose whole promise is a clean slate. */
function disposeWorkspacePtys(ws: Workspace) {
  for (const ptyId of getWorkspacePtyIds(ws)) window.electronAPI.pty.dispose(ptyId);
  // #1129 — remote-terminal surfaces have no ptyId; a "clean slate" that
  // leaves sessions running on a paired host is not one.
  destroyWorkspaceRemoteSessions(ws);
}

// ─── Orchestrator (deck brain) settings ──────────────────────────────────────
//
// Model picker for the Command Deck orchestrator. The value is a claude model
// alias handed to the Agent SDK ('' = the subscription's default). Applied
// between turns: main swaps the brain adapter on the next send after a change —
// the conversation itself survives via the persisted session id.

const ORCHESTRATOR_MODEL_OPTIONS = [
  { value: '',       labelKey: 'settings.orchestratorModelDefault' },
  { value: 'opus',   labelKey: '' }, // product names — no translation
  { value: 'sonnet', labelKey: '' },
  { value: 'haiku',  labelKey: '' },
];

// D2 — global role→model enforcement editor. One compact row per built-in role
// (v1 binds only the 4 fixed roles; a custom-role combobox is deferred): an
// agent select, a model combobox, and a free-text extra-args field. Writing
// through setOrchestratorRoleBinding normalizes + persists; clearing every field
// unbinds the role.
//
// The agent list keeps launchers with no verified `--model` grammar
// (opencode/gemini) because an args-only binding is still enforceable for them —
// but a row that cannot do what it looks like it does says so INLINE rather than
// no-op'ing silently. Model entry is a datalist combobox, not a <select>: only
// claude's aliases are known to us, and a codex model id (`gpt-5.5`) must be
// typeable.
const ROLE_BINDING_AGENTS = ['claude', 'codex', 'opencode', 'gemini'] as const;

// Model ids and CLI args are machine evidence, so the free-text fields are mono.
const ROLE_BINDING_FIELD_CLASS = 'settings-input font-mono';

/** The one honest thing to say about a row's current state, or none when the
 *  row does exactly what it appears to. Keeps a mis-set binding from looking
 *  bound while enforcing nothing. */
export function roleBindingHint(b: { agent?: string; model?: string; args?: string }):
  | { key: string; params?: Record<string, string> }
  | undefined {
  if (b.model && !b.agent) return { key: 'settings.roleBindingHintNoAgent' };
  if (b.model && b.agent && !launcherSupportsModelFlag(b.agent)) {
    return { key: 'settings.roleBindingHintNoGrammar', params: { agent: b.agent } };
  }
  if (b.agent && !b.model && !b.args) return { key: 'settings.roleBindingHintInert' };
  return undefined;
}

/**
 * A text input whose DISPLAYED text survives normalization while you type.
 *
 * Every write to a binding is normalized on the way into the store
 * (normalizeBindingField collapses whitespace runs and trims), so a plainly
 * controlled input re-rendered from the store ate the space the instant you
 * typed it: `--foo ` came back as `--foo`, and the next character landed as
 * `--foob`. A two-token args value could be pasted but never typed.
 *
 * So while the field has focus we render the RAW keystrokes. The persisted value
 * is still normalized on every keystroke — committing per keystroke rather than
 * on blur is deliberate, since it means no edit can be stranded by an unmount
 * (the panel closing, the section collapsing) with nothing to flush. Dropping
 * the draft on blur or Enter snaps the field back to the canonical spelling that
 * was actually stored, so the operator sees what wmux kept. A paste is just a
 * change event, and rides the same path.
 */
function DraftTextInput({
  value,
  onChange,
  ...rest
}: {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  'aria-label': string;
  type: string;
  placeholder?: string;
  list?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      {...rest}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(e);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export interface RoleBindingsViewProps {
  bindings: Record<string, { agent?: string; model?: string; args?: string }>;
  /** Called with the FULL next binding for a role (the view merges the patch). */
  onChange: (role: string, next: { agent?: string; model?: string; args?: string }) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Presentational half — the container below owns the store. Split so the view
 *  is renderable (and assertable) without a live store, matching NotificationsView. */
export function RoleBindingsView({ bindings, onChange, t }: RoleBindingsViewProps) {
  const update = (role: string, patch: { agent?: string; model?: string; args?: string }) => {
    onChange(role, { ...(bindings[role] ?? {}), ...patch });
  };

  return (
    <SettingsSection id="roles" title={t('settings.roleBindings')} description={t('settings.roleBindingsDesc')}>
      {ORCH_ROLES.map((role) => {
        const b = bindings[role] ?? {};
        const hint = roleBindingHint(b);
        const listId = `role-binding-models-${role}`;
        return (
          <div key={role} className="settings-row" data-role-binding-row={role}>
            <div className="flex items-center gap-2">
              <span className="ui-field-label w-[76px] shrink-0">{role}</span>
              <Select
                aria-label={t('settings.roleBindingAgentLabel', { role })}
                value={b.agent ?? ''}
                onChange={(e) => update(role, { agent: e.target.value })}
                className="settings-role-agent"
              >
                <option value="">{t('settings.roleBindingAgentPlaceholder')}</option>
                {ROLE_BINDING_AGENTS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </Select>
              <DraftTextInput
                aria-label={t('settings.roleBindingModelLabel', { role })}
                type="text"
                list={listId}
                value={b.model ?? ''}
                placeholder={t('settings.roleBindingModelPlaceholder')}
                onChange={(e) => update(role, { model: e.target.value })}
                className={ROLE_BINDING_FIELD_CLASS}
                style={{ width: 132 }}
              />
              {/* Suggestions only — free text is required for codex model ids.
                  We only know claude's aliases, so that is all we suggest. */}
              <datalist id={listId}>
                {b.agent === 'claude' &&
                  MODEL_OPTIONS.filter((o) => o.value).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
              </datalist>
              <DraftTextInput
                aria-label={t('settings.roleBindingArgsLabel', { role })}
                type="text"
                value={b.args ?? ''}
                placeholder={t('settings.roleBindingArgsPlaceholder')}
                onChange={(e) => update(role, { args: e.target.value })}
                className={`flex-1 min-w-0 ${ROLE_BINDING_FIELD_CLASS}`}
              />
            </div>
            {hint && (
              <p
                className="ui-field-description m-0 mt-1 pl-[84px]"
                data-role-binding-hint={role}
              >
                {t(hint.key, hint.params)}
              </p>
            )}
          </div>
        );
      })}
    </SettingsSection>
  );
}

function RoleBindingEditor() {
  const t = useT();
  const bindings = useStore((s) => s.orchestratorRoleBindings);
  const setBinding = useStore((s) => s.setOrchestratorRoleBinding);
  return <RoleBindingsView bindings={bindings} onChange={setBinding} t={t} />;
}

function OrchestratorSection() {
  const t = useT();
  const deckBrainModel = useStore((s) => s.deckBrainModel);
  const setDeckBrainModel = useStore((s) => s.setDeckBrainModel);
  const deckBrainFullPower = useStore((s) => s.deckBrainFullPower);
  const setDeckBrainFullPower = useStore((s) => s.setDeckBrainFullPower);
  const deckBrainVendor = useStore((s) => s.deckBrainVendor);
  const setDeckBrainVendor = useStore((s) => s.setDeckBrainVendor);
  const channelsTabVisible = useStore((s) => s.channelsTabVisible);
  const setChannelsTabVisible = useStore((s) => s.setChannelsTabVisible);
  // Global auto-wake switch — persisted in MAIN (deck-autowake.json) because
  // the event-push coalescer that spends the tokens lives there. Read on
  // mount; optimistic toggle with echo reconciliation.
  const [autoWake, setAutoWake] = useState(true);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.deck?.autoWake
      ?.get()
      .then((r) => { if (!cancelled) setAutoWake(r.enabled); })
      .catch(() => undefined); // keep the default-on rendering
    return () => { cancelled = true; };
  }, []);
  const onAutoWakeChange = (enabled: boolean) => {
    setAutoWake(enabled);
    window.electronAPI.deck?.autoWake
      ?.set(enabled)
      .then((r) => setAutoWake(r.enabled))
      .catch(() => setAutoWake(!enabled));
  };
  // `deck.ledgerGate` — persisted in MAIN (deck-ledger-gate.json), the same
  // file the Stop gate reads, so the toggle and the gate can never disagree and
  // the choice survives a restart. Default OFF; same optimistic-toggle-with-
  // echo shape as auto-wake, except the default rendering is off, so a failed
  // read leaves the switch showing the behaviour actually in force.
  const [ledgerGate, setLedgerGate] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.deck?.ledgerGate
      ?.get()
      .then((r) => { if (!cancelled) setLedgerGate(r.enabled); })
      .catch(() => undefined); // keep the default-off rendering
    return () => { cancelled = true; };
  }, []);
  const onLedgerGateChange = (enabled: boolean) => {
    setLedgerGate(enabled);
    window.electronAPI.deck?.ledgerGate
      ?.set(enabled)
      .then((r) => setLedgerGate(r.enabled))
      .catch(() => setLedgerGate(!enabled));
  };
  // D1 briefing toggles — persisted in MAIN (deck-briefing.json). Read on mount;
  // optimistic toggle with echo reconciliation (mirrors auto-wake).
  const [briefingEnabled, setBriefingEnabled] = useState(true);
  const [briefingAutoShow, setBriefingAutoShow] = useState(true);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.deck?.briefing
      ?.getConfig()
      .then((c) => {
        if (cancelled) return;
        setBriefingEnabled(c.enabled);
        setBriefingAutoShow(c.autoShow);
      })
      .catch(() => undefined); // keep the default-on rendering
    return () => { cancelled = true; };
  }, []);
  // A mounted DeckBriefingCard reads its config from main, not from this
  // component's state, so every confirmed change is broadcast — otherwise a card
  // that is already on screen stays visible after the operator turns it off.
  const onBriefingEnabledChange = (enabled: boolean) => {
    setBriefingEnabled(enabled);
    window.electronAPI.deck?.briefing
      ?.setConfig({ enabled })
      .then((c) => {
        setBriefingEnabled(c.enabled);
        setBriefingAutoShow(c.autoShow);
        notifyBriefingConfigChanged();
      })
      .catch(() => setBriefingEnabled(!enabled));
  };
  const onBriefingAutoShowChange = (autoShow: boolean) => {
    setBriefingAutoShow(autoShow);
    window.electronAPI.deck?.briefing
      ?.setConfig({ autoShow })
      .then((c) => {
        setBriefingEnabled(c.enabled);
        setBriefingAutoShow(c.autoShow);
        notifyBriefingConfigChanged();
      })
      .catch(() => setBriefingAutoShow(!autoShow));
  };
  const options = ORCHESTRATOR_MODEL_OPTIONS.map((o) => ({
    value: o.value,
    label: o.labelKey
      ? t(o.labelKey)
      : o.value.charAt(0).toUpperCase() + o.value.slice(1),
  }));
  return (
    <>
      <SettingsSection data-testid="orchestrator-section">
        <SettingRow id="brain"
          label={t('settings.orchestratorBrain')}
          description={t('settings.orchestratorBrainDesc')}
        >
          <SettingSelect
            value={deckBrainVendor}
            onChange={(v) =>
              setDeckBrainVendor(v === 'claude' || v === 'hermes' ? v : 'claude-pty')
            }
            options={[
              { value: 'claude', label: t('settings.orchestratorBrainClaude') },
              { value: 'claude-pty', label: t('settings.orchestratorBrainClaudePty') },
              { value: 'hermes', label: t('settings.orchestratorBrainHermes') },
            ]}
            label={t('settings.orchestratorBrain')}
          />
        </SettingRow>
        {/* Picking the terminal runtime does not only swap the agent behind the
            orchestrator: the panel itself becomes an embedded Claude Code TUI
            instead of the chat surface. That is the change people actually
            notice, and nothing said so before they picked it. */}
        {deckBrainVendor === 'claude-pty' && (
          <SettingNote data-testid="orchestrator-claude-pty-note">
            {t('settings.orchestratorBrainClaudePtyNote')}
          </SettingNote>
        )}
        <SettingRow id="model"
          label={t('settings.orchestratorModel')}
          description={t('settings.orchestratorModelDesc')}
        >
          <SettingSelect
            value={deckBrainModel}
            onChange={setDeckBrainModel}
            options={options}
            label={t('settings.orchestratorModel')}
          />
        </SettingRow>
        {/* Full power tunes settingSources/canUseTool — both SDK-only knobs. The
            terminal brain (an interactive TUI) and ACP brains ignore the flag
            entirely (see createAdapter in deck.handler), so with the terminal
            brain now the default the row would otherwise read as a toggle that
            does nothing when clicked. Inert + a reason instead of hidden: the
            setting still exists, it just belongs to the other vendor. */}
        <SettingRow
          id="fullpower"
          label={t('settings.orchestratorFullPower')}
          description={
            deckBrainVendor === 'claude'
              ? t('settings.orchestratorFullPowerDesc')
              : t('settings.orchestratorFullPowerSdkOnly')
          }
        >
          <Toggle
            checked={deckBrainFullPower}
            onChange={setDeckBrainFullPower}
            label={t('settings.orchestratorFullPower')}
            disabled={deckBrainVendor !== 'claude'}
          />
        </SettingRow>
        <SettingRow id="autowake"
          label={t('settings.autoWake')}
          description={t('settings.autoWakeDesc')}
        >
          <Toggle
            checked={autoWake}
            onChange={onAutoWakeChange}
            label={t('settings.autoWake')}
          />
        </SettingRow>
        {/* Experimental on purpose: this replaces the shipped Stop gate's
            snapshot inference with the task ledger, and the ledger has not run a
            full dogfood yet (orchestrator track, 2026-09). */}
        <SettingRow id="ledgergate"
          label={t('settings.ledgerGate')}
          description={t('settings.ledgerGateDesc')}
        >
          <div className="flex items-center gap-3">
            <Badge title={t('settings.ledgerGateDesc')}>{t('settings.mcpExperimental')}</Badge>
            <Toggle
              checked={ledgerGate}
              onChange={onLedgerGateChange}
              label={t('settings.ledgerGate')}
            />
          </div>
        </SettingRow>
        <SettingRow
          label={t('settings.channelsTabVisible')}
          description={t('settings.channelsTabVisibleDesc')}
        >
          <Toggle
            checked={channelsTabVisible}
            onChange={setChannelsTabVisible}
            label={t('settings.channelsTabVisible')}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title={t('settings.briefing')}>
        <SettingRow
          id="briefing"
          label={t('settings.briefing')}
          description={t('settings.briefingDesc')}
        >
          <Toggle
            checked={briefingEnabled}
            onChange={onBriefingEnabledChange}
            label={t('settings.briefing')}
          />
        </SettingRow>
        <SettingRow
          label={t('settings.briefingAutoShow')}
          description={t('settings.briefingAutoShowDesc')}
        >
          <Toggle
            checked={briefingAutoShow}
            onChange={onBriefingAutoShowChange}
            label={t('settings.briefingAutoShow')}
          />
        </SettingRow>
      </SettingsSection>
    </>
  );
}

// ─── MCP integration status ──────────────────────────────────────────────────

/** Mirror of McpStatusPayload in main/ipc/handlers/mcp.handler.ts. */
interface McpServerState {
  registered: boolean;
  path: string | null;
}
interface McpTargetStatusPayload {
  id: string;
  displayName: string;
  format: 'json' | 'toml';
  configPath: string;
  configExists: boolean;
  configModified: string | null;
  verified: boolean;
  wmux: McpServerState;
}
interface McpStatusPayload {
  targets: McpTargetStatusPayload[];
}

interface ElectronMcpApi {
  check: () => Promise<McpStatusPayload>;
  reregister: () => Promise<McpStatusPayload>;
  unregister: () => Promise<McpStatusPayload>;
}

/**
 * MCP servers panel in Settings → General. Surfaces whether each agent config
 * has the wmux MCP entry, plus Re-register / Unregister buttons.
 *
 * Mirrors the `wmux mcp check` CLI output so users have a one-stop way to
 * verify Claude Code can discover the wmux MCP bridge — DX D4 decision.
 */
/** Tell the setup card (and any other MCP view) to re-read. This section's
 *  own listener re-reads too, which costs one extra check and nothing else. */
function announceMcpChange(): void {
  window.dispatchEvent(new CustomEvent(MCP_STATUS_CHANGED_EVENT));
}

function McpStatusSection() {
  const t = useT();
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
    // The setup card's Register writes the same configs: re-read after it.
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

  // Section is hidden entirely when the preload doesn't expose the API —
  // keeps older dev builds clean and avoids "phantom" buttons that error.
  if (!mcpApi && !loading) return null;

  // One row per client config. The status is a Badge (neutral/success), the
  // client name is prose, and only the config path is mono (machine evidence).
  // Non-existent configs read "not detected" — the agent isn't installed, and
  // wmux never creates its config.
  const renderTarget = (target: McpTargetStatusPayload) => (
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
        {target.configExists && (
          <Badge tone={target.wmux.registered ? 'success' : 'neutral'}>
            {target.wmux.registered && <span aria-hidden="true" className="inline-flex"><IconCheck size={12} /></span>}
            {target.wmux.registered ? t('settings.mcpRegistered') : t('settings.mcpNotRegistered')}
          </Badge>
        )}
      </div>
    </div>
  );

  const actions = status ? (
    <div className="flex items-center gap-2 shrink-0">
      <Button
        variant="secondary"
        onClick={() => void handleReregister()}
        disabled={pending !== null}
      >
        {pending === 'reregister' ? '…' : t('settings.mcpReregister')}
      </Button>
      {confirmingUnregister ? (
        <>
          <Button
            variant="ghost"
            onClick={() => setConfirmingUnregister(false)}
            disabled={pending !== null}
          >
            {t('common.cancel')}
          </Button>
          <UiButton
            variant="danger"
            size="md"
            onClick={() => void handleUnregister()}
            disabled={pending !== null}
          >
            {pending === 'unregister' ? '…' : t('settings.mcpConfirm')}
          </UiButton>
        </>
      ) : (
        <Button
          variant="destructive"
          onClick={() => setConfirmingUnregister(true)}
          disabled={pending !== null}
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
          {status.targets.map((target) => renderTarget(target))}
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

// ─── LanLink control plane (PR-3) ───────────────────────────────────────────────
//
// Daemon-backed Settings section: an OFF-by-default enable toggle + a NIC picker.
// The daemon is the source of truth — `lanlink.status` is read on mount, and the
// toggle/picker write through `lanlink.configure`, updating from the response.
// Network-0: nothing here opens a port; PR-4's listener subscribes to the daemon's
// config-changed signal. The section hides itself when the control-plane RPC is
// unavailable (local mode / no daemon).

/** Sentinel select value meaning "no NIC selected". */
export const LANLINK_NIC_NONE = '';

/** Stable select-value key for a NIC identity (US separator can't appear in a name/MAC). */
function nicKey(nic: LanLinkNic): string {
  return `${nic.name}${nic.mac}`;
}

export interface NicOption {
  value: string;
  label: string;
  nic: LanLinkNic | null;
}

/**
 * Build the NIC dropdown options from the live NIC list plus the currently
 * persisted selection. Pure (testable): always leads with a "none" option, lists
 * each live NIC, and — crucially — keeps a persisted-but-currently-absent NIC
 * visible as a labelled stale option so a momentarily-unplugged NIC doesn't
 * silently vanish from the user's selection.
 */
export function nicOptions(
  nics: NicInfo[],
  selectedNic: LanLinkNic | null,
  t: (key: string) => string,
): NicOption[] {
  const opts: NicOption[] = [{ value: LANLINK_NIC_NONE, label: t('settings.lanlinkNicNone'), nic: null }];
  const seen = new Set<string>();
  for (const n of nics) {
    const value = nicKey(n);
    seen.add(value);
    const addrs = n.addresses.length > 0 ? ` (${n.addresses.join(', ')})` : '';
    opts.push({ value, label: `${n.name}${addrs}`, nic: { name: n.name, mac: n.mac } });
  }
  if (selectedNic) {
    const value = nicKey(selectedNic);
    if (!seen.has(value)) {
      opts.push({
        value,
        label: `${selectedNic.name} — ${t('settings.lanlinkNicUnavailable')}`,
        nic: { name: selectedNic.name, mac: selectedNic.mac },
      });
    }
  }
  return opts;
}

export interface LanLinkViewProps {
  enabled: boolean;
  onToggleEnabled: (v: boolean) => void;
  options: NicOption[];
  selectedValue: string;
  onChangeNic: (value: string) => void;
  busy: boolean;
  t: (key: string) => string;
}

/**
 * Pure presentational view (node-env testable via renderToStaticMarkup). Holds no
 * IPC/store wiring — the container passes derived props and setter callbacks.
 */
export function LanLinkView({
  enabled,
  onToggleEnabled,
  options,
  selectedValue,
  onChangeNic,
  busy,
  t,
}: LanLinkViewProps) {
  return (
    <SettingsSection title={t('settings.lanlink')} data-testid="lanlink-section">
      <SettingRow id="lanenable" label={t('settings.lanlinkEnable')} description={t('settings.lanlinkEnableDesc')}>
        <Toggle checked={enabled} onChange={onToggleEnabled} label={t('settings.lanlinkEnable')} />
      </SettingRow>
      <SettingRow id="lannic" label={t('settings.lanlinkNic')} description={t('settings.lanlinkNicDesc')}>
        <SettingSelect
          value={selectedValue}
          onChange={onChangeNic}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
          label={t('settings.lanlinkNic')}
        />
      </SettingRow>
      <SettingNote data-testid="lanlink-warning">
        {t('settings.lanlinkWarning')}
      </SettingNote>
      {busy && (
        <SettingNote>{t('settings.lanlinkApplying')}</SettingNote>
      )}
    </SettingsSection>
  );
}

function LanLinkSection() {
  const t = useT();
  const [status, setStatus] = useState<LanLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  // NOT_FOUND / DAEMON_DISCONNECTED are expected in local mode (no daemon control
  // pipe) — silence those toasts and just hide the section.
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN', 'DAEMON_DISCONNECTED'] });

  // Lazily access the API so the component is safe where preload hasn't exposed it.
  const lanlinkApi = (
    window.electronAPI as unknown as { lanlink?: { status: () => Promise<LanLinkStatus>; configure: (p: { enabled?: boolean; nic?: LanLinkNic | null }) => Promise<LanLinkStatus> } }
  ).lanlink;

  const refresh = useCallback(async () => {
    if (!lanlinkApi?.status) {
      setUnavailable(true);
      setLoading(false);
      return;
    }
    // finally so a thrown probe never leaves the section stuck on "loading"
    // (useIpc.invoke is non-throwing today, but the guard is cheap insurance).
    try {
      const result = await ipcInvoke(() => lanlinkApi.status());
      if (result.ok) {
        setStatus(result.data);
        setUnavailable(false); // recover if a prior probe failed (daemon reconnected)
      } else {
        setUnavailable(true);
      }
    } finally {
      setLoading(false);
    }
  }, [ipcInvoke, lanlinkApi]);

  useEffect(() => {
    void refresh();
    // Re-probe when the daemon (re)connects — opening Settings mid-reconnect, or a
    // disconnect after the section loaded, would otherwise leave the tab blank/stale
    // until the user remounts it (codex PR-3 P3).
    const daemonApi = (
      window.electronAPI as unknown as { daemon?: { onConnected?: (cb: () => void) => () => void } }
    ).daemon;
    const off = daemonApi?.onConnected?.(() => void refresh());
    return () => { off?.(); };
  }, [refresh]);

  const apply = useCallback(
    async (patch: { enabled?: boolean; nic?: LanLinkNic | null }) => {
      if (!lanlinkApi?.configure) return;
      setBusy(true);
      try {
        const result = await ipcInvoke(() => lanlinkApi.configure(patch));
        if (result.ok) setStatus(result.data);
      } finally {
        setBusy(false);
      }
    },
    [ipcInvoke, lanlinkApi],
  );

  // Local mode / daemon unreachable: the tab is always listed, so render an
  // explanatory placeholder rather than a blank pane. The on-mount probe +
  // daemon:onConnected re-probe above recover this automatically once a daemon
  // connects; in persistent local-only mode (respawn budget exhausted) this
  // message is the section's resting state instead of an empty panel.
  if (unavailable) {
    return (
      <SettingsSection title={t('settings.lanlink')}>
        <SettingNote>{t('settings.lanlinkUnavailable')}</SettingNote>
      </SettingsSection>
    );
  }
  if (loading || !status) {
    return (
      <SettingsSection title={t('settings.lanlink')}>
        <SettingNote>{t('settings.lanlinkLoading')}</SettingNote>
      </SettingsSection>
    );
  }

  const options = nicOptions(status.nics, status.nic, t);
  const selectedValue = status.nic ? nicKey(status.nic) : LANLINK_NIC_NONE;

  return (
    <LanLinkView
      enabled={status.enabled}
      onToggleEnabled={(v) => void apply({ enabled: v })}
      options={options}
      selectedValue={selectedValue}
      onChangeNic={(value) => {
        const picked = options.find((o) => o.value === value);
        void apply({ nic: picked?.nic ?? null });
      }}
      busy={busy}
      t={t}
    />
  );
}

// ─── LanLink pairing (PR-5) ─────────────────────────────────────────────────
//
// Sibling to LanLinkView/LanLinkSection (PR-3, left untouched). Adds the pairing
// surface: mint a PIN + countdown, join a remote machine, list/revoke peers. ALL
// state lives in the CONTAINER (LanLinkPairingSection); the VIEW is pure (props
// only) so it is node-env testable via renderToStaticMarkup. The PIN displayed is
// the human 6-digit pairing PIN (never crypto material), and peer messages are
// never surfaced here — outbound control only.

export interface LanLinkPairingViewProps {
  enabled: boolean;
  /** This machine's host:port for a peer's Join form (null until a NIC resolves). */
  selfAddress: string | null;
  // pair this machine
  pin: string | null;
  countdownSec: number | null;
  failCount: number;
  pairBusy: boolean;
  onBeginPair: () => void;
  onCancelPair: () => void;
  // join a machine
  joinHost: string;
  joinPort: number;
  joinPin: string;
  onJoinHost: (v: string) => void;
  onJoinPort: (v: number) => void;
  onJoinPin: (v: string) => void;
  onJoin: () => void;
  joinBusy: boolean;
  // peers
  peers: LanLinkPeerSummary[];
  confirmingRevoke: string | null;
  onAskRevoke: (uuid: string) => void;
  onConfirmRevoke: (uuid: string) => void;
  onCancelRevoke: () => void;
  // shared
  error: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export function LanLinkPairingView(props: LanLinkPairingViewProps) {
  const {
    enabled, selfAddress, pin, countdownSec, failCount, pairBusy, onBeginPair, onCancelPair,
    joinHost, joinPort, joinPin, onJoinHost, onJoinPort, onJoinPin, onJoin, joinBusy,
    peers, confirmingRevoke, onAskRevoke, onConfirmRevoke, onCancelRevoke, error, t,
  } = props;

  // Pairing is only meaningful when LanLink is enabled (a PIN minted while the
  // listener is off can't be completed). Show an explanatory hint instead of an
  // actionable-but-dead form.
  if (!enabled) {
    return (
      <SettingsSection id="lanpair" title={t('settings.lanlinkPair')} data-testid="lanlink-pairing-section">
        <SettingNote>{t('settings.lanlinkPairDisabled')}</SettingNote>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection id="lanpair" title={t('settings.lanlinkPair')} data-testid="lanlink-pairing-section">
        {/* Pair this machine: mint a PIN + live countdown. Starting a pairing
            window is what unblocks a second machine, so it is the tab's one
            primary; Join is secondary. */}
        <SettingRow label={t('settings.lanlinkPairStart')} description={t('settings.lanlinkPairStartDesc')}>
          {pin ? (
            <div className="flex items-center gap-3">
              <span data-testid="lanlink-pair-pin" className="settings-kbd tracking-widest" style={{ fontSize: 13, minHeight: 28 }}>
                {pin}
              </span>
              <span className="ui-field-description tabular-nums">
                {countdownSec != null && countdownSec > 0
                  ? t('settings.lanlinkPairCountdown', { seconds: countdownSec })
                  : t('settings.lanlinkPairExpired')}
              </span>
              <Button variant="secondary" onClick={onCancelPair}>{t('settings.lanlinkPairCancel')}</Button>
            </div>
          ) : (
            <Button variant="primary" onClick={onBeginPair} disabled={pairBusy}>
              {t('settings.lanlinkPairStartButton')}
            </Button>
          )}
        </SettingRow>
        {pin && selfAddress && (
          <SettingNote data-testid="lanlink-pair-self" className="font-mono">
            {t('settings.lanlinkPairSelfAddress', { address: selfAddress })}
          </SettingNote>
        )}
        {failCount > 0 && (
          <SettingNote tone="warning">
            {t('settings.lanlinkPairFailCount', { count: failCount })}
          </SettingNote>
        )}

        {/* Join a machine: enter a remote host/port/PIN. Join inputs commit on
            EVERY keystroke (not commit-on-blur like SettingPathInput) so clicking
            Join with focus still in a field submits the current value, not a
            stale empty draft (codex P2). */}
        <SettingRow label={t('settings.lanlinkPairJoin')} description={t('settings.lanlinkPairJoinDesc')} layout="stacked">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              value={joinHost}
              placeholder={t('settings.lanlinkPairJoinHostPlaceholder')}
              aria-label={t('settings.lanlinkPairJoinHost')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => onJoinHost(e.target.value)}
              className="settings-input font-mono"
              style={{ width: 200 }}
            />
            <SettingNumberInput value={joinPort} onChange={onJoinPort} min={1} max={65535} label={t('settings.lanlinkPairJoinPort')} />
            <Input
              type="text"
              value={joinPin}
              placeholder={t('settings.lanlinkPairJoinPinPlaceholder')}
              aria-label={t('settings.lanlinkPairJoinPin')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => onJoinPin(e.target.value)}
              className="settings-input font-mono"
              style={{ width: 120 }}
            />
            <Button variant="secondary" onClick={onJoin} disabled={joinBusy}>
              {t('settings.lanlinkPairJoinButton')}
            </Button>
          </div>
        </SettingRow>
        {error && <SettingNote data-testid="lanlink-pair-error" tone="danger">{error}</SettingNote>}
      </SettingsSection>

      {/* Paired peers + live revoke. */}
      <SettingsSection title={t('settings.lanlinkPeers')}>
        {peers.length === 0 ? (
          <SettingNote>{t('settings.lanlinkPeersEmpty')}</SettingNote>
        ) : (
          <div className="contents" data-testid="lanlink-peers">
            {peers.map((p) => (
              <div key={p.peerUuid} className="settings-row ui-row" style={{ flexDirection: 'row' }}>
                <Badge>{t('settings.lanlinkPeerBadge')}</Badge>
                <span className="ui-field-label truncate">{p.peerName}</span>
                {p.burned && (
                  <Badge tone="danger">{t('settings.lanlinkPeerBurned')}</Badge>
                )}
                <div className="flex-1" />
                {confirmingRevoke === p.peerUuid ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="ghost" onClick={onCancelRevoke}>{t('settings.close')}</Button>
                    <UiButton variant="danger" size="md" onClick={() => onConfirmRevoke(p.peerUuid)}>{t('settings.lanlinkPeerRevoke')}</UiButton>
                  </div>
                ) : (
                  <Button variant="destructive" className="shrink-0" onClick={() => onAskRevoke(p.peerUuid)}>
                    {t('settings.lanlinkPeerRevoke')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

function LanLinkPairingSection() {
  const t = useT();
  const { invoke: ipcInvoke } = useIpc({ silent: ['NOT_FOUND', 'UNKNOWN', 'DAEMON_DISCONNECTED'] });
  const api = window.electronAPI?.lanlink;

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [nic, setNic] = useState<LanLinkNic | null>(null);
  const [effectivePort, setEffectivePort] = useState<number | null>(null);
  const [nics, setNics] = useState<NicInfo[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [peers, setPeers] = useState<LanLinkPeerSummary[]>([]);
  const [joinHost, setJoinHost] = useState('');
  const [joinPort, setJoinPort] = useState(0);
  const [joinPin, setJoinPin] = useState('');
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPeers = useCallback(async () => {
    if (!api?.peersList) return;
    const r = await ipcInvoke(() => api.peersList());
    if (r.ok) setPeers(r.data.peers);
  }, [api, ipcInvoke]);

  const refreshStatus = useCallback(async () => {
    if (!api?.status) { setUnavailable(true); return; }
    const r = await ipcInvoke(() => api.status());
    if (r.ok) {
      setEnabled(r.data.enabled); setNic(r.data.nic);
      setEffectivePort(r.data.effectivePort); setNics(r.data.nics);
      setUnavailable(false);
    } else setUnavailable(true);
  }, [api, ipcInvoke]);

  const refreshPairStatus = useCallback(async () => {
    if (!api?.pairStatus) return;
    const r = await ipcInvoke(() => api.pairStatus());
    if (r.ok) {
      setFailCount(r.data.failCount);
      if (!r.data.active) { setPin(null); setDeadline(null); }
    }
  }, [api, ipcInvoke]);

  // Mount probe + daemon-reconnect re-probe + a light 3s poll WHILE the Settings tab
  // is open (this section is mounted only when the LanLink tab is active). The poll
  // keeps enabled/nic in sync with a toggle in the sibling LanLinkSection AND surfaces
  // an inbound peer (another machine joining our PIN, persisted daemon-side) without a
  // manual refresh (codex P2 / CodeRabbit). Both RPCs are read-only.
  useEffect(() => {
    void refreshStatus();
    void refreshPeers();
    const daemonApi = (
      window.electronAPI as unknown as { daemon?: { onConnected?: (cb: () => void) => () => void } }
    ).daemon;
    const off = daemonApi?.onConnected?.(() => { void refreshStatus(); void refreshPeers(); });
    const poll = setInterval(() => { void refreshStatus(); void refreshPeers(); }, 3000);
    return () => { off?.(); clearInterval(poll); };
  }, [refreshStatus, refreshPeers]);

  // Countdown + pairStatus poll ONLY while a pairing window is open (perf: no idle
  // interval). Cleared on unmount / window close.
  useEffect(() => {
    if (!pin || deadline == null) return;
    const tick = setInterval(() => {
      setNow(Date.now());
      void refreshPairStatus();
    }, 1000);
    return () => clearInterval(tick);
  }, [pin, deadline, refreshPairStatus]);

  // Auto-clear an expired PIN so the UI doesn't show a stale code.
  useEffect(() => {
    if (deadline != null && now >= deadline) { setPin(null); setDeadline(null); }
  }, [now, deadline]);

  const onBeginPair = useCallback(async () => {
    if (!api?.pairBegin) return;
    setPairBusy(true); setError(null);
    setFailCount(0); // a fresh window starts at 0 — don't show the prior window's count
    const r = await ipcInvoke(() => api.pairBegin());
    setPairBusy(false);
    if (r.ok) {
      setPin(r.data.pin);
      // expiresInMs is number|null. A null deadline would stall the countdown AND the
      // auto-clear effects (both guard on deadline != null), so treat null as
      // already-expired rather than a non-expiring PIN (Claude P2).
      setDeadline(r.data.expiresInMs != null ? Date.now() + r.data.expiresInMs : Date.now());
      setNow(Date.now());
    }
  }, [api, ipcInvoke]);

  const onCancelPair = useCallback(async () => {
    if (!api?.pairCancel) return;
    const r = await ipcInvoke(() => api.pairCancel());
    // Only hide the PIN if the daemon actually closed the window. On a failed cancel
    // the window may still be active — hiding it would mislead the user into thinking
    // it was canceled (codex P2). Also clear the stale fail-count warning, since the
    // poll stops once the PIN is gone (codex P3).
    if (r.ok) { setPin(null); setDeadline(null); setFailCount(0); }
  }, [api, ipcInvoke]);

  const onJoin = useCallback(async () => {
    if (!api?.pairJoin) return;
    if (!joinHost || joinPort < 1 || joinPort > 65535 || !joinPin) {
      setError(t('settings.lanlinkPairError'));
      return;
    }
    setJoinBusy(true); setError(null);
    const r = await ipcInvoke(() => api.pairJoin({ host: joinHost, port: joinPort, pin: joinPin }));
    setJoinBusy(false);
    if (r.ok) { setJoinPin(''); void refreshPeers(); }
    else setError(t('settings.lanlinkPairError'));
  }, [api, ipcInvoke, joinHost, joinPort, joinPin, refreshPeers, t]);

  const onConfirmRevoke = useCallback(async (uuid: string) => {
    if (!api?.peersRemove) return;
    setConfirmingRevoke(null);
    // {ok:true} is unconditional daemon-side, so trust the refreshed list — not the
    // ack — to confirm the peer actually went away.
    await ipcInvoke(() => api.peersRemove(uuid));
    void refreshPeers();
  }, [api, ipcInvoke, refreshPeers]);

  if (unavailable) {
    return (
      <SettingsSection id="lanpair" title={t('settings.lanlinkPair')}>
        <SettingNote>{t('settings.lanlinkUnavailable')}</SettingNote>
      </SettingsSection>
    );
  }

  // This machine's reachable address for a peer to enter on their "Join" form: the
  // selected NIC's IP + the daemon's effective listen port. Shown next to the PIN so
  // the peer knows the full host:port, not just the code (codex#5).
  const selfAddress = (() => {
    if (!nic || effectivePort == null) return null;
    const match = nics.find((n) => n.name === nic.name && n.mac === nic.mac);
    const ip = match?.addresses[0];
    return ip ? `${ip}:${effectivePort}` : null;
  })();

  const countdownSec = deadline != null ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  return (
    <LanLinkPairingView
      enabled={enabled === true && nic !== null}
      selfAddress={selfAddress}
      pin={pin}
      countdownSec={countdownSec}
      failCount={failCount}
      pairBusy={pairBusy}
      onBeginPair={() => void onBeginPair()}
      onCancelPair={() => void onCancelPair()}
      joinHost={joinHost}
      joinPort={joinPort}
      joinPin={joinPin}
      onJoinHost={setJoinHost}
      onJoinPort={setJoinPort}
      onJoinPin={setJoinPin}
      onJoin={() => void onJoin()}
      joinBusy={joinBusy}
      peers={peers}
      confirmingRevoke={confirmingRevoke}
      onAskRevoke={setConfirmingRevoke}
      onConfirmRevoke={(uuid) => void onConfirmRevoke(uuid)}
      onCancelRevoke={() => setConfirmingRevoke(null)}
      error={error}
      t={t}
    />
  );
}

// ─── Update status widget ─────────────────────────────────────────────────────

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';

function UpdateStatus() {
  const t = useT();
  const [state, setState] = useState<UpdateState>('idle');
  const [releaseName, setReleaseName] = useState<string>('');
  // The subscription effect runs once, so its closure would hold the mount-time
  // releaseName forever. The comparison that decides whether an `available`
  // event is the release we already staged has to read the live value.
  const releaseNameRef = useRef<string>('');
  useEffect(() => { releaseNameRef.current = releaseName; }, [releaseName]);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [percent, setPercent] = useState<number | null>(null);
  // Updater-not-configured in dev is expected; don't spam toasts for UNKNOWN.
  const { invoke: ipcInvoke } = useIpc({ silent: ['UNKNOWN'] });

  useEffect(() => {
    const removeAvailable = window.electronAPI.updater.onUpdateAvailable((data) => {
      if (data.status === 'downloaded') {
        setState('downloaded');
        if (data.releaseName) setReleaseName(data.releaseName);
      } else {
        // NOT an unconditional demotion. Every background poll re-announces
        // `available` for a release it already downloaded, and downloadUpdate
        // returns early once a staged path is held — so no second `downloaded`
        // ever follows to undo this. Demoting turned the Install button back
        // into "Check for updates" within the poll interval and left it that
        // way, on the exact state this panel was just taught to read on mount.
        //
        // Held only while it is the SAME release, though. A superseding
        // release unlinks the staged artifact and announces the new version
        // before re-downloading it; holding `downloaded` through that would
        // offer an Install button for a file main just deleted. The version
        // is what distinguishes "we already have this one" from "this is a
        // different one" — so track it either way.
        const next = data.releaseName;
        setState((prev) => (prev === 'downloaded' && (!next || next === releaseNameRef.current)
          ? prev
          : 'available'));
        if (next) setReleaseName(next);
      }
    });
    const removeProgress = window.electronAPI.updater.onUpdateProgress((data) => {
      setState('downloading');
      setPercent(typeof data.percent === 'number' ? data.percent : null);
    });
    const removeNotAvailable = window.electronAPI.updater.onUpdateNotAvailable(() => {
      setState('not-available');
    });
    const removeError = window.electronAPI.updater.onUpdateError((data) => {
      setState('error');
      setErrorMsg(data.message || '');
    });
    return () => { removeAvailable(); removeProgress(); removeNotAvailable(); removeError(); };
  }, []);

  // #897 — ask what is already true, instead of only listening for what happens
  // next. Subscribing alone means this panel knows nothing on mount: a
  // background poll that downloaded an update BEFORE Settings was opened fired
  // its one event into a component that did not exist yet, so the panel showed
  // a bare version number and a "check for updates" button while a verified
  // installer sat on disk. That is the same push-only mistake as #866's refused
  // notice and the missing ready-toast — third time in this subsystem, so the
  // read is a pull.
  useEffect(() => {
    const read = window.electronAPI?.updater?.getPendingInstall;
    if (!read) return; // stale preload / tests
    let cancelled = false;
    void read()
      .then((pending) => {
        if (cancelled || !pending) return;
        // Only fills an unknown state — a live event that arrived first is
        // fresher than this snapshot and must not be stomped.
        setState((prev) => (prev === 'idle' ? 'downloaded' : prev));
        setReleaseName((prev) => prev || pending.version);
      })
      .catch(() => { /* the widget still works from live events */ });
    return () => { cancelled = true; };
  }, []);

  const handleCheck = async () => {
    setState('checking');
    const result = await ipcInvoke(() => window.electronAPI.updater.checkForUpdates());
    if (!result.ok) { setState('error'); return; }
    // On an unsupported platform (or in dev) the handler answers 'not-available'
    // directly and no UPDATE_NOT_AVAILABLE event ever follows — without this the
    // widget would sit in 'checking' forever.
    if ((result.data as { status?: string } | undefined)?.status === 'not-available') {
      setState('not-available');
    }
  };

  const handleInstall = () => {
    window.electronAPI.updater.installUpdate().catch(() => { /* best-effort — updater surfaces its own errors */ });
  };

  const statusText = (() => {
    switch (state) {
      case 'checking': return t('settings.checkUpdate') + '...';
      case 'downloading': return percent === null
        ? t('settings.checkUpdate') + '…'
        : `${t('settings.checkUpdate')}… ${percent}%`;
      case 'available': return t('settings.updateAvailable');
      // No `(releaseName)` suffix here: the Latest line above already prints
      // the version, and appending it produced "Latest 3.43.0 — Update ready
      // (3.43.0)". The suffix only ever existed for the case where there is no
      // Latest line to print, which the `!releaseName && statusText` branch
      // below already covers.
      case 'downloaded': return t('settings.updateReady');
      case 'not-available': return t('settings.upToDate');
      case 'error': return t('settings.updateFailed');
      default: return '';
    }
  })();

  const statusColor = (() => {
    switch (state) {
      case 'available':
      case 'downloading':
      case 'downloaded': return 'var(--accent-green)';
      case 'error': return 'var(--accent-red)';
      default: return 'var(--text-sub)';
    }
  })();

  return (
    <div data-setting-id="checkupdate" className="settings-row scroll-mt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="ui-field-label">{t('settings.wmuxUpdates')}</span>
          {/* Current and latest on their own lines. The old copy put the running
              version and a status word on one line and never named the version
              you would be moving TO, so "update ready" could not be reconciled
              against anything — #897's reporters were comparing exactly those two
              numbers by hand (winget list vs the app). */}
          <span className="ui-field-description">
            {t('settings.currentVersion')} v{__APP_VERSION__}
          </span>
          {releaseName && (
            <span className="ui-field-description" style={{ color: statusColor }}>
              {t('settings.latestVersion')} {releaseName}
              {statusText ? ` — ${statusText}` : ''}
            </span>
          )}
          {!releaseName && statusText && (
            <span className="ui-field-description" style={{ color: statusColor }}>{statusText}</span>
          )}
          {state === 'error' && errorMsg && (
            <span className="ui-field-description font-mono">{errorMsg}</span>
          )}
          {/* #866: the Windows install has to run against a dead tree, so the
              daemon goes down with the app and live panes do not survive it.
              Said before the button is pressed, not after — the old copy
              promised the opposite ("sessions persist in the daemon"). */}
          {state === 'downloaded' && (
            <span className="ui-field-description">
              {t('settings.updateEndsSessions')}
            </span>
          )}
          {state === 'downloading' && (
            <div className="mt-1.5 h-1 w-40 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--surface-fill-hover)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: percent === null ? '100%' : `${percent}%`,
                  backgroundColor: 'var(--text-sub)',
                  opacity: percent === null ? 0.4 : 1,
                }}
              />
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {/* "Check" stays visible while an install is staged. It used to be
              replaced by "Install now", so once one update was downloaded there
              was no way to ask for a newer one — a staged 3.49.2 hid the 3.49.3
              published minutes later until the 30-minute poll got around to it.
              A check always offers the latest, so re-checking over a staged
              install is safe. */}
          <Button
            variant="secondary"
            onClick={handleCheck}
            disabled={state === 'checking' || state === 'downloading'}
          >
            {t('settings.checkUpdate')}
          </Button>
          {/* A staged, verified installer is what unblocks the user on this
              tab, so it is the tab's one primary. */}
          {state === 'downloaded' && (
            <Button onClick={handleInstall} variant="primary">
              {/* An action, not a status. This said "Update ready", which is what
                  the line above already reports — a button labelled with a state
                  does not tell you what pressing it does. */}
              {t('update.installNow')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tab content components ───────────────────────────────────────────────────

// Windows "start on login" toggle (issue #460). The per-user Run registry key
// is the source of truth — read on mount, flipped optimistically with echo
// reconciliation (mirrors OrchestratorSection's auto-wake). Rendered on win32
// (Run key) + darwin(로그인 항목); the backing IPC is a no-op elsewhere.
function StartupSection() {
  const t = useT();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.autostart
      ?.get()
      .then((r) => { if (!cancelled) setEnabled(r.enabled); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const onChange = (next: boolean) => {
    setEnabled(next); // optimistic
    window.electronAPI.autostart
      ?.set(next)
      .then((r) => setEnabled(r.enabled)) // reconcile with the real registry state
      .catch(() => setEnabled(!next));
  };
  return (
    <SettingsSection title={t('settings.startup')}>
      <SettingRow id="startup" label={t('settings.startOnLogin')} description={t('settings.startOnLoginDesc')}>
        <Toggle checked={enabled} onChange={onChange} label={t('settings.startOnLogin')} />
      </SettingRow>
    </SettingsSection>
  );
}

function TabGeneral() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const autoUpdateEnabled = useStore((s) => s.autoUpdateEnabled);
  const storeSetAutoUpdate = useStore((s) => s.setAutoUpdateEnabled);
  const setAutoUpdateEnabled = (enabled: boolean) => {
    storeSetAutoUpdate(enabled);
    window.electronAPI.settings.setAutoUpdateEnabled(enabled);
  };

  return (
    <div className="settings-page">
      {/* Language — native names in one Select; no flags (DESIGN.md: no
          emoji in chrome, and a flag is not a language). */}
      <SettingsSection>
        <SettingRow id="language" label={t('settings.language')}>
          <SettingSelect
            label={t('settings.language')}
            value={locale}
            onChange={(v) => setLocale(v as Locale)}
            options={LOCALE_OPTIONS.map(({ value, label }) => ({ value, label }))}
          />
        </SettingRow>
      </SettingsSection>

      {/* Updates */}
      <SettingsSection title={t('settings.updates')}>
        <SettingRow id="autoupdate" label={t('settings.autoUpdate')} description={t('settings.autoUpdateDesc')}>
          <Toggle
            checked={autoUpdateEnabled}
            onChange={setAutoUpdateEnabled}
            label={t('settings.autoUpdate')}
          />
        </SettingRow>
        <UpdateStatus />
      </SettingsSection>

      {/* Startup — win32(레지스트리 Run 키) + darwin(로그인 항목). 그 외 숨김. */}
      {(window.electronAPI.platform === 'win32' || window.electronAPI.platform === 'darwin') && (
        <StartupSection />
      )}

      {/* Tutorial */}
      <SettingsSection title={t('settings.tutorial')}>
        <SettingRow id="tutorial" label={t('settings.restartTutorial')} description={t('settings.restartTutorialDesc')}>
          <Button
            variant="secondary"
            onClick={() => {
              useStore.getState().startOnboarding();
              useStore.getState().setSettingsPanelVisible(false);
            }}
          >
            {t('settings.restartTutorial')}
          </Button>
        </SettingRow>
      </SettingsSection>

      {/* First-run setup — the wizard and cheat sheet re-entry points. */}
      <TabFirstRunSetup />

      {/* Reset */}
      <ResetSection />
    </div>
  );
}

// ─── Terminal tab — shell, cwd, scrollback, pane behavior ────────────────────
// #1196 — the three image-paste routes, in escalating explicitness.
const IMAGE_PASTE_MODE_LABELS: ReadonlyArray<{ mode: ImagePasteMode; labelKey: string }> = [
  { mode: 'auto', labelKey: 'settings.imagePasteAuto' },
  { mode: 'native', labelKey: 'settings.imagePasteNative' },
  { mode: 'path', labelKey: 'settings.imagePastePath' },
];

/** Exported for tests — the same seam ChromePresetActionsView uses. */
export function ImagePasteModeView({
  value,
  onChange,
  t,
}: {
  value: ImagePasteMode;
  onChange: (mode: ImagePasteMode) => void;
  t: (key: string) => string;
}) {
  return (
    <SegmentedControl
      value={value}
      onValueChange={onChange}
      options={IMAGE_PASTE_MODE_LABELS.map(({ mode, labelKey }) => ({ value: mode, label: t(labelKey) }))}
      data-testid="image-paste-mode"
    />
  );
}

function TabTerminal() {
  const t = useT();
  const defaultShell = useStore((s) => s.defaultShell);
  const setDefaultShell = useStore((s) => s.setDefaultShell);
  const scrollbackLines = useStore((s) => s.scrollbackLines);
  const setScrollbackLines = useStore((s) => s.setScrollbackLines);
  const scrollbackRestoreEnabled = useStore((s) => s.scrollbackRestoreEnabled);
  const setScrollbackRestoreEnabled = useStore((s) => s.setScrollbackRestoreEnabled);
  const imagePasteMode = useStore((s) => s.imagePasteMode);
  const setImagePasteMode = useStore((s) => s.setImagePasteMode);
  const splitInheritsCwd = useStore((s) => s.splitInheritsCwd);
  const setSplitInheritsCwd = useStore((s) => s.setSplitInheritsCwd);
  const imeResidueGuardEnabled = useStore((s) => s.imeResidueGuardEnabled);
  const setImeResidueGuardEnabled = useStore((s) => s.setImeResidueGuardEnabled);
  const hiddenPaneRetentionEnabled = useStore((s) => s.hiddenPaneRetentionEnabled);
  const setHiddenPaneRetentionEnabled = useStore((s) => s.setHiddenPaneRetentionEnabled);
  const coldParkEnabled = useStore((s) => s.coldParkEnabled);
  const setColdParkEnabled = useStore((s) => s.setColdParkEnabled);
  const startupDirectory = useStore((s) => s.startupDirectory);
  const setStartupDirectory = useStore((s) => s.setStartupDirectory);
  const [detectedShells, setDetectedShells] = useState<ShellInfo[]>([]);
  const shellOptions = detectedShells.map((shell) => ({ value: shell.path, label: shell.name }));

  // #1103 — WSL distro picker: shown only when the default terminal IS WSL
  // and more than one distro exists (a single-distro machine has nothing to
  // choose). '' = the system default (today's behaviour).
  const defaultWslDistro = useStore((s) => s.defaultWslDistro);
  const setDefaultWslDistro = useStore((s) => s.setDefaultWslDistro);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const selectedIsWsl = detectedShells.some(
    (shell) => shell.path === defaultShell && isWslShellPath(shell.path),
  );
  useEffect(() => {
    let cancelled = false;
    if (!selectedIsWsl) return;
    void window.electronAPI.shell.wslDistros()
      .then((distros) => {
        if (cancelled) return;
        setWslDistros(distros);
        // Reconcile a stale choice: a distro that was uninstalled/renamed on
        // the host must not keep injecting `-d <gone>` into every new pane
        // while the picker (built from the live list) shows "System default".
        const stored = useStore.getState().defaultWslDistro;
        if (stored && distros.length > 0 && !distros.includes(stored)) {
          useStore.getState().setDefaultWslDistro(null);
          window.electronAPI.settings.setDefaultWslDistro(null);
        }
      })
      .catch(() => { if (!cancelled) setWslDistros([]); });
    return () => { cancelled = true; };
  }, [selectedIsWsl]);
  const onWslDistroChange = useCallback((value: string) => {
    setDefaultWslDistro(value === '' ? null : value);
    window.electronAPI.settings.setDefaultWslDistro(value === '' ? null : value);
  }, [setDefaultWslDistro]);

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
    <div className="settings-page">
      <SettingsSection title={t('settings.sectionShell')}>
        <SettingRow id="shell" label={t('settings.defaultShell')}>
          <SettingSelect
            label={t('settings.defaultShell')}
            value={defaultShell}
            onChange={setDefaultShell}
            options={shellOptions}
          />
        </SettingRow>
        {selectedIsWsl && wslDistros.length > 1 && (
          <SettingRow
            id="wsl-distro"
            label={t('settings.wslDistro')}
            description={t('settings.wslDistroDesc')}
          >
            <SettingSelect
              label={t('settings.wslDistro')}
              value={defaultWslDistro ?? ''}
              onChange={onWslDistroChange}
              options={[{ value: '', label: t('settings.wslDistroDefault') }]
                .concat(wslDistros.map((name) => ({ value: name, label: name })))}
            />
          </SettingRow>
        )}
        <SettingRow id="startdir" label={t('settings.startupDirectory')} description={t('settings.startupDirectoryDesc')}>
          <SettingPathInput
            label={t('settings.startupDirectory')}
            value={startupDirectory}
            onCommit={setStartupDirectory}
            placeholder={t('settings.startupDirectoryPlaceholder')}
          />
        </SettingRow>
        <SettingRow id="splitcwd" label={t('settings.splitInheritsCwd')} description={t('settings.splitInheritsCwdDesc')}>
          <Toggle
            checked={splitInheritsCwd}
            onChange={setSplitInheritsCwd}
            label={t('settings.splitInheritsCwd')}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title={t('settings.sectionInput')}>
        <SettingRow id="ime" label={t('settings.imeResidueGuard')} description={t('settings.imeResidueGuardDesc')}>
          <Toggle
            checked={imeResidueGuardEnabled}
            onChange={setImeResidueGuardEnabled}
            label={t('settings.imeResidueGuard')}
          />
        </SettingRow>
        <SettingRow id="imagepaste" label={t('settings.imagePaste')} description={t('settings.imagePasteDesc')}>
          <ImagePasteModeView value={imagePasteMode} onChange={setImagePasteMode} t={t} />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title={t('settings.sectionPerformance')}>
        <SettingRow id="retention" label={t('settings.hiddenPaneRetention')} description={t('settings.hiddenPaneRetentionDesc')}>
          <Toggle
            checked={hiddenPaneRetentionEnabled}
            onChange={setHiddenPaneRetentionEnabled}
            label={t('settings.hiddenPaneRetention')}
          />
        </SettingRow>
        <SettingRow id="coldpark" label={t('settings.coldPark')} description={t('settings.coldParkDesc')}>
          <Toggle
            checked={coldParkEnabled}
            onChange={setColdParkEnabled}
            label={t('settings.coldPark')}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title={t('settings.sectionScrollback')}>
        <SettingRow id="scrollback" label={t('settings.scrollbackLines')} description={t('settings.scrollbackDesc')}>
          <SettingNumberInput
            label={t('settings.scrollbackLines')}
            value={scrollbackLines}
            onChange={setScrollbackLines}
            min={1000}
            max={100000}
          />
        </SettingRow>
        <SettingRow id="restore" label={t('settings.scrollbackRestore')} description={t('settings.scrollbackRestoreDesc')}>
          <Toggle
            checked={scrollbackRestoreEnabled}
            onChange={setScrollbackRestoreEnabled}
            label={t('settings.scrollbackRestore')}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

// ─── Browser tab — agent browser runtime and what agents learn about sites ───
function TabBrowser() {
  const t = useT();
  const browserLightweightMode = useStore((s) => s.browserLightweightMode);
  const setBrowserLightweightMode = useStore((s) => s.setBrowserLightweightMode);
  const browserDiscardHidden = useStore((s) => s.browserDiscardHidden);
  const setBrowserDiscardHidden = useStore((s) => s.setBrowserDiscardHidden);
  const siteMemoryEnabled = useStore((s) => s.siteMemoryEnabled);
  const setSiteMemoryEnabled = useStore((s) => s.setSiteMemoryEnabled);
  const siteGuidesEnabled = useStore((s) => s.siteGuidesEnabled);
  const setSiteGuidesEnabled = useStore((s) => s.setSiteGuidesEnabled);
  const browserBackend = useStore((s) => s.browserBackend);
  const setBrowserBackend = useStore((s) => s.setBrowserBackend);
  const browserBackendHydrated = useStore((s) => s.browserBackendHydrated);

  return (
    <div className="settings-page">
      <SettingsSection title={t('settings.browserSectionRuntime')}>
        <SettingRow id="browserbackend" label={t('settings.browserBackend')} description={t('settings.browserBackendDesc')}>
          <SettingSelect
            label={t('settings.browserBackend')}
            value={browserBackend}
            // Locked until the boot read of main's persisted value lands, so an
            // edit can never race the async hydration and be overwritten.
            disabled={!browserBackendHydrated}
            onChange={(v) => setBrowserBackend(isBrowserBackend(v) ? v : 'builtin')}
            options={BROWSER_BACKENDS.map((b) => ({
              value: b,
              label: t(
                b === 'builtin'
                  ? 'settings.browserBackendBuiltin'
                  : b === 'external'
                    ? 'settings.browserBackendExternal'
                    : 'settings.browserBackendChrome',
              ),
            }))}
          />
        </SettingRow>
        <SettingRow id="browserlight" label={t('settings.browserLightweight')} description={t('settings.browserLightweightDesc')}>
          <Toggle
            checked={browserLightweightMode}
            onChange={setBrowserLightweightMode}
            label={t('settings.browserLightweight')}
          />
        </SettingRow>
        {browserLightweightMode && (
          <SettingRow label={t('settings.browserDiscard')} description={t('settings.browserDiscardDesc')}>
            <Toggle
              checked={browserDiscardHidden}
              onChange={setBrowserDiscardHidden}
              label={t('settings.browserDiscard')}
            />
          </SettingRow>
        )}
      </SettingsSection>
      <SettingsSection title={t('settings.browserSectionKnowledge')}>
        <SettingRow id="sitememory" label={t('settings.siteMemory')} description={t('settings.siteMemoryDesc')}>
          <Toggle
            checked={siteMemoryEnabled}
            onChange={setSiteMemoryEnabled}
            label={t('settings.siteMemory')}
          />
        </SettingRow>
        <SettingRow id="siteguides" label={t('settings.siteGuides')} description={t('settings.siteGuidesDesc')}>
          <Toggle
            checked={siteGuidesEnabled}
            onChange={setSiteGuidesEnabled}
            label={t('settings.siteGuides')}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

// ─── Fan-out workers — permission mode + allow-list button ───────────────────
// The mode is main-side (it can loosen what an unattended worker may do), so
// it is read and written over IPC, never through the renderer store.
function FanoutWorkersSection() {
  const t = useT();
  // Main-side too: main makes the approval decision, so the switch it reads
  // is the one this row writes.
  const [requireApproval, setRequireApprovalState] = useState(false);
  const [mode, setMode] = useState<FanoutWorkerPermissionMode>(DEFAULT_FANOUT_WORKER_PERMISSION_MODE);
  // Shown as its own line under the row, not in the (one-line) description,
  // so a failure's text is never cut off behind Learn more.
  const [allowResult, setAllowResult] = useState<{ text: string; failed: boolean } | null>(null);
  const [allowing, setAllowing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.fanout?.getWorkerPermissionMode?.()
      .then((m) => {
        if (!cancelled && isFanoutWorkerPermissionMode(m)) setMode(m);
      })
      .catch(() => undefined);
    window.electronAPI?.fanout?.getRequireApproval?.()
      .then((v) => {
        if (!cancelled && typeof v === 'boolean') setRequireApprovalState(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const onModeChange = (next: string) => {
    if (!isFanoutWorkerPermissionMode(next)) return;
    window.electronAPI.fanout
      .setWorkerPermissionMode(next)
      .then((stored) => setMode(stored))
      .catch(() => undefined);
  };

  const onRequireApprovalChange = (next: boolean) => {
    window.electronAPI.fanout
      .setRequireApproval(next)
      .then((stored) => setRequireApprovalState(stored))
      .catch(() => undefined);
  };

  const onAllow = async () => {
    setAllowing(true);
    try {
      const out = await window.electronAPI.deck.hooksBridge.allowWorkerTools();
      if (!out.ok) setAllowResult({ text: t('settings.fanoutAllowWorkerToolsFailed', { error: out.error ?? '' }), failed: true });
      else if (out.added.length === 0) setAllowResult({ text: t('settings.fanoutAllowWorkerToolsAlready'), failed: false });
      else setAllowResult({ text: t('settings.fanoutAllowWorkerToolsDone', { count: String(out.added.length) }), failed: false });
    } catch (err) {
      setAllowResult({ text: t('settings.fanoutAllowWorkerToolsFailed', { error: err instanceof Error ? err.message : String(err) }), failed: true });
    } finally {
      setAllowing(false);
    }
  };

  return (
    <SettingsSection title={t('settings.fanoutWorkers')}>
      <SettingRow
        id="fanoutapproval"
        label={t('settings.fanoutRequireApproval')}
        description={t('settings.fanoutRequireApprovalDesc')}
      >
        <Toggle
          checked={requireApproval}
          onChange={onRequireApprovalChange}
          label={t('settings.fanoutRequireApproval')}
        />
      </SettingRow>
      <SettingRow
        id="fanoutworkers"
        label={t('settings.fanoutWorkerPermissionMode')}
        description={t('settings.fanoutWorkerPermissionModeDesc')}
      >
        <SettingSelect
          value={mode}
          onChange={onModeChange}
          label={t('settings.fanoutWorkerPermissionMode')}
          options={FANOUT_WORKER_PERMISSION_MODES.map((m) => ({ value: m, label: t(`settings.fanoutWorkerMode.${m}`) }))}
        />
      </SettingRow>
      {mode === 'bypassPermissions' && (
        <SettingNote tone="warning">
          {t('settings.fanoutWorkerBypassWarning')}
        </SettingNote>
      )}
      <SettingRow
        id="fanoutallowtools"
        label={t('settings.fanoutAllowWorkerTools')}
        description={t('settings.fanoutAllowWorkerToolsDesc')}
      >
        <Button variant="secondary" onClick={onAllow} disabled={allowing}>
          {t('settings.fanoutAllowWorkerToolsButton')}
        </Button>
      </SettingRow>
      {allowResult && (
        <SettingNote tone={allowResult.failed ? 'danger' : 'muted'} role="status" data-testid="fanout-allow-result">
          {allowResult.text}
        </SettingNote>
      )}
    </SettingsSection>
  );
}

// ─── Orchestrator tab — the deck brain: runtime, model, wake, gates ──────────
function TabOrchestrator() {
  return (
    <div className="settings-page">
      <OrchestratorSection />
    </div>
  );
}

// ─── Roles & fan-out tab — who runs each role, and what workers may do ───────
function TabRoles() {
  const t = useT();
  const a2aAutoApproveExecute = useStore((s) => s.a2aAutoApproveExecute);
  const setA2aAutoApproveExecute = useStore((s) => s.setA2aAutoApproveExecute);

  return (
    <div className="settings-page">
      <RoleBindingEditor />

      {/* A2A execution */}
      <SettingsSection title={t('settings.a2aExecution')}>
        <SettingRow id="a2a" label={t('settings.a2aAutoApproveExecute')} description={t('settings.a2aAutoApproveExecuteDesc')}>
          <Toggle
            checked={a2aAutoApproveExecute}
            onChange={setA2aAutoApproveExecute}
            label={t('settings.a2aAutoApproveExecute')}
          />
        </SettingRow>
      </SettingsSection>

      {/* Fan-out workers */}
      <FanoutWorkersSection />
    </div>
  );
}

// ─── Agent toolbar rows (Appearance) ─────────────────────────────────────────
// Moved out of the Agents tab: whether the inject toolbar is pinned is a
// question about what the window shows, not about how agents run.
function AgentToolbarSection() {
  const t = useT();
  const agentToolbarEnabled = useStore((s) => s.agentToolbarEnabled);
  const setAgentToolbarEnabled = useStore((s) => s.setAgentToolbarEnabled);
  const newConversationCommand = useStore((s) => s.newConversationCommand);
  const setNewConversationCommand = useStore((s) => s.setNewConversationCommand);

  return (
    <SettingsSection title={t('settings.agentToolbar')}>
      <SettingRow id="toolbar" label={t('settings.agentToolbarShow')} description={t('settings.agentToolbarShowDesc')}>
        <Toggle
          checked={agentToolbarEnabled}
          onChange={setAgentToolbarEnabled}
          label={t('settings.agentToolbarShow')}
        />
      </SettingRow>
      <SettingRow label={t('settings.agentToolbarNewCommand')}>
        <Input
          type="text"
          aria-label={t('settings.agentToolbarNewCommand')}
          value={newConversationCommand}
          onChange={(e) => setNewConversationCommand(e.target.value)}
          spellCheck={false}
          // A command line is machine evidence: mono.
          className="settings-input font-mono"
          style={{ width: 240 }}
        />
      </SettingRow>
    </SettingsSection>
  );
}

// ─── Claude Code tab — what wmux installs into Claude Code, and its health ───
function TabClaudeCode() {
  return (
    <div className="settings-page">
      <IntegrationSetupSectionContainer />
      <ClaudeIntegrationSection />
      {/* Per-client MCP registration. It lives with the setup card because it
          is the same question — is wmux wired into the agent's config — asked
          for every client wmux knows, not an agent-facing preference. */}
      <McpStatusSection />
    </div>
  );
}

// ─── Remote & phone tab — devices that hold a credential, shared snippets ────
// The live serve toggle stays in the sidebar Remote popover; this tab is where
// you manage what persists once the server is off.
function TabRemote() {
  const t = useT();
  const [devicesOpen, setDevicesOpen] = useState(false);
  useOwnedDialog(devicesOpen);
  return (
    <div className="settings-page">
      <SettingsSection>
        <SettingRow id="paireddevices" label={t('web.devicesTitle')} description={t('web.devicesSubtitle')}>
          <Button variant="secondary" onClick={() => setDevicesOpen(true)}>
            {t('web.devicesLink')}
          </Button>
        </SettingRow>
      </SettingsSection>
      <div data-setting-id="quickcommands" className="scroll-mt-4">
        <QuickCommandsSection />
      </div>
      {devicesOpen && <PairedDevicesModal onClose={() => setDevicesOpen(false)} />}
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
      className="w-full rounded-[12px] p-2 flex flex-col gap-2"
      style={{ backgroundColor: 'var(--bg-base)', border: '1px solid var(--surface-hairline)', boxShadow: 'var(--surface-shadow)' }}
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
          className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded flex-1"
          style={{ backgroundColor: 'var(--surface-fill)', color: 'var(--text-main)', border: '1px solid var(--surface-hairline)' }}
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
  /** Live WCAG report for text/accent tokens. Omitted for backgrounds. */
  contrast?: ContrastReport;
  /** Translator + surface labeller, only needed when `contrast` is set. */
  t?: (key: string, vars?: Record<string, string | number>) => string;
  surfaceLabel?: (bg: string) => string;
  /** Suggested safe hex from the nudge, or null when AA is unreachable. */
  nudgeHex?: string | null;
  /** True when this token differs from the chosen base preset. */
  overridden?: boolean;
  /** Reset this single token back to the base preset value. */
  onResetToBase?: () => void;
  /** The editable token + role this row owns. Drives the inspect markers
   *  (tokenAttrs) so the row is itself a click target, and lets the inspect
   *  target-reaction (D-hover) find and auto-open the matching row. */
  tokenKey?: UIThemeTokenKey;
  tokenRole?: TokenRole;
  /** True when this row is the current inspect target: on mount/transition it
   *  scrolls into view, flashes, and opens its picker (D-hover). */
  inspectTargeted?: boolean;
}

function TokenRow({
  label,
  description,
  value,
  hueScope,
  onChange,
  contrast,
  t,
  surfaceLabel,
  nudgeHex,
  overridden,
  onResetToBase,
  tokenKey,
  tokenRole,
  inspectTargeted,
}: TokenRowProps) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  // Offer the nudge only when there's a real, reachable safe shade that
  // actually differs from the current value.
  const canNudge = !!contrast && !contrast.allPass && !!nudgeHex && nudgeHex.toUpperCase() !== value.toUpperCase();

  // Inspect target-reaction (D-hover): when the overlay click selects this
  // row's token, open its picker, scroll it into view, and briefly flash so the
  // eye lands on the row that maps to what was just clicked on screen. The
  // flash auto-clears; jsdom can't verify scroll/visual, so that part is
  // dogfood-only — the open transition itself is the testable unit.
  useEffect(() => {
    if (!inspectTargeted) return;
    setOpen(true);
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 900);
    return () => window.clearTimeout(id);
  }, [inspectTargeted]);

  return (
    <div
      ref={rowRef}
      className="flex flex-col gap-1 px-2 py-1.5 rounded transition-shadow"
      // tokenAttrs makes the row itself an inspect target so Settings' own
      // surface participates in point-and-style (requirement 6). Spread only
      // when the row declares a token (all 10 editable rows do).
      {...(tokenKey && tokenRole ? tokenAttrs(tokenKey, tokenRole) : {})}
      data-testid={tokenKey ? `token-row-${tokenKey}` : undefined}
      style={flash ? { boxShadow: '0 0 0 2px var(--accent-blue)' } : undefined}
    >
      <button
        className={`flex items-center justify-between w-full rounded ${FOCUS_RING}`}
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {/* "Changed from preset" dot — hover/click resets just this token. */}
          {overridden && onResetToBase && t && (
            <span
              role="button"
              tabIndex={0}
              aria-label={t('settings.theme.resetToken')}
              title={`${t('settings.theme.tokenOverridden')} — ${t('settings.theme.resetToken')}`}
              data-testid={`token-overridden-dot-${label}`}
              className={`group/dot shrink-0 inline-flex items-center justify-center rounded-full ${FOCUS_RING}`}
              style={{ width: 12, height: 12 }}
              onClick={(e) => { e.stopPropagation(); onResetToBase(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onResetToBase(); }
              }}
            >
              {/* Solid dot at rest, undo glyph on hover/focus. Fixed colors. */}
              <span
                className="block rounded-full group-hover/dot:hidden group-focus-visible/dot:hidden"
                style={{ width: 6, height: 6, backgroundColor: '#FBBF24' }}
              />
              <span
                className="hidden group-hover/dot:inline-flex group-focus-visible/dot:inline-flex"
                style={{ color: '#FBBF24', width: 10, height: 10 }}
              >
                <Icon size={10}><path d="M11.5 4.2A5 5 0 1 0 12 7" /><polyline points="11.8,1.5 11.8,4.4 8.9,4.4" /></Icon>
              </span>
            </span>
          )}
          <div className="flex flex-col items-start min-w-0">
            <span className="text-[11px] text-[color:var(--text-sub)] font-medium">{label}</span>
            {description && (
              <span className="text-[10px] text-[color:var(--text-muted)]">{description}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {contrast && t && surfaceLabel && (
            <ContrastBadge report={contrast} t={t} surfaceLabel={surfaceLabel} />
          )}
          <span className="text-[10px] text-[color:var(--text-muted)] font-mono tabular-nums">{value.toUpperCase()}</span>
          <span
            className="w-6 h-6 rounded"
            style={{ backgroundColor: value, border: '1px solid var(--bg-overlay)' }}
          />
        </div>
      </button>

      {/* Nudge link — applies the nearest AA-passing lightness. Warning UI is
          fixed high-contrast so it reads even when the theme is broken. */}
      {contrast && !contrast.allPass && t && (
        <div className="flex items-center gap-2 pl-1">
          {canNudge && nudgeHex ? (
            <button
              type="button"
              data-testid={`contrast-nudge-${contrast.token}`}
              onClick={() => onChange(nudgeHex)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${FOCUS_RING}`}
              style={{ backgroundColor: '#1F2937', color: '#93C5FD', border: '1px solid #3B5067' }}
            >
              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: nudgeHex, border: '1px solid color-mix(in srgb, var(--surface-highlight) 30%, transparent)' }} />
              {t('settings.contrast.nudge')}
            </button>
          ) : (
            <span className="text-[10px]" style={{ color: '#9CA3AF' }}>
              {t('settings.contrast.nudgeUnavailable')}
            </span>
          )}
        </div>
      )}

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
      { key: 'accent',          labelKey: 'settings.token.accent',          hueScope: 'color' },
      { key: 'accentSecondary', labelKey: 'settings.token.accentSecondary', hueScope: 'color' },
      { key: 'success',         labelKey: 'settings.token.success',         hueScope: 'color' },
      { key: 'danger',          labelKey: 'settings.token.danger',          hueScope: 'color' },
      { key: 'warning',         labelKey: 'settings.token.warning',         hueScope: 'color' },
    ],
  },
];

const BASE_ON_OPTIONS: { value: BuiltinThemeId; label: string }[] = [
  { value: 'amber', label: 'Amber' },
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
  accentSecondary: 'Links / info accent',
  success: 'OK / running / complete',
  danger: 'Errors / destructive',
  warning: 'Waiting / caution',
};

// Foreground tokens that get a live WCAG contrast badge (text + accent). The
// other accents (success/danger/warning) are semantic signal colors, not body
// text on a surface, so they're left out of the body-AA check.
const CONTRAST_TOKENS: ReadonlySet<string> = new Set(['textMain', 'textSub', 'textMuted', 'accent']);

// The representative inspect role for each editable token (requirement 6).
// Backgrounds paint a fill ('bg'), the three text tokens paint text ('text'),
// and the four accent/signal tokens paint accent-colored fills/strokes
// ('accent'). The overlay's findTokenForElement keys off these via tokenAttrs
// so a click on a Settings row routes back to the same row.
const TOKEN_INSPECT_ROLE: Record<UITokenSpec['key'], TokenRole> = {
  bgBase: 'bg',
  bgSurface: 'bg',
  bgMantle: 'bg',
  textMain: 'text',
  textSub: 'text',
  textMuted: 'text',
  accent: 'accent',
  accentSecondary: 'accent',
  success: 'accent',
  danger: 'accent',
  warning: 'accent',
};

/**
 * Detect which built-in preset a CustomThemeColors most closely came from, by
 * exact-matching the 10 UI tokens. Returns null when it matches none (fully
 * hand-tuned). Used to label the header and as the per-token "overridden" base.
 */
export function detectBasePreset(colors: CustomThemeColors): BuiltinThemeId | null {
  for (const { value } of BASE_ON_OPTIONS) {
    const preset = builtinToCustom(value);
    const same = UI_TOKEN_GROUPS.every((g) =>
      g.tokens.every(({ key }) => colors[key].toUpperCase() === preset[key].toUpperCase()),
    );
    if (same) return value;
  }
  return null;
}

function CustomThemeEditor() {
  const t = useT();
  const customThemeColors = useStore((s) => s.customThemeColors) ?? DEFAULT_CUSTOM_THEME;
  const setCustomThemeColors = useStore((s) => s.setCustomThemeColors);
  const updateCustomThemeColor = useStore((s) => s.updateCustomThemeColor);
  // Inspect mode (D-hover): the entry button starts point-and-style; the
  // target token (set by an overlay click) tells us which TokenRow to open.
  const enterInspect = useStore((s) => s.enterInspect);
  const inspectTargetToken = useStore((s) => s.inspectTargetToken);

  // The preset the user is comparing against for per-token "overridden" dots.
  // Seeded from an exact match (if the current colors equal a built-in), else
  // catppuccin-mocha. A "Reset to preset…" pick updates both the colors and
  // this base so subsequent edits show as overrides of the new preset.
  const detected = detectBasePreset(customThemeColors);
  const [basePreset, setBasePreset] = useState<BuiltinThemeId>(detected ?? 'catppuccin-mocha');
  // If the live colors exactly match a built-in (e.g. just reseeded), keep the
  // comparison base in sync so nothing reads as "overridden" right after a reset.
  const effectiveBase = detected ?? basePreset;
  const baseColors = useMemo(() => builtinToCustom(effectiveBase), [effectiveBase]);
  const baseLabel = BASE_ON_OPTIONS.find((o) => o.value === effectiveBase)?.label ?? effectiveBase;

  // Surface-aware contrast: each text/accent token vs bgBase/bgSurface/bgMantle.
  const reports = useMemo(() => {
    const out: Partial<Record<ForegroundTokenKey, ContrastReport>> = {};
    for (const tok of ['textMain', 'textSub', 'textMuted', 'accent'] as ForegroundTokenKey[]) {
      out[tok] = evaluateToken(tok, customThemeColors);
    }
    return out;
  }, [customThemeColors]);

  // t() returns the key string itself for a missing key, so the `|| bg` fallback
  // was unreachable dead code — t(...) is always truthy. Kept as a plain call.
  const surfaceLabel = (bg: string): string => t(`settings.contrast.surface.${bg}`);

  const onResetToPreset = (id: BuiltinThemeId): void => {
    setBasePreset(id);
    setCustomThemeColors(builtinToCustom(id));
  };

  return (
    <SettingsSection title={t('settings.customTheme')}>

      {/* Point-and-style entry: shrink Settings to a bar and let the user click
          a region on screen to edit its color (D-settings / D-hover). */}
      <button
        type="button"
        data-testid="inspect-start"
        onClick={() => enterInspect()}
        className={`flex items-center gap-2 w-full px-3 py-2 rounded-[5px] text-left transition-colors ${FOCUS_RING}`}
        style={{ backgroundColor: 'var(--surface-fill)', color: 'var(--text-main)', border: '1px solid var(--surface-hairline)' }}
      >
        <span className="inline-flex items-center shrink-0" style={{ color: 'var(--text-sub)' }}>
          {/* Eyedropper-ish target glyph (shares the 14px line-icon grid). */}
          <Icon><circle cx="7" cy="7" r="3" /><line x1="7" y1="1.5" x2="7" y2="3.5" /><line x1="7" y1="10.5" x2="7" y2="12.5" /><line x1="1.5" y1="7" x2="3.5" y2="7" /><line x1="10.5" y1="7" x2="12.5" y2="7" /></Icon>
        </span>
        <span className="text-[12px] font-medium">{t('settings.inspect.start')}</span>
      </button>

      {/* Header: "Custom (based on …)" + Reset-to-preset control */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-[12px] gap-2"
        style={{ backgroundColor: 'var(--surface-fill)', border: '1px solid var(--surface-hairline)' }}
      >
        <span className="text-[11px] text-[color:var(--text-sub)] truncate" data-testid="custom-theme-based-on">
          {t('settings.theme.basedOn', { preset: baseLabel })}
        </span>
        <select
          className={`text-[13px] rounded-[8px] px-2 py-1 shrink-0 ${FOCUS_RING}`}
          style={{ backgroundColor: 'var(--surface-fill)', color: 'var(--text-main)', border: '1px solid var(--surface-hairline)' }}
          aria-label={t('settings.theme.resetToPreset')}
          data-testid="reset-to-preset-select"
          onChange={(e) => {
            if (e.target.value) onResetToPreset(e.target.value as BuiltinThemeId);
            e.currentTarget.value = '';
          }}
          value=""
        >
          <option value="" disabled>{t('settings.theme.resetToPreset')}</option>
          {BASE_ON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* UI token groups (always expanded — only 3-4 tokens each) */}
      {UI_TOKEN_GROUPS.map((group) => (
        <div
          key={group.label}
          className="rounded-[12px] overflow-hidden"
          style={{ backgroundColor: 'var(--surface-fill)', border: '1px solid var(--surface-hairline)' }}
        >
          <div
            className="px-3 py-1.5 text-[13px] font-medium"
            style={{ color: 'var(--text-muted)' }}
          >
            {t(`settings.tokenGroup.${group.label.toLowerCase()}`) || group.label}
          </div>
          <div className="pb-1">
            {group.tokens.map(({ key, labelKey, hueScope }) => {
              const report = CONTRAST_TOKENS.has(key) ? reports[key as ForegroundTokenKey] : undefined;
              const nudge = report ? nudgeForReport(report, customThemeColors) : null;
              const overridden = customThemeColors[key].toUpperCase() !== baseColors[key].toUpperCase();
              // key is one of the 10 UIThemeTokenKeys (UITokenSpec.key excludes
              // only xtermPaletteId/xtermOverrides), so the cast is sound and the
              // role map is exhaustive over exactly these keys.
              const tokenKey = key as UIThemeTokenKey;
              const role = TOKEN_INSPECT_ROLE[key];
              return (
                <TokenRow
                  key={key}
                  label={t(labelKey) || key}
                  description={TOKEN_DESCRIPTIONS[key]}
                  value={customThemeColors[key]}
                  hueScope={hueScope}
                  onChange={(v) => updateCustomThemeColor(key, v)}
                  contrast={report}
                  t={t}
                  surfaceLabel={surfaceLabel}
                  nudgeHex={nudge ? nudge.hex : undefined}
                  overridden={overridden}
                  onResetToBase={() => updateCustomThemeColor(key, baseColors[key])}
                  tokenKey={tokenKey}
                  tokenRole={role}
                  inspectTargeted={isInspectTargetRow(inspectTargetToken, tokenKey)}
                />
              );
            })}
          </div>
        </div>
      ))}

      {/* Terminal palette preset */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-[12px]"
        style={{ backgroundColor: 'var(--surface-fill)', border: '1px solid var(--surface-hairline)' }}
      >
        <div className="flex flex-col">
          <span className="text-[11px] text-[color:var(--text-sub)]">{t('settings.xtermPalette') || 'Terminal Palette'}</span>
          <span className="text-[10px] text-[color:var(--text-muted)]">
            {t('settings.xtermPaletteDesc') || '16-color ANSI palette for terminal output'}
          </span>
        </div>
        <select
          className={`text-[13px] rounded-[8px] px-2 py-1 ${FOCUS_RING}`}
          style={{ backgroundColor: 'var(--surface-fill)', color: 'var(--text-main)', border: '1px solid var(--surface-hairline)' }}
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
    </SettingsSection>
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
  // Inspect terminal-target reaction (D-terminal): a click on the terminal area
  // sets inspectXtermTarget to 'background' | 'foreground'. When that happens we
  // expand this section and flash the matching surface slot so the user lands
  // on the right swatch. Tracked locally for the flash; the expand is the
  // testable unit (jsdom can't verify scroll/flash visuals → dogfood).
  const inspectXtermTarget = useStore((s) => s.inspectXtermTarget);
  const flashRowRef = useRef<HTMLDivElement>(null);
  const [flashSlot, setFlashSlot] = useState<'background' | 'foreground' | null>(null);

  useEffect(() => {
    if (!inspectXtermTarget) return;
    setExpanded(true);
    setFlashSlot(inspectXtermTarget);
    // Defer scroll until the section has rendered its now-expanded body.
    const raf = window.requestAnimationFrame(() => {
      flashRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const id = window.setTimeout(() => setFlashSlot(null), 900);
    return () => { window.cancelAnimationFrame(raf); window.clearTimeout(id); };
  }, [inspectXtermTarget]);

  const presetId = (customThemeColors.xtermPaletteId as XtermPaletteId);
  const preset = XTERM_PALETTES[presetId] ?? XTERM_PALETTES['catppuccin-mocha'];
  const overrides = customThemeColors.xtermOverrides ?? {};
  const overrideCount = Object.keys(overrides).length;

  return (
    <div
      className="rounded-[12px] overflow-hidden"
      style={{ backgroundColor: 'var(--surface-fill)', border: '1px solid var(--surface-hairline)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`w-full flex items-center justify-between px-3 py-2 text-left hover:bg-[color:var(--bg-surface)] transition-colors ${FOCUS_RING}`}
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
        <span
          className="text-[color:var(--text-muted)] transition-transform shrink-0"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
        >
          <IconChevron />
        </span>
      </button>

      {expanded && (
        <div className="pb-1">
          {XTERM_SLOT_GROUPS.map((group) => (
            <div key={group.labelKey}>
              <div
                className="px-3 py-1 text-[13px] font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                {t(group.labelKey) || group.fallback}
              </div>
              {group.slots.map(({ key, labelKey, fallback }) => {
                const overrideVal = overrides[key];
                const effective = overrideVal ?? preset[key];
                const isOverridden = typeof overrideVal === 'string';
                // The inspect terminal-target highlights exactly the background /
                // foreground surface slot it resolved to (D-terminal v1).
                const isFlashed = flashSlot === key;
                return (
                  <div
                    key={key}
                    ref={isFlashed ? flashRowRef : undefined}
                    data-testid={`xterm-slot-${key}`}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-[color:var(--bg-surface)] transition-colors rounded"
                    style={isFlashed ? { boxShadow: '0 0 0 2px var(--accent-blue)' } : undefined}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-[color:var(--text-sub)] truncate">
                          {t(labelKey) || fallback}
                        </span>
                        {isOverridden && (
                          <Badge>
                            {t('settings.xtermSlotOverridden') || 'custom'}
                          </Badge>
                        )}
                      </div>
                      <span className="text-[10px] text-[color:var(--text-muted)] font-mono tabular-nums">{effective.toUpperCase()}</span>
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
                        className={`inline-flex items-center text-[color:var(--text-subtle)] hover:text-[color:var(--accent-red)] transition-colors shrink-0 rounded ${FOCUS_RING}`}
                        title={t('settings.xtermSlotReset') || 'Reset to preset'}
                        aria-label={t('settings.xtermSlotReset') || 'Reset to preset'}
                      >
                        <Icon size={12}><path d="M11.5 4.2A5 5 0 1 0 12 7" /><polyline points="11.8,1.5 11.8,4.4 8.9,4.4" /></Icon>
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
                style={{ backgroundColor: 'var(--surface-fill)', color: 'var(--accent-red)', border: '1px solid var(--surface-hairline)' }}
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

// ─── Theme preview thumbnail ─────────────────────────────────────────────────

/**
 * A miniature "fake app slice" rendered from a theme's REAL derived palette —
 * deriveBuiltinPalette(id) for built-ins, deriveFullPalette(customThemeColors)
 * for custom — so every card previews the exact colors that theme ships instead
 * of an abstract dot cluster or a hand-maintained tuple. Because the custom
 * card's palette is derived on each render, it tracks the user's live edits.
 */
function ThemeThumbnail({ palette }: { palette: FullCssPalette }) {
  return (
    <div
      className="w-full flex flex-col gap-1 p-1.5"
      style={{ height: 56, backgroundColor: palette.bgBase }}
      aria-hidden="true"
    >
      {/* Top row: an accent-glow "cursor" dot + a primary-text title bar. */}
      <div className="flex items-center gap-1">
        <span
          className="rounded-full shrink-0"
          style={{ width: 6, height: 6, backgroundColor: palette.accentCursor, boxShadow: `0 0 4px ${palette.accentCursor}` }}
        />
        <span className="rounded-full" style={{ height: 3, width: '55%', backgroundColor: palette.textMain }} />
      </div>
      {/* Elevated surface block. */}
      <span className="rounded" style={{ height: 9, width: '100%', backgroundColor: palette.bgSurface }} />
      {/* Bottom row: a secondary-text bar + two status dots (success / danger). */}
      <div className="flex items-center gap-1 mt-auto">
        <span className="rounded-full" style={{ height: 3, width: '40%', backgroundColor: palette.textSub }} />
        <span className="rounded-full shrink-0 ml-auto" style={{ width: 5, height: 5, backgroundColor: palette.accentGreen }} />
        <span className="rounded-full shrink-0" style={{ width: 5, height: 5, backgroundColor: palette.accentRed }} />
      </div>
    </div>
  );
}

// Live-preview sample for the font picker. Mixes Latin, Hangul, and the
// 0/O · 1/l pairs that monospace fonts disambiguate — so the user instantly
// sees whether their chosen font has fixed-width CJK glyphs (the whole point
// of issue #147) and is actually monospaced. Not translated: it is a glyph
// demo, not prose.
const FONT_PREVIEW_SAMPLE = 'AaBb 한글 漢字 0O 1l {}';

/**
 * Font-family picker: a custom combobox for installed fonts, plus an explicit
 * "custom font" mode for typing any family name by hand.
 *
 * Native `<input list>`+`<datalist>` was rejected: the browser filters the
 * datalist by the input's *current value*, so re-opening a chosen field shows
 * only that one item — the opposite of a dropdown. This combobox opens the FULL
 * installed-font list on click regardless of the current value, filters only
 * once the user types, and renders each option *in its own font* so a mixed-mono
 * font's CJK glyphs are visible before selection (the point of issue #147).
 *
 * Recommended seed fonts that are NOT installed on this machine are greyed and
 * tagged "not installed" — otherwise several of them render identically via the
 * fallback chain and look like duplicates.
 *
 * A separate "custom" row drops the field into free-text mode for a not-yet-
 * enumerated family (e.g. JetBrainsMonoHangul): the dropdown collapses, the user
 * types a name, and Apply/Enter commits it. The store setter sanitizes the
 * value, and `terminalFontFamilyCss` sanitizes again at every render site, so
 * nothing here needs to guard the CSS string.
 */
function FontFamilyField() {
  const t = useT();
  const terminalFontFamily = useStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = useStore((s) => s.setTerminalFontFamily);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  // Combobox state. `open` = dropdown visible. `query` = text typed since
  // opening — empty right after opening, so the list shows EVERYTHING until the
  // user searches. `highlight` drives keyboard nav. `custom`/`customText` are
  // the separate free-text entry mode, kept apart so the dropdown (selects
  // installed fonts) and custom entry (types any name) never fight.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const customRef = useRef<HTMLInputElement>(null);

  // Fetch installed fonts once when the field mounts. Best-effort: an empty
  // result (non-Windows, enumeration failed) just means no suggestions — the
  // custom-entry mode still lets the user type any name. Mirrors shell.list.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.fonts
      .list()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch(() => {
        if (!cancelled) setSystemFonts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the suggestion list with the four curated fonts, then merge in the
  // system fonts (deduped, seeds first so the recommended options lead).
  const suggestions = useMemo(() => {
    const seeds = FONT_FAMILY_OPTIONS.map((o) => o.value);
    const seen = new Set(seeds);
    const merged = [...seeds];
    for (const f of systemFonts) {
      if (!seen.has(f)) {
        seen.add(f);
        merged.push(f);
      }
    }
    return merged;
  }, [systemFonts]);

  // Installed-state lookup. Only meaningful once enumeration returned something:
  // an empty systemFonts means "couldn't enumerate" (non-Windows, spawn failed),
  // NOT "everything is uninstalled" — so don't grey anything in that case.
  const installedSet = useMemo(() => new Set(systemFonts), [systemFonts]);
  const knowInstalled = systemFonts.length > 0;
  const isInstalled = useCallback(
    // Bundled fonts always render (shipped via @font-face), so treat them as
    // available regardless of OS enumeration.
    (f: string) => BUNDLED_FONTS.has(f) || !knowInstalled || installedSet.has(f),
    [knowInstalled, installedSet],
  );

  // Empty query (just opened) → show everything; once the user types →
  // substring-filter.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return suggestions;
    return suggestions.filter((f) => f.toLowerCase().includes(q));
  }, [suggestions, query]);

  // Closed → show the committed font. Open → show the live query (blank right
  // after opening). The live preview tracks the highlighted option while
  // navigating, else the committed font.
  const displayValue = open ? query : terminalFontFamily;
  const previewTarget = highlight >= 0 && filtered[highlight] ? filtered[highlight] : terminalFontFamily;

  const openList = useCallback(() => {
    setOpen(true);
    setQuery('');
    setHighlight(-1);
  }, []);
  const closeReset = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHighlight(-1);
  }, []);
  const selectFont = useCallback(
    (f: string) => {
      setTerminalFontFamily(f);
      closeReset();
    },
    [setTerminalFontFamily, closeReset],
  );

  const enterCustom = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHighlight(-1);
    setCustomText(terminalFontFamily);
    setCustom(true);
  }, [terminalFontFamily]);
  const exitCustom = useCallback(() => {
    setCustom(false);
    setCustomText('');
  }, []);
  const applyCustom = useCallback(() => {
    const v = customText.trim();
    if (v !== '') setTerminalFontFamily(v);
    exitCustom();
  }, [customText, setTerminalFontFamily, exitCustom]);

  // Focus the custom input when entering custom mode.
  useEffect(() => {
    if (custom) customRef.current?.focus();
  }, [custom]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (highlight < 0 || !listRef.current) return;
    (listRef.current.children[highlight] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  // ─── Custom free-text entry mode ──────────────────────────────────────────
  if (custom) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-1" style={{ minWidth: 180 }}>
          <input
            ref={customRef}
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyCustom();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                exitCustom();
              }
            }}
            aria-label={t('settings.fontFamily')}
            placeholder={t('settings.fontCustomPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            className="ui-input settings-input font-mono flex-1"
            style={{ minWidth: 120 }}
          />
          <UiButton
            variant="icon"
            onClick={applyCustom}
            aria-label={t('settings.fontApply')}
            title={t('settings.fontApply')}
            className="shrink-0"
          >
            <IconCheck size={12} />
          </UiButton>
          <UiButton
            variant="icon"
            onClick={exitCustom}
            aria-label={t('settings.fontCancel')}
            title={t('settings.fontCancel')}
            className="shrink-0"
          >
            <IconX size={12} />
          </UiButton>
        </div>
        <div
          className="text-xs rounded-md px-2 py-1 w-full text-right truncate"
          style={{
            fontFamily: terminalFontFamilyCss(customText),
            color: 'var(--text-sub)',
            border: '1px solid var(--surface-hairline)',
            minWidth: 180,
          }}
          aria-hidden="true"
        >
          {FONT_PREVIEW_SAMPLE}
        </div>
      </div>
    );
  }

  // ─── Dropdown (installed-font selection) mode ─────────────────────────────
  return (
    <div className="relative flex flex-col items-end gap-1.5">
      <div className="relative" style={{ minWidth: 180 }}>
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="terminal-font-listbox"
          aria-autocomplete="list"
          value={displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(-1);
          }}
          onMouseDown={() => {
            // Toggle on click so a second click closes; opening always shows the
            // full list (openList resets the query state).
            if (open) closeReset();
            else openList();
          }}
          onBlur={() => {
            // Tab-out / click-away just closes and keeps the stored value.
            // Typing here only filters — committing a not-installed name is the
            // custom mode's job. Option clicks use onMouseDown+preventDefault, so
            // they fire first and this is skipped.
            closeReset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!open) return openList();
              setHighlight((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              // Highlighted row first; else the sole/first filtered match.
              if (highlight >= 0 && filtered[highlight]) selectFont(filtered[highlight]);
              else if (filtered.length > 0) selectFont(filtered[0]);
              else closeReset();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              closeReset();
              e.currentTarget.blur();
            }
          }}
          aria-label={t('settings.fontFamily')}
          // Open + blank → hint the current font so it stays visible while the
          // field is cleared for browsing; closed → the normal placeholder.
          placeholder={open && terminalFontFamily ? terminalFontFamily : t('settings.fontFamilyPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          className="ui-input settings-input font-mono w-full"
          style={{ paddingRight: 28 }}
        />
        {/* Chevron affordance — signals this is a dropdown, not a plain field. */}
        <span
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex"
          style={{ color: 'var(--text-sub)' }}
          aria-hidden="true"
        >
          <Icon size={12}><polyline points="3.5,5.5 7,9 10.5,5.5" /></Icon>
        </span>
        {open && (
          <ul
            ref={listRef}
            id="terminal-font-listbox"
            role="listbox"
            className="absolute right-0 z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-[10px] p-1"
            style={{
              backgroundColor: 'var(--bg-base)',
              border: '1px solid var(--surface-hairline)',
              boxShadow: 'var(--surface-shadow)',
            }}
          >
            {filtered.map((f, i) => {
              const isCurrent = f === terminalFontFamily;
              const isHi = i === highlight;
              const installed = isInstalled(f);
              return (
                <li
                  key={f}
                  role="option"
                  aria-selected={isCurrent}
                  // preventDefault keeps input focus so onBlur doesn't fire and
                  // clobber the selection before onMouseDown runs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectFont(f);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs cursor-pointer rounded-[6px]"
                  style={{
                    // Greyed when not installed (renders via fallback anyway).
                    fontFamily: terminalFontFamilyCss(f),
                    color: installed ? 'var(--text-main)' : 'var(--text-muted)',
                    backgroundColor: isHi ? 'var(--surface-fill-hover)' : 'transparent',
                  }}
                >
                  <span className="truncate">{f}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {!installed && (
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {t('settings.fontNotInstalled')}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="inline-flex" style={{ color: 'var(--text-main)' }} aria-hidden="true">
                        <IconCheck size={12} />
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-2 py-1 text-xs" style={{ color: 'var(--text-muted)' }} aria-disabled="true">
                —
              </li>
            )}
            {/* Sticky entry point into free-text custom mode. */}
            <li
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                enterCustom();
              }}
              className="sticky bottom-0 flex items-center gap-1.5 px-2 py-1.5 text-xs cursor-pointer border-t"
              style={{
                backgroundColor: 'var(--bg-base)',
                borderColor: 'var(--surface-hairline)',
                color: 'var(--text-main)',
              }}
            >
              <span aria-hidden="true" className="inline-flex"><IconPlus size={12} /></span>
              <span>{t('settings.fontCustom')}</span>
            </li>
          </ul>
        )}
      </div>
      {/* Live preview — renders the sample in the highlighted/current font so
          Hangul + mono glyphs are visible before committing. */}
      <div
        className="text-xs rounded-md px-2 py-1 w-full text-right truncate"
        style={{
          fontFamily: terminalFontFamilyCss(previewTarget),
          color: 'var(--text-sub)',
          border: '1px solid var(--surface-hairline)',
          minWidth: 180,
        }}
        aria-hidden="true"
      >
        {FONT_PREVIEW_SAMPLE}
      </div>
    </div>
  );
}

export function ChromePresetActionsView({
  onApply,
}: {
  onApply: (preset: ChromePreset) => void;
}) {
  const t = useT();

  return (
    <div
      role="group"
      aria-label={t('settings.chromePreset')}
      className="flex shrink-0 items-center gap-2"
    >
      <Button
        type="button"
        variant="secondary"
        onClick={() => onApply('minimal')}
        data-chrome-preset="minimal"
      >
        {t('settings.chromePresetMinimal')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => onApply('standard')}
        data-chrome-preset="standard"
      >
        {t('settings.chromePresetStandard')}
      </Button>
    </div>
  );
}

function TabAppearance() {
  const t = useT();
  const terminalFontSize    = useStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useStore((s) => s.setTerminalFontSize);
  const terminalCursorStyle = useStore((s) => s.terminalCursorStyle);
  const setTerminalCursorStyle = useStore((s) => s.setTerminalCursorStyle);

  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const sidebarSortMode = useStore((s) => s.sidebarSortMode);
  const setSidebarSortMode = useStore((s) => s.setSidebarSortMode);
  const sidebarShowPaneCoordinates = useStore((s) => s.sidebarShowPaneCoordinates);
  const setSidebarShowPaneCoordinates = useStore((s) => s.setSidebarShowPaneCoordinates);
  const setSidebarPosition = useStore((s) => s.setSidebarPosition);
  const multiviewArrangement = useStore((s) => s.multiviewArrangement);
  const setMultiviewArrangement = useStore((s) => s.setMultiviewArrangement);

  const paneActionsVisible = useStore((s) => s.paneActionsVisible);
  const setPaneActionsVisible = useStore((s) => s.setPaneActionsVisible);
  const chatViewEnabled = useStore((s) => s.chatViewEnabled);
  const setChatViewEnabled = useStore((s) => s.setChatViewEnabled);
  const titlebarClockVisible = useStore((s) => s.titlebarClockVisible);
  const setTitlebarClockVisible = useStore((s) => s.setTitlebarClockVisible);
  const paneNewTerminalButton = useStore((s) => s.paneNewTerminalButton);
  const setPaneNewTerminalButton = useStore((s) => s.setPaneNewTerminalButton);
  const applyChromePreset = useStore((s) => s.applyChromePreset);
  const pushToast = useStore((s) => s.pushToast);

  const applyChromePresetWithFeedback = (preset: ChromePreset) => {
    applyChromePreset(preset);
    pushToast({ level: 'info', message: t('settings.chromePresetApplied') });
  };

  // UI scale (#822) — whole-interface zoom, applied to main via window:setUiScale.
  const uiScale = useStore((s) => s.uiScale);
  const setUiScale = useStore((s) => s.setUiScale);

  const currentTheme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  // Live custom-theme colors drive the `custom` card's thumbnail so it always
  // reflects the user's real palette (not a frozen snapshot). Null before the
  // user has ever customized → fall back to the default custom theme.
  const customThemeColors = useStore((s) => s.customThemeColors) ?? DEFAULT_CUSTOM_THEME;

  return (
    <div className="settings-page">
      {/* Theme — visual cards on the surface radii and hairlines. Selection is
          a neutral outline + check, never steel (steel is focus only). */}
      <section data-setting-id="theme" className="settings-section scroll-mt-4">
        <div className="settings-section-head">
          <h3 className="ui-group-label settings-section-title">{t('settings.theme')}</h3>
        </div>
        <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label={t('settings.theme')}>
          {THEME_OPTIONS.map(({ value, label }) => {
            const selected = currentTheme === value;
            const palette = value === 'custom'
              ? deriveFullPalette(customThemeColors)
              : deriveBuiltinPalette(value as BuiltinThemeId);
            return (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                role="radio"
                aria-checked={selected}
                aria-label={label}
                className={`settings-theme-card ${FOCUS_RING}`}
              >
                <ThemeThumbnail palette={palette} />
                <div
                  className="flex items-center justify-between gap-1 px-2.5 py-1.5"
                  style={{ backgroundColor: palette.bgMantle, color: selected ? palette.textMain : palette.textSub }}
                >
                  <span className="text-[13px] truncate">{label}</span>
                  {selected && (
                    <span className="shrink-0 inline-flex" style={{ color: palette.textMain }} aria-hidden="true">
                      <IconCheck size={12} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Custom theme editor — shown when custom theme selected */}
      {currentTheme === 'custom' && <CustomThemeEditor />}

      <SettingsSection title={t('settings.sectionInterface')}>
        <SettingRow id="uiscale" label={t('settings.uiScale')} description={t('settings.uiScaleDesc')}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.8}
              max={1.6}
              step={0.05}
              value={uiScale}
              onChange={(e) => setUiScale(Number(e.target.value))}
              aria-label={t('settings.uiScale')}
              className={`settings-range ${FOCUS_RING}`}
            />
            <span className="settings-range-value">
              {Math.round(uiScale * 100)}%
            </span>
          </div>
        </SettingRow>
        <SettingRow id="chrome" label={t('settings.chromePreset')} description={t('settings.chromePresetDesc')}>
          <ChromePresetActionsView onApply={applyChromePresetWithFeedback} />
        </SettingRow>
        {/* Off by default — the OS draws a clock already, and a permanent
            reading in the titlebar is the dead gauge DESIGN.md rules out. */}
        <SettingRow label={t('settings.titlebarClock')} description={t('settings.titlebarClockDesc')}>
          <Toggle
            checked={titlebarClockVisible}
            onChange={setTitlebarClockVisible}
            label={t('settings.titlebarClock')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.sectionSidebar')}>
        <SettingRow id="sidebarpos" label={t('settings.sidebarPosition')} description={t('settings.sidebarPositionDesc')}>
          <SegmentedControl
            value={sidebarPosition}
            onValueChange={setSidebarPosition}
            options={[
              { value: 'left', label: t('settings.sidebarLeft') },
              { value: 'right', label: t('settings.sidebarRight') },
            ]}
          />
        </SettingRow>
        {/* Manual by default on purpose: a list that reorders itself under the
            user's eyes costs more than the scan it saves. #1481 adds "Recent
            activity" beside needs-you-first; the row id stays for deep links. */}
        <SettingRow
          id="sidebarattention"
          label={t('settings.sidebarSort')}
          description={t('settings.sidebarSortDesc')}
        >
          <SegmentedControl
            value={sidebarSortMode}
            onValueChange={setSidebarSortMode}
            options={[
              { value: 'manual', label: t('settings.sidebarSortManual') },
              { value: 'attention', label: t('settings.sidebarSortAttention') },
              { value: 'recent', label: t('settings.sidebarSortRecent') },
            ]}
          />
        </SettingRow>
        {/* #1326 — on by default: turning it off is an explicit opt-out, not a
            behavior change nobody asked for. */}
        <SettingRow
          id="sidebarpanecoordinates"
          label={t('settings.sidebarShowPaneCoordinates')}
          description={t('settings.sidebarShowPaneCoordinatesDesc')}
        >
          <Toggle
            checked={sidebarShowPaneCoordinates}
            onChange={setSidebarShowPaneCoordinates}
            label={t('settings.sidebarShowPaneCoordinates')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.sectionPanes')}>
        <SettingRow
          id="multiview"
          label={t('settings.multiviewArrangement')}
          description={t('settings.multiviewArrangementDesc')}
        >
          <SegmentedControl
            value={multiviewArrangement}
            onValueChange={setMultiviewArrangement}
            options={MULTIVIEW_ARRANGEMENTS.map((mode) => ({
              value: mode,
              label: mode === 'auto'
                ? t('settings.multiviewAuto')
                : mode === 'columns'
                  ? t('settings.multiviewColumns')
                  : t('settings.multiviewRows'),
            }))}
          />
        </SettingRow>
        <SettingRow label={t('settings.paneActionsVisible')} description={t('settings.paneActionsVisibleDesc')}>
          <Toggle
            checked={paneActionsVisible}
            onChange={setPaneActionsVisible}
            label={t('settings.paneActionsVisible')}
          />
        </SettingRow>
        {/* Labelled experimental on purpose: this is the one toggle here that
            changes what wmux RECOMMENDS, not just what it shows. See the
            uiSlice note. */}
        <SettingRow
          label={t('settings.paneNewTerminalButton')}
          description={t('settings.paneNewTerminalButtonDesc')}
        >
          <div className="flex items-center gap-3">
            <Badge title={t('settings.paneNewTerminalButtonDesc')}>{t('settings.mcpExperimental')}</Badge>
            <Toggle
              checked={paneNewTerminalButton}
              onChange={setPaneNewTerminalButton}
              label={t('settings.paneNewTerminalButton')}
            />
          </div>
        </SettingRow>
        {/* Off by default while experimental (PR #1440): markdown coverage is
            incomplete and the send path is still being tested in the field. */}
        <SettingRow label={t('settings.chatView')} description={t('settings.chatViewDesc')}>
          <Toggle
            checked={chatViewEnabled}
            onChange={setChatViewEnabled}
            label={t('settings.chatView')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.terminal')} overflowVisible>
        <SettingRow id="fontsize" label={t('settings.fontSize')} description={`${terminalFontSize}px — ${t('settings.fontSizeRange')}`}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={12}
              max={24}
              value={terminalFontSize}
              onChange={(e) => setTerminalFontSize(Number(e.target.value))}
              aria-label={t('settings.fontSize')}
              className={`settings-range ${FOCUS_RING}`}
            />
            <span className="settings-range-value">{terminalFontSize}</span>
          </div>
        </SettingRow>
        <SettingRow id="fontfamily" label={t('settings.fontFamily')} description={t('settings.fontFamilyDesc')}>
          <FontFamilyField />
        </SettingRow>
        <div data-setting-id="cursorshape" className="settings-block scroll-mt-4">
          <div className="flex flex-col gap-0.5">
            <span className="ui-field-label">{t('settings.cursorShape')}</span>
            <span className="ui-field-description">{t('settings.cursorShapeDesc')}</span>
          </div>
          <CursorShapePicker value={terminalCursorStyle} onChange={setTerminalCursorStyle} t={t} />
        </div>
      </SettingsSection>

      <AgentToolbarSection />
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
  // #949 — unread-glow dim level (1 = no dimming, 0.6 = historical look)
  paneGlowOpacity: number;
  onChangePaneGlowOpacity: (v: number) => void;
  paneFlashEnabled: boolean;
  onChangePaneFlashEnabled: (v: boolean) => void;
  taskbarFlashEnabled: boolean;
  onChangeTaskbarFlashEnabled: (v: boolean) => void;
  notificationSoundChoice: 'default' | 'none';
  onChangeNotificationSoundChoice: (choice: 'default' | 'none') => void;

  // #516 — per-category mute
  mutedNotificationCategories: NotificationCategory[];
  onChangeCategoryMuted: (category: NotificationCategory, muted: boolean) => void;

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
    paneGlowOpacity, onChangePaneGlowOpacity,
    paneFlashEnabled, onChangePaneFlashEnabled,
    taskbarFlashEnabled, onChangeTaskbarFlashEnabled,
    notificationSoundChoice, onChangeNotificationSoundChoice,
    mutedNotificationCategories, onChangeCategoryMuted,
    workspaces, onChangeWorkspaceMuted,
    t,
  } = props;

  return (
    <div className="settings-page" data-testid="notifications-settings-section">
      {/* Global behavior */}
      <SettingsSection title={t('settings.notificationBehavior')}>
        <SettingRow id="sound" label={t('settings.sound')} description={t('settings.soundDesc')}>
          <Toggle
            checked={notificationSoundEnabled}
            onChange={() => onToggleNotificationSound()}
            label={t('settings.sound')}
          />
        </SettingRow>
        <SettingRow id="toast" label={t('settings.toast')} description={t('settings.toastDesc')}>
          <Toggle
            checked={toastEnabled}
            onChange={onChangeToastEnabled}
            label={t('settings.toast')}
          />
        </SettingRow>
        <SettingRow id="osnotify" label={t('settings.ring')} description={t('settings.ringDesc')}>
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

        {/* #949 — Unread-glow dim level. A slider rather than a toggle so users
            can land anywhere between "no shadowing" (100%) and the historical
            look (60%). Disabled alongside the pane ring: with the ring off the
            glow never renders, so the dim has nothing to act on. */}
        <SettingRow label={t('settings.paneGlowDim')} description={t('settings.paneGlowDimDesc')}>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={60}
              max={100}
              step={5}
              value={Math.round(paneGlowOpacity * 100)}
              onChange={(e) => onChangePaneGlowOpacity(Number(e.target.value) / 100)}
              disabled={!paneRingEnabled}
              aria-label={t('settings.paneGlowDim')}
              className={`settings-range disabled:opacity-40 ${FOCUS_RING}`}
            />
            <span className="settings-range-value">{Math.round(paneGlowOpacity * 100)}%</span>
          </div>
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
        <div className="settings-row" data-testid="notification-sound-choice-row">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex flex-col gap-0.5">
              <span className="ui-field-label" id="notification-sound-choice-label">
                {t('settings.notificationSoundChoice')}
              </span>
              <span className="ui-field-description" id="notification-sound-choice-desc">
                {t('settings.notificationSoundChoiceDesc')}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-labelledby="notification-sound-choice-label"
              aria-describedby="notification-sound-choice-desc"
              className="flex items-center gap-4 shrink-0"
            >
              <label className="settings-radio">
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
              <label className="settings-radio">
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
      </SettingsSection>

      {/* #516 — Per-category mute. Muted categories still reach the
          notification panel; only toast/sound/ring/flash are suppressed. */}
      <SettingsSection
        id="catmute"
        title={t('settings.notificationCategories')}
        description={t('settings.notificationCategoriesDesc')}
        data-testid="notification-category-section"
      >
        {NOTIFICATION_CATEGORIES.map((category) => (
          <SettingRow
            key={category}
            label={t(`settings.notificationCategory.${category}`)}
            description={t(`settings.notificationCategory.${category}.desc`)}
          >
            <Toggle
              checked={!mutedNotificationCategories.includes(category)}
              onChange={(enabled) => onChangeCategoryMuted(category, !enabled)}
              label={t(`settings.notificationCategory.${category}`)}
            />
          </SettingRow>
        ))}
      </SettingsSection>

      {/* T12 — Per-workspace mute list */}
      <SettingsSection
        id="wsmute"
        title={t('settings.perWorkspaceNotifications')}
        description={t('settings.perWorkspaceNotificationsDesc')}
        data-testid="per-workspace-mute-section"
      >
        {workspaces.length === 0 ? (
          <SettingNote data-testid="per-workspace-mute-empty">
            {t('settings.perWorkspaceNotificationsEmpty')}
          </SettingNote>
        ) : (
          <div className="flex flex-col" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {workspaces.map((ws, idx) => {
              const labelId = `workspace-mute-label-${ws.id}`;
              const descId = `workspace-mute-desc-${ws.id}`;
              return (
                <label
                  key={ws.id}
                  htmlFor={`workspace-mute-${ws.id}`}
                  className="settings-row cursor-pointer hover:bg-[color:var(--surface-fill-hover)] transition-colors"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderTop: idx === 0 ? 'none' : '1px solid var(--surface-hairline)',
                  }}
                  data-testid={`per-workspace-mute-row-${ws.id}`}
                >
                  <div className="min-w-0 mr-3 flex flex-col gap-0.5">
                    <span className="ui-field-label truncate" id={labelId}>
                      {t('settings.muteWorkspace', { name: ws.name })}
                    </span>
                    <span className="ui-field-description truncate" id={descId}>
                      {ws.name}
                    </span>
                  </div>
                  <input
                    id={`workspace-mute-${ws.id}`}
                    type="checkbox"
                    checked={ws.muted}
                    aria-labelledby={labelId}
                    aria-describedby={descId}
                    onChange={(e) => onChangeWorkspaceMuted(ws.id, e.target.checked)}
                    data-testid={`per-workspace-mute-checkbox-${ws.id}`}
                    className="settings-native-check shrink-0 cursor-pointer"
                  />
                </label>
              );
            })}
          </div>
        )}
      </SettingsSection>
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
  const paneGlowOpacity          = useStore((s) => s.paneGlowOpacity);
  const setPaneGlowOpacity       = useStore((s) => s.setPaneGlowOpacity);
  const paneFlashEnabled         = useStore((s) => s.paneFlashEnabled);
  const setPaneFlashEnabled      = useStore((s) => s.setPaneFlashEnabled);
  const taskbarFlashEnabled      = useStore((s) => s.taskbarFlashEnabled);
  const setTaskbarFlashEnabled   = useStore((s) => s.setTaskbarFlashEnabled);
  const notificationSoundChoice  = useStore((s) => s.notificationSoundChoice);
  const setNotificationSoundChoice = useStore((s) => s.setNotificationSoundChoice);

  // #516 fields
  const mutedNotificationCategories = useStore((s) => s.mutedNotificationCategories);
  const setNotificationCategoryMuted = useStore((s) => s.setNotificationCategoryMuted);

  // A1: {id,name,notificationsMuted}만 필요 — 투영만 구독해 cwd/git/port churn에
  // 리렌더되지 않게 한다.
  const muteRows = useStore(useShallow(selectWorkspaceMuteRows));
  const updateWorkspaceMetadata = useStore((s) => s.updateWorkspaceMetadata);

  const workspaceRows: NotificationsViewWorkspaceRow[] = useMemo(
    () => muteRows.map((ws) => ({
      id: ws.id,
      name: ws.name,
      muted: ws.notificationsMuted,
    })),
    [muteRows],
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
      paneGlowOpacity={paneGlowOpacity}
      onChangePaneGlowOpacity={setPaneGlowOpacity}
      paneFlashEnabled={paneFlashEnabled}
      onChangePaneFlashEnabled={setPaneFlashEnabled}
      taskbarFlashEnabled={taskbarFlashEnabled}
      onChangeTaskbarFlashEnabled={setTaskbarFlashEnabled}
      notificationSoundChoice={notificationSoundChoice}
      onChangeNotificationSoundChoice={setNotificationSoundChoice}
      mutedNotificationCategories={mutedNotificationCategories}
      onChangeCategoryMuted={setNotificationCategoryMuted}
      workspaces={workspaceRows}
      onChangeWorkspaceMuted={(id, muted) => updateWorkspaceMetadata(id, { notificationsMuted: muted })}
    />
  );
}

// ─── Dialogs Settings owns ───────────────────────────────────────────────────
//
// A modal opened FROM Settings (key capture, paired devices) is the top-most
// layer: Escape closes only it and Ctrl/Cmd+F must not pull focus to the
// search box behind it. Settings' own key handler runs first (window,
// capture), so it has to know when one is open. Each owner registers while it
// is open; a DOM query for any aria-modal dialog would also match dialogs
// Settings does not own (the floating terminal stays mounted, hidden).
const OwnedDialogContext = createContext<(delta: number) => void>(() => undefined);

function useOwnedDialog(open: boolean): void {
  const register = useContext(OwnedDialogContext);
  useEffect(() => {
    if (!open) return;
    register(1);
    return () => register(-1);
  }, [open, register]);
}

// ─── Key capture overlay ──────────────────────────────────────────────────────

function KeyCaptureOverlay({ label, onCapture, onCancel }: { label: string; onCapture: (key: string, code: string) => void; onCancel: () => void }) {
  const t = useT();
  useOwnedDialog(true);
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
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onCancel}
    >
      <div
        className="px-8 py-6 rounded-[14px] text-center"
        style={{ backgroundColor: 'var(--bg-base)', border: '1px solid var(--surface-hairline)', boxShadow: 'var(--surface-shadow)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[16px] font-semibold text-[color:var(--text-main)] mb-2">{label}</p>
        <p className="text-[13px] text-[color:var(--text-sub)]">{t('settings.escToCancel')}</p>
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
function shortcutLabel(entry: KeymapEntry): string {
  const isMac = window.electronAPI.platform === 'darwin';
  // literalCtrl entries (tmux prefix, bookmark family) stay literal on macOS —
  // the flag lives in WMUX_KEYMAP so this and useKeyboard.ts can't drift.
  return isMac ? macDisplayCombo(entry) : entry.combo;
}

const PREFIX_ACTION_IDS = [
  'splitHorizontal', 'splitVertical', 'closePane',
  'newWorkspace', 'nextWorkspace', 'prevWorkspace',
  'hideWindow', 'toggleZoom', 'commandPalette',
  'renameWorkspace', 'killWorkspace', 'showCheatSheet',
  'focusUp', 'focusDown', 'focusLeft', 'focusRight',
  'movePaneUp', 'movePaneDown', 'movePaneLeft', 'movePaneRight',
  'swapPanePrev', 'swapPaneNext',
  'stashPane',
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
  const disabledShortcuts = useStore((s) => s.disabledShortcuts);
  const toggleShortcutDisabled = useStore((s) => s.toggleShortcutDisabled);
  const prefixConfig = useStore((s) => s.prefixConfig);
  const setPrefixKey = useStore((s) => s.setPrefixKey);
  const setPrefixBinding = useStore((s) => s.setPrefixBinding);
  const removePrefixBinding = useStore((s) => s.removePrefixBinding);
  const resetPrefixConfig = useStore((s) => s.resetPrefixConfig);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [capturingPrefixKey, setCapturingPrefixKey] = useState(false);
  const [capturingBindingKey, setCapturingBindingKey] = useState<string | null>(null);
  const [addingBinding, setAddingBinding] = useState(false);

  // Was a hand-copied subset that had drifted — Ctrl+Shift+A / Ctrl+Shift+G /
  // Ctrl+M / Ctrl+Tab and the zoom keys are all bound but were missing, so a
  // custom keybinding on one of them got no conflict warning and then silently
  // never fired. Derived from WMUX_KEYMAP now (#818), and resolved for the
  // running platform — on macOS a built-in that fires on ⌘ cannot collide with
  // a custom binding, which is matched on literal Ctrl.
  // #1152 — a disabled built-in no longer claims its combo, so a custom
  // keybinding on it is a deliberate rebind, not a conflict to warn about.
  const BUILTIN_KEYS = new Set(
    [...builtinCombosFor(window.electronAPI?.platform === 'darwin' ? 'darwin' : 'win32')]
      .filter((c) => !disabledShortcuts.includes(c)),
  );

  const prefixKeyDisplay = `Ctrl+${keyCodeToDisplay(prefixConfig.key)}`;
  const bindingEntries = Object.entries(prefixConfig.bindings);

  // OS-aware labels — macOS shows ⌘ for the cmdOrCtrl family, literal Ctrl for
  // tmux/bookmark family. prefixKeyDisplay always renders as literal Ctrl
  // because the prefix combo stays on Ctrl across every OS.
  const shortcuts = [
    // The prefix row keeps its own config below — no toggle (combo: undefined).
    { keys: prefixKeyDisplay, description: t('settings.prefixMode'), combo: undefined as string | undefined },
    ...ADVERTISED_SHORTCUTS.map((entry) => ({
      keys: shortcutLabel(entry),
      description: t(entry.descriptionKey as Parameters<typeof t>[0]),
      // #1152 — the storage-form combo keys the disable toggle.
      combo: entry.combo as string | undefined,
    })),
  ];

  return (
    <div className="settings-page">
      <SettingsSection title={t('settings.shortcuts')}>
        {shortcuts.map((s) => (
          <KbdRow
            key={s.keys}
            keys={s.keys}
            description={s.description}
            // #1152 — advertised built-ins can be switched off; the key then
            // passes through to the terminal (Codex Ctrl+T et al.).
            disabled={s.combo ? disabledShortcuts.includes(s.combo) : undefined}
            onToggleDisabled={s.combo ? () => toggleShortcutDisabled(s.combo as string) : undefined}
            toggleTitle={t('settings.shortcutDisableHint')}
          />
        ))}
      </SettingsSection>

      {/* Prefix mode configuration */}
      <SettingsSection
        title={t('settings.prefixMode')}
        action={(
          <Button
            variant="ghost"
            onClick={() => { if (confirm(t('settings.prefixResetConfirm'))) resetPrefixConfig(); }}
          >
            {t('settings.prefixReset')}
          </Button>
        )}
      >
        {/* Prefix trigger key */}
        <SettingRow id="prefix" label={t('settings.prefixKey')} description={t('settings.prefixKeyDesc')}>
          <button
            type="button"
            className={`settings-kbd ${FOCUS_RING}`}
            style={{ minWidth: 50, justifyContent: 'center', minHeight: 28 }}
            onClick={() => setCapturingPrefixKey(true)}
          >
            {keyCodeToDisplay(prefixConfig.key)}
          </button>
        </SettingRow>

        {/* Prefix bindings list */}
        <p className="settings-note" style={{ paddingBottom: 4 }}>{t('settings.prefixBindings')}</p>
        {bindingEntries.length === 0 ? (
          <SettingNote>{t('settings.kb.noBindings')}</SettingNote>
        ) : (
          bindingEntries.map(([key, actionId]) => (
            <div key={key} className="settings-row settings-kbd-row">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <button
                  type="button"
                  className={`settings-kbd ${FOCUS_RING}`}
                  // Fixed width so the action selects line up down the list.
                  style={{ width: 88, justifyContent: 'center' }}
                  onClick={() => setCapturingBindingKey(key)}
                >
                  {key}
                </button>
                <span className="text-[color:var(--text-muted)] shrink-0 inline-flex"><IconChevron /></span>
                <Select
                  aria-label={`${t('settings.prefixAction')} (${key})`}
                  className="flex-1 min-w-0"
                  value={actionId}
                  onChange={(e) => {
                    removePrefixBinding(key);
                    setPrefixBinding(key, e.target.value);
                  }}
                >
                  {PREFIX_ACTION_IDS.map((aid) => (
                    <option key={aid} value={aid}>{prefixActionLabel(aid, t)}</option>
                  ))}
                </Select>
              </div>
              <UiButton
                variant="icon"
                className="shrink-0"
                onClick={() => removePrefixBinding(key)}
                title={t('settings.kb.delete')}
                aria-label={t('settings.kb.delete')}
              >
                <IconX size={12} />
              </UiButton>
            </div>
          ))
        )}
        {/* Add prefix binding */}
        <div className="settings-row" style={{ minHeight: 0 }}>
          <Button variant="secondary" className="self-start" onClick={() => setAddingBinding(true)}>
            <IconPlus size={12} /> {t('settings.prefixAddBinding')}
          </Button>
        </div>
      </SettingsSection>

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
      <SettingsSection id="customkeys" title={t('settings.customKeybindings')}>
        {/* macOS 기본 설정에서 F1–F12는 미디어 키로 동작해 F키 단독 바인딩이 발동하지 않음 → 안내 */}
        {window.electronAPI.platform === 'darwin' && hasBareFunctionKeyBinding(customKeybindings) && (
          <SettingNote>{t('settings.kb.macFnHint')}</SettingNote>
        )}

        {customKeybindings.length === 0 ? (
          <SettingNote>{t('settings.kb.noBindings')}</SettingNote>
        ) : (
          customKeybindings.map((kb) => (
            <div key={kb.id} className="settings-row settings-kbd-row">
              {/* Key badge */}
              <button
                type="button"
                className={`settings-kbd shrink-0 ${FOCUS_RING}`}
                style={{ minWidth: 60, justifyContent: 'center' }}
                onClick={() => setCapturingFor(kb.id)}
              >
                {kb.key}
              </button>

              {/* Conflict warning */}
              {BUILTIN_KEYS.has(kb.key) && (
                <span
                  role="img"
                  aria-label={t('settings.kb.conflict')}
                  title={t('settings.kb.conflict')}
                  className="inline-flex shrink-0"
                  style={{ color: 'var(--accent-yellow)' }}
                >
                  <IconWarning size={12} />
                </span>
              )}

              {/* Label */}
              <Input
                className="settings-input min-w-0"
                style={{ maxWidth: 140 }}
                value={kb.label}
                onChange={(e) => updateKeybinding(kb.id, { label: e.target.value })}
                placeholder={t('settings.kb.label')}
                aria-label={t('settings.kb.label')}
                onClick={(e) => e.stopPropagation()}
              />

              {/* Command */}
              <Input
                className="settings-input font-mono flex-[2] min-w-0"
                value={kb.command}
                onChange={(e) => updateKeybinding(kb.id, { command: e.target.value })}
                placeholder={t('settings.kb.command')}
                aria-label={t('settings.kb.command')}
                onClick={(e) => e.stopPropagation()}
              />

              {/* Send Enter toggle */}
              <Toggle
                checked={kb.sendEnter}
                onChange={(v) => updateKeybinding(kb.id, { sendEnter: v })}
                label={t('settings.kb.sendEnter')}
              />

              {/* Delete */}
              <UiButton
                variant="icon"
                className="shrink-0"
                onClick={() => removeKeybinding(kb.id)}
                title={t('settings.kb.delete')}
                aria-label={t('settings.kb.delete')}
              >
                <IconX size={12} />
              </UiButton>
            </div>
          ))
        )}

        {/* Add button */}
        <div className="settings-row" style={{ minHeight: 0 }}>
          <Button variant="secondary" className="self-start" onClick={() => setCapturingFor('new')}>
            <IconPlus size={12} /> {t('settings.kb.add')}
          </Button>
        </div>
      </SettingsSection>

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
    <SettingsSection id="firstrun" title={t('settings.firstRunSetup')} data-testid="first-run-setup-section">
      <div className="settings-row" data-testid="first-run-setup-last-completed">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex flex-col gap-0.5">
            <span className="ui-field-label">{lastCompleted}</span>
            <span className="ui-field-description">{t('settings.firstRunSetupDesc')}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              onClick={onShowCheatSheet}
              data-testid="first-run-setup-show-cheat-sheet"
            >
              {t('settings.firstRunSetup.showCheatSheet')}
            </Button>
            <Button
              variant="secondary"
              onClick={onOpenWizard}
              data-testid="first-run-setup-open-wizard"
            >
              {t('settings.firstRunSetup.openWizard')}
            </Button>
          </div>
        </div>
      </div>

      <div className="settings-row settings-kbd-row" style={{ justifyContent: 'flex-start' }} data-testid="first-run-setup-claude-row">
        <StatusBadge ok={claudeFound} okLabel="detected" failLabel="not detected" />
        <span className="settings-kbd-desc">{claudeStatusText}</span>
      </div>

      <div className="settings-row settings-kbd-row" style={{ justifyContent: 'flex-start' }} data-testid="first-run-setup-mcp-row">
        <StatusBadge ok={mcpRegistered} okLabel="registered" failLabel="not registered" />
        <span className="settings-kbd-desc">{mcpStatusText}</span>
      </div>

      {status?.status.claudeJsonPath && (
        <SettingNote
          className="font-mono truncate"
          title={status.status.claudeJsonPath}
          data-testid="first-run-setup-claude-path"
        >
          {status.status.claudeJsonPath}
        </SettingNote>
      )}
    </SettingsSection>
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
    <div className="settings-page">
      {/* Product header — left-aligned, name + version inline (no centered hero) */}
      <Card className="flex items-center gap-3 px-4 py-4">
        <span
          className="grid place-items-center rounded-[10px] shrink-0"
          style={{ width: 40, height: 40, backgroundColor: 'var(--surface-fill-hover)', color: 'var(--text-main)' }}
        >
          <Icon size={22}><path d="M7 1.5 L8 6 L12.5 7 L8 8 L7 12.5 L6 8 L1.5 7 L6 6 Z" /></Icon>
        </span>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[16px] font-semibold text-[color:var(--text-main)]">wmux</span>
            {/* The version string is machine evidence. */}
            <span className="text-[11px] font-mono tabular-nums text-[color:var(--text-sub)]">v{__APP_VERSION__}</span>
          </div>
          <p data-setting-id="version" className="ui-field-description m-0 mt-0.5 truncate scroll-mt-4">
            {t('settings.aboutTagline')}
          </p>
        </div>
      </Card>

      <SettingsSection title={t('settings.builtWith')}>
        {[
          'Electron 41',
          'React 19 + TypeScript 5.9',
          'xterm.js 6 + node-pty',
          'Vite 5 + Tailwind CSS 3',
          'Zustand 5 + Immer',
        ].map((item) => (
          <div key={item} className="settings-row settings-kbd-row" style={{ minHeight: 36 }}>
            <span className="settings-kbd-desc">{item}</span>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.links')}>
        <a
          href="https://github.com/openwong2kim/wmux"
          target="_blank"
          rel="noopener noreferrer"
          className={`settings-row settings-kbd-row justify-start gap-2 text-[13px] text-[color:var(--accent-blue)] hover:underline ${FOCUS_RING}`}
          style={{ justifyContent: 'flex-start' }}
        >
          <IconExternalLink />
          <span>{t('settings.githubRepo')}</span>
        </a>
      </SettingsSection>
    </div>
  );
}

// ─── SettingsPanel ─────────────────────────────────────────────────────────────

// ─── Inspect decision helpers (pure — unit-testable in the node env) ─────────
//
// The SettingsPanel behaviour that matters for inspect mode reduces to three
// pure decisions. Extracting them keeps the (DOM-bound) component thin and lets
// the node-env vitest suite assert the contract directly — the visual scroll /
// flash remains dogfood-only, but the branch logic is fully covered.

/**
 * D-esc (mandatory regression): should an Escape keypress close Settings?
 * NO while inspect is active (the overlay owns ESC → exitInspect); YES
 * otherwise — preserving the pre-inspect behaviour exactly.
 */
export function shouldEscCloseSettings(inspectModeActive: boolean): boolean {
  return !inspectModeActive;
}

/**
 * D-settings: render the collapsed floating bar (true) vs the full modal
 * (false). Collapse only when inspect minimized AND there is no pending target
 * to edit, OR the user dismissed that target back to the bar.
 */
export function shouldShowInspectBar(
  inspectMinimized: boolean,
  hasTarget: boolean,
  dismissedTarget: boolean,
): boolean {
  return inspectMinimized && (!hasTarget || dismissedTarget);
}

/**
 * D-hover: does a given editable token row match the current inspect target?
 *
 * Matched on the TOKEN ALONE — never the role. Each editable token maps to
 * exactly one TokenRow, so the token uniquely identifies the row. The click
 * role (`target.role`) stays the element's representative role for the overlay's
 * highlight/menu labeling, but a derived region routes to its source token while
 * keeping that representative role (e.g. bgOverlay border → token 'bgSurface',
 * role 'border'). Requiring role equality here would then leave that pick with
 * no matching row (bgSurface's canonical role is 'bg') and dead-click the
 * largest clickable surfaces. Token-only matching makes every routed pick open
 * its row.
 */
export function isInspectTargetRow(
  target: { token: UIThemeTokenKey; role: TokenRole } | null,
  tokenKey: UIThemeTokenKey,
): boolean {
  return target !== null && target.token === tokenKey;
}

// ─── Inspect minimized bar (D-settings) ─────────────────────────────────────
//
// While point-and-style is active, the full Settings modal shrinks to a small
// fixed corner bar so the live app underneath is visible to click. Pure prop
// component (no store) so it renders under `renderToStaticMarkup` in tests.
//
// FIXED high-contrast styling on purpose: the user may be actively breaking the
// theme tokens, so this bar must stay readable. It therefore NEVER uses
// var(--*) — every color is a self-sufficient hardcoded pair, mirroring the
// ContrastBadge rationale (plans/color-customization-inspect-mode.md §4.4).
export function InspectMinimizedBar({
  t,
  onDone,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  onDone: () => void;
}) {
  return (
    <div
      data-testid="inspect-minimized-bar"
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-[7px] px-4 py-3 shadow-2xl"
      style={{
        width: 320,
        backgroundColor: '#111827',
        color: '#F9FAFB',
        border: '1px solid #374151',
        boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
      }}
    >
      <span className="inline-flex items-center shrink-0" style={{ color: '#60A5FA' }}>
        <Icon><circle cx="7" cy="7" r="3" /><line x1="7" y1="1.5" x2="7" y2="3.5" /><line x1="7" y1="10.5" x2="7" y2="12.5" /><line x1="1.5" y1="7" x2="3.5" y2="7" /><line x1="10.5" y1="7" x2="12.5" y2="7" /></Icon>
      </span>
      <span className="flex-1 text-[12px] font-medium truncate">{t('settings.inspect.picking')}</span>
      <button
        type="button"
        data-testid="inspect-done"
        onClick={onDone}
        className="shrink-0 rounded px-2.5 py-1 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2"
        style={{ backgroundColor: '#2563EB', color: '#FFFFFF', border: '1px solid #1D4ED8' }}
      >
        {t('settings.inspect.done')}
      </button>
    </div>
  );
}

export default function SettingsPanel({ initialTab }: { initialTab?: string }) {
  const t = useT();
  const visible   = useStore((s) => s.settingsPanelVisible);
  const setVisible = useStore((s) => s.setSettingsPanelVisible);

  // Inspect mode (D-settings / D-esc). When minimized AND no target is pending,
  // render the small floating bar instead of the full modal; while inspect is
  // active the ESC handler is suppressed (the overlay owns ESC → exitInspect).
  const inspectModeActive = useStore((s) => s.inspectModeActive);
  const inspectMinimized = useStore((s) => s.inspectMinimized);
  const inspectTargetToken = useStore((s) => s.inspectTargetToken);
  const inspectXtermTarget = useStore((s) => s.inspectXtermTarget);
  const exitInspect = useStore((s) => s.exitInspect);
  const clearInspectTarget = useStore((s) => s.clearInspectTarget);

  // A pending target (overlay clicked a region/terminal slot) temporarily
  // restores the full modal so the user can edit that color — Settings stays
  // mounted the whole time (D-settings). We don't mutate the store's
  // inspectMinimized (owned by uiSlice); the local `dismissedTarget` lets the
  // user collapse back to the bar after editing without leaving inspect.
  const hasTarget = inspectTargetToken !== null || inspectXtermTarget !== null;
  const [dismissedTarget, setDismissedTarget] = useState(false);
  // Reset the dismissal whenever a *new* target arrives so the next click
  // re-expands the editor even if the previous one was dismissed.
  useEffect(() => {
    if (hasTarget) setDismissedTarget(false);
  }, [inspectTargetToken, inspectXtermTarget, hasTarget]);
  const showBar = shouldShowInspectBar(inspectMinimized, hasTarget, dismissedTarget);

  // Every id that reaches the state goes through resolveSettingsTab, so a
  // retired or unknown id (an old deep link) opens a real tab, never nothing.
  const [activeTab, setActiveTabState] = useState<TabId>(() => resolveSettingsTab(initialTab));
  const setActiveTab = useCallback((id: string) => setActiveTabState(resolveSettingsTab(id)), []);
  const ownedDialogs = useRef(0);
  const registerOwnedDialog = useCallback((delta: number) => { ownedDialogs.current += delta; }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const searchHits = useMemo(
    () => matchSettings(searchQuery, t, SETTINGS_CATALOG),
    [searchQuery, t],
  );
  const searching = searchQuery.trim().length > 0;

  const jumpTo = useCallback((id: string) => {
    const entry = SETTINGS_CATALOG.find((item) => item.id === id);
    if (!entry) return;
    setSearchQuery('');
    setActiveTab(entry.tab);
    setHighlightId(id);
  }, [setActiveTab]);

  useEffect(() => {
    if (!highlightId || searching) return;
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-setting-id="${highlightId}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.classList.add('settings-flash');
    const timer = window.setTimeout(() => {
      el?.classList.remove('settings-flash');
      setHighlightId(null);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [highlightId, searching, activeTab]);

  // When a target arrives while collapsed, surface the editor on the Appearance
  // tab so the auto-opened TokenRow / xterm slot is actually on screen.
  useEffect(() => {
    if (hasTarget && !dismissedTarget) setActiveTab('appearance');
  }, [hasTarget, dismissedTarget, setActiveTab]);

  const TAB_META: Record<TabId, { label: string; icon: ReactNode }> = {
    general:              { label: t('settings.tabGeneral'),       icon: <IconGeneral /> },
    appearance:           { label: t('settings.tabAppearance'),    icon: <IconAppearance /> },
    terminal:             { label: t('settings.tabTerminal'),      icon: <IconTerminal /> },
    shortcuts:            { label: t('settings.tabKeyboard'),      icon: <IconShortcuts /> },
    notifications:        { label: t('settings.tabNotifications'), icon: <IconNotifications /> },
    'claude-integration': { label: t('settings.tabClaudeCode'),    icon: <IconClaude /> },
    accounts:             { label: t('settings.tabAccounts'),      icon: <IconUsers /> },
    orchestrator:         { label: t('settings.tabOrchestrator'),  icon: <IconAgents /> },
    roles:                { label: t('settings.tabRoles'),         icon: <IconRobot /> },
    browser:              { label: t('settings.tabBrowser'),       icon: <IconBrowser /> },
    remote:               { label: t('settings.tabRemote'),        icon: <IconRemoteDevices /> },
    lanlink:              { label: t('settings.tabLan'),           icon: <IconLanLink /> },
    about:                { label: t('settings.tabAbout'),         icon: <IconAbout /> },
  };

  // Close on Escape (D-esc). While inspect is active the overlay owns ESC
  // (ESC → exitInspect, leaving Settings mounted), so this handler MUST NOT
  // close Settings — it no-ops. When inspect is NOT active, ESC closes Settings
  // exactly as before (mandatory regression: the non-inspect path is unchanged).
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      // A dialog Settings opened owns the keyboard (see useOwnedDialog).
      if (ownedDialogs.current > 0) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        // suppressed while inspect active — overlay handles ESC (D-esc).
        if (!shouldEscCloseSettings(inspectModeActive)) return;
        if (searchQuery.trim()) {
          e.stopPropagation();
          setSearchQuery('');
          return;
        }
        e.stopPropagation();
        setVisible(false);
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [visible, setVisible, inspectModeActive, searchQuery]);

  if (!visible) return null;

  // D-settings: collapsed to the floating bar while picking. "Done" exits
  // inspect; Settings stays mounted (exitInspect keeps settingsPanelVisible).
  if (showBar) {
    return <InspectMinimizedBar t={t} onDone={() => exitInspect()} />;
  }

  // Close affordances (X / footer Close / backdrop). When inspect is active the
  // full modal is only a temporary editor for a pending target — closing it
  // collapses back to the floating bar so the user keeps picking, rather than
  // tearing the whole Settings panel down out from under the overlay. When
  // inspect is NOT active, this closes Settings as before.
  const handleClose = () => {
    if (inspectModeActive) {
      setDismissedTarget(true);
      // Integration contract: clear the pending target so the overlay resumes
      // hover inspection (overlayShouldCapture flips back to true). Without this
      // the target stays set, the overlay keeps yielding capture, and the user
      // can never hover-pick a second region — inspect is stranded after one
      // click. This collapses Settings to the floating bar and re-arms picking.
      clearInspectTarget();
      return;
    }
    setVisible(false);
  };

  return (
    // Full-bleed surface under the 36px custom titlebar (DESIGN.md Window
    // Chrome). Settings fills the whole terminal area instead of floating as a
    // small centered modal: no scrim, no rounding/shadow/border, opaque
    // bg-base — it reads as an app screen, not a dialog stacked on top. Closed
    // via Esc (keydown handler above) or the header X. `ui-surface` scopes the
    // quiet-surface tokens (hairlines, flat buttons, 10px inputs) to it.
    <OwnedDialogContext.Provider value={registerOwnedDialog}>
    <div
      className="ui-surface settings-screen fixed inset-x-0 bottom-0 z-50 flex flex-col"
      style={{ top: 36, backgroundColor: 'var(--bg-base)' }}
    >
      {/* Panel — fills the full-bleed surface */}
      <div
        ref={panelRef}
        className="flex flex-col flex-1 min-h-0 overflow-hidden"
        style={{ backgroundColor: 'var(--bg-base)' }}
      >
        {/* Header */}
        <div className="settings-header shrink-0">
          <h2 className="settings-header-title">{t('settings.title')}</h2>
          <UiButton
            variant="icon"
            className="settings-header-close"
            onClick={handleClose}
            aria-label={t('settings.close')}
          >
            <IconX />
          </UiButton>
        </div>

        {/* Body: left nav + right content */}
        <div className="flex flex-1 min-h-0">
          {/* Left tab navigation */}
          <nav className="settings-nav" aria-label={t('settings.title')}>
            <div className="settings-nav-search">
              <Input
                ref={searchRef}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('settings.searchPlaceholder')}
                aria-label={t('settings.searchPlaceholder')}
                data-testid="settings-search"
              />
              <p className="settings-nav-count" aria-live="polite">
                {searching
                  ? (searchHits.length
                    ? t('settings.searchMatches', { n: searchHits.length })
                    : t('settings.searchNoMatches', { query: searchQuery.trim() }))
                  : ''}
              </p>
            </div>
            <div className="settings-nav-list">
              {SETTINGS_NAV_GROUPS.map((group) => (
                <div key={group.id} className="settings-nav-group">
                  {group.labelKey && (
                    <div className="settings-nav-heading">{t(group.labelKey)}</div>
                  )}
                  {group.tabs.map((tabId) => {
                    const tab = TAB_META[tabId];
                    const isActive = !searching && activeTab === tabId;
                    const hits = searching ? tabHitCount(tabId, searchHits) : 0;
                    return (
                      <button
                        key={tabId}
                        type="button"
                        data-settings-tab={tabId}
                        onClick={() => {
                          setSearchQuery('');
                          setActiveTab(tabId);
                        }}
                        aria-current={isActive ? 'page' : undefined}
                        data-dim={searching && hits === 0 ? 'true' : undefined}
                        className={`settings-nav-row ${FOCUS_RING}`}
                      >
                        <span className="settings-nav-icon inline-flex items-center leading-none">
                          {tab.icon}
                        </span>
                        <span className="flex-1 truncate">{tab.label}</span>
                        {searching && hits > 0 && (
                          <span className="settings-nav-hits">{hits}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </nav>

          {/* Right content — scrolls full-width, but the content column is
              centered at a readable max-width so full-bleed doesn't stretch
              toggle rows across the whole screen. */}
          <div className="settings-content">
            <div className="settings-column">
              {searching ? (
                <SettingsSearchResults
                  query={searchQuery}
                  hits={searchHits}
                  tabLabel={(tab) => TAB_META[tab].label}
                  t={t}
                  onJump={jumpTo}
                />
              ) : (
                <>
                  <h1 className="settings-page-title" data-testid="settings-page-title">{TAB_META[activeTab].label}</h1>
                  <div className="settings-page" data-settings-page={activeTab}>
                    {activeTab === 'general'            && <TabGeneral />}
                    {activeTab === 'appearance'         && <TabAppearance />}
                    {activeTab === 'terminal'           && <TabTerminal />}
                    {activeTab === 'shortcuts'          && <TabShortcuts />}
                    {activeTab === 'notifications'      && <TabNotifications />}
                    {activeTab === 'claude-integration' && <TabClaudeCode />}
                    {activeTab === 'accounts'           && <AccountsSection />}
                    {activeTab === 'orchestrator'       && <TabOrchestrator />}
                    {activeTab === 'roles'              && <TabRoles />}
                    {activeTab === 'browser'            && <TabBrowser />}
                    {activeTab === 'remote'             && <TabRemote />}
                    {activeTab === 'lanlink'            && <><LanLinkSection /><LanLinkPairingSection /></>}
                    {activeTab === 'about'              && <TabAbout />}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    </OwnedDialogContext.Provider>
  );
}
