// Quiet recovery reads a parsed viewport, not a byte stream. Every predicate
// requires interactive choices at the bottom; a quoted question alone is not
// evidence that the agent is currently asking for permission.
import { parseTerminalPrompt } from '../../daemon/approvals/terminalPromptParse';
import { screenReaderKeyRow } from '../../daemon/approvals/screenReaderKeyRow';
import { readFolderTrustScreen } from '../../daemon/approvals/approvalKeystrokes';

export interface ScreenApproval {
  text: string;
  message: string;
}

function rowsAtBottom(rows: readonly string[]): string[] {
  return rows.map((row) => row.replace(/[│║┃╭╮╯╰┌┐┘└]/g, ' ').trim()).filter(Boolean);
}

export function claudeScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const prompt = parseTerminalPrompt(rows);
  if (prompt?.active) return { text: prompt.question.replace(/\s+/g, ''), message: 'Approval requested' };
  // Unnumbered Yes/No choices, `No, exit` first. A narrow pane wraps the
  // question, so its fixed start is also the text: a resize is no new dialog.
  const trust = 'Quick safety check:';
  if (choiceDialog(rows, /^Quick safety check:/, /^Enter to confirm · Esc to cancel$/)) return { text: trust, message: 'Project trust prompt' };
  // Claude Code's screen-reader layout ends every dialog with a key row and
  // draws no cursor (screenReaderKeyRow). Its trust dialog is read like the
  // input guard reads it; any other dialog there owns the keys too, whether
  // or not a reader above names it.
  const key = screenReaderKeyRow(rows);
  if (!key) return null;
  if (key.keys === 'y/n' && readFolderTrustScreen(rows) !== null) return { text: trust, message: 'Project trust prompt' };
  return { text: screenReaderQuestion(key.lines, key.at).replace(/\s+/g, ''), message: 'Approval requested' };
}

/**
 * A screen-reader dialog's question: the row right above its option 1, or,
 * when that row is the lower-case tail Ink broke off a long question, the rows
 * from the nearest of the two above it that starts one (`> Which …?`, `Do you
 * want to …`). With no option 1, the key row itself.
 */
function screenReaderQuestion(lines: readonly string[], at: number): string {
  let first = at - 1;
  while (first >= 0 && !/^1[.)]\s/.test(lines[first]!.trim())) first--;
  if (first <= 0) return lines[at]!.trim();
  let start = first - 1;
  if (!/^(?:[A-Z]|> )/.test(lines[start]!.trim())) {
    for (let i = first - 2; i >= Math.max(0, first - 3); i--) {
      if (/^(?:> |Do you want to )/.test(lines[i]!.trim())) { start = i; break; }
    }
  }
  return lines.slice(start, first).map((row) => row.trim()).join(' ').replace(/^> /, '');
}

/** A dialog's choice rows: `option` is one choice, `selected` marks exactly
 *  one of them, and every `required` choice must be offered. */
interface ChoiceRows {
  option: RegExp;
  selected: RegExp;
  required: readonly RegExp[];
}

const YES_NO_CHOICES: ChoiceRows = {
  option: /^[❯›>]?\s*(?:\d+[.)]\s*)?(?:Yes|No)\b/i,
  selected: /^[❯›>]/,
  required: [/\bYes\b/i, /\bNo\b/i],
};

/** Codex 0.162.1 folder-trust choices (live capture): numbered, the first is to trust. */
const CODEX_TRUST_CHOICES: ChoiceRows = {
  option: /^›?\s*\d+\.\s+\S/,
  selected: /^›/,
  required: [/^›?\s*\d+\.\s+Trust and continue$/],
};

function choiceDialog(rows: readonly string[], question: RegExp, footer: RegExp, choice: ChoiceRows = YES_NO_CHOICES): string | null {
  const tail = rowsAtBottom(rows);
  if (!footer.test(tail.at(-1) ?? '')) return null;
  let q = -1;
  for (let i = tail.length - 2; i >= 0; i--) {
    if (question.test(tail[i] ?? '')) { q = i; break; }
  }
  if (q < 0) return null;
  const body = tail.slice(q + 1, -1);
  const { option, selected, required } = choice;
  const choices = body.filter((row) => option.test(row));
  if (choices.length < 2 || choices.filter((row) => selected.test(row)).length !== 1) return null;
  if (!required.every((needed) => choices.some((row) => needed.test(row)))) return null;
  // A command body may precede the choices. Nothing except choices may
  // follow the first one; subsequent agent output means this is old text.
  const first = body.findIndex((row) => option.test(row));
  if (!body.slice(first).every((row) => option.test(row))) return null;
  return tail[q] ?? null;
}

export function agyScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const text = choiceDialog(rows, /^Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+project\?$/,
    /^(?:↑\/↓|↑↓)\s+Navigate\s*[·•]\s*enter\s+Confirm$/i);
  return text ? { text, message: 'Project trust prompt' } : null;
}

