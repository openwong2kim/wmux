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

/**
 * Cap on the device name.
 *
 * The popover is a fixed 288px box, so an unbounded name is a layout bug, and
 * the roster reads better with labels a human scans than with sentences.
 */
export const DEVICE_NAME_MAX = 32;

type WebApi = NonNullable<Window['electronAPI']['web']>;

function webApi(): WebApi | undefined {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.web;
}

// ─── Pure helpers (unit-tested without a DOM) ──────────────────────────────

/** The first URL to surface (selectable/copyable). Empty string when none. */
export function primaryWebUrl(info: WebTerminalInfo): string {
  return info.urls && info.urls.length > 0 ? info.urls[0] : '';
}

/**
 * Split a transport-error line into text and the one URL it may contain.
 *
 * `describeTailscaleProblem` writes for a terminal, where an operator can
 * select a URL and paste it. In a popover that is a dead end: the whole point
 * of the line is "go install this", and making the reader retype
 * `https://tailscale.com/download` by hand is the worst possible last step.
 *
 * Deliberately narrow — first URL only, no markdown, no rich text. The strings
 * are ours, not user input, and a general linkifier here would be a parser
 * nobody asked for.
 */
export function splitLinkedLine(line: string): { before: string; url: string; after: string } {
  const m = /https?:\/\/[^\s,)]+/.exec(line);
  if (!m) return { before: line, url: '', after: '' };
  return {
    before: line.slice(0, m.index),
    url: m[0],
    after: line.slice(m.index + m[0].length),
  };
}

/** `host:port` bind label, tolerant of a partial info. */
export function webBindLabel(info: WebTerminalInfo): string {
  if (!info.host && !info.port) return '';
  return `${info.host ?? ''}:${info.port ?? ''}`;
}

/**
 * The address to type on the phone: origin + `/pair`, with NO token in it —
 * that is the whole point of the pairing code (a 6-char code instead of a
 * 36-char UUID). When exposed we prefer a reachable LAN/tailnet address over
 * loopback, because 127.0.0.1 means nothing on another device.
 */
export function webPairUrl(info: WebTerminalInfo): string {
  const urls = info.urls ?? [];
  if (urls.length === 0) return '';
  const reachable = urls.find((u) => !/\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u));
  const chosen = reachable ?? urls[0];
  try {
    return `${new URL(chosen).origin}/pair`;
  } catch {
    return '';
  }
}

// ─── Presentational popover body (renderToStaticMarkup-testable) ───────────

export interface WebPopoverBodyProps {
  info: WebTerminalInfo;
  allowInput: boolean;
  expose: boolean;
  /** Put the server behind a `tailscale serve` HTTPS front. */
  tailscale: boolean;
  /** What the next paired device will be called. Required before a code shows. */
  deviceName: string;
  busy: boolean;
  /** Which value was just copied, so only that button flips to "Copied". */
  copied: CopyTarget;
  onToggleAllowInput: () => void;
  onToggleExpose: () => void;
  onToggleTailscale: () => void;
  onStart: () => void;
  onStop: () => void;
  onCopyUrl: () => void;
  onCopyPairUrl: () => void;
  onCopyPairCode: () => void;
  onOpenUrl: () => void;
  /** Open an external link (install page) in the OS browser. */
  onOpenLink: (url: string) => void;
  onNewPairCode: () => void;
  onDeviceNameChange: (value: string) => void;
  /** Name the device, then mint its code (`daemon.web.pairStart`). */
  onStartPairing: () => void;
  t: (key: string) => string;
}

