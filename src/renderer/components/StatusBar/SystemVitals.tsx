import { useEffect, useState } from 'react';
import type { SystemStatsSnapshot } from '../../../shared/systemStats';

const POLL_INTERVAL_MS = 5_000;

export function pressureToneClass(percent: number): string {
  if (percent >= 85) return 'text-[var(--accent-red)]';
  if (percent >= 75) return 'text-[var(--accent-yellow)]';
  return 'text-[var(--text-sub2)]';
}

export function wslPressurePercent(stats: SystemStatsSnapshot): number | null {
  if (!stats.wsl) return null;
  return stats.wsl.memory.percent;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatMemory(label: string, memory: SystemStatsSnapshot['memory']): string {
  return `${label}: ${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} (${memory.percent}%)`;
}

export function buildSystemVitalsTooltip(stats: SystemStatsSnapshot): string {
  const lines = [
    `Host CPU: ${stats.cpuPercent}%`,
    formatMemory('Host RAM', stats.memory),
    `wmux: ${formatBytes(stats.appMemoryBytes)}`,
  ];
  if (stats.wsl) {
    lines.push(formatMemory('WSL VM RAM', stats.wsl.memory));
  }
  return lines.join('\n');
}

export function SystemVitalsView({ stats }: { stats: SystemStatsSnapshot }) {
  const wslPercent = wslPressurePercent(stats);
  const tooltip = buildSystemVitalsTooltip(stats);
  return (
    <span className="flex items-center gap-1" title={tooltip} aria-label={tooltip} data-testid="system-vitals">
      <span className={pressureToneClass(stats.cpuPercent)}>CPU {stats.cpuPercent}%</span>
      <span aria-hidden="true">·</span>
      <span className={pressureToneClass(stats.memory.percent)}>RAM {stats.memory.percent}%</span>
      {wslPercent !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className={pressureToneClass(wslPercent)}>WSL {wslPercent}%</span>
        </>
      )}
    </span>
  );
}

export default function SystemVitals() {
  const [stats, setStats] = useState<SystemStatsSnapshot | null>(null);

  useEffect(() => {
    const getStats = window.electronAPI.system.getStats;
    if (typeof getStats !== 'function') return;
    let cancelled = false;
    const update = () => {
      void getStats()
        .then((next) => { if (!cancelled) setStats(next); })
        .catch(() => { /* Preserve the last useful sample while main or WSL is unavailable. */ });
    };
    update();
    const timer = setInterval(update, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return stats ? <SystemVitalsView stats={stats} /> : null;
}
