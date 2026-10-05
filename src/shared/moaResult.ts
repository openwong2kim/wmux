// The result of a task Moa delegated, as its result card in Moa's chat shows
// it: a summary, how many checks wmux could verify, and the changed files.
// Read from the work link's durable result when it has one, else from the
// A2A task's completion evidence. Every string is agent text: render as text.
import { isVerifiedItem } from './completionEvidence';
import type { EvidenceItem } from './types';
import type { WorkLinkResult } from './workLink';

export interface MoaTaskResult {
  summary?: string;
  /** Evidence items wmux counts as verified. */
  verified: number;
  /** All evidence items. */
  checks: number;
  /** Repo-relative paths, when the worker named them. */
  files?: string[];
}

const SUMMARY_MAX = 600;
const FILES_MAX = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const capped = (s: string): string => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);
const pathsOf = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const files = v.filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, FILES_MAX);
  return files.length ? files : undefined;
};

/** From an A2A task's completion evidence ({ summary, items, files }). */
export function resultFromEvidence(evidence: unknown): MoaTaskResult | null {
  if (!isRecord(evidence)) return null;
  const items = Array.isArray(evidence.items) ? (evidence.items as unknown[]).filter(isRecord) : [];
  const summary = text(evidence.summary);
  const files = pathsOf(evidence.files);
  return {
    ...(summary ? { summary: capped(summary) } : {}),
    verified: items.filter((it) => isVerifiedItem(it as unknown as EvidenceItem)).length,
    checks: items.length,
    ...(files ? { files } : {}),
  };
}

/** From a full A2A task: its completion evidence rides on `status.evidence`. */
export function resultFromTask(task: unknown): MoaTaskResult | null {
  const status = isRecord(task) ? task.status : undefined;
  return resultFromEvidence(isRecord(status) ? status.evidence : undefined);
}

/**
 * From a work link's durable `result` ({ summary, verification: "2/3", at }),
 * when the link carries one. It names no files.
 */
export function resultFromWorkLink(link: { result?: WorkLinkResult } | null | undefined): MoaTaskResult | null {
  const r = link?.result;
  const summary = text(r?.summary);
  if (!r || !summary) return null;
  const m = typeof r.verification === 'string' ? /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(r.verification) : null;
  return { summary: capped(summary), verified: m ? Number(m[1]) : 0, checks: m ? Number(m[2]) : 0 };
}
