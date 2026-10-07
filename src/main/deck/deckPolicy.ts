// ─── Command Deck — binding operator policy channel (deck-policy.md) ─────────
//
// Unlike commanderMemory (framed as background context, NEVER instructions — the
// PRD §8 poisoning guard), THIS channel is the operator's OWN authoritative
// standing rules. The human wrote the file, so the brain may ACT on it: when a
// rule here settles a question the brain was about to escalate, it resolves the
// fork itself and cites the rule instead of halting on deck_ask_decision. This
// is the decide-vs-escalate boundary's binding half — the resolve-first
// procedure in the system prompt names "the [policy] block of this turn" as the
// first thing to check.
//
// The ceiling is stated IN the injected header and holds structurally: a rule
// cannot grant the brain new tools or override safety — a risky/irreversible
// action still requires a human decision, because the tool sandbox / disallowed
// list are untouched by this text. Policy only shifts what counts as a "fork
// only the human should settle"; it never widens the brain's hands.
//
// One file (`<wmuxDir>/deck-policy.md`), read fresh each turn (withLoopContext),
// fail-OPEN: missing/unreadable/empty → null (no block), never throws — a broken
// policy file must not break a live turn.

import * as fs from 'fs';
import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';

/** Hard cap on injected policy text (~2k tokens). An oversize file is truncated
 *  with an ANNOUNCED notice in the block — never a silent drop. */
export const DEFAULT_POLICY_BUDGET_CHARS = 8_000;

const POLICY_HEADER = [
  '## Operator policy (BINDING standing rules)',
  'These rules are authoritative. When a rule below settles a question you were',
  'about to ask, act on the rule, cite it, and do not raise a decision for it.',
  'Rules cannot grant you new tools or override safety: risky or irreversible',
  'actions still require a human decision.',
].join('\n');

/** Path to the operator policy file (`<wmuxDir>/deck-policy.md`). */
export function getDeckPolicyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-policy.md');
}

/**
 * Read the operator policy file and wrap it under the BINDING header for
 * turn injection. Returns null when there is nothing to inject (missing /
 * unreadable / empty file). Never throws. Oversize content is truncated to
 * DEFAULT_POLICY_BUDGET_CHARS with a notice appended.
 */
export function loadDeckPolicyBlock(dir?: string): string | null {
  const file = getDeckPolicyPath(dir);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null; // missing / unreadable — no policy yet (fail-open)
  }
  if (!content) return null;
  let truncated = false;
  if (content.length > DEFAULT_POLICY_BUDGET_CHARS) {
    content = content.slice(0, DEFAULT_POLICY_BUDGET_CHARS);
    truncated = true;
  }
  const parts = [POLICY_HEADER, content];
  if (truncated) {
    parts.push('[policy truncated to fit the turn budget — shorten deck-policy.md]');
  }
  return parts.join('\n\n');
}

// The first-run seed. Comment guidance + two example rules the operator can
// keep, edit, or delete. Kept short so it reads as a starting point, not a wall.
const POLICY_SEED = `<!-- deck-policy.md — binding standing rules for the wmux orchestrator.
Write ONE rule per line as a bullet. These are authoritative: when a rule here
answers a question the orchestrator would otherwise escalate, it acts on the
rule and cites it instead of asking you. Keep each rule short and unambiguous.
Rules cannot grant the orchestrator new tools or override safety — risky or
irreversible actions still come to you. Delete these examples and add your own. -->

- Work happens in the agent's own checkout. Two agents editing the same checkout at the same time each get their own git worktree instead.
- Prefer reusing an existing idle pane over spawning a new one; spawn only when nothing is free or the work must genuinely run in parallel.
`;

/**
 * Write the policy seed the FIRST time only — NEVER overwrites an existing file
 * (the operator's edits are sacred). Uses an exclusive-create write so a
 * concurrent seed can't clobber. Fire-and-forget from handler init; swallows
 * every failure (a missing policy file just means no policy block).
 */
