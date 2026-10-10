// Settings › Moa's per-goal detail: per-criterion ✓/✗ with evidence, the
// last refusal's other problems, and what Moa delivered. Pure; exported for
// tests.

import fs from 'node:fs';
import type { MoaGoalPanel } from '../../shared/moa';
import { goalTermsOf, type MoaGoalContract } from '../../shared/moaGoal';

/** The last lines of a gate log worth showing (the failing assertion is
 *  usually at the end). Never throws. */
export function logTail(p: string, lines = 4): string[] {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf
        .toString('utf8')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() && !/^(> |npm (ERR|error)! |# )/.test(l))
        .slice(-lines)
        .map((l) => l.slice(0, 200));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** "task X: the gate failed (cmd, exit 1); see /path/to.log" → readable
 *  summary + the log as a separate, openable path. */
export function splitProblem(p: string, tail: (path: string) => string[] = logTail): { text: string; logPath?: string; excerpt?: string[] } {
  const m = /^(.*?);\s*see (\S.*\.log)$/.exec(p);
  if (!m) return { text: p };
  const excerpt = tail(m[2]);
  return { text: m[1], logPath: m[2], ...(excerpt.length ? { excerpt } : {}) };
}

export function goalPanelDetail(c: MoaGoalContract, tail: (path: string) => string[] = logTail): Pick<MoaGoalPanel, 'criteria' | 'problems' | 'delivery'> {
  const { doneCriteria } = goalTermsOf(c);
  const problems = c.status === 'active' ? c.lastCheck?.problems ?? [] : [];
  const criterionProblem = (n: number) => problems.find((p) => p.startsWith(`criterion ${n}`) && /^criterion \d+\b/.test(p));
  const criteria = doneCriteria.map((text, i) => {
    const n = i + 1;
    const proved = c.verification?.criteria.find((x) => x.criterion === n);
    if (proved) return { n, text, state: 'pass' as const, evidence: proved.artifacts.map((a) => a.path) };
    return { n, text, state: criterionProblem(n) ? ('fail' as const) : ('open' as const), evidence: [] };
  });
  const other = problems.filter((p) => !/^criterion \d+\b/.test(p)).map((p) => splitProblem(p, tail));
  return {
    ...(criteria.length ? { criteria } : {}),
    ...(other.length ? { problems: other } : {}),
    ...(c.delivery
      ? {
          delivery: {
            items: c.delivery.items.map((x) => ({
              branch: x.branch,
              pushed: x.pushed,
              ...(x.prUrl ? { prUrl: x.prUrl } : {}),
              ...(x.prNumber !== undefined ? { prNumber: x.prNumber } : {}),
              ...(x.error ? { error: x.error } : {}),
            })),
            reverted: !!c.delivery.reverted,
            ...(c.delivery.reverted ? { revertNotes: c.delivery.reverted.notes } : {}),
          },
        }
      : {}),
  };
}
