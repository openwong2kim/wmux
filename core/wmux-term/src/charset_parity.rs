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
fn national_sets_stay_divergent() {
    for text in [
        "\x1b(Ax", "\x1b)K", "\x1b*Rx", "\x1b+=x", "\x1b-Ax", "\x1b.7x",
    ] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
}

// G2 and G3, and G1 and G2 designated by `ESC -` and `ESC .`, which xterm
// maps to the same slots. xterm.js invokes them with the locking shifts
// (LS2 `ESC n`, LS3 `ESC o`, LS3R `ESC |`, LS2R `ESC }`, LS1R `ESC ~`).
#[test]
fn locking_shifts_invoke_g2_and_g3() {
    assert_eq!(first_row(&["\x1b*0\x1bnq\x0fq"]), "─q");
    assert_eq!(first_row(&["\x1b+0\x1boq\x0fq"]), "─q");
    assert_eq!(first_row(&["\x1b+0\x1b|q"]), "─");
    assert_eq!(first_row(&["\x1b*0\x1b}q"]), "─");
}

#[test]
fn ls2_invokes_an_undesignated_g2() {
    assert_eq!(first_row(&["\x1b(0\x1bnq"]), "q");
}

#[test]
fn ls1r_invokes_g1() {
    assert_eq!(first_row(&["\x1b)0\x1b~q"]), "─");
}

#[test]
fn decrc_restores_a_locking_shift() {
    assert_eq!(first_row(&["\x1b*0\x1bn\x1b7\x0f\x1b8q"]), "─");
}

#[test]
fn dash_and_dot_designate_g1_and_g2() {
    assert_eq!(first_row(&["\x1b-0\x0eq"]), "─");
    assert_eq!(first_row(&["\x1b.0\x1bnq"]), "─");
    assert_eq!(first_row(&["\x1b)0\x1b-B\x0eq"]), "q");
}

// selectDefaultCharset: ASCII in G0, G0 shifted in, G1-G3 kept.
#[test]
fn percent_returns_g0_to_ascii() {
    assert_eq!(first_row(&["\x1b(0\x1b%Gq"]), "q");
    assert_eq!(first_row(&["\x1b)0\x0e\x1b%@q"]), "q");
    assert_eq!(first_row(&["\x1b)0\x1b%@\x0eq"]), "─");
}

// xterm skips `ESC /`.
#[test]
fn slash_designates_nothing() {
    assert_eq!(first_row(&["\x1b(0\x1b/Aq"]), "─");
}

// A final other than B or 0 stays refused, whether or not xterm's table has
// it today.
#[test]
fn other_finals_stay_divergent() {
    for text in ["\x1b(Xq", "\x1b(%5q", "\x1b)1q"] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
}

// xterm's DECSC saves the charset slots designated so far and its DECRC
// restores only those (Buffer.savedCharsets); Alacritty restores all four.
#[test]
fn decrc_restores_the_saved_slots() {
    assert_eq!(first_row(&["\x1b*0\x1b7\x1b(B\x1b*B\x1b8\x1bnq"]), "─");
}

#[test]
fn decrc_with_nothing_saved_keeps_a_later_slot() {
    assert_eq!(first_row(&["\x1b*0\x1b8\x1bnq"]), "─");
}

#[test]
fn a_slot_designated_after_the_save_is_divergent_at_the_restore() {
    for text in [
        "\x1b7\x1b*0\x1b8\x1bnq",
        "\x1b[s\x1b+0\x1b[u\x1boq",
        "\x1b(0\x1b[?1049h\x1b*0\x1b[?1049l\x1bnq",
        "\x1b[!p\x1b7\x1b)0\x1b8\x0eq",
    ] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
    // Without a restore after it, the designation is served.
    assert_eq!(first_row(&["\x1b7\x1b*0\x1bnq"]), "─");
}

#[test]
fn a_c0_inside_a_control_the_feed_runs_stays_divergent() {
    for text in ["\x1b\x07nq", "\x1b%\x07Gq", "\x1b-\x070q", "\x1b[!\x07pq"] {
        assert!(fed(20, 3, 100, &[text]).divergent, "{text:?}");
    }
}