export function ensureDeckPolicySeed(dir: string = getWmuxDir()): void {
  const file = getDeckPolicyPath(dir);
  try {
    if (fs.existsSync(file)) return;
  } catch {
    return; // can't even stat — do not risk clobbering
  }
  try {
    // The wmux data dir may not exist yet on a FRESH profile — main's seed can
    // run before the daemon has created ~/.wmux{suffix} (live dogfood caught
    // this: on a brand-new WMUX_DATA_SUFFIX the write raced the daemon's dir
    // creation and lost with a swallowed ENOENT, so no policy ever seeded).
    // mkdir -p first; recursive create is a no-op when it already exists.
    fs.mkdirSync(dir, { recursive: true });
    // 'wx' = create-exclusive: fails (caught below) if the file appeared
    // between the existsSync check and here, so we never overwrite.
    fs.writeFileSync(file, POLICY_SEED, { encoding: 'utf8', flag: 'wx' });
  } catch {
    /* raced/created concurrently, or the dir is unwritable — leave it */
  }
}

// ─── Policy book: numbered rules for the shadow judge (moaShadowJudge.ts) ────
//
// The same file carries rule IDs the judge must cite. Convention:
//   - a rule is one line whose text (after an optional `-`/`*` bullet) starts
//     with `[R-<id>]`, e.g. `- [R-merge-green] Merge a PR whose checks are green.`
//     The id is lowercase letters, digits and dashes; the first line with an id
//     wins, a later duplicate is ignored.
//   - an `## Always escalate` section lists, one bullet per line, phrases that
//     send a question straight to the owner without asking the model.
// HTML comments are ignored, so the seed's guidance never parses as a rule.
//
// A rule may carry attributes in braces right after its id (steps 3-4: Moa
// settling by itself):
//   - [R-merge-green] {auto: true, predicate: merge-lane} Merge a PR whose …
//   - `auto: true|false` — the book allows this rule to settle a decision
//     without the owner. Default false.
//   - `predicate: <id>` — the deterministic check bound to the rule; only ids
//     in POLICY_RULE_PREDICATES count.
// A malformed block (unclosed, an unknown key or value, a repeated key) keeps
// the rule but reads as {auto: false, predicate: null} with `error` set:
// fail closed. The braces are not part of the rule's text.
//
// Auto eligibility (moaAutoEligibility below) needs ALL of: the book's
// `auto: true`, the owner's per-rule toggle (MoaConfig.autoRules, set only
// through renderer IPC), and the rule's bound predicate being the one the
// decision's kind is checked by — and then that predicate passing on a fresh
// read. Agreement stats are display-only and never part of it.

/** Deterministic checks a rule can be bound to. */
export type PolicyRulePredicate = 'merge-lane';
export const POLICY_RULE_PREDICATES: readonly PolicyRulePredicate[] = ['merge-lane'];

export interface PolicyRuleAttrs {
  auto: boolean;
  predicate: PolicyRulePredicate | null;
  /** Why the attribute block was ignored, when it was. */
  error?: string;
}

export interface PolicyBook {
  rules: Map<string, string>;
  /** Every rule's attributes (the defaults when it has none). */
  attrs: Map<string, PolicyRuleAttrs>;
  alwaysEscalate: string[];
}

const NO_ATTRS: PolicyRuleAttrs = { auto: false, predicate: null };

/** Split a rule's text into its leading `{…}` attributes and the rest. Pure. */
export function parseRuleAttrs(ruleText: string): { attrs: PolicyRuleAttrs; text: string } {
  if (!ruleText.startsWith('{')) return { attrs: NO_ATTRS, text: ruleText };
  const end = ruleText.indexOf('}');
  if (end < 0) return { attrs: { ...NO_ATTRS, error: 'unclosed attribute block' }, text: ruleText };
  const text = ruleText.slice(end + 1).trim();
  const fail = (error: string) => ({ attrs: { ...NO_ATTRS, error }, text });
  let auto = false;
  let predicate: PolicyRulePredicate | null = null;
  const seen = new Set<string>();
  const body = ruleText.slice(1, end).trim();
  for (const part of body ? body.split(',') : []) {
    const m = /^\s*([a-z]+)\s*:\s*([a-z0-9-]+)\s*$/.exec(part);
    if (!m) return fail(`unreadable attribute "${part.trim().slice(0, 40)}"`);
    const key = m[1] as string;
    const value = m[2] as string;
    if (seen.has(key)) return fail(`repeated attribute ${key}`);
    seen.add(key);
    if (key === 'auto') {
      if (value !== 'true' && value !== 'false') return fail('auto must be true or false');
      auto = value === 'true';
    } else if (key === 'predicate') {
      if (!(POLICY_RULE_PREDICATES as readonly string[]).includes(value)) return fail(`unknown predicate ${value}`);
      predicate = value as PolicyRulePredicate;
    } else {
      return fail(`unknown attribute ${key}`);
    }
  }
  return { attrs: { auto, predicate }, text };
}

