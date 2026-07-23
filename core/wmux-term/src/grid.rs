//! Core logic — the sole shared module used by binding layers (napi/wasm).
//!
//! S-A1 spike scope: vte raw `Perform` 8 callbacks + mini grid (char cells + cursor).
//! `print` records cells and advances the cursor; `execute` handles CR/LF only.
//! SGR · scroll · reflow · unicode width are **not implemented** (E1's job). This is plumbing proof.
//!
//! `no_std` not used (skeleton allows std — both wasm/napi targets are std).
//!
//! Structure: `Grid = Parser + Screen` field split — `feed` uses field-wise split borrows via
//! `self.parser.advance(&mut self.screen, ..)` so the parser need not be taken out of ownership
//! (no `std::mem::take`). Even if Perform callbacks unwind, there is no path where parser state
//! is lost to default (review feedback).

use vte::{Params, Parser, Perform};

/// Grid dimension cap — cols and rows each clamped. 4096²=16M cells so `cols*rows` usize
/// overflow is ruled out at the source (review feedback — domain cap instead of checked_mul).
const MAX_DIM: u32 = 4096;

/// feed() return surface — minimal subset of §6 contract.
/// writeback is always 0 in the skeleton (surface reserved only — E1 Interactive mode fills it).
pub struct FeedResult {
    /// Number of rows changed (dirty) in this feed.
    pub dirty_rows: u32,
    /// PTY writeback byte length — skeleton constant 0.
    pub writeback_len: u32,
}

/// Screen state (cells · cursor · dirty) — `Perform` implementor.
/// Separate field from the parser so concurrent borrows with `advance` are valid.
struct Screen {
    cols: u32,
    rows: u32,
    /// Row-major cell storage — length cols*rows.
    cells: Vec<char>,
    /// Cursor position (0-based).
    cursor_x: u32,
    cursor_y: u32,
    /// Rows touched in this feed (for dirty aggregation).
    dirty: Vec<bool>,
}

/// Mini grid + vte parser state. Public surface is spike contract (§6 minimal subset) only.
pub struct Grid {
    parser: Parser,
    screen: Screen,
}

impl Grid {
    /// New grid — cols×rows blank cells + cursor at (0,0).
    /// Dimensions clamped to [1, 4096] (guard 0 + rule out product overflow).
    pub fn new(cols: u32, rows: u32) -> Self {
        let cols = cols.clamp(1, MAX_DIM);
        let rows = rows.clamp(1, MAX_DIM);
        let len = (cols as usize) * (rows as usize); // ≤ 16M — overflow impossible.
        Grid {
            parser: Parser::new(),
            screen: Screen {
                cols,
                rows,
                cells: vec![' '; len],
                cursor_x: 0,
                cursor_y: 0,
                dirty: vec![false; rows as usize],
            },
        }
    }

    /// Stream bytes through the parser and return dirty aggregate.
    /// Parser (self.parser) and screen (self.screen) are separate fields — split borrow, no take/restore.
    pub fn feed(&mut self, bytes: &[u8]) -> FeedResult {
        for d in self.screen.dirty.iter_mut() {
            *d = false;
        }
        self.parser.advance(&mut self.screen, bytes);

        let dirty_rows = self.screen.dirty.iter().filter(|&&d| d).count() as u32;
        FeedResult {
            dirty_rows,
            writeback_len: 0, // Skeleton — surface reserved only.
        }
    }

    /// String snapshot of the given row (trailing spaces preserved — fixed cols width).
    pub fn snapshot_row(&self, y: u32) -> String {
        if y >= self.screen.rows {
            return String::new();
        }
        let start = (y as usize) * (self.screen.cols as usize);
        let end = start + (self.screen.cols as usize);
        self.screen.cells[start..end].iter().collect()
    }

    /// Full reset — blank cells, cursor origin, parser reset.
    pub fn reset(&mut self) {
        for c in self.screen.cells.iter_mut() {
            *c = ' ';
        }
        self.screen.cursor_x = 0;
        self.screen.cursor_y = 0;
        for d in self.screen.dirty.iter_mut() {
            *d = false;
        }
        self.parser = Parser::new();
    }

    pub fn cols(&self) -> u32 {
        self.screen.cols
    }

    pub fn rows(&self) -> u32 {
        self.screen.rows
    }
}

