//! ANSI replay of a Rust-engine session (AnsiSnapshotBackend selects it).
//! Grid/cursor/style restoration is separate from partial input-tail handling.
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Grid, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{CharsetIndex, Color, NamedColor, StandardCharset};
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
        let mut end = columns;
        // A soft-wrapped row must reach its last column to wrap again, so its
        // blanks print: Alacritty cannot tell a printed blank from an empty
        // cell. Only the empty cells a widen gave the row, or an erase left at
        // its edge, are known (the grid marks them): printed, they would
        // become content, so print filler through the edge instead and erase
        // it, each run with its own background, once the row wrapped.
        let empty = row
            .empty_from()
            .filter(|_| wrapped && y < grid.screen_lines() as i32 - 1);
        if let Some(from) = empty {
            while end > from && blank(line(end - 1)) {
                end -= 1;
            }
        } else if !wrapped {
            while end > 0 && blank(line(end - 1)) {
                end -= 1;
            }
        }
        // Blanks left of the cursor are usually printed: a prompt's
        // trailing space, which reads back as part of the prompt. Not past a
        // widen's mark: a blank printed there would have moved it.
        if y == grid.cursor.point.line.0 && !wrapped {
            end = end.max(grid.cursor.point.column.0);
        }
        let filler = empty.is_some() && end < columns;
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
            } else if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) && x + 1 < columns {
                // A widen left that spacer inside the row: xterm's cell there
                // is empty, so step over it.
                out.push_str("\x1b[C");
            }
        }
        if filler {
            // Neither the filler nor a scroll its wrap causes paints anything.
            pen.set(out, &Cell::default());
            // One more than fits lands on the next row's head and wraps it;
            // erase that one, then go back up to the filler.
            out.extend(std::iter::repeat_n('-', columns - end + 1));
            out.push_str("\x1b[D\x1b[X\x1b[A\r");
            // An erase can empty the whole row (`end` 0), and CUF 0 moves one.
            if end > 0 {
                let _ = write!(out, "\x1b[{end}C");
            }
        }
        // Trailing blanks: skip a default run, erase a colored one with ECH so
        // the cells stay empty but keep their background, as an erase left them.
        // Over filler, erase every run, each with its own background.
        let mut x = end;
        while x < columns {
            let bg = line(x).bg;
            let mut run = x;
            while run < columns && line(run).bg == bg {
                run += 1;
            }
            if filler {
                pen.set(
                    out,
                    &Cell {
                        bg,
                        ..Cell::default()
                    },
                );
                let _ = write!(out, "\x1b[{}X", run - x);
            } else if bg != Color::Named(NamedColor::Background) {
                pen.set(out, line(x));
                let _ = write!(out, "\x1b[{}X", run - x);
            }
            if run < columns {
                let _ = write!(out, "\x1b[{}C", run - x);
            }
            x = run;
        }
        if filler {
            // Down to the wrapped row's head, where the next row prints.
            out.push_str("\r\x1b[B");
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
    c1_at(data).is_some()
}

/// Where the first C1 control (as a UTF-8 code point) starts in `data`.
pub(crate) fn c1_at(data: &[u8]) -> Option<usize> {
    data.windows(2)
        .position(|pair| pair[0] == 0xc2 && (0x80..=0x9f).contains(&pair[1]))
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

/// An escape vte does not run as xterm.js does, which the feed applies itself
/// (native_core.rs `run_like_xterm`), in its plain spelling only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum XtermControl {
    /// LS2 `ESC n`, LS3 `ESC o`, LS3R `ESC |`, LS2R `ESC }`, LS1R `ESC ~`:
    /// xterm's setgLevel (vte has none of them).
    Shift(CharsetIndex),
    /// `ESC % @` and `ESC % G`: xterm's selectDefaultCharset, ASCII in G0 and
    /// G0 shifted in.
    DefaultCharset,
    /// `ESC -` and `ESC .` with `B` or `0`: xterm designates G1 and G2 (vte
    /// only designates through `(` to `+`).
    Designate(CharsetIndex, StandardCharset),
    /// DECSTR `CSI ! p`: xterm's softReset (vte has none).
    SoftReset,
}

