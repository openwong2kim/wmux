export interface MemoryStats {
  totalBytes: number;
  usedBytes: number;
  percent: number;
}

export interface WslSystemStats {
  distro: string;
  memory: MemoryStats;
  swap: MemoryStats;
}

export interface SystemStatsSnapshot {
  cpuPercent: number;
  memory: MemoryStats;
  appMemoryBytes: number;
  wsl: WslSystemStats | null;
}
