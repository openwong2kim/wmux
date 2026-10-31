// The questions agents ask before working in a folder they have not seen.
// A leaf module: the first-run screens (shared/agentFirstRun) and the input
// guard's trust-prompt check (daemon/approvals/approvalKeystrokes) both read
// these, and agentFirstRun already imports approvalKeystrokes.

/** The trust dialog's opening question (Claude Code 2.1.x). */
export const TRUST_HEADLINE = /is this a project you created or one you trust/i;

/** Codex's folder-trust screen (wording differs across releases; agy asks about
 *  the contents of a project). Gemini CLI 0.35.3/0.65.0 and Qwen Code 0.26.1
 *  ask the same "files in this folder" / "this folder?" (measured). Never answered. */
export const CODEX_TRUST_HEADLINE = /do you trust the (?:contents of this (?:directory|project)|files in this folder)|trust this folder\?/i;

/** The reason a launch line was not typed: main puts it in the refusal, the
 *  renderer recognises it there to tell the person why. */
export const FOLDER_TRUST_LAUNCH_REFUSAL = 'the pane is on a folder-trust prompt; answer it in the pane';

/** The reason an automated launch line was not typed because the screen could
 *  not be read: unlike the prompt itself, this may pass by itself. */
export const FOLDER_TRUST_UNREADABLE_REFUSAL = 'the pane has no readable screen, so a folder-trust prompt cannot be ruled out';

/** The daemon's folder-trust read budget by default (main waits a margin
 *  past it): a person's own launch line or key waits on the read before it
 *  is typed. */
export const FOLDER_TRUST_DEFAULT_BUDGET_MS = 250;

/** The folder-trust read budget for a writer no person waits on (an agent's
 *  message or key, a scheduled prompt, a wake nudge, an automated launch
 *  line) into a pane with no screen: it may wait for a whole-ring parse that
 *  FOLDER_TRUST_DEFAULT_BUDGET_MS would cut. */
export const FOLDER_TRUST_DELIVERY_BUDGET_MS = 1000;
