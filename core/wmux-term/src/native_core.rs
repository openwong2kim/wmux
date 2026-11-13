//! Opt-in native terminal core: VT state and retained history behind N-API.
//! NativeTransport owns the production PTY; NativePty remains a spike harness.

use crate::native_output::NativeOutputChunk;
use crate::native_serialize::XtermControl;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Grid, GridCell};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{
    Attr, CharsetIndex, ClearMode, Handler, NamedMode, NamedPrivateMode, Processor,
    StandardCharset, Timeout,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};

/// Loader contract for the opt-in daemon text backend. Bump on incompatible
/// changes to the exposed snapshot shape or required compatibility policy.
#[napi(catch_unwind)]
pub fn native_core_abi_version() -> u32 {
    1
}

#[napi(catch_unwind)]
pub fn native_core_capabilities() -> Vec<String> {
    vec![
        "text-v1".into(),
        "ring-v1".into(),
        "pty-v1".into(),
        "frozen-ring-v1".into(),
        "output-chunk-v1".into(),
        "output-interpreter-v1".into(),
        "ansi-v2".into(),
        "ansi-v3".into(),
        "console-owner-v1".into(),
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        "process-table-v1".into(),
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        "listen-sockets-v1".into(),
    ]
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[napi(object)]
pub struct NativeProcessRow {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub created: Option<f64>,
    pub cmdline: Option<String>,
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub struct ProcessTableTask {
    with_command_lines: bool,
}
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl Task for ProcessTableTask {
    type Output = Vec<crate::process_table::ProcessRow>;
    type JsValue = Vec<NativeProcessRow>;
    fn compute(&mut self) -> Result<Self::Output> {
        crate::process_table::snapshot(self.with_command_lines).map_err(Error::from_reason)
    }
    fn resolve(&mut self, _env: Env, rows: Self::Output) -> Result<Self::JsValue> {
        Ok(rows
            .into_iter()
            .map(|r| NativeProcessRow {
                pid: r.pid,
                ppid: r.ppid,
                name: r.name,
                created: r.created,
                cmdline: r.cmdline,
            })
            .collect())
    }
}

/// The process table off the JS thread. With `with_command_lines`, each
/// row also carries its creation time and command line where readable.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[napi(catch_unwind)]
pub fn process_table(with_command_lines: bool) -> AsyncTask<ProcessTableTask> {
    AsyncTask::new(ProcessTableTask { with_command_lines })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[napi(object)]
pub struct NativeListenSocket {
    pub pid: u32,
    pub port: u32,
    pub address: String,
    /// 4 or 6.
    pub family: u32,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[napi(object)]
pub struct NativePortSnapshot {
    pub processes: Vec<NativeProcessRow>,
    pub sockets: Vec<NativeListenSocket>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub struct PortSnapshotTask;
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Task for PortSnapshotTask {
    type Output = crate::process_table::PortSnapshot;
    type JsValue = NativePortSnapshot;
    fn compute(&mut self) -> Result<Self::Output> {
        crate::process_table::port_snapshot().map_err(Error::from_reason)
    }
    fn resolve(&mut self, _env: Env, snap: Self::Output) -> Result<Self::JsValue> {
        Ok(NativePortSnapshot {
            processes: snap
                .processes
                .into_iter()
                .map(|r| NativeProcessRow {
                    pid: r.pid,
                    ppid: r.ppid,
                    name: r.name,
                    created: r.created,
                    cmdline: r.cmdline,
                })
                .collect(),
            sockets: snap
                .sockets
                .into_iter()
                .map(|r| NativeListenSocket {
                    pid: r.pid,
                    port: r.port.into(),
                    address: r.address,
                    family: r.family.into(),
                })
                .collect(),
        })
    }
}

/// PortWatcher's snapshot off the JS thread: the process walk and every
/// listening TCP socket this user can read, with the pid holding it, from
/// one walk.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[napi(catch_unwind)]
pub fn port_snapshot() -> AsyncTask<PortSnapshotTask> {
    AsyncTask::new(PortSnapshotTask)
}

struct Size {
    cols: usize,
    rows: usize,
}
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

fn dimensions(cols: u32, rows: u32) -> Result<Size> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(Error::from_reason(
            "Experiment requires 2..1000 columns and 1..1000 rows",
        ));
    }
    Ok(Size {
        cols: cols as usize,
        rows: rows as usize,
    })
}

#[napi(object)]
pub struct NativeTextRow {
    pub text: String,
    pub wrapped: bool,
    pub undimmed: Option<String>,
}

#[napi(object)]
pub struct NativeTextSnapshot {
    pub rows: Vec<NativeTextRow>,
    pub buffer_type: String,
    pub rows_below_cursor: u32,
}

#[napi]
pub struct NativeTerminal {
    term: Option<Term<VoidListener>>,
    parser: Processor,
    scrollback: u32,
    /// xterm's scrollback in the last `feed_xterm` (this grid's until then).
    requested_scrollback: u32,
    /// `feed_xterm` state besides the grid.
    feed: XtermFeed,
    /// Why the ANSI snapshot of this stream cannot match xterm's, for good
    /// (an alternate screen's width change is XtermFeed::alt_reflow).
    refusal: Option<&'static str>,
    /// Bytes scanned past the refusal for other refusal families (at most
    /// REFUSAL_SCAN_BYTES).
    scanned: usize,
    /// The text feed's trailing ESC (advance_indexing).
    text_held: Vec<u8>,
}

/// Whether narrowing to `cols` reflows a row below the cursor's paragraph on
/// this grid: a soft-wrapped row there, or a row with content past the new
/// width. A widen follows xterm's cursor rule (vendor grow_columns).
fn reflows_below_cursor<T: GridCell>(grid: &Grid<T>, cols: usize) -> bool {
    let old = grid.columns();
    if cols >= old {
        return false;
    }
    let last = Column(old - 1);
    let lines = grid.screen_lines() as i32;
    let mut y = grid.cursor.point.line.0;
    while y + 1 < lines && grid[Line(y)][last].flags().contains(Flags::WRAPLINE) {
        y += 1;
    }
    ((y + 1)..lines).any(|y| {
        let row = &grid[Line(y)];
        row[last].flags().contains(Flags::WRAPLINE)
            || (cols..old).any(|x| !row[Column(x)].is_empty())
    })
}

const C1: &str = "unsupported-state-c1: a C1 control, which Alacritty prints";
const LONG_SEQUENCE: &str =
    "unsupported-state-long-sequence: an unfinished sequence past the held bytes";
/// How many bytes past a refusal `feed_xterm` still scans for other refusal
/// families (XtermFeed::scan): a fixed bound, so the same stream always
/// names the same families, and the xterm fallback waits little for it.
const REFUSAL_SCAN_BYTES: usize = 1024 * 1024;
const ROUND_TRIP: &str =
    "unsupported-state-mode: more than kitty keyboard controls between ?47h and ?47l";
const OPEN_ROUND_TRIP: &str = "unsupported-state-mode: the stream ends between ?47h and ?47l";
/// Not counted past a first refusal: `scan` has no screen to read.
const RESTORE_ROW_ALT: &str = "unsupported-state-restore-row: a DECRC or SCORC on the alternate screen after a resize xterm skipped there, so its saved cursor cannot be placed";

const RESTORE_ROW: &str =
    "unsupported-state-restore-row: a DECRC or SCORC on a screen this tracker and Alacritty disagree on, so xterm's row cannot be placed";

/// Alternate-screen and mouse controls that Alacritty ignores (vte maps no
/// mode 9, 47 or 1047) and that xterm runs, which leave the same screen as
/// Alacritty's in some states only. The restore seam writes all three
/// (src/shared/restoreSeam.ts); `XtermFeed::allows` holds the states.
///
/// Kitty keyboard flags: xterm swaps them on every switch of 47, 1047 and
/// 1049, and Alacritty only on 1049, so after these rules the two may hold
/// different flags. Neither payload restores any: xterm's SerializeAddon
/// does not serialize them and `native_serialize::serialize` writes none
/// (RustAnsiParity.test.ts fails if either starts to). A native payload that
/// carries the flags needs xterm's per-screen flag stacks tracked first.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ContextRule {
    /// `?9l`: xterm turns its mouse protocol off whichever it was. The
    /// payload writes the protocol this feed tracks as xterm does (`mouse`).
    MouseOff,
    /// `?47l` or `?1047l`. Off the alternate screen xterm does nothing either
    /// (activateNormalBuffer returns); on it, xterm leaves and Alacritty
    /// does not, except that `?47l` closes a round trip.
    AltLeave { mode_47: bool },
    /// `?47h` from the main screen: xterm shows a blank alternate screen with
    /// the cursor where it was, and the matching `?47l` puts back the main
    /// screen with the cursor where the alternate one left it. With only
    /// kitty keyboard controls between (`round_trip`), neither cursor nor
    /// cell moved, as on Alacritty, which stayed on the main screen.
    AltEnter,
}

/// The rule a control falls under, by its shape alone: one private mode,
/// digits only (leading zeros as xterm reads them), no C0 inside.
fn context_rule(sequence: &[u8]) -> Option<ContextRule> {
    let (&last, params) = sequence.strip_prefix(b"\x1b[?")?.split_last()?;
    if params.is_empty() || !params.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mode = std::str::from_utf8(params).ok()?.parse::<u16>().ok()?;
    match (mode, last) {
        (9, b'l') => Some(ContextRule::MouseOff),
        (47, b'l') => Some(ContextRule::AltLeave { mode_47: true }),
        (1047, b'l') => Some(ContextRule::AltLeave { mode_47: false }),
        (47, b'h') => Some(ContextRule::AltEnter),
        _ => None,
    }
}

/// A kitty keyboard flag push, pop or set: `CSI > Ps u`, `CSI < Ps u`,
/// `CSI = Ps ; Ps u`. Neither payload restores the flags (`ContextRule`).
fn is_kitty_keyboard(sequence: &[u8]) -> bool {
    sequence
        .strip_prefix(b"\x1b[")
        .and_then(|s| s.strip_suffix(b"u"))
        .and_then(<[u8]>::split_first)
        .is_some_and(|(marker, params)| {
            b"<>=".contains(marker) && params.iter().all(|&b| b.is_ascii_digit() || b == b';')
        })
}
/// The longest unfinished sequence `feed_xterm` holds for its next bytes.
const MAX_HELD: usize = 256;
/// The longest unfinished string re-shipped after a snapshot, in UTF-16
/// units (util/ansiStreamScan.ts MAX_PENDING_TAIL_CHARS).
const MAX_TAIL_UNITS: usize = 4096;

/// What the ANSI feed tracks besides the grid. Margins, cursor visibility
/// and the pending input tail follow util/ansiStreamScan.ts, which the xterm
/// path runs over the same bytes, so both payloads restore the same state.
#[derive(Default)]
struct XtermFeed {
    /// An unfinished escape sequence awaiting its next bytes.
    held: Vec<u8>,
    /// The stream ends inside a string (OSC, DCS, SOS, PM, APC): `tail`
    /// holds it from its introducer, `tail_units` counts it.
    in_string: bool,
    tail: Vec<u8>,
    tail_units: usize,
    tail_overflow: bool,
    /// DECSTBM margins in effect on the main and the alternate screen, kept
    /// per screen as xterm does (MarginTracker).
    main_margins: bool,
    alt_margins: bool,
    /// xterm's alternate screen is active (?47, ?1047, ?1049).
    alt_screen: bool,
    /// Inside a `?47h` taken from the main screen and not yet left
    /// (`ContextRule::AltEnter`): Alacritty stayed on the main screen.
    round_trip: bool,
    /// DECTCEM off (CursorVisibilityTracker).
    cursor_hidden: bool,
    /// SGR-pixels mouse encoding, ?1016 (SgrMouseEncodingTracker). Alacritty
    /// does not parse it, so its mode set never carries it.
    sgr_pixels: bool,
    /// SGR mouse encoding, ?1006 (SgrMouseEncodingTracker). Alacritty drops
    /// it on ?1005, which xterm ignores.
    sgr_mouse: bool,
    /// xterm's mouse protocol (9, 1000, 1002 or 1003; 0 for none): any of
    /// their resets turns it off, where Alacritty clears only that mode.
    mouse: u16,
    /// The stream so far ends in a printed character, which REP repeats.
    printed: bool,
    /// DCH or ICH ran: a half-erased fullwidth glyph may sit next to an
    /// unrelated cell, so it cannot be repaired from its partner.
    shifted: bool,
    /// A control Alacritty parses differently from xterm.
    divergent: bool,
    /// The refusal the first one is reported as (native_serialize::refusal).
    refused: Option<&'static str>,
    /// Every refusal family met so far, each once, in the order met. The
    /// feed goes on past the first refusal, so the counters can tell what
    /// else a refused stream holds (NativeTerminal::refusal_families).
    seen: Vec<&'static str>,
    /// The alternate screen changed width with a soft-wrapped row on it
    /// (NativeTerminal::resize). Unlike the other refusals this one ends:
    /// leaving that screen discards the rows that differ.
    alt_reflow: bool,
    /// The sequence just tracked resets 47, 1047 or 1049, or is RIS: it may
    /// leave the alternate screen, whatever this tracker thinks is shown.
    may_leave_alt: bool,
    /// xterm's DECAWM off and DECOM on, which its DECRC restores from the
    /// save (Alacritty's leaves both as they are).
    no_wraparound: bool,
    origin: bool,
    /// How many charset slots (G0 up) xterm designated since its charsets
    /// were last reset: its DECSC saves only those.
    charset_slots: u8,
    /// Which charset slots (G0 up) hold DEC line drawing, on both terminals
    /// alike: every other set is refused (native_serialize::divergent).
    dec_slots: [bool; 4],
    /// xterm's saved cursor on the main and the alternate screen.
    saved: [SavedCursor; 2],
    /// The length of xterm's alternate buffer (`lines.maxLength`): the rows
    /// at its last leave or reset, or at a resize while it is shown, and
    /// only ever more at a resize while it is not (an empty buffer's resize
    /// grows it and returns). Past the screen rows, the alternate screen
    /// keeps rows above it there.
    alt_rows: usize,
    /// The alternate screen was shown with `alt_rows` past the screen rows
    /// since it was last left: its saved row may count rows above the screen
    /// that Alacritty's alternate grid never keeps.
    alt_overhang: bool,
}

/// What xterm's DECRC restores and Alacritty's does not (Buffer.saved*),
/// kept per screen as xterm keeps it per buffer.
#[derive(Clone, Copy, Default)]
struct SavedCursor {
    /// A save ran on this screen (Alacritty's `cursor_saved`). Without one
    /// both keep every charset slot on a restore.
    saved: bool,
    /// The charset slots xterm saved; it restores only those, Alacritty all.
    charset_slots: u8,
    /// What each slot held at the save. A slot past `charset_slots` that
    /// holds another set by the restore keeps it on xterm, where Alacritty
    /// puts this one back; designated again to the same set, both agree.
    dec_slots: [bool; 4],
    no_wraparound: bool,
    origin: bool,
    /// The screen's history (rows above it) at the save: xterm saves an
    /// absolute row, Alacritty a screen row (place_like_xterm). The
    /// alternate screen keeps none, so there it starts at 0. A resize then
    /// carries the rows the two move their saved rows apart by (RowStep).
    history: i64,
    /// A narrower resize clamped Alacritty's saved column on the alternate
    /// screen while xterm's, in its emptied buffer, kept it (resize).
    unplaceable: bool,
}

/// A byte of a printed character (not a C0 control or DEL).
fn printable(byte: u8) -> bool {
    byte >= 0x20 && byte != 0x7f
}

/// ICH, DCH or ECH: `CSI Ps @`, `CSI Ps P`, `CSI Ps X`.
fn is_restricting(sequence: &[u8]) -> bool {
    sequence
        .strip_prefix(b"\x1b[")
        .and_then(<[u8]>::split_last)
        .is_some_and(|(last, params)| {
            matches!(last, b'@' | b'P' | b'X')
                && params.iter().all(|&b| b.is_ascii_digit() || b == b';')
        })
}

/// REP: `CSI Ps b`.
fn is_rep(sequence: &[u8]) -> bool {
    sequence
        .strip_prefix(b"\x1b[")
        .and_then(|s| s.strip_suffix(b"b"))
        .is_some_and(|params| params.iter().all(|&b| b.is_ascii_digit() || b == b';'))
}

/// String terminators as PartialSequenceTracker reads them: BEL, CAN, SUB,
/// and ESC (ST, or an abort that starts a new sequence).
fn string_end(data: &[u8]) -> Option<usize> {
    data.iter()
        .position(|b| matches!(b, 0x07 | 0x18 | 0x1a | 0x1b))
}

/// A refusal's family: the `unsupported-*` token before its colon.
fn refusal_family(why: &'static str) -> &'static str {
    why.split(':').next().unwrap_or(why)
}

impl XtermFeed {
    /// Refuse the stream, reported as `why` when it is the first refusal;
    /// every refusal's family is kept in `seen`.
    fn refuse(&mut self, when: bool, why: &'static str) {
        if !when {
            return;
        }
        let family = refusal_family(why);
        if !self.seen.contains(&family) {
            self.seen.push(family);
        }
        if !self.divergent {
            self.divergent = true;
            self.refused = Some(why);
        }
    }

    fn push_tail(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if self.tail_overflow {
                return;
            }
            if b & 0xc0 != 0x80 {
                if self.tail_units >= MAX_TAIL_UNITS {
                    self.tail_overflow = true;
                    self.tail = Vec::new();
                    return;
                }
                self.tail_units += if b >= 0xf0 { 2 } else { 1 };
            }
            self.tail.push(b);
        }
    }

    fn start_string(&mut self) {
        self.in_string = true;
        self.tail.clear();
        self.tail_units = 0;
        self.tail_overflow = false;
    }

    /// Whether xterm and Alacritty leave the same screen after a control
    /// under `rule`. `alt`: Alacritty shows its alternate screen at this
    /// byte, read from its own mode rather than this tracker's (which misses
    /// a sub-parameter like `?1049:0h`, or a mode past 32 parameters).
    /// Alacritty enters it only by 1049; xterm's other entries are refused,
    /// except the round trip, during which Alacritty stays on the main one.
    fn allows(&self, rule: ContextRule, alt: bool) -> bool {
        match rule {
            ContextRule::MouseOff => true,
            ContextRule::AltLeave { mode_47 } if self.round_trip => mode_47,
            ContextRule::AltLeave { .. } => !alt,
            ContextRule::AltEnter => !alt && !self.round_trip,
        }
    }

    /// The refusals a control shows, given the byte after it and whether a
    /// printed character came right before it. `rule`: its `context_rule`.
    /// `alt`: Alacritty's alternate screen at this byte, when the feed's
    /// state is current (see `allows`); past a refusal (`scan`) it is not,
    /// and a `ContextRule` control counts as nothing.
    fn refuse_control(
        &mut self,
        sequence: &[u8],
        rule: Option<ContextRule>,
        next_byte: Option<u8>,
        printed: bool,
        alt: Option<bool>,
    ) {
        let refused = match rule {
            Some(rule) => alt.is_some_and(|alt| !self.allows(rule, alt)),
            // xterm forgets the preceding character at any control;
            // Alacritty repeats whatever was printed last.
            None => crate::native_serialize::divergent(sequence) || (is_rep(sequence) && !printed),
        };
        if refused {
            self.refuse(true, crate::native_serialize::refusal(sequence));
        }
        // A sequence cut short by DEL (or an escape by a byte past ASCII):
        // both parsers ignore DEL there, so `ESC DEL D` is still IND and
        // `CSI ! DEL p` DECSTR, which this scan would not see as such.
        let last = sequence[sequence.len() - 1];
        let cut = if sequence.get(1) == Some(&b'[') {
            !(0x40..=0x7e).contains(&last) && next_byte == Some(0x7f)
        } else {
            !(0x30..=0x7e).contains(&last) && next_byte.is_some_and(|b| b == 0x7f || b >= 0x80)
        };
        self.refuse(
            cut,
            "unsupported-state-cut: a sequence cut short by DEL or a byte past ASCII",
        );
    }

    /// After a refusal: only name the families the rest of the stream holds,
    /// without laying it into the grid. It sees what a control shows by
    /// itself (`refuse_control`, C1, an overlong sequence); a refusal that
    /// needs the screen's state (a restore, margins, a `ContextRule` control
    /// or a round trip) counts only when first.
    fn scan(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(bytes);
        let c1 = crate::native_serialize::c1_at(&data);
        let mut next = if self.in_string {
            self.string_payload(&mut data, 0)
        } else {
            Some(0)
        };
        let mut printed = self.printed;
        while let Some(at) = next {
            let Some(found) = data[at..].iter().position(|&b| b == 0x1b) else {
                if at < data.len() {
                    printed = printable(data[data.len() - 1]);
                }
                break;
            };
            let at = at + found;
            if found > 0 {
                printed = printable(data[at - 1]);
            }
            let Some(len) = crate::native_serialize::sequence_len(&data[at..]) else {
                if data.len() - at <= MAX_HELD {
                    self.held = data.split_off(at);
                } else {
                    self.refuse(true, LONG_SEQUENCE);
                }
                break;
            };
            let sequence = &data[at..at + len];
            if len == 2 && matches!(sequence[1], b']' | b'P' | b'X' | b'^' | b'_') {
                self.start_string();
                next = self.string_payload(&mut data, at + len);
            } else {
                let next_byte = data.get(at + len).copied();
                let sequence = &data[at..at + len];
                self.refuse_control(sequence, context_rule(sequence), next_byte, printed, None);
                next = Some(at + len);
            }
            printed = false;
        }
        self.refuse(c1.is_some(), C1);
        self.printed = printed && self.held.is_empty() && !self.in_string;
    }

    /// Consume a string's payload from `data[at..]`; returns where scanning
    /// resumes, or None when the string continues past the data. An ESC as
    /// the last byte is held: it ends the string only with what follows.
    fn string_payload(&mut self, data: &mut Vec<u8>, at: usize) -> Option<usize> {
        match string_end(&data[at..]).map(|end| at + end) {
            Some(end) if data[end] == 0x1b && end + 1 == data.len() => {
                self.push_tail(&data[at..end]);
                self.held = data.split_off(end);
                None
            }
            Some(end) => {
                self.in_string = false;
                Some(if data[end] == 0x1b { end } else { end + 1 })
            }
            None => {
                self.push_tail(&data[at..]);
                None
            }
        }
    }

    /// The charset slots, DECAWM and DECOM as xterm saves and restores them
    /// with the cursor (DECSC/DECRC, SCOSC/SCORC), to refuse a restore that
    /// Alacritty runs differently. `sequence` has no C0 controls inside.
    /// `history` reads the main screen's history at this sequence. A DECRC
    /// or SCORC returns the screen it restores on, by this tracker.
    fn track_saved_cursor(
        &mut self,
        sequence: &[u8],
        history: &mut dyn FnMut() -> usize,
    ) -> Option<usize> {
        let screen = usize::from(self.alt_screen);
        let plain_csi = |final_byte: u8| {
            sequence
                .strip_prefix(b"\x1b[")
                .and_then(<[u8]>::split_last)
                .is_some_and(|(&last, params)| {
                    last == final_byte && params.iter().all(|&b| b.is_ascii_digit() || b == b';')
                })
        };
        match sequence {
            b"\x1b7" => self.save_cursor(screen, history),
            b"\x1b8" => {
                self.restore_cursor(screen);
                return Some(screen);
            }
            b"\x1bc" => {
                self.no_wraparound = false;
                self.origin = false;
                self.charset_slots = 0;
                self.dec_slots = [false; 4];
                self.saved = Default::default();
            }
            // xterm's softReset resets the charsets and the modes, not the
            // saved ones. It moves the saved cursor to the top left of the
            // screen as it is now (savedY = ybase), as soft_reset_like_xterm
            // does on Alacritty.
            b"\x1b[!p" => {
                self.no_wraparound = false;
                self.origin = false;
                self.charset_slots = 0;
                self.dec_slots = [false; 4];
                self.saved[screen].history = if screen == 0 { history() as i64 } else { 0 };
            }
            b"\x1b%@" | b"\x1b%G" => self.designate(0, false),
            [0x1b, slot @ (b'(' | b')' | b'*' | b'+' | b'-' | b'.'), set @ (b'B' | b'0')] => self
                .designate(
                    match slot {
                        b'(' => 0,
                        b')' | b'-' => 1,
                        b'*' | b'.' => 2,
                        _ => 3,
                    },
                    *set == b'0',
                ),
            _ if plain_csi(b's') => self.save_cursor(screen, history),
            _ if plain_csi(b'u') => {
                self.restore_cursor(screen);
                return Some(screen);
            }
            _ => {}
        }
        None
    }

    fn designate(&mut self, slot: u8, dec: bool) {
        self.charset_slots = self.charset_slots.max(slot + 1);
        self.dec_slots[usize::from(slot)] = dec;
    }

    fn save_cursor(&mut self, screen: usize, history: &mut dyn FnMut() -> usize) {
        self.saved[screen] = SavedCursor {
            saved: true,
            charset_slots: self.charset_slots,
            dec_slots: self.dec_slots,
            no_wraparound: self.no_wraparound,
            origin: self.origin,
            history: if screen == 0 { history() as i64 } else { 0 },
            unplaceable: false,
        };
    }

    /// xterm restores DECAWM and DECOM (their defaults when nothing was
    /// saved) and only the charset slots it saved; Alacritty restores no mode
    /// and every slot. The GL shift needs no check: both save it with the
    /// cursor (xterm's savedGlevel, Alacritty's `Cursor::active_charset`).
    fn restore_cursor(&mut self, screen: usize) {
        let saved = self.saved[screen];
        let later_slot = saved.saved
            && (usize::from(saved.charset_slots)..4)
                .any(|slot| self.dec_slots[slot] != saved.dec_slots[slot]);
        self.refuse(
            later_slot
                || saved.no_wraparound != self.no_wraparound
                || saved.origin != self.origin,
            "unsupported-state-decrc: a cursor restore xterm runs differently (DECAWM, DECOM, or a charset slot designated since the save to another set)",
        );
    }

    /// `rows`: the screen height the sequence is parsed at. `history` reads
    /// the main screen's history after the sequence, C0 controls inside it
    /// included (main_history). A DECRC or SCORC returns the screen it
    /// restores on, by this tracker.
    fn track(
        &mut self,
        sequence: &[u8],
        rows: usize,
        history: &mut dyn FnMut() -> usize,
    ) -> Option<usize> {
        // C0 controls inside a sequence execute and are not part of it.
        let filtered: Vec<u8>;
        let sequence = if sequence[1..].iter().any(|&b| b < 0x20) {
            filtered = sequence[..1]
                .iter()
                .chain(sequence[1..].iter().filter(|&&b| b >= 0x20))
                .copied()
                .collect();
            &filtered[..]
        } else {
            sequence
        };
        let numeric = |params: &[u8]| params.iter().all(|&b| b.is_ascii_digit() || b == b';');
        let restore = self.track_saved_cursor(sequence, history);
        if sequence == b"\x1b[!p" {
            self.set_margins(false);
        }
        self.may_leave_alt = sequence == b"\x1bc";
        if sequence == b"\x1bc" {
            self.main_margins = false;
            self.alt_margins = false;
            self.alt_screen = false;
            self.round_trip = false;
            self.sgr_pixels = false;
            self.sgr_mouse = false;
            self.mouse = 0;
        }
        if sequence == b"\x1b[!p" {
            self.cursor_hidden = false;
        }
        if let Some(params) = sequence
            .strip_prefix(b"\x1b[")
            .and_then(|s| s.strip_suffix(b"r"))
        {
            if numeric(params) {
                self.scroll_region(params, rows);
            }
        }
        if let Some((&last, params)) = sequence
            .strip_prefix(b"\x1b[?")
            .and_then(<[u8]>::split_last)
        {
            if matches!(last, b'h' | b'l') && numeric(params) {
                let set = last == b'h';
                // Modes by number, as xterm reads them: `01000` is 1000.
                let modes = params.split(|&b| b == b';').map(|mode| {
                    std::str::from_utf8(mode)
                        .ok()
                        .and_then(|m| m.parse::<u16>().ok())
                });
                for mode in modes {
                    match mode {
                        Some(25) => self.cursor_hidden = !set,
                        Some(6) => self.origin = set,
                        Some(7) => self.no_wraparound = !set,
                        Some(1016) => self.sgr_pixels = set,
                        Some(1006) => self.sgr_mouse = set,
                        Some(protocol @ (9 | 1000 | 1002 | 1003)) => {
                            self.mouse = if set { protocol } else { 0 };
                        }
                        Some(47 | 1047 | 1049) => {
                            self.may_leave_alt |= !set;
                            // xterm's 1049 saves the cursor on the screen
                            // shown, and restores the main screen's after
                            // showing it.
                            if mode == Some(1049) {
                                if set {
                                    self.save_cursor(usize::from(self.alt_screen), history);
                                } else {
                                    self.restore_cursor(0);
                                }
                            }
                            if set && !self.alt_screen {
                                // xterm's alternate screen starts with its own
                                // full region; Alacritty keeps one region, so
                                // the alternate screen inherits the main one's.
                                self.refuse(
                                    self.main_margins,
                                    "unsupported-state-alt-margins: the alternate screen entered with margins set",
                                );
                            }
                            if !set && self.alt_screen {
                                // xterm clears the alternate screen's region on
                                // leaving it; Alacritty keeps one region for
                                // both screens, so the main screen inherits it.
                                self.refuse(
                                    self.alt_margins,
                                    "unsupported-state-alt-margins: the alternate screen left with margins set",
                                );
                                self.alt_margins = false;
                            }
                            self.alt_screen = set;
                        }
                        _ => {}
                    }
                }
            }
        }
        restore
    }

    /// Feed `bytes`, giving ED 1 and ED 2 xterm's semantics. An unfinished
    /// sequence at the end waits in `held` for the bytes that complete it.
    fn feed(&mut self, parser: &mut Processor, term: &mut Term<VoidListener>, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(bytes);
        // Refused wherever it is; reported first only if it comes first.
        let c1 = crate::native_serialize::c1_at(&data);
        let mut from = 0;
        let mut next = if self.in_string {
            self.string_payload(&mut data, 0)
        } else {
            Some(0)
        };
        // Whether the stream so far ends in a printed character (false after
        // a sequence or string, and at the start of a feed after either).
        let mut printed = self.printed;
        while let Some(at) = next {
            let Some(found) = data[at..].iter().position(|&b| b == 0x1b) else {
                if at < data.len() {
                    printed = printable(data[data.len() - 1]);
                    // Text or a C0 control on xterm's blank alternate screen.
                    self.refuse(self.round_trip, ROUND_TRIP);
                }
                break;
            };
            let at = at + found;
            if found > 0 {
                printed = printable(data[at - 1]);
                self.refuse(self.round_trip, ROUND_TRIP);
            }
            self.refuse(c1.is_some_and(|c1| c1 < at), C1);
            let Some(len) = crate::native_serialize::sequence_len(&data[at..]) else {
                if data.len() - at <= MAX_HELD {
                    self.held = data.split_off(at);
                } else {
                    self.refuse(true, LONG_SEQUENCE);
                }
                break;
            };
            let sequence = &data[at..at + len];
            let rule = context_rule(sequence);
            self.refuse(
                self.round_trip
                    && !is_kitty_keyboard(sequence)
                    && rule != Some(ContextRule::AltLeave { mode_47: true }),
                ROUND_TRIP,
            );
            if sequence == b"\x1b[1J" || sequence == b"\x1b[2J" {
                parser.advance(term, &data[from..at]);
                erase_like_xterm(parser, term, sequence[2] == b'2');
                from = at + len;
                next = Some(at + len);
            } else if sequence == b"\x1bD" || sequence == b"\x1bE" {
                // IND and NEL keep the paragraph, as xterm's `index` does.
                parser.advance(term, &data[from..at]);
                index_like_xterm(parser, term, sequence);
                from = at + len;
                next = Some(at + len);
            } else if let Some(control) = crate::native_serialize::xterm_control(sequence) {
                // vte ignores it: run it as xterm does once vte has parsed it.
                parser.advance(term, &data[from..at + len]);
                run_like_xterm(parser, term, control);
                let rows = term.screen_lines();
                let restore = self.track(sequence, rows, &mut || main_history(parser, term));
                debug_assert!(
                    restore.is_none(),
                    "DECRC and SCORC are not xterm-only controls"
                );
                from = at + len;
                next = Some(at + len);
            } else if is_restricting(sequence) {
                // xterm's ICH, DCH and ECH first restrict the cursor, which
                // drops a pending wrap; Alacritty keeps it.
                parser.advance(term, &data[from..at]);
                let synchronized = parser.sync_timeout().pending_timeout();
                if synchronized {
                    parser.stop_sync(term);
                }
                term.grid_mut().cursor.input_needs_wrap = false;
                if synchronized {
                    parser.advance(term, b"\x1b[?2026h");
                }
                self.shifted |= sequence.last() != Some(&b'X');
                from = at;
                next = Some(at + len);
            } else if len == 2 && matches!(sequence[1], b']' | b'P' | b'X' | b'^' | b'_') {
                self.start_string();
                self.push_tail(sequence);
                next = self.string_payload(&mut data, at + len);
            } else {
                let leave_1049 = resets_1049(sequence);
                let screen_rule = matches!(
                    rule,
                    Some(ContextRule::AltLeave { .. } | ContextRule::AltEnter)
                );
                // Alacritty's own screen before this control (`allows`).
                let alt = if screen_rule || leave_1049.is_some() {
                    parser.advance(term, &data[from..at]);
                    from = at;
                    alternate_shown(parser, term)
                } else {
                    self.alt_screen
                };
                self.refuse_control(
                    sequence,
                    rule,
                    data.get(at + len).copied(),
                    printed,
                    Some(alt),
                );
                match rule {
                    Some(ContextRule::AltEnter) if self.allows(ContextRule::AltEnter, alt) => {
                        self.round_trip = true;
                    }
                    Some(ContextRule::AltLeave { mode_47: true }) => self.round_trip = false,
                    _ => {}
                }
                // Whether Alacritty shows its alternate screen before a control
                // that may leave it (xterm's alternate buffer length, below).
                let shown_before = (sequence == b"\x1bc"
                    || (sequence.starts_with(b"\x1b[?") && sequence.ends_with(b"l")))
                    && {
                        parser.advance(term, &data[from..at]);
                        from = at;
                        alternate_shown(parser, term)
                    };
                // Read only at a save, so the parser runs through the
                // sequence just for those (`from` moves with it): a C0 inside
                // runs first and may scroll, and a save itself never does.
                let rows = term.screen_lines();
                let restore = self.track(sequence, rows, &mut || {
                    parser.advance(term, &data[from..at + len]);
                    from = at + len;
                    main_history(parser, term)
                });
                next = Some(at + len);
                // xterm's ?1049l restores the main screen's saved cursor even
                // on the main screen (the restore seam's first control);
                // Alacritty's does nothing there. Run that restore as xterm
                // does: `track` checked it as the DECRC it then is.
                match leave_1049 {
                    Some(true) if !alt => {
                        parser.advance(term, &data[from..at + len]);
                        from = at + len;
                        restore_like_xterm(parser, term, self.saved[0].history);
                    }
                    Some(false) if !alt => {
                        self.refuse(true, crate::native_serialize::refusal(sequence))
                    }
                    _ => {}
                }
                if let Some(screen) = restore {
                    // A DECRC or SCORC Alacritty runs itself, onto its saved
                    // screen row: move it to xterm's row.
                    parser.advance(term, &data[from..at + len]);
                    from = at + len;
                    let history = self.saved[screen].history;
                    let placed = with_sync_flushed(parser, term, |term| {
                        let alt = term.mode().contains(TermMode::ALT_SCREEN);
                        let placed = alt == (screen == 1);
                        if placed {
                            place_like_xterm(term, history);
                        }
                        placed
                    });
                    self.refuse(!placed, RESTORE_ROW);
                    self.refuse(
                        screen == 1
                            && (self.saved[1].unplaceable
                                || self.alt_overhang
                                || self.alt_rows > rows),
                        RESTORE_ROW_ALT,
                    );
                }
                if self.may_leave_alt {
                    // xterm empties its alternate buffer on leaving it, which
                    // sets the buffer's length back to the screen rows; RIS
                    // makes new buffers. Decided by Alacritty's own mode, as
                    // below.
                    parser.advance(term, &data[from..at + len]);
                    from = at + len;
                    if sequence == b"\x1bc" || (shown_before && !alternate_shown(parser, term)) {
                        self.alt_rows = rows;
                        self.alt_overhang = false;
                    }
                }
                if self.alt_reflow && self.may_leave_alt {
                    // Leaving the alternate screen, or a reset there, drops
                    // its rows on both (xterm at once, Alacritty on the next
                    // entry), and with them the wrap flags a width change
                    // lost. Decided by Alacritty's own mode at this byte, not
                    // this tracker's: past 32 parameters, for one, they
                    // disagree on whether a leave happened.
                    parser.advance(term, &data[from..at + len]);
                    from = at + len;
                    self.alt_reflow = alternate_shown(parser, term);
                }
            }
            printed = false;
        }
        self.refuse(c1.is_some(), C1);
        // A held sequence or an unfinished string ends the stream so far.
        self.printed = printed && self.held.is_empty() && !self.in_string;
        parser.advance(term, &data[from..]);
    }

    /// DECSTBM as xterm's setScrollRegion reads it (MarginTracker): top
    /// defaults to 1, bottom to the rows, 0 is the default, a bottom past the
    /// screen is the screen, and a region whose bottom is not below its top
    /// is ignored. Only a region narrower than the screen is active.
    fn scroll_region(&mut self, params: &[u8], rows: usize) {
        let mut values = params.split(|&b| b == b';').map(|digits| {
            digits.iter().fold(0usize, |n, &d| {
                n.saturating_mul(10).saturating_add(usize::from(d - b'0'))
            })
        });
        let first = values.next().unwrap_or(0);
        let second = values.next().unwrap_or(0);
        let top = first.max(1);
        let bottom = if second == 0 || second > rows {
            rows
        } else {
            second
        };
        if bottom > top {
            self.set_margins(top != 1 || bottom != rows);
        } else {
            // xterm ignores it; Alacritty keeps a bottom past the screen
            // (saturated to u16) and applies any top above it.
            let cap = usize::from(u16::MAX);
            self.refuse(
                second > rows && top.min(cap) < second.min(cap),
                "unsupported-state-margins: a region only Alacritty applies",
            );
        }
    }

    /// Set the active screen's margins.
    fn set_margins(&mut self, narrowed: bool) {
        if self.alt_screen {
            self.alt_margins = narrowed;
        } else {
            self.main_margins = narrowed;
        }
    }

    /// A region narrower than the screen on either screen: the snapshot
    /// restores neither.
    fn margins(&self) -> bool {
        self.main_margins || self.alt_margins
    }

    /// The bytes that leave a replaying parser where this one is: the
    /// unfinished string or sequence the stream ends inside.
    fn pending_tail(&self) -> std::result::Result<Vec<u8>, &'static str> {
        if !self.in_string {
            return Ok(self.held.clone());
        }
        if self.tail_overflow {
            return Err("partial-tail-overflow");
        }
        Ok([self.tail.as_slice(), &self.held].concat())
    }
}

/// IND or NEL (`sequence`, C0 controls or DEL inside included) as xterm's
/// `index`.
fn index_like_xterm(parser: &mut Processor, term: &mut Term<VoidListener>, sequence: &[u8]) {
    // vte runs IND and NEL through the line feed, which ends the paragraph of
    // the row it enters as xterm's `lineFeed` does (vendor `line_down`);
    // xterm's `index` keeps it. Put back the flag it cleared, which it does
    // only when the cursor moved down one row.
    let synchronized = parser.sync_timeout().pending_timeout();
    if synchronized {
        parser.stop_sync(term);
    }
    let line = term.grid().cursor.point.line;
    let last = term.grid().last_column();
    let wrapped = term.grid()[line][last].flags.contains(Flags::WRAPLINE);
    parser.advance(term, sequence);
    if wrapped && term.grid().cursor.point.line == line + 1 {
        term.grid_mut()[line][last].flags.insert(Flags::WRAPLINE);
    }
    if synchronized {
        parser.advance(term, b"\x1b[?2026h");
    }
}

/// Run `f` on Alacritty with every byte the parser holds in a synchronized
/// update applied first, then re-enter the update.
fn with_sync_flushed<R>(
    parser: &mut Processor,
    term: &mut Term<VoidListener>,
    f: impl FnOnce(&mut Term<VoidListener>) -> R,
) -> R {
    let synchronized = parser.sync_timeout().pending_timeout();
    if synchronized {
        parser.stop_sync(term);
    }
    let result = f(term);
    if synchronized {
        parser.advance(term, b"\x1b[?2026h");
    }
    result
}

/// Alacritty shows its alternate screen.
fn alternate_shown(parser: &mut Processor, term: &mut Term<VoidListener>) -> bool {
    with_sync_flushed(parser, term, |term| {
        term.mode().contains(TermMode::ALT_SCREEN)
    })
}

/// The main screen's history (rows above the screen), with the bytes a
/// synchronized update holds back applied. The alternate screen keeps none.
fn main_history(parser: &mut Processor, term: &mut Term<VoidListener>) -> usize {
    with_sync_flushed(parser, term, |term| main_grid(term).history_size())
}

/// The main screen's grid, whichever screen is shown.
fn main_grid(term: &Term<VoidListener>) -> &Grid<Cell> {
    if term.mode().contains(TermMode::ALT_SCREEN) {
        term.inactive_grid()
    } else {
        term.grid()
    }
}

/// xterm's restoreCursor (DECRC) on Alacritty's main screen, once the parser
/// has taken the control that runs it. xterm puts back the colours, not the
/// open hyperlink (`extended.urlId` stays), and clamps the cursor into the
/// last column, which drops a pending wrap. The row is xterm's
/// (place_like_xterm).
fn restore_like_xterm(parser: &mut Processor, term: &mut Term<VoidListener>, history: i64) {
    with_sync_flushed(parser, term, |term| {
        let link = term.grid().cursor.template.hyperlink();
        term.restore_cursor_position();
        let cursor = &mut term.grid_mut().cursor;
        cursor.template.set_hyperlink(link);
        cursor.input_needs_wrap = false;
        place_like_xterm(term, history);
    });
}

/// Moves the cursor a restore on the main screen just put on Alacritty's
/// saved screen row to xterm's row.
///
/// xterm saves an absolute row (`ybase + y`) and restores `savedY - ybase`:
/// each row the stream scrolled into history since the save (`history`, the
/// main screen's then) moves it up by one, and ED 3 moves it down by the rows
/// it cleared. Then `_restrictCursor` keeps it on the screen, or inside the
/// scrolling region with DECOM on (restored from the save, which `track`
/// checked equal to the mode in force).
fn place_like_xterm(term: &mut Term<VoidListener>, history: i64) {
    let (top, bottom) = if term.mode().contains(TermMode::ORIGIN) {
        let region = term.scroll_region();
        (i64::from(region.start.0), i64::from(region.end.0) - 1)
    } else {
        (0, term.screen_lines() as i64 - 1)
    };
    let now = term.grid().history_size() as i64;
    let cursor = &mut term.grid_mut().cursor;
    let row = i64::from(cursor.point.line.0) + history - now;
    cursor.point.line = Line(row.clamp(top, bottom) as i32);
}

/// xterm's saved row on one screen across the row step of a resize, while
/// that step runs on its own (`Term::resize` at the old width).
///
/// The save stays placeable while xterm's absolute saved row equals the save's
/// history plus Alacritty's saved screen row (place_like_xterm). Alacritty's
/// own rule is observed: `shrink_lines` clamps its saved row onto the new
/// screen, and `grow_lines` moves it down by the history rows it pulls.
/// xterm's is computed (`Buffer.resize`): its saved row stays absolute. A
/// shorter screen pushes the rows the cursor needs into history, then trims
/// the rows past the cap from the top and moves the saved row up with them
/// (`savedY = Math.max(savedY - amountToTrim, 0)`). The alternate screen is
/// the same with no history and a cap of 0.
struct RowStep {
    /// xterm's saved row, absolute in this grid's rows, once trimmed.
    xterm_saved: i64,
}

impl RowStep {
    fn before(grid: &Grid<Cell>, saved_history: i64, target: usize, cap: usize) -> Self {
        let rows = grid.screen_lines() as i64;
        let target = target as i64;
        let history = grid.history_size() as i64;
        let saved = saved_history + i64::from(grid.saved_cursor.point.line.0);
        let trimmed = if target < rows {
            let pushed = (i64::from(grid.cursor.point.line.0) + 1 - target).max(0);
            (history + pushed - cap as i64).max(0)
        } else {
            0
        };
        RowStep {
            xterm_saved: (saved - trimmed).max(0),
        }
    }

    /// A screen xterm's resize skips: its alternate buffer while another is
    /// shown, emptied when it was left. The saved row stays as it is.
    fn untouched(grid: &Grid<Cell>, saved_history: i64) -> Self {
        RowStep {
            xterm_saved: saved_history + i64::from(grid.saved_cursor.point.line.0),
        }
    }

    /// The save's history once Alacritty's grid has run the step.
    fn after(&self, grid: &Grid<Cell>) -> i64 {
        self.xterm_saved - i64::from(grid.saved_cursor.point.line.0)
    }
}

/// The alternate screen's grid, whichever screen is shown.
fn alt_grid(term: &Term<VoidListener>) -> &Grid<Cell> {
    if term.mode().contains(TermMode::ALT_SCREEN) {
        term.grid()
    } else {
        term.inactive_grid()
    }
}

const HISTORY_LIMIT: &str = "unsupported-history-limit: history reached the native grid cap";

/// Past the native cap xterm keeps rows this grid trimmed (its own cap,
/// `requested`, is larger), so the history and the saved rows part.
fn history_at_native_cap(term: &Term<VoidListener>, requested: u32, cap: u32) -> bool {
    requested > cap
        && [term.grid(), term.inactive_grid()]
            .iter()
            .any(|grid| grid.history_size() >= cap as usize)
}

/// A DECRST that resets 1049, read as `track` reads it (C0 controls inside
/// run and are not part of it): `Some(true)` with 1049 as its only mode in
/// plain digits, `Some(false)` in a list (`divergent` refuses a sub-parameter
/// or a list past 32 parameters before this runs).
fn resets_1049(sequence: &[u8]) -> Option<bool> {
    let filtered: Vec<u8>;
    let sequence = if sequence[1..].iter().any(|&b| b < 0x20) {
        filtered = sequence[..1]
            .iter()
            .chain(sequence[1..].iter().filter(|&&b| b >= 0x20))
            .copied()
            .collect();
        &filtered[..]
    } else {
        sequence
    };
    let params = sequence.strip_prefix(b"\x1b[?")?.strip_suffix(b"l")?;
    if params.is_empty() || !params.iter().all(|&b| b.is_ascii_digit() || b == b';') {
        return None;
    }
    let mut count = 0;
    let mut found = false;
    for mode in params.split(|&b| b == b';') {
        count += 1;
        let value = mode.iter().fold(0u32, |n, &d| {
            n.saturating_mul(10).saturating_add(u32::from(d - b'0'))
        });
        found |= value == 1049 && !mode.is_empty();
    }
    found.then_some(count == 1)
}

/// A control vte ignores (native_serialize::XtermControl), run as xterm.js
/// does after the parser has taken its bytes.
fn run_like_xterm(parser: &mut Processor, term: &mut Term<VoidListener>, control: XtermControl) {
    // Inside a synchronized update the parser holds bytes back: apply them
    // first. xterm's soft reset ends the update; the others re-enter it.
    let synchronized = parser.sync_timeout().pending_timeout();
    if synchronized {
        parser.stop_sync(term);
    }
    match control {
        XtermControl::Shift(index) => term.set_active_charset(index),
        XtermControl::DefaultCharset => {
            term.configure_charset(CharsetIndex::G0, StandardCharset::Ascii);
            term.set_active_charset(CharsetIndex::G0);
        }
        XtermControl::Designate(index, charset) => term.configure_charset(index, charset),
        XtermControl::SoftReset => soft_reset_like_xterm(term),
    }
    if synchronized && control != XtermControl::SoftReset {
        parser.advance(term, b"\x1b[?2026h");
    }
}

/// xterm.js's softReset (DECSTR). The cursor is shown and stays where it is,
/// pending wrap included. The margins are the full screen. The attributes are
/// the defaults, with no link. IRM and the DEC modes xterm tracks return to
/// their defaults (autowrap on, the others off; the cursor style to the
/// default). G0-G3 are ASCII with G0 shifted in. The saved cursor moves to the
/// top left with default attributes and keeps its charsets and shift, as
/// xterm keeps its saved charsets and G-level. Mouse tracking and the screen
/// shown stay as they are. A synchronized update ends (run_like_xterm).
fn soft_reset_like_xterm(term: &mut Term<VoidListener>) {
    let point = term.grid().cursor.point;
    let wrap = term.grid().cursor.input_needs_wrap;
    // Alacritty's DECSTBM homes the cursor; it is put back below.
    term.set_scrolling_region(1, None);
    term.set_private_mode(NamedPrivateMode::ShowCursor.into());
    term.set_private_mode(NamedPrivateMode::LineWrap.into());
    for mode in [
        NamedPrivateMode::CursorKeys,
        NamedPrivateMode::Origin,
        NamedPrivateMode::ReportFocusInOut,
        NamedPrivateMode::BracketedPaste,
    ] {
        term.unset_private_mode(mode.into());
    }
    term.unset_mode(NamedMode::Insert.into());
    term.unset_keypad_application_mode();
    term.set_cursor_style(None);
    term.pop_keyboard_modes(u16::MAX);
    term.terminal_attribute(Attr::Reset);
    term.set_hyperlink(None);
    for index in [
        CharsetIndex::G0,
        CharsetIndex::G1,
        CharsetIndex::G2,
        CharsetIndex::G3,
    ] {
        term.configure_charset(index, StandardCharset::Ascii);
    }
    term.set_active_charset(CharsetIndex::G0);
    let grid = term.grid_mut();
    grid.cursor.point = point;
    grid.cursor.input_needs_wrap = wrap;
    grid.saved_cursor.point = Point::new(Line(0), Column(0));
    grid.saved_cursor.template = Cell::default();
    grid.saved_cursor.input_needs_wrap = false;
}

/// `parser.advance` for a stream no XtermFeed scans (the text snapshot), with
/// IND and NEL as xterm's `index`. Both parsers execute C0 controls and ignore
/// DEL between the ESC and its final byte. An ESC still waiting for that byte
/// at the end of `bytes` waits in `held` with what follows it, up to
/// MAX_HELD bytes as XtermFeed holds; past that it goes to the parser as is.
fn advance_indexing(
    parser: &mut Processor,
    term: &mut Term<VoidListener>,
    held: &mut Vec<u8>,
    bytes: &[u8],
) {
    let joined;
    let bytes = if held.is_empty() {
        bytes
    } else {
        let mut data = std::mem::take(held);
        data.extend_from_slice(bytes);
        joined = data;
        &joined[..]
    };
    let mut from = 0;
    let mut at = 0;
    while let Some(found) = bytes[at..].iter().position(|&b| b == 0x1b) {
        let esc = at + found;
        let mut end = esc + 1;
        while bytes
            .get(end)
            .is_some_and(|&b| (b < 0x20 && !matches!(b, 0x18 | 0x1a | 0x1b)) || b == 0x7f)
        {
            end += 1;
        }
        match bytes.get(end) {
            None if bytes.len() - esc <= MAX_HELD => {
                parser.advance(term, &bytes[from..esc]);
                held.extend_from_slice(&bytes[esc..]);
                return;
            }
            None => break,
            Some(b'D' | b'E') => {
                parser.advance(term, &bytes[from..esc]);
                index_like_xterm(parser, term, &bytes[esc..=end]);
                from = end + 1;
                at = from;
            }
            Some(_) => at = esc + 1,
        }
    }
    parser.advance(term, &bytes[from..]);
}

/// xterm's ED 1 / ED 2, where Alacritty differs: its ED 2 on the primary
/// screen scrolls the screen into history (its ED 1 used to skip the top row
/// from the second; the vendored handler now matches xterm). The renderer is
/// xterm.
fn erase_like_xterm(parser: &mut Processor, term: &mut Term<VoidListener>, all: bool) {
    // A real ESC [ ends any string or sequence in progress; Alacritty
    // ignores DECSED, so this ends it the same way and does nothing else.
    parser.advance(term, b"\x1b[?J");
    // Inside a synchronized update the parser holds bytes back; apply them
    // first, then re-enter the update (buffering is timing, not state).
    let synchronized = parser.sync_timeout().pending_timeout();
    if synchronized {
        parser.stop_sync(term);
    }
    if all {
        // Whole lines over their physical width: an alternate-screen row
        // keeps cells past a narrower width, and xterm erases those too.
        term.grid_mut().reset_region_keep_width(..);
        // No row is a continuation any more (xterm's isWrapped): the reset
        // rows lost their wraps; the top row's comes from history.
        term.end_wrap_into(Line(0));
    } else {
        // The vendored ED 1 is xterm's: the rows above reset over their
        // physical width, the cursor's row erased up to it, its wraps and
        // empty run kept as xterm keeps them.
        term.clear_screen(ClearMode::Above);
    }
    if synchronized {
        parser.advance(term, b"\x1b[?2026h");
    }
}

#[napi]
impl NativeTerminal {
    #[napi(constructor, catch_unwind)]
    pub fn new(cols: u32, rows: u32, scrollback: u32) -> Result<Self> {
        let size = dimensions(cols, rows)?;
        if scrollback > 100_000 || (rows as u64 + scrollback as u64) * cols as u64 > 4_000_000 {
            return Err(Error::from_reason(
                "Experiment grid exceeds four million cells",
            ));
        }
        let config = Config {
            scrolling_history: scrollback as usize,
            osc52: Osc52::Disabled,
            ..Config::default()
        };
        Ok(Self {
            term: Some(Term::new(config, &size, VoidListener)),
            parser: Processor::new(),
            scrollback,
            requested_scrollback: scrollback,
            feed: XtermFeed {
                alt_rows: rows as usize,
                ..XtermFeed::default()
            },
            refusal: None,
            scanned: 0,
            text_held: Vec::new(),
        })
    }

    #[napi(catch_unwind)]
    pub fn feed(&mut self, bytes: Uint8Array) -> Result<()> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        // Parser retains incomplete UTF-8 / escape state across feeds.
        // VoidListener intentionally discards all PTY replies and clipboard events.
        advance_indexing(&mut self.parser, term, &mut self.text_held, &bytes);
        Ok(())
    }

    /// `feed` for an ANSI snapshot replayed by xterm: ED 1 and ED 2 erase as
    /// xterm does (see erase_like_xterm). The snapshot is refused for good by
    /// a control Alacritty parses differently, or by a history past this
    /// terminal's cap when the request asked for more; an alternate screen's
    /// width change is not reported (leaving that screen later in the stream
    /// lifts it). Past the refusal, the next REFUSAL_SCAN_BYTES are only
    /// scanned for other refusal families (refusal_families), not laid into
    /// the grid. Returns true once refused and that scan is done: the caller
    /// stops parsing then.
    #[napi(catch_unwind)]
    pub fn feed_xterm(&mut self, bytes: Uint8Array, requested_scrollback: u32) -> Result<bool> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        if self.refusal.is_some() {
            let take = bytes.len().min(REFUSAL_SCAN_BYTES - self.scanned);
            self.feed.scan(&bytes[..take]);
            self.scanned += take;
            return Ok(self.scanned >= REFUSAL_SCAN_BYTES);
        }
        self.requested_scrollback = requested_scrollback;
        self.feed.feed(&mut self.parser, term, &bytes);
        if self.feed.divergent {
            self.refusal = Some(
                self.feed
                    .refused
                    .unwrap_or("unsupported-state: a control Alacritty parses differently"),
            );
        } else if history_at_native_cap(term, requested_scrollback, self.scrollback) {
            self.refusal = Some(HISTORY_LIMIT);
        }
        // Refused in these bytes: the scan of the next ones comes first.
        Ok(false)
    }

    /// Every refusal family the ANSI feed met, the reported one first, each
    /// once. Empty while the snapshot is not refused.
    #[napi(catch_unwind)]
    pub fn refusal_families(&self) -> Result<Vec<String>> {
        let mut families: Vec<&'static str> =
            self.refusal.map(refusal_family).into_iter().collect();
        for family in &self.feed.seen {
            if !families.contains(family) {
                families.push(family);
            }
        }
        Ok(families.into_iter().map(str::to_owned).collect())
    }

    /// Replay an immutable native ring copy without a full JS Buffer round trip.
    #[napi(catch_unwind)]
    pub fn feed_frozen(&mut self, source: &NativeFrozenRing, start: u32, end: u32) -> Result<()> {
        let bytes = source
            .bytes
            .get(start as usize..end as usize)
            .ok_or_else(|| Error::from_reason("Invalid frozen ring range"))?;
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        advance_indexing(&mut self.parser, term, &mut self.text_held, bytes);
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn resize(&mut self, cols: u32, rows: u32) -> Result<()> {
        let size = dimensions(cols, rows)?;
        if (rows as u64 + self.scrollback as u64) * cols as u64 > 4_000_000 {
            return Err(Error::from_reason(
                "Experiment grid exceeds four million cells",
            ));
        }
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        // The row step runs at the old width first (below).
        if (rows as u64 + self.scrollback as u64) * term.columns() as u64 > 4_000_000 {
            return Err(Error::from_reason(
                "Experiment grid exceeds four million cells",
            ));
        }
        // vte holds bytes back inside a synchronized update; xterm parsed them
        // at the old size. Apply them first, then re-enter the update.
        let synchronized = self.parser.sync_timeout().pending_timeout();
        if synchronized {
            self.parser.stop_sync(term);
        }
        // xterm never reflows or cuts the alternate screen: its rows keep
        // their cells and wrap flags across a resize. The vendored grid keeps
        // a row's cells past a narrower width and shows them again when it
        // widens, as xterm's does (vendor/alacritty_terminal WMUX-PATCH.md),
        // but a width change with a soft-wrapped row on screen loses the
        // flags, until the screen is left.
        if term.mode().contains(TermMode::ALT_SCREEN) {
            let grid = term.grid();
            let old = grid.columns();
            if old != cols as usize
                && (0..grid.screen_lines() as i32).any(|y| {
                    grid[Line(y)][Column(old - 1)]
                        .flags
                        .contains(Flags::WRAPLINE)
                })
            {
                self.feed.alt_reflow = true;
            }
        }
        // Narrower, a paragraph below the cursor's that reflows: xterm moves
        // its cursor row by the rows that adds as if they were above it and
        // clips a different row than Alacritty does. (A widen follows xterm's
        // rule in the vendored grow_columns.)
        let primary = main_grid(term);
        // xterm resizes its alternate screen's cursor without a reflow, and
        // the round trip's `?47l` then hands it to the main screen.
        let resized =
            term.columns() != size.columns() || term.screen_lines() != size.screen_lines();
        if self.feed.round_trip && resized {
            self.refusal
                .get_or_insert("unsupported-state-mode: a resize between ?47h and ?47l");
        }
        if reflows_below_cursor(primary, cols as usize) {
            self.refusal.get_or_insert(
                "unsupported-reflow: a paragraph below the cursor reflows, which moves xterm's cursor off its row",
            );
        }
        // Both terminals reset the margins of both screens on a size change.
        if resized {
            self.feed.main_margins = false;
            self.feed.alt_margins = false;
        }
        // A resize moves rows between the screen and the history on both
        // terminals, and each moves its saved rows by its own rules. Both
        // change rows before they reflow columns (Alacritty's Grid::resize;
        // xterm's Buffer.resize runs _reflow last), so the row step runs on
        // its own first and each screen's save is carried across it
        // (RowStep). Then the column step's history change is carried, so a
        // later restore counts only the rows the stream scrolled
        // (place_like_xterm).
        let target = size.screen_lines();
        let alt = term.mode().contains(TermMode::ALT_SCREEN);
        // xterm's alternate buffer, emptied whenever it is left, is skipped by
        // its resize: it keeps the length it had, so shown again on fewer
        // rows it keeps rows above the screen that Alacritty's has none of,
        // and its saved column is not clamped.
        if alt && self.feed.alt_rows > term.screen_lines() {
            self.feed.alt_overhang = true;
        }
        if !alt && alt_grid(term).saved_cursor.point.column.0 >= size.columns() {
            self.feed.saved[1].unplaceable = true;
        }
        self.feed.alt_rows = if alt {
            target
        } else {
            self.feed.alt_rows.max(target)
        };
        if term.screen_lines() != target {
            let main_step = RowStep::before(
                main_grid(term),
                self.feed.saved[0].history,
                target,
                self.scrollback as usize,
            );
            let alt_step = if alt {
                RowStep::before(alt_grid(term), self.feed.saved[1].history, target, 0)
            } else {
                RowStep::untouched(alt_grid(term), self.feed.saved[1].history)
            };
            term.resize(dimensions(term.columns() as u32, rows)?);
            self.feed.saved[0].history = main_step.after(main_grid(term));
            self.feed.saved[1].history = alt_step.after(alt_grid(term));
            // Checked here too: a wider reflow next can take history back
            // under the cap after the row step trimmed at it.
            if history_at_native_cap(term, self.requested_scrollback, self.scrollback) {
                self.refusal.get_or_insert(HISTORY_LIMIT);
            }
        }
        let before = main_grid(term).history_size() as i64;
        term.resize(size);
        self.feed.saved[0].history += main_grid(term).history_size() as i64 - before;
        // feed_xterm checks the same after a chunk, where the chunk's own
        // ED 3 could hide a resize's trim.
        if history_at_native_cap(term, self.requested_scrollback, self.scrollback) {
            self.refusal.get_or_insert(HISTORY_LIMIT);
        }
        if synchronized {
            self.parser.advance(term, b"\x1b[?2026h");
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn text_snapshot(&mut self, undimmed: bool) -> Result<NativeTextSnapshot> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        let held = std::mem::take(&mut self.text_held);
        self.parser.advance(term, &held);
        // A text read must include bytes in an unfinished synchronized update.
        // This finalizes the batch; this API does not promise ANSI replay state.
        self.parser.stop_sync(term);
        let grid = term.grid();
        let history = grid.history_size() as i32;
        let mut rows = Vec::with_capacity(grid.total_lines());
        let mut wrapped = false;
        for y in -history..grid.screen_lines() as i32 {
            let line = &grid[Line(y)];
            let mut text = String::new();
            let mut plain = String::new();
            for x in 0..grid.columns() {
                let cell = &line[Column(x)];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                text.push(cell.c);
                if let Some(chars) = cell.zerowidth() {
                    text.extend(chars);
                }
                if undimmed {
                    if cell.flags.contains(Flags::DIM) {
                        plain.push(' ');
                        if cell.flags.contains(Flags::WIDE_CHAR) {
                            plain.push(' ');
                        }
                    } else {
                        plain.push(cell.c);
                        if let Some(chars) = cell.zerowidth() {
                            plain.extend(chars);
                        }
                    }
                }
            }
            rows.push(NativeTextRow {
                // xterm trims blank grid cells, not arbitrary Unicode whitespace.
                text: text.trim_end_matches(' ').to_owned(),
                wrapped,
                undimmed: undimmed.then(|| plain.trim_end().to_owned()),
            });
            wrapped = line[Column(grid.columns() - 1)]
                .flags
                .contains(Flags::WRAPLINE);
        }
        while rows.last().is_some_and(|r| r.text.is_empty()) {
            rows.pop();
        }
        let cursor_row = history + grid.cursor.point.line.0;
        let rows_below_cursor = (rows.len() as i32 - 1 - cursor_row).max(0) as u32;
        Ok(NativeTextSnapshot {
            rows,
            rows_below_cursor,
            buffer_type: if term.mode().contains(TermMode::ALT_SCREEN) {
                "alternate"
            } else {
                "normal"
            }
            .into(),
        })
    }

    /// `requested_scrollback` above this terminal's own limit means the
    /// caller capped the history to bound memory: a history that reached the
    /// cap may have dropped rows the request would have kept.
    #[napi(catch_unwind)]
    pub fn ansi_snapshot(&mut self, requested_scrollback: Option<u32>) -> Result<Buffer> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        // An unfinished sequence is part of the stream: parse it, then ship it.
        self.parser.advance(term, &self.feed.held);
        // Bytes held in a synchronized update count for the checks below.
        let synchronized = self.parser.sync_timeout().pending_timeout();
        self.parser.stop_sync(term);
        // xterm still shows the blank alternate screen; Alacritty the main.
        if self.feed.round_trip && self.refusal.is_none() {
            self.feed.refuse(true, OPEN_ROUND_TRIP);
            self.refusal = Some(OPEN_ROUND_TRIP);
        }
        if let Some(refusal) = self.refusal {
            return Err(Error::from_reason(refusal));
        }
        if self.feed.alt_reflow {
            return Err(Error::from_reason(
                "unsupported-reflow: the alternate screen changed width, which xterm leaves uncut",
            ));
        }
        if requested_scrollback.is_some_and(|requested| requested > self.scrollback)
            && [term.grid(), term.inactive_grid()]
                .iter()
                .any(|grid| grid.history_size() >= self.scrollback as usize)
        {
            return Err(Error::from_reason(
                "unsupported-history-limit: history reached the native grid cap",
            ));
        }
        // xterm's SerializeAddon drops margins: both paths replay raw then.
        if self.feed.margins() {
            return Err(Error::from_reason("margins"));
        }
        let tail = self.feed.pending_tail().map_err(Error::from_reason)?;
        let mut result = crate::native_serialize::serialize(term, !self.feed.shifted)
            .map_err(Error::from_reason)?;
        // Mouse protocol and encoding as xterm's modes tail restores them: the
        // encoding only while a protocol is on.
        if self.feed.mouse != 0 {
            result.push_str(&format!("\x1b[?{}h", self.feed.mouse));
            if self.feed.sgr_pixels {
                result.push_str("\x1b[?1016h");
            } else if self.feed.sgr_mouse {
                result.push_str("\x1b[?1006h");
            }
        }
        if synchronized {
            result.push_str("\x1b[?2026h");
        }
        // Asserted always: a reflush lands on a client whose cursor may be hidden.
        result.push_str(if self.feed.cursor_hidden {
            "\x1b[?25l"
        } else {
            "\x1b[?25h"
        });
        let mut payload = result.into_bytes();
        payload.extend_from_slice(&tail);
        Ok(payload.into())
    }

    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.term = None;
        self.parser = Processor::new();
    }
}

