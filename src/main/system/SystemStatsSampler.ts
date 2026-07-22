import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { MemoryStats, WslSystemStats } from '../../shared/systemStats';

interface CpuTotals {
  idle: number;
  total: number;
}

const WSL_TIMEOUT_MS = 2_000;

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
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  return { totalBytes, usedBytes, percent };
}

export function parseWslMeminfo(text: string, distro: string): WslSystemStats | null {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const memTotal = values.get('MemTotal') ?? 0;
  const memAvailable = values.get('MemAvailable') ?? 0;
  if (memTotal <= 0) return null;
  const swapTotal = values.get('SwapTotal') ?? 0;
  const swapFree = values.get('SwapFree') ?? 0;
  return {
    distro,
    memory: memoryStats(memTotal, memAvailable),
    swap: memoryStats(swapTotal, swapFree),
  };
}

function decodeWslList(buffer: Buffer): string {
  // `wsl.exe --list` uses UTF-16LE when stdout is redirected on Windows.
  return buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8');
}

function runWsl(args: string[]): Promise<Buffer> {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'buffer', timeout: WSL_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}

async function readWslStats(): Promise<WslSystemStats | null> {
  if (process.platform !== 'win32') return null;
  try {
    const list = decodeWslList(await runWsl(['--list', '--running', '--quiet']));
    const distro = list.split(/\r?\n/).map((line) => line.replace(/^\*\s*/, '').trim()).find(Boolean);
    if (!distro) return null;
    const meminfo = (await runWsl(['--distribution', distro, '--exec', 'cat', '/proc/meminfo'])).toString('utf8');
    return parseWslMeminfo(meminfo, distro);
  } catch {
    // WSL may be stopped, unavailable, or too busy to answer. Host stats must
    // remain useful and the titlebar must never wait indefinitely for it.
    return null;
  }
}

export class SystemStatsSampler {
  private previousCpu = cpuTotals();

  async sample(appMemoryBytes: number): Promise<import('../../shared/systemStats').SystemStatsSnapshot> {
    const currentCpu = cpuTotals();
    const cpuPercent = cpuPercentBetween(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;
    const totalBytes = os.totalmem();
    return {
      cpuPercent,
      memory: memoryStats(totalBytes, os.freemem()),
      appMemoryBytes,
      wsl: await readWslStats(),
    };
  }
}
