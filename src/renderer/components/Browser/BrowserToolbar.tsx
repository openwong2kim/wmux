import { useRef, useState, useCallback, useEffect } from 'react';
import { useT } from '../../hooks/useT';

// ---------------------------------------------------------------------------
// URL safety check — only allow http: and https: schemes
// ---------------------------------------------------------------------------

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SVG Icon components
// ---------------------------------------------------------------------------

function IconBack() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="9,2 4,7 9,12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconForward() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="5,2 10,7 5,12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 7A5 5 0 1 1 7 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <polyline points="7,0.5 9.5,2.5 7,4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconDevTools() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1" y1="4.5" x2="13" y2="4.5" stroke="currentColor" strokeWidth="1.2" />
      <polyline points="3.5,7 5.5,9 3.5,11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="7" y1="11" x2="10.5" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconInspect() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3" />
      <line x1="9" y1="9" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="4.5" width="8" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.5 4.5V3a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// BrowserToolbar props
// ---------------------------------------------------------------------------

interface BrowserToolbarProps {
  currentUrl: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isActive: boolean;
  inspecting: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onToggleInspect: () => void;
  onOpenDevTools: () => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BrowserToolbar({
  currentUrl,
  isLoading,
  canGoBack,
  canGoForward,
  isActive,
  inspecting,
  onNavigate,
  onBack,
  onForward,
  onRefresh,
  onToggleInspect,
  onOpenDevTools,
  onClose,
}: BrowserToolbarProps) {
  const t = useT();
  const [inputValue, setInputValue] = useState(currentUrl);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync display URL when not focused
  useEffect(() => {
    if (!isFocused) {
      setInputValue(currentUrl);
    }
  }, [currentUrl, isFocused]);

  // Ctrl+L focuses the URL bar — only register when this browser panel is active
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const raw = inputValue.trim();
    if (!raw) return;
    // Normalize: add protocol if missing
    let url = raw;
    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      // If it looks like a domain, add https://; otherwise treat as search
      if (/^[\w-]+(\.[\w-]+)+([\/?#].*)?$/.test(url)) {
        url = `https://${url}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }
    if (!isSafeUrl(url)) return;
    setInputValue(url);
    onNavigate(url);
    inputRef.current?.blur();
  }, [inputValue, onNavigate]);

  const isSecure = currentUrl.startsWith('https://');

  const btnBase = 'flex items-center justify-center w-6 h-6 rounded transition-colors duration-100';
  const btnEnabled = `${btnBase} text-[var(--text-sub2)] hover:text-[var(--text-main)] hover:bg-[var(--bg-surface)] cursor-pointer`;
  const btnDisabled = `${btnBase} text-[var(--bg-overlay)] cursor-default`;

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1.5 shrink-0"
      style={{ backgroundColor: 'var(--bg-mantle)', borderBottom: '1px solid var(--bg-surface)' }}
    >
      {/* Back */}
      <button
        className={canGoBack ? btnEnabled : btnDisabled}
        onClick={canGoBack ? onBack : undefined}
        title={t('browser.back')}
        tabIndex={-1}
      >
        <IconBack />
      </button>

      {/* Forward */}
      <button
        className={canGoForward ? btnEnabled : btnDisabled}
        onClick={canGoForward ? onForward : undefined}
        title={t('browser.forward')}
        tabIndex={-1}
      >
        <IconForward />
      </button>

      {/* Refresh */}
      <button
        className={btnEnabled}
        onClick={onRefresh}
        title={t('browser.reload')}
        tabIndex={-1}
      >
        <span className={isLoading ? 'animate-spin' : ''}>
          <IconRefresh />
        </span>
      </button>

      {/* URL bar */}
      <form className="flex-1 min-w-0" onSubmit={handleSubmit}>
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md"
          style={{
            backgroundColor: isFocused ? 'var(--bg-base)' : '#11111b',
            border: `1px solid ${isFocused ? 'var(--accent-blue)' : 'var(--bg-surface)'}`,
            transition: 'border-color 0.15s',
          }}
        >
          {/* Lock icon */}
          <span className={isSecure ? 'text-[var(--accent-green)]' : 'text-[var(--text-muted)]'} style={{ flexShrink: 0 }}>
            <IconLock />
          </span>

          {/* Loading indicator */}
          {isLoading && (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] animate-pulse shrink-0" />
          )}

          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => {
              setIsFocused(true);
              inputRef.current?.select();
            }}
            onBlur={() => {
              setIsFocused(false);
              setInputValue(currentUrl);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setInputValue(currentUrl);
                inputRef.current?.blur();
              }
            }}
            className="flex-1 min-w-0 bg-transparent text-[var(--text-main)] text-xs outline-none"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </form>

      {/* Inspector */}
      <button
        className={inspecting
          ? `${btnBase} text-[var(--accent-blue)] bg-[var(--bg-surface)] cursor-pointer`
          : btnEnabled}
        onClick={onToggleInspect}
        title={inspecting ? 'Inspector OFF' : 'Inspector ON — click an element to copy its selector'}
        tabIndex={-1}
      >
        <IconInspect />
      </button>

      {/* DevTools */}
      <button
        className={btnEnabled}
        onClick={onOpenDevTools}
        title={t('browser.devToolsTooltip')}
        tabIndex={-1}
      >
        <IconDevTools />
      </button>

      {/* Close */}
      <button
        className={`${btnBase} text-[var(--text-sub2)] hover:text-[var(--accent-red)] hover:bg-[#3b1e1e] cursor-pointer`}
        onClick={onClose}
        title={t('browser.close')}
        tabIndex={-1}
      >
        <IconClose />
      </button>
    </div>
  );
}
