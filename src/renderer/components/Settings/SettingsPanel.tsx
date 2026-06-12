import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { useStore } from '../../stores';
import { LOCALE_OPTIONS, type Locale } from '../../i18n';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { THEME_OPTIONS, XTERM_PALETTE_OPTIONS, XTERM_PALETTES, builtinToCustom, DEFAULT_CUSTOM_THEME, tokenAttrs, type BuiltinThemeId, type ThemeId, type XtermPaletteId, type UIThemeTokenKey, type TokenRole } from '../../themes';
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
import type { CustomThemeColors, XtermThemeColors } from '../../../shared/types';
import type { FirstRunCheckResult } from '../../../shared/firstRun';
import { FIRST_RUN_REOPEN_EVENT } from '../../../shared/firstRun';
import { ClaudeIntegrationSection } from './ClaudeIntegrationSection';
import { terminalFontFamilyCss } from '../../utils/terminalFont';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabId = 'general' | 'appearance' | 'notifications' | 'shortcuts' | 'claude-integration' | 'first-run-setup' | 'about';
type ShellInfo = { name: string; path: string; args?: string[] };

// ─── Icon components ──────────────────────────────────────────────────────────
//
// One stroke-based line-icon system. All icons share a 14×14 viewBox,
// `stroke="currentColor"` (so they inherit the caller's text color, including
// active/inactive tab coloring), strokeWidth 1.3, and round caps/joins. This
// replaces the Unicode glyphs (⚙◑◎⌨◈◇ℹ✓✗▾▸↺✕⎋) that rendered at mismatched
// sizes and weights across platforms (issue #145).

/** Shared svg wrapper — keeps every icon on the same grid + style. */
function Icon({ children, size = 14 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IconX() {
  return <Icon><line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" /></Icon>;
}

function IconCheck() {
  return <Icon><polyline points="2.5,7.4 5.8,10.5 11.5,3.5" /></Icon>;
}

function IconChevron() {
  // Points right; rotate 90° via transform for an expanded/down state.
  return <Icon><polyline points="5.5,3 9.5,7 5.5,11" /></Icon>;
}

function IconExternalLink() {
  return (
    <Icon>
      <path d="M6 3H3.3v7.7h7.7V8" />
      <polyline points="8.2,2.5 11.5,2.5 11.5,5.8" />
      <line x1="11.5" y1="2.5" x2="6.6" y2="7.4" />
    </Icon>
  );
}

// ─── Shared focus ring ─────────────────────────────────────────────────────────
//
// Keyboard-visible focus indicator. wmux is a keyboard-first developer tool, so
// every interactive control needs one. Applied via className so it composes with
// inline color styles. (Audit: 33 buttons, only 3 had focus rings.)

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-blue)] focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--bg-base)]';

// ─── Card primitive ────────────────────────────────────────────────────────────
//
// The `rounded-lg + bg-mantle + 1px bg-surface border` surface was copy-pasted
// ~25× inline. One component now owns it — change the surface treatment once and
// it propagates everywhere. Callers pass layout via className and may override
// individual style properties (e.g. maxHeight) via `style`.

