// The result of a task Moa delegated, as its result card in Moa's chat shows
// it: a summary, how many checks wmux could verify, and the changed files.
// Read from the work link's durable result when it has one, else from the
// A2A task's completion evidence. Every string is agent text: render as text.
import { isVerifiedItem } from './completionEvidence';
import type { EvidenceItem } from './types';

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

/**
 * From a work link's durable `result`, when the link carries one. The field is
 * read loosely (summary, verified/verifiedItemCount, checks/itemCount, files),
 * so an older or newer link shape degrades to "no result" instead of failing.
 */
export function resultFromWorkLink(link: unknown): MoaTaskResult | null {
  const r = isRecord(link) ? link.result : undefined;
  if (!isRecord(r)) return null;
  const num = (...vs: unknown[]): number => {
    for (const v of vs) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return 0;
  };
  const summary = text(r.summary);
  const files = pathsOf(r.files);
  return {
    ...(summary ? { summary: capped(summary) } : {}),
    verified: num(r.verified, r.verifiedItemCount),
    checks: num(r.checks, r.itemCount),
    ...(files ? { files } : {}),
  };
}
