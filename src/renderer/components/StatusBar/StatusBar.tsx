import { useState, useEffect } from 'react';
import { useStore } from '../../stores';

export default function StatusBar() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const unreadCount = useStore((s) => s.notifications.filter((n) => !n.read).length);

  const [time, setTime] = useState(new Date());
  const [memUsage, setMemUsage] = useState('');

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Update memory usage every 5 seconds
  useEffect(() => {
    const update = () => {
      const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
      if (perf.memory) {
        setMemUsage(`${Math.round(perf.memory.usedJSHeapSize / 1024 / 1024)}MB`);
      }
    };
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, []);

  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const branch = activeWs?.metadata?.gitBranch;

  return (
    <div className="flex items-center justify-between h-6 px-3 bg-[#11111b] border-b border-[#313244] text-[10px] text-[#585b70] shrink-0 select-none font-mono">
      {/* Left: workspace + branch */}
      <div className="flex items-center gap-3">
        <span className="text-[#cdd6f4] font-medium">{activeWs?.name || 'wmux'}</span>
        {branch && (
          <span>
            <span className="text-[#f9e2af]">⎇</span> {branch}
          </span>
        )}
      </div>

      {/* Right: status indicators */}
      <div className="flex items-center gap-3">
        {unreadCount > 0 && (
          <span className="text-[#89b4fa]">
            ● {unreadCount}
          </span>
        )}
        {memUsage && <span>{memUsage}</span>}
        <span>{timeStr}</span>
      </div>
    </div>
  );
}
