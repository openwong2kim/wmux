//! ANSI replay of a Rust-engine session (AnsiSnapshotBackend selects it).
//! Grid/cursor/style restoration is separate from partial input-tail handling.
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Grid, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use std::fmt::Write;

/// The rendition `style` gives a default cell.
const RESET: &str = "\x1b[0m";

fn color(out: &mut String, value: Color, foreground: bool) {
    let base = if foreground { 38 } else { 48 };
    match value {
        Color::Spec(rgb) => {
            let _ = write!(out, ";{base};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
        Color::Indexed(index) => {
            let _ = write!(out, ";{base};5;{index}");
        }
        Color::Named(NamedColor::Foreground | NamedColor::Background) => {}
        Color::Named(value) => {
            let index = value as u32;
            if index < 8 {
                let _ = write!(out, ";{}", (if foreground { 30 } else { 40 }) + index);
            } else if index < 16 {
                let _ = write!(out, ";{}", (if foreground { 90 } else { 100 }) + index - 8);
            }
        }
    }
}

fn style(cell: &Cell) -> String {
    let mut out = String::from("\x1b[0");
    for (flag, code) in [
        (Flags::BOLD, 1),
        (Flags::DIM, 2),
        (Flags::ITALIC, 3),
        (Flags::BLINK, 5),
        (Flags::INVERSE, 7),
        (Flags::HIDDEN, 8),
        (Flags::STRIKEOUT, 9),
    ] {
        if cell.flags.contains(flag) {
            let _ = write!(out, ";{code}");
        }
    }
    let underline = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) {
        Some(2)
    } else if cell.flags.contains(Flags::UNDERCURL) {
        Some(3)
    } else if cell.flags.contains(Flags::DOTTED_UNDERLINE) {
        Some(4)
    } else if cell.flags.contains(Flags::DASHED_UNDERLINE) {
        Some(5)
    } else if cell.flags.contains(Flags::UNDERLINE) {
        Some(1)
    } else {
        None
    };
    if let Some(kind) = underline {
        let _ = write!(out, ";4:{kind}");
    }
    color(&mut out, cell.fg, true);
    color(&mut out, cell.bg, false);
    if let Some(value) = cell.underline_color() {
        match value {
            Color::Spec(rgb) => {
                let _ = write!(out, ";58:2::{}:{}:{}", rgb.r, rgb.g, rgb.b);
            }
            Color::Indexed(index) => {
                let _ = write!(out, ";58:5:{index}");
            }
            Color::Named(_) => {}
        }
    }
    out.push('m');
    out
}

fn glyph(out: &mut String, cell: &Cell) {
    // A tab marks the blank cell it started on (for copying); xterm moves the
    // cursor without writing. Replaying it would jump to a tab stop instead.
    out.push(if cell.c == '\t' { ' ' } else { cell.c });
    if let Some(chars) = cell.zerowidth() {
        out.extend(chars);
    }
}

/// An OSC 8 target that replays as written. A control character would end
/// or corrupt the sequence, and a separator would split its parameters.
fn replayable(link: &Hyperlink) -> bool {
    let printable = |c: char| !c.is_control();
    link.uri().chars().all(printable)
        && !link.uri().is_empty()
        && link
            .id()
            .chars()
            .all(|c| printable(c) && c != ':' && c != ';')
}

/// Current rendition and hyperlink of the replay, emitted only on change.
#[derive(Default)]
struct Pen {
    style: String,
    /// The current rendition paints erased and scrolled-in cells.
    colored: bool,
    link: Option<Hyperlink>,
}

impl Pen {
    fn set(&mut self, out: &mut String, cell: &Cell) {
        let style = style(cell);
        if style != self.style {
            out.push_str(&style);
            self.style = style;
            self.colored = cell.bg != Color::Named(NamedColor::Background);
        }
        self.set_link(out, cell.hyperlink().filter(replayable));
    }

    fn set_link(&mut self, out: &mut String, link: Option<Hyperlink>) {
        if link == self.link {
            return;
        }
        match &link {
            Some(link) => {
                let _ = write!(out, "\x1b]8;id={};{}\x1b\\", link.id(), link.uri());
            }
            None => out.push_str("\x1b]8;;\x1b\\"),
        }
        self.link = link;
    }

    fn print(&mut self, out: &mut String, cell: &Cell) {
        self.set(out, cell);
        glyph(out, cell);
    }
}

fn cursor(out: &mut String, pen: &mut Pen, grid: &Grid<Cell>) {
    let point = grid.cursor.point;
    let mut col = point.column.0;
    if grid.cursor.input_needs_wrap
        && grid[point.line][Column(col)]
            .flags
            .contains(Flags::WIDE_CHAR_SPACER)
    {
        col = col.saturating_sub(1);
    }
    let _ = write!(out, "\x1b[{};{}H", point.line.0 + 1, col + 1);
    // CUP clears wrap-pending. Repaint the edge cell to restore that state.
    if grid.cursor.input_needs_wrap {
        pen.print(out, &grid[point.line][Column(col)]);
    }
    // The template carries an open hyperlink into the live output.
    out.push_str(&style(&grid.cursor.template));
    pen.style.clear();
    pen.set_link(out, grid.cursor.template.hyperlink().filter(replayable));
}

/// A cell that may replay as empty: xterm stores erased or never-written
/// cells as empty, which copy and reflow treat as absent, while a printed
/// space is content. Alacritty cannot tell them apart, nor keep the colors a
/// reflow leaves on xterm's empty cells. Attributes a blank does not show
/// (foreground, bold, italic, blink) are dropped with it; visible ones keep it.
fn blank(cell: &Cell) -> bool {
    (cell.c == ' ' || cell.c == '\t')
        && !cell.flags.intersects(
            Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT | Flags::WIDE_CHAR_SPACER,
        )
        && cell.zerowidth().is_none()
        && cell.extra.is_none()
}

/// xterm erases a fullwidth glyph whole when an erase, insert or delete
/// touches either half; Alacritty can leave one half behind, and replaying it
/// would shift the rest of the row. An orphan half becomes the blank its
/// erased partner holds; one whose partner is not blank is refused.
fn whole_glyphs(
    line: &Row<Cell>,
    columns: usize,
    repair: bool,
) -> Result<Option<Vec<Cell>>, &'static str> {
    let mut fixed: Option<Vec<Cell>> = None;
    for x in 0..columns {
        let flags = line[Column(x)].flags;
        let partner = if flags.contains(Flags::WIDE_CHAR) {
            let spacer =
                x + 1 < columns && line[Column(x + 1)].flags.contains(Flags::WIDE_CHAR_SPACER);
            (!spacer).then_some(x + 1)
        } else if flags.contains(Flags::WIDE_CHAR_SPACER) {
            let glyph = x > 0 && line[Column(x - 1)].flags.contains(Flags::WIDE_CHAR);
            (!glyph).then(|| x.wrapping_sub(1))
        } else {
            None
        };
        let Some(partner) = partner else {
            continue;
        };
        // After DCH or ICH the partner may be an unrelated cell, and xterm
        // fills the orphan with the erase attribute: not reproducible.
        let erased = (repair && partner < columns)
            .then(|| &line[Column(partner)])
            .filter(|cell| blank(cell) && !cell.flags.contains(Flags::WIDE_CHAR_SPACER))
            .ok_or("unsupported-wide-half: half a fullwidth glyph next to content")?;
        let cells =
            fixed.get_or_insert_with(|| (0..columns).map(|i| line[Column(i)].clone()).collect());
        let wrap = cells[x].flags & Flags::WRAPLINE;
        cells[x] = Cell {
            bg: erased.bg,
            ..Cell::default()
        };
        cells[x].flags |= wrap;
    }
    Ok(fixed)
}