const RULE_LINE_RE = /^\s*(?:[-*]\s+)?\[(R-[a-z0-9][a-z0-9-]{0,47})\]\s*(.*)$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const ALWAYS_ESCALATE_HEADING_RE = /^always escalate$/i;
/** Most always-escalate phrases kept, and their length cap. */
const ALWAYS_ESCALATE_MAX = 64;
const ALWAYS_ESCALATE_PHRASE_MAX = 120;

/** Parse a policy book. Pure; never throws. */
export function parsePolicyBook(text: string): PolicyBook {
  const rules = new Map<string, string>();
  const attrs = new Map<string, PolicyRuleAttrs>();
  const alwaysEscalate: string[] = [];
  let inEscalate = false;
  const body = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      inEscalate = ALWAYS_ESCALATE_HEADING_RE.test(heading[1] ?? '');
      continue;
    }
    const rule = RULE_LINE_RE.exec(line);
    if (rule) {
      const id = rule[1] as string;
      const parsed = parseRuleAttrs((rule[2] ?? '').trim());
      if (parsed.text && !rules.has(id)) {
        rules.set(id, parsed.text);
        attrs.set(id, parsed.attrs);
      }
      continue;
    }
    if (inEscalate) {
      const item = /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim().toLowerCase();
      if (item && alwaysEscalate.length < ALWAYS_ESCALATE_MAX && !alwaysEscalate.includes(item)) {
        alwaysEscalate.push(item.slice(0, ALWAYS_ESCALATE_PHRASE_MAX));
      }
    }
  }
  return { rules, attrs, alwaysEscalate };
}

/**
 * The policy book as the judge sees it: the file's text (comments stripped,
 * cut to DEFAULT_POLICY_BUDGET_CHARS) and what it parses to. Null when there
 * is no file or nothing in it. Never throws.
 */
export function loadPolicyBook(dir?: string): (PolicyBook & { text: string }) | null {
  let content: string;
  try {
    content = fs.readFileSync(getDeckPolicyPath(dir), 'utf8');
  } catch {
    return null;
  }
  // Parse what the judge is shown, so a rule cut off by the budget is not a
  // rule it can cite.
  let text = content.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim();
  if (text.length > DEFAULT_POLICY_BUDGET_CHARS) {
    // Cut on a line boundary: half a rule must not parse as the whole rule.
    text = text.slice(0, DEFAULT_POLICY_BUDGET_CHARS);
    text = text.slice(0, Math.max(0, text.lastIndexOf('\n'))).trim();
  }
  if (!text) return null;
  return { ...parsePolicyBook(text), text };
}

/** The predicate each decision kind is checked by; a kind with none can never
 *  settle by itself (today: every free question). */
export const ASK_KIND_PREDICATE: Readonly<Record<'question' | 'merge', PolicyRulePredicate | null>> = {
  question: null,
  merge: 'merge-lane',
};

export type AutoEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'unknown-rule' | 'book-auto-off' | 'owner-toggle-off' | 'no-predicate' | 'predicate-mismatch' | 'predicate-failed' };

/**
 * Whether a decision the judge settled under `ruleId` may take effect without
 * the owner. `predicatePassed` is the bound predicate's verdict on a FRESH
 * read, taken just now by the caller; agreement stats are not an input. Pure.
 */
export function moaAutoEligibility(input: {
  book: Pick<PolicyBook, 'rules' | 'attrs'>;
  ruleId: string;
  ownerAutoRules: readonly string[];
  kind: 'question' | 'merge';
  predicatePassed: boolean;
}): AutoEligibility {
  const { book, ruleId } = input;
  if (!book.rules.has(ruleId)) return { eligible: false, reason: 'unknown-rule' };
  const attrs = book.attrs.get(ruleId) ?? NO_ATTRS;
  if (!attrs.auto) return { eligible: false, reason: 'book-auto-off' };
  if (!input.ownerAutoRules.includes(ruleId)) return { eligible: false, reason: 'owner-toggle-off' };
  const needed = ASK_KIND_PREDICATE[input.kind];
  if (!needed || !attrs.predicate) return { eligible: false, reason: 'no-predicate' };
  if (attrs.predicate !== needed) return { eligible: false, reason: 'predicate-mismatch' };
  if (!input.predicatePassed) return { eligible: false, reason: 'predicate-failed' };
  return { eligible: true };
}