/// The control `sequence` spells exactly, if it is one the feed runs itself.
pub(crate) fn xterm_control(sequence: &[u8]) -> Option<XtermControl> {
    let charset = |final_byte: u8| match final_byte {
        b'B' => Some(StandardCharset::Ascii),
        b'0' => Some(StandardCharset::SpecialCharacterAndLineDrawing),
        _ => None,
    };
    Some(match sequence.strip_prefix(b"\x1b")? {
        b"n" | b"}" => XtermControl::Shift(CharsetIndex::G2),
        b"o" | b"|" => XtermControl::Shift(CharsetIndex::G3),
        b"~" => XtermControl::Shift(CharsetIndex::G1),
        b"%@" | b"%G" => XtermControl::DefaultCharset,
        [b'-', last] => XtermControl::Designate(CharsetIndex::G1, charset(*last)?),
        [b'.', last] => XtermControl::Designate(CharsetIndex::G2, charset(*last)?),
        b"[!p" => XtermControl::SoftReset,
        _ => return None,
    })
}

/// `sequence` without the C0 controls inside it, which execute and are not
/// part of it (rare); None when it has none.
fn without_c0(sequence: &[u8]) -> Option<Vec<u8>> {
    sequence[1..].iter().any(|&b| b < 0x20).then(|| {
        sequence[..1]
            .iter()
            .chain(sequence[1..].iter().filter(|&&b| b >= 0x20))
            .copied()
            .collect()
    })
}

/// IND, NEL, ED 1/2 or a control in `xterm_control`, spelled without C0:
/// the feed gives these xterm's semantics only in their plain spelling.
fn run_by_the_feed(plain: &[u8]) -> bool {
    let body = &plain[1..];
    body == b"D"
        || body == b"E"
        || (body.first() == Some(&b'[') && body.last() == Some(&b'J'))
        || xterm_control(plain).is_some()
}

/// Controls whose parse differs between Alacritty and xterm, so a replay of
/// Alacritty's grid cannot match xterm's (RustAnsiParity.test.ts measures
/// each): a designation into G0-G3 other than ASCII or DEC line drawing,
/// selective erase, SL/SR, DECIC/DECDC, DECSTR with parameters, SD spelled
/// `CSI ^` (vte ignores it), ED 1/2 spelled other than `CSI 1 J` /
/// `CSI 2 J`, the modes 2, 9, 20, 45, 47, 66, 1047 and 1048, SGR 21/53 or
/// malformed colors, and a control the feed runs as xterm does
/// (`run_by_the_feed`) with a C0 control inside. `sequence` is complete.
pub(crate) fn divergent(sequence: &[u8]) -> bool {
    let filtered = without_c0(sequence);
    if filtered.as_deref().is_some_and(run_by_the_feed) {
        return true;
    }
    let body = filtered.as_deref().unwrap_or(sequence);
    match body[1..].split_first() {
        Some((b'[', rest)) => csi_divergent(rest),
        // ASCII and DEC line drawing replay alike in G0-G3 (vte designates
        // through `(` to `+`, the feed `-` and `.`). Any other final is
        // refused: the national sets in xterm's table are not in vte's.
        // xterm skips `/`.
        Some((b'(' | b')' | b'*' | b'+' | b'-' | b'.', rest)) => rest != b"B" && rest != b"0",
        // DECALN: Alacritty fills the screen but leaves the cursor in place.
        Some((b'#', rest)) => rest == b"8",
        _ => false,
    }
}

