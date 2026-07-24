import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconBrowser } from '../icons';
import {
  webIsExposed,
  type WebStartArgs,
  type WebTerminalInfo,
} from '../../../shared/web';

/**
 * wmux web — titlebar status-strip toggle (DESIGN.md: chips render only when
 * meaningful; amber = alive + the single primary action per surface).
 *
 * At rest the control is quiet muted text ("web"). When the daemon-hosted
 * browser terminal is running it grows an amber dot (alive state). Clicking
 * opens a single floating-shadow popover (7px radius) that starts/stops the
 * server and surfaces the pairing code + URL.
 *
 * State (the last WebTerminalInfo) lives in this persistently-mounted component,
 * so it survives popover close/reopen. We never trust a cached value blindly:
 * the popover re-reads status on open and polls every 10s while open, and a
 * one-shot mount fetch keeps the resting dot correct without continuous polling.
 */

/** Poll cadence while the popover is open (owner spec). */
const POLL_INTERVAL_MS = 10_000;

type WebApi = NonNullable<Window['electronAPI']['web']>;

function webApi(): WebApi | undefined {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.web;
}

// ─── Pure helpers (unit-tested without a DOM) ──────────────────────────────

/** The first URL to surface (selectable/copyable). Empty string when none. */
export function primaryWebUrl(info: WebTerminalInfo): string {
  return info.urls && info.urls.length > 0 ? info.urls[0] : '';
}

/** `host:port` bind label, tolerant of a partial info. */
export function webBindLabel(info: WebTerminalInfo): string {
  if (!info.host && !info.port) return '';
  return `${info.host ?? ''}:${info.port ?? ''}`;
}

// ─── Presentational popover body (renderToStaticMarkup-testable) ───────────

export interface WebPopoverBodyProps {
  info: WebTerminalInfo;
  allowInput: boolean;
  expose: boolean;
  busy: boolean;
  copied: boolean;
  onToggleAllowInput: () => void;
  onToggleExpose: () => void;
  onStart: () => void;
  onStop: () => void;
  onCopyUrl: () => void;
  t: (key: string) => string;
}

/**
 * The popover contents. Split from WebToggle so the node-env test suite can
 * assert the off/on markup via renderToStaticMarkup (effects don't run here —
 * the parent drives all state through props). Mirrors the StatusBar.test.tsx
 * presentational-view pattern.
 */
