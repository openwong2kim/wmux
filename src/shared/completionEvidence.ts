/**
 * §6.M P1 completion evidence contract — validator core (pure functions, domain-agnostic).
 * Design authority: plans/completion-evidence-design-2026-07-06.md v1.1
 *
 * Gate = structure, verified = grade (E9): transition gate enforces only structure (summary +
 * well-formed items + sanitize + caps); "verified" is computed·displayed honestly via
 * verifiedItemCount — verified≥1 is not a transition requirement (consumed as dependency
 * predicate of P2 gate7). Structure prevents laundering like auto passed promotion on
 * run-success from polluting the gate.
 */
import type { CompletionEvidence, EvidenceItem } from './types';

// E12: DoS caps — prevent giant evidence permanently amplifying the append-only canonical log.
// Enforced on both authority validator (validateCompletionEvidence) and wire guard (normalize).
export const EVIDENCE_MAX_ITEMS = 64;
export const EVIDENCE_MAX_STR_BYTES = 4 * 1024; // per summary/command/location/output
export const EVIDENCE_MAX_FILES = 256;
export const EVIDENCE_MAX_FILE_PATH_BYTES = 1024;
export const EVIDENCE_MAX_TOTAL_BYTES = 64 * 1024; // JSON.stringify(evidence) total

// Use TextEncoder instead of Buffer so this runs in renderer (Electron), daemon, and vitest
// (utf8 byte count — same meaning as Buffer.byteLength).
const utf8 = new TextEncoder();
function byteLen(s: unknown): number {
  return typeof s === 'string' ? utf8.encode(s).length : 0;
}

/**
 * "Verified" = (command && passed) | (inspection|artifact && verified).
 * Grade computation only — not a transition gate (E9).
 */
export function isVerifiedItem(it: EvidenceItem): boolean {
  if (it.kind === 'command') return it.status === 'passed';
  return it.status === 'verified'; // union closes kind
}

function isWellFormedItem(it: unknown): it is EvidenceItem {
  if (it === null || typeof it !== 'object') return false;
  const o = it as Record<string, unknown>;
  if (typeof o.summary !== 'string' || o.summary.trim() === '') return false;
  if (o.kind === 'command') {
    return (
      (o.status === 'passed' || o.status === 'failed') &&
      typeof o.command === 'string' &&
      o.command.trim() !== ''
    );
  }
  if (o.kind === 'inspection' || o.kind === 'artifact') {
    return o.status === 'verified' || o.status === 'unverified';
  }
  return false; // unknown kind/status = malformed (fail-closed)
}

function withinCaps(ev: CompletionEvidence): boolean {
  if ((ev.items ?? []).length > EVIDENCE_MAX_ITEMS) return false;
  if (byteLen(ev.summary) > EVIDENCE_MAX_STR_BYTES) return false;
  for (const it of ev.items ?? []) {
    const io = it as { summary?: string; output?: string; command?: string; location?: string };
    if (byteLen(io.summary) > EVIDENCE_MAX_STR_BYTES || byteLen(io.output) > EVIDENCE_MAX_STR_BYTES) return false;
    if (byteLen(io.command) > EVIDENCE_MAX_STR_BYTES || byteLen(io.location) > EVIDENCE_MAX_STR_BYTES) return false;
  }
  if ((ev.files ?? []).length > EVIDENCE_MAX_FILES) return false;
  return byteLen(JSON.stringify(ev)) <= EVIDENCE_MAX_TOTAL_BYTES;
}

export type EvidenceVerdict =
  | { ok: true; verifiedItemCount: number }
  | { ok: false; code: string };

/**
 * Completion evidence gate. to is completed|failed only — canceled (abort, not a result claim)
 * and teardown force-fail (intentional bypass entry point, E10) do not call this gate.
 * Shape validation is common to completed·failed (X8: block malformed diagnostic items from audit log),
 * verified is never required on any transition (E9 — grade only).
 */
export function validateCompletionEvidence(
  to: 'completed' | 'failed',
  ev: CompletionEvidence | undefined,
): EvidenceVerdict {
  if (!ev) {
    return { ok: false, code: to === 'completed' ? 'completion_evidence_missing' : 'failure_reason_missing' };
  }
  if (typeof ev.summary !== 'string' || ev.summary.trim() === '') {
    return { ok: false, code: to === 'completed' ? 'completion_evidence_empty_summary' : 'failure_reason_missing' };
  }
  // Authority validator does not trust type annotations — non-array items (e.g. {}) would make
  // for..of throw TypeError instead of verdict, collapsing the gate. fail-closed.
  if (ev.items !== undefined && !Array.isArray(ev.items)) {
    return { ok: false, code: 'completion_evidence_invalid_item' };
  }
  if (ev.files !== undefined && !Array.isArray(ev.files)) {
    return { ok: false, code: 'completion_evidence_bad_file_path' };
  }
  if (!withinCaps(ev)) return { ok: false, code: 'completion_evidence_too_large' }; // E12
  for (const f of ev.files ?? []) {
    if (!isSafeRelPath(f)) return { ok: false, code: 'completion_evidence_bad_file_path' };
  }
  const items = ev.items ?? [];
  for (const it of items) {
    if (!isWellFormedItem(it)) return { ok: false, code: 'completion_evidence_invalid_item' };
  }
  if (to === 'completed' && items.length === 0) {
    return { ok: false, code: 'completion_evidence_no_items' };
  }
  // E9: verified≥1 is grade not transition requirement — return honestly (0 allowed)
  return { ok: true, verifiedItemCount: items.filter(isVerifiedItem).length };
}

