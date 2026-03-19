import { useEffect, useRef, useState, useCallback } from 'react';

interface SearchBarProps {
  onFindNext: (text: string) => void;
  onFindPrevious: (text: string) => void;
  onClose: () => void;
}

export default function SearchBar({ onFindNext, onFindPrevious, onClose }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 마운트 시 입력 필드에 포커스
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ESC 키로 닫기
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onFindPrevious(query);
      } else {
        onFindNext(query);
      }
    }
  }, [query, onFindNext, onFindPrevious]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  return (
    <div
      className="absolute top-0 right-2 z-50 flex items-center gap-1 px-2 py-1.5 rounded-b-md shadow-lg"
      style={{
        background: '#313244',
        border: '1px solid #45475a',
        borderTop: 'none',
        minWidth: '280px',
      }}
      // 클릭이 Pane의 handleClick까지 버블링되지 않도록 차단
      onClick={(e) => e.stopPropagation()}
    >
      {/* 검색 아이콘 */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        className="shrink-0 text-[#6c7086]"
        style={{ color: '#6c7086' }}
      >
        <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>

      {/* 입력 필드 */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="검색..."
        className="flex-1 bg-transparent outline-none text-xs"
        style={{
          color: '#cdd6f4',
          caretColor: '#f5e0dc',
          minWidth: 0,
        }}
        spellCheck={false}
      />

      {/* 이전 버튼 (Shift+Enter) */}
      <button
        onClick={() => onFindPrevious(query)}
        title="이전 결과 (Shift+Enter)"
        className="flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-[#45475a] text-[#a6adc8] hover:text-[#cdd6f4] shrink-0"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M5 8L2 5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 8L5 5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 다음 버튼 (Enter) */}
      <button
        onClick={() => onFindNext(query)}
        title="다음 결과 (Enter)"
        className="flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-[#45475a] text-[#a6adc8] hover:text-[#cdd6f4] shrink-0"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 닫기 버튼 */}
      <button
        onClick={onClose}
        title="닫기 (ESC)"
        className="flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-[#45475a] text-[#6c7086] hover:text-[#f38ba8] shrink-0"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
