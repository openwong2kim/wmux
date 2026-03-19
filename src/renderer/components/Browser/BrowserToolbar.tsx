import { useRef, useState, useCallback, useEffect } from 'react';

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
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
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
  onNavigate,
  onBack,
  onForward,
  onRefresh,
  onOpenDevTools,
  onClose,
}: BrowserToolbarProps) {
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
    setInputValue(url);
    onNavigate(url);
    inputRef.current?.blur();
  }, [inputValue, onNavigate]);

  const isSecure = currentUrl.startsWith('https://');

  const btnBase = 'flex items-center justify-center w-6 h-6 rounded transition-colors duration-100';
  const btnEnabled = `${btnBase} text-[#a6adc8] hover:text-[#cdd6f4] hover:bg-[#313244] cursor-pointer`;
  const btnDisabled = `${btnBase} text-[#45475a] cursor-default`;

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1.5 shrink-0"
      style={{ backgroundColor: '#181825', borderBottom: '1px solid #313244' }}
    >
      {/* Back */}
      <button
        className={canGoBack ? btnEnabled : btnDisabled}
        onClick={canGoBack ? onBack : undefined}
        title="Back"
        tabIndex={-1}
      >
        <IconBack />
      </button>

      {/* Forward */}
      <button
        className={canGoForward ? btnEnabled : btnDisabled}
        onClick={canGoForward ? onForward : undefined}
        title="Forward"
        tabIndex={-1}
      >
        <IconForward />
      </button>

      {/* Refresh */}
      <button
        className={btnEnabled}
        onClick={onRefresh}
        title="Refresh"
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
            backgroundColor: isFocused ? '#1e1e2e' : '#11111b',
            border: `1px solid ${isFocused ? '#89b4fa' : '#313244'}`,
            transition: 'border-color 0.15s',
          }}
        >
          {/* Lock icon */}
          <span className={isSecure ? 'text-[#a6e3a1]' : 'text-[#585b70]'} style={{ flexShrink: 0 }}>
            <IconLock />
          </span>

          {/* Loading indicator */}
          {isLoading && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#89b4fa] animate-pulse shrink-0" />
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
            className="flex-1 min-w-0 bg-transparent text-[#cdd6f4] text-xs outline-none"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </form>

      {/* DevTools */}
      <button
        className={btnEnabled}
        onClick={onOpenDevTools}
        title="Open DevTools (F12)"
        tabIndex={-1}
      >
        <IconDevTools />
      </button>

      {/* Close */}
      <button
        className={`${btnBase} text-[#a6adc8] hover:text-[#f38ba8] hover:bg-[#3b1e1e] cursor-pointer`}
        onClick={onClose}
        title="Close browser"
        tabIndex={-1}
      >
        <IconClose />
      </button>
    </div>
  );
}
