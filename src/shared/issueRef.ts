// An issue dragged off the Git page. The row puts this JSON under its own
// dataTransfer type, so a drop target can tell an issue from text or files.

export const ISSUE_DRAG_TYPE = 'application/x-wmux-issue';

export interface IssueRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
}

export function serializeIssueRef(ref: IssueRef): string {
  const { host, owner, repo, number, title, url } = ref;
  return JSON.stringify({ host, owner, repo, number, title, url });
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

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
  if (!nonEmpty(o.host) || !nonEmpty(o.owner) || !nonEmpty(o.repo) || !nonEmpty(o.url)) return null;
  if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) return null;
  if (typeof o.title !== 'string') return null;
  if (!/^https:\/\//i.test(o.url)) return null;
  return { host: o.host, owner: o.owner, repo: o.repo, number: o.number, title: o.title, url: o.url };
}

/** host/owner/repo from an issue's web URL (https://host/owner/repo/issues/N). */
export function issueRepoFromUrl(url: string): { host: string; owner: string; repo: string } | null {
  const m = url.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/\d+/i);
  return m ? { host: m[1], owner: m[2], repo: m[3] } : null;
}