function Card({
  className = '',
  style,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg ${className}`}
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)', ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ─── Button primitive ──────────────────────────────────────────────────────────

type ButtonVariant = 'secondary' | 'primary' | 'destructive' | 'accent';

const BUTTON_VARIANT_STYLE: Record<ButtonVariant, React.CSSProperties> = {
  secondary:   { backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)',  border: '1px solid var(--bg-overlay)' },
  primary:     { backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)',    border: '1px solid transparent' },
  destructive: { backgroundColor: 'var(--accent-red)',  color: 'var(--bg-base)',    border: '1px solid transparent' },
  accent:      { backgroundColor: 'var(--bg-surface)',  color: 'var(--accent-blue)', border: '1px solid var(--bg-overlay)' },
};

function Button({
  variant = 'secondary',
  className = '',
  style,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${FOCUS_RING} ${className}`}
      style={{ ...BUTTON_VARIANT_STYLE[variant], ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

// ─── Status badge ──────────────────────────────────────────────────────────────
//
// A check (ok) / cross (fail) status dot. Replaces the inline ✓/✗ glyphs and
// carries an aria-label so the state is exposed to assistive tech.

function StatusBadge({ ok, okLabel = 'OK', failLabel = 'Not OK' }: { ok: boolean; okLabel?: string; failLabel?: string }) {
  return (
    <span
      role="img"
      aria-label={ok ? okLabel : failLabel}
      className="shrink-0 inline-flex items-center justify-center"
      style={{ color: ok ? 'var(--accent-green)' : 'var(--accent-red)', width: 14, height: 14 }}
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
      style={{ backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}`, height: 16, fontSize: 9, lineHeight: '14px' }}
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

function IconFirstRun() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <line x1="3.5" y1="1.8" x2="3.5" y2="12.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3.5 2.5h6.7l-1.7 2.3 1.7 2.3H3.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
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
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${FOCUS_RING}`}
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
    <Card className="flex items-center justify-between px-3 py-2.5">
      <div className="min-w-0 mr-3">
        <p className="text-sm text-[color:var(--text-main)]">{label}</p>
        {description && <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">{description}</p>}
      </div>
      {children}
    </Card>
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
      className="text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)] font-mono tabular-nums text-center"
      style={{
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-main)',
        border: '1px solid var(--bg-overlay)',
        width: 64,
      }}
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
    <input
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
      className="text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)] font-mono"
      style={{
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-main)',
        border: '1px solid var(--bg-overlay)',
        width: 200,
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
        className="text-[10px] font-mono tabular-nums px-2 py-0.5 rounded"
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
            <Button variant="destructive" onClick={handleReset}>
              {t('settings.resetButton')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t('settings.close')}
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="shrink-0 ml-3"
            style={{ color: 'var(--accent-red)' }}
            onClick={() => setConfirming(true)}
          >
            {t('settings.resetButton')}
          </Button>
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
          <StatusBadge ok={server.registered} okLabel="registered" failLabel="not registered" />
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
              <Button
                variant="accent"
                onClick={() => void handleReregister()}
                disabled={pending !== null}
                style={{ opacity: pending ? 0.5 : 1 }}
              >
                {pending === 'reregister' ? '…' : 'Re-register'}
              </Button>
              {confirmingUnregister ? (
                <>
                  <Button
                    variant="destructive"
                    onClick={() => void handleUnregister()}
                    disabled={pending !== null}
                  >
                    {pending === 'unregister' ? '…' : 'Confirm'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmingUnregister(false)}
                    disabled={pending !== null}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => setConfirmingUnregister(true)}
                  disabled={pending !== null}
                  style={{ color: 'var(--accent-red)' }}
                >
                  Unregister
                </Button>
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

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';

function UpdateStatus() {
  const t = useT();
  const [state, setState] = useState<UpdateState>('idle');
  const [releaseName, setReleaseName] = useState<string>('');
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
        setState('available');
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
      case 'downloading': return percent === null
        ? t('settings.checkUpdate') + '…'
        : `${t('settings.checkUpdate')}… ${percent}%`;
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
      case 'downloading':
      case 'downloaded': return 'var(--accent-green)';
      case 'error': return 'var(--accent-red)';
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
        {state === 'downloading' && (
          <div className="mt-1.5 h-1 w-40 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-surface)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: percent === null ? '100%' : `${percent}%`,
                backgroundColor: 'var(--accent-green)',
                opacity: percent === null ? 0.4 : 1,
              }}
            />
          </div>
        )}
      </div>
      <div className="flex gap-2 shrink-0 ml-3">
        {state === 'downloaded' ? (
          <Button
            onClick={handleInstall}
            style={{ backgroundColor: 'var(--accent-green)', color: 'var(--bg-base)', border: 'none' }}
          >
            {t('settings.updateReady')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={handleCheck}
            disabled={state === 'checking' || state === 'downloading'}
            style={{ border: 'none', opacity: state === 'checking' || state === 'downloading' ? 0.5 : 1 }}
          >
            {t('settings.checkUpdate')}
          </Button>
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
  const splitInheritsCwd = useStore((s) => s.splitInheritsCwd);
  const setSplitInheritsCwd = useStore((s) => s.setSplitInheritsCwd);
  const imeResidueGuardEnabled = useStore((s) => s.imeResidueGuardEnabled);
  const setImeResidueGuardEnabled = useStore((s) => s.setImeResidueGuardEnabled);
  const startupDirectory = useStore((s) => s.startupDirectory);
  const setStartupDirectory = useStore((s) => s.setStartupDirectory);
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
              className={`px-3 py-2 rounded-lg text-sm transition-colors text-left ${FOCUS_RING}`}
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
        <SettingRow label={t('settings.startupDirectory')} description={t('settings.startupDirectoryDesc')}>
          <SettingPathInput
            label={t('settings.startupDirectory')}
            value={startupDirectory}
            onCommit={setStartupDirectory}
            placeholder={t('settings.startupDirectoryPlaceholder')}
          />
        </SettingRow>
        <SettingRow label={t('settings.splitInheritsCwd')} description={t('settings.splitInheritsCwdDesc')}>
          <Toggle
            checked={splitInheritsCwd}
            onChange={setSplitInheritsCwd}
            label={t('settings.splitInheritsCwd')}
          />
        </SettingRow>
        <SettingRow label={t('settings.imeResidueGuard')} description={t('settings.imeResidueGuardDesc')}>
          <Toggle
            checked={imeResidueGuardEnabled}
            onChange={setImeResidueGuardEnabled}
            label={t('settings.imeResidueGuard')}
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
          <Button
            variant="secondary"
            className="shrink-0"
            style={{ color: 'var(--text-subtle)' }}
            onClick={() => {
              useStore.getState().startOnboarding();
              useStore.getState().setSettingsPanelVisible(false);
            }}
          >
            {t('settings.restartTutorial')}
          </Button>
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
          className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded flex-1"
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
              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: nudgeHex, border: '1px solid rgba(255,255,255,0.3)' }} />
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
    <div className="flex flex-col gap-2">
      <SectionLabel label={t('settings.customTheme')} />

      {/* Point-and-style entry: shrink Settings to a bar and let the user click
          a region on screen to edit its color (D-settings / D-hover). */}
      <button
        type="button"
        data-testid="inspect-start"
        onClick={() => enterInspect()}
        className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left transition-colors ${FOCUS_RING}`}
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--accent-blue)' }}
      >
        <span className="inline-flex items-center shrink-0" style={{ color: 'var(--accent-blue)' }}>
          {/* Eyedropper-ish target glyph (shares the 14px line-icon grid). */}
          <Icon><circle cx="7" cy="7" r="3" /><line x1="7" y1="1.5" x2="7" y2="3.5" /><line x1="7" y1="10.5" x2="7" y2="12.5" /><line x1="1.5" y1="7" x2="3.5" y2="7" /><line x1="10.5" y1="7" x2="12.5" y2="7" /></Icon>
        </span>
        <span className="text-[12px] font-medium">{t('settings.inspect.start')}</span>
      </button>

      {/* Header: "Custom (based on …)" + Reset-to-preset control */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-lg gap-2"
        style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      >
        <span className="text-[11px] text-[color:var(--text-sub)] truncate" data-testid="custom-theme-based-on">
          {t('settings.theme.basedOn', { preset: baseLabel })}
        </span>
        <select
          className={`text-[11px] rounded px-2 py-0.5 font-mono shrink-0 ${FOCUS_RING}`}
          style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--bg-overlay)' }}
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
          className={`text-[11px] rounded px-2 py-0.5 font-mono ${FOCUS_RING}`}
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
      className="rounded-lg overflow-hidden"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
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
                className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider"
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
                          <span
                            className="text-[10px] uppercase tracking-wider rounded px-1"
                            style={{ color: 'var(--accent-blue)', border: '1px solid var(--accent-blue)' }}
                          >
                            {t('settings.xtermSlotOverridden') || 'custom'}
                          </span>
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
            className="text-xs rounded-md px-2 py-1 flex-1 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)] font-mono"
            style={{
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-main)',
              border: '1px solid var(--bg-overlay)',
              minWidth: 120,
            }}
          />
          <button
            type="button"
            onClick={applyCustom}
            aria-label={t('settings.fontApply')}
            title={t('settings.fontApply')}
            className="text-xs rounded-md px-1.5 py-1 shrink-0 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)]"
            style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)' }}
          >
            ✓
          </button>
          <button
            type="button"
            onClick={exitCustom}
            aria-label={t('settings.fontCancel')}
            title={t('settings.fontCancel')}
            className="text-xs rounded-md px-1.5 py-1 shrink-0 focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)]"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-sub)', border: '1px solid var(--bg-overlay)' }}
          >
            ✕
          </button>
        </div>
        <div
          className="text-xs rounded-md px-2 py-1 w-full text-right truncate"
          style={{
            fontFamily: terminalFontFamilyCss(customText),
            color: 'var(--text-sub)',
            backgroundColor: 'var(--bg-base)',
            border: '1px solid var(--bg-surface)',
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
          className="text-xs rounded-md pl-2 pr-6 py-1 w-full focus:outline-none focus:ring-1 focus:ring-[color:var(--accent-blue)] font-mono"
          style={{
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-main)',
            border: '1px solid var(--bg-overlay)',
          }}
        />
        {/* Chevron affordance — signals this is a dropdown, not a plain field. */}
        <span
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px]"
          style={{ color: 'var(--text-muted)' }}
          aria-hidden="true"
        >
          ▼
        </span>
        {open && (
          <ul
            ref={listRef}
            id="terminal-font-listbox"
            role="listbox"
            className="absolute right-0 z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md py-1 shadow-lg"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--bg-overlay)',
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
                  className="flex items-center justify-between gap-2 px-2 py-1 text-xs cursor-pointer"
                  style={{
                    // Greyed when not installed (renders via fallback anyway).
                    fontFamily: terminalFontFamilyCss(f),
                    color: installed ? 'var(--text-main)' : 'var(--text-muted)',
                    backgroundColor: isHi ? 'var(--bg-overlay)' : 'transparent',
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
                      <span style={{ color: 'var(--accent-blue)' }} aria-hidden="true">
                        ✓
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
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--bg-overlay)',
                color: 'var(--accent-blue)',
              }}
            >
              <span aria-hidden="true">＋</span>
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
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          minWidth: 180,
        }}
        aria-hidden="true"
      >
        {FONT_PREVIEW_SAMPLE}
      </div>
    </div>
  );
}

function TabAppearance() {
  const t = useT();
  const terminalFontSize    = useStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useStore((s) => s.setTerminalFontSize);

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
              className={`px-2 py-2 rounded-lg text-[11px] transition-colors text-center flex flex-col items-center ${FOCUS_RING}`}
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
            <span className="text-xs font-mono tabular-nums text-[color:var(--text-sub)] w-6 text-right">{terminalFontSize}</span>
          </div>
        </SettingRow>
        <SettingRow label={t('settings.fontFamily')} description={t('settings.fontFamilyDesc')}>
          <FontFamilyField />
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
          className={`text-[11px] font-mono tabular-nums px-3 py-1 rounded shrink-0 ${FOCUS_RING}`}
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
          className={`text-[10px] px-1.5 py-0.5 rounded text-[color:var(--accent-yellow)] hover:text-[color:var(--text-main)] transition-colors ${FOCUS_RING}`}
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
                className={`text-[10px] font-mono tabular-nums px-2 py-0.5 rounded shrink-0 ${FOCUS_RING}`}
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--accent-green)', border: '1px solid var(--bg-overlay)', minWidth: 50, textAlign: 'center' }}
                onClick={() => setCapturingBindingKey(key)}
              >
                {key}
              </button>
              <span className="text-[color:var(--text-muted)] shrink-0"><IconChevron /></span>
              <select
                className={`flex-1 bg-transparent text-[11px] text-[color:var(--text-sub)] font-mono outline-none cursor-pointer rounded ${FOCUS_RING}`}
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
                className={`inline-flex items-center text-[color:var(--text-subtle)] hover:text-[color:var(--accent-red)] transition-colors shrink-0 rounded ${FOCUS_RING}`}
                onClick={() => removePrefixBinding(key)}
                title={t('settings.kb.delete')}
                aria-label={t('settings.kb.delete')}
              >
                <Icon size={12}><line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" /></Icon>
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add prefix binding */}
      <button
        className={`mt-1 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${FOCUS_RING}`}
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
                className={`text-[10px] font-mono tabular-nums px-2 py-0.5 rounded shrink-0 ${FOCUS_RING}`}
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
                className={`inline-flex items-center text-[color:var(--text-subtle)] hover:text-[color:var(--accent-red)] transition-colors shrink-0 rounded ${FOCUS_RING}`}
                onClick={() => removeKeybinding(kb.id)}
                title={t('settings.kb.delete')}
                aria-label={t('settings.kb.delete')}
              >
                <Icon size={12}><line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" /></Icon>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add button */}
      <button
        className={`mt-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${FOCUS_RING}`}
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
          <StatusBadge ok={claudeFound} okLabel="detected" failLabel="not detected" />
          <span className="text-sm text-[color:var(--text-main)] font-mono">{claudeStatusText}</span>
        </div>

        <div
          className="px-3 py-2 rounded-lg flex items-center gap-2"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
          data-testid="first-run-setup-mcp-row"
        >
          <StatusBadge ok={mcpRegistered} okLabel="registered" failLabel="not registered" />
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
        <Button
          variant="accent"
          onClick={onOpenWizard}
          data-testid="first-run-setup-open-wizard"
        >
          {t('settings.firstRunSetup.openWizard')}
        </Button>
        <Button
          variant="secondary"
          onClick={onShowCheatSheet}
          data-testid="first-run-setup-show-cheat-sheet"
        >
          {t('settings.firstRunSetup.showCheatSheet')}
        </Button>
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
      {/* Product header — left-aligned, name + version inline (no centered hero) */}
      <Card className="flex items-center gap-3 px-4 py-3.5">
        <span
          className="grid place-items-center rounded-md shrink-0"
          style={{ width: 40, height: 40, backgroundColor: 'var(--bg-surface)', color: 'var(--accent-blue)' }}
        >
          <Icon size={22}><path d="M7 1.5 L8 6 L12.5 7 L8 8 L7 12.5 L6 8 L1.5 7 L6 6 Z" /></Icon>
        </span>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold font-mono tracking-wide text-[color:var(--text-main)]">wmux</span>
            <span className="text-[11px] font-mono tabular-nums text-[color:var(--accent-blue)]">v{__APP_VERSION__}</span>
          </div>
          <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5 truncate">
            {t('settings.aboutTagline')}
          </p>
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <SectionLabel label={t('settings.builtWith')} />
        <Card className="px-3 py-2.5 flex flex-col gap-1.5">
          {[
            'Electron 41',
            'React 19 + TypeScript 5.9',
            'xterm.js 6 + node-pty',
            'Vite 5 + Tailwind CSS 3',
            'Zustand 5 + Immer',
          ].map((item) => (
            <div key={item} className="flex items-center gap-2">
              <span className="shrink-0 rounded-full" style={{ width: 4, height: 4, backgroundColor: 'var(--text-muted)' }} />
              <span className="text-[12px] text-[color:var(--text-sub)] font-mono">{item}</span>
            </div>
          ))}
        </Card>
      </div>

      <div>
        <SectionLabel label={t('settings.links')} />
        <a
          href="https://github.com/openwong2kim/wmux"
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-[color:var(--accent-blue)] hover:text-[color:var(--text-main)] transition-colors ${FOCUS_RING}`}
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          <IconExternalLink />
          <span>{t('settings.githubRepo')}</span>
        </a>
      </div>
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
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg px-4 py-3 shadow-2xl"
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

export default function SettingsPanel() {
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

  const [activeTab, setActiveTab] = useState<TabId>('general');
  const panelRef = useRef<HTMLDivElement>(null);

  // When a target arrives while collapsed, surface the editor on the Appearance
  // tab so the auto-opened TokenRow / xterm slot is actually on screen.
  useEffect(() => {
    if (hasTarget && !dismissedTarget) setActiveTab('appearance');
  }, [hasTarget, dismissedTarget]);

  const tabs: { id: TabId; label: string; icon: ReactNode }[] = [
    { id: 'general',            label: t('settings.tabGeneral'),         icon: <IconGeneral /> },
    { id: 'appearance',         label: t('settings.tabAppearance'),      icon: <IconAppearance /> },
    { id: 'notifications',      label: t('settings.tabNotifications'),   icon: <IconNotifications /> },
    { id: 'shortcuts',          label: t('settings.tabShortcuts'),       icon: <IconShortcuts /> },
    { id: 'claude-integration', label: t('claudeIntegration.tab'),       icon: <IconClaude /> },
    { id: 'first-run-setup',    label: t('settings.firstRunSetup'),      icon: <IconFirstRun /> },
    { id: 'about',              label: t('settings.tabAbout'),           icon: <IconAbout /> },
  ];

  // Close on Escape (D-esc). While inspect is active the overlay owns ESC
  // (ESC → exitInspect, leaving Settings mounted), so this handler MUST NOT
  // close Settings — it no-ops. When inspect is NOT active, ESC closes Settings
  // exactly as before (mandatory regression: the non-inspect path is unchanged).
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // suppressed while inspect active — overlay handles ESC (D-esc).
        if (!shouldEscCloseSettings(inspectModeActive)) return;
        e.stopPropagation();
        setVisible(false);
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [visible, setVisible, inspectModeActive]);

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
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
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
            className={`inline-flex items-center rounded p-0.5 text-[color:var(--text-subtle)] hover:text-[color:var(--text-main)] transition-colors ${FOCUS_RING}`}
            onClick={handleClose}
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
                  aria-current={isActive ? 'page' : undefined}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors text-[12px] ${!isActive ? 'hover:bg-[color:var(--bg-surface)]' : ''} ${FOCUS_RING}`}
                  style={{
                    backgroundColor: isActive ? 'var(--bg-surface)' : 'transparent',
                    color: isActive ? 'var(--text-main)' : 'var(--text-subtle)',
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  <span className="inline-flex items-center leading-none shrink-0" style={{ color: isActive ? 'var(--accent-blue)' : 'var(--text-muted)' }}>
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
            className={`text-xs px-2 py-1 rounded text-[color:var(--text-subtle)] hover:text-[color:var(--text-main)] transition-colors ${FOCUS_RING}`}
            onClick={handleClose}
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
