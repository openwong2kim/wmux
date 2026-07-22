import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { MemoryStats, WslSystemStats } from '../../shared/systemStats';

interface CpuTotals {
  idle: number;
  total: number;
}

const PROCESS_TIMEOUT_MS = 2_000;

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuTotals, current: CpuTotals): number {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

function memoryStats(totalBytes: number, availableBytes: number): MemoryStats {
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const percent = totalBytes > 0
    ? Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100)))
    : 0;
  return { totalBytes, usedBytes, percent };
}

function memoryStatsFromUsed(totalBytes: number, usedBytes: number): MemoryStats {
  const percent = totalBytes > 0
    ? Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100)))
    : 0;
  return { totalBytes, usedBytes: Math.max(0, usedBytes), percent };
}

export function parseMemorySize(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\s*$/i.exec(value);
  if (!match) return null;
  const powers: Record<string, number> = { KB: 1, MB: 2, GB: 3, TB: 4 };
  return Number(match[1]) * 1024 ** powers[match[2].toUpperCase()];
}

export function parseWslConfigMemory(text: string): number | null {
  let inWsl2 = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const section = /^\[([^\]]+)]$/.exec(line);
    if (section) {
      inWsl2 = section[1].trim().toLowerCase() === 'wsl2';
      continue;
    }
    if (!inWsl2) continue;
    const setting = /^memory\s*=\s*(.+)$/i.exec(line);
    if (setting) return parseMemorySize(setting[1]);
  }
  return null;
}

export function parseTasklistWslMemory(text: string): number | null {
  let modernKB = 0;
  let legacyKB = 0;
  for (const line of text.split(/\r?\n/)) {
    const fields = Array.from(line.matchAll(/"([^"]*)"(?:,|$)/g), (match) => match[1]);
    if (fields.length < 5) continue;
    const imageName = fields[0].toLowerCase();
    if (imageName !== 'vmmemwsl.exe' && imageName !== 'vmmem.exe') continue;
    const digits = fields[4].replace(/\D/g, '');
    if (!digits) continue;
    if (imageName === 'vmmemwsl.exe') modernKB += Number(digits);
    else legacyKB += Number(digits);
  }
  // Prefer the WSL-specific modern process. A generic legacy vmmem process
  // may coexist for another Hyper-V consumer and must not be double-counted.
  if (modernKB > 0) return modernKB * 1024;
  return legacyKB > 0 ? legacyKB * 1024 : null;
}

function configuredWslMemoryLimit(): number {
  try {
    const config = fs.readFileSync(path.join(os.homedir(), '.wslconfig'), 'utf8');
    return parseWslConfigMemory(config) ?? Math.floor(os.totalmem() / 2);
  } catch {
    return Math.floor(os.totalmem() / 2);
  }
}

function readWslVmWorkingSet(): Promise<number | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
  return new Promise((resolve) => {
    execFile(
      executable,
      // Both modern vmmemWSL.exe and legacy vmmem.exe run in session 0.
      // Filtering to that service session keeps output bounded while allowing
      // the parser to support both names in a single non-invasive query.
      ['/FI', 'SESSION eq 0', '/FO', 'CSV', '/NH'],
      { encoding: 'buffer', timeout: PROCESS_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseTasklistWslMemory((stdout as Buffer).toString('latin1'))),
    );
  });
}

export class SystemStatsSampler {
  private previousCpu = cpuTotals();

  constructor(
    private readonly sampleWslWorkingSet: () => Promise<number | null> = readWslVmWorkingSet,
    private readonly wslMemoryLimit: number = configuredWslMemoryLimit(),
  ) {}

  async sample(appMemoryBytes: number): Promise<import('../../shared/systemStats').SystemStatsSnapshot> {
    const currentCpu = cpuTotals();
    const cpuPercent = cpuPercentBetween(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;
    const totalBytes = os.totalmem();
    const wslUsedBytes = await this.sampleWslWorkingSet();
    const wsl: WslSystemStats | null = wslUsedBytes === null
      ? null
      : { memory: memoryStatsFromUsed(this.wslMemoryLimit, wslUsedBytes) };
    return {
      cpuPercent,
      memory: memoryStats(totalBytes, os.freemem()),
      appMemoryBytes,
      wsl,
    };
  }
}