impl Screen {
    /// Write a character at the cursor and advance the cursor.
    /// At line end, wrap to column 0 of the next row (skeleton — auto-wrap only, DECAWM not implemented).
    fn put_char(&mut self, c: char) {
        if self.cursor_y >= self.rows {
            return;
        }
        let idx = (self.cursor_y as usize) * (self.cols as usize) + (self.cursor_x as usize);
        if idx < self.cells.len() {
            self.cells[idx] = c;
            self.dirty[self.cursor_y as usize] = true;
        }
        // Advance cursor.
        self.cursor_x += 1;
        if self.cursor_x >= self.cols {
            self.cursor_x = 0;
            if self.cursor_y + 1 < self.rows {
                self.cursor_y += 1;
            }
            // Last row: hold cursor y (scroll not implemented — E1's job).
        }
    }

    fn carriage_return(&mut self) {
        self.cursor_x = 0;
    }

    fn line_feed(&mut self) {
        if self.cursor_y + 1 < self.rows {
            self.cursor_y += 1;
        }
        // Scroll not implemented — hold on last row.
    }
}

/// vte raw `Perform` — all 8 callbacks implemented (no ansi feature; decision doc D1 parser sub-decision).
/// In the skeleton only `print`/`execute` affect the screen; the other 6 stay no-op surface.
impl Perform for Screen {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => self.carriage_return(),
            b'\n' => self.line_feed(),
            _ => {} // Other C0 control chars ignored (skeleton).
        }
    }

    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        // DCS entry — skeleton no-op (surface preserved).
    }

    fn put(&mut self, _byte: u8) {
        // DCS data byte — no-op.
    }

    fn unhook(&mut self) {
        // DCS exit — no-op.
    }

    fn osc_dispatch(&mut self, _params: &[&[u8]], _bit_more: bool) {
        // OSC (7/8/52/133 etc.) — skeleton no-op. E1 dispatches as first-class events.
    }

    fn csi_dispatch(
        &mut self,
        _params: &Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
        // CSI (SGR · cursor moves · scroll region etc.) — no-op. E1's job.
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {
        // ESC (charset · alt-screen etc.) — no-op. E1's job.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_advances_cursor_and_records_cell() {
        // Core test 1: does print record a cell and advance the cursor?
        let mut g = Grid::new(10, 3);
        let r = g.feed(b"hi");
        assert_eq!(g.snapshot_row(0), "hi        "); // 2 chars + 8 spaces (cols=10).
        assert_eq!(r.dirty_rows, 1);
        assert_eq!(r.writeback_len, 0); // Skeleton constant.
    }

    #[test]
    fn crlf_moves_cursor_to_next_line() {
        // Core test 2: does execute(CR/LF) move the cursor to column 0 of the next row?
        let mut g = Grid::new(10, 3);
        g.feed(b"ab\r\ncd");
        assert_eq!(g.snapshot_row(0), "ab        ");
        assert_eq!(g.snapshot_row(1), "cd        "); // CR to col 0 + LF to next row.
    }

    #[test]
    fn reset_clears_grid() {
        let mut g = Grid::new(5, 2);
        g.feed(b"xyz");
        g.reset();
        assert_eq!(g.snapshot_row(0), "     "); // All blank.
    }

    #[test]
    fn csi_is_swallowed_not_printed() {
        // SGR sequence must not leak into cells (parser swallows even with csi_dispatch no-op).
        let mut g = Grid::new(20, 2);
        g.feed(b"\x1b[31mred\x1b[0m");
        assert_eq!(g.snapshot_row(0), "red                 "); // ANSI stripped, 'red' only.
    }

    #[test]
    fn auto_wrap_at_line_end() {
        // Auto-wrap at line end (skeleton).
        let mut g = Grid::new(3, 2);
        g.feed(b"abcd");
        assert_eq!(g.snapshot_row(0), "abc");
        assert_eq!(g.snapshot_row(1), "d  ");
    }

    #[test]
    fn dimensions_clamped_to_max() {
        // Dimension cap clamp — product overflow ruled out at source (review feedback).
        let g = Grid::new(u32::MAX, u32::MAX);
        assert_eq!(g.cols(), MAX_DIM);
        assert_eq!(g.rows(), MAX_DIM);
    }

    #[test]
    fn split_csi_across_feed_chunks_survives() {
        // CSI split at chunk boundary — parser state preserved across feed calls
        // (regression guard for mem::take removal — review feedback).
        let mut g = Grid::new(20, 2);
        g.feed(b"\x1b[3"); // Cut mid CSI parameter.
        g.feed(b"1mred\x1b[0m");
        assert_eq!(g.snapshot_row(0), "red                 "); // Split sequence also swallowed.
    }
}