/// Returns whether the replay leaves a hyperlink open.
fn screen(out: &mut String, grid: &Grid<Cell>, repair: bool) -> Result<bool, &'static str> {
    let mut pen = Pen::default();
    let columns = grid.columns();
    for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        let row = &grid[Line(y)];
        let fixed = whole_glyphs(row, columns, repair)?;
        let line = |x: usize| fixed.as_ref().map_or(&row[Column(x)], |cells| &cells[x]);
        let wrapped = row[grid.last_column()].flags.contains(Flags::WRAPLINE);
        // A soft-wrapped row must reach its last column to wrap again.
        let mut end = columns;
        if !wrapped {
            while end > 0 && blank(line(end - 1)) {
                end -= 1;
            }
            // Blanks left of the cursor are usually printed: a prompt's
            // trailing space, which reads back as part of the prompt.
            if y == grid.cursor.point.line.0 {
                end = end.max(grid.cursor.point.column.0);
            }
        }
        for x in 0..end {
            let cell = line(x);
            // A fullwidth glyph that did not fit wraps by itself on replay,
            // leaving the edge cell empty as xterm does; a printed spacer
            // would turn that cell into content.
            if !cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                pen.print(out, cell);
            }
        }
        // Trailing blanks: skip a default run, erase a colored one with ECH so
        // the cells stay empty but keep their background, as an erase left them.
        let mut x = end;
        while x < columns {
            let bg = line(x).bg;
            let mut run = x;
            while run < columns && line(run).bg == bg {
                run += 1;
            }
            if bg != Color::Named(NamedColor::Background) {
                pen.set(out, line(x));
                let _ = write!(out, "\x1b[{}X", run - x);
            }
            if run < columns {
                let _ = write!(out, "\x1b[{}C", run - x);
            }
            x = run;
        }
        if y < grid.screen_lines() as i32 - 1 && !wrapped {
            // A scroll fills the new row with the current background; clear
            // a colored one first so it paints no cells the grid lacks.
            if pen.colored {
                out.push_str(RESET);
                pen.style = RESET.to_owned();
                pen.colored = false;
            }
            out.push_str("\r\n");
        }
    }
    cursor(out, &mut pen, grid);
    Ok(pen.link.is_some())
}