export function WebPopoverBody({
  info,
  allowInput,
  expose,
  busy,
  copied,
  onToggleAllowInput,
  onToggleExpose,
  onStart,
  onStop,
  onCopyUrl,
  t,
}: WebPopoverBodyProps) {
  if (!info.running) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="text-[12px] font-semibold text-[var(--text-main)]">
          {t('web.headline')}
        </div>
        {info.error ? (
          <div className="text-[11px] text-[var(--text-sub)] leading-snug">
            {t('web.daemonOffline')}
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-[11px] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={allowInput}
            onChange={onToggleAllowInput}
            className="accent-[var(--accent)]"
          />
          {t('web.allowInput')}
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={expose}
            onChange={onToggleExpose}
            className="accent-[var(--accent)]"
          />
          {t('web.expose')}
        </label>
        <p className="text-[10px] leading-snug text-[var(--text-sub)]">
          {t('web.scrollbackWarning')}
        </p>
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className={`w-full rounded-[5px] px-3 py-1.5 text-[11px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] disabled:opacity-40 disabled:cursor-not-allowed transition-opacity ${FOCUS_RING}`}
        >
          {busy ? t('web.starting') : t('web.start')}
        </button>
      </div>
    );
  }

  const url = primaryWebUrl(info);
  const exposed = webIsExposed(info);
  const viewers =
    typeof info.clients === 'number'
      ? t('web.viewers').replace('{count}', String(info.clients))
      : '';

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-main)]">
        <span
          aria-hidden="true"
          className="w-[6px] h-[6px] rounded-full bg-[var(--accent)]"
        />
        <span className="font-mono">{webBindLabel(info)}</span>
        {viewers ? <span className="text-[var(--text-sub)]">· {viewers}</span> : null}
      </div>

      {url ? (
        <div className="flex items-center gap-1.5">
          <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-[var(--text-sub)] select-all">
            {url}
          </span>
          <button
            type="button"
            onClick={onCopyUrl}
            className={`shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
          >
            {copied ? t('web.copied') : t('web.copyUrl')}
          </button>
        </div>
      ) : null}

      {info.pairCode ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-[var(--text-sub)]">{t('web.pairCode')}</span>
          <span className="font-mono text-[22px] font-bold tracking-widest text-[var(--text-main)] select-all">
            {info.pairCode}
          </span>
          <span className="text-[10px] text-[var(--text-sub)]">{t('web.pairValidity')}</span>
        </div>
      ) : null}

      <div className="text-[11px]">
        {info.allowInput ? (
          <span className="font-semibold text-[var(--accent)]">{t('web.inputEnabled')}</span>
        ) : (
          <span className="text-[var(--text-sub)]">{t('web.readOnly')}</span>
        )}
      </div>

      {exposed ? (
        <p className="text-[10px] leading-snug text-[var(--text-sub)]">{t('web.exposeWarning')}</p>
      ) : null}

      <button
        type="button"
        onClick={onStop}
        disabled={busy}
        className={`w-full rounded-[5px] px-3 py-1.5 text-[11px] font-semibold bg-[var(--bg-surface)] text-[var(--text-main)] hover:bg-[var(--bg-overlay)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${FOCUS_RING}`}
      >
        {busy ? t('web.stopping') : t('web.stop')}
      </button>
    </div>
  );
}

// ─── The mounted toggle ────────────────────────────────────────────────────

/**
 * `statusbar` — the compact instrument-strip chip (quiet text + amber dot).
 * `sidebar`  — a full-width labeled row matching the Agent / Git entries at the
 *              foot of the workspace list, with the popover opening upward.
 */
export type WebToggleVariant = 'statusbar' | 'sidebar';

export default function WebToggle({ variant = 'statusbar' }: { variant?: WebToggleVariant } = {}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<WebTerminalInfo>({ running: false });
  const [allowInput, setAllowInput] = useState(false);
  const [expose, setExpose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [anchorLeft, setAnchorLeft] = useState(8);
  // Sidebar rows sit at the bottom of a tall column, so the popover has to open
  // upward from the button instead of hanging off the titlebar.
  const [anchorBottom, setAnchorBottom] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const api = webApi();

  const refresh = useCallback(async () => {
    const a = webApi();
    if (!a) return;
    try {
      const next = await a.status();
      setInfo(next);
    } catch {
      // Handler resolves rather than rejects; a rejection here means the bridge
      // is missing entirely — leave the last known state untouched.
    }
  }, []);

  // One mount-time fetch keeps the resting amber dot correct without a
  // continuous poll (the popover-open poll below covers live updates).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll every 10s while the popover is open; also refresh immediately on open.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  // Outside-click + ESC close (mirrors PresetPicker).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      if (!v) {
        // Seed the checkboxes from the live state so reopening while running
        // reflects the actual mode, and anchor the popover under the button.
        const r = btnRef.current?.getBoundingClientRect();
        const menuWidth = 288; // w-72
        if (r) {
          if (variant === 'sidebar') {
            // Fly out beside the row, bottom-aligned with it: opening upward
            // would cover the sibling Agent / Git rows. Prefer the side facing
            // the content area, and fall back if it would overflow.
            const toRight = r.right + 6 + menuWidth <= window.innerWidth - 8;
            setAnchorLeft(
              toRight
                ? r.right + 6
                : Math.max(8, r.left - 6 - menuWidth),
            );
            setAnchorBottom(Math.max(8, window.innerHeight - r.bottom));
          } else {
            setAnchorLeft(Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8)));
            setAnchorBottom(null);
          }
        }
      }
      return !v;
    });
  }, [variant]);

  const handleStart = useCallback(async () => {
    const a = webApi();
    if (!a) return;
    setBusy(true);
    try {
      const args: WebStartArgs = { allowInput, expose };
      const next = await a.start(args);
      setInfo(next);
    } finally {
      setBusy(false);
    }
  }, [allowInput, expose]);

  const handleStop = useCallback(async () => {
    const a = webApi();
    if (!a) return;
    setBusy(true);
    try {
      const next = await a.stop();
      setInfo(next);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleCopyUrl = useCallback(async () => {
    const url = primaryWebUrl(info);
    if (!url) return;
    try {
      await window.clipboardAPI?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard lock/size error — the URL stays selectable for manual copy */
    }
  }, [info]);

  // The web bridge is absent entirely (e.g. under a stripped test harness) —
  // render nothing rather than a dead control.
  if (!api) return null;

  const running = info.running === true;

  const isSidebar = variant === 'sidebar';

  // Sidebar row: same geometry and type as the Agent / Git entries above it.
  // Colour follows the Git precedent — steel while the popover is open
  // (navigation), amber while the server is running (alive), muted at rest.
  const sidebarClass = `flex items-center gap-2 shrink-0 h-9 px-4 border-t border-[var(--bg-surface)] text-[11px] font-mono transition-colors ${FOCUS_RING} ${
    open
      ? 'text-[var(--accent-blue)]'
      : running
        ? 'text-[var(--accent)] hover:opacity-80'
        : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)]'
  }`;

  const statusbarClass = `flex items-center gap-1.5 transition-colors ${
    running
      ? 'text-[var(--text-sub)] hover:text-[var(--text-main)]'
      : 'text-[var(--text-muted)] hover:text-[var(--text-sub)]'
  }`;

  return (
    <div className={isSidebar ? 'contents' : 'relative flex items-center'}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-pressed={isSidebar ? running : undefined}
        title={t('web.tooltip')}
        data-testid={isSidebar ? 'sidebar-web-toggle' : 'statusbar-web-toggle'}
        data-sidebar-web={isSidebar ? '' : undefined}
        style={isSidebar ? ({ borderColor: 'var(--border-soft)' } as CSSProperties) : undefined}
        className={isSidebar ? sidebarClass : statusbarClass}
      >
        {isSidebar ? (
          <IconBrowser size={14} />
        ) : running ? (
          <span aria-hidden="true" className="w-[6px] h-[6px] rounded-full bg-[var(--accent)]" />
        ) : null}
        <span>{t('web.label')}</span>
        {isSidebar && running ? (
          <span
            aria-hidden="true"
            className="ml-auto w-[6px] h-[6px] rounded-full bg-[var(--accent)]"
          />
        ) : null}
      </button>

      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-label={t('web.headline')}
          style={(anchorBottom !== null
            ? { left: anchorLeft, bottom: anchorBottom }
            : { left: anchorLeft, top: 40 }) as CSSProperties}
          className="fixed z-50 w-72 rounded-[7px] border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl font-sans"
        >
          <WebPopoverBody
            info={info}
            allowInput={allowInput}
            expose={expose}
            busy={busy}
            copied={copied}
            onToggleAllowInput={() => setAllowInput((v) => !v)}
            onToggleExpose={() => setExpose((v) => !v)}
            onStart={handleStart}
            onStop={handleStop}
            onCopyUrl={handleCopyUrl}
            t={t}
          />
        </div>
      ) : null}
    </div>
  );
}
