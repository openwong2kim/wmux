//! DECSTR (`CSI ! p`) as @xterm/headless runs it (InputHandler softReset,
//! CoreService.reset, CharsetService.reset). Each expectation is what xterm
//! shows for the same bytes; the rendered comparison is in
//! src/daemon/__tests__/RustAnsiParity.test.ts.

use crate::parity_support::{cursor, fed, screen, Fed};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::TermMode;

fn reset(chunks: &[&str]) -> Fed {
    let fed = fed(20, 3, 100, chunks);
    assert!(!fed.divergent, "{chunks:?}");
    fed
}

#[test]
fn the_cursor_stays_where_it_is() {
    let fed = reset(&["ab\x1b[2;3r\x1b[3;2H\x1b[!pX"]);
    assert_eq!(screen(&fed.term), ["ab", "", " X"]);
}

#[test]
fn a_pending_wrap_is_kept() {
    let fed = reset(&[&format!("{}\x1b[!pY", "x".repeat(20))]);
    assert_eq!(
        screen(&fed.term),
        ["x".repeat(20), "Y".to_owned(), String::new()]
    );
}

#[test]
fn the_margins_become_the_full_screen() {
    let fed = reset(&["1\r\n2\r\n3\x1b[1;2r\x1b[!p\x1b[3;1H\nX"]);
    assert_eq!(screen(&fed.term), ["2", "3", "X"]);
}

#[test]
fn origin_mode_is_reset_without_moving_the_cursor() {
    let fed = reset(&["\x1b[2;3r\x1b[?6h\x1b[2;2H\x1b[!pX\x1b[HY"]);
    assert_eq!(screen(&fed.term), ["Y", "", " X"]);
}

#[test]
fn insert_mode_and_attributes_are_reset() {
    let fed = reset(&["abc\x1b[4h\x1b[1;31m\x1b[!p\x1b[1;1HX"]);
    assert_eq!(screen(&fed.term)[0], "Xbc");
    let cell = &fed.term.grid()[Line(0)][Column(0)];
    assert_eq!(
        (cell.fg, cell.bg, cell.flags),
        (Cell::default().fg, Cell::default().bg, Flags::empty())
    );
}

#[test]
fn an_open_link_is_closed() {
    let fed = reset(&["\x1b]8;;https://e.com\x07a\x1b[!pb"]);
    let row = &fed.term.grid()[Line(0)];
    assert!(row[Column(0)].hyperlink().is_some());
    assert!(row[Column(1)].hyperlink().is_none());
}

#[test]
fn the_dec_modes_return_to_their_defaults() {
    let fed = reset(&["\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[?7l\x1b[?25l\x1b[!p"]);
    let mode = *fed.term.mode();
    assert!(mode.contains(TermMode::LINE_WRAP | TermMode::SHOW_CURSOR));
    assert!(!mode.intersects(
        TermMode::APP_CURSOR
            | TermMode::APP_KEYPAD
            | TermMode::BRACKETED_PASTE
            | TermMode::FOCUS_IN_OUT
    ));
}

#[test]
fn mouse_tracking_and_the_alternate_screen_stay() {
    let fed = reset(&["\x1b[?1000h\x1b[?1049h\x1b[!p"]);
    assert!(fed
        .term
        .mode()
        .contains(TermMode::MOUSE_REPORT_CLICK | TermMode::ALT_SCREEN));
}

#[test]
fn the_charsets_return_to_ascii() {
    assert_eq!(screen(&reset(&["\x1b(0\x1b[!pq"]).term)[0], "q");
    assert_eq!(screen(&reset(&["\x1b)0\x0e\x1b[!pq"]).term)[0], "q");
    assert_eq!(screen(&reset(&["\x1b*0\x1bn\x1b[!pq"]).term)[0], "q");
}

#[test]
fn the_saved_cursor_moves_to_the_top_left_with_default_attributes() {
    let fed = reset(&["ab\x1b[2;3H\x1b[1m\x1b7\x1b[!p\x1b[3;3H\x1b8X"]);
    assert_eq!(screen(&fed.term)[0], "Xb");
    assert_eq!(cursor(&fed.term), (0, 1));
    assert!(!fed.term.grid()[Line(0)][Column(0)]
        .flags
        .contains(Flags::BOLD));
}

#[test]
fn the_saved_charsets_are_kept() {
    assert_eq!(screen(&reset(&["\x1b(0\x1b7\x1b[!p\x1b8q"]).term)[0], "─");
}

#[test]
fn a_synchronized_update_ends() {
    let fed = reset(&["\x1b[?2026hab\x1b[!pX"]);
    assert_eq!(screen(&fed.term)[0], "abX");
}

// xterm's DECRC restores DECAWM and DECOM from the save (their defaults when
// nothing was saved); Alacritty's keeps the current ones.
#[test]
fn a_restore_that_changes_decawm_or_decom_is_divergent() {
    for text in [
        "\x1b[?7l\x1b7\x1b[!p\x1b8x",
        "\x1b[?6h\x1b7\x1b[!p\x1b8x",
        "\x1b[?7l\x1b8x",
        "\x1b[?7l\x1b[?1049h\x1b[?7h\x1b[?1049lx",
    ] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
    assert_eq!(screen(&reset(&["\x1b7\x1b[!p\x1b8X"]).term)[0], "X");
    assert_eq!(screen(&reset(&["\x1b[?7l\x1b7\x1b8X"]).term)[0], "X");
}

#[test]
fn other_spellings_stay_divergent() {
    for text in ["\x1b[0!p", "\x1b[!\x07p", "ab\x1b[!\x7fpcd"] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
}
