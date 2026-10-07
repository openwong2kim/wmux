// Unit tests for deckPolicy (the binding operator-policy channel). All
// filesystem cases run against a real tmp dir; no electron, no SDK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadDeckPolicyBlock,
  ensureDeckPolicySeed,
  getDeckPolicyPath,
  DEFAULT_POLICY_BUDGET_CHARS,
  parsePolicyBook,
  loadPolicyBook,
  parseRuleAttrs,
  moaAutoEligibility,
} from '../deckPolicy';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-policy-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDeckPolicyBlock', () => {
  it('returns null when the policy file is missing', () => {
    expect(loadDeckPolicyBlock(dir)).toBeNull();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(getDeckPolicyPath(dir), '   \n\t\n');
    expect(loadDeckPolicyBlock(dir)).toBeNull();
  });

  it('wraps the file content under the BINDING header', () => {
    fs.writeFileSync(getDeckPolicyPath(dir), '- deploy only from main');
    const block = loadDeckPolicyBlock(dir)!;
    expect(block).toContain('## Operator policy (BINDING standing rules)');
    expect(block).toContain('These rules are authoritative');
    // The safety ceiling is stated in the header.
    expect(block).toContain('risky or irreversible');
    // The operator content is included verbatim.
    expect(block).toContain('- deploy only from main');
  });

  it('truncates an oversize file with an announced notice (never silent)', () => {
    const huge = '- rule '.repeat(DEFAULT_POLICY_BUDGET_CHARS); // well over budget
    fs.writeFileSync(getDeckPolicyPath(dir), huge);
    const block = loadDeckPolicyBlock(dir)!;
    expect(block).toContain('[policy truncated to fit the turn budget');
    // Body is capped at the budget (header + notice add a small fixed overhead).
    expect(block.length).toBeLessThan(DEFAULT_POLICY_BUDGET_CHARS + 500);
  });

  it('never throws — a directory in place of the file resolves to null', () => {
    fs.mkdirSync(getDeckPolicyPath(dir)); // readFileSync on a dir throws → caught
    expect(loadDeckPolicyBlock(dir)).toBeNull();
  });
});

describe('ensureDeckPolicySeed', () => {
  it('creates the seed file once with the example worktree rule', () => {
    expect(fs.existsSync(getDeckPolicyPath(dir))).toBe(false);
    ensureDeckPolicySeed(dir);
    const seeded = fs.readFileSync(getDeckPolicyPath(dir), 'utf8');
    expect(seeded).toContain("the agent's own checkout");
    // The seed is loadable and wrapped under the binding header.
    const block = loadDeckPolicyBlock(dir)!;
    expect(block).toContain('## Operator policy (BINDING standing rules)');
    expect(block).toContain("the agent's own checkout");
  });

  it('NEVER overwrites an existing policy file (operator edits are sacred)', () => {
    const custom = '- my own rule that must survive';
    fs.writeFileSync(getDeckPolicyPath(dir), custom);
    ensureDeckPolicySeed(dir);
    ensureDeckPolicySeed(dir); // idempotent, still no overwrite
    expect(fs.readFileSync(getDeckPolicyPath(dir), 'utf8')).toBe(custom);
  });

  it('creates the data dir first when it does not exist yet (fresh-profile race)', () => {
    // Live dogfood regression: on a brand-new WMUX_DATA_SUFFIX, main's seed can
    // run before the daemon has created ~/.wmux{suffix}. The write must mkdir -p
    // its parent, not swallow an ENOENT and silently never seed.
    const freshDir = path.join(dir, 'not', 'yet', 'created');
    expect(fs.existsSync(freshDir)).toBe(false);
    ensureDeckPolicySeed(freshDir);
    expect(fs.existsSync(getDeckPolicyPath(freshDir))).toBe(true);
    expect(loadDeckPolicyBlock(freshDir)!).toContain("the agent's own checkout");
  });
});

