/**
 * Claude Code 2.1.312 with its OSC 7501 query answered: the query, every
 * report and every window title it wrote in one recorded session, in order,
 * with the milliseconds since spawn and what the session was doing. The query
 * chunk is kept whole (Claude sends DA1 right behind it); the rest of the
 * capture is screen output. Answered, Claude's titles carry no spinner or
 * idle glyph (`Claude Code`, not `✳ Claude Code`).
 *
 * The session: boot, a one-word turn, then a turn that asks to run a shell
 * command, which is declined with Esc, then `/exit`.
 */
const report = (body: string) => `\x1b]7501;${body}\x07`;

export const CLAUDE_2_1_312_SESSION = [
  { at: 1027, step: 'boot', bytes: '\x1b]0;✳ Claude Code\x07' },
  { at: 1620, step: 'query', bytes: '\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c' },
  { at: 1735, step: 'boot', bytes: `${report('state=idle:app=claude-code')}\x1b]0;Claude Code\x07` },
  // 8495: the first prompt is submitted.
  { at: 8703, step: 'turn 1', bytes: report('state=working:app=claude-code') },
  { at: 10005, step: 'turn 1', bytes: '\x1b]0;Greeting exchange\x07' },
  { at: 10320, step: 'turn 1 ends', bytes: report('state=done:app=claude-code') },
  // 12420: the second prompt is submitted.
  { at: 12476, step: 'turn 2', bytes: report('state=working:app=claude-code') },
  // msg: "approve Bash: touch probe.txt"
  { at: 13484, step: 'approval box', bytes: report('state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNoOiB0b3VjaCBwcm9iZS50eHQ=') },
  // 15128: declined with Esc.
  { at: 15263, step: 'declined', bytes: report('state=idle:app=claude-code') },
  // 17236: `/exit` is submitted.
  { at: 17257, step: 'exit', bytes: report('state=working:app=claude-code') },
  { at: 17279, step: 'exit', bytes: `${report('state=clear')}\x1b]0;\x07` },
] as const;
