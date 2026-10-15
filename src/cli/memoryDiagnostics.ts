import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppMemoryDiagnostics, DaemonMemoryDiagnostics } from '../shared/memoryDiagnostics';

interface ProcessRow { pid: number; ppid: number; rssBytes: number; browser: boolean }
type Group = 'app' | 'daemon' | 'workloads' | 'browser' | 'appChildren';
export interface ProcessMemorySection {
  available: boolean;
  reason?: string;
  groups?: Record<Group, { processes: number; rssBytes: number }>;
}

/** Only numeric counters leave the parser; command lines are not included in reports. */
export function parseProcessMemory(text: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, rss, name] = match;
    const rssBytes = Number(rss) * 1024;
    if (!Number.isSafeInteger(rssBytes)) continue;
    rows.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), rssBytes, browser: /chrome|chromium/i.test(name) });
  }
  return rows;
}

/** Assign each observed PID once, even when the daemon is a child of main. */
export function groupProcessMemory(
  rows: ReadonlyMap<number, ProcessRow>,
  mainPid: number | undefined,
  daemonPid: number | undefined,
  appPids: ReadonlySet<number>,
  excludedPid: number,
): NonNullable<ProcessMemorySection['groups']> {
  const groups: NonNullable<ProcessMemorySection['groups']> = {
    app: { processes: 0, rssBytes: 0 }, daemon: { processes: 0, rssBytes: 0 },
    workloads: { processes: 0, rssBytes: 0 }, browser: { processes: 0, rssBytes: 0 },
    appChildren: { processes: 0, rssBytes: 0 },
  };
  for (const row of rows.values()) {
    const ancestors: ProcessRow[] = [];
    const seen = new Set<number>();
    let cursor: ProcessRow | undefined = row;
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      ancestors.push(cursor);
      cursor = rows.get(cursor.ppid);
    }
    if (seen.has(excludedPid)) continue;
    let group: Group | undefined;
    if (row.pid === daemonPid) group = 'daemon';
    else if (daemonPid !== undefined && seen.has(daemonPid)) group = 'workloads';
    else if (row.pid === mainPid || appPids.has(row.pid)) group = 'app';
    else if (mainPid !== undefined && seen.has(mainPid)) {
      group = ancestors.some((p) => p.browser) ? 'browser' : 'appChildren';
    }
    if (group) {
      groups[group].processes++;
      groups[group].rssBytes += row.rssBytes;
    }
  }
  return groups;
}

export async function collectProcessMemory(
  app: AppMemoryDiagnostics | undefined,
  daemon: DaemonMemoryDiagnostics | undefined,
): Promise<ProcessMemorySection> {
  if (process.platform === 'win32') return { available: false, reason: 'Process-tree RSS sampling is available on macOS/Linux.' };
  if (!app && !daemon) return { available: false, reason: 'Process roots unavailable (app/daemon not running or older build).' };
  try {
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss=,comm='], {
      timeout: 3000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    });
    const rows = parseProcessMemory(stdout);
    if ((!app || !rows.has(app.mainPid)) && (!daemon || !rows.has(daemon.pid))) {
      return { available: false, reason: 'Process roots exited or were absent from the sample.' };
    }
    return {
      available: true,
      groups: groupProcessMemory(rows, app?.mainPid, daemon?.pid, new Set(app?.processes.map((p) => p.pid)), process.pid),
    };
  } catch {
    return { available: false, reason: 'Process sample failed, timed out, or exceeded the output limit.' };
  }
}

export function renderMemoryDiagnostics(
  app: AppMemoryDiagnostics | undefined,
  daemon: DaemonMemoryDiagnostics | undefined,
  processes: ProcessMemorySection,
): string {
  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const lines = ['Memory diagnostics (on demand; byte counters in JSON)'];
  lines.push(app
    ? `  Electron working sets: ${mib(app.processes.reduce((sum, p) => sum + p.workingSetBytes, 0))} (${app.processes.length} processes)`
    : '  Electron metrics unavailable (app not running or older build)');
  if (daemon) {
    lines.push(`  daemon RSS: ${mib(daemon.rssBytes)}; JS heap used: ${mib(daemon.heapUsedBytes)}; external: ${mib(daemon.externalBytes)}; ArrayBuffers: ${mib(daemon.arrayBuffersBytes)}`);
    const sum = (key: 'ringStoredBytes' | 'ringAllocatedBytes' | 'ringCapacityBytes' | 'socketQueuedBytes' | 'resyncQueuedBytes') =>
      daemon.sessions.reduce((total, session) => total + session[key], 0);
    lines.push(`  rings: ${mib(sum('ringStoredBytes'))} stored / ${mib(sum('ringAllocatedBytes'))} allocated / ${mib(sum('ringCapacityBytes'))} ceiling`);
    lines.push(`  output queues: ${mib(sum('socketQueuedBytes'))} socket / ${mib(sum('resyncQueuedBytes'))} resync tee`);
    if (daemon.hibernation) {
      const failures = daemon.hibernation.wakeFailures ? `; ${daemon.hibernation.wakeFailures} wake(s) could not read the .buf` : '';
      lines.push(`  hibernated idle panes: ${daemon.hibernation.sessions} (${mib(daemon.hibernation.freedBytes)} ring memory freed${failures})`);
    }
    for (const session of [...daemon.sessions].sort((a, b) =>
      (b.socketQueuedBytes + b.resyncQueuedBytes + b.ringAllocatedBytes) - (a.socketQueuedBytes + a.resyncQueuedBytes + a.ringAllocatedBytes)).slice(0, 5)) {
      lines.push(`    ${session.id} (${session.state}): ring ${mib(session.ringAllocatedBytes)}, socket ${mib(session.socketQueuedBytes)} (pipe peak ${mib(session.socketPeakQueuedBytes)}), resync ${mib(session.resyncQueuedBytes)}`);
    }
  } else lines.push('  daemon memory unavailable (daemon not running or older build)');
  if (processes.available && processes.groups) {
    for (const [name, group] of Object.entries(processes.groups)) {
      lines.push(`  process RSS ${name}: ${mib(group.rssBytes)} (${group.processes} processes)`);
    }
  } else lines.push(`  process-tree RSS unavailable: ${processes.reason ?? 'unknown'}`);
  lines.push('  RSS excludes swapped-out pages and macOS compressed pages; shared pages may be counted more than once. This is not swap attribution.');
  lines.push('  Heap, external, ArrayBuffers and ring/queue counters overlap. Do not add them to RSS. Tree sampling excludes reparented children and this diagnostic process.');
  return lines.join('\n');
}