/// The refusal a divergent `sequence` is reported as. Its family (the
/// `unsupported-state-*` token before the colon) is the key the daemon counts
/// fallbacks under (`wmux doctor --performance`), so the controls that send
/// panes to the xterm path can be told apart.
pub(crate) fn refusal(sequence: &[u8]) -> &'static str {
    let filtered = without_c0(sequence);
    if filtered.as_deref().is_some_and(run_by_the_feed) {
        return "unsupported-state-c0-inside: a C0 control inside a control the snapshot runs as xterm does";
    }
    let body = filtered.as_deref().unwrap_or(sequence);
    match body[1..].split_first() {
        Some((b'(' | b')' | b'*' | b'+' | b'-' | b'.', _)) => {
            "unsupported-state-charset: a character set other than ASCII or DEC line drawing"
        }
        Some((b'#', _)) => "unsupported-state-decaln: DECALN",
        Some((b'[', rest)) => match rest.last() {
            Some(b'h' | b'l') => "unsupported-state-mode: a mode Alacritty sets differently",
            Some(b'm') => "unsupported-state-sgr: an SGR attribute or color Alacritty reads differently",
            Some(b'J' | b'K') => "unsupported-state-erase: selective erase, or ED spelled other than CSI 1 J / CSI 2 J",
            Some(b'b') => "unsupported-state-rep: REP after a control",
            Some(b'p') => "unsupported-state-decstr: DECSTR with parameters",
            _ => "unsupported-state-csi: SL, SR, DECIC, DECDC or SD spelled CSI ^",
        },
        _ => "unsupported-state-esc: an escape Alacritty parses differently",
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
        (None, b" ", b'@' | b'A') | (None, b"'", b'}' | b'~') => true,
        // The feed runs DECSTR itself, spelled without parameters.
        (None, b"!", b'p') => !params.is_empty(),
        // vte does not dispatch SD spelled `CSI ^`, which xterm runs.
        (None, b"", b'^') => true,
        (Some(b'?'), b"", b'h' | b'l') => {
            let mut modes = params.split(';').map(number);
            // vte leaves a synchronized update only on exactly `CSI ? 2026 l`.
            // xterm's DECSET 2 (DECANM) puts ASCII in G0-G3; vte ignores it.
            params != "2026" && modes.clone().any(|mode| mode == Some(2026))
                || modes.any(|mode| matches!(mode, Some(2 | 3 | 9 | 45 | 66 | 47 | 1047 | 1048)))
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
    // The inactive grid is the primary screen only while the alternate one is
    // shown. Otherwise it is a left alternate screen: xterm cleared its cells,
    // and the payload carries none of it (nor its saved cursor, which both
    // terminals keep and check again once that screen is shown).
    let grids = [term.grid(), term.inactive_grid()];
    let shown = if term.mode().contains(TermMode::ALT_SCREEN) {
        2
    } else {
        1
    };
    for grid in &grids[..shown] {
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
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::cell::Flags;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor};

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
            "\x1b(0\x1b)0",
            // G2/G3 as ASCII or DEC line drawing, and `ESC /`, which xterm
            // skips (the feed runs `-`, `.`, the locking shifts, `ESC %` and
            // DECSTR itself: xterm_control).
            "\x1b*0\x1b+B\x1b/A",
            "\x1b[55m\x1b[5m",
            "\x1b[38;5;53m\x1b[48;2;53;55;6m\x1b[38:2::53:55:5m",
            "\x1b[?1049h\x1b[?2004h\x1b[?1006h\x1b[4h\x1b[0J\x1b[J\x1b[3J",
            "\x1b[2T\x1b[?2;1S",
            "\x1b[S\x1b[2S",
        ] {
            assert!(classify(text).iter().all(|d| !d), "{text:?}");
        }
        assert!(!has_c1("\u{2733}\u{d55c}".as_bytes()));
    }

    #[test]
    fn divergent_controls_stay_on_xterm() {
        for text in [
            "\x1b(A",
            "\x1b)=",
            "\x1b(X",
            "\x1b(%5",
            "\x1b*K",
            "\x1b+7",
            "\x1b-A",
            "\x1b.R",
            "\x1b\x07n",
            "\x1b%\x00G",
            "\x1b.\x070",
            "\x1b[!\x07p",
            "\x1b[?2J",
            "\x1b[?K",
            "\x1b[2 @",
            "\x1b[ A",
            "\x1b[2'}",
            "\x1b['~",
            "\x1b[1!p",
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
            "\x1b[?2h",
            "\x1b[?1;2l",
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
        // DCH at the first half: the second half it pulls to the cursor is
        // filled, as xterm's deleteCells does, so it replays as a blank.
        let out = replay(10, "a\u{4e2d}b\x1b[1;2H\x1b[P").unwrap();
        assert!(out.contains("a b"), "{out:?}");
        assert!(!out.contains('\u{4e2d}'), "{out:?}");
        // Next to a blank too, filled with the erase attribute, as xterm's.
        let mut term = Term::new(Config::default(), &Size(10, 3), VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, " \u{4e2d}b\x1b[44m\x1b[1;2H\x1b[P".as_bytes());
        let row = &term.grid()[Line(0)];
        assert!(!row[Column(1)]
            .flags
            .intersects(Flags::WIDE_CHAR | Flags::WIDE_CHAR_SPACER));
        assert_eq!(row[Column(1)].bg, Color::Named(NamedColor::Blue));
        assert_eq!(row[Column(2)].c, 'b');
    }

    /// Written at 7 columns ("abcdddR" soft-wrapped onto "ef", the cursor
    /// on the continuation), then widened to 10: row 0's cells 7..10 are the
    /// widen's empty ones.
    fn widened(rows: usize) -> (Term<VoidListener>, Processor) {
        let mut term = Term::new(Config::default(), &Size(7, rows), VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, b"abcdddRef");
        term.resize(Size(10, rows));
        (term, parser)
    }

    /// Where the serializer would treat each marked row's cells as empty:
    /// the blanks after the mark and after the row's last other content.
    /// Those cells must be unwritten (default blanks, at most the wrap
    /// flag); a stale mark would turn printed blanks into empty cells, which
    /// the cases below rule out by where they print.
    fn sound(term: &Term<VoidListener>) -> Vec<(i32, usize)> {
        let grid = term.grid();
        let mut runs = Vec::new();
        for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
            let row = &grid[Line(y)];
            let Some(from) = row.empty_from() else {
                continue;
            };
            let mut start = grid.columns();
            while start > from && super::blank(&row[Column(start - 1)]) {
                start -= 1;
            }
            // An erase's run keeps the erase background, as xterm's erased
            // cells do; the serializer erases it with that background.
            for x in start..grid.columns() {
                let cell = &row[Column(x)];
                assert!(
                    cell.fg == Color::Named(NamedColor::Foreground)
                        && (cell.flags - Flags::WRAPLINE).is_empty(),
                    "row {y} column {x} in a run from {start}: {cell:?}"
                );
            }
            runs.push((y, start));
        }
        runs
    }

    #[test]
    fn widen_and_erase_marks_stay_sound_through_every_other_edit() {
        let after = |rows: usize, bytes: &str| {
            let (mut term, mut parser) = widened(rows);
            parser.advance(&mut term, bytes.as_bytes());
            sound(&term)
        };
        assert_eq!(after(3, ""), [(0, 7)]);
        // A blank or a glyph printed in the run ends it there.
        assert_eq!(after(3, "\x1b[1;9H "), [(0, 9)]);
        assert_eq!(after(3, "\x1b[1;9HZ"), [(0, 9)]);
        assert_eq!(after(3, "\x1b[1;10H "), []);
        // Erased cells are empty: they join the run when they reach it (it
        // then starts where it did, or where the erase did if that is
        // earlier), start one at the edge, and leave it alone short of it.
        // Inserted cells move the run with them, out of the row at worst; a
        // delete empties what moves in from the run and what it fills at the
        // end.
        assert_eq!(after(3, "\x1b[1;9H\x1b[X"), [(0, 7)]);
        assert_eq!(after(3, "\x1b[1;2H\x1b[X"), [(0, 7)]);
        assert_eq!(after(3, "\x1b[1;9H\x1b[1K"), [(0, 0)]);
        assert_eq!(after(3, "\x1b[1;2H\x1b[@"), [(0, 8)]);
        assert_eq!(after(3, "\x1b[1;2H\x1b[3@"), []);
        assert_eq!(after(3, "\x1b[1;3H\x1b[20@"), [(0, 2)]);
        assert_eq!(after(3, "\x1b[1;9H\x1b[1J"), [(0, 0)]);
        assert_eq!(after(3, "\x1b[4h\x1b[1;9HZ\x1b[4l"), [(0, 9)]);
        assert_eq!(after(3, "\x1b[1;9H\x1b[2X"), [(0, 7)]);
        assert_eq!(after(3, "\x1b[1;5H\x1b[K"), [(0, 4)]);
        assert_eq!(after(3, "\x1b[1;5H\x1b[44m\x1b[K"), [(0, 4)]);
        assert_eq!(after(3, "\x1b[1;5H\x1b[1K"), [(0, 7)]);
        assert_eq!(after(3, "\x1b[1;10H\x1b[1K"), [(0, 0)]);
        assert_eq!(after(3, "\x1b[1;1H\x1b[2K"), [(0, 0)]);
        assert_eq!(after(3, "\x1b[1;2H\x1b[P"), [(0, 6)]);
        assert_eq!(after(3, "\x1b[1;2H\x1b[44m\x1b[5P"), [(0, 2)]);
        // Rows that move keep their run: insert and delete lines, scrolls,
        // and line feeds at the bottom into history.
        assert_eq!(after(3, "\x1b[1;1H\x1b[L"), [(1, 7)]);
        assert_eq!(after(3, "\x1b[2;1H\x1b[M"), [(0, 7)]);
        assert_eq!(after(3, "\x1b[T"), [(1, 7)]);
        assert_eq!(after(3, "\x1b[3;1H\n\n\n"), [(-3, 7)]);
        // A reset is a new line.
        assert_eq!(after(3, "\x1bc"), []);
        // A later widen keeps the first run; a narrowing keeps what fits.
        let (mut term, _) = widened(3);
        term.resize(Size(13, 3));
        assert_eq!(sound(&term), [(0, 7)]);
        term.resize(Size(8, 3));
        assert_eq!(sound(&term), [(0, 7)]);
        term.resize(Size(12, 3));
        assert_eq!(sound(&term), [(0, 7)]);
        // A later widen over an edit marks only the cells nothing wrote.
        let widen = |bytes: &str| {
            let (mut term, mut parser) = widened(3);
            parser.advance(&mut term, bytes.as_bytes());
            term.resize(Size(13, 3));
            sound(&term)
        };
        assert_eq!(widen("\x1b[1;9HZ\x1b[2;3H"), [(0, 9)]);
        // An erase inside the run keeps it, so the widen extends it.
        assert_eq!(widen("\x1b[1;9H\x1b[X\x1b[2;3H"), [(0, 7)]);
        assert_eq!(widen("\x1b[1;9H\x1b[44m \x1b[0m\x1b[2;3H"), [(0, 9)]);
        assert_eq!(widen("\x1b[1;1H\x1b[L\x1b[3;3H"), [(1, 7)]);
    }

    #[test]
    fn a_wrapped_row_with_an_empty_tail_wraps_on_filler_it_erases() {
        // Written at 7 columns, the cursor on the continuation, widened to 10:
        // the cursor's paragraph is not reflowed, so row 0 is "abcdddR" and
        // three empty cells, soft-wrapped onto "ef".
        let run = |after: &str| {
            let mut term = Term::new(Config::default(), &Size(7, 3), VoidListener);
            let mut parser: Processor = Processor::new();
            parser.advance(&mut term, b"abcddd\x1b[41mR\x1b[0mef");
            term.resize(Size(10, 3));
            parser.advance(&mut term, after.as_bytes());
            assert!(term.grid()[Line(0)][Column(9)]
                .flags
                .contains(Flags::WRAPLINE));
            serialize(&term, true).unwrap()
        };
        // Filler through the edge (4 = 3 cells + the next row's head), its
        // head erased, then back up to column 7; the red pen closed first.
        let out = run("");
        let at = out.find("----\x1b[D\x1b[X\x1b[A\r\x1b[7C").expect(&out);
        assert!(out[..at].ends_with("R\x1b[0m"), "{out:?}");
        // The tail erased with the default background in one run, then down
        // to the next row's head before it prints.
        assert!(out[at..].contains("\x1b[3X\r\x1b[Bef"), "{out:?}");
        // The cursor moved into the empty run prints nothing there.
        let out = run("\x1b[1;9H");
        assert!(out.contains("R\x1b[0m----\x1b[D\x1b[X\x1b[A\r\x1b[7C"), "{out:?}");
        // A blank printed there later, here with a colored background, is
        // content: the empty run starts after it, and only that is filler
        // (an empty run holds unwritten cells, so its background is default).
        let out = run("\x1b[1;9H\x1b[44m \x1b[0m\x1b[2;3H");
        assert!(
            out.contains(
                "R\x1b[0m \x1b[0;44m \x1b[0m--\x1b[D\x1b[X\x1b[A\r\x1b[9C\x1b[1X\r\x1b[Bef"
            ),
            "{out:?}"
        );
        // Without a widen, blanks printed up to a wrap stay content.
        let out = replay(5, "ab   cd").unwrap();
        assert!(out.contains("ab   cd"), "{out:?}");
        // An erase through a wrapped row's edge leaves empty cells too: they
        // replay as filler erased in the erase background.
        let out = replay(5, "abcdefg\x1b[1;3H\x1b[44m\x1b[K\x1b[0m\x1b[2;3H").unwrap();
        assert!(out.contains("ab----\x1b[D\x1b[X\x1b[A\r\x1b[2C\x1b[0;44m\x1b[3X"), "{out:?}");
        // From column 0 the whole row is filler, and only CR goes back to it
        // (CUF 0 would move one).
        let out = replay(5, "abcdefg\x1b[1;1H\x1b[2K\x1b[2;3H").unwrap();
        assert!(out.contains("------\x1b[D\x1b[X\x1b[A\r\x1b[5X"), "{out:?}");
    }

    #[test]
    fn cursor_saved_with_pending_wrap_is_refused() {
        let err = replay(4, "abcd\x1b7\x1b[H").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
        let err = replay(4, "abcd\x1b[?1049h").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
        // Saved on the alternate screen: refused while it is shown, not once
        // it is left, as the payload no longer carries that screen.
        let err = replay(4, "n\x1b[?1049h\x1b[Habcd\x1b7\x1b[H").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
        assert!(replay(4, "n\x1b[?1049h\x1b[Habcd\x1b7\x1b[?1049lX").is_ok());
        // Both keep that screen's saved cursor: refused again once it is
        // shown, as a restore there may still diverge.
        let err = replay(4, "n\x1b[?1049h\x1b[Habcd\x1b7\x1b[?1049l\x1b[?1049h").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
    }
}