/// The length of the escape sequence at `data[0] == ESC`, or None while it
/// is unfinished. A string (OSC, DCS, ...) counts only its introducer: an
/// ESC inside one ends it in both parsers, and the rest scans as text. C0
/// controls inside a sequence execute without ending it; ESC, CAN and SUB
/// abort it, which ends it before them.
pub(crate) fn sequence_len(data: &[u8]) -> Option<usize> {
    let csi = data.get(1) == Some(&b'[');
    let mut i = if csi { 2 } else { 1 };
    loop {
        let b = *data.get(i)?;
        match b {
            0x1b | 0x18 | 0x1a => return Some(i.max(1)),
            0x00..=0x1f => {}
            0x20..=0x2f => {}
            0x30..=0x3f if csi => {}
            0x30..=0x7e => return Some(i + 1),
            _ => return Some(i),
        }
        i += 1;
    }
}

/// A C1 control as a UTF-8 code point: xterm executes it, Alacritty prints it.
pub(crate) fn has_c1(data: &[u8]) -> bool {
    data.windows(2)
        .any(|pair| pair[0] == 0xc2 && (0x80..=0x9f).contains(&pair[1]))
}

/// A parameter as xterm reads it: empty is 0, anything else not a number.
fn number(param: &str) -> Option<u32> {
    if param.is_empty() {
        Some(0)
    } else {
        param.parse().ok()
    }
}

