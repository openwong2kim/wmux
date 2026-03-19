import { useState, useRef, useEffect } from 'react';
import type { AgentStatus, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';

interface WorkspaceItemProps {
  workspace: Workspace;
  isActive: boolean;
  index: number;
  onSelect: () => void;
  onCtrlSelect: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

// Maps AgentStatus to a colored dot indicator character and Tailwind color class.
const AGENT_STATUS_ICON: Record<AgentStatus, { dot: string; className: string; label: string }> = {
  running:  { dot: '●', className: 'text-[#89b4fa]', label: 'Agent running' },
  complete: { dot: '●', className: 'text-[#a6e3a1]', label: 'Agent complete' },
  error:    { dot: '●', className: 'text-[#f38ba8]', label: 'Agent error' },
  waiting:  { dot: '●', className: 'text-[#f9e2af]', label: 'Agent waiting' },
  idle:     { dot: '●', className: 'text-[#585b70]', label: 'Agent idle' },
};

function AgentStatusDot({ status, agentName }: { status: AgentStatus; agentName?: string }): React.ReactElement {
  const icon = AGENT_STATUS_ICON[status];
  return (
    <span
      className={`text-[8px] leading-none flex-shrink-0 ${icon.className} ${status === 'running' ? 'animate-pulse' : ''}`}
      title={agentName ? `${agentName} — ${icon.label}` : icon.label}
    >
      {icon.dot}
    </span>
  );
}

function shortenPath(path: string, maxLen = 25): string {
  if (!path || path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join('/')}`;
}

export default function WorkspaceItem({ workspace, isActive, index, onSelect, onCtrlSelect, onRename, onClose, onReorder }: WorkspaceItemProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(workspace.name);
  const [isDragging, setIsDragging] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<'above' | 'below' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragStartTimeRef = useRef<number>(0);

  const unreadCount = useStore((s) =>
    s.notifications.filter((n) => !n.read && n.workspaceId === workspace.id).length,
  );

  const metadata = workspace.metadata;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== workspace.name) {
      onRename(trimmed);
    } else {
      setEditName(workspace.name);
    }
    setEditing(false);
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    dragStartTimeRef.current = Date.now();
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
    // 약간의 딜레이 후 dragging 상태로 전환 (더블클릭 구분)
    setTimeout(() => setIsDragging(true), 0);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    setDropIndicator(null);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropIndicator(e.clientY < midY ? 'above' : 'below');
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // currentTarget 밖으로 나갈 때만 인디케이터 제거
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropIndicator(null);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropIndicator(null);
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (isNaN(fromIndex) || fromIndex === index) return;

    // 드롭 위치를 아이템 중간 기준으로 결정
    // 위 절반 → 현재 index 앞으로, 아래 절반 → 현재 index 뒤로
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const toIndex = e.clientY < midY
      ? (fromIndex < index ? index - 1 : index)
      : (fromIndex > index ? index + 1 : index);
    onReorder(fromIndex, toIndex);
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 드래그 직후 클릭 이벤트 무시 (200ms 이내)
    if (Date.now() - dragStartTimeRef.current < 200) return;
    if (e.ctrlKey) {
      e.preventDefault();
      onCtrlSelect();
    } else {
      onSelect();
    }
  };

  const handleDoubleClick = () => {
    // 드래그 직후 더블클릭 이벤트 무시
    if (Date.now() - dragStartTimeRef.current < 300) return;
    setEditName(workspace.name);
    setEditing(true);
  };

  return (
    <div className="relative mx-2">
      {/* 드롭 인디케이터 - 위 */}
      {dropIndicator === 'above' && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-[#89b4fa] rounded-full z-10 -translate-y-px" />
      )}

      <div
        draggable
        className={`group flex items-start gap-2 px-3 py-1.5 cursor-pointer rounded-md transition-colors select-none ${
          isActive
            ? 'bg-[#313244] text-[#cdd6f4]'
            : 'text-[#6c7086] hover:bg-[#313244]/50 hover:text-[#bac2de]'
        } ${isDragging ? 'opacity-40' : 'opacity-100'}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Status indicator */}
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${isActive ? 'bg-[#a6e3a1]' : 'bg-[#585b70]'}`} />

        {/* Name + Metadata */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-[11px] font-mono px-1 py-0 rounded border border-[#585b70] outline-none"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditName(workspace.name); setEditing(false); }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-mono truncate">{workspace.name}</span>
                {metadata?.agentStatus && metadata.agentStatus !== 'idle' && (
                  <AgentStatusDot status={metadata.agentStatus} agentName={metadata.agentName} />
                )}
                {unreadCount > 0 && (
                  <span className="bg-[#89b4fa] text-[#1e1e2e] text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 flex-shrink-0">
                    {unreadCount}
                  </span>
                )}
              </div>
              {metadata && (metadata.gitBranch || metadata.cwd || (metadata.listeningPorts && metadata.listeningPorts.length > 0) || metadata.agentName) && (
                <div className="mt-0.5 space-y-0 text-[10px] text-[#585b70]">
                  {metadata.gitBranch && (
                    <div className="truncate" title={metadata.gitBranch}>
                      <span className="text-[#f9e2af]">⎇</span> {metadata.gitBranch}
                    </div>
                  )}
                  {metadata.cwd && (
                    <div className="truncate" title={metadata.cwd}>
                      {shortenPath(metadata.cwd)}
                    </div>
                  )}
                  {metadata.listeningPorts && metadata.listeningPorts.length > 0 && (
                    <div className="truncate">
                      <span className="text-[#a6e3a1]">●</span> :{metadata.listeningPorts.slice(0, 3).join(', :')}
                      {metadata.listeningPorts.length > 3 && ` +${metadata.listeningPorts.length - 3}`}
                    </div>
                  )}
                  {metadata.agentName && (
                    <div className="truncate" title={`Agent: ${metadata.agentName}`}>
                      <span className="text-[#cba6f7]">⚡</span> {metadata.agentName}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Shortcut hint */}
        <span className="text-[8px] font-mono text-[#585b70] flex-shrink-0 mt-0.5">
          {index < 9 ? `^${index + 1}` : ''}
        </span>

        {/* Close button */}
        <button
          className="opacity-0 group-hover:opacity-100 text-[#6c7086] hover:text-[#f38ba8] text-[10px] font-mono flex-shrink-0 mt-0.5 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Close workspace"
        >
          ✕
        </button>
      </div>

      {/* 드롭 인디케이터 - 아래 */}
      {dropIndicator === 'below' && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#89b4fa] rounded-full z-10 translate-y-px" />
      )}
    </div>
  );
}
