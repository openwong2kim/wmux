//! ANSI replay of a Rust-engine session (AnsiSnapshotBackend selects it).
//! Grid/cursor/style restoration is separate from partial input-tail handling.
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Grid};
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

/// Returns whether the replay leaves a hyperlink open.
fn screen(out: &mut String, grid: &Grid<Cell>) -> bool {
    let mut pen = Pen::default();
    let columns = grid.columns();
    for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        let line = &grid[Line(y)];
        let wrapped = line[grid.last_column()].flags.contains(Flags::WRAPLINE);
        // A soft-wrapped row must reach its last column to wrap again.
        let mut end = columns;
        if !wrapped {
            while end > 0 && blank(&line[Column(end - 1)]) {
                end -= 1;
            }
            // Blanks left of the cursor are usually printed: a prompt's
            // trailing space, which reads back as part of the prompt.
            if y == grid.cursor.point.line.0 {
                end = end.max(grid.cursor.point.column.0);
            }
        }
        for x in 0..end {
            let cell = &line[Column(x)];
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
            let bg = line[Column(x)].bg;
            let mut run = x;
            while run < columns && line[Column(run)].bg == bg {
                run += 1;
            }
            if bg != Color::Named(NamedColor::Background) {
                pen.set(out, &line[Column(x)]);
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
    pen.link.is_some()
}

pub fn serialize(term: &Term<VoidListener>) -> Result<String, &'static str> {
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
        let linked = screen(&mut out, term.inactive_grid());
        out.push_str("\x1b[?1049h\x1b[0m\x1b[H");
        if linked {
            out.push_str("\x1b]8;;\x1b\\");
        }
    }
    screen(&mut out, term.grid());
    for (mode, code) in [
        (TermMode::APP_CURSOR, 1),
        (TermMode::ORIGIN, 6),
        (TermMode::FOCUS_IN_OUT, 1004),
        (TermMode::SGR_MOUSE, 1006),
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
    if modes.contains(TermMode::MOUSE_MOTION) {
        out.push_str("\x1b[?1003h");
    } else if modes.contains(TermMode::MOUSE_DRAG) {
        out.push_str("\x1b[?1002h");
    } else if modes.contains(TermMode::MOUSE_REPORT_CLICK) {
        out.push_str("\x1b[?1000h");
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
        serialize(&term)
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
    fn cursor_saved_with_pending_wrap_is_refused() {
        let err = replay(4, "abcd\x1b7\x1b[H").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
        let err = replay(4, "abcd\x1b[?1049h").unwrap_err();
        assert!(err.starts_with("unsupported-saved-wrap"));
    }
}
