//! In-line editing controls as @xterm/headless runs them (InputHandler
//! deleteChars). Each expectation is what xterm shows for the same bytes;
//! the rendered comparison is in src/daemon/__tests__/RustAnsiParity.test.ts.

use crate::parity_support::{fed, screen};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::vte::ansi::{Color, NamedColor};

#[test]
fn dch_past_the_line_end_keeps_the_cells_before_the_cursor() {
    let fed = fed(20, 3, 100, &["abcdef\x1b[1;5H\x1b[44m\x1b[30P"]);
    assert_eq!(screen(&fed.term)[0], "abcd");
    let row = &fed.term.grid()[Line(0)];
    assert_eq!(row[Column(3)].bg, Cell::default().bg);
    assert_eq!(row[Column(4)].bg, Color::Named(NamedColor::Blue));
    assert_eq!(row[Column(19)].bg, Color::Named(NamedColor::Blue));
}

#[test]
fn dch_past_the_line_end_near_the_edge() {
    let fed = fed(20, 3, 100, &["abcdefghijklmnopqrst\x1b[1;18H\x1b[9P"]);
    assert_eq!(screen(&fed.term)[0], "abcdefghijklmnopq");
}

#[test]
fn dch_that_fits_shifts_the_rest_left() {
    let fed = fed(20, 3, 100, &["abcdefghij\x1b[1;3H\x1b[2P"]);
    assert_eq!(screen(&fed.term)[0], "abefghij");
}
