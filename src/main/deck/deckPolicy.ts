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

- Work happens in an isolated git worktree under the designated worktrees folder — never the product's main checkout. If a task doesn't say where, this rule answers it.
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
