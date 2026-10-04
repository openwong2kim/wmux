// A pull request dragged off the Git page, the PR twin of issueRef: the row
// puts this JSON under its own dataTransfer type, and a consumer accepts it
// only when host/owner/repo/number are exactly the ones its URL spells. The
// title is the PR author's free text (capped here, still untrusted).
import { ISSUE_REF_TITLE_MAX } from './issueRef';

export const PR_DRAG_TYPE = 'application/x-wmux-pr';

export interface PrDragRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** Untrusted free text, at most ISSUE_REF_TITLE_MAX characters. */
  title: string;
  url: string;
}

/** host/owner/repo/number from a PR's web URL (https://host/owner/repo/pull/N), whole URL only. */
export function prUrlParts(url: string): { host: string; owner: string; repo: string; number: number } | null {
  const m = url.match(/^https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d{0,9})$/i);
  return m ? { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) } : null;
}

export function serializePrDragRef(ref: PrDragRef): string {
  const { host, owner, repo, number, title, url } = ref;
  return JSON.stringify({ host, owner, repo, number, title: title.slice(0, ISSUE_REF_TITLE_MAX), url });
}

/** The ref in a drag payload, or null when the payload is not one. */
export function parsePrDragRef(raw: string): PrDragRef | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || typeof o.title !== 'string') return null;
  const p = prUrlParts(o.url);
  if (!p || o.host !== p.host || o.owner !== p.owner || o.repo !== p.repo || o.number !== p.number) return null;
  return { ...p, title: o.title.slice(0, ISSUE_REF_TITLE_MAX), url: o.url };
}
