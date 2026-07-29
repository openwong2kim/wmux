// ─── wmux-owned skills for the terminal orchestrator's brain home ───────────
//
// The orchestrator's execution contract used to live in chat text: a preamble
// that said "you have no shell, delegate instead", re-sent every turn, competing
// with the actual task for the model's attention and lost the moment the turn
// scrolled away. Skills are the durable form of the same instruction — Claude
// Code discovers them from the cwd's `.claude/skills/` and fires them from
// their `description` when the situation matches, without being named.
//
// Verified against the installed CLI on 2026-07-29: under `--setting-sources
// project` (what buildBrainLaunchCommand passes) skills in the cwd are
// discovered, are NOT gated by `--allowedTools`, and fire situationally.
//
// The files are wmux-owned and regenerated on every spawn, so a skill can never
// drift behind the profile it describes. An operator who rewrites one keeps
// their version: a generated file carries a marker near its top, and a file
// without one is left alone. That is the same operator-owns-it story as
// `brains/<wsId>/CLAUDE.md`.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Ownership marker, written as the first line of every generated skill's
 *  BODY (the line right after the closing `---`). Its ABSENCE is what protects
 *  an operator's own edit from being clobbered on the next spawn.
 *
 *  Not the file's literal first line: Claude Code parses SKILL.md frontmatter
 *  only when the opening `---` is at offset 0, so a marker above it would cost
 *  the skill its name and description — and with them its ability to fire. */
export const WMUX_SKILL_MARKER = '<!-- wmux-owned: regenerated on every brain spawn -->';

export interface BrainSkillFile {
  /** Path relative to `<brainHome>/.claude/skills/`. */
  relPath: string;
  content: string;
}

const DELEGATE_SKILL = `---
name: delegate
description: Use when about to run a shell command, a git or gh operation, edit a file, or take on any multi-step build, test, or release task. Explains that the orchestrator has no shell and how to hand the work to a worker pane instead.
---
${WMUX_SKILL_MARKER}

# Delegate the work — you have no shell

You cannot run commands. \`Bash\`, \`Edit\`, \`Write\`, \`Task\` and \`Agent\` are
denied to you at two layers: the profile's permission deny list, and a
PreToolUse hook that blocks the call and tells you why. This is a capability
boundary, not a preference or a style guide. Retrying, rephrasing, or asking for
an exception does not change it.

## What you can do yourself

- Observe the fleet: list panes, read their screens, read their metadata.
- Create workers: split a pane, then drive it by typing into it.
- Communicate: post to channels, read unread, send and answer A2A tasks.
- Escalate: raise a decision gate when a choice belongs to the operator.

## Everything else goes to a worker pane

There is no third option. If a task needs a shell, a file edit, or a build, it
belongs to a worker. Split a pane, send it the task, and wait for it.

Two things about that path you must not forget:

- **It cannot read an exit code.** Sending keystrokes and polling the screen is
  all you get. Never report a command as having succeeded because the pane
  looked calm — say what you actually observed, and have the worker state its
  own result explicitly.
- **The \`wmux\` CLI is not a substitute for your MCP tools.** The two disagree:
  a \`wmux channel unread\` run has reported nothing while the MCP
  \`channel_unread\` reported five channels with waiting messages. Trust the MCP
  tools; treat CLI output typed into a pane as that pane's opinion.

## What every delegation prompt must carry

1. A gate the worker runs per commit unit (typecheck, lint, the relevant tests),
   and the instruction to stop rather than push past a red gate.
2. An instruction to report back immediately on a conflict or a failed gate,
   rather than working around it.
3. An explicit statement of how the next instruction reaches the worker once it
   goes idle — a worker that does not know it will be woken invents work.
`;

const APPROVE_SKILL = `---
name: approve
description: Use when a worker pane is waiting for approval or is reported as awaiting_input, before sending any keystroke to it. Explains how to verify what is actually on screen before pressing anything.
---
${WMUX_SKILL_MARKER}

# Read the screen before you press anything

A pane reported as \`awaiting_input\` tells you that something is waiting. It does
not tell you WHAT. The event is a pointer, not a description, and it can be
stale by the time you act on it.

## The order is fixed

1. Read that pane's screen. Read the actual prompt text — the whole question,
   the file paths in it, the command it is about to run.
2. Decide whether it falls inside what the operator has already approved for
   this task.
3. Only then send a keystroke.

Never press on the strength of the event alone. Never press because a prompt of
that shape is "usually fine". If the pane has moved on, or is asking something
different from what you expected, start over at step 1.

## When it is outside what was approved

Raise a decision gate (\`deck_ask_decision\`) and wait. Destructive commands,
force pushes, anything touching credentials, anything that reaches production,
and anything the operator has not scoped are all in this category.

Pressing a key is not deciding on the operator's behalf. You are confirming a
decision that was already made. When no such decision exists, there is nothing
for you to confirm — ask.
`;

/** The generated skills. Pure, so their content is unit-testable with no
 *  filesystem and no brain. */
export function buildBrainSkills(): BrainSkillFile[] {
  return [
    { relPath: path.join('delegate', 'SKILL.md'), content: DELEGATE_SKILL },
    { relPath: path.join('approve', 'SKILL.md'), content: APPROVE_SKILL },
  ];
}

/** How far into a file the marker may appear and still count as ours. Just past
 *  the generated frontmatter — far enough for a name/description edit, short
 *  enough that a marker quoted somewhere in an operator's prose does not read
 *  as a claim of ownership. */
const MARKER_SEARCH_WINDOW = 512;

/** Whether the given content carries wmux's ownership marker. */
export function isWmuxOwnedSkill(content: string): boolean {
  return content.slice(0, MARKER_SEARCH_WINDOW).includes(WMUX_SKILL_MARKER);
}

/** Whether the file at `filePath` is one wmux may overwrite. Unreadable is NOT
 *  ownable: EACCES/EISDIR/EIO leave us unable to prove the marker is there, and
 *  guessing "ours" would silently destroy an operator's own skill. Only ENOENT
 *  (the file vanished between existsSync and here) means there is nothing to
 *  protect, so it is ours to create. */
function readIsWmuxOwned(filePath: string): boolean {
  try {
    return isWmuxOwnedSkill(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
}

/**
 * Write the skills under `<brainHome>/.claude/skills/`, skipping any file an
 * operator has taken ownership of (see WMUX_SKILL_MARKER). Never throws: a
 * skill that could not be written costs the skill, never the spawn.
 */
export function installBrainSkills(brainHome: string): void {
  const root = path.join(brainHome, '.claude', 'skills');
  for (const skill of buildBrainSkills()) {
    const target = path.join(root, skill.relPath);
    try {
      if (fs.existsSync(target) && !readIsWmuxOwned(target)) {
        console.warn(`[deck] keeping the operator's own ${skill.relPath} — not overwriting it.`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, skill.content, 'utf8');
    } catch (err) {
      console.warn(`[deck] could not install the brain skill ${skill.relPath}: ${String(err)}`);
    }
  }
}
