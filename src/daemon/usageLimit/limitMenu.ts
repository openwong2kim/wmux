// Claude Code's usage-limit menu, told apart strictly enough for the daemon to
// press Escape on it with nobody at the pane (a headless session, see
// a2aRemote/headlessDelivery.ts). Real captures at 80x24 are the fixtures.
//
// The menu is the last thing drawn:
//
//      What do you want to do?
//
//      ❯ 1. Stop and wait for limit to reset
//        2. Wait here, then continue automatically at <time>   (later "shortly")
//        3. Ask your admin for more usage                       (differs by plan)
//
//      Enter to confirm · Esc to cancel
//
// It is matched by its header, its footer and its first two rows. Row 2's tail
// is redrawn in place over time, so only its start counts; row 3 and any row
// after it differ by plan and are only required to be numbered options.

const HEADER = 'What do you want to do?';
const FOOTER = 'Enter to confirm · Esc to cancel';
const ROW_1 = '1. Stop and wait for limit to reset';
const ROW_2_START = '2. Wait here, then continue automatically';
/** A numbered option row, with or without the selection glyph. */
const OPTION_ROW = /^(?:❯\s*)?(\d+)\.\s\S/;

/**
 * Whether the screen's last drawn rows are exactly the usage-limit menu: its
 * footer last, its header above, and between them only numbered options (an
 * option a narrow pane wrapped goes on in rows indented past its number), the
 * first two being the limit menu's own.
 */
export function usageLimitMenuOnScreen(rows: readonly string[]): boolean {
  const lines = rows.map((r) => r.replace(/\s+$/, ''));
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]!.trim()) end--;
  if (end < 0 || lines[end]!.trim() !== FOOTER) return false;
  let head = end - 1;
  while (head >= 0 && lines[head]!.trim() !== HEADER) head--;
  if (head < 0) return false;
  const options: Array<{ col: number; text: string }> = [];
  for (const line of lines.slice(head + 1, end)) {
    const text = line.trim();
    if (!text) continue;
    const option = OPTION_ROW.exec(text);
    if (option) {
      options.push({ col: line.indexOf(`${option[1]}.`), text: text.replace(/^❯\s*/, '') });
      continue;
    }
    // A wrapped option's next row: indented past its number.
    const last = options.at(-1);
    if (!last || line.length - line.trimStart().length <= last.col) return false;
    last.text += ` ${text}`;
  }
  return options.length >= 2 && options[0]!.text === ROW_1 && options[1]!.text.startsWith(ROW_2_START);
}