/** Nothing copied, or the field whose copy button should read "Copied". */
export type CopyTarget = null | 'url' | 'pairUrl' | 'pairCode';

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
  tailscale,
  busy,
  copied,
  onToggleAllowInput,
  onToggleExpose,
  onToggleTailscale,
  onStart,
  onStop,
  onCopyUrl,
  onCopyPairUrl,
  onCopyPairCode,
  onOpenUrl,
  onOpenLink,
  onNewPairCode,
  onDeviceNameChange,
  onStartPairing,
  deviceName,
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
        {/* The only transport a phone can actually pair over. Listed FIRST
            because it is the one most operators opening this popover want:
            a device credential never expires, so it is not handed out over
            plaintext, which rules the LAN option out for pairing entirely. */}
        <label className="flex items-center gap-2 text-[11px] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={tailscale}
            onChange={onToggleTailscale}
            className="accent-[var(--accent)]"
          />
          {t('web.tailscale')}
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
        {/* Say what --expose actually buys now. Since #616 it can serve panes
            to the LAN but cannot pair a phone, and a checkbox that silently
            means "watch only" is how someone ends up stuck at a 403. */}
        {expose ? (
          <p className="text-[10px] leading-snug text-[var(--text-sub)]">
            {t('web.exposeNoPairing')}
          </p>
        ) : null}
        {info.transportError ? (
          <div className="flex flex-col gap-1 rounded-[5px] bg-[var(--bg-surface)] px-2 py-1.5">
            {info.transportError.lines.map((line, i) => {
              const { before, url, after } = splitLinkedLine(line);
              return (
                <span key={i} className="text-[10px] leading-snug text-[var(--text-sub)]">
                  {before}
                  {url ? (
                    <button
                      type="button"
                      onClick={() => onOpenLink(url)}
                      className={`text-[var(--accent-blue)] hover:underline ${FOCUS_RING}`}
                    >
                      {url}
                    </button>
                  ) : null}
                  {after}
                </span>
              );
            })}
          </div>
        ) : null}
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
  const pairUrl = webPairUrl(info);
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

      {/* Path 1 — this machine. The URL carries the token, so it just works;
          clicking opens it in the default browser rather than being dead text. */}
      {url ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            {t('web.openHere')}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenUrl}
              title={url}
              className={`flex-1 min-w-0 truncate text-left font-mono text-[11px] text-[var(--accent-blue)] hover:underline ${FOCUS_RING}`}
            >
              {url}
            </button>
            <button
              type="button"
              onClick={onCopyUrl}
              className={`shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            >
              {copied === 'url' ? t('web.copied') : t('web.copy')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Path 2 — another device. This is what the pairing code exists for:
          typing a 36-char token on a phone keyboard is miserable, so the phone
          opens a token-free /pair address and enters six characters instead. */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {t('web.onPhone')}
        </span>
        {info.pairRefusal ? (
          // The whole point of the refusal: this replaces the code rather than
          // sitting beside it. A code shown next to "pairing is unavailable" is
          // still a code someone will try to type into a phone.
          <>
            <span className="text-[10px] leading-snug text-[var(--text-sub)]">
              {info.pairRefusal.reason === 'no-front'
                ? t('web.refusalNoFront')
                : t('web.refusalInsecure')}
            </span>
            <span
              title={info.pairRefusal.detail}
              className="text-[10px] leading-snug text-[var(--text-muted)]"
            >
              {info.pairRefusal.reason === 'no-front'
                ? t('web.refusalNoFrontFix')
                : t('web.refusalInsecureFix')}
            </span>
          </>
        ) : info.pairCode && info.pendingDeviceName ? (
          <>
          {/* Which device this code will register. The operator typed it a
              moment ago, but the code outlives that moment by ten minutes and
              a mis-labelled roster is only discovered when someone needs to
              revoke one entry out of eight. */}
          <span className="text-[10px] leading-snug text-[var(--text-sub)]">
            {t('web.pairingAs').replace('{name}', info.pendingDeviceName ?? '')}
          </span>
          <span className="text-[10px] leading-snug text-[var(--text-sub)]">
            {t('web.pairHint')}
          </span>
          {pairUrl ? (
            <div className="flex items-center gap-1.5">
              <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-[var(--text-sub)] select-all">
                {pairUrl}
              </span>
              <button
                type="button"
                onClick={onCopyPairUrl}
                className={`shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
              >
                {copied === 'pairUrl' ? t('web.copied') : t('web.copy')}
              </button>
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="flex-1 font-mono text-[22px] font-bold tracking-widest text-[var(--text-main)] select-all">
              {info.pairCode}
            </span>
            <button
              type="button"
              onClick={onCopyPairCode}
              className={`shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] bg-[var(--bg-surface)] transition-colors ${FOCUS_RING}`}
            >
              {copied === 'pairCode' ? t('web.copied') : t('web.copy')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-sub)]">{t('web.pairValidity')}</span>
            {/* Still reachable while a code is live: the operator may believe
                this one was seen. It re-mints under the SAME name, so replacing
                a code never silently costs the device its label. */}
            <button
              type="button"
              onClick={onNewPairCode}
              disabled={busy}
              className={`ml-auto shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] text-[var(--text-sub)] hover:text-[var(--text-main)] bg-[var(--bg-surface)] disabled:opacity-40 transition-colors ${FOCUS_RING}`}
            >
              {t('web.newPairCode')}
            </button>
          </div>
          </>
        ) : (
          // Name first, code second. A code exists from the moment the server
          // starts, but redeeming an unnamed one produces the "Unnamed device"
          // rows that make a roster unoperable — the live roster on this
          // machine is 5 of 8. The name is taken HERE, on the desktop, because
          // this is the only moment a human is present to give one; the phone
          // still types nothing but the code.
          <>
            <span className="text-[10px] leading-snug text-[var(--text-sub)]">
              {t('web.nameHint')}
            </span>
            <input
              type="text"
              value={deviceName}
              onChange={(e) => onDeviceNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && deviceName.trim() && !busy) onStartPairing();
              }}
              placeholder={t('web.namePlaceholder')}
              maxLength={DEVICE_NAME_MAX}
              aria-label={t('web.nameHint')}
              className={`w-full rounded-[6px] bg-[var(--bg-base)] px-2 py-1 text-[11px] text-[var(--text-main)] placeholder:text-[var(--text-muted)] ${FOCUS_RING}`}
            />
            <button
              type="button"
              onClick={onStartPairing}
              disabled={busy || deviceName.trim().length === 0}
              className={`self-start rounded-[5px] px-2 py-1 text-[10px] text-[var(--text-main)] bg-[var(--bg-surface)] hover:bg-[var(--bg-overlay)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${FOCUS_RING}`}
            >
              {t('web.showPairCode')}
            </button>
            {/* A refused mint used to leave this panel looking untouched: no
                code appeared and nothing said why. The button guards the empty
                name, so what lands here is the server refusing for its own
                reason, which the operator cannot guess. */}
            {info.pairStartError ? (
              <span className="text-[10px] leading-snug text-[var(--accent-red)]">
                {info.pairStartError}
              </span>
            ) : null}
          </>
        )}
      </div>

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
  const [tailscale, setTailscale] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [anchorLeft, setAnchorLeft] = useState(8);
  // Sidebar rows sit at the bottom of a tall column, so the popover has to open
  // upward from the button instead of hanging off the titlebar.
  const [anchorBottom, setAnchorBottom] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const api = webApi();

  /**
   * `verifyFront` asks the main process to shell out to tailscale. Pass it only
   * on deliberate moments — never from the 10s poll, which would spawn a
   * process six times a minute for a fact that changes when a human acts.
   */
  const refresh = useCallback(async (verifyFront = false) => {
    const a = webApi();
    if (!a) return;
    try {
      const next = await a.status(verifyFront ? { verifyFront: true } : undefined);
      setInfo(next);
      // Seed the transport checkbox from what is actually running, so a daemon
      // restart cannot leave the box unchecked over a tailnet server — the
      // operator's next Stop → Start would silently drop them onto loopback.
      if (next.running) setTailscale(next.tailscale === true);
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

  // Poll every 10s while the popover is open. The refresh ON OPEN verifies the
  // tailnet front (a deliberate act by the operator); the polls after it do not.
  useEffect(() => {
    if (!open) return;
    void refresh(true);
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
    // Measure + anchor OUTSIDE the setOpen updater: state updaters must stay
    // pure (React may invoke them twice in StrictMode), and these are DOM
    // reads plus sibling setState calls.
    if (!open) {
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
    setOpen(!open);
  }, [open, variant]);

  const handleStart = useCallback(async () => {
    const a = webApi();
    if (!a) return;
    setBusy(true);
    try {
      const args: WebStartArgs = { allowInput, expose, tailscale };
      const next = await a.start(args);
      setInfo(next);
    } finally {
      setBusy(false);
    }
  }, [allowInput, expose, tailscale]);

  // The two transports are alternatives, not additions: `tailscale serve`
  // proxies loopback, so a wildcard bind alongside it is a second, weaker way
  // in. Enforced here as well as main-side so the checkboxes never show a
  // combination the handler would silently rewrite.
  const handleToggleTailscale = useCallback(() => {
    setTailscale((v) => {
      if (!v) setExpose(false);
      return !v;
    });
  }, []);

  const handleToggleExpose = useCallback(() => {
    setExpose((v) => {
      if (!v) setTailscale(false);
      return !v;
    });
  }, []);

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

  const copyValue = useCallback(async (target: Exclude<CopyTarget, null>, value: string) => {
    if (!value) return;
    try {
      await window.clipboardAPI?.writeText(value);
      setCopied(target);
      setTimeout(() => setCopied((c) => (c === target ? null : c)), 1500);
    } catch {
      /* clipboard lock/size error — every value stays select-all for manual copy */
    }
  }, []);

  const handleCopyUrl = useCallback(
    () => copyValue('url', primaryWebUrl(info)),
    [copyValue, info],
  );
  const handleCopyPairUrl = useCallback(
    () => copyValue('pairUrl', webPairUrl(info)),
    [copyValue, info],
  );
  const handleCopyPairCode = useCallback(
    () => copyValue('pairCode', info.pairCode ?? ''),
    [copyValue, info],
  );

  /**
   * "New code" now goes through pairStart too, carrying the name the operator
   * already gave. Routing it through the nameless pairRefresh would quietly
   * register the NEXT device unnamed — the same hole the name field closes.
   */
  const handleNewPairCode = useCallback(async () => {
    const a = webApi();
    if (!a) return;
    const name = (info.pendingDeviceName ?? deviceName).trim();
    setBusy(true);
    try {
      if (name && a.pairStart) setInfo(await a.pairStart(name));
      else if (a.pairRefresh) setInfo(await a.pairRefresh());
    } finally {
      setBusy(false);
    }
  }, [deviceName, info.pendingDeviceName]);

  /**
   * Send an install link to the OS browser.
   *
   * Never navigates this window: the renderer is the app, and a navigation
   * away from it is a broken app rather than a browser tab. `http(s)` only —
   * the strings are ours today, but a URL scheme is exactly the kind of thing
   * that stops being trustworthy the moment someone widens the source.
   */
  const handleOpenLink = useCallback((url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    void window.electronAPI?.shell?.openExternal?.(url);
  }, []);

  const handleStartPairing = useCallback(async () => {
    const a = webApi();
    const name = deviceName.trim();
    if (!a?.pairStart || !name) return;
    setBusy(true);
    try {
      setInfo(await a.pairStart(name));
    } finally {
      setBusy(false);
    }
  }, [deviceName]);

  // The URL is the one value that is directly actionable on this machine, so
  // clicking it opens the browser instead of leaving the operator to copy and
  // paste. Falls back to a copy when no shell bridge exists.
  const handleOpenUrl = useCallback(() => {
    const url = primaryWebUrl(info);
    if (!url) return;
    const shell = window.electronAPI?.shell;
    if (shell?.openExternal) void shell.openExternal(url);
    else void copyValue('url', url);
  }, [copyValue, info]);

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
            tailscale={tailscale}
            busy={busy}
            copied={copied}
            onToggleAllowInput={() => setAllowInput((v) => !v)}
            onToggleExpose={handleToggleExpose}
            onToggleTailscale={handleToggleTailscale}
            onStart={handleStart}
            onStop={handleStop}
            onCopyUrl={handleCopyUrl}
            onCopyPairUrl={handleCopyPairUrl}
            onCopyPairCode={handleCopyPairCode}
            onOpenUrl={handleOpenUrl}
            onOpenLink={handleOpenLink}
            onNewPairCode={handleNewPairCode}
            deviceName={deviceName}
            onDeviceNameChange={(v) => setDeviceName(v.slice(0, DEVICE_NAME_MAX))}
            onStartPairing={handleStartPairing}
            t={t}
          />
        </div>
      ) : null}
    </div>
  );
}