/// SGR 53 (overline: Alacritty has none), SGR 21 (xterm's double
/// underline), and color syntax the two parse differently. A color's
/// operands are not attributes: RGB red 53 is not overline.
fn sgr_divergent(params: &str) -> bool {
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    let mut list = params.split(';');
    while let Some(param) = list.next() {
        let mut parts = param.split(':');
        let attribute = number(parts.next().unwrap_or(""));
        let mode = parts.next();
        let colon = mode.is_some();
        match attribute {
            Some(21 | 53) => return true,
            // Colon colors read alike only as `38:5:n` and `38:2:cs:r:g:b`:
            // vte reads `38:2:r:g:b` as r,g,b where xterm reads g,b,0, and
            // leaves the color on `38:5`, which xterm sets to index 0.
            Some(38 | 48 | 58) if colon => {
                let operands: Vec<&str> = parts.collect();
                let readable = match mode {
                    Some("5") => operands.len() == 1 && digits(operands[0]),
                    Some("2") => operands.len() == 4 && operands[1..].iter().all(|v| digits(v)),
                    _ => false,
                };
                if !readable {
                    return true;
                }
            }
            Some(38 | 48 | 58) => {
                let operands = match list.next().and_then(number) {
                    Some(5) => 1,
                    Some(2) => 3,
                    _ => return true,
                };
                for _ in 0..operands {
                    if !list.next().is_some_and(digits) {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// Controls whose parse differs between Alacritty and xterm, so a replay of
/// Alacritty's grid cannot match xterm's (RustAnsiParity.test.ts measures
/// each): charset designators other than ASCII, selective erase, SL/SR,
/// DECIC/DECDC, DECSTR, SU (Alacritty keeps the rows in history), ED 1/2
/// spelled other than `CSI 1 J` / `CSI 2 J`, the modes 9, 20, 45, 47, 66,
/// 1047 and 1048, and SGR 21/53 or malformed colors. `sequence` is complete.
pub(crate) fn divergent(sequence: &[u8]) -> bool {
    // C0 controls inside a sequence execute and are not part of it (rare).
    let filtered: Vec<u8>;
    let mut body = &sequence[1..];
    if body.iter().any(|&b| b < 0x20) {
        filtered = body.iter().copied().filter(|&b| b >= 0x20).collect();
        body = &filtered;
        // The feed gives ED xterm's semantics only in its plain spelling.
        if body.first() == Some(&b'[') && body.last() == Some(&b'J') {
            return true;
        }
    }
    match body.split_first() {
        Some((b'[', rest)) => csi_divergent(rest),
        Some((b'(' | b')', rest)) => rest != b"B",
        Some((b'*' | b'+' | b'-' | b'.' | b'/', _)) => true,
        // DECALN: Alacritty fills the screen but leaves the cursor in place.
        Some((b'#', rest)) => rest == b"8",
        _ => false,
    }
}

fn csi_divergent(rest: &[u8]) -> bool {
    let Some((&last, head)) = rest.split_last() else {
        return false;
    };
    let (private, head) = match head.split_first() {
        Some((&marker, tail)) if b"<=>?".contains(&marker) => (Some(marker), tail),
        _ => (None, head),
    };
    let split = head
        .iter()
        .position(|b| (0x20..=0x2f).contains(b))
        .unwrap_or(head.len());
    let (params, intermediates) = head.split_at(split);
    let params = std::str::from_utf8(params).unwrap_or("");
    match (private, intermediates, last) {
        (Some(b'?'), b"", b'J' | b'K') => true,
        (None, b" ", b'@' | b'A') | (None, b"'", b'}' | b'~') | (None, b"!", b'p') => true,
        // SU keeps rows in Alacritty's history; Alacritty ignores SD as `CSI ^`.
        (None, b"", b'S' | b'^') => true,
        (Some(b'?'), b"", b'h' | b'l') => {
            let mut modes = params.split(';').map(number);
            // vte leaves a synchronized update only on exactly `CSI ? 2026 l`.
            params != "2026" && modes.clone().any(|mode| mode == Some(2026))
                || modes.any(|mode| matches!(mode, Some(3 | 9 | 45 | 66 | 47 | 1047 | 1048)))
        }
        (None, b"", b'h' | b'l') => params.split(';').any(|mode| number(mode) == Some(20)),
        (None, b"", b'J') => {
            let first = number(params.split([';', ':']).next().unwrap_or(""));
            matches!(first, Some(1 | 2)) && params != "1" && params != "2"
        }
        (None, b"", b'm') => sgr_divergent(params),
        _ => false,
    }
}

/// `repair_wide`: whether a half-erased fullwidth glyph may be replayed as
/// the blank its erased partner holds (the stream shifted no cells).
pub fn serialize(term: &Term<VoidListener>, repair_wide: bool) -> Result<String, &'static str> {
    // xterm can retain half a wide glyph when clipping the cursor paragraph.
    // Printing that glyph would wrap instead. Refuse instead of corrupting it.
    for grid in [term.grid(), term.inactive_grid()] {
        for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
            if grid[Line(y)][grid.last_column()]
                .flags
                .contains(Flags::WIDE_CHAR)
            {
                return Err("unsupported-wide-edge: clipped fullwidth glyph requires raw replay");
            }
        }
        // xterm clamps a restored cursor into the last column and drops the
        // pending wrap; Alacritty keeps it, so the next glyph lands a row lower.
        // A cursor saved while wrap was pending may already have diverged.
        if grid.saved_cursor.input_needs_wrap {
            return Err("unsupported-saved-wrap: cursor saved with a pending wrap");
        }
    }
    let mut out = String::from("\x1b[0m\x1b[?6l\x1b[?7h\x1b[4l\x1b[H");
    let modes = term.mode();
    if modes.contains(TermMode::ALT_SCREEN) {
        // DECSC on entry saves the primary template, open hyperlink included,
        // as it did live; the alternate grid then starts without one.
        let linked = screen(&mut out, term.inactive_grid(), repair_wide)?;
        out.push_str("\x1b[?1049h\x1b[0m\x1b[H");
        if linked {
            out.push_str("\x1b]8;;\x1b\\");
        }
    }
    screen(&mut out, term.grid(), repair_wide)?;
    for (mode, code) in [
        (TermMode::APP_CURSOR, 1),
        (TermMode::ORIGIN, 6),
        (TermMode::FOCUS_IN_OUT, 1004),
        (TermMode::BRACKETED_PASTE, 2004),
    ] {
        if modes.contains(mode) {
            let _ = write!(out, "\x1b[?{code}h");
        }
    }
    if modes.contains(TermMode::INSERT) {
        out.push_str("\x1b[4h");
    }
    if modes.contains(TermMode::APP_KEYPAD) {
        out.push_str("\x1b=");
    }
    if !modes.contains(TermMode::LINE_WRAP) {
        out.push_str("\x1b[?7l");
    }
    out.push_str(if modes.contains(TermMode::SHOW_CURSOR) {
        "\x1b[?25h"
    } else {
        "\x1b[?25l"
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::serialize;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::Processor;

    struct Size(usize, usize);
    impl Dimensions for Size {
        fn total_lines(&self) -> usize {
            self.1
        }
        fn screen_lines(&self) -> usize {
            self.1
        }
        fn columns(&self) -> usize {
            self.0
        }
    }

    fn replay(cols: usize, bytes: &str) -> Result<String, &'static str> {
        let mut term = Term::new(Config::default(), &Size(cols, 3), VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, bytes.as_bytes());
        serialize(&term, true)
    }

    use super::{divergent, has_c1, sequence_len};

    fn classify(text: &str) -> Vec<bool> {
        let bytes = text.as_bytes();
        let mut found = Vec::new();
        let mut at = 0;
        while let Some(offset) = bytes[at..].iter().position(|&b| b == 0x1b) {
            at += offset;
            let len = sequence_len(&bytes[at..]).expect("complete sequence");
            found.push(divergent(&bytes[at..at + len]));
            at += len;
        }
        found
    }

    #[test]
    fn accepted_controls_replay_on_rust() {
        for text in [
            "\x1b]0;\u{2733} Claude Code\x07",
            "\x1b]8;;https://e.com\x1b\\",
            "\x1b7\x1b8",
            "\x1b[s\x1b[u",
            "\x1b[>1u\x1b[?u\x1b[<u\x1b[=1;1u",
            "\x1bH\x1b[3g\x1b[g",
            "\x1b[5 q\x1b[>0q\x1b[1q\x1b[1\"q",
            "\x1b(B\x1b)B",
            "\x1b[55m\x1b[5m",
            "\x1b[38;5;53m\x1b[48;2;53;55;6m\x1b[38:2::53:55:5m",
            "\x1b[?1049h\x1b[?2004h\x1b[?1006h\x1b[4h\x1b[0J\x1b[J\x1b[3J",
            "\x1b[2T\x1b[?2;1S",
        ] {
            assert!(classify(text).iter().all(|d| !d), "{text:?}");
        }
        assert!(!has_c1("\u{2733}\u{d55c}".as_bytes()));
    }

    #[test]
    fn divergent_controls_stay_on_xterm() {
        for text in [
            "\x1b(0",
            "\x1b)0",
            "\x1b(A",
            "\x1b(%5",
            "\x1b*0",
            "\x1b+B",
            "\x1b-A",
            "\x1b[?2J",
            "\x1b[?K",
            "\x1b[2 @",
            "\x1b[ A",
            "\x1b[2'}",
            "\x1b['~",
            "\x1b[!p",
            "\x1b[2S",
            "\x1b[20h",
            "\x1b[?9h",
            "\x1b[?1;45h",
            "\x1b[?66h",
            "\x1b[?47h",
            "\x1b[?1047l",
            "\x1b[?1048h",
            "\x1b[02J",
            "\x1b[2;0J",
            "\x1b[1:1J",
            "\x1b[53m",
            "\x1b[21m",
            "\x1b[38;2;1;2;3;53m",
            "\x1b[38;2;53m",
            "\x1b[38;5m",
            "\x1b[38;7;1m",
            "\x1b[?3h",
            "\x1b[?3l",
            "\x1b[?2026;1l",
            "\x1b[?1;2026h",
            "\x1b[1^",
            "\x1b#8",
            "\x1b[38:2:1:2:3m",
            "\x1b[48:2:1:2:3m",
            "\x1b[38:5m",
            "\x1b[38:2:1:2m",
            "\x1b[38:2::1:2m",
            "\x1b[38:5:1:2m",
            "\x1b[38:7:1m",
            "\x1b[?01047h",
            "\x1b[?2026;0h",
            "\x1b[020h",
            "\x1b[2\x00J",
            "\x1b[1\nJ",
        ] {
            let found = classify(text);
            assert!(found.iter().any(|&d| d), "{text:?}");
        }
        assert!(has_c1("a\u{9b}31m".as_bytes()));
    }

    #[test]
    fn unfinished_sequences_wait_for_more_bytes() {
        for text in ["\x1b", "\x1b[", "\x1b[38;2;1", "\x1b(", "\x1b[ "] {
            assert_eq!(sequence_len(text.as_bytes()), None, "{text:?}");
        }
        // ESC aborts a sequence in progress, which ends before it.
        assert_eq!(sequence_len(b"\x1b[3\x1b[m"), Some(3));
        assert_eq!(sequence_len(b"\x1b\x1b"), Some(1));
    }

    #[test]
    fn trailing_blanks_stay_empty_cells() {
        let out = replay(10, "ab   \r\ncd").unwrap();
        assert!(out.contains("\x1b[0mab\r\ncd"), "{out:?}");
    }

    #[test]
    fn blanks_before_the_cursor_stay_printed() {
        let out = replay(10, "ab\r\n$ ").unwrap();
        assert!(out.contains("ab\r\n$ \r\n"), "{out:?}");
    }

    #[test]
    fn colored_erase_replays_as_erase() {
        let out = replay(10, "abc\x1b[44m\x1b[K").unwrap();
        assert!(out.contains("abc\x1b[0;44m\x1b[7X"), "{out:?}");
    }

    #[test]
    fn tab_cells_replay_as_blanks() {
        let out = replay(20, "a\tb").unwrap();
        assert!(!out.contains('\t') && out.contains("a       b"), "{out:?}");
    }

    #[test]
    fn hyperlinks_are_restored_and_closed() {
        let out = replay(20, "\x1b]8;id=k;http://e.com\x07link\x1b]8;;\x07 x").unwrap();
        assert!(
            out.contains("\x1b]8;id=k;http://e.com\x1b\\link\x1b]8;;\x1b\\ x"),
            "{out:?}"
        );
    }

    #[test]
    fn hyperlinks_with_controls_are_dropped() {
        let out = replay(20, "\x1b]8;;http://e.com/\u{85}\x07link").unwrap();
        assert!(!out.contains("\x1b]8;id"), "{out:?}");
    }

    #[test]
    fn fullwidth_wrap_leaves_the_edge_empty() {
        let out = replay(4, "abc\u{4e2d}").unwrap();
        assert!(out.contains("abc\u{4e2d}"), "{out:?}");
    }

    #[test]
    fn an_orphan_glyph_half_replays_as_the_erased_blank() {
        // ECH on the first half: b stays in column 3, not 2.
        let out = replay(10, "a\u{4e2d}b\x1b[1;2H\x1b[X").unwrap();
        assert!(out.contains("\x1b[0ma  b"), "{out:?}");
        // EL0 on the second half erases the glyph whole (the blank left of
        // the cursor replays as printed).
        let out = replay(10, "a\u{4e2d}b\x1b[1;3H\x1b[K").unwrap();
        assert!(out.contains("\x1b[0ma \r\n"), "{out:?}");
        assert!(!out.contains('\u{4e2d}'), "{out:?}");
        // DCH pulls the second half next to content: refused.
        let err = replay(10, "a\u{4e2d}b\x1b[1;2H\x1b[P").unwrap_err();
        assert!(err.starts_with("unsupported-wide-half"));
        // Next to a blank too: xterm fills it with the erase attribute.
        let mut term = Term::new(Config::default(), &Size(10, 3), VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, " \u{4e2d}b\x1b[44m\x1b[1;2H\x1b[P".as_bytes());
        assert!(serialize(&term, false)
            .unwrap_err()
            .starts_with("unsupported-wide-half"));
    }

    #[test]
    fn cursor_saved_with_pending_wrap_is_refused() {
        let err = replay(4, "abcd\x1b7\x1b[H").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
        let err = replay(4, "abcd\x1b[?1049h").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
    }
}
