//! Scrolling controls as @xterm/headless runs them (InputHandler scrollDown,
//! deleteLines, insertLines, reverseIndex). Each expectation is what xterm
//! shows for the same bytes; the rendered comparison is in
//! src/daemon/__tests__/RustAnsiParity.test.ts.

use crate::parity_support::{fed, history, screen};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::vte::ansi::{Color, NamedColor};

#[test]
fn sd_clears_with_default_attributes() {
    let fed = fed(10, 3, 100, &["1\r\n2\x1b[44m\x1b[T"]);
    assert_eq!(screen(&fed.term), ["", "1", "2"]);
    assert_eq!(fed.term.grid()[Line(0)][Column(0)].bg, Cell::default().bg);
}

#[test]
fn sd_inside_a_region_clears_with_default_attributes() {
    let fed = fed(
        10,
        5,
        100,
        &["1\r\n2\r\n3\r\n4\r\n5\x1b[2;4r\x1b[44m\x1b[2T\x1b[r"],
    );
    assert_eq!(screen(&fed.term), ["1", "", "", "2", "5"]);
    for line in [1, 2] {
        assert_eq!(
            fed.term.grid()[Line(line)][Column(0)].bg,
            Cell::default().bg
        );
    }
}

#[test]
fn il_and_ri_keep_the_erase_colour() {
    let blue = Color::Named(NamedColor::Blue);
    let il = fed(10, 3, 100, &["1\x1b[44m\x1b[L"]);
    assert_eq!(il.term.grid()[Line(0)][Column(0)].bg, blue);
    let ri = fed(10, 3, 100, &["1\x1b[44m\x1b[H\x1bM"]);
    assert_eq!(screen(&ri.term), ["", "1", ""]);
    assert_eq!(ri.term.grid()[Line(0)][Column(0)].bg, blue);
}

#[test]
fn dl_on_the_top_row_keeps_history() {
    let fed = fed(10, 3, 100, &["1\r\n2\r\n3\x1b[H\x1b[M"]);
    assert!(history(&fed.term).is_empty());
    assert_eq!(screen(&fed.term), ["2", "3", ""]);
}

#[test]
fn dl_past_the_screen_on_the_top_row_clears_it() {
    let fed = fed(10, 3, 100, &["1\r\n2\r\n3\r\n4\x1b[H\x1b[44m\x1b[9M"]);
    assert_eq!(history(&fed.term), ["1"]);
    assert_eq!(screen(&fed.term), ["", "", ""]);
    assert_eq!(
        fed.term.grid()[Line(2)][Column(0)].bg,
        Color::Named(NamedColor::Blue)
    );
}

#[test]
fn a_linefeed_at_the_bottom_still_scrolls_into_history() {
    let fed = fed(10, 3, 100, &["1\r\n2\r\n3\x1b[H\x1b[M\x1b[3;1Hx\r\ny"]);
    assert_eq!(history(&fed.term), ["2"]);
    assert_eq!(screen(&fed.term), ["3", "x", "y"]);
}
