//! Opt-in native terminal core: VT state and retained history behind N-API.
//! NativeTransport owns the production PTY; NativePty remains a spike harness.

use crate::fallible::{self, AllocFailed, CallError, CallResult, ErrorCode};
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
use alacritty_terminal::wmux_alloc::{self, GridAllocFailed};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};
use std::sync::mpsc::{sync_channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use crate::test_allocator;

/// Loader contract for the opt-in daemon text backend. Bump on incompatible
/// changes to the exposed snapshot shape or required compatibility policy.
#[napi(catch_unwind)]
pub fn native_core_abi_version() -> u32 {
    1
}

/// Builds one vte processor for this thread's NativeTerminals now, if none
/// is idle (`parsers::warm`): its 2 MiB buffer is allocated infallibly, so
/// the snapshot loader takes it at load, before memory runs short (#3440).
/// Calling it again while one is idle does nothing.
#[napi(catch_unwind)]
pub fn warm_terminal_parsers() {
    parsers::warm();
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
        #[cfg(windows)]
        "pipe-listener-v1".into(),
        // v1 plus the client token read and the pipe owner check.
        #[cfg(windows)]
        "pipe-listener-v2".into(),
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

/// The rows JS receives, in one buffer reserved fallibly (one per process).
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
// Reached only through the napi export, which the test build does not call.
#[cfg_attr(test, allow(dead_code))]
fn native_rows(
    rows: Vec<crate::process_table::ProcessRow>,
) -> std::result::Result<Vec<NativeProcessRow>, AllocFailed> {
    let mut out = fallible::try_with_capacity(rows.len(), "the process table for JS")?;
    out.extend(rows.into_iter().map(|r| NativeProcessRow {
        pid: r.pid,
        ppid: r.ppid,
        name: r.name,
        created: r.created,
        cmdline: r.cmdline,
    }));
    Ok(out)
}

/// A table read's error as a Task's. A refusal (a refused allocation, or an
/// OS call refused for want of memory) is kept in `refused` for `reject`,
/// which rejects with code ALLOC_FAILED (`task_refusal`): a Task's errors
/// cannot carry it. Anything else rejects as it is.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
// Reached only through the napi export, which the test build does not call.
#[cfg_attr(test, allow(dead_code))]
fn task_error(refused: &mut Option<CallError>, error: CallError) -> Error {
    match error {
        CallError::Reason(reason) => Error::from_reason(reason.into_owned()),
        refusal => {
            *refused = Some(refusal);
            Error::from_status(Status::GenericFailure)
        }
    }
}

/// The JS rows are built off the JS thread too, so `resolve` allocates
/// nothing of its own.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub struct ProcessTableTask {
    with_command_lines: bool,
    /// A refusal in `compute` (`task_error`), for `reject`.
    refused: Option<CallError>,
}
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl Task for ProcessTableTask {
    type Output = Vec<NativeProcessRow>;
    type JsValue = Vec<NativeProcessRow>;
    fn compute(&mut self) -> Result<Self::Output> {
        crate::process_table::snapshot(self.with_command_lines)
            .and_then(|rows| Ok(native_rows(rows)?))
            .map_err(|error| task_error(&mut self.refused, error))
    }
    fn resolve(&mut self, _env: Env, rows: Self::Output) -> Result<Self::JsValue> {
        Ok(rows)
    }
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(match self.refused.take() {
            Some(refused) => fallible::task_refusal(env, refused),
            None => error,
        })
    }
}

/// The process table off the JS thread. With `with_command_lines`, each
/// row also carries its creation time and command line where readable.
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[napi(catch_unwind)]
pub fn process_table(with_command_lines: bool) -> AsyncTask<ProcessTableTask> {
    AsyncTask::new(ProcessTableTask {
        with_command_lines,
        refused: None,
    })
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

/// The snapshot JS receives, its two lists reserved fallibly.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn native_port_snapshot(
    snap: crate::process_table::PortSnapshot,
) -> std::result::Result<NativePortSnapshot, AllocFailed> {
    let processes = native_rows(snap.processes)?;
    let mut sockets =
        fallible::try_with_capacity(snap.sockets.len(), "the listening sockets for JS")?;
    sockets.extend(snap.sockets.into_iter().map(|r| NativeListenSocket {
        pid: r.pid,
        port: r.port.into(),
        address: r.address,
        family: r.family.into(),
    }));
    Ok(NativePortSnapshot { processes, sockets })
}

/// Built off the JS thread, as ProcessTableTask.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Default)]
pub struct PortSnapshotTask {
    /// A refusal in `compute` (`task_error`), for `reject`.
    refused: Option<CallError>,
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Task for PortSnapshotTask {
    type Output = NativePortSnapshot;
    type JsValue = NativePortSnapshot;
    fn compute(&mut self) -> Result<Self::Output> {
        crate::process_table::port_snapshot()
            .and_then(|snap| Ok(native_port_snapshot(snap)?))
            .map_err(|error| task_error(&mut self.refused, error))
    }
    fn resolve(&mut self, _env: Env, snap: Self::Output) -> Result<Self::JsValue> {
        Ok(snap)
    }
    fn reject(&mut self, env: Env, error: Error) -> Result<Self::JsValue> {
        Err(match self.refused.take() {
            Some(refused) => fallible::task_refusal(env, refused),
            None => error,
        })
    }
}

/// PortWatcher's snapshot off the JS thread: the process walk and every
/// listening TCP socket this user can read, with the pid holding it, from
/// one walk.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[napi(catch_unwind)]
pub fn port_snapshot() -> AsyncTask<PortSnapshotTask> {
    AsyncTask::new(PortSnapshotTask::default())
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

fn dimensions(cols: u32, rows: u32) -> CallResult<Size> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(CallError::reason(
            "Experiment requires 2..1000 columns and 1..1000 rows",
        ));
    }
    Ok(Size {
        cols: cols as usize,
        rows: rows as usize,
    })
}

