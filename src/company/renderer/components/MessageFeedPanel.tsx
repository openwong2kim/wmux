import { useStore } from '../../../renderer/stores';
import type { MessageFeedEntry } from '../store';

const TAG_COLORS: Record<string, string> = {
  directive: 'var(--accent-blue)',
  report: 'var(--accent-green)',
  approval: 'var(--accent-yellow)',
  blocked: 'var(--accent-red)',
  broadcast: 'var(--accent-cursor)',
  message: 'var(--text-sub)',
};

function FeedEntry({ entry }: { entry: MessageFeedEntry }) {
  const color = TAG_COLORS[entry.tag] || TAG_COLORS.message;
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div
      className="flex gap-2 px-3 py-1.5 transition-colors"
      style={{ borderBottom: '1px solid var(--bg-surface)' }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(var(--bg-surface-rgb), 0.3)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
    >
      <span className="text-[9px] font-mono flex-shrink-0 w-14 text-right" style={{ color: 'var(--text-muted)' }}>
        {time}
      </span>
      <span
        className="text-[8px] font-mono px-1 py-0.5 rounded flex-shrink-0 uppercase"
        style={{ color, border: `1px solid ${color}`, opacity: 0.8 }}
      >
        {entry.tag}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-[10px] font-mono">
          <span style={{ color: 'var(--accent-blue)' }}>{entry.from}</span>
          <span style={{ color: 'var(--text-muted)' }}> → </span>
          <span style={{ color: 'var(--accent-green)' }}>{entry.to}</span>
        </span>
        <div className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'var(--text-sub)' }}>
          {entry.message}
        </div>
      </div>
    </div>
  );
}

export default function MessageFeedPanel() {
  const visible = useStore((s) => s.messageFeedVisible);
  const messageFeed = useStore((s) => s.messageFeed);
  const clearFeed = useStore((s) => s.clearFeed);
  const setMessageFeedVisible = useStore((s) => s.setMessageFeedVisible);

  if (!visible) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[900] flex flex-col"
      style={{ height: 240, backgroundColor: 'var(--bg-mantle)', borderTop: '1px solid var(--bg-surface)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--bg-surface)' }}
      >
        <span className="text-[11px] font-mono font-bold" style={{ color: 'var(--text-main)' }}>
          Message Feed ({messageFeed.length})
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={clearFeed}
            className="text-[10px] font-mono transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            Clear
          </button>
          <button
            onClick={() => setMessageFeedVisible(false)}
            className="text-[10px] font-mono transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-main)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            {'\u2715'}
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {messageFeed.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
            No messages yet
          </div>
        ) : (
          [...messageFeed].reverse().map((entry) => (
            <FeedEntry key={entry.id} entry={entry} />
          ))
        )}
      </div>
    </div>
  );
}
