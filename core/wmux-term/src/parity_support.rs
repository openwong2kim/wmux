//! Test-only support for the per-reason parity modules (one per refusal a
//! change retires: SU/SD, charset, reflow). A terminal is fed raw bytes
//! through the snapshot's own feed and read back as rows, so a module can
//! state what xterm shows for the same bytes. The rendered comparison with
//! @xterm/headless is src/daemon/__tests__/_rustParity.ts.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::Term;

/// A terminal after the feed, and whether the feed met a control the
/// snapshot refuses as `unsupported-state`.
pub(crate) struct Fed {
    pub term: Term<VoidListener>,
    pub divergent: bool,
}

/// `chunks` fed in order (a split sequence is held across chunks) into a
/// `cols` x `rows` screen keeping `history` rows above it.
pub(crate) fn fed(cols: usize, rows: usize, history: usize, chunks: &[&str]) -> Fed {
    let bytes: Vec<&[u8]> = chunks.iter().map(|c| c.as_bytes()).collect();
    let (term, divergent) = crate::native_core::fed_for_test(cols, rows, history, &bytes);
    Fed { term, divergent }
}

fn text(term: &Term<VoidListener>, line: i32) -> String {
    let grid = term.grid();
    (0..grid.columns())
        .map(|x| grid[Line(line)][Column(x)].c)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// The visible rows, top first, trailing blanks dropped.
pub(crate) fn screen(term: &Term<VoidListener>) -> Vec<String> {
    (0..term.grid().screen_lines() as i32)
        .map(|y| text(term, y))
        .collect()
}

/// The rows scrolled off the top, oldest first, trailing blanks dropped.
pub(crate) fn history(term: &Term<VoidListener>) -> Vec<String> {
    let size = term.grid().history_size() as i32;
    (-size..0).map(|y| text(term, y)).collect()
}

/// The cursor as (row on screen, column), both from 0.
pub(crate) fn cursor(term: &Term<VoidListener>) -> (i32, usize) {
    let point = term.grid().cursor.point;
    (point.line.0, point.column.0)
}

#[cfg(test)]
mod tests {
    use super::{cursor, fed, history, screen};

    #[test]
    fn rows_scroll_into_history_oldest_first() {
        let fed = fed(10, 3, 100, &["1\r\n2\r\n3\r\n", "4\r\n5"]);
        assert!(!fed.divergent);
        assert_eq!(history(&fed.term), ["1", "2"]);
        assert_eq!(screen(&fed.term), ["3", "4", "5"]);
        assert_eq!(cursor(&fed.term), (2, 1));
    }

    #[test]
    fn a_split_divergent_control_is_reported() {
        assert!(fed(10, 3, 100, &["a\x1b(", "0q"]).divergent);
    }
}
