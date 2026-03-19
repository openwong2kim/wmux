import { useState, useEffect } from 'react';
import { useStore } from '../../stores';

export default function StatusBar() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const unreadCount = useStore((s) => s.notifications.filter((n) => !n.read).length);
  const toggleSettingsPanel = useStore((s) => s.toggleSettingsPanel);

  // Company 모드 비용 정보
  const sidebarMode = useStore((s) => s.sidebarMode);
  const totalCost = useStore((s) => s.company?.totalCostEstimate ?? 0);
  const sessionStartTime = useStore((s) => s.sessionStartTime);

  const [time, setTime] = useState(new Date());
  const [memUsage, setMemUsage] = useState('');
  const [sessionMin, setSessionMin] = useState(0);

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
      if (sessionStartTime) {
        setSessionMin(Math.floor((Date.now() - sessionStartTime) / 60_000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

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
  const isCompanyMode = sidebarMode === 'company';

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
        {/* Company 모드 배지 */}
        {isCompanyMode && (
          <span className="text-[8px] font-mono px-1.5 py-px bg-[#313244] text-[#89b4fa] rounded">
            COMPANY
          </span>
        )}
      </div>

      {/* Right: status indicators */}
      <div className="flex items-center gap-3">
        {/* Company 모드일 때 비용 표시 */}
        {isCompanyMode && (
          <span className="text-[#a6adc8]" title={`Session: ${sessionMin}m`}>
            ~${totalCost.toFixed(2)}
          </span>
        )}
        {unreadCount > 0 && (
          <span className="text-[#89b4fa]">
            ● {unreadCount}
          </span>
        )}
        {memUsage && <span>{memUsage}</span>}
        <span>{timeStr}</span>
        <button
          onClick={toggleSettingsPanel}
          className="text-[#585b70] hover:text-[#cdd6f4] transition-colors ml-1"
          title="Settings (Ctrl+,)"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
