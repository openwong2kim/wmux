//! Charset designation and shifts as @xterm/headless runs them (InputHandler
//! selectCharset, shiftIn/shiftOut, saveCursor/restoreCursor and the
//! CHARSETS['0'] table). Each expectation is what xterm shows for the same
//! bytes; the rendered comparison is in RustAnsiParity.test.ts.

use crate::parity_support::{fed, screen};

fn first_row(chunks: &[&str]) -> String {
    let fed = fed(20, 3, 100, chunks);
    assert!(!fed.divergent, "{chunks:?}");
    screen(&fed.term)[0].clone()
}

#[test]
fn g0_dec_line_drawing_maps_like_xterm() {
    assert_eq!(first_row(&["\x1b(0lqk\x1b(Bq"]), "┌─┐q");
}

#[test]
fn underscore_is_not_in_the_dec_table() {
    assert_eq!(first_row(&["\x1b(0_q_\x1b(B"]), "_─_");
}

#[test]
fn so_and_si_switch_between_g1_and_g0() {
    assert_eq!(first_row(&["\x1b)0q\x0eq\x0fq"]), "q─q");
}

#[test]
fn decrc_restores_the_shift_with_the_cursor() {
    assert_eq!(first_row(&["\x1b)0\x0e\x1b7\x0fq\x1b8q"]), "─");
}

#[test]
fn decrc_restores_the_designations_with_the_cursor() {
    assert_eq!(first_row(&["\x1b(0\x1b7\x1b(Bq\x1b8q"]), "─");
}

#[test]
fn decrc_with_nothing_saved_keeps_the_designations_and_returns_to_g0() {
    assert_eq!(first_row(&["\x1b(0\x1b8q"]), "─");
    assert_eq!(first_row(&["\x1b)0\x0e\x1b8q"]), "q");
}

#[test]
fn leaving_the_alternate_screen_restores_the_shift() {
    let fed = fed(20, 3, 100, &["\x1b)0\x0e\x1b[?1049hq\x0fq\x1b[?1049lq"]);
    assert!(!fed.divergent);
    assert_eq!(screen(&fed.term)[0], "─");
}

#[test]
fn ris_returns_to_ascii() {
    assert_eq!(first_row(&["\x1b(0q\x1bcq"]), "q");
}

#[test]
fn other_designations_stay_divergent() {
    for text in ["\x1b(Ax", "\x1b)K", "\x1b*0x", "\x1b+0x", "\x1b-Ax"] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
}