describe('parsePolicyBook', () => {
  const FIXTURE = [
    '<!-- [R-in-comment] never a rule -->',
    '# House rules',
    '- [R-merge-green] Merge a PR whose required checks are all green.',
    '* [R-reuse-pane] Reuse an idle pane before spawning a new one.',
    '[R-bare-line] A rule without a bullet still counts.',
    '- [R-merge-green] A duplicate id is ignored.',
    '- [R-empty]',
    '- [Not-a-rule] wrong prefix',
    '- plain bullet, no id',
    '',
    '## Always escalate',
    '- Anything about billing',
    '- anything about billing',
    '* customer data',
    '- [R-inside-escalate] still a rule, not a phrase',
    '',
    '## Notes',
    '- not an escalation phrase',
  ].join('\n');

  it('parses rule ids, first id wins, comments and malformed ids ignored', () => {
    const book = parsePolicyBook(FIXTURE);
    expect([...book.rules.keys()]).toEqual(['R-merge-green', 'R-reuse-pane', 'R-bare-line', 'R-inside-escalate']);
    expect(book.rules.get('R-merge-green')).toBe('Merge a PR whose required checks are all green.');
  });

  it('collects the always-escalate section only, lowercased and deduped', () => {
    expect(parsePolicyBook(FIXTURE).alwaysEscalate).toEqual(['anything about billing', 'customer data']);
  });

  it('returns an empty book for text with no rules', () => {
    const book = parsePolicyBook('- just prose\n');
    expect(book.rules.size).toBe(0);
    expect(book.alwaysEscalate).toEqual([]);
  });

  it('loadPolicyBook cuts on a line boundary at the budget', () => {
    const filler = '- filler line that is not a rule\n'.repeat(Math.ceil(DEFAULT_POLICY_BUDGET_CHARS / 33));
    fs.writeFileSync(getDeckPolicyPath(dir), `- [R-first] kept\n${filler}- [R-last] past the budget\n`);
    const book = loadPolicyBook(dir);
    if (!book) throw new Error('expected a book');
    expect(book.text.length).toBeLessThanOrEqual(DEFAULT_POLICY_BUDGET_CHARS);
    expect(book.rules.has('R-first')).toBe(true);
    expect(book.rules.has('R-last')).toBe(false);
  });

  it('loadPolicyBook is null for a missing file', () => {
    expect(loadPolicyBook(dir)).toBeNull();
  });
});

describe('policy rule attributes (auto, predicate)', () => {
  const BOOK = [
    '- [R-merge-green] {auto: true, predicate: merge-lane} Merge a PR whose required checks are green.',
    '- [R-plain] No attributes, so never auto.',
    '- [R-off] {auto: false, predicate: merge-lane} Explicitly off.',
    '- [R-unknown-key] {auto: true, owner: yes} Unknown keys fail closed.',
    '- [R-bad-pred] {auto: true, predicate: anything} Unknown predicates fail closed.',
    '- [R-unclosed] {auto: true Merge everything.',
    '- [R-question] {auto: true} A question rule with no predicate.',
  ].join('\n');

  it('parses attributes off the rule text, defaulting to auto false', () => {
    const book = parsePolicyBook(BOOK);
    expect(book.rules.get('R-merge-green')).toBe('Merge a PR whose required checks are green.');
    expect(book.attrs.get('R-merge-green')).toEqual({ auto: true, predicate: 'merge-lane' });
    expect(book.attrs.get('R-plain')).toEqual({ auto: false, predicate: null });
    expect(book.attrs.get('R-off')).toEqual({ auto: false, predicate: 'merge-lane' });
    expect(book.attrs.get('R-question')).toEqual({ auto: true, predicate: null });
  });

  it('a malformed block keeps the rule but reads as not auto', () => {
    const book = parsePolicyBook(BOOK);
    for (const id of ['R-unknown-key', 'R-bad-pred', 'R-unclosed']) {
      expect(book.rules.has(id)).toBe(true);
      expect(book.attrs.get(id)).toMatchObject({ auto: false, predicate: null });
      expect(book.attrs.get(id)?.error).toBeTruthy();
    }
    expect(parseRuleAttrs('{auto: true, auto: true} x').attrs).toMatchObject({ auto: false, error: 'repeated attribute auto' });
    expect(parseRuleAttrs('{auto: yes} x').attrs).toMatchObject({ auto: false, error: 'auto must be true or false' });
    expect(parseRuleAttrs('{} x')).toEqual({ attrs: { auto: false, predicate: null }, text: 'x' });
  });

  it('auto eligibility needs the book flag, the owner toggle, the kind\'s predicate, and its fresh pass', () => {
    const book = parsePolicyBook(BOOK);
    const base = { book, ruleId: 'R-merge-green', ownerAutoRules: ['R-merge-green'], kind: 'merge' as const, predicatePassed: true };
    expect(moaAutoEligibility(base)).toEqual({ eligible: true });
    expect(moaAutoEligibility({ ...base, ownerAutoRules: [] })).toEqual({ eligible: false, reason: 'owner-toggle-off' });
    expect(moaAutoEligibility({ ...base, predicatePassed: false })).toEqual({ eligible: false, reason: 'predicate-failed' });
    expect(moaAutoEligibility({ ...base, ruleId: 'R-plain', ownerAutoRules: ['R-plain'] })).toEqual({ eligible: false, reason: 'book-auto-off' });
    expect(moaAutoEligibility({ ...base, ruleId: 'R-nope', ownerAutoRules: ['R-nope'] })).toEqual({ eligible: false, reason: 'unknown-rule' });
    // A free question has no predicate today: never auto, even with both flags.
    expect(moaAutoEligibility({ ...base, ruleId: 'R-question', ownerAutoRules: ['R-question'], kind: 'question' })).toEqual({ eligible: false, reason: 'no-predicate' });
    expect(moaAutoEligibility({ ...base, kind: 'question' })).toEqual({ eligible: false, reason: 'no-predicate' });
    expect(moaAutoEligibility({ ...base, ruleId: 'R-question', ownerAutoRules: ['R-question'] })).toEqual({ eligible: false, reason: 'no-predicate' });
  });
});