enum ReadEvent {
    Data(Vec<u8>),
    Eof,
    Error(String),
}

#[napi(object)]
pub struct NativePtyRead {
    pub data: Buffer,
    pub eof: bool,
    pub error: Option<String>,
}

/// Polling transport for the experiment only; no JS callbacks from reader threads.
/// The 16 x 16 KiB channel bounds queued bytes and applies OS-level backpressure.
#[napi]
pub struct NativePty {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Arc<Mutex<Box<dyn Child + Send + Sync>>>>,
    receiver: Option<Receiver<ReadEvent>>,
    eof: bool,
    pid: u32,
}

#[napi]
impl NativePty {
    #[napi(constructor, catch_unwind)]
    pub fn new(
        command: String,
        args: Vec<String>,
        cwd: String,
        cols: u32,
        rows: u32,
    ) -> Result<Self> {
        dimensions(cols, rows)?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows as u16,
                cols: cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);
        let (sender, receiver) = sync_channel(16);
        let mut result = Self {
            master: Some(pair.master),
            writer: Some(writer),
            child: Some(Arc::new(Mutex::new(child))),
            receiver: Some(receiver),
            eof: false,
            pid,
        };
        let spawned = std::thread::Builder::new()
            .name("wmux-spike-pty-read".into())
            .spawn(move || {
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    let event = match reader.read(&mut buffer) {
                        Ok(0) => ReadEvent::Eof,
                        Ok(n) => ReadEvent::Data(buffer[..n].to_vec()),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => ReadEvent::Error(e.to_string()),
                    };
                    let done = !matches!(event, ReadEvent::Data(_));
                    if sender.send(event).is_err() || done {
                        break;
                    }
                }
            });
        if let Err(e) = spawned {
            result.close();
            return Err(Error::from_reason(e.to_string()));
        }
        Ok(result)
    }

    #[napi(getter, catch_unwind)]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    #[napi(catch_unwind)]
    pub fn read(&mut self) -> Result<NativePtyRead> {
        let receiver = self
            .receiver
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?;
        let mut data = Vec::new();
        let mut error = None;
        // Bound each JS poll even if the producer continuously refills the channel.
        for _ in 0..16 {
            match receiver.try_recv() {
                Ok(ReadEvent::Data(bytes)) => data.extend(bytes),
                Ok(ReadEvent::Eof) | Err(TryRecvError::Disconnected) => {
                    self.eof = true;
                    break;
                }
                Ok(ReadEvent::Error(e)) => {
                    error = Some(e);
                    self.eof = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        Ok(NativePtyRead {
            data: data.into(),
            eof: self.eof,
            error,
        })
    }

    /// Small control writes only. A production adapter must move potentially
    /// blocking writes off Node's event loop and implement node-pty's contract.
    #[napi(catch_unwind)]
    pub fn write(&mut self, bytes: Uint8Array) -> Result<()> {
        if bytes.len() > 4096 {
            return Err(Error::from_reason(
                "Experiment writes limited to 4096 bytes",
            ));
        }
        self.writer
            .as_mut()
            .ok_or_else(|| Error::from_reason("PTY closed"))?
            .write_all(&bytes)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        dimensions(cols, rows)?;
        self.master
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?
            .resize(PtySize {
                cols: cols as u16,
                rows: rows as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn try_wait(&mut self) -> Result<Option<u32>> {
        let child = self
            .child
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?;
        // kill() can own the lock during its OS grace period; never stall Node.
        let Ok(mut child) = child.try_lock() else {
            return Ok(None);
        };
        child
            .try_wait()
            .map(|status| status.map(|s| s.exit_code()))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(catch_unwind)]
    pub fn kill(&mut self) -> Result<AsyncTask<KillPty>> {
        let child = self
            .child
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY closed"))?;
        Ok(AsyncTask::new(KillPty {
            child: Arc::clone(child),
        }))
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self) {
        self.receiver.take();
        self.writer.take();
        self.master.take();
        if let Some(child) = self.child.take() {
            // Both termination's grace period and reaping belong off the JS thread.
            // This owns the immediate child, not arbitrary detached descendants.
            std::thread::spawn(move || {
                if let Ok(mut child) = child.lock() {
                    if !matches!(child.try_wait(), Ok(Some(_))) {
                        let _ = child.kill();
                    }
                    let _ = child.wait();
                }
            });
        }
    }
}

impl Drop for NativePty {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct KillPty {
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}
impl Task for KillPty {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| Error::from_reason("PTY lock poisoned"))?;
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Ok(());
        }
        child.kill().map_err(|e| Error::from_reason(e.to_string()))
    }
    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct GeometryMark {
    at: u64,
    cols: u32,
    rows: u32,
}

#[napi(object)]
pub struct NativeGeometrySize {
    pub cols: u32,
    pub rows: u32,
}
#[napi(object)]
pub struct NativeGeometryChange {
    pub offset: f64,
    pub cols: u32,
    pub rows: u32,
}
#[napi(object)]
pub struct NativeReplayGeometry {
    pub start: NativeGeometrySize,
    pub changes: Vec<NativeGeometryChange>,
}
#[napi(object)]
pub struct NativeRingSnapshot {
    pub data: Buffer,
    pub written_at: f64,
    pub geometry: Option<NativeReplayGeometry>,
}

#[napi]
pub struct NativeFrozenRing {
    bytes: Vec<u8>,
    geometry: Vec<GeometryMark>,
    written_at: u64,
}
#[napi]
impl NativeFrozenRing {
    #[napi(getter, catch_unwind)]
    pub fn size(&self) -> u32 {
        self.bytes.len() as u32
    }
    #[napi(getter, catch_unwind)]
    pub fn written_at(&self) -> f64 {
        self.written_at as f64
    }
    #[napi(getter, catch_unwind)]
    pub fn geometry(&self) -> Option<NativeReplayGeometry> {
        replay_geometry(&self.geometry, self.written_at - self.bytes.len() as u64)
    }
    #[napi(catch_unwind)]
    pub fn read_all(&self) -> Buffer {
        self.bytes.clone().into()
    }
    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.bytes = Vec::new();
        self.geometry.clear();
    }
}
fn replay_geometry(marks: &[GeometryMark], start: u64) -> Option<NativeReplayGeometry> {
    marks.first().map(|first| NativeReplayGeometry {
        start: NativeGeometrySize {
            cols: first.cols,
            rows: first.rows,
        },
        changes: marks
            .iter()
            .skip(1)
            .map(|m| NativeGeometryChange {
                offset: (m.at - start) as f64,
                cols: m.cols,
                rows: m.rows,
            })
            .collect(),
    })
}

/// Byte retention and geometry use the same lifetime offset as the JS oracle.
#[napi]
pub struct NativeRing {
    bytes: Vec<u8>,
    capacity: usize,
    length: usize,
    write_pos: usize,
    total_written: u64,
    geometry: Vec<GeometryMark>,
    /// The newest mark is provisional: the next mark replaces it.
    geometry_tail_provisional: bool,
}

#[napi]
impl NativeRing {
    #[napi(constructor, catch_unwind)]
    pub fn new(capacity: u32) -> Result<Self> {
        if capacity == 0 || capacity > 256 * 1024 * 1024 {
            return Err(Error::from_reason("Ring capacity must be 1..256MiB"));
        }
        Ok(Self {
            bytes: vec![0; (capacity as usize).min(64 * 1024)],
            capacity: capacity as usize,
            length: 0,
            write_pos: 0,
            total_written: 0,
            geometry: Vec::new(),
            geometry_tail_provisional: false,
        })
    }

    #[napi(catch_unwind)]
    pub fn write(&mut self, bytes: Uint8Array) -> Result<()> {
        self.write_bytes(&bytes)
    }

    #[napi(catch_unwind)]
    pub fn write_chunk(&mut self, chunk: &NativeOutputChunk) -> Result<()> {
        self.write_bytes(&chunk.bytes)
    }

    #[napi(catch_unwind)]
    pub fn read_all(&self) -> Buffer {
        self.copy_bytes().into()
    }

    #[napi(catch_unwind)]
    pub fn freeze(&mut self) -> NativeFrozenRing {
        self.prune_geometry();
        NativeFrozenRing {
            bytes: self.copy_bytes(),
            geometry: self.geometry.clone(),
            written_at: self.total_written,
        }
    }

    #[napi(getter, catch_unwind)]
    pub fn size(&self) -> u32 {
        self.length as u32
    }
    #[napi(getter, catch_unwind)]
    pub fn allocated_bytes(&self) -> u32 {
        self.bytes.len() as u32
    }

    #[napi(getter, catch_unwind)]
    pub fn total_bytes_written(&self) -> f64 {
        self.total_written as f64
    }

    #[napi(catch_unwind)]
    pub fn clear(&mut self) -> Result<()> {
        if self.capacity == 0 {
            return Err(Error::from_reason("Ring disposed"));
        }
        self.bytes.fill(0);
        self.length = 0;
        self.write_pos = 0;
        Ok(())
    }

    /// The same rules as RingBuffer.noteGeometry (TS): an applied mark is
    /// kept even with no bytes at it; a provisional one (`applied` false) is
    /// replaced by the next mark unless it is the window's only size; an
    /// applied repeat of a provisional tail makes it applied; a run of marks
    /// with no bytes between them keeps the one with the fewest rows and the
    /// newest. `applied` defaults to true.
    #[napi(catch_unwind)]
    pub fn note_geometry(&mut self, cols: u32, rows: u32, applied: Option<bool>) -> Result<()> {
        if self.capacity == 0 {
            return Err(Error::from_reason("Ring disposed"));
        }
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let applied = applied.unwrap_or(true);
        if let Some(last) = self.geometry.last() {
            if last.cols == cols && last.rows == rows {
                if applied {
                    self.geometry_tail_provisional = false;
                }
                return Ok(());
            }
        }
        if self.geometry_tail_provisional {
            self.prune_geometry();
            if self.geometry.len() > 1 {
                self.geometry.pop();
                self.geometry_tail_provisional = false;
                if let Some(last) = self.geometry.last() {
                    if last.cols == cols && last.rows == rows {
                        return Ok(());
                    }
                }
            }
            self.geometry_tail_provisional = false;
        }
        self.geometry.push(GeometryMark {
            at: self.total_written,
            cols,
            rows,
        });
        self.geometry_tail_provisional = !applied;
        self.compact_geometry_run();
        self.prune_geometry();
        Ok(())
    }

    /// A viewer's replay is out: a provisional newest mark is kept.
    #[napi(catch_unwind)]
    pub fn settle_geometry(&mut self) {
        self.geometry_tail_provisional = false;
    }

    #[napi(getter, catch_unwind)]
    pub fn geometry_tail_provisional(&self) -> bool {
        self.geometry_tail_provisional && !self.geometry.is_empty()
    }

    #[napi(getter, catch_unwind)]
    pub fn has_geometry_changes(&mut self) -> bool {
        self.prune_geometry();
        self.geometry.len() > 1
    }

    #[napi(catch_unwind)]
    pub fn read_all_with_geometry(&mut self) -> NativeRingSnapshot {
        self.prune_geometry();
        let start = self.total_written - self.length as u64;
        let geometry = self.geometry.first().map(|first| NativeReplayGeometry {
            start: NativeGeometrySize {
                cols: first.cols,
                rows: first.rows,
            },
            changes: self
                .geometry
                .iter()
                .skip(1)
                .map(|m| NativeGeometryChange {
                    offset: (m.at - start) as f64,
                    cols: m.cols,
                    rows: m.rows,
                })
                .collect(),
        });
        NativeRingSnapshot {
            data: self.read_all(),
            written_at: self.total_written as f64,
            geometry,
        }
    }

    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.bytes = Vec::new();
        self.capacity = 0;
        self.length = 0;
        self.write_pos = 0;
        self.geometry.clear();
        self.geometry_tail_provisional = false;
    }
}

impl NativeRing {
    fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        if self.capacity == 0 {
            return Err(Error::from_reason("Ring disposed"));
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let next_total = self
            .total_written
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| Error::from_reason("Ring byte offset exceeds JS safe integer range"))?;
        let input = if bytes.len() > self.capacity {
            &bytes[bytes.len() - self.capacity..]
        } else {
            bytes
        };
        let needed = (self.length + input.len()).min(self.capacity);
        if needed > self.bytes.len() {
            // Growth only happens before the ring has wrapped; resize preserves order.
            let mut next = self.bytes.len();
            while next < needed {
                next = (next * 2).min(self.capacity);
            }
            self.bytes
                .try_reserve_exact(next - self.bytes.len())
                .map_err(|e| Error::from_reason(e.to_string()))?;
            self.bytes.resize(next, 0);
            self.write_pos = self.length;
        }
        let tail = input.len().min(self.bytes.len() - self.write_pos);
        self.bytes[self.write_pos..self.write_pos + tail].copy_from_slice(&input[..tail]);
        self.bytes[..input.len() - tail].copy_from_slice(&input[tail..]);
        self.write_pos = (self.write_pos + input.len()) % self.bytes.len();
        self.length = needed;
        self.total_written = next_total;
        Ok(())
    }

    fn copy_bytes(&self) -> Vec<u8> {
        if self.length == 0 {
            return Vec::new();
        }
        let start = if self.length < self.bytes.len() {
            0
        } else {
            self.write_pos
        };
        let tail = self.length.min(self.bytes.len() - start);
        let mut result = Vec::with_capacity(self.length);
        result.extend_from_slice(&self.bytes[start..start + tail]);
        result.extend_from_slice(&self.bytes[..self.length - tail]);
        result
    }

    /// A run of marks at the newest mark's offset keeps the one with the
    /// fewest rows and the newest (RingBuffer.compactGeometryRun).
    fn compact_geometry_run(&mut self) {
        let Some(at) = self.geometry.last().map(|m| m.at) else {
            return;
        };
        let end = self.geometry.len() - 1;
        let mut start = end;
        while start > 0 && self.geometry[start - 1].at == at {
            start -= 1;
        }
        if end - start < 2 {
            return;
        }
        let mut keep = start;
        for i in start + 1..end {
            let (m, k) = (&self.geometry[i], &self.geometry[keep]);
            if m.rows < k.rows || (m.rows == k.rows && m.cols < k.cols) {
                keep = i;
            }
        }
        let kept = self.geometry[keep].clone();
        self.geometry.splice(start..end, [kept]);
    }

    fn prune_geometry(&mut self) {
        let start = self.total_written - self.length as u64;
        let keep = self
            .geometry
            .iter()
            .rposition(|m| m.at <= start)
            .unwrap_or(0);
        if keep > 0 {
            self.geometry.drain(..keep);
        }
        // Past the cap, the oldest marks after the first go: the first is the
        // size the window's first bytes were written at.
        if self.geometry.len() > 256 {
            let excess = self.geometry.len() - 256;
            self.geometry.drain(1..1 + excess);
        }
    }
}

/// Test hook for the per-reason parity modules (parity_support.rs): `chunks`
/// fed the way a snapshot feeds the ring, then whether the feed met a
/// divergent control.
#[cfg(test)]
pub(crate) fn fed_for_test(
    cols: usize,
    rows: usize,
    history: usize,
    chunks: &[&[u8]],
) -> (Term<VoidListener>, bool) {
    let config = Config {
        scrolling_history: history,
        ..Config::default()
    };
    let mut term = Term::new(config, &Size { cols, rows }, VoidListener);
    let mut parser: Processor = Processor::new();
    let mut feed = XtermFeed::default();
    for chunk in chunks {
        feed.feed(&mut parser, &mut term, chunk);
    }
    parser.advance(&mut term, &feed.held);
    (term, feed.divergent)
}

#[cfg(test)]
mod tests {
    use super::{Size, XtermFeed};
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::{Dimensions, Grid, GridCell};
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Processor, Timeout};

    fn feed_with(chunks: &[&str]) -> (Term<VoidListener>, Processor, XtermFeed) {
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        for chunk in chunks {
            feed.feed(&mut parser, &mut term, chunk.as_bytes());
        }
        (term, parser, feed)
    }

    fn feed(chunks: &[&str]) -> Term<VoidListener> {
        let (mut term, mut parser, feed) = feed_with(chunks);
        parser.advance(&mut term, &feed.held);
        term
    }

    fn row(term: &Term<VoidListener>, line: i32) -> String {
        let grid = term.grid();
        (0..grid.columns())
            .map(|x| grid[Line(line)][Column(x)].c)
            .collect::<String>()
            .trim_end()
            .to_owned()
    }

    #[test]
    fn erase_display_keeps_the_screen_out_of_history() {
        // Split inside the sequence, as a slice or live chunk boundary can.
        let term = feed(&["1\r\n2\r\n3\x1b[", "2Jx"]);
        assert_eq!(term.grid().history_size(), 0);
        assert_eq!(
            (row(&term, 0), row(&term, 1), row(&term, 2)),
            ("".into(), "".into(), " x".into())
        );
    }

    #[test]
    fn erase_above_clears_the_top_row_from_the_second() {
        let term = feed(&["aaa\r\nbbb\x1b[1;2H\x1b[1J"]);
        assert_eq!((row(&term, 0), row(&term, 1)), ("  a".into(), "bbb".into()));
        let term = feed(&["aaa\r\nbbb\x1b[2;2H\x1b[1J"]);
        assert_eq!((row(&term, 0), row(&term, 1)), ("".into(), "  b".into()));
    }

    #[test]
    fn erase_inside_a_synchronized_update_keeps_the_update_open() {
        let (mut term, mut parser, _) = feed_with(&["a\x1b[?2026hb\x1b[2Jc"]);
        assert!(parser.sync_timeout().pending_timeout());
        parser.stop_sync(&mut term);
        assert_eq!(row(&term, 0), "  c");
        assert_eq!(term.grid().history_size(), 0);
    }

    #[test]
    fn erase_ends_a_string_like_the_real_escape() {
        let term = feed(&["a\x1b]0;title\x1b[2Jc"]);
        assert_eq!(row(&term, 0), " c");
    }

    #[test]
    fn a_split_divergent_control_is_seen() {
        let (_, _, feed) = feed_with(&["hello\x1b(", "A#"]);
        assert!(feed.divergent);
        let (_, _, feed) = feed_with(&["\x1b]0;\x1b(A in a title\x07"]);
        assert!(feed.divergent, "ESC ends the string, then designates");
        let (_, _, feed) = feed_with(&["\x1b]0;(A in a title\x07ok"]);
        assert!(!feed.divergent);
    }

    #[test]
    fn the_first_refusal_names_its_control() {
        let family = |chunks: &[&str]| {
            let refused = feed_with(chunks).2.refused.expect("refused");
            refused.split(':').next().unwrap().to_owned()
        };
        assert_eq!(family(&["\x1b(A#\x1b[?47h"]), "unsupported-state-charset");
        assert_eq!(family(&["\x1b[?47h\x1b(A"]), "unsupported-state-mode");
        assert_eq!(family(&["\x1b[1!p"]), "unsupported-state-decstr");
        assert_eq!(family(&["\x1b[53m"]), "unsupported-state-sgr");
        assert_eq!(family(&["a\x1b[31m\x1b[2b"]), "unsupported-state-rep");
        assert_eq!(family(&["\x1b#8"]), "unsupported-state-decaln");
        assert_eq!(family(&["\x1b\x07n"]), "unsupported-state-c0-inside");
        assert_eq!(family(&["\x1b(\x07A"]), "unsupported-state-charset");
        assert_eq!(family(&["\x1b[!\x7fp"]), "unsupported-state-cut");
        assert_eq!(family(&["\x1b7\x1b*0\x1b8"]), "unsupported-state-decrc");
        assert_eq!(family(&["a\u{9b}31m"]), "unsupported-state-c1");
        // The first refused control is named, a C1 included, in one chunk.
        assert_eq!(family(&["\x1b(Ax\u{9b}31m"]), "unsupported-state-charset");
        assert_eq!(family(&["\u{9b}31m\x1b(A"]), "unsupported-state-c1");
        assert_eq!(
            family(&["\x1b[1;2r\x1b[?1049h"]),
            "unsupported-state-alt-margins"
        );
        assert!(feed_with(&["\x1b*0\x1bn\x1b[!pok"]).2.refused.is_none());
    }

    #[test]
    fn alternate_screen_and_mouse_resets_are_judged_on_the_state_they_meet() {
        let refused = |chunks: &[&str]| feed_with(chunks).2.refused;
        // Off the alternate screen, the resets xterm ignores too.
        assert_eq!(refused(&["a\x1b[?47l\x1b[?1047l\x1b[?047lb"]), None);
        assert_eq!(refused(&["\x1b[?1049ha\x1b[?1049l\x1b[?1047lb"]), None);
        // On xterm's alternate screen they leave it; Alacritty stays.
        let mode = Some("unsupported-state-mode: a mode Alacritty sets differently");
        assert_eq!(refused(&["\x1b[?1049ha\x1b[?47lb"]), mode);
        assert_eq!(refused(&["\x1b[?1049ha\x1b[?1047lb"]), mode);
        // One mode per control only: a list keeps the old refusal.
        assert_eq!(refused(&["a\x1b[?47;1047l"]), mode);
        // ?9l with any protocol on; the payload writes the tracked one.
        let (_, _, feed) = feed_with(&["\x1b[?1002h\x1b[?1006h\x1b[?9lx"]);
        assert_eq!((feed.refused, feed.mouse), (None, 0));
        assert_eq!(refused(&["\x1b[?9hx"]), mode);
        assert_eq!(refused(&["\x1b[?9;1000lx"]), mode);
        // A C0 inside is not the plain control the rule reads.
        assert!(refused(&["\x1b[?4\r7lx"]).is_some());
    }

    #[test]
    fn a_restore_refuses_only_a_later_slot_that_holds_another_set() {
        let refused = |chunks: &[&str]| feed_with(chunks).2.refused.is_some();
        // Designated again to the set it held at the save (sgr0's `ESC ( B`
        // on an alternate screen): both restore alike.
        assert!(!refused(&["\x1b7\x1b(B\x1b8"]));
        assert!(!refused(&["\x1b[?1049h\x1b(Bx\x1b[?1049l"]));
        assert!(!refused(&["\x1b7\x1b*0\x1b*B\x1b8"]));
        // Another set: xterm keeps it, Alacritty puts back the saved one.
        assert!(refused(&["\x1b7\x1b*0\x1b8"]));
        assert!(refused(&["\x1b[?1049h\x1b(0x\x1b[?1049l"]));
        // A slot the save held is restored by both.
        assert!(!refused(&["\x1b(B\x1b7\x1b(0\x1b8"]));
        // So are they after a soft reset, which keeps the save.
        assert!(!refused(&["\x1b*0\x1b7\x1b[!p\x1b*0\x1b8"]));
    }

    #[test]
    fn a_1049_reset_on_the_main_screen_restores_as_xterm_does() {
        let first_cell = |chunks: &[&str]| {
            let (mut term, mut parser, feed) = feed_with(chunks);
            parser.advance(&mut term, &feed.held);
            (feed.refused, term.grid()[Line(0)][Column(0)].c)
        };
        // xterm puts back the saved G0 (ASCII) and the saved GL (G0); without
        // the restore Alacritty would print line drawing.
        assert_eq!(
            first_cell(&["\x1b(B\x1b7\x1b(0\x1b[?1049l\x1b[Hq"]),
            (None, 'q')
        );
        assert_eq!(first_cell(&["\x1b)0\x0e\x1b[?1049l\x1b[Hq"]), (None, 'q'));
        // The cursor comes back too: nothing saved puts it top left.
        assert_eq!(first_cell(&["\x1b[2;5H\x1b[?1049lq"]), (None, 'q'));
        // A slot designated since the save to another set stays on xterm.
        assert!(first_cell(&["\x1b7\x1b(0\x1b[?1049l"]).0.is_some());
        // In a list, or with a sub-parameter: refused.
        assert!(first_cell(&["a\x1b[?1049;25l"]).0.is_some());
        assert!(first_cell(&["a\x1b[?1049:0l"]).0.is_some());
        assert!(first_cell(&["\x1b[?1049:0hx"]).0.is_some());
        // A C0 inside runs and is not part of it: still the restore.
        assert_eq!(
            first_cell(&["\x1b(B\x1b7\x1b(0\x1b[?10\r49l\x1b[Hq"]),
            (None, 'q')
        );
        // xterm keeps the open hyperlink (urlId) and puts back the colours.
        let link = |chunks: &[&str]| {
            feed_with(chunks)
                .0
                .grid()
                .cursor
                .template
                .hyperlink()
                .is_some()
        };
        assert!(link(&["\x1b]8;;http://e.com\x1b\\a\x1b[?1049l"]));
        assert!(!link(&[
            "\x1b]8;;http://e.com\x1b\\\x1b7\x1b]8;;\x1b\\a\x1b[?1049l"
        ]));
        // xterm clamps a cursor saved with a pending wrap into the last column.
        let (term, _, _) = feed_with(&["0123456789\x1b7\x1b[H\x1b[?1049l"]);
        assert!(!term.grid().cursor.input_needs_wrap);
        // Leaving the alternate screen stays as it was.
        assert_eq!(first_cell(&["q\x1b[?1049hx\x1b[?1049l"]), (None, 'q'));
    }

    /// The refusal family, if any, and the cursor row after `chunks`.
    fn restored(chunks: &[&str]) -> (Option<&'static str>, i32) {
        let (mut term, mut parser, feed) = feed_with(chunks);
        parser.advance(&mut term, &feed.held);
        (
            feed.refused.map(|r| r.split(':').next().unwrap_or(r)),
            term.grid().cursor.point.line.0,
        )
    }

    /// The save's history after a row-only resize of `text` at 10x6 to
    /// `target` rows, from `history` at the save.
    fn row_step(text: &str, scrollback: usize, history: i64, target: usize, alt: bool) -> i64 {
        let config = Config {
            scrolling_history: scrollback,
            ..Config::default()
        };
        let mut term = Term::new(config, &Size { cols: 10, rows: 6 }, VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, text.as_bytes());
        let cap = if alt { 0 } else { scrollback };
        let step = super::RowStep::before(term.grid(), history, target, cap);
        term.resize(Size {
            cols: 10,
            rows: target,
        });
        step.after(term.grid())
    }

    #[test]
    fn a_row_step_keeps_xterm_s_saved_row() {
        // Saved on row 3 (index 2), cursor on the bottom row, 6 rows to 4: two
        // rows go to history on both; Alacritty's saved row stays on index 2,
        // xterm's absolute row too.
        assert_eq!(row_step("a\x1b[3;1H\x1b7\x1b[6;1H", 100, 0, 4, false), 0);
        // Saved on the bottom row with the cursor above: Alacritty clamps the
        // saved row to index 3; xterm keeps index 5.
        assert_eq!(row_step("a\x1b[6;1H\x1b7\x1b[2;1H", 100, 0, 4, false), 2);
        // Full history (cap 2): xterm trims the two rows pushed and moves its
        // saved row up, but not above 0 (Math.max(savedY - amountToTrim, 0)).
        let full = "\x1b7".to_owned() + &"x\r\n".repeat(7);
        assert_eq!(row_step(&full, 2, 0, 4, false), 0);
        assert_eq!(
            row_step(
                &("x\r\n".repeat(7) + "\x1b[1;1H\x1b7\x1b[6;1H"),
                2,
                2,
                4,
                false
            ),
            0
        );
        // Taller with the cursor on the bottom row: both pull history down;
        // Alacritty moves its saved row with it, xterm keeps its row.
        assert_eq!(
            row_step(
                &("x\r\n".repeat(7) + "\x1b[2;1H\x1b7\x1b[6;1H"),
                100,
                2,
                8,
                false
            ),
            0
        );
        // The alternate screen keeps no history: xterm trims the rows the
        // cursor pushes and moves its saved row up by them, Alacritty clamps.
        let alt = "\x1b[?1049h\x1b[3;1H\x1b7\x1b[6;1H";
        assert_eq!(row_step(alt, 100, 0, 4, true), -2);
    }

    #[test]
    fn a_1049_reset_on_the_main_screen_restores_xterm_s_row_after_a_scroll() {
        // Saved on row 2 of 3 (index 1). No scroll since: that row.
        assert_eq!(
            restored(&["a\x1b[2;1H\x1b7\x1b[3;1H\x1b[?1049l"]),
            (None, 1)
        );
        // One row scrolled into history: xterm's row moves up by one.
        assert_eq!(
            restored(&["a\x1b[2;1H\x1b7\x1b[3;1H\n\x1b[?1049l"]),
            (None, 0)
        );
        // Two rows: it would be above the screen, and xterm clamps it to 0.
        assert_eq!(
            restored(&["a\x1b[2;1H\x1b7\x1b[3;1H\n\n\x1b[?1049l"]),
            (None, 0)
        );
        // Read at the save, past bytes a synchronized update holds back.
        assert_eq!(
            restored(&["\x1b[?2026ha\r\nb\r\nc\x1b7\n\x1b[?1049l\x1b[?2026l"]),
            (None, 1)
        );
        // A ?1049h on the main screen saves the row the same way.
        assert_eq!(
            restored(&["a\r\nb\r\nc\x1b[?1049h\x1b[?1049l\n\x1b[?1049l"]),
            (None, 1)
        );
        // ED 3 since the save: xterm's row moves down by the rows cleared,
        // and stays on the screen (`_restrictCursor`).
        let filled = "1\r\n2\r\n3\r\n4\r\n5";
        assert_eq!(
            restored(&[filled, "\x1b[1;1H\x1b7\x1b[3J\x1b[?1049l"]),
            (None, 2)
        );
        assert_eq!(
            restored(&[filled, "\x1b[2;1H\x1b7\x1b[3J\x1b[?1049l"]),
            (None, 2)
        );
        // A line feed inside the save runs before it and scrolls first.
        assert_eq!(restored(&["1\r\n2\r\n3\x1b\n7\x1b[?1049l"]), (None, 2));
        // A soft reset saves the top left of the screen as it is then.
        assert_eq!(
            restored(&[filled, "\x1b[2;1H\x1b7\x1b[3J\x1b[!p\x1b[?1049l"]),
            (None, 0)
        );
    }

    #[test]
    fn a_decrc_on_the_main_screen_restores_xterm_s_row_after_a_scroll() {
        assert_eq!(restored(&["a\x1b[2;1H\x1b7\x1b[3;1H\x1b8"]), (None, 1));
        assert_eq!(restored(&["a\x1b[2;1H\x1b7\x1b[3;1H\n\x1b8"]), (None, 0));
        // SCOSC and SCORC alike.
        assert_eq!(restored(&["a\x1b[2;1H\x1b[s\x1b[3;1H\x1b[u"]), (None, 1));
        assert_eq!(restored(&["a\x1b[2;1H\x1b[s\x1b[3;1H\n\x1b[u"]), (None, 0));
        // The alternate screen keeps no history: its row stays.
        assert_eq!(
            restored(&["\x1b[?1049h\x1b[2;1H\x1b7\x1b[3;1H\n\x1b8"]),
            (None, 1)
        );
        // ED 3 past the rows below the save: the last row.
        let filled = "1\r\n2\r\n3\r\n4\r\n5";
        assert_eq!(restored(&[filled, "\x1b[1;1H\x1b7\x1b[3J\x1b8"]), (None, 2));
        assert_eq!(restored(&[filled, "\x1b[2;1H\x1b7\x1b[3J\x1b8"]), (None, 2));
        // With DECOM on, xterm keeps the row inside the scrolling region:
        // above its top after a scroll...
        assert_eq!(
            restored(&["\x1b[2;3r\x1b[?6h\x1b7\x1b[r\x1b[3;1H\n\n\x1b[2;3r\x1b8"]),
            (None, 1)
        );
        // ...and below its bottom after ED 3.
        assert_eq!(
            restored(&[filled, "\x1b[1;2r\x1b[?6h\x1b7\x1b[3J\x1b8"]),
            (None, 1)
        );
        // A restore on a screen this tracker and Alacritty disagree on is
        // not placed: Alacritty has no ?47.
        let (_, _, feed) = feed_with(&["a\x1b[?47h\x1b8"]);
        assert!(feed.seen.contains(&"unsupported-state-restore-row"));
    }

    #[test]
    fn the_alternate_screen_rules_read_alacritty_s_own_screen() {
        let refused = |chunks: &[&str]| feed_with(chunks).2.refused.is_some();
        // 33 parameters: neither parser takes the last one, the tracker does.
        let long = format!("\x1b[?{}1049l", "1;".repeat(32));
        assert!(refused(&["\x1b[?1049ha", &long, "\x1b[?47lb"]));
        // Alacritty on its main screen: the resets xterm ignores there too.
        assert!(!refused(&["a\x1b[?47l\x1b[?1047lb"]));
    }

    #[test]
    fn a_47_round_trip_holds_only_kitty_keyboard_controls() {
        let (_, _, feed) = feed_with(&["a\x1b[?47h\x1b[<99u\x1b[>1u\x1b[=1;1u\x1b[?47lb"]);
        assert_eq!(
            (feed.refused, feed.round_trip, feed.alt_screen),
            (None, false, false)
        );
        // Split across feeds, held mid-sequence.
        let (_, _, feed) = feed_with(&["a\x1b[?47h\x1b[<9", "9u\x1b[?4", "7lb"]);
        assert_eq!(feed.refused, None);
        let round_trip = |chunks: &[&str]| feed_with(chunks).2.refused;
        let inside = Some(crate::native_core::ROUND_TRIP);
        assert_eq!(round_trip(&["\x1b[?47hx\x1b[?47l"]), inside);
        assert_eq!(round_trip(&["\x1b[?47h", "\r\n", "\x1b[?47l"]), inside);
        assert_eq!(round_trip(&["\x1b[?47h\x1b[2J\x1b[?47l"]), inside);
        assert_eq!(round_trip(&["\x1b[?47h\x1b]0;t\x07\x1b[?47l"]), inside);
        assert_eq!(round_trip(&["\x1b[?47h\x1b[?u\x1b[?47l"]), inside);
        assert_eq!(round_trip(&["\x1b[?47h\x1b[?1047l"]), inside);
        assert_eq!(round_trip(&["\x1b[?47h\x1b[?47h"]), inside);
        // Entered on the alternate screen: refused as before.
        assert_eq!(
            round_trip(&["\x1b[?1049h\x1b[?47h"]),
            Some("unsupported-state-mode: a mode Alacritty sets differently")
        );
        // Still open at the end: the snapshot refuses it (ansi_snapshot).
        let (_, _, feed) = feed_with(&["a\x1b[?47h\x1b[<99u"]);
        assert_eq!((feed.refused, feed.round_trip), (None, true));
        // A RIS ends it with the alternate screen.
        let (_, _, feed) = feed_with(&["\x1b[?47h\x1bc"]);
        assert!(!feed.round_trip);
    }

    #[test]
    fn the_scan_past_a_refusal_names_what_controls_show_by_themselves() {
        let mut feed = feed_with(&["\x1b(A"]).2;
        // Split across scans, inside a string, cut by DEL, and a C1.
        feed.scan(b"\x1b]0;\x1b[53m title\x07\x1b[5");
        feed.scan(b"3m\x1b[!\x7fp\xc2\x9b31m");
        // A restore needs the screen's state: not seen by the scan. Neither
        // does a ContextRule control, nor text inside a round trip.
        feed.scan(b"\x1b7\x1b*0\x1b8");
        feed.scan(b"\x1b[?47hx\x1b[?47l\x1b[?1047l\x1b[?9l");
        assert_eq!(
            feed.seen,
            [
                "unsupported-state-charset",
                "unsupported-state-sgr",
                "unsupported-state-cut",
                "unsupported-state-c1"
            ]
        );
        assert_eq!(
            feed.refused.map(crate::native_core::refusal_family),
            Some("unsupported-state-charset")
        );
    }

    #[test]
    fn every_refused_family_is_seen_once_in_order() {
        let seen = |chunks: &[&str]| feed_with(chunks).2.seen;
        assert_eq!(
            seen(&["\x1b[?47h\x1b(Ax\x1b[?47l\x1b[53m", "\x1b(K"]),
            [
                "unsupported-state-mode",
                "unsupported-state-charset",
                "unsupported-state-sgr"
            ]
        );
        // A C1 is seen at the first control after it, or at the chunk's end.
        assert_eq!(
            seen(&["\u{9b}31m\x1b(A"]),
            ["unsupported-state-c1", "unsupported-state-charset"]
        );
        assert_eq!(
            seen(&["\x1b(Ax\u{9b}31m"]),
            ["unsupported-state-charset", "unsupported-state-c1"]
        );
        assert!(seen(&["plain \x1b[1mtext"]).is_empty());
        // The first refusal is still the one reported.
        let feed = feed_with(&["\x1b[53m\x1b(A"]).2;
        assert_eq!(
            feed.refused.map(crate::native_core::refusal_family),
            Some("unsupported-state-sgr")
        );
        assert_eq!(
            feed.seen,
            ["unsupported-state-sgr", "unsupported-state-charset"]
        );
    }

    #[test]
    fn the_pending_tail_matches_the_stream_trackers() {
        let tail = |chunks: &[&str]| {
            feed_with(chunks)
                .2
                .pending_tail()
                .map(|t| String::from_utf8(t).unwrap())
        };
        assert_eq!(tail(&["hi\x1b[31;"]).unwrap(), "\x1b[31;");
        assert_eq!(tail(&["hi\x1b]0;ti", "tle"]).unwrap(), "\x1b]0;title");
        assert_eq!(tail(&["hi\x1b]0;title\x1b"]).unwrap(), "\x1b]0;title\x1b");
        assert_eq!(tail(&["hi\x1b]0;title\x1b", "\\done"]).unwrap(), "");
        assert_eq!(tail(&["hi\x1b]0;title\x07done"]).unwrap(), "");
        assert_eq!(
            tail(&["\x1bP", &"x".repeat(5000)]).unwrap_err(),
            "partial-tail-overflow"
        );
    }

    #[test]
    fn rep_needs_a_character_printed_right_before() {
        let divergent = |chunks: &[&str]| feed_with(chunks).2.divergent;
        assert!(!divergent(&["ab\x1b[3b"]));
        assert!(
            !divergent(&["ab", "\x1b[3b"]),
            "printed in the previous chunk"
        );
        assert!(divergent(&["X\r\x1b[3b"]));
        assert!(divergent(&["X\x1b[31m\x1b[3b"]));
        assert!(divergent(&["X\x1b[31m", "\x1b[3b"]));
        assert!(divergent(&["\x1b[3b"]));
        assert!(divergent(&["X\x1b]0;t\x07\x1b[3b"]));
    }

    #[test]
    fn insert_delete_and_erase_drop_a_pending_wrap() {
        for edit in ["\x1b[X", "\x1b[P", "\x1b[@"] {
            let (mut term, mut parser, feed) = feed_with(&["abcdefghij", edit, "Z"]);
            parser.advance(&mut term, &feed.held);
            assert_eq!(term.grid().cursor.point.line.0, 0, "{edit:?}");
            assert_eq!(row(&term, 1), "", "{edit:?}");
        }
        let (_, _, feed) = feed_with(&["a\x1b[X"]);
        assert!(!feed.shifted);
        let (_, _, feed) = feed_with(&["a\x1b[2P"]);
        assert!(feed.shifted);
    }

    #[test]
    fn the_mouse_protocol_follows_xterm() {
        let mouse = |chunks: &[&str]| {
            let feed = feed_with(chunks).2;
            (feed.mouse, feed.sgr_mouse)
        };
        assert_eq!(mouse(&["\x1b[?1002h\x1b[?1006h"]), (1002, true));
        assert_eq!(mouse(&["\x1b[?1002h\x1b[?1000l"]), (0, false));
        assert_eq!(mouse(&["\x1b[?1003;1000h"]), (1000, false));
        assert_eq!(mouse(&["\x1b[?1000h\x1b[?1006h\x1b[?1005h"]), (1000, true));
        assert_eq!(mouse(&["\x1b[?1000h\x1b[?1006h\x1bc"]), (0, false));
        assert_eq!(mouse(&["\x1b[?100\r0h"]), (1000, false), "embedded C0");
        assert_eq!(
            mouse(&["\x1b[?01000;01006h"]),
            (1000, true),
            "leading zeros"
        );
        assert_eq!(mouse(&["\x1b[?1000h\x1b[?01000l"]), (0, false));
    }

    #[test]
    fn margins_and_cursor_follow_the_stream_trackers() {
        let state = |chunks: &[&str]| {
            let (_, _, feed) = feed_with(chunks);
            (feed.margins(), feed.cursor_hidden)
        };
        assert_eq!(state(&["\x1b[2;4r"]), (true, false));
        assert_eq!(state(&["\x1b[2;4r\x1b[r"]), (false, false));
        assert_eq!(state(&["\x1b[2;4r\x1bc"]), (false, false));
        // xterm's setScrollRegion over 3 rows: 0 reads as the default, a
        // bottom past the screen is the screen, an empty region is ignored.
        for reset in [
            "\x1b[0;0r",
            "\x1b[0r",
            "\x1b[1r",
            "\x1b[;3r",
            "\x1b[1;9r",
            "\x1b[1;3;2r",
        ] {
            assert_eq!(state(&["\x1b[2;4r", reset]), (false, false), "{reset:?}");
        }
        for region in ["\x1b[2r", "\x1b[1;2r", "\x1b[0;2r"] {
            assert_eq!(state(&[region]), (true, false), "{region:?}");
        }
        assert_eq!(state(&["\x1b[3;2r"]), (false, false));
        assert_eq!(state(&["\x1b[2;4r\x1b[3;2r"]), (true, false));
        assert_eq!(state(&["\x1b[?1;25l"]), (false, true));
        assert_eq!(state(&["\x1b[?25l\x1b[?25h"]), (false, false));
    }

    #[test]
    fn margins_follow_xterm_per_screen() {
        let margins = |chunks: &[&str]| feed_with(chunks).2.margins();
        // The main screen's region outlives an alternate screen that resets its own.
        assert!(margins(&["\x1b[2;3r\x1b[?1049h\x1b[r\x1b[?1049l"]));
        assert!(margins(&["\x1b[2;3r\x1b[?1049h\x1b[r"]));
        // The alternate screen's region goes with it.
        assert!(margins(&["\x1b[?1049h\x1b[2;3r"]));
        assert!(!margins(&["\x1b[?1049h\x1b[2;3r", "\x1b[?1049l"]));
        assert!(!margins(&["\x1b[2;3r\x1b[?1049h\x1b[1;2r\x1bc\x1b[?1049l"]));
    }

    #[test]
    fn alacritty_keeps_the_alternate_region_on_the_main_screen() {
        // xterm leaves the main screen's full region in place; Alacritty has
        // one region, so main-screen output keeps scrolling inside rows 1-2.
        let chunks = ["\x1b[?1049h\x1b[1;2r\x1b[?1049l\x1b[Ha\r\nb\r\nc\r\nd"];
        let (term, _, feed) = feed_with(&chunks);
        assert_eq!(
            (row(&term, 0), row(&term, 1), row(&term, 2)),
            ("c".into(), "d".into(), String::new())
        );
        assert!(feed.divergent);
    }

    #[test]
    fn alacritty_carries_the_main_region_into_the_alternate_screen() {
        // xterm's alternate screen scrolls in full and ends with a, b, c;
        // Alacritty keeps rows 1-2 as the region, so LF on row 3 stays there.
        let chunks = ["\x1b[1;2r\x1b[?1049h\x1b[3;1Ha\r\nb\r\nc"];
        let (term, _, feed) = feed_with(&chunks);
        assert_eq!(
            (row(&term, 0), row(&term, 1), row(&term, 2)),
            (String::new(), String::new(), "c".into())
        );
        assert!(feed.divergent);
        // A region the alternate screen sets for itself is no divergence.
        assert!(!feed_with(&["\x1b[?1049h\x1b[1;2r"]).2.divergent);
        // Nor is the full region it starts with when the main screen has one.
        assert!(!feed_with(&["\x1b[1;3r\x1b[?1049h"]).2.divergent);
    }

    #[test]
    fn a_region_only_alacritty_applies_is_divergent() {
        let divergent = |chunks: &[&str]| feed_with(chunks).2.divergent;
        // Top at or past the last of 3 rows: xterm ignores it, Alacritty
        // keeps the bottom it was given and homes the cursor.
        assert!(divergent(&["ab\x1b[3;9r"]));
        assert!(divergent(&["ab\x1b[4;9r"]));
        assert!(!divergent(&["ab\x1b[3;3r"]), "both ignore it");
        assert!(!divergent(&["ab\x1b[2;9r"]), "both apply it");
    }

    #[test]
    fn leaving_the_alternate_screen_lifts_its_width_change() {
        // As NativeTerminal::resize leaves it after a width change there.
        let lifted = |chunks: &[&str]| {
            let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
            let mut parser: Processor = Processor::new();
            let mut feed = XtermFeed::default();
            feed.feed(&mut parser, &mut term, b"\x1b[?1049h");
            feed.alt_reflow = true;
            for chunk in chunks {
                feed.feed(&mut parser, &mut term, chunk.as_bytes());
            }
            !feed.alt_reflow
        };
        assert!(lifted(&["x\x1b[?1049l"]));
        assert!(lifted(&["\x1b[?10", "49l"]), "split across chunks");
        // Left and entered again in one chunk: the new screen is a fresh one.
        assert!(lifted(&["\x1b[?1049l$ less\r\n\x1b[?1049hpage"]));
        assert!(!lifted(&["more output"]));
        assert!(!lifted(&["\x1b[?1049h"]), "entering again while on it");
        assert!(lifted(&["\x1bc"]), "a reset leaves it too");
        assert!(
            lifted(&["\x1b[?2026h\x1b[?1049l"]),
            "inside a synchronized update"
        );
        // Past 32 parameters Alacritty (and xterm) drop the rest: no leave,
        // though this tracker reads every one.
        let overflow = format!("\x1b[?{}1049l", "1;".repeat(32));
        assert!(!lifted(&[overflow.as_str()]));
        assert!(
            lifted(&[overflow.as_str(), "\x1b[?1049l"]),
            "a real leave after it"
        );
    }

    #[test]
    fn erases_and_cell_edits_keep_or_end_a_paragraph_as_xterm_s() {
        use alacritty_terminal::term::cell::Flags;
        // On 10 columns: `para` wraps row 0 into row 1; `para3` wraps rows 0
        // and 1; `history` also wraps the history row into screen row 0.
        let para = "xxxxxxxxxxxxxxx\x1b[1;1H";
        let para3 = "xxxxxxxxxxxxxxxxxxxxxxxxx\x1b[1;1H";
        let history = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        let wraps = |term: &Term<VoidListener>, line: i32| {
            term.grid()[Line(line)][Column(9)]
                .flags
                .contains(Flags::WRAPLINE)
        };
        // xterm keeps the wrap as the next row's isWrapped: no EL, ECH, ICH,
        // DCH or print touches it, also from a pending wrap.
        for edit in [
            "\x1b[1;5H\x1b[K",
            "\x1b[1;5H\x1b[44m\x1b[K",
            "\x1b[1;10H\x1b[1K",
            "\x1b[1;10HX\x1b[1K",
            "\x1b[2K",
            "\x1b[1;10HX\x1b[K",
            "\x1b[1;8H\x1b[5X",
            "\x1b[10X",
            "\x1b[1;3H\x1b[2@",
            "\x1b[1;3H\x1b[2P",
            "\x1b[1;10HX\x1b[P",
            "\x1b[4h\x1b[1;3HAB\x1b[4l",
        ] {
            assert!(wraps(&feed(&[para, edit]), 0), "{edit:?}");
        }
        let term = feed(&[para, "\x1b[1;10HZ"]);
        assert!(wraps(&term, 0) && term.grid()[Line(0)][Column(9)].c == 'Z');
        // EL 2, or EL 0 from column 0, ends the row's own: the row above no
        // longer wraps into it. The row still wraps into the next.
        for edit in ["\x1b[2;1H\x1b[K", "\x1b[2;4H\x1b[2K"] {
            let term = feed(&[para3, edit]);
            assert!(!wraps(&term, 0) && wraps(&term, 1), "{edit:?}");
        }
        for edit in ["\x1b[2;4H\x1b[K", "\x1b[2;4H\x1b[1K"] {
            let term = feed(&[para3, edit]);
            assert!(wraps(&term, 0) && wraps(&term, 1), "{edit:?}");
        }
        // ED resets the rows after the cursor's; from column 0 the cursor's
        // row is no longer a continuation either.
        let term = feed(&[para3, "\x1b[2;4H\x1b[J"]);
        assert!(wraps(&term, 0) && !wraps(&term, 1));
        let term = feed(&[para3, "\x1b[2;1H\x1b[J"]);
        assert!(!wraps(&term, 0) && !wraps(&term, 1));
        // A pending wrap: its cursor is past the last column, so ED erases
        // nothing on its row, and the pending wrap stays.
        let term = feed(&[para, "\x1b[1;10HX\x1b[J"]);
        assert!(!wraps(&term, 0) && term.grid()[Line(0)][Column(9)].c == 'X');
        assert!(term.grid().cursor.input_needs_wrap);
        // ED 1 resets the rows above; the cursor's row keeps its wrap unless
        // the erase reached its last column.
        assert!(wraps(&feed(&[para3, "\x1b[2;4H\x1b[1J"]), 1));
        assert!(!wraps(&feed(&[para3, "\x1b[2;10H\x1b[1J"]), 1));
        // The history row stops wrapping into the top row it no longer
        // continues, and only then.
        for edit in [
            "\x1b[1;1H\x1b[2K",
            "\x1b[1;1H\x1b[K",
            "\x1b[1;1H\x1b[J",
            "\x1b[1;3H\x1b[1J",
            "\x1b[2J",
        ] {
            assert!(!wraps(&feed(&[history, edit]), -1), "{edit:?}");
        }
        assert!(wraps(&feed(&[history, "\x1b[1;3H\x1b[K"]), -1));
        // The text feed (no XtermFeed) takes Alacritty's own ED 1 the same way.
        let plain = |bytes: &str| {
            let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
            let mut parser: Processor = Processor::new();
            parser.advance(&mut term, bytes.as_bytes());
            term
        };
        let term = plain(&format!("{para3}\x1b[3;4H\x1b[1J"));
        assert!(!wraps(&term, 1));
        assert!(!wraps(&plain(&format!("{history}\x1b[1;3H\x1b[1J")), -1));
        // From the second row it resets the top row too, as xterm does.
        let term = plain(&format!("{para3}\x1b[2;4H\x1b[1J"));
        assert!(row(&term, 0).is_empty() && !wraps(&term, 0) && wraps(&term, 1));
    }

    #[test]
    fn a_line_feed_into_a_continuation_ends_its_paragraph_as_xterm_s() {
        use alacritty_terminal::term::cell::Flags;
        // 15 x on 10 columns: row 1 continues row 0.
        let wrapped = |chunks: &[&str]| {
            let term = feed(chunks);
            term.grid()[Line(0)][Column(9)]
                .flags
                .contains(Flags::WRAPLINE)
        };
        let para = "xxxxxxxxxxxxxxx\x1b[1;1H";
        assert!(wrapped(&[para]));
        // xterm's lineFeed: LF, VT and FF clear the entered row's wrap.
        for lf in ["\n", "\x0b", "\x0c"] {
            assert!(!wrapped(&[para, lf]), "{lf:?}");
        }
        assert!(
            !wrapped(&[para, "\x1b[1;2r\x1b[1;1H\n"]),
            "inside a region, above its bottom"
        );
        // xterm's index: IND and NEL keep it, also in an update or a split.
        for index in ["\x1bD", "\x1bE", "\x1b[?2026h\x1bD"] {
            assert!(wrapped(&[para, index]), "{index:?}");
        }
        assert!(wrapped(&[para, "\x1b", "D"]), "split across chunks");
        // With a C0 inside, the feed leaves IND and NEL to the reference.
        assert!(crate::native_serialize::divergent(b"\x1b\x07D"));
        assert!(crate::native_serialize::divergent(b"\x1b\x00E"));
        // Both drop a pending wrap: the next glyph lands in the last column.
        for down in ["\n", "\x1bD"] {
            let term = feed(&["xxxxxxxxxx", down, "Y"]);
            assert_eq!(term.grid()[Line(1)][Column(9)].c, 'Y', "{down:?}");
        }
        // The text feed (no XtermFeed) keeps IND's paragraph too.
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut held = Vec::new();
        for chunk in [para.as_bytes(), b"\x1b", b"D"] {
            super::advance_indexing(&mut parser, &mut term, &mut held, chunk);
        }
        assert!(term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // DEL inside, split after it: both parsers ignore DEL there.
        for chunk in [para.as_bytes(), b"\x1b\x7f", b"D"] {
            super::advance_indexing(&mut parser, &mut term, &mut held, chunk);
        }
        assert!(held.is_empty());
        assert!(term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // An ESC followed by an endless run of C0 controls and DEL, a few
        // bytes per feed: the held bytes stay under the cap, so each feed
        // rescans at most that much, and the run reaches the parser.
        super::advance_indexing(&mut parser, &mut term, &mut held, b"\x1b");
        let mut most = 0;
        for i in 0..100_000 {
            let chunk: &[u8] = if i % 2 == 0 { b"\x00\x7f\x07" } else { b"\x7f" };
            super::advance_indexing(&mut parser, &mut term, &mut held, chunk);
            most = most.max(held.len());
        }
        assert!(most <= super::MAX_HELD, "{most}");
        assert!(held.len() <= super::MAX_HELD);
        // The ANSI feed leaves that spelling to the reference.
        assert!(feed_with(&[para, "\x1b\x7fD"]).2.divergent);
        assert!(
            !feed_with(&[para, "\x1b7\u{e9}"]).2.divergent,
            "a complete escape before UTF-8"
        );
        super::advance_indexing(&mut parser, &mut term, &mut held, b"\x1b[1;1H\n");
        assert!(!term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // An auto-wrap below a scroll region keeps its wrap.
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 5 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        feed.feed(&mut parser, &mut term, b"\x1b[1;2r\x1b[4;1Hxxxxxxxxxxxxxxx");
        assert!(term.grid()[Line(3)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // At the bottom a line feed scrolls; the paragraph moves up intact.
        let (term, _, _) = feed_with(&["\x1b[3;1Hxxxxxxxxxxxxxxx\x1b[3;1H\n"]);
        assert!(term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        let (term, _, _) = feed_with(&["\x1b[3;1Hxxxxxxxxxxxxxxx\x1b[3;1H\x1bD"]);
        assert!(term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
    }

    #[test]
    fn the_pixel_mouse_encoding_follows_the_stream_tracker() {
        let pixels = |chunks: &[&str]| feed_with(chunks).2.sgr_pixels;
        assert!(pixels(&["\x1b[?1003;1016h"]));
        assert!(!pixels(&["\x1b[?1016h\x1b[?1016l"]));
        assert!(!pixels(&["\x1b[?1016h\x1bc"]));
        assert!(pixels(&["\x1b[?10", "16h"]), "split across chunks");
    }
}

/// The alternate screen's cells past a narrower width, against xterm.js
/// (headless, the daemon's options): a 20x4 alternate screen narrowed to 10,
/// driven, then widened. Each expectation is what xterm showed.
#[cfg(test)]
mod alt_kept_cells_tests {
    use super::{Size, XtermFeed};
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::cell::Flags;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor};

    enum Step {
        Out(&'static str),
        Size(usize, usize),
    }
    use Step::{Out, Size as To};

    const N: Step = To(10, 4);
    const W: Step = To(20, 4);
    const R0: &str = "0000000000ABCDEFGHIJ";
    const R1: &str = "1111111111KLMNOPQRST";
    const R2: &str = "2222222222abcdefghij";
    const R3: &str = "3333333333klmnopqrst";
    const BLANK: &str = "....................";

    /// Rows as text ('.' for a blank, a wide char's spacer skipped), and the
    /// columns of each row with a red background (base 36).
    /// The terminal after `steps`, from the 20x4 alternate screen.
    fn run_term(steps: &[Step]) -> (Term<VoidListener>, ()) {
        let mut term = Term::new(Config::default(), &Size { cols: 20, rows: 4 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        let start = format!("\x1b[?1049h\x1b[H{R0}\r\n{R1}\r\n{R2}\r\n{R3}");
        feed.feed(&mut parser, &mut term, start.as_bytes());
        for step in steps {
            match step {
                Out(bytes) => feed.feed(&mut parser, &mut term, bytes.as_bytes()),
                To(cols, rows) => {
                    parser.advance(&mut term, &std::mem::take(&mut feed.held));
                    term.resize(Size {
                        cols: *cols,
                        rows: *rows,
                    });
                }
            }
        }
        parser.advance(&mut term, &feed.held);
        (term, ())
    }

    fn run(steps: &[Step]) -> (Vec<String>, Vec<String>) {
        let (term, _) = run_term(steps);
        let grid = term.grid();
        let mut text = Vec::new();
        let mut red = Vec::new();
        for y in 0..grid.screen_lines() {
            let row = &grid[Line(y as i32)];
            let mut line = String::new();
            let mut bg = String::new();
            for x in 0..grid.columns() {
                let cell = &row[Column(x)];
                if cell.bg == Color::Named(NamedColor::Red) {
                    bg.push(std::char::from_digit(x as u32, 36).unwrap());
                }
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                line.push(if cell.c == ' ' { '.' } else { cell.c });
            }
            text.push(line);
            red.push(bg);
        }
        (text, red)
    }

    fn rows(steps: &[Step]) -> Vec<String> {
        run(steps).0
    }

    /// Rows as cells: '_' for a wide glyph's spacer (xterm's width-0 cell).
    fn cells(steps: &[Step]) -> Vec<String> {
        let (term, _) = run_term(steps);
        let grid = term.grid();
        (0..grid.screen_lines())
            .map(|y| {
                let row = &grid[Line(y as i32)];
                (0..grid.columns())
                    .map(|x| {
                        let cell = &row[Column(x)];
                        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                            '_'
                        } else if cell.c == ' ' {
                            '.'
                        } else {
                            cell.c
                        }
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn a_large_dch_clears_from_the_cursor_only_with_or_without_kept_cells() {
        assert_eq!(
            rows(&[Out("\x1b[1;6H\x1b[999P")])[0],
            "00000..............."
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;6H\x1b[999P"), W])[0],
            "00000..............."
        );
    }

    #[test]
    fn insert_mode_wraps_a_wide_glyph_before_it_shifts_anything() {
        let shown = cells(&[N, Out("\x1b[4h\x1b[2;10H\u{4e2d}\x1b[4l"), W]);
        assert_eq!(shown[1], "111111111.KLMNOPQRST");
        assert_eq!(shown[2], "\u{4e2d}_2222222222abcdefgh");
        // With autowrap off the glyph is dropped, and nothing shifts.
        assert_eq!(
            cells(&[
                N,
                Out("\x1b[?7l\x1b[4h\x1b[2;10H\u{4e2d}\x1b[4l\x1b[?7h"),
                W
            ]),
            all([R0, R1, R2, R3])
        );
    }

    #[test]
    fn insert_mode_blanks_a_wide_glyph_shifted_into_the_last_visible_column() {
        assert_eq!(
            cells(&[N, Out("\x1b[1;8H\u{4e2d}\x1b[4h\x1b[1;1Hxy\x1b[4l"), W])[0],
            "xy0000000._0ABCDEFGH"
        );
        assert_eq!(
            cells(&[Out("\x1b[1;18H\u{4e2d}\x1b[4h\x1b[1;1Hxy\x1b[4l")])[0],
            "xy0000000000ABCDEFG."
        );
    }

    #[test]
    fn insert_and_delete_at_a_wide_glyph_cut_it_as_xterm_does() {
        for narrowed in [true, false] {
            let around = |edit: &'static str| {
                let mut steps = vec![];
                if narrowed {
                    steps.push(To(10, 4));
                }
                steps.push(Out("\x1b[1;3H\u{4e2d}\x1b[1;4H"));
                steps.push(Out(edit));
                if narrowed {
                    steps.push(To(20, 4));
                }
                cells(&steps)[0].clone()
            };
            assert_eq!(
                around("\x1b[1@"),
                "00.._000000ABCDEFGHI",
                "ICH at the spacer, narrowed={narrowed}"
            );
            assert_eq!(
                around("\x1b[1P"),
                "00.000000ABCDEFGHIJ.",
                "DCH at the spacer, narrowed={narrowed}"
            );
        }
        assert_eq!(
            cells(&[Out("\x1b[1;19H\u{4e2d}"), N, Out("\x1b[1;1H\x1b[1@"), W])[0],
            ".0000000000ABCDEFGH.",
            "pushed off the physical end"
        );
    }

    #[test]
    fn erase_at_a_wide_glyph_cuts_it_as_xterm_does() {
        for narrowed in [true, false] {
            let around = |glyph: &'static str, edit: &'static str| {
                let mut steps = vec![Out(glyph)];
                if narrowed {
                    steps.insert(0, To(10, 4));
                }
                steps.push(Out(edit));
                if narrowed {
                    steps.push(To(20, 4));
                }
                (cells(&steps)[0].clone(), run(&steps).1[0].clone())
            };
            let glyph = "\x1b[1;3H\u{4e2d}";
            assert_eq!(
                around(glyph, "\x1b[1;4H\x1b[1X").0,
                "00..000000ABCDEFGHIJ",
                "ECH at the spacer, narrowed={narrowed}"
            );
            assert_eq!(
                around(glyph, "\x1b[1;2H\x1b[2X").0,
                "0...000000ABCDEFGHIJ",
                "ECH ending on the lead, narrowed={narrowed}"
            );
            assert_eq!(
                around(glyph, "\x1b[1;3H\x1b[2X").0,
                "00..000000ABCDEFGHIJ",
                "ECH over the glyph, narrowed={narrowed}"
            );
            assert_eq!(
                around(glyph, "\x1b[1;4H\x1b[41m\x1b[1X\x1b[m"),
                ("00..000000ABCDEFGHIJ".to_string(), "23".to_string()),
                "the cut lead takes the fill, narrowed={narrowed}"
            );
        }
        assert_eq!(
            cells(&[Out("\x1b[1;13H\u{4e2d}"), N, Out("\x1b[1;9H\x1b[5X"), W])[0],
            "00000000......EFGHIJ",
            "ECH into kept cells, ending on a kept lead"
        );
    }

    #[test]
    fn the_alternate_screen_keeps_no_cells_while_it_is_not_shown() {
        let (term, _) = run_term(&[N, Out("\x1b[?1049l"), To(8, 4)]);
        let alt = term.inactive_grid();
        assert!((0..alt.screen_lines()).all(|y| alt[Line(y as i32)].hidden_len() == 0));
        let (term, _) = run_term(&[N, Out("\x1b[?1049l")]);
        let alt = term.inactive_grid();
        assert!((0..alt.screen_lines()).all(|y| alt[Line(y as i32)].hidden_len() == 0));
    }

    fn all(rows: [&str; 4]) -> Vec<String> {
        rows.iter().map(|r| r.to_string()).collect()
    }

    #[test]
    fn a_widen_shows_the_cells_a_narrow_kept() {
        assert_eq!(rows(&[N, W]), all([R0, R1, R2, R3]));
        assert_eq!(
            rows(&[N, To(5, 4), W]),
            all([R0, R1, R2, R3]),
            "narrows never cut"
        );
        let wide: Vec<String> = [R0, R1, R2, R3]
            .iter()
            .map(|r| format!("{r}.........."))
            .collect();
        assert_eq!(rows(&[N, To(30, 4)]), wide);
    }

    #[test]
    fn a_partial_widen_drops_what_lies_past_it() {
        assert_eq!(
            rows(&[N, To(15, 4), W]),
            all([
                "0000000000ABCDE.....",
                "1111111111KLMNO.....",
                "2222222222abcde.....",
                "3333333333klmno....."
            ])
        );
    }

    #[test]
    fn printing_and_line_erase_touch_the_visible_cells_only() {
        assert_eq!(
            rows(&[N, Out("\x1b[1;6Hxyz"), W])[0],
            "00000xyz00ABCDEFGHIJ"
        );
        let wrapped = rows(&[N, Out("\x1b[1;9Hxyzw"), W]);
        assert_eq!(
            wrapped[..2],
            [
                "00000000xyABCDEFGHIJ".to_string(),
                "zw11111111KLMNOPQRST".to_string()
            ]
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;6H\x1b[K"), W])[0],
            "00000.....ABCDEFGHIJ"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;6H\x1b[1K"), W])[0],
            "......0000ABCDEFGHIJ"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;6H\x1b[2K"), W])[0],
            "..........ABCDEFGHIJ"
        );
        assert_eq!(rows(&[N, Out("\x1b[1;20Hz"), W])[0], "000000000zABCDEFGHIJ");
        assert_eq!(
            rows(&[Out("\x1b[1;16H"), N, Out("Z"), W])[0],
            "000000000ZABCDEFGHIJ"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;1H\t\t\tq"), W])[0],
            "000000000qABCDEFGHIJ"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;3Ha\x1b[15b"), W])[..2],
            [
                "00aaaaaaaaABCDEFGHIJ".to_string(),
                "aaaaaaaa11KLMNOPQRST".to_string()
            ]
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;10HQ\x1b[K"), W])[0],
            "000000000QABCDEFGHIJ",
            "a pending wrap"
        );
    }

    #[test]
    fn display_erase_fills_whole_lines_and_the_current_one_visibly() {
        assert_eq!(
            rows(&[N, Out("\x1b[2;6H\x1b[J"), W]),
            all([R0, "11111.....KLMNOPQRST", BLANK, BLANK])
        );
        assert_eq!(
            rows(&[N, Out("\x1b[2;6H\x1b[1J"), W]),
            all([BLANK, "......1111KLMNOPQRST", R2, R3])
        );
        assert_eq!(
            rows(&[N, Out("\x1b[2J"), W]),
            all([BLANK, BLANK, BLANK, BLANK])
        );
        assert_eq!(rows(&[N, Out("\x1b[3J"), W]), all([R0, R1, R2, R3]));
    }

    #[test]
    fn character_insert_delete_and_erase_run_over_the_physical_line() {
        assert_eq!(
            rows(&[N, Out("\x1b[1;3H\x1b[3@"), W])[0],
            "00...00000000ABCDEFG"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;3H\x1b[3P"), W])[0],
            "0000000ABCDEFGHIJ..."
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;3H\x1b[15X"), W])[0],
            "00...............HIJ"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;9H\x1b[3X"), W])[0],
            "00000000...BCDEFGHIJ"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;3H\x1b[30X"), W])[0],
            "00.................."
        );
        assert_eq!(
            rows(&[N, Out("\x1b[4h\x1b[1;3Hxy\x1b[4l"), W])[0],
            "00xy00000000ABCDEFGH",
            "insert mode"
        );
        assert_eq!(
            rows(&[N, Out("\x1b[1;3H\x1b[3P"), To(15, 4), W])[0],
            "0000000ABCDEFGH....."
        );
        assert_eq!(
            rows(&[
                N,
                Out("\x1b[1;3H\x1b[3@"),
                To(5, 4),
                Out("\x1b[1;1H\x1b[2@"),
                W
            ])[0],
            "..00...00000000ABCDE"
        );
    }

    #[test]
    fn lines_move_with_their_kept_cells_and_new_lines_take_the_current_width() {
        assert_eq!(rows(&[N, Out("\x1b[4;1H\n"), W]), all([R1, R2, R3, BLANK]));
        assert_eq!(
            rows(&[N, Out("\x1b[1;1H\x1bM"), W]),
            all([BLANK, R0, R1, R2])
        );
        assert_eq!(
            rows(&[N, Out("\x1b[2;1H\x1b[L"), W]),
            all([R0, BLANK, R1, R2])
        );
        assert_eq!(
            rows(&[N, Out("\x1b[2;1H\x1b[M"), W]),
            all([R0, R2, R3, BLANK])
        );
        assert_eq!(rows(&[N, Out("\x1b[S"), W]), all([R1, R2, R3, BLANK]));
        assert_eq!(rows(&[N, Out("\x1b[T"), W]), all([BLANK, R0, R1, R2]));
        assert_eq!(
            rows(&[N, Out("\x1b[2;3r\x1b[S\x1b[r"), W]),
            all([R0, R2, BLANK, R3])
        );
        assert_eq!(
            rows(&[N, Out("\x1b[2;3r\x1b[3;1H\n\x1b[r"), W]),
            all([R0, R2, BLANK, R3])
        );
        assert_eq!(rows(&[To(10, 3), To(20, 4)]), all([R1, R2, R3, BLANK]));
        assert_eq!(rows(&[To(10, 6), To(20, 4)]), all([R0, R1, R2, R3]));
        let grown = rows(&[To(10, 6), Out("\x1b[6;1Hsixth"), To(20, 6)]);
        assert_eq!(grown[..4], all([R0, R1, R2, R3])[..]);
        assert_eq!(
            grown[4..],
            [
                "....................".to_string(),
                "sixth...............".to_string()
            ]
        );
    }

    #[test]
    fn decaln_fills_the_physical_line() {
        assert_eq!(
            rows(&[N, Out("\x1b#8"), W]),
            all(["EEEEEEEEEEEEEEEEEEEE"; 4])
        );
    }

    #[test]
    fn leaving_the_alternate_screen_or_a_reset_drops_the_kept_cells() {
        assert_eq!(
            rows(&[N, Out("\x1b[?1049l"), W, Out("\x1b[?1049h")]),
            all([BLANK; 4])
        );
        // ?47 and ?1047 get a native snapshot only where they leave no
        // alternate screen behind on xterm (ContextRule).
        assert_eq!(rows(&[N, Out("\x1bc"), W]), all([BLANK; 4]));
    }

    #[test]
    fn a_wide_char_cut_at_the_narrow_edge_comes_back_whole() {
        assert_eq!(
            rows(&[Out("\x1b[1;10H\u{4e2d}"), N, W])[0],
            "000000000\u{4e2d}BCDEFGHIJ"
        );
    }

    #[test]
    fn the_erase_background_reaches_kept_cells_as_xterm_s_does() {
        let red = |steps: &[Step]| run(steps).1;
        let full = "0123456789abcdefghij".to_string();
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[2J\x1b[0m"), W]),
            vec![full.clone(); 4]
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[2;6H\x1b[J\x1b[0m"), W]),
            vec!["".into(), "56789".into(), full.clone(), full.clone()]
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[1;6H\x1b[K\x1b[0m"), W])[0],
            "56789"
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[1;3H\x1b[3P\x1b[0m"), W])[0],
            "hij"
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[1;3H\x1b[3@\x1b[0m"), W])[0],
            "234"
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[1;3H\x1b[15X\x1b[0m"), W])[0],
            "23456789abcdefg"
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[4;1H\n\x1b[0m"), W])[3],
            "0123456789"
        );
        assert_eq!(
            red(&[N, Out("\x1b[41m\x1b[2;1H\x1b[L\x1b[0m"), W])[1],
            "0123456789"
        );
    }
}