/**
 * files[] path sanitize. Repository-relative paths only; pure string judgment without filesystem access.
 * Policy: no decode or normalization — judge·store input as literal code units; consumers must not
 * URL-decode or Unicode-normalize before use (that invalidates this guard — contract). '..' is ASCII
 * so cannot be disguised via Unicode normalization; percent-encoded ('%2e%2e%2f') is not decoded,
 * so harmless literal segment names.
 */
export function isSafeRelPath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (byteLen(p) > EVIDENCE_MAX_FILE_PATH_BYTES) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false; // C0 control chars (incl. null)·DEL
  }
  // Single colon rule rejects all: drive absolute ('C:\x'), drive-relative ('C:foo'),
  // NTFS ADS ('a.txt:ads'), URL scheme ('file://x'). Colon is unnecessary in portable
  // relative paths (forbidden in Windows filenames).
  if (p.includes(':')) return false;
  // Reject leading separators: POSIX absolute '/x', UNC '\\host', NT namespace '\\?\' all covered
  if (/^[/\\]/.test(p)) return false;
  const segs = p.split(/[/\\]/); // split on both OS separators
  if (segs.some((s) => s === '..')) return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null; // JSON.parse product + null-proto only
}

/**
 * Untrusted-wire completion evidence guard+normalize. Inherits and strengthens isTaskState
 * (types.ts, LanLink C10) threat model (block hostile wire values before they become lookup keys·store records).
 * On failure returns null (→ reason code completion_evidence_malformed). On success returns a **new object**
 * copying known fields only — unknown keys dropped (prototype pollution·smuggled fields blocked at source),
 * original object's getters/prototype cannot act downstream. recordedBy/recordedAt also dropped here
 * (server-only stamps — canonical writer records via authContext).
 * Judges shape only — empty summary etc. business invariants are revalidated by authority validator
 * (validateCompletionEvidence) (wire pass ≠ trust).
 */
export function normalizeCompletionEvidenceWire(v: unknown): CompletionEvidence | null {
  if (!isPlainObject(v)) return null;
  if (!Object.hasOwn(v, 'summary') || typeof v.summary !== 'string') return null;

  const items: EvidenceItem[] = [];
  if (Object.hasOwn(v, 'items')) {
    if (!Array.isArray(v.items) || v.items.length > EVIDENCE_MAX_ITEMS) return null;
    for (const raw of v.items) {
      if (!isPlainObject(raw)) return null;
      if (raw.kind === 'command') {
        if (raw.status !== 'passed' && raw.status !== 'failed') return null;
        if (!Object.hasOwn(raw, 'command') || typeof raw.command !== 'string') return null;
        if (typeof raw.summary !== 'string') return null;
        items.push({
          kind: 'command',
          status: raw.status,
          summary: raw.summary,
          command: raw.command,
          ...(typeof raw.output === 'string' ? { output: raw.output } : {}),
        });
      } else if (raw.kind === 'inspection' || raw.kind === 'artifact') {
        if (raw.status !== 'verified' && raw.status !== 'unverified') return null;
        if (typeof raw.summary !== 'string') return null;
        items.push({
          kind: raw.kind,
          status: raw.status,
          summary: raw.summary,
          ...(typeof raw.location === 'string' ? { location: raw.location } : {}),
          ...(typeof raw.output === 'string' ? { output: raw.output } : {}),
        });
      } else {
        return null; // unknown kind = reject entire payload (fail-closed)
      }
    }
  }
  let files: string[] | undefined;
  if (Object.hasOwn(v, 'files')) {
    if (!Array.isArray(v.files) || v.files.length > EVIDENCE_MAX_FILES) return null;
    // Enforce path sanitize on wire too (dual with authority validator) — even in additive-inert
    // window before gate is wired, non-relative paths ('/etc/x', 'a/../b') cannot persist as
    // store records (isTaskState precedent: validate before save).
    if ((v.files as unknown[]).some((f) => !isSafeRelPath(f))) return null;
    files = [...(v.files as string[])];
  }
  const out: CompletionEvidence = { summary: v.summary, items, ...(files ? { files } : {}) };
  return byteLen(JSON.stringify(out)) <= EVIDENCE_MAX_TOTAL_BYTES ? out : null;
}