/// `dimensions` for the spike PTY: its only error is the range, never a
/// refused allocation.
fn pty_dimensions(cols: u32, rows: u32) -> Result<()> {
    match dimensions(cols, rows) {
        Ok(_) => Ok(()),
        Err(CallError::Reason(reason)) => Err(Error::from_reason(reason)),
        Err(CallError::Alloc(_) | CallError::OsRefused(_)) => {
            unreachable!("dimensions allocates nothing")
        }
    }
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
    /// From this thread's processors, given back at dispose or drop.
    parser: PooledParser,
    /// Drops an OSC past MAX_OSC_BODY before the parser sees it.
    osc: OscCap,
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
    /// A grid allocation was refused: the terminal is gone and every call
    /// that needs it fails with GRID_REFUSED (`settle`).
    grid_refused: bool,
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
/// The most bytes one `feed` / `feed_xterm` call takes: the ring's 256 MiB
/// cap (RustSnapshot feeds 256 KiB at a time). A feed joins its bytes to at
/// most MAX_HELD held ones, so the join is bounded by this plus MAX_HELD.
const MAX_FEED_BYTES: usize = 256 * 1024 * 1024;
/// A feed's held bytes joined to its input (MAX_FEED_BYTES + MAX_HELD).
const FEED_JOIN: &str = "a terminal feed's input";
/// The held sequence's room, reserved before parsing so that holding one
/// never allocates mid-feed (MAX_HELD).
const HELD: &str = "a terminal feed's held sequence";
/// The tracker's copy of a control without its C0 bytes (`track`).
const TRACKED_C0: &str = "a control the feed tracks, without its C0 bytes";
/// Why the ANSI snapshot is refused when the feed could not allocate a
/// buffer partway through a call (the call itself reports ALLOC_FAILED).
pub(crate) const ALLOC_REFUSED: &str =
    "unsupported-alloc: a buffer the ANSI feed needed could not be allocated";
/// Why every call after a refused grid allocation fails: the refusal may have
/// left the grid half updated, so the terminal is dropped (`settle`).
pub(crate) const GRID_REFUSED: &str =
    "unsupported-alloc: the terminal grid could not allocate, so this terminal is unusable";

/// Runs `f`, which drives the vendored grid. A refused grid allocation
/// unwinds out of it (vendor `wmux_alloc`: a zero-sized payload, no panic
/// hook) and comes back here as the refusal; any other panic goes on. Nothing
/// `f` touches holds a lock.
fn grid_unwind<R>(f: impl FnOnce() -> R) -> std::result::Result<R, AllocFailed> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => Ok(result),
        Err(payload) if payload.is::<GridAllocFailed>() => {
            let (bytes, what) = wmux_alloc::take_refusal();
            Err(AllocFailed { what, bytes })
        }
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

/// The longest OSC body the snapshot terminal parses (OscCap). vte's OSC
/// buffer (its std build) grows without a bound and infallibly (#3440).
const MAX_OSC_BODY: usize = 1024 * 1024;
/// The OSC a feed ended inside, held for the next (OscCap): at most
/// MAX_OSC_BODY and its opening bytes.
const OSC_HELD: &str = "an OSC held across feeds";
/// A held buffer kept for the next OSC up to this capacity; past it, freed.
const OSC_HELD_KEPT: usize = 64 * 1024;
/// Why `feed_xterm` refuses a stream with a dropped OSC: xterm reads it.
const LONG_OSC: &str =
    "unsupported-state-long-sequence: an OSC past 1 MiB, which the native snapshot drops";

/// Bytes vte reads between an ESC and the byte after it while staying in
/// its escape state: C0 controls but CAN and SUB (executed), another ESC,
/// DEL, and every byte from 0x80 (its escape state reads no UTF-8 and
/// ignores them). vte reads no C1 introducer: 0x9D opens no OSC.
fn esc_filler(b: u8) -> bool {
    !matches!(b, 0x18 | 0x1a | 0x20..=0x7e)
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
enum OscScan {
    #[default]
    Text,
    /// The last feed ended on an ESC, perhaps with filler after it, which
    /// went on: the feeds below hold it for the byte after it.
    EscPassed,
    /// The last feed ended inside an OSC body (held).
    Osc,
    /// Inside an OSC past MAX_OSC_BODY: skipped up to its end.
    Drop,
    /// The last feed ended on an ESC that ends a dropped OSC.
    DropEsc,
}

/// What follows a dropped OSC's introducer: vte ends the OSC it opens there,
/// empty (its dispatch does nothing), and executes the CAN (nothing).
const OSC_DROPPED: &[u8] = b"\x18";

/// The snapshot terminal's pre-scan (feed, feedXterm, feedFrozen): an OSC
/// whose body passes MAX_OSC_BODY never reaches the parser. vte opens an OSC
/// at an ESC, filler (esc_filler), then `]`, whatever it was inside, and
/// dispatches it at any end (BEL, CAN, SUB, ESC), so an OSC a feed ends
/// inside is held until it ends or passes the cap; one that starts and ends
/// in a feed under the cap passes in place.
///
/// A dropped OSC leaves vte as an OSC a CAN ends leaves it: its introducer
/// goes on (whatever vte was inside ends there as it would), then a CAN
/// (OSC_DROPPED), where vte is in its ground state. Its body never reaches
/// vte, and its end is skipped as vte reads it: a BEL or an ESC \ is skipped
/// with it; a CAN or SUB is passed on (vte executes it); another ESC begins
/// the next sequence. 0x9C is part of the body for vte. A feed's final ESC
/// goes on as before (the feeds below hold it).
///
/// Its state changes only once the bytes it stands for went on (`emit`
/// succeeded), so a refused first emit changes nothing, and the same bytes
/// fed again pass as if the refusal had not happened. A refusal after some
/// bytes went on (vte advanced) leaves the state those bytes left: such a
/// feed is partially applied, and a dropped OSC's introducer that went on
/// is never passed again (its CAN, if refused, is owed instead).
#[derive(Default)]
struct OscCap {
    /// What the bytes passed on so far leave.
    scan: OscScan,
    /// The open OSC (OscScan::Osc), from its ESC, or from its `]` when its
    /// ESC went on already.
    held: Vec<u8>,
    /// The held OSC's introducer: its first `intro` bytes, up to its `]`.
    intro: usize,
    /// The held OSC's body bytes so far.
    body: usize,
    /// An OSC was dropped since the last `take_dropped`.
    dropped: bool,
    /// A dropped OSC's introducer went on and its OSC_DROPPED was refused:
    /// it goes on before any other byte.
    owed: bool,
}

/// Where OscCap passes bytes: `dropped` is true for the bytes that stand for
/// a dropped OSC (its introducer, then OSC_DROPPED).
type OscEmit<'a> = dyn FnMut(&[u8], bool) -> std::result::Result<(), AllocFailed> + 'a;

/// `emit(bytes)` unless empty.
fn emit_some(emit: &mut OscEmit<'_>, bytes: &[u8]) -> std::result::Result<(), AllocFailed> {
    if bytes.is_empty() {
        return Ok(());
    }
    emit(bytes, false)
}

/// Where the filler after an ESC (esc_filler) ends, from `at` on.
fn past_filler(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && esc_filler(bytes[at]) {
        at += 1;
    }
    at
}

impl OscCap {
    /// Passes `bytes` to `emit` in order, less any OSC past the cap, holding
    /// an OSC the bytes end inside. A refused hold returns before the bytes
    /// it would hold are passed on.
    fn scan(
        &mut self,
        bytes: &[u8],
        emit: &mut OscEmit<'_>,
    ) -> std::result::Result<(), AllocFailed> {
        if self.owed {
            emit(OSC_DROPPED, true)?;
            self.owed = false;
        }
        let len = bytes.len();
        // Where the bytes passed on as they are start, and where scanning is.
        let mut from = 0;
        let mut i = 0;
        // What the bytes up to `i` leave; kept in `self.scan` only once the
        // bytes up to there went on.
        let mut scan = self.scan;
        loop {
            // An OSC opens: held from `start`, its body after `bracket`;
            // `before` is what the bytes up to `start` leave.
            let (start, bracket, before) = match scan {
                OscScan::Text => {
                    let Some(found) = bytes[i..].iter().position(|&b| b == 0x1b) else {
                        break;
                    };
                    let esc = i + found;
                    let at = past_filler(bytes, esc + 1);
                    if at == len {
                        scan = OscScan::EscPassed;
                        break;
                    }
                    if bytes[at] != b']' {
                        i = at;
                        continue;
                    }
                    (esc, at, OscScan::Text)
                }
                OscScan::EscPassed => {
                    let at = past_filler(bytes, i);
                    if at == len {
                        break;
                    }
                    scan = OscScan::Text;
                    if bytes[at] != b']' {
                        i = at;
                        continue;
                    }
                    // Until its `]` went on, the ESC still waits for it.
                    (at, at, OscScan::EscPassed)
                }
                OscScan::Osc => {
                    match string_end(&bytes[i..]) {
                        Some(end) if self.body + end <= MAX_OSC_BODY => {
                            self.flush(&bytes[i..i + end], emit)?;
                            scan = OscScan::Text;
                            from = i + end;
                            i += end;
                        }
                        Some(end) => {
                            self.drop_held(emit)?;
                            (from, i, scan) = Self::end_dropped(bytes, i + end);
                        }
                        None if self.body + (len - i) <= MAX_OSC_BODY => {
                            self.hold(&bytes[i..])?;
                            self.body += len - i;
                            from = len;
                            break;
                        }
                        None => {
                            self.drop_held(emit)?;
                            scan = OscScan::Drop;
                            from = len;
                            break;
                        }
                    }
                    continue;
                }
                OscScan::Drop => {
                    match string_end(&bytes[i..]) {
                        Some(end) => (from, i, scan) = Self::end_dropped(bytes, i + end),
                        None => {
                            from = len;
                            break;
                        }
                    }
                    continue;
                }
                OscScan::DropEsc => {
                    if i == len {
                        break;
                    }
                    if bytes[i] == b'\\' {
                        scan = OscScan::Text;
                        i += 1;
                    } else {
                        // That ESC ended the dropped OSC and begins the next
                        // sequence, perhaps another OSC.
                        emit(&b"\x1b"[..], false)?;
                        scan = OscScan::EscPassed;
                        self.scan = scan;
                    }
                    from = i;
                    continue;
                }
            };
            let body = bracket + 1;
            match string_end(&bytes[body..]) {
                Some(end) if end <= MAX_OSC_BODY => i = body + end,
                Some(end) => {
                    emit_some(emit, &bytes[from..start])?;
                    self.scan = before;
                    self.drop_osc(&bytes[start..body], emit)?;
                    (from, i, scan) = Self::end_dropped(bytes, body + end);
                }
                None if len - body <= MAX_OSC_BODY => {
                    // Room first, then the bytes before it: only once they
                    // went on is the OSC held, so a refusal of either leaves
                    // nothing held and a retry holds it once.
                    fallible::try_reserve(&mut self.held, len - start, OSC_HELD)?;
                    emit_some(emit, &bytes[from..start])?;
                    self.held.extend_from_slice(&bytes[start..]);
                    self.intro = body - start;
                    self.body = len - body;
                    scan = OscScan::Osc;
                    from = len;
                    break;
                }
                None => {
                    emit_some(emit, &bytes[from..start])?;
                    self.scan = before;
                    self.drop_osc(&bytes[start..body], emit)?;
                    scan = OscScan::Drop;
                    from = len;
                    break;
                }
            }
        }
        emit_some(emit, &bytes[from..])?;
        self.scan = scan;
        Ok(())
    }

    /// An OSC is dropped: its introducer (from its ESC, or its `]` when the
    /// ESC went on already) goes on, then OSC_DROPPED. A refused introducer
    /// changes nothing.
    fn drop_osc(
        &mut self,
        intro: &[u8],
        emit: &mut OscEmit<'_>,
    ) -> std::result::Result<(), AllocFailed> {
        emit(intro, true)?;
        self.intro_went_on(emit)
    }

    /// The held OSC is dropped (`drop_osc`). The hold is kept until its
    /// introducer went on, so a refused introducer leaves the OSC held as it
    /// was and a retry passes it once; then the hold is freed.
    fn drop_held(&mut self, emit: &mut OscEmit<'_>) -> std::result::Result<(), AllocFailed> {
        emit(&self.held[..self.intro], true)?;
        self.clear_open();
        self.intro_went_on(emit)
    }

    /// A dropped OSC's introducer went on: vte is inside it, and the bytes
    /// after it are its body, skipped (OscScan::Drop). OSC_DROPPED follows,
    /// owed while refused (`scan` passes it first).
    fn intro_went_on(&mut self, emit: &mut OscEmit<'_>) -> std::result::Result<(), AllocFailed> {
        self.dropped = true;
        self.scan = OscScan::Drop;
        self.owed = true;
        emit(OSC_DROPPED, true)?;
        self.owed = false;
        Ok(())
    }

    /// The dropped OSC ends at `bytes[at]` (string_end): returns where the
    /// bytes passed on resume, where scanning resumes, and the state there.
    fn end_dropped(bytes: &[u8], at: usize) -> (usize, usize, OscScan) {
        match bytes[at] {
            0x07 => (at + 1, at + 1, OscScan::Text),
            0x1b => match bytes.get(at + 1) {
                Some(b'\\') => (at + 2, at + 2, OscScan::Text),
                Some(_) => (at, at, OscScan::Text),
                None => (bytes.len(), bytes.len(), OscScan::DropEsc),
            },
            // CAN and SUB: vte ends the OSC and executes them.
            _ => (at, at + 1, OscScan::Text),
        }
    }

    fn hold(&mut self, bytes: &[u8]) -> std::result::Result<(), AllocFailed> {
        fallible::try_reserve(&mut self.held, bytes.len(), OSC_HELD)?;
        self.held.extend_from_slice(bytes);
        Ok(())
    }

    /// Passes the held OSC on with `rest`, its end, and empties the hold. A
    /// refusal (the hold's growth, or the parser's join before it parses
    /// anything) leaves the OSC held as it was, so a retry passes it once.
    fn flush(
        &mut self,
        rest: &[u8],
        emit: &mut OscEmit<'_>,
    ) -> std::result::Result<(), AllocFailed> {
        let before = self.held.len();
        self.hold(rest)?;
        let held = std::mem::take(&mut self.held);
        let result = emit(&held, false);
        self.held = held;
        match result {
            Ok(()) => {
                self.clear_open();
                Ok(())
            }
            Err(failed) => {
                self.held.truncate(before);
                Err(failed)
            }
        }
    }

    /// Whether an OSC was dropped since the last call.
    fn take_dropped(&mut self) -> bool {
        std::mem::take(&mut self.dropped)
    }

    /// The held OSC has gone on (`flush`, or the snapshot read it): empty.
    fn clear_open(&mut self) {
        if self.scan == OscScan::Osc {
            self.scan = OscScan::Text;
        }
        self.held.clear();
        if self.held.capacity() > OSC_HELD_KEPT {
            self.held = Vec::new();
        }
        self.intro = 0;
        self.body = 0;
    }
}

/// vte builds a Processor with its 2 MiB synchronized-update buffer
/// allocated infallibly (vte is not vendored, #3440). Each thread keeps the
/// processors its terminals are done with, reset, and hands them to its next
/// terminals: a thread builds one per terminal alive at once, not one per
/// terminal.
mod parsers {
    use alacritty_terminal::vte::ansi::{Handler, Processor, Timeout};
    use std::cell::RefCell;

    /// Idle processors kept per thread (2 MiB each); more are dropped.
    pub(super) const MAX_IDLE: usize = 4;

    thread_local! {
        static IDLE: RefCell<Vec<Processor>> = const { RefCell::new(Vec::new()) };
    }

    /// An idle processor of this thread, or a new one.
    pub(super) fn take() -> Processor {
        IDLE.try_with(|idle| idle.borrow_mut().pop())
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    /// One new processor for this thread's next terminal, if none is idle.
    pub(super) fn warm() {
        let _ = IDLE.try_with(|idle| {
            let mut idle = idle.borrow_mut();
            if idle.is_empty() && idle.try_reserve(1).is_ok() {
                idle.push(Processor::new());
            }
        });
    }

    /// Keeps `parser` for this thread's next terminal, reset (`reset`).
    pub(super) fn give(mut parser: Processor) {
        reset(&mut parser);
        let _ = IDLE.try_with(move |idle| {
            let mut idle = idle.borrow_mut();
            if idle.len() < MAX_IDLE && idle.try_reserve(1).is_ok() {
                idle.push(parser);
            }
        });
    }

    #[cfg(test)]
    pub(super) fn idle() -> usize {
        IDLE.with(|idle| idle.borrow().len())
    }

    /// Takes in what a parser holds and acts on nothing.
    struct Discard;
    impl Handler for Discard {}

    /// The ground state a new processor starts in, without allocating: an
    /// open synchronized update ends (its bytes parsed into nothing), and
    /// a CAN ends any sequence, string or partial UTF-8 character. One
    /// thing cannot be put back: the character REP repeats, which vte
    /// keeps privately from the last print. A space is printed last, so it
    /// is a space rather than the last terminal's character.
    pub(super) fn reset(parser: &mut Processor) {
        let mut discard = Discard;
        if parser.sync_timeout().pending_timeout() {
            parser.stop_sync(&mut discard);
        }
        parser.advance(&mut discard, b"\x18 ");
    }
}

/// The terminal's processor, from this thread's (`parsers`) and given back
/// when the terminal is disposed or dropped, or its constructor fails.
struct PooledParser(Option<Processor>);

impl PooledParser {
    fn take() -> Self {
        Self(Some(parsers::take()))
    }

    /// Gives the processor back to this thread's pool, unless the thread is
    /// unwinding: then it is dropped (`discard`), whatever the unwind is, a
    /// grid refusal or any other panic, since either can leave vte partway
    /// through a call.
    fn release(&mut self) {
        if std::thread::panicking() {
            self.discard();
            return;
        }
        if let Some(parser) = self.0.take() {
            parsers::give(parser);
        }
    }

    /// Drops the processor rather than keeping it: an unwind out of vte
    /// (a grid refusal, settled by `settle`, or any other panic, `release`)
    /// can leave what `reset` cannot put back (the synchronized-update
    /// buffer vte takes for its replay, gone; a partial UTF-8 count past its
    /// bytes).
    fn discard(&mut self) {
        self.0 = None;
    }
}

impl Drop for PooledParser {
    fn drop(&mut self) {
        self.release();
    }
}

/// A disposed terminal returns before it parses ("Terminal disposed"), and
/// one a grid refusal dropped too (GRID_REFUSED).
const PARSER_RELEASED: &str = "the terminal's parser is used after dispose or a grid refusal";

impl Deref for PooledParser {
    type Target = Processor;
    fn deref(&self) -> &Processor {
        self.0.as_ref().expect(PARSER_RELEASED)
    }
}

impl DerefMut for PooledParser {
    fn deref_mut(&mut self) -> &mut Processor {
        self.0.as_mut().expect(PARSER_RELEASED)
    }
}

fn check_feed_len(len: usize) -> CallResult<()> {
    if len > MAX_FEED_BYTES {
        return Err(CallError::reason(
            "Terminal feed exceeds the 256 MiB per-call limit",
        ));
    }
    Ok(())
}

/// Joins `held` (at most MAX_HELD bytes) and `bytes` into one buffer, and
/// leaves `held` empty with room for MAX_HELD bytes. On a refusal nothing
/// changed: the caller returns before parsing anything.
fn join_held(held: &mut Vec<u8>, bytes: &[u8]) -> std::result::Result<Vec<u8>, AllocFailed> {
    fallible::try_reserve(held, MAX_HELD.saturating_sub(held.len()), HELD)?;
    let data = fallible::try_concat(held, bytes, FEED_JOIN)?;
    held.clear();
    Ok(data)
}
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
    seen: Families,
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
    /// The first allocation refused partway through a feed: the snapshot is
    /// refused (ALLOC_REFUSED) and the call reports it.
    alloc_failed: Option<AllocFailed>,
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

/// Room for every refusal family the feed has (about 25).
const MAX_FAMILIES: usize = 40;

/// The refusal families a feed met, each once, in the order met, in fixed
/// storage: keeping one never allocates, not even right after a refused
/// grid allocation (`settle`), where an allocation could abort. A family
/// past MAX_FAMILIES is not kept; there are fewer.
#[derive(Clone, Copy)]
struct Families {
    met: [&'static str; MAX_FAMILIES],
    len: usize,
}

impl Default for Families {
    fn default() -> Self {
        Self {
            met: [""; MAX_FAMILIES],
            len: 0,
        }
    }
}

impl Families {
    fn add(&mut self, family: &'static str) {
        if !self.contains(family) && self.len < MAX_FAMILIES {
            self.met[self.len] = family;
            self.len += 1;
        }
    }

    fn contains(&self, family: &str) -> bool {
        self.as_slice().contains(&family)
    }

    fn as_slice(&self) -> &[&'static str] {
        &self.met[..self.len]
    }
}

impl XtermFeed {
    /// Refuse the stream, reported as `why` when it is the first refusal;
    /// every refusal's family is kept in `seen`. Allocates nothing.
    fn refuse(&mut self, when: bool, why: &'static str) {
        if !when {
            return;
        }
        self.seen.add(refusal_family(why));
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
            // At most MAX_TAIL_UNITS units of up to 3 bytes (a 4-byte
            // character counts 2), about 12 KiB. Refused, the tail is lost as
            // when it overflows, and the snapshot refused.
            if let Err(failed) =
                fallible::try_reserve(&mut self.tail, 1, "the ANSI feed's pending string")
            {
                self.refuse_alloc(failed);
                self.tail_overflow = true;
                self.tail = Vec::new();
                return;
            }
            self.tail.push(b);
        }
    }

    /// A buffer the feed could not allocate partway through: the snapshot is
    /// refused for good and the call reports the first refusal.
    fn refuse_alloc(&mut self, failed: AllocFailed) {
        self.alloc_failed.get_or_insert(failed);
        self.refuse(true, ALLOC_REFUSED);
    }

    /// Holds `data[at..]` (at most MAX_HELD bytes, the room `join_held`
    /// reserved) for the next feed, and cuts it from `data`.
    fn hold(&mut self, data: &mut Vec<u8>, at: usize) {
        debug_assert!(self.held.is_empty() && data.len() - at <= self.held.capacity());
        self.held.extend_from_slice(&data[at..]);
        data.truncate(at);
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
            None => match crate::native_serialize::try_divergent(sequence) {
                Ok(divergent) => divergent || (is_rep(sequence) && !printed),
                Err(failed) => {
                    // Unread, the control cannot be trusted: refused.
                    self.refuse_alloc(failed);
                    return;
                }
            },
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
    fn scan(&mut self, bytes: &[u8]) -> std::result::Result<(), AllocFailed> {
        let mut data = join_held(&mut self.held, bytes)?;
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
                    self.hold(&mut data, at);
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
        Ok(())
    }

    /// Consume a string's payload from `data[at..]`; returns where scanning
    /// resumes, or None when the string continues past the data. An ESC as
    /// the last byte is held: it ends the string only with what follows.
    fn string_payload(&mut self, data: &mut Vec<u8>, at: usize) -> Option<usize> {
        match string_end(&data[at..]).map(|end| at + end) {
            Some(end) if data[end] == 0x1b && end + 1 == data.len() => {
                self.push_tail(&data[at..end]);
                self.hold(data, end);
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
                // Column 0 is placeable whatever a narrower resize clamped.
                self.saved[screen].unplaceable = false;
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
        let mut filtered: Vec<u8>;
        let sequence = if sequence[1..].iter().any(|&b| b < 0x20) {
            // At most the sequence, which is at most the feed's input.
            filtered = match fallible::try_with_capacity(sequence.len(), TRACKED_C0) {
                Ok(buffer) => buffer,
                Err(failed) => {
                    // Untracked, the snapshot cannot be trusted: refused.
                    self.refuse_alloc(failed);
                    return None;
                }
            };
            filtered.push(sequence[0]);
            filtered.extend(sequence[1..].iter().filter(|&&b| b >= 0x20));
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
    ///
    /// A refused join returns before anything is parsed. A buffer refused
    /// partway through is recorded in `alloc_failed` and refuses the snapshot.
    fn feed(
        &mut self,
        parser: &mut Processor,
        term: &mut Term<VoidListener>,
        bytes: &[u8],
    ) -> std::result::Result<(), AllocFailed> {
        let mut data = join_held(&mut self.held, bytes)?;
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
                    self.hold(&mut data, at);
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
        Ok(())
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
    fn pending_tail(&self) -> CallResult<Vec<u8>> {
        // At most MAX_HELD held bytes after a tail of about 12 KiB (push_tail).
        const TAIL: &str = "the ANSI snapshot's pending tail";
        if !self.in_string {
            return Ok(fallible::try_copy(&self.held, TAIL)?);
        }
        if self.tail_overflow {
            return Err(CallError::reason("partial-tail-overflow"));
        }
        Ok(fallible::try_concat(&self.tail, &self.held, TAIL)?)
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

/// xterm's saved row on the main screen across a narrowing that reflows
/// (`Buffer._reflowSmaller`): for each reflowed paragraph,
/// `savedY = min(savedY + linesToAdd, ybase + rows - 1)`, absolute. ybase
/// grows by at most a paragraph's added rows, so this is one clamp of the
/// total: `min(savedY + added, ybase + rows - 1)` (#3354).
///
/// The save is placeable while xterm's `savedY` equals the save's history
/// plus Alacritty's saved screen row (place_like_xterm). So the history
/// before the narrowing, `history`, plus the saved row before it,
/// `line_before`, moves by every added row. Alacritty moved its row only by
/// the rows the reflow kept on screen, clipped at the last row, and the
/// history grew by fewer rows than were added once the cap trimmed some, so
/// neither of those is used. The clamp is applied here, not at the restore:
/// xterm keeps the clamped row, and later output below the cap moves ybase
/// but not savedY. For a resize whose narrowing added rows.
fn narrowed_saved_history(grid: &Grid<Cell>, history: i64, line_before: i64) -> i64 {
    let line = i64::from(grid.saved_cursor.point.line.0);
    let bottom = grid.history_size() as i64 + grid.screen_lines() as i64 - 1;
    (history + line_before + grid.narrowing_added as i64 - line).min(bottom - line)
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
/// or a list past 32 parameters before this runs). The C0 bytes are
/// skipped in place: the read allocates nothing.
fn resets_1049(sequence: &[u8]) -> Option<bool> {
    let (&first, rest) = sequence.split_first()?;
    let mut body = rest.iter().copied().filter(|&b| b >= 0x20);
    if first != 0x1b || body.next() != Some(b'[') || body.next() != Some(b'?') {
        return None;
    }
    let (mut count, mut found, mut params, mut ended) = (0, false, false, false);
    let (mut value, mut digits) = (0u32, 0usize);
    for b in body {
        if ended {
            return None;
        }
        match b {
            b'0'..=b'9' => {
                value = value.saturating_mul(10).saturating_add(u32::from(b - b'0'));
                digits += 1;
            }
            b';' => {
                count += 1;
                found |= digits > 0 && value == 1049;
                (value, digits) = (0, 0);
            }
            b'l' => {
                ended = true;
                continue;
            }
            _ => return None,
        }
        params = true;
    }
    if !ended || !params {
        return None;
    }
    count += 1;
    found |= digits > 0 && value == 1049;
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
///
/// A refused join returns before anything is parsed; nothing else allocates.
fn advance_indexing(
    parser: &mut Processor,
    term: &mut Term<VoidListener>,
    held: &mut Vec<u8>,
    bytes: &[u8],
) -> std::result::Result<(), AllocFailed> {
    let joined;
    let bytes = if held.is_empty() {
        // Room to hold an ESC below (MAX_HELD) without allocating then.
        fallible::try_reserve(held, MAX_HELD, HELD)?;
        bytes
    } else {
        joined = join_held(held, bytes)?;
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
                // Within the MAX_HELD room reserved above.
                held.extend_from_slice(&bytes[esc..]);
                return Ok(());
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
    Ok(())
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

/// The most bytes `ansi_snapshot` appends after the serialized screen
/// besides the pending tail.
const ANSI_MODES_TAIL: usize = 32;

/// The text snapshot's rows and strings.
const TEXT_SNAPSHOT: &str = "the text snapshot";

/// One grid line as text, and with dim cells blanked when `undimmed`. Each
/// string starts with room for one byte per cell and grows fallibly from
/// there (a cell holds its character and its zero-width ones).
fn text_row(
    line: &alacritty_terminal::grid::Row<Cell>,
    columns: usize,
    undimmed: bool,
) -> std::result::Result<(String, Option<String>), AllocFailed> {
    let mut text = String::new();
    fallible::try_reserve_str(&mut text, columns, TEXT_SNAPSHOT)?;
    let mut plain = String::new();
    if undimmed {
        fallible::try_reserve_str(&mut plain, columns, TEXT_SNAPSHOT)?;
    }
    let push = |s: &mut String, c: char| fallible::try_push(s, c, TEXT_SNAPSHOT);
    for x in 0..columns {
        let cell = &line[Column(x)];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        push(&mut text, cell.c)?;
        for &c in cell.zerowidth().unwrap_or_default() {
            push(&mut text, c)?;
        }
        if undimmed {
            if cell.flags.contains(Flags::DIM) {
                push(&mut plain, ' ')?;
                if cell.flags.contains(Flags::WIDE_CHAR) {
                    push(&mut plain, ' ')?;
                }
            } else {
                push(&mut plain, cell.c)?;
                for &c in cell.zerowidth().unwrap_or_default() {
                    push(&mut plain, c)?;
                }
            }
        }
    }
    // Trimmed in place, without a second copy. xterm trims blank grid cells,
    // not arbitrary Unicode whitespace; the undimmed text trims both.
    let kept = text.trim_end_matches(' ').len();
    text.truncate(kept);
    Ok((
        text,
        undimmed.then(|| {
            let kept = plain.trim_end().len();
            plain.truncate(kept);
            plain
        }),
    ))
}

#[napi]
impl NativeTerminal {
    #[napi(constructor, catch_unwind)]
    pub fn new(cols: u32, rows: u32, scrollback: u32) -> Result<Self, ErrorCode> {
        Ok(Self::create(cols, rows, scrollback)?)
    }

    #[napi(catch_unwind)]
    pub fn feed(&mut self, bytes: Uint8Array) -> Result<(), ErrorCode> {
        Ok(self.feed_bytes(&bytes)?)
    }

    /// See `feed_xterm_bytes`.
    #[napi(catch_unwind)]
    pub fn feed_xterm(
        &mut self,
        bytes: Uint8Array,
        requested_scrollback: u32,
    ) -> Result<bool, ErrorCode> {
        Ok(self.feed_xterm_bytes(&bytes, requested_scrollback)?)
    }

    /// Every refusal family the ANSI feed met, the reported one first, each
    /// once. Empty while the snapshot is not refused.
    #[napi(catch_unwind)]
    pub fn refusal_families(&self) -> Vec<String> {
        self.families()
    }

    /// Replay an immutable native ring copy without a full JS Buffer round trip.
    #[napi(catch_unwind)]
    pub fn feed_frozen(
        &mut self,
        source: &NativeFrozenRing,
        start: u32,
        end: u32,
    ) -> Result<(), ErrorCode> {
        Ok(self.feed_frozen_range(source, start, end)?)
    }

    #[napi(catch_unwind)]
    pub fn resize(&mut self, cols: u32, rows: u32) -> Result<(), ErrorCode> {
        Ok(self.resize_grid(cols, rows)?)
    }

    #[napi(catch_unwind)]
    pub fn text_snapshot(&mut self, undimmed: bool) -> Result<NativeTextSnapshot, ErrorCode> {
        Ok(self.text_snapshot_rows(undimmed)?)
    }

    /// See `ansi_snapshot_bytes`.
    #[napi(catch_unwind)]
    pub fn ansi_snapshot(
        &mut self,
        requested_scrollback: Option<u32>,
    ) -> Result<Buffer, ErrorCode> {
        Ok(self.ansi_snapshot_bytes(requested_scrollback)?.into())
    }

    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.term = None;
        // Back to this thread's processors, never a new one (#3440).
        self.parser.release();
        self.osc = OscCap::default();
    }
}

/// The calls' bodies, free of napi types so the unit tests link without
/// Node (`CallError`).
impl NativeTerminal {
    pub(crate) fn create(cols: u32, rows: u32, scrollback: u32) -> CallResult<Self> {
        let size = dimensions(cols, rows)?;
        if scrollback > 100_000 || (rows as u64 + scrollback as u64) * cols as u64 > 4_000_000 {
            return Err(CallError::reason(
                "Experiment grid exceeds four million cells",
            ));
        }
        let config = Config {
            scrolling_history: scrollback as usize,
            osc52: Osc52::Disabled,
            ..Config::default()
        };
        // Taken first: a refused grid gives it back (PooledParser's drop).
        let parser = PooledParser::take();
        let term = grid_unwind(|| Term::new(config, &size, VoidListener))?;
        Ok(Self {
            term: Some(term),
            parser,
            osc: OscCap::default(),
            scrollback,
            requested_scrollback: scrollback,
            feed: XtermFeed {
                alt_rows: rows as usize,
                ..XtermFeed::default()
            },
            refusal: None,
            scanned: 0,
            text_held: Vec::new(),
            grid_refused: false,
        })
    }

    pub(crate) fn feed_bytes(&mut self, bytes: &[u8]) -> CallResult<()> {
        self.usable()?;
        let result = grid_unwind(|| {
            let term = self
                .term
                .as_mut()
                .ok_or_else(|| CallError::reason("Terminal disposed"))?;
            check_feed_len(bytes.len())?;
            // Parser retains incomplete UTF-8 / escape state across feeds.
            // VoidListener intentionally discards all PTY replies and clipboard events.
            let (parser, held) = (&mut self.parser, &mut self.text_held);
            self.osc.scan(bytes, &mut |part, _| {
                advance_indexing(parser, term, held, part)
            })?;
            Ok(())
        });
        self.settle(result)
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
    ///
    /// A refused allocation throws ALLOC_FAILED: before any byte is parsed
    /// (the join), or partway through, which also refuses the snapshot.
    pub(crate) fn feed_xterm_bytes(
        &mut self,
        bytes: &[u8],
        requested_scrollback: u32,
    ) -> CallResult<bool> {
        self.usable()?;
        let result = grid_unwind(|| {
            let term = self
                .term
                .as_mut()
                .ok_or_else(|| CallError::reason("Terminal disposed"))?;
            check_feed_len(bytes.len())?;
            if self.refusal.is_some() {
                let take = bytes.len().min(REFUSAL_SCAN_BYTES - self.scanned);
                self.feed.scan(&bytes[..take])?;
                self.scanned += take;
                if let Some(failed) = self.feed.alloc_failed.take() {
                    return Err(failed.into());
                }
                return Ok(self.scanned >= REFUSAL_SCAN_BYTES);
            }
            self.requested_scrollback = requested_scrollback;
            // A refused join parses nothing; one after a part was parsed
            // refuses the snapshot.
            let mut parsed = false;
            let (feed, parser) = (&mut self.feed, &mut self.parser);
            let scanned = self.osc.scan(bytes, &mut |part, dropped| {
                // Refused as LONG_OSC before the bytes in its place reach
                // the tracker, so that refusal is the one reported.
                feed.refuse(dropped, LONG_OSC);
                feed.feed(parser, term, part)?;
                parsed = true;
                Ok(())
            });
            if let Err(failed) = scanned {
                if !parsed {
                    return Err(failed.into());
                }
                self.feed.refuse_alloc(failed);
            }
            self.feed.refuse(self.osc.take_dropped(), LONG_OSC);
            if self.feed.divergent {
                self.refusal = Some(
                    self.feed
                        .refused
                        .unwrap_or("unsupported-state: a control Alacritty parses differently"),
                );
            } else if history_at_native_cap(term, requested_scrollback, self.scrollback) {
                self.refusal = Some(HISTORY_LIMIT);
            }
            if let Some(failed) = self.feed.alloc_failed.take() {
                return Err(failed.into());
            }
            // Refused in these bytes: the scan of the next ones comes first.
            Ok(false)
        });
        self.settle(result)
    }

    /// The reported refusal's family first, then the others in the order
    /// met (`XtermFeed::seen`, fixed storage). The list JS gets is a small
    /// fixed allocation, as an error's code is: at most MAX_FAMILIES short
    /// strings, never sized by the session.
    pub(crate) fn families(&self) -> Vec<String> {
        let reported = self.refusal.map(refusal_family);
        let rest = self
            .feed
            .seen
            .as_slice()
            .iter()
            .copied()
            .filter(|family| Some(*family) != reported);
        reported
            .into_iter()
            .chain(rest)
            .map(str::to_owned)
            .collect()
    }

    pub(crate) fn feed_frozen_range(
        &mut self,
        source: &NativeFrozenRing,
        start: u32,
        end: u32,
    ) -> CallResult<()> {
        self.usable()?;
        let result = grid_unwind(|| {
            let bytes = source
                .bytes
                .get(start as usize..end as usize)
                .ok_or_else(|| CallError::reason("Invalid frozen ring range"))?;
            let term = self
                .term
                .as_mut()
                .ok_or_else(|| CallError::reason("Terminal disposed"))?;
            let (parser, held) = (&mut self.parser, &mut self.text_held);
            self.osc.scan(bytes, &mut |part, _| {
                advance_indexing(parser, term, held, part)
            })?;
            Ok(())
        });
        self.settle(result)
    }

    pub(crate) fn resize_grid(&mut self, cols: u32, rows: u32) -> CallResult<()> {
        self.usable()?;
        let result = grid_unwind(|| {
            let size = dimensions(cols, rows)?;
            if (rows as u64 + self.scrollback as u64) * cols as u64 > 4_000_000 {
                return Err(CallError::reason(
                    "Experiment grid exceeds four million cells",
                ));
            }
            let term = self
                .term
                .as_mut()
                .ok_or_else(|| CallError::reason("Terminal disposed"))?;
            // The row step runs at the old width first (below).
            if (rows as u64 + self.scrollback as u64) * term.columns() as u64 > 4_000_000 {
                return Err(CallError::reason(
                    "Experiment grid exceeds four million cells",
                ));
            }
            // vte holds bytes back inside a synchronized update; xterm parsed them
            // at the old size. Apply them first, then re-enter the update.
            let synchronized = self.parser.sync_timeout().pending_timeout();
            if synchronized {
                self.parser.stop_sync(term);
                // The held bytes can trim at the cap at the old width, and a
                // width-only widen can take the history back under it.
                if history_at_native_cap(term, self.requested_scrollback, self.scrollback) {
                    self.refusal.get_or_insert(HISTORY_LIMIT);
                }
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
            let saved_line = i64::from(main_grid(term).saved_cursor.point.line.0);
            // The grid records a narrowing only when this resize runs one: a
            // resize to the same size returns early and leaves the last one's.
            let narrows = size.columns() < term.columns();
            term.resize(size);
            let grid = main_grid(term);
            self.feed.saved[0].history = if narrows && grid.narrowing_added > 0 {
                narrowed_saved_history(grid, self.feed.saved[0].history, saved_line)
            } else {
                self.feed.saved[0].history + grid.history_size() as i64 - before
            };
            // feed_xterm checks the same after a chunk, where the chunk's own
            // ED 3 could hide a resize's trim.
            if history_at_native_cap(term, self.requested_scrollback, self.scrollback) {
                self.refusal.get_or_insert(HISTORY_LIMIT);
            }
            if synchronized {
                self.parser.advance(term, b"\x1b[?2026h");
            }
            Ok(())
        });
        self.settle(result)
    }

    pub(crate) fn text_snapshot_rows(&mut self, undimmed: bool) -> CallResult<NativeTextSnapshot> {
        self.usable()?;
        let result = grid_unwind(|| {
            let term = self
                .term
                .as_mut()
                .ok_or_else(|| CallError::reason("Terminal disposed"))?;
            self.parser.advance(term, &self.text_held);
            self.text_held.clear();
            // An open OSC stays held, so a later feed cannot continue it past
            // the cap.
            // A text read must include bytes in an unfinished synchronized update.
            // This finalizes the batch; this API does not promise ANSI replay state.
            self.parser.stop_sync(term);
            let grid = term.grid();
            let history = grid.history_size() as i32;
            // One per grid line: at most the grid's 4M cells.
            let mut rows = fallible::try_with_capacity(grid.total_lines(), TEXT_SNAPSHOT)?;
            let mut wrapped = false;
            for y in -history..grid.screen_lines() as i32 {
                let line = &grid[Line(y)];
                let (text, plain) = text_row(line, grid.columns(), undimmed)?;
                rows.push(NativeTextRow {
                    text,
                    wrapped,
                    undimmed: plain,
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
        });
        self.settle(result)
    }

    /// `requested_scrollback` above this terminal's own limit means the
    /// caller capped the history to bound memory: a history that reached the
    /// cap may have dropped rows the request would have kept.
    pub(crate) fn ansi_snapshot_bytes(
        &mut self,
        requested_scrollback: Option<u32>,
    ) -> CallResult<Vec<u8>> {
        self.usable()?;
        let result = grid_unwind(|| {
            let term = self
                .term
                .as_mut()
                .ok_or_else(|| CallError::reason("Terminal disposed"))?;
            // An OSC or ESC the stream ends inside reaches the feed, so its
            // tail ships it (a dropped one refused the snapshot already).
            // A refused join parses nothing: the OSC stays held for the next
            // snapshot.
            if self.osc.scan == OscScan::Osc {
                self.feed.feed(&mut self.parser, term, &self.osc.held)?;
                self.osc.clear_open();
                if self.feed.divergent && self.refusal.is_none() {
                    self.refusal = self.feed.refused;
                }
                if let Some(failed) = self.feed.alloc_failed.take() {
                    return Err(failed.into());
                }
            }
            // An unfinished sequence is part of the stream: parse it, then ship it.
            self.parser.advance(term, &self.feed.held);
            // Bytes held in a synchronized update count for the checks below.
            let synchronized = self.parser.sync_timeout().pending_timeout();
            self.parser.stop_sync(term);
            let payload = (|| -> CallResult<Vec<u8>> {
                // xterm still shows the blank alternate screen; Alacritty the main.
                if self.feed.round_trip && self.refusal.is_none() {
                    self.feed.refuse(true, OPEN_ROUND_TRIP);
                    self.refusal = Some(OPEN_ROUND_TRIP);
                }
                if let Some(refusal) = self.refusal {
                    return Err(CallError::reason(refusal));
                }
                if self.feed.alt_reflow {
                    return Err(CallError::reason(
                    "unsupported-reflow: the alternate screen changed width, which xterm leaves uncut",
                ));
                }
                if requested_scrollback.is_some_and(|requested| requested > self.scrollback)
                    && [term.grid(), term.inactive_grid()]
                        .iter()
                        .any(|grid| grid.history_size() >= self.scrollback as usize)
                {
                    return Err(CallError::reason(
                        "unsupported-history-limit: history reached the native grid cap",
                    ));
                }
                // xterm's SerializeAddon drops margins: both paths replay raw then.
                if self.feed.margins() {
                    return Err(CallError::reason("margins"));
                }
                let tail = self.feed.pending_tail()?;
                let mut result = crate::native_serialize::serialize(term, !self.feed.shifted)?;
                // The modes below (at most 30 bytes: `?100Nh`, `?1016h`, `?2026h`,
                // `?25l`) and the tail, so neither grows the payload infallibly.
                fallible::try_reserve_str(
                    &mut result,
                    tail.len().saturating_add(ANSI_MODES_TAIL),
                    "the ANSI snapshot",
                )?;
                // Mouse protocol and encoding as xterm's modes tail restores them: the
                // encoding only while a protocol is on.
                if self.feed.mouse != 0 {
                    let _ = std::fmt::Write::write_fmt(
                        &mut result,
                        format_args!("\x1b[?{}h", self.feed.mouse),
                    );
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
                Ok(payload)
            })();
            // A failed snapshot leaves the stream inside its synchronized
            // update, as before the call: the held bytes stay applied (they
            // are not parsed twice), and only the mode comes back, so the
            // next snapshot still ends in ?2026h.
            if synchronized && payload.is_err() {
                self.parser.advance(term, b"\x1b[?2026h");
            }
            payload
        });
        self.settle(result)
    }

    /// GRID_REFUSED once a grid allocation was refused.
    fn usable(&self) -> CallResult<()> {
        if self.grid_refused {
            return Err(CallError::reason(GRID_REFUSED));
        }
        Ok(())
    }

    /// The result of a call into the grid (`grid_unwind`). A refused grid
    /// allocation throws ALLOC_FAILED for this call, and the terminal is
    /// dropped: the grid may be half updated. So is its parser, never given
    /// back to the pool (`PooledParser::discard`). The snapshot is refused as
    /// unsupported-alloc, and every later call but `refusalFamilies` and
    /// `dispose` fails with GRID_REFUSED.
    fn settle<R>(
        &mut self,
        result: std::result::Result<CallResult<R>, AllocFailed>,
    ) -> CallResult<R> {
        result.unwrap_or_else(|failed| {
            self.grid_refused = true;
            self.term = None;
            self.parser.discard();
            self.feed.refuse(true, GRID_REFUSED);
            self.refusal.get_or_insert(GRID_REFUSED);
            Err(failed.into())
        })
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
        pty_dimensions(cols, rows)?;
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
        pty_dimensions(cols, rows)?;
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
    pub fn geometry(&self) -> Result<Option<NativeReplayGeometry>, ErrorCode> {
        Ok(replay_geometry(
            &self.geometry,
            self.written_at - self.bytes.len() as u64,
        )?)
    }
    #[napi(catch_unwind)]
    pub fn read_all(&self) -> Result<Buffer, ErrorCode> {
        Ok(self.copy_bytes()?.into())
    }
    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.bytes = Vec::new();
        self.geometry.clear();
    }
}
impl NativeFrozenRing {
    fn copy_bytes(&self) -> std::result::Result<Vec<u8>, AllocFailed> {
        // Bounded by the ring it was frozen from (256 MiB).
        fallible::try_copy(&self.bytes, RING_COPY)
    }
}
/// A copy of a ring's bytes (at most its 256 MiB capacity).
const RING_COPY: &str = "a copy of the output ring";
/// The ring's geometry marks: at most MAX_GEOMETRY_MARKS.
const GEOMETRY: &str = "the output ring's geometry marks";
/// The most geometry marks a ring keeps (prune_geometry), one more while a
/// new mark is pruned.
const MAX_GEOMETRY_MARKS: usize = 256;

fn replay_geometry(
    marks: &[GeometryMark],
    start: u64,
) -> std::result::Result<Option<NativeReplayGeometry>, AllocFailed> {
    let Some(first) = marks.first() else {
        return Ok(None);
    };
    // At most MAX_GEOMETRY_MARKS.
    let mut changes = fallible::try_with_capacity(marks.len() - 1, GEOMETRY)?;
    changes.extend(marks.iter().skip(1).map(|m| NativeGeometryChange {
        offset: (m.at - start) as f64,
        cols: m.cols,
        rows: m.rows,
    }));
    Ok(Some(NativeReplayGeometry {
        start: NativeGeometrySize {
            cols: first.cols,
            rows: first.rows,
        },
        changes,
    }))
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
    pub fn new(capacity: u32) -> Result<Self, ErrorCode> {
        Ok(Self::create(capacity)?)
    }

    #[napi(catch_unwind)]
    pub fn write(&mut self, bytes: Uint8Array) -> Result<(), ErrorCode> {
        Ok(self.write_bytes(&bytes)?)
    }

    #[napi(catch_unwind)]
    pub fn write_chunk(&mut self, chunk: &NativeOutputChunk) -> Result<(), ErrorCode> {
        Ok(self.write_bytes(&chunk.bytes)?)
    }

    #[napi(catch_unwind)]
    pub fn read_all(&self) -> Result<Buffer, ErrorCode> {
        Ok(self.copy_bytes()?.into())
    }

    #[napi(catch_unwind)]
    pub fn freeze(&mut self) -> Result<NativeFrozenRing, ErrorCode> {
        Ok(self.freeze_copy()?)
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
    pub fn note_geometry(
        &mut self,
        cols: u32,
        rows: u32,
        applied: Option<bool>,
    ) -> Result<(), ErrorCode> {
        Ok(self.note_geometry_mark(cols, rows, applied)?)
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
    pub fn read_all_with_geometry(&mut self) -> Result<NativeRingSnapshot, ErrorCode> {
        let (data, geometry) = self.copy_with_geometry()?;
        Ok(NativeRingSnapshot {
            data: data.into(),
            written_at: self.total_written as f64,
            geometry,
        })
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
    fn create(capacity: u32) -> CallResult<Self> {
        if capacity == 0 || capacity > 256 * 1024 * 1024 {
            return Err(CallError::reason("Ring capacity must be 1..256MiB"));
        }
        // The first 64 KiB; writes grow it up to the capacity (write_bytes).
        let initial = (capacity as usize).min(64 * 1024);
        let mut bytes = fallible::try_with_capacity(initial, "the output ring")?;
        bytes.resize(initial, 0);
        Ok(Self {
            bytes,
            capacity: capacity as usize,
            length: 0,
            write_pos: 0,
            total_written: 0,
            geometry: Vec::new(),
            geometry_tail_provisional: false,
        })
    }

    fn freeze_copy(&mut self) -> std::result::Result<NativeFrozenRing, AllocFailed> {
        self.prune_geometry();
        // At most MAX_GEOMETRY_MARKS after the prune.
        let mut geometry = fallible::try_with_capacity(self.geometry.len(), GEOMETRY)?;
        geometry.extend_from_slice(&self.geometry);
        Ok(NativeFrozenRing {
            bytes: self.copy_bytes()?,
            geometry,
            written_at: self.total_written,
        })
    }

    fn note_geometry_mark(
        &mut self,
        cols: u32,
        rows: u32,
        applied: Option<bool>,
    ) -> CallResult<()> {
        if self.capacity == 0 {
            return Err(CallError::reason("Ring disposed"));
        }
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        // Room for the mark pushed below, before anything changes: at most
        // MAX_GEOMETRY_MARKS + 1 before its prune.
        fallible::try_reserve(&mut self.geometry, 1, GEOMETRY)?;
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

    /// The retained bytes and their geometry (`readAllWithGeometry`).
    fn copy_with_geometry(
        &mut self,
    ) -> std::result::Result<(Vec<u8>, Option<NativeReplayGeometry>), AllocFailed> {
        self.prune_geometry();
        let start = self.total_written - self.length as u64;
        let geometry = replay_geometry(&self.geometry, start)?;
        Ok((self.copy_bytes()?, geometry))
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> CallResult<()> {
        if self.capacity == 0 {
            return Err(CallError::reason("Ring disposed"));
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let next_total = self
            .total_written
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or_else(|| CallError::reason("Ring byte offset exceeds JS safe integer range"))?;
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
            // At most the capacity (256 MiB); a refusal leaves the ring as it was.
            let additional = next - self.bytes.len();
            fallible::try_reserve_exact(&mut self.bytes, additional, "the output ring")?;
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

    /// The retained bytes, oldest first: at most the capacity (256 MiB).
    fn copy_bytes(&self) -> std::result::Result<Vec<u8>, AllocFailed> {
        if self.length == 0 {
            return Ok(Vec::new());
        }
        let start = if self.length < self.bytes.len() {
            0
        } else {
            self.write_pos
        };
        let tail = self.length.min(self.bytes.len() - start);
        let mut result = fallible::try_with_capacity(self.length, RING_COPY)?;
        result.extend_from_slice(&self.bytes[start..start + tail]);
        result.extend_from_slice(&self.bytes[..self.length - tail]);
        Ok(result)
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
        if self.geometry.len() > MAX_GEOMETRY_MARKS {
            let excess = self.geometry.len() - MAX_GEOMETRY_MARKS;
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
        feed.feed(&mut parser, &mut term, chunk).unwrap();
    }
    parser.advance(&mut term, &feed.held);
    (term, feed.divergent)
}

#[cfg(test)]
mod tests {
    use super::{Size, XtermFeed};
    use crate::fallible::CallError;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Processor, Timeout};

    fn feed_with(chunks: &[&str]) -> (Term<VoidListener>, Processor, XtermFeed) {
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        for chunk in chunks {
            feed.feed(&mut parser, &mut term, chunk.as_bytes()).unwrap();
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
        assert!(feed.seen.contains("unsupported-state-restore-row"));
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
        feed.scan(b"\x1b]0;\x1b[53m title\x07\x1b[5").unwrap();
        feed.scan(b"3m\x1b[!\x7fp\xc2\x9b31m").unwrap();
        // A restore needs the screen's state: not seen by the scan. Neither
        // does a ContextRule control, nor text inside a round trip.
        feed.scan(b"\x1b7\x1b*0\x1b8").unwrap();
        feed.scan(b"\x1b[?47hx\x1b[?47l\x1b[?1047l\x1b[?9l")
            .unwrap();
        assert_eq!(
            feed.seen.as_slice(),
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
        let seen = |chunks: &[&str]| feed_with(chunks).2.seen.as_slice().to_vec();
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
            feed.seen.as_slice(),
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
            CallError::reason("partial-tail-overflow")
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
            feed.feed(&mut parser, &mut term, b"\x1b[?1049h").unwrap();
            feed.alt_reflow = true;
            for chunk in chunks {
                feed.feed(&mut parser, &mut term, chunk.as_bytes()).unwrap();
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
            super::advance_indexing(&mut parser, &mut term, &mut held, chunk).unwrap();
        }
        assert!(term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // DEL inside, split after it: both parsers ignore DEL there.
        for chunk in [para.as_bytes(), b"\x1b\x7f", b"D"] {
            super::advance_indexing(&mut parser, &mut term, &mut held, chunk).unwrap();
        }
        assert!(held.is_empty());
        assert!(term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // An ESC followed by an endless run of C0 controls and DEL, a few
        // bytes per feed: the held bytes stay under the cap, so each feed
        // rescans at most that much, and the run reaches the parser.
        super::advance_indexing(&mut parser, &mut term, &mut held, b"\x1b").unwrap();
        let mut most = 0;
        for i in 0..100_000 {
            let chunk: &[u8] = if i % 2 == 0 { b"\x00\x7f\x07" } else { b"\x7f" };
            super::advance_indexing(&mut parser, &mut term, &mut held, chunk).unwrap();
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
        super::advance_indexing(&mut parser, &mut term, &mut held, b"\x1b[1;1H\n").unwrap();
        assert!(!term.grid()[Line(0)][Column(9)]
            .flags
            .contains(Flags::WRAPLINE));
        // An auto-wrap below a scroll region keeps its wrap.
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 5 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        feed.feed(&mut parser, &mut term, b"\x1b[1;2r\x1b[4;1Hxxxxxxxxxxxxxxx")
            .unwrap();
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
        feed.feed(&mut parser, &mut term, start.as_bytes()).unwrap();
        for step in steps {
            match step {
                Out(bytes) => feed.feed(&mut parser, &mut term, bytes.as_bytes()).unwrap(),
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

#[cfg(test)]
mod narrowed_saved_history_tests {
    use super::narrowed_saved_history;
    use alacritty_terminal::grid::Grid;
    use alacritty_terminal::index::Line;
    use alacritty_terminal::term::cell::Cell;

    /// An 8-row grid with no history, its saved row on `line`, after a
    /// narrowing that added `added` rows.
    fn grid(line: i32, added: usize) -> Grid<Cell> {
        let mut grid = Grid::<Cell>::new(8, 10, 2);
        grid.saved_cursor.point.line = Line(line);
        grid.narrowing_added = added;
        grid
    }

    #[test]
    fn carries_every_added_row() {
        // The row stayed on 2 while 3 rows were added, none kept in the
        // history: absolute row 2 + 3 = 5, above the last row.
        assert_eq!(narrowed_saved_history(&grid(2, 3), 0, 2), 3);
    }

    #[test]
    fn carries_the_rows_clipped_at_the_last_row() {
        // From row 6, 2 rows kept above clipped it at 7: absolute row
        // -2 + 6 + 2 = 6, screen row 6; the clamp (row 7) does not bind.
        assert_eq!(narrowed_saved_history(&grid(7, 2), -2, 6), -1);
    }

    #[test]
    fn clamps_to_the_last_row() {
        // Row 5 + 9 added would pass row 7.
        assert_eq!(narrowed_saved_history(&grid(5, 9), 0, 5), 2);
        // xterm clamps on every reflowed narrowing, trimmed rows or not.
        assert_eq!(narrowed_saved_history(&grid(6, 2), 3, 6), 1);
    }
}

/// Refused allocations (#3440): each call reports ALLOC_FAILED and the object
/// stays consistent and usable.
#[cfg(test)]
mod alloc_failure_tests {
    use super::*;
    use crate::fallible::CallError;
    use crate::fallible::{fail_from, fail_what, ALLOC_FAILED};

    fn assert_alloc_failed<E: Into<CallError>>(error: Option<E>) {
        let error: CallError = error.expect("the call is refused").into();
        assert!(matches!(error, CallError::Alloc(_)), "{error:?}");
        assert!(error.message().starts_with(ALLOC_FAILED), "{error:?}");
    }

    fn terminal() -> NativeTerminal {
        NativeTerminal::create(20, 4, 100).unwrap()
    }

    fn text(terminal: &mut NativeTerminal) -> Vec<String> {
        let snapshot = terminal.text_snapshot_rows(false).ok().unwrap();
        snapshot.rows.into_iter().map(|row| row.text).collect()
    }

    #[test]
    fn a_refused_ring_copy_is_an_error_and_the_ring_reads_back_after() {
        let mut ring = NativeRing::create(1024).unwrap();
        ring.write_bytes(b"hello ring").unwrap();
        ring.note_geometry_mark(80, 24, None).unwrap();
        {
            let _fail = fail_from(10);
            assert_alloc_failed(ring.copy_bytes().err());
            assert_alloc_failed(ring.freeze_copy().err());
            assert_alloc_failed(ring.copy_with_geometry().err());
        }
        assert_eq!(&ring.copy_bytes().unwrap()[..], b"hello ring");
        let frozen = ring.freeze_copy().ok().unwrap();
        {
            let _fail = fail_from(10);
            assert_alloc_failed(frozen.copy_bytes().err());
        }
        assert_eq!(&frozen.copy_bytes().unwrap()[..], b"hello ring");
        let (data, geometry) = ring.copy_with_geometry().ok().unwrap();
        assert_eq!(data, b"hello ring");
        assert_eq!(geometry.map(|g| g.start.cols), Some(80));
    }

    #[test]
    fn a_refused_ring_growth_leaves_the_ring_as_it_was() {
        {
            let _fail = fail_from(64 * 1024);
            assert_alloc_failed(NativeRing::create(1 << 20).err());
        }
        let mut ring = NativeRing::create(1 << 20).unwrap();
        ring.write_bytes(&[1; 1000]).unwrap();
        {
            // Growth past the first 64 KiB asks for 128 KiB.
            let _fail = fail_from(128 * 1024);
            assert_alloc_failed(ring.write_bytes(&[2; 70 * 1024]).err());
        }
        assert_eq!(ring.size(), 1000);
        assert_eq!(ring.total_bytes_written(), 1000.0);
        assert_eq!(&ring.copy_bytes().unwrap()[..], &[1; 1000][..]);
        ring.write_bytes(&[2; 70 * 1024]).unwrap();
        assert_eq!(ring.size() as usize, 1000 + 70 * 1024);
    }

    #[test]
    fn a_refused_geometry_mark_changes_nothing() {
        let mut ring = NativeRing::create(1024).unwrap();
        {
            let _fail = fail_from(1);
            assert_alloc_failed(ring.note_geometry_mark(80, 24, Some(false)).err());
        }
        assert!(!ring.geometry_tail_provisional());
        ring.note_geometry_mark(80, 24, None).unwrap();
        assert_eq!(ring.geometry.len(), 1);
    }

    #[test]
    fn a_refused_text_feed_join_parses_nothing_and_keeps_the_held_escape() {
        let mut terminal = terminal();
        terminal.feed_bytes(b"ab\x1b").unwrap();
        assert_eq!(terminal.text_held, b"\x1b");
        {
            let _fail = fail_from(1);
            assert_alloc_failed(terminal.feed_bytes(b"Dcd").err());
        }
        assert_eq!(terminal.text_held, b"\x1b", "the held ESC survived");
        // ESC D is IND, as one sequence across the two feeds.
        terminal.feed_bytes(b"Dcd").unwrap();
        assert_eq!(text(&mut terminal), ["ab", "  cd"]);
    }

    #[test]
    fn a_refused_ansi_feed_join_parses_nothing() {
        let mut terminal = terminal();
        {
            let _fail = fail_from(1);
            assert_alloc_failed(terminal.feed_xterm_bytes(b"hello", 100).err());
        }
        assert!(terminal.refusal.is_none());
        assert!(text(&mut terminal).is_empty());
        terminal.feed_xterm_bytes(b"hello", 100).unwrap();
        assert_eq!(text(&mut terminal), ["hello"]);
        assert!(terminal.ansi_snapshot_bytes(None).is_ok());
    }

    #[test]
    fn a_buffer_refused_partway_through_an_ansi_feed_refuses_the_snapshot() {
        let mut terminal = terminal();
        terminal.feed_xterm_bytes(b"ok", 100).unwrap();
        // A DCS: an open OSC is held before the feed (OscCap).
        let osc = [b"\x1bPq".as_slice(), &[b'x'; 297]].concat();
        {
            // The 300-byte join fits; the pending string's growth to 512 does not.
            let _fail = fail_from(512);
            assert_alloc_failed(terminal.feed_xterm_bytes(&osc, 100).err());
        }
        assert_eq!(terminal.refusal, Some(ALLOC_REFUSED));
        assert_eq!(terminal.families(), ["unsupported-alloc"]);
        assert_eq!(
            terminal.ansi_snapshot_bytes(None).err().unwrap().message(),
            ALLOC_REFUSED
        );
        // The terminal goes on: the scan past the refusal, and its text.
        assert!(!terminal.feed_xterm_bytes(b"\x07more", 100).unwrap());
        assert_eq!(text(&mut terminal), ["ok"]);
    }

    #[test]
    fn a_refused_text_snapshot_is_an_error_and_the_next_one_reads() {
        let mut terminal = terminal();
        terminal.feed_bytes(b"line one\r\nline two").unwrap();
        {
            let _fail = fail_from(1);
            assert_alloc_failed(terminal.text_snapshot_rows(false).err());
        }
        assert_eq!(text(&mut terminal), ["line one", "line two"]);
    }

    #[test]
    fn a_text_row_trims_in_place_as_before() {
        let mut terminal = terminal();
        terminal
            .feed_bytes("a b  \r\n\x1b[2mdim\x1b[0m e\u{301} \u{3000}".as_bytes())
            .unwrap();
        let rows = terminal.text_snapshot_rows(true).ok().unwrap().rows;
        assert_eq!(rows[0].text, "a b");
        assert_eq!(rows[1].text, "dim e\u{301} \u{3000}");
        assert_eq!(rows[1].undimmed.as_deref(), Some("    e\u{301}"));
    }

    #[test]
    fn a_refused_ansi_snapshot_is_an_error_and_the_next_one_replays() {
        let mut terminal = terminal();
        terminal
            .feed_xterm_bytes(b"\x1b[31mred\x1b[0m plain", 100)
            .unwrap();
        let payload = terminal.ansi_snapshot_bytes(None).unwrap().to_vec();
        {
            let _fail = fail_from(1);
            assert_alloc_failed(terminal.ansi_snapshot_bytes(None).err());
        }
        assert_eq!(
            terminal.ansi_snapshot_bytes(None).unwrap().to_vec(),
            payload
        );
    }

    #[test]
    fn a_refused_pending_tail_is_an_error_and_the_next_snapshot_ships_it() {
        let mut terminal = terminal();
        terminal.feed_xterm_bytes(b"ab\x1b]0;tit", 100).unwrap();
        {
            let _fail = fail_from(1);
            assert_alloc_failed(terminal.ansi_snapshot_bytes(None).err());
        }
        let payload = terminal.ansi_snapshot_bytes(None).unwrap();
        assert!(payload.ends_with(b"\x1b]0;tit"));
    }

    #[test]
    fn a_failed_ansi_snapshot_keeps_the_synchronized_update_for_the_next() {
        let stream: &[u8] = b"ab\x1b[?2026hcd";
        let mut once = terminal();
        once.feed_xterm_bytes(stream, 100).unwrap();
        let expected = once.ansi_snapshot_bytes(None).unwrap();
        assert!(expected.windows(8).any(|w| w == b"\x1b[?2026h"));
        let mut terminal = terminal();
        terminal.feed_xterm_bytes(stream, 100).unwrap();
        {
            let _fail = fail_what("the ANSI snapshot");
            assert_alloc_failed(terminal.ansi_snapshot_bytes(None).err());
        }
        assert_eq!(terminal.ansi_snapshot_bytes(None).unwrap(), expected);
        assert_eq!(text(&mut terminal), ["abcd"], "the held bytes parsed once");
    }

    #[test]
    fn a_refused_initial_ring_buffer_is_an_error() {
        {
            let _fail = fail_what("the output ring");
            assert_alloc_failed(NativeRing::create(1024).err());
        }
        let mut ring = NativeRing::create(1024).unwrap();
        ring.write_bytes(b"after").unwrap();
        assert_eq!(ring.copy_bytes().unwrap(), b"after");
    }

    #[test]
    fn a_refused_copy_of_a_control_with_c0_inside_refuses_the_snapshot() {
        for what in [TRACKED_C0, crate::native_serialize::WITHOUT_C0] {
            let mut terminal = terminal();
            terminal.feed_xterm_bytes(b"ok", 100).unwrap();
            {
                let _fail = fail_what(what);
                assert_alloc_failed(terminal.feed_xterm_bytes(b"\x1b[3\x081m", 100).err());
            }
            assert_eq!(terminal.refusal, Some(ALLOC_REFUSED), "{what}");
            assert_eq!(terminal.families(), ["unsupported-alloc"]);
            assert!(!terminal.feed_xterm_bytes(b"more", 100).unwrap());
            assert_eq!(text(&mut terminal), ["ok"]);
        }
    }

    #[test]
    fn a_control_the_classifier_cannot_copy_reads_as_an_allocation_refusal() {
        use crate::native_serialize::{divergent, refusal, try_divergent, WITHOUT_C0};
        let _fail = fail_what(WITHOUT_C0);
        assert!(try_divergent(b"\x1b[3\x081m").is_err());
        assert_eq!(refusal(b"\x1b[3\x081m"), ALLOC_REFUSED);
        assert!(
            !divergent(b"\x1b[31m"),
            "a control without C0 inside is not copied"
        );
    }

    #[test]
    fn resets_1049_reads_a_control_with_c0_inside_in_place() {
        assert_eq!(resets_1049(b"\x1b[?1049l"), Some(true));
        assert_eq!(resets_1049(b"\x1b[?10\x0849l"), Some(true));
        assert_eq!(resets_1049(b"\x1b[?01049l"), Some(true));
        assert_eq!(resets_1049(b"\x1b[?1;1049l"), Some(false));
        assert_eq!(resets_1049(b"\x1b[?1049;l"), Some(false));
        assert_eq!(resets_1049(b"\x1b[?1049h"), None);
        assert_eq!(resets_1049(b"\x1b[?1047l"), None);
        assert_eq!(resets_1049(b"\x1b[?l"), None);
        assert_eq!(resets_1049(b"\x1b[?;l"), None);
        assert_eq!(resets_1049(b"\x1b[?104l9l"), None);
        assert_eq!(resets_1049(b"\x1b[1049l"), None);
        assert_eq!(resets_1049(b"\x1b[?1049:1l"), None);
        assert_eq!(resets_1049(b"\x1b"), None);
    }
}

#[cfg(test)]
mod grid_refusal_tests {
    use super::*;
    use crate::fallible::CallError;
    use crate::fallible::ALLOC_FAILED;
    use alacritty_terminal::wmux_alloc::{fail_what, DAMAGE, LINES, REFLOW, ROW, TABS};

    /// One row of 205 cells (24 bytes each): the size of the abort the
    /// capped series met.
    const ROW_205: &str = "ALLOC_FAILED: could not allocate 4920 bytes for a grid row";

    /// The call threw `seam`; the terminal is dropped, the snapshot refused
    /// as unsupported-alloc, and every later call fails with GRID_REFUSED.
    fn assert_grid_refused(terminal: &mut NativeTerminal, error: Option<CallError>, seam: &str) {
        let error = error.expect("the call is refused");
        assert!(matches!(error, CallError::Alloc(_)), "{error:?}");
        assert_eq!(error.message(), seam);
        assert!(terminal.term.is_none(), "the terminal is dropped");
        assert_eq!(terminal.families(), ["unsupported-alloc"]);
        let later = [
            terminal.feed_bytes(b"x").err(),
            terminal.feed_xterm_bytes(b"x", 100).err(),
            terminal.resize_grid(30, 5).err(),
            terminal.text_snapshot_rows(false).err(),
            terminal.ansi_snapshot_bytes(None).err(),
        ];
        for error in later {
            assert_eq!(error.expect("refused").message(), GRID_REFUSED);
        }
        terminal.dispose();
    }

    #[test]
    fn a_refused_grid_in_new_is_an_error() {
        for what in [LINES, ROW, TABS, DAMAGE] {
            let _fail = fail_what(what);
            let error = NativeTerminal::create(205, 24, 100).err().expect("refused");
            assert!(
                error.message().starts_with(ALLOC_FAILED),
                "{}",
                error.message()
            );
            assert!(
                error.message().ends_with(&format!("bytes for {what}")),
                "{}",
                error.message()
            );
        }
        let _fail = fail_what(ROW);
        assert_eq!(
            NativeTerminal::create(205, 24, 100)
                .err()
                .unwrap()
                .message(),
            ROW_205
        );
        drop(_fail);
        assert!(NativeTerminal::create(205, 24, 100).is_ok());
    }

    #[test]
    fn a_refused_row_drops_the_terminal() {
        let mut terminal = NativeTerminal::create(20, 4, 100).unwrap();
        terminal.feed_bytes(b"hello").unwrap();
        let error = {
            let _fail = fail_what(ROW);
            terminal.resize_grid(205, 4).err()
        };
        assert_grid_refused(&mut terminal, error, ROW_205);
    }

    #[test]
    fn a_refused_history_growth_drops_the_terminal() {
        let mut terminal = NativeTerminal::create(20, 4, 100).unwrap();
        let error = {
            let _fail = fail_what(LINES);
            terminal
                .feed_xterm_bytes(b"1\r\n2\r\n3\r\n4\r\n5", 100)
                .err()
        };
        // The history grows by 1000 rows at once, past the screen's 4.
        let seam = "ALLOC_FAILED: could not allocate 48192 bytes for the grid's lines";
        assert_grid_refused(&mut terminal, error, seam);
    }

    #[test]
    fn a_refused_reflow_drops_the_terminal() {
        let mut terminal = NativeTerminal::create(20, 4, 100).unwrap();
        terminal.feed_bytes(b"hello").unwrap();
        let error = {
            let _fail = fail_what(REFLOW);
            terminal.resize_grid(10, 4).err()
        };
        // The rows laid out again: the 4 on screen.
        let seam = "ALLOC_FAILED: could not allocate 192 bytes for a grid reflow";
        assert_grid_refused(&mut terminal, error, seam);
    }

    #[test]
    fn a_panic_other_than_a_refusal_goes_on() {
        let payload = std::panic::catch_unwind(|| grid_unwind(|| std::panic::panic_any(7u8)));
        assert_eq!(payload.err().unwrap().downcast_ref::<u8>(), Some(&7));
    }

    /// The real allocator refusing, not the injection: every allocation of at
    /// least 4 KiB on this thread fails, as one did in the capped series.
    #[test]
    fn a_refused_grid_row_is_alloc_failed_not_an_abort() {
        let mut terminal = NativeTerminal::create(80, 24, 0).unwrap();
        let error = test_allocator::refusing(4096, || terminal.resize_grid(205, 24).err());
        assert_eq!(error.expect("refused").message(), ROW_205);
        assert!(terminal.term.is_none());
    }
}

#[cfg(test)]
mod seam_message_tests {
    use super::*;
    use crate::fallible::{refill_spare, ALLOC_FAILED};

    const ROW_205: &str = "ALLOC_FAILED: could not allocate 4920 bytes for a grid row";

    #[test]
    fn a_seam_message_after_a_refusal_asks_the_allocator_for_nothing() {
        let failed = AllocFailed {
            what: "a grid row",
            bytes: 4920,
        };
        refill_spare();
        let message = test_allocator::refusing(1, || failed.message());
        assert_eq!(test_allocator::refused(), 0, "written into the spare");
        assert_eq!(message, ROW_205);
        // No spare now, and none to be had: the prefix alone, or nothing.
        let prefix = test_allocator::refusing(ALLOC_FAILED.len() + 1, || failed.message());
        assert_eq!(prefix, ALLOC_FAILED);
        assert_eq!(test_allocator::refusing(1, || failed.message()), "");
        // With memory back, the exact message, and a fallible allocation
        // that succeeds gives the thread its spare again.
        assert_eq!(failed.message(), ROW_205);
        drop(fallible::try_with_capacity::<u8>(1, "a test buffer").unwrap());
        assert_eq!(test_allocator::refusing(1, || failed.message()), ROW_205);
        assert_eq!(test_allocator::refused(), 0);
    }

    #[test]
    fn a_refusal_family_is_kept_without_allocating() {
        let mut feed = XtermFeed::default();
        test_allocator::refusing(1, || {
            feed.refuse(true, GRID_REFUSED);
            feed.refuse(true, ALLOC_REFUSED);
            feed.refuse(true, GRID_REFUSED);
        });
        assert_eq!(test_allocator::refused(), 0);
        assert_eq!(feed.seen.as_slice(), ["unsupported-alloc"]);
        assert_eq!(feed.refused, Some(GRID_REFUSED));
        // Past its room, a family is dropped, never grown into.
        let mut families = Families::default();
        for n in 0..=MAX_FAMILIES {
            families.add(["a", "b"][n % 2]);
        }
        assert_eq!(families.as_slice(), ["a", "b"]);
    }

    /// The MSVC unwinder allocates nothing (vendor `wmux_alloc`), so every
    /// allocation of 64 bytes or more can be refused across the whole
    /// call; the Itanium unwinder allocates its exception header.
    #[cfg(all(windows, target_env = "msvc"))]
    #[test]
    fn a_fresh_terminal_s_grid_refusal_returns_alloc_failed_without_aborting() {
        let mut terminal = NativeTerminal::create(80, 24, 0).unwrap();
        refill_spare();
        let error = test_allocator::refusing(64, || terminal.resize_grid(205, 24).err());
        assert!(matches!(error, Some(CallError::Alloc(_))), "{error:?}");
        assert_eq!(terminal.families(), ["unsupported-alloc"]);
        assert_eq!(
            terminal.feed_bytes(b"x"),
            Err(CallError::reason(GRID_REFUSED))
        );
    }

    #[test]
    fn a_refusal_keeps_its_code_when_its_message_cannot_be_built() {
        let failed = AllocFailed {
            what: "a grid row",
            bytes: 4920,
        };
        // Taken outside the refusal: a thread's first use of its spare
        // can allocate to register the buffer's destructor.
        refill_spare();
        let (code, message) = test_allocator::refusing(1, || {
            // The spare goes to the first message, then nothing more is had.
            drop(failed.message());
            CallError::Alloc(failed).into_js()
        });
        assert_eq!(message, "", "the diagnostic is lost");
        assert_eq!(code, ErrorCode::AllocFailed);
        assert_eq!(code.as_ref(), "ALLOC_FAILED", "the classification is not");
        // With memory back, the message is whole again.
        let (code, message) = CallError::Alloc(failed).into_js();
        assert_eq!((code.as_ref(), message.as_str()), ("ALLOC_FAILED", ROW_205));
        // Any other error keeps napi's code.
        let (code, message) = CallError::reason("Terminal disposed").into_js();
        assert_eq!(
            (code.as_ref(), message.as_str()),
            ("GenericFailure", "Terminal disposed")
        );
    }

    #[test]
    fn a_grid_refusal_reaches_its_caller_with_the_full_message_under_refusal() {
        let mut terminal = NativeTerminal::create(80, 24, 0).unwrap();
        refill_spare();
        let error = test_allocator::refusing(4096, || terminal.resize_grid(205, 24).err());
        assert_eq!(
            error.expect("refused"),
            CallError::Alloc(AllocFailed {
                what: "a grid row",
                bytes: 4920,
            })
        );
    }
}

#[cfg(test)]
mod parser_pool_tests {
    use super::*;
    use alacritty_terminal::term::test::TermSize;

    /// vte's synchronized-update buffer (ansi.rs SYNC_BUFFER_SIZE).
    const SYNC_BUFFER: usize = 2 * 1024 * 1024;

    /// `f` on a thread of its own: its processors are its own.
    fn on_new_thread<R: Send>(f: impl FnOnce() -> R + Send) -> R {
        std::thread::scope(|scope| scope.spawn(f).join().unwrap())
    }

    #[test]
    fn a_parser_dropped_during_any_unwind_is_not_pooled() {
        on_new_thread(|| {
            let terminal = NativeTerminal::create(80, 24, 100).unwrap();
            assert_eq!(parsers::idle(), 0);
            // Not a grid refusal: any unwind that drops the terminal.
            let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _terminal = terminal;
                std::panic::resume_unwind(Box::new("a test unwind"));
            }));
            assert!(unwound.is_err());
            assert_eq!(parsers::idle(), 0, "dropped, not given back");
            // Dropped outside an unwind, a terminal's parser is kept.
            drop(NativeTerminal::create(80, 24, 100).unwrap());
            assert_eq!(parsers::idle(), 1);
        });
    }

    #[test]
    fn a_warmed_thread_builds_its_parser_at_the_warm() {
        let (at_warm, after) = on_new_thread(|| {
            let ((), at_warm) = test_allocator::counting(SYNC_BUFFER, || {
                warm_terminal_parsers();
                warm_terminal_parsers();
            });
            let ((), after) = test_allocator::counting(SYNC_BUFFER, || {
                let mut terminal = NativeTerminal::create(80, 24, 100).unwrap();
                terminal.feed_bytes(b"hello").unwrap();
                terminal.dispose();
                warm_terminal_parsers();
                NativeTerminal::create(80, 24, 100).unwrap().dispose();
            });
            assert_eq!(parsers::idle(), 1);
            (at_warm, after)
        });
        assert_eq!(at_warm, 1, "the warm builds one, once");
        assert_eq!(after, 0, "the terminals take the warmed one");
    }

    #[test]
    fn snapshots_in_a_row_on_one_thread_build_one_parser() {
        let (_, built) = on_new_thread(|| {
            test_allocator::counting(SYNC_BUFFER, || {
                for round in 0..3 {
                    let mut terminal = NativeTerminal::create(80, 24, 100).unwrap();
                    // Disposed or dropped inside a synchronized update.
                    terminal.feed_bytes(b"\x1b[?2026hhello").unwrap();
                    if round == 1 {
                        drop(terminal);
                    } else {
                        terminal.text_snapshot_rows(false).unwrap();
                        terminal.feed_bytes(b"\x1b[?2026hmore").unwrap();
                        terminal.dispose();
                    }
                }
                // A refused grid gives its parser back too.
                let _fail = alacritty_terminal::wmux_alloc::fail_what(
                    alacritty_terminal::wmux_alloc::LINES,
                );
                assert!(NativeTerminal::create(80, 24, 100).is_err());
                drop(_fail);
                NativeTerminal::create(80, 24, 100).unwrap().dispose();
                assert_eq!(parsers::idle(), 1);
            })
        });
        assert_eq!(built, 1, "one 2 MiB buffer for the thread");
    }

    #[test]
    fn a_parser_a_grid_refusal_unwound_is_dropped_not_pooled() {
        use alacritty_terminal::wmux_alloc::{fail_what, LINES};
        on_new_thread(|| {
            // Partway through a synchronized update's replay: vte took its
            // 2 MiB buffer for the replay and never put it back.
            let mut terminal = NativeTerminal::create(20, 4, 100).unwrap();
            terminal
                .feed_bytes(b"\x1b[?2026h1\r\n2\r\n3\r\n4\r\n5")
                .unwrap();
            let error = {
                let _fail = fail_what(LINES);
                terminal.text_snapshot_rows(false).err()
            };
            assert!(matches!(error, Some(CallError::Alloc(_))), "{error:?}");
            terminal.dispose();
            assert_eq!(parsers::idle(), 0, "dropped, not given back");
            // Partway through a character split across feeds: vte's count of
            // its bytes stays behind, past what its reset reads.
            let mut terminal = NativeTerminal::create(20, 4, 100).unwrap();
            terminal.feed_bytes(&[b'x'; 80]).unwrap();
            terminal.feed_bytes(b"\xe4\xb8").unwrap();
            let error = {
                let _fail = fail_what(LINES);
                terminal.feed_bytes(b"\xad").err()
            };
            assert!(matches!(error, Some(CallError::Alloc(_))), "{error:?}");
            terminal.dispose();
            drop(terminal);
            assert_eq!(parsers::idle(), 0);
            // The next terminal builds a parser of its own.
            let ((), built) = test_allocator::counting(SYNC_BUFFER, || {
                NativeTerminal::create(20, 4, 100).unwrap().dispose();
            });
            assert_eq!(built, 1);
            assert_eq!(parsers::idle(), 1);
        });
    }

    #[test]
    fn terminals_alive_at_once_have_parsers_of_their_own() {
        let texts = on_new_thread(|| {
            let mut a = NativeTerminal::create(20, 3, 0).unwrap();
            let mut b = NativeTerminal::create(20, 3, 0).unwrap();
            // Interleaved, each inside its own sequence and update.
            a.feed_bytes(b"\x1b[?2026ha\x1b[3").unwrap();
            b.feed_bytes(b"b\x1b]2;x").unwrap();
            a.feed_bytes(b"1mA\x1b[?2026l").unwrap();
            b.feed_bytes(b"\x07B").unwrap();
            let text = |t: &mut NativeTerminal| -> Vec<String> {
                t.text_snapshot_rows(false)
                    .unwrap()
                    .rows
                    .into_iter()
                    .map(|r| r.text)
                    .collect()
            };
            let texts = (text(&mut a), text(&mut b));
            a.dispose();
            b.dispose();
            assert_eq!(parsers::idle(), 2);
            texts
        });
        assert_eq!(texts, (vec!["aA".to_owned()], vec!["bB".to_owned()]));
    }

    /// A fresh stream through `parser` into a new terminal: its ANSI replay.
    fn replay(parser: &mut Processor) -> String {
        let mut term = Term::new(Config::default(), &TermSize::new(20, 4), VoidListener);
        parser.advance(
            &mut term,
            "\x1b[31mred\x1b[0m \u{e9} \u{d55c}\r\n\x1b]2;t\x07\x1b[?2026hin sync\x1b[?2026l\x1b[3;5Hx\x1b[1;20Hy"
                .as_bytes(),
        );
        parser.stop_sync(&mut term);
        crate::native_serialize::serialize(&term, true)
            .ok()
            .unwrap()
    }

    #[test]
    fn a_reused_parser_reads_a_stream_as_a_new_one() {
        let fresh = on_new_thread(|| replay(&mut Processor::new()));
        let leftovers: [&[u8]; 7] = [
            b"\x1b[3",
            b"\x1b]2;open title",
            b"\xe2\x82",
            b"\x1b[?2026hpending \x1b[31m",
            b"\x1bP1$qm",
            b"\x1b",
            b"plain",
        ];
        for leftover in leftovers {
            let (reused, built) = on_new_thread(|| {
                let mut parser = parsers::take();
                let mut term = Term::new(Config::default(), &TermSize::new(20, 4), VoidListener);
                parser.advance(&mut term, leftover);
                test_allocator::counting(SYNC_BUFFER, || {
                    parsers::give(parser);
                    let mut parser = parsers::take();
                    assert!(!parser.sync_timeout().pending_timeout());
                    assert_eq!(parser.sync_bytes_count(), 0);
                    replay(&mut parser)
                })
            });
            assert_eq!(reused, fresh, "after {leftover:?}");
            assert_eq!(built, 0, "reset and reuse allocate no buffer");
        }
    }
}

#[cfg(test)]
mod osc_cap_tests {
    use super::*;

    fn run(cap: &mut OscCap, feeds: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for feed in feeds {
            cap.scan(feed, &mut |part, _| {
                out.extend_from_slice(part);
                Ok(())
            })
            .unwrap();
        }
        out
    }

    fn passes(feeds: &[&[u8]]) {
        let mut cap = OscCap::default();
        assert_eq!(run(&mut cap, feeds), feeds.concat());
        assert!(!cap.take_dropped());
    }

    fn drops(feeds: &[&[u8]], left: &[u8]) {
        let mut cap = OscCap::default();
        assert_eq!(run(&mut cap, feeds), left);
        assert!(cap.take_dropped());
    }

    fn body(len: usize) -> Vec<u8> {
        vec![b'x'; len]
    }

    #[test]
    fn an_osc_under_the_cap_passes_split_or_whole() {
        passes(&[b"a\x1b]2;ti", b"tle\x07b"]);
        passes(&[b"a\x1b]2;title\x07b"]);
        passes(&[b"a\x1b", b"]2;t", b"", b"itle\x1b\\b"]);
        passes(&[b"\x1b]2;t\x1b", b"\\b"]);
        passes(&[b"a\x1b", b"[31mb"]);
        passes(&[b"a\x1b\x00", b"\x00[31mb"]);
        let max = [b"\x1b]2;".as_slice(), &body(MAX_OSC_BODY - 2), b"\x07z"].concat();
        passes(&[&max]);
        passes(&[&max[..10], &max[10..MAX_OSC_BODY], &max[MAX_OSC_BODY..]]);
    }

    #[test]
    fn a_long_url_passes_unchanged() {
        let url = [
            b"\x1b]8;;https://example.invalid/".as_slice(),
            &body(100 * 1024),
            b"\x07link\x1b]8;;\x07",
        ]
        .concat();
        passes(&[&url]);
        passes(&[&url[..1000], &url[1000..60_000], &url[60_000..]]);
    }

    #[test]
    fn an_osc_past_the_cap_is_dropped_split_or_whole() {
        // Its introducer and a CAN stand in for it (OSC_DROPPED).
        let big = body(MAX_OSC_BODY + 1);
        drops(
            &[&[b"a\x1b]0;".as_slice(), &big, b"\x07b"].concat()],
            b"a\x1b]\x18b",
        );
        let half = body(MAX_OSC_BODY / 2 + 1);
        drops(&[b"a\x1b]0;", &half, &half, b"\x07b"], b"a\x1b]\x18b");
        // Held under the cap, then past it.
        drops(
            &[b"a\x1b]0;", &body(10), &big, b"tail\x07b"],
            b"a\x1b]\x18b",
        );
    }

    #[test]
    fn a_dropped_osc_ends_where_vte_ends_it() {
        let open = [b"\x1b]0;".as_slice(), &body(MAX_OSC_BODY + 1)].concat();
        // ESC \ split across feeds.
        drops(
            &[&[open.as_slice(), b"\x1b"].concat(), b"\\b"],
            b"\x1b]\x18b",
        );
        drops(&[&open, b"\x1b\\b"], b"\x1b]\x18b");
        // Another sequence ends it and is read.
        drops(
            &[&[open.as_slice(), b"\x1b[31mx"].concat()],
            b"\x1b]\x18\x1b[31mx",
        );
        drops(
            &[&[open.as_slice(), b"\x1b"].concat(), b"[31mx"],
            b"\x1b]\x18\x1b[31mx",
        );
        drops(
            &[&[open.as_slice(), b"\x1b"].concat(), b"]2;t\x07x"],
            b"\x1b]\x18\x1b]2;t\x07x",
        );
        // That next OSC is capped too: its ESC went on, its `]` and a CAN
        // stand in for it.
        let next = [&open[1..], b"\x07x"].concat();
        drops(
            &[&[open.as_slice(), b"\x1b"].concat(), &next],
            b"\x1b]\x18\x1b]\x18x",
        );
        // CAN and SUB are executed.
        drops(&[&[open.as_slice(), b"\x18x"].concat()], b"\x1b]\x18\x18x");
        drops(&[&open, b"\x1ax"], b"\x1b]\x18\x1ax");
        // 0x9C is body for vte.
        drops(&[&open, b"\x9c\x07x"], b"\x1b]\x18x");
    }

    #[test]
    fn filler_between_the_esc_and_the_bracket_does_not_hide_an_osc() {
        let big = body(MAX_OSC_BODY + 1);
        drops(
            &[&[b"a\x1b\x00\x7f]0;".as_slice(), &big, b"\x07b"].concat()],
            b"a\x1b\x00\x7f]\x18b",
        );
        // Another ESC, and bytes from 0x80 (0x9D among them), are filler too.
        drops(
            &[&[b"a\x1b\x1b\x9d\xc3]0;".as_slice(), &big, b"\x07b"].concat()],
            b"a\x1b\x1b\x9d\xc3]\x18b",
        );
        // A feed's final ESC and its filler go on, then the `]` and a CAN.
        drops(
            &[b"a\x1b", &[b"\x00]0;".as_slice(), &big, b"\x07b"].concat()],
            b"a\x1b\x00]\x18b",
        );
        drops(
            &[
                b"a\x1b\x00",
                b"\x00",
                &[b"]0;".as_slice(), &big, b"\x07b"].concat(),
            ],
            b"a\x1b\x00\x00]\x18b",
        );
        drops(
            &[b"a\x1b", b"\x1b]0;", &body(10), &big, b"\x07b"],
            b"a\x1b\x1b]\x18b",
        );
    }

    #[test]
    fn a_control_in_a_dropped_osc_opener_is_executed_where_it_stands() {
        // vte executes the LF in its escape state, before the `]`.
        let big = body(MAX_OSC_BODY + 1);
        let stream = [b"a\x1b\n]0;".as_slice(), &big, b"\x07b"].concat();
        let short = screen(&[b"a\x1b\n]0;x\x18b"]);
        assert_eq!(short, ["a", " b"]);
        assert_eq!(screen(&[&stream]), short);
        assert_eq!(
            screen(&[&stream[..2], &stream[2..]]),
            short,
            "after the ESC"
        );
        assert_eq!(screen(&[&stream[..3], &stream[3..]]), short, "after the LF");
        assert_eq!(
            screen(&[&stream[..6], &stream[6..]]),
            short,
            "held, then dropped"
        );
    }

    #[test]
    fn a_refused_prefix_holds_the_osc_after_it_once() {
        let mut cap = OscCap::default();
        let mut refuse = true;
        let mut out = Vec::new();
        let mut emit = |part: &[u8], _: bool| {
            if std::mem::take(&mut refuse) {
                return Err(AllocFailed {
                    what: "a test join",
                    bytes: 1,
                });
            }
            out.extend_from_slice(part);
            Ok(())
        };
        assert!(cap.scan(b"ab\x1b]2;t", &mut emit).is_err());
        assert!(cap.held.is_empty(), "nothing held");
        assert_eq!(cap.scan, OscScan::Text);
        cap.scan(b"ab\x1b]2;t", &mut emit).unwrap();
        assert_eq!(cap.held, b"\x1b]2;t");
        // A refused flush leaves the OSC held as it was.
        let mut refused = |_: &[u8], _: bool| {
            Err(AllocFailed {
                what: "a test join",
                bytes: 1,
            })
        };
        assert!(cap.scan(b"itle\x07c", &mut refused).is_err());
        assert_eq!(cap.held, b"\x1b]2;t");
        assert_eq!(cap.scan, OscScan::Osc);
        let mut out2 = Vec::new();
        cap.scan(b"itle\x07c", &mut |part, _| {
            out2.extend_from_slice(part);
            Ok(())
        })
        .unwrap();
        assert_eq!(out, b"ab");
        assert_eq!(out2, b"\x1b]2;title\x07c");
    }

    /// What `feeds` pass on with the `nth` emit of the last feed refused
    /// once and that feed then fed again; and whether the refused attempt
    /// had passed bytes on first (partially applied).
    fn retried(feeds: &[&[u8]], nth: usize) -> (Vec<u8>, bool) {
        let (last, before) = feeds.split_last().unwrap();
        let mut cap = OscCap::default();
        let mut out = run(&mut cap, before);
        let mut calls = 0;
        let mut advanced = false;
        let refused = cap.scan(last, &mut |part, _| {
            calls += 1;
            if calls == nth {
                return Err(AllocFailed {
                    what: "a test join",
                    bytes: 1,
                });
            }
            advanced = true;
            out.extend_from_slice(part);
            Ok(())
        });
        assert!(refused.is_err(), "emit {nth} refused");
        out.extend(run(&mut cap, &[last]));
        assert!(cap.take_dropped());
        (out, advanced)
    }

    /// How many emits `feeds`' last feed makes, unrefused.
    fn emits(feeds: &[&[u8]]) -> usize {
        let (last, before) = feeds.split_last().unwrap();
        let mut cap = OscCap::default();
        run(&mut cap, before);
        let mut count = 0;
        cap.scan(last, &mut |_, _| {
            count += 1;
            Ok(())
        })
        .unwrap();
        count
    }

    #[test]
    fn a_split_opener_after_a_trailing_esc_is_retried_whole() {
        // The ESC went on with the first feed; the `]` is the next feed's
        // first byte, and the body passes the cap.
        let big = body(MAX_OSC_BODY + 1);
        let tail = [b"]0;".as_slice(), &big, b"\x07after"].concat();
        let feeds: [&[u8]; 2] = [b"x\x1b", &tail];
        let whole = b"x\x1b]\x18after".as_slice();
        drops(&feeds, whole);
        // The first emit (the `]`) refused: nothing changed, so the retry
        // passes what one unrefused feed passes.
        assert_eq!(retried(&feeds, 1), (whole.to_vec(), false));
        // Refused after the `]` went on: it is not passed again (its CAN
        // is owed), and the body stays skipped.
        for nth in 2..=emits(&feeds) {
            assert_eq!(retried(&feeds, nth), (whole.to_vec(), true), "emit {nth}");
        }
    }

    #[test]
    fn a_held_osc_keeps_its_opener_until_the_opener_went_on() {
        // The opener holds an LF, which vte executes in its escape state.
        let big = body(MAX_OSC_BODY + 1);
        let rest = [big.as_slice(), b"\x07b"].concat();
        let feeds: [&[u8]; 2] = [b"a\x1b\n]0;", &rest];
        let whole = b"a\x1b\n]\x18b".as_slice();
        drops(&feeds, whole);
        assert_eq!(retried(&feeds, 1), (whole.to_vec(), false));
        for nth in 2..=emits(&feeds) {
            assert_eq!(retried(&feeds, nth), (whole.to_vec(), true), "emit {nth}");
        }
    }

    /// A terminal's text and refusal families after `feeds` through
    /// feed_xterm, the last one's first join refused once and retried.
    fn xterm_retried(feeds: &[&[u8]], refuse: bool) -> (Vec<String>, Vec<String>) {
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        let (last, before) = feeds.split_last().unwrap();
        for feed in before {
            terminal.feed_xterm_bytes(feed, 0).unwrap();
        }
        if refuse {
            fallible::fail_next(FEED_JOIN, 1);
            assert!(matches!(
                terminal.feed_xterm_bytes(last, 0),
                Err(CallError::Alloc(AllocFailed {
                    what: FEED_JOIN,
                    ..
                }))
            ));
            fallible::fail_next("", 0);
        }
        terminal.feed_xterm_bytes(last, 0).unwrap();
        (text(&mut terminal), terminal.families())
    }

    #[test]
    fn a_terminal_feed_retried_after_its_first_join_reads_as_one_feed() {
        let big = body(MAX_OSC_BODY + 1);
        // A trailing ESC, then `]` and the body.
        let tail = [b"]0;".as_slice(), &big, b"\x07after"].concat();
        let feeds: [&[u8]; 2] = [b"x\x1b", &tail];
        let unrefused = xterm_retried(&feeds, false);
        assert_eq!(unrefused.0, ["xafter"]);
        assert_eq!(unrefused.1, ["unsupported-state-long-sequence"]);
        assert_eq!(xterm_retried(&feeds, true), unrefused);
        // A held OSC with an LF in its opener, dropped by the next feed.
        let rest = [big.as_slice(), b"\x07b"].concat();
        let feeds: [&[u8]; 2] = [b"a\x1b\n]0;", &rest];
        let unrefused = xterm_retried(&feeds, false);
        assert_eq!(unrefused.0, ["a", " b"], "the LF went on");
        assert_eq!(xterm_retried(&feeds, true), unrefused);
    }

    #[test]
    fn c1_controls_open_no_osc_and_0x9c_ends_none() {
        // vte reads 0x9D as a stray UTF-8 byte, which it skips: no OSC opens.
        let big = body(MAX_OSC_BODY + 1);
        passes(&[&[b"a\x9d0;".as_slice(), &big, b"\x07b"].concat()]);
        // Inside an OSC, 0x9C is body.
        passes(&[b"\x1b]2;a\x9cb\x07c"]);
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_bytes(b"a\x9d0;t\x07b").unwrap();
        assert_eq!(text(&mut terminal), ["a0;tb"]);
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_bytes(b"a\x1b]2;t\x9cb\x07c").unwrap();
        assert_eq!(text(&mut terminal), ["ac"]);
    }

    fn text(terminal: &mut NativeTerminal) -> Vec<String> {
        let snapshot = terminal.text_snapshot_rows(false).ok().unwrap();
        snapshot.rows.into_iter().map(|row| row.text).collect()
    }

    #[test]
    fn text_after_a_dropped_osc_reads() {
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_bytes(b"a\x1b]2;").unwrap();
        terminal.feed_bytes(&body(MAX_OSC_BODY)).unwrap();
        terminal.feed_bytes(b"xx\x07hello").unwrap();
        assert_eq!(text(&mut terminal), ["ahello"]);
        // Its ESC ending a feed, which went on before the OSC was dropped.
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_bytes(b"a\x1b").unwrap();
        let rest = [b"]2;".as_slice(), &body(MAX_OSC_BODY), b"\x07hello"].concat();
        terminal.feed_bytes(&rest).unwrap();
        assert_eq!(text(&mut terminal), ["ahello"]);
    }

    /// The screen `feeds` leave, each fed as one call.
    fn screen(feeds: &[&[u8]]) -> Vec<String> {
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        for feed in feeds {
            terminal.feed_bytes(feed).unwrap();
        }
        text(&mut terminal)
    }

    #[test]
    fn a_dropped_osc_leaves_vte_where_an_osc_a_can_ends_leaves_it() {
        let big = body(MAX_OSC_BODY + 1);
        // What vte was inside before the OSC, and what follows its end.
        let befores: [&[u8]; 8] = [
            b"",
            b"ab",
            b"a\x1b",
            b"a\x1b[31",
            b"a\x1b]2;t",
            b"a\x1bP1$q",
            b"a\x1b\x1b",
            b"\xe4\xb8",
        ];
        let ends: [(&[u8], &[u8]); 4] = [
            (b"\x07", b""),
            (b"\x1b\\", b""),
            (b"", b"\x18"),
            (b"", b"\x1a"),
        ];
        for before in befores {
            for (end, executed) in ends {
                let after = [executed, b"cd\x1b[1mz"].concat();
                // The same stream with the OSC short, ended by a CAN.
                let short = screen(&[&[before, b"\x1b]0;x\x18", &after].concat()]);
                let whole = [before, b"\x1b]0;", &big, end, &after].concat();
                assert_eq!(screen(&[&whole]), short, "{before:?} {end:?}");
                // Split: at the OSC's start, in its body, before its end.
                let at = before.len();
                let split = [
                    &whole[..at + 1],
                    &whole[at + 1..at + 9],
                    &whole[at + 9..at + MAX_OSC_BODY],
                    &whole[at + MAX_OSC_BODY..whole.len() - after.len() - end.len()],
                    &whole[whole.len() - after.len() - end.len()..],
                ];
                assert_eq!(screen(&split), short, "split {before:?} {end:?}");
            }
        }
    }

    #[test]
    fn a_dropped_osc_after_another_esc_runs_no_reset() {
        // vte stays in its escape state at the second ESC; the OSC opens
        // after it, and the `c` after its BEL is text, not RIS.
        let big = body(MAX_OSC_BODY + 1);
        let stream = [b"ab\x1b\x1b]0;".as_slice(), &big, b"\x07c"].concat();
        assert_eq!(screen(&[&stream]), ["abc"]);
        assert_eq!(screen(&[b"ab\x1b", &stream[3..]]), ["abc"]);
    }

    #[test]
    fn a_dropped_osc_ends_the_csi_it_interrupts() {
        let big = body(MAX_OSC_BODY + 1);
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal
            .feed_bytes(&[b"a\x1b[31\x1b]0;".as_slice(), &big].concat())
            .unwrap();
        terminal.feed_bytes(b"\x07x").unwrap();
        assert_eq!(text(&mut terminal), ["ax"]);
        let grid = terminal.term.as_ref().unwrap().grid();
        assert_eq!(grid[Line(0)][Column(1)].fg, Cell::default().fg, "not red");
    }

    #[test]
    fn a_dropped_osc_ends_the_osc_before_it() {
        // The short OSC 2 ends at the dropped one's ESC, so the text after
        // it is text, not body growing vte's OSC buffer.
        let big = body(MAX_OSC_BODY + 1);
        let stream = [b"\x1b]2;t\x1b]1337;".as_slice(), &big, b"\x07text"].concat();
        assert_eq!(screen(&[&stream]), ["text"]);
        assert_eq!(
            screen(&[&stream[..6], &stream[6..100], &stream[100..]]),
            ["text"]
        );
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_xterm_bytes(&stream, 0).unwrap();
        assert_eq!(terminal.refusal, Some(LONG_OSC));
        assert_eq!(terminal.families()[0], "unsupported-state-long-sequence");
    }

    #[test]
    fn a_dropped_osc_refuses_the_ansi_snapshot() {
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_xterm_bytes(b"a\x1b]2;", 0).unwrap();
        terminal
            .feed_xterm_bytes(&body(MAX_OSC_BODY + 1), 0)
            .unwrap();
        assert_eq!(terminal.refusal, Some(LONG_OSC));
        assert_eq!(
            terminal.ansi_snapshot_bytes(None).err().unwrap().message(),
            LONG_OSC
        );
    }

    #[test]
    fn a_long_hyperlink_reaches_the_ansi_snapshot() {
        let url = [b"https://example.invalid/".as_slice(), &body(100 * 1024)].concat();
        let stream = [b"\x1b]8;;".as_slice(), &url, b"\x07link\x1b]8;;\x07"].concat();
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_xterm_bytes(&stream[..50_000], 0).unwrap();
        terminal.feed_xterm_bytes(&stream[50_000..], 0).unwrap();
        let payload = terminal.ansi_snapshot_bytes(None).ok().unwrap();
        assert!(payload.windows(url.len()).any(|w| w == url.as_slice()));
    }

    #[test]
    fn a_stream_ending_inside_an_osc_ships_it_in_the_tail() {
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_xterm_bytes(b"a\x1b]2;abc", 0).unwrap();
        let payload = terminal.ansi_snapshot_bytes(None).ok().unwrap();
        assert!(
            payload.ends_with(b"\x1b]2;abc"),
            "{:?}",
            String::from_utf8_lossy(&payload)
        );
        let mut terminal = NativeTerminal::create(20, 3, 0).unwrap();
        terminal.feed_xterm_bytes(b"a\x1b", 0).unwrap();
        let payload = terminal.ansi_snapshot_bytes(None).ok().unwrap();
        assert!(payload.ends_with(b"\x1b"));
    }
}
