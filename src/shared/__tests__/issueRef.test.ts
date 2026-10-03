import { describe, it, expect } from 'vitest';
import { ISSUE_DRAG_TYPE, ISSUE_REF_TITLE_MAX, issueRepoFromUrl, parseIssueRef, serializeIssueRef, type IssueRef } from '../issueRef';
import { parseIssueFilter } from '../issueSurface';

const ref: IssueRef = {
  host: 'github.com',
  owner: 'Open-Wong',
  repo: 'wmux',
  number: 42,
  title: 'Crash on "quotes" and </script>',
  url: 'https://github.com/Open-Wong/wmux/issues/42',
};

describe('issueRef', () => {
  it('has its own drag type', () => {
    expect(ISSUE_DRAG_TYPE).toBe('application/x-wmux-issue');
  });

  it('round-trips through the drag payload', () => {
    expect(parseIssueRef(serializeIssueRef(ref))).toEqual(ref);
  });

  it('drops extra fields when serializing', () => {
    const json = serializeIssueRef({ ...ref, extra: 1 } as IssueRef);
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['host', 'number', 'owner', 'repo', 'title', 'url']);
  });

  it('rejects what is not an issue ref', () => {
    expect(parseIssueRef('not json')).toBeNull();
    expect(parseIssueRef('null')).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, number: 0 }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, number: 1.5 }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, owner: '' }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, title: undefined }))).toBeNull();
  });

  it('accepts a ref only when host/owner/repo/number are the ones its URL spells', () => {
    expect(parseIssueRef(JSON.stringify({ ...ref, number: 43 }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, repo: 'other' }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, owner: 'open-wong' }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, host: 'evil.example' }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, url: `${ref.url}/../../../x/y/issues/42` }))).toBeNull();
    expect(parseIssueRef(JSON.stringify({ ...ref, url: 'https://github.com/Open-Wong/wmux/pull/42' }))).toBeNull();
  });

  it('caps the title', () => {
    const long = 'x'.repeat(ISSUE_REF_TITLE_MAX + 50);
    expect(parseIssueRef(JSON.stringify({ ...ref, title: long }))!.title).toHaveLength(ISSUE_REF_TITLE_MAX);
    expect(JSON.parse(serializeIssueRef({ ...ref, title: long })).title).toHaveLength(ISSUE_REF_TITLE_MAX);
  });

  it('reads host/owner/repo from an issue URL, case kept', () => {
    expect(issueRepoFromUrl(ref.url)).toEqual({ host: 'github.com', owner: 'Open-Wong', repo: 'wmux' });
    expect(issueRepoFromUrl('https://github.com/o/r/pull/1')).toBeNull();
  });
});

describe('parseIssueFilter', () => {
  it('accepts the four kinds and trims a label', () => {
    expect(parseIssueFilter({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(parseIssueFilter({ kind: 'assigned' })).toEqual({ kind: 'assigned' });
    expect(parseIssueFilter({ kind: 'created' })).toEqual({ kind: 'created' });
    expect(parseIssueFilter({ kind: 'label', label: ' bug ' })).toEqual({ kind: 'label', label: 'bug' });
  });

  it('rejects anything else', () => {
    expect(parseIssueFilter(null)).toBeNull();
    expect(parseIssueFilter({ kind: 'mine' })).toBeNull();
    expect(parseIssueFilter({ kind: 'label', label: '' })).toBeNull();
    expect(parseIssueFilter({ kind: 'label', label: 'a\nb' })).toBeNull();
    expect(parseIssueFilter({ kind: 'label', label: 'x'.repeat(101) })).toBeNull();
  });
});