/** What a Pi choice row starts with once piSelectorRows has read its indent. */
const PI_CHOICE = '◦';
const PI_TRUST_CHOICES: ChoiceRows = {
  option: new RegExp(`^[→${PI_CHOICE}] (?:Trust|Do not trust)\\b`),
  selected: /^→/,
  required: [new RegExp(`^[→${PI_CHOICE}] Trust\\b`), new RegExp(`^[→${PI_CHOICE}] Do not trust\\b`)],
};

/**
 * Pi's selector rows as choiceDialog reads them. Pi 1.4.0 indents a choice by
 * three cells (` → ` on the selected one) and its key footer by one, and in a
 * narrow pane wraps either onto rows indented by one (44-column capture): those
 * rows are joined back onto the choice or footer above. A choice is known by
 * its indent, which the trim in choiceDialog would lose, so an unselected one
 * is marked with PI_CHOICE: a wrapped path row reading `Trust-repo/…` is no
 * choice. Frame rules are dropped.
 */
function piSelectorRows(rows: readonly string[]): string[] {
  const out: string[] = [];
  let joinable = false;
  for (const row of rows) {
    if (!row.trim() || /^\s*─+\s*$/.test(row)) { joinable = false; continue; }
    if (joinable && /^ [^\s→]/.test(row) && !row.startsWith(' ↑↓ ')) {
      out[out.length - 1] += ` ${row.trim()}`;
      continue;
    }
    const unselected = /^ {3}\S/.test(row);
    out.push(unselected ? `${PI_CHOICE} ${row.trim()}` : row);
    joinable = unselected || /^ (?:→ |↑↓ )/.test(row);
  }
  return out;
}

/** Pi 1.4.0 project-trust selector (live capture): one `→` choice, then a key footer. */
export function piScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const text = choiceDialog(piSelectorRows(rows), /^Trust project folder\?$/,
    /^↑↓ navigate\s+enter select\s+escape\/ctrl\+c cancel$/, PI_TRUST_CHOICES);
  return text ? { text, message: 'Project trust prompt' } : null;
}

const QWEN_CHOICES: ChoiceRows = {
  option: /^(?:›\s*)?\d+\.\s+\S/,
  selected: /^›/,
  required: [/^(?:›\s*)?1\.\s+Yes\b/, /\bNo\b/],
};
/** The spinner row that ends every Qwen permission dialog, without the counters a running turn adds. */
const QWEN_DIALOG_END = /^[\u2800-\u28ff]\s*Waiting\s+for\s+user\s+confirmation\.\.\.$/;

/**
 * Qwen Code 0.26.1 permission dialogs (shell, file write and edit; 120 and 60
 * columns): the question, numbered choices with `›` on the selected one, and
 * the confirmation spinner row as the last row. A long shell question is cut
 * with `…` rather than wrapped. Just after it is drawn a narrow pane can show
 * a scrollbar thumb in its last column; that cell is dropped. The text is the
 * spinner row's words, the value the line pattern reports, so a recheck after
 * the stream has already reported the dialog does not report it twice.
 */
export function qwenScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const cleaned = rows.map((row) => row.replace(/\s*[\u2580-\u259f]$/, ''));
  if (!choiceDialog(cleaned, /^(?:Allow execution of: .+[?…]|Apply this change\?)$/, QWEN_DIALOG_END, QWEN_CHOICES)) return null;
  return { text: 'Waiting for user confirmation...', message: 'Approval requested' };
}

/**
 * Codex 0.157.1 command/edit fixtures: numbered choices and a final key hint.
 * The 0.162.1 folder-trust screen (live capture) has the same shape; its
 * question row goes on with the explanation.
 */
export function codexScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const text = choiceDialog(rows, /^Would you like to (?:run the following command|make the following edits)\?$/,
    /^Press enter to confirm or esc to cancel$/i);
  if (text) return { text, message: 'Approval requested' };
  // The question row's fixed start is the text: its wrap changes with the width.
  const trust = 'Trust this folder?';
  return choiceDialog(rows, /^Trust this folder\?(?:$| Codex\b)/, /^enter continue · esc back$/, CODEX_TRUST_CHOICES)
    ? { text: trust, message: 'Directory trust prompt' } : null;
}

/**
 * Gemini CLI and Qwen Code folder-trust dialogs (live captures, the
 * folder-trust fixtures): read with the input guard's own reader, so the
 * notice and the refusal to type into the dialog see the same screen. A pane
 * too narrow to read the choices still shows the dialog. The text is fixed:
 * the question wraps differently at every width, and a resize is no new dialog.
 */
export function folderTrustScreenApproval(rows: readonly string[]): ScreenApproval | null {
  return readFolderTrustScreen(rows) === null ? null : { text: 'Do you trust this folder?', message: 'Folder trust prompt' };
}

/** OpenCode 1.18.30 permission fixture: horizontal choices with a key footer. */
export function openCodeScreenApproval(rows: readonly string[]): ScreenApproval | null {
  const tail = rowsAtBottom(rows).slice(-12);
  const footer = /^Allow once\s+Allow always\s+Reject\s+ctrl\+f fullscreen\s+⇆ select\s+enter confirm$/i;
  if (!footer.test(tail.at(-1) ?? '') || !tail.includes('△ Permission required')) return null;
  return { text: '△ Permission required', message: 'Permission requested' };
}
