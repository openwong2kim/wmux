// An issue dragged off the Git page. The row puts this JSON under its own
// dataTransfer type, so a drop target can tell an issue from text or files.
//
// Anything can be dropped on a page, so a consumer never trusts the payload:
// parseIssueRef accepts it only when host/owner/repo/number are exactly the
// ones its URL spells, and the title is the issue author's free text (capped
// here, still untrusted): show it as text, never as markup or a command.

export const ISSUE_DRAG_TYPE = 'application/x-wmux-issue';

/** Longest title a ref carries; a longer one is cut. */
export const ISSUE_REF_TITLE_MAX = 256;

export interface IssueRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** Untrusted free text, at most ISSUE_REF_TITLE_MAX characters. */
  title: string;
  url: string;
}

export function serializeIssueRef(ref: IssueRef): string {
  const { host, owner, repo, number, title, url } = ref;
  return JSON.stringify({ host, owner, repo, number, title: title.slice(0, ISSUE_REF_TITLE_MAX), url });
}

/** host/owner/repo/number from an issue's web URL (https://host/owner/repo/issues/N), whole URL only. */
export function issueUrlParts(url: string): { host: string; owner: string; repo: string; number: number } | null {
  const m = url.match(/^https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d{0,9})$/i);
  return m ? { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) } : null;
}

/** host/owner/repo from an issue's web URL. */
export function issueRepoFromUrl(url: string): { host: string; owner: string; repo: string } | null {
  const p = issueUrlParts(url);
  return p ? { host: p.host, owner: p.owner, repo: p.repo } : null;
}

/** The ref in a drag payload, or null when the payload is not one. */
export function parseIssueRef(raw: string): IssueRef | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || typeof o.title !== 'string') return null;
  const p = issueUrlParts(o.url);
  if (!p || o.host !== p.host || o.owner !== p.owner || o.repo !== p.repo || o.number !== p.number) return null;
  return { ...p, title: o.title.slice(0, ISSUE_REF_TITLE_MAX), url: o.url };
}
