//! Opt-in native terminal core: VT state and retained history behind N-API.
//! NativeTransport owns the production PTY; NativePty remains a spike harness.

use crate::native_output::NativeOutputChunk;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, Timeout};
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
        "live-screen-v1".into(),
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

pub(crate) struct Size {
    pub cols: usize,
    pub rows: usize,
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
    /// `feed_xterm` state besides the grid.
    feed: XtermFeed,
    /// Why the ANSI snapshot of this stream cannot match xterm's.
    refusal: Option<&'static str>,
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
pub(crate) struct XtermFeed {
    /// An unfinished escape sequence awaiting its next bytes.
    held: Vec<u8>,
    /// The stream ends inside a string (OSC, DCS, SOS, PM, APC): `tail`
    /// holds it from its introducer, `tail_units` counts it.
    in_string: bool,
    tail: Vec<u8>,
    tail_units: usize,
    tail_overflow: bool,
    /// DECSTBM margins in effect (MarginTracker).
    margins: bool,
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
    /// A live screen's feed (NativeLiveScreen): mode 2026 is stripped, so the
    /// parser never holds bytes back, and taint is recorded.
    live: bool,
    /// Mode 2026 as the stream sets it (a live feed never passes it on).
    sync_mode: bool,
    /// Lifetime offset of the next byte fed.
    offset: u64,
    /// The first reason this grid can't match xterm's.
    taint: Option<Taint>,
    /// The last byte fed was 0xC2 and isn't held: the next feed's first byte
    /// can complete a C1 control with it.
    c1_lead: bool,
}

/// Why a grid can't match xterm's, and the lifetime offset of the byte
/// (or the resize) where that started. Chunking doesn't move it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Taint {
    pub reason: &'static str,
    pub at: u64,
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

/// A DECSET or DECRST naming mode 2026, without it: `?25;2026h` becomes
/// `?25h`, and a sequence naming nothing else becomes nothing. Modes read by
/// number, as xterm reads them. C0 controls inside the sequence execute
/// before its dispatch, so they come first. None for any other sequence.
fn without_sync(sequence: &[u8]) -> Option<Vec<u8>> {
    let body = sequence.strip_prefix(b"\x1b[?")?;
    let mut out: Vec<u8> = body.iter().copied().filter(|&b| b < 0x20).collect();
    let body: Vec<u8> = body.iter().copied().filter(|&b| b >= 0x20).collect();
    let (&last, params) = body.split_last()?;
    if !matches!(last, b'h' | b'l') || !params.iter().all(|&b| b.is_ascii_digit() || b == b';') {
        return None;
    }
    let is_sync = |mode: &&[u8]| {
        std::str::from_utf8(mode)
            .ok()
            .and_then(|m| m.parse::<u16>().ok())
            == Some(2026)
    };
    let modes: Vec<&[u8]> = params.split(|&b| b == b';').collect();
    if !modes.iter().any(is_sync) {
        return None;
    }
    let kept: Vec<&[u8]> = modes.into_iter().filter(|m| !is_sync(m)).collect();
    if !kept.is_empty() {
        out.extend_from_slice(b"\x1b[?");
        out.extend_from_slice(&kept.join(&b';'));
        out.push(last);
    }
    Some(out)
}

/// How many bytes at the end of `data` start a UTF-8 character that isn't
/// finished.
fn unfinished_utf8(data: &[u8]) -> usize {
    for back in 1..=data.len().min(3) {
        let byte = data[data.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let len = match byte {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return 0,
        };
        return if back < len { back } else { 0 };
    }
    0
}

/// String terminators as PartialSequenceTracker reads them: BEL, CAN, SUB,
/// and ESC (ST, or an abort that starts a new sequence).
fn string_end(data: &[u8]) -> Option<usize> {
    data.iter()
        .position(|b| matches!(b, 0x07 | 0x18 | 0x1a | 0x1b))
}

impl XtermFeed {
    /// The feed of a live screen, whose next byte is at lifetime `offset`.
    pub(crate) fn live(offset: u64) -> Self {
        Self {
            live: true,
            offset,
            ..Self::default()
        }
    }

    /// A control Alacritty parses differently, at lifetime offset `at`.
    fn diverge(&mut self, at: u64) {
        self.divergent = true;
        self.taint_at("divergent-control", at);
    }

    /// A resize at lifetime offset `at` scrolled rows xterm keeps on screen.
    pub(crate) fn note_reflow(&mut self, at: u64) {
        self.taint_at("reflow", at);
    }

    /// Keep the earliest taint by offset: a feed finds C1 controls before it
    /// scans its sequences, so the order found isn't the stream's order.
    fn taint_at(&mut self, reason: &'static str, at: u64) {
        if self.taint.is_none_or(|taint| at < taint.at) {
            self.taint = Some(Taint { reason, at });
        }
    }

    /// Count the next byte fed as lifetime offset `offset` (after a lead
    /// that isn't part of the ring).
    pub(crate) fn rebase(&mut self, offset: u64) {
        self.offset = offset;
    }

    pub(crate) fn taint(&self) -> Option<Taint> {
        self.taint
    }

    /// The unfinished sequence waiting for its next bytes (at most MAX_HELD).
    pub(crate) fn held_len(&self) -> usize {
        self.held.len()
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

    fn track(&mut self, sequence: &[u8]) {
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
        if sequence == b"\x1bc" || sequence == b"\x1b[!p" {
            self.margins = false;
        }
        if sequence == b"\x1bc" {
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
                self.margins = params.iter().any(u8::is_ascii_digit);
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
                        Some(2026) => self.sync_mode = set,
                        Some(1016) => self.sgr_pixels = set,
                        Some(1006) => self.sgr_mouse = set,
                        Some(protocol @ (9 | 1000 | 1002 | 1003)) => {
                            self.mouse = if set { protocol } else { 0 };
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    /// Feed `bytes`, giving ED 1 and ED 2 xterm's semantics. An unfinished
    /// sequence at the end waits in `held` for the bytes that complete it.
    pub(crate) fn feed(
        &mut self,
        parser: &mut Processor,
        term: &mut Term<VoidListener>,
        bytes: &[u8],
    ) {
        let mut data = std::mem::take(&mut self.held);
        // Held bytes were counted when they first came.
        let start = self.offset - data.len() as u64;
        self.offset += bytes.len() as u64;
        data.extend_from_slice(bytes);
        if !data.is_empty() {
            if self.c1_lead && (0x80..=0x9f).contains(&data[0]) {
                self.diverge(start - 1);
            }
            self.c1_lead = data.last() == Some(&0xc2);
        }
        if let Some(at) = crate::native_serialize::c1_at(&data) {
            self.diverge(start + at as u64);
        }
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
                    self.diverge(start + at as u64);
                }
                break;
            };
            let sequence = &data[at..at + len];
            if sequence == b"\x1b[1J" || sequence == b"\x1b[2J" {
                parser.advance(term, &data[from..at]);
                erase_like_xterm(parser, term, sequence[2] == b'2');
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
                // xterm forgets the preceding character at any control;
                // Alacritty repeats whatever was printed last.
                if crate::native_serialize::divergent(sequence) || (is_rep(sequence) && !printed) {
                    self.diverge(start + at as u64);
                }
                self.track(sequence);
                // A live screen can't stop a synchronized update on a read
                // without touching the parser, so its parser never enters one.
                // Checked first: replay feeds don't allocate on every `ESC [ ?`.
                if self.live {
                    if let Some(replacement) = without_sync(sequence) {
                        parser.advance(term, &data[from..at]);
                        from = at;
                        // An update the strip missed (a form its scan can't
                        // read) holds bytes back until the app ends it, so
                        // the app's reset goes through as it is.
                        let missed = parser.sync_timeout().pending_timeout();
                        if !(missed && sequence.last() == Some(&b'l')) {
                            parser.advance(term, &replacement);
                            from = at + len;
                        }
                    }
                }
                next = Some(at + len);
            }
            printed = false;
        }
        // A live feed holds an unfinished UTF-8 character too: the parser
        // reads a C1 control split across two calls differently from a whole
        // one, and a live screen's chunks must not change its grid.
        if self.live && self.held.is_empty() && !self.in_string {
            let tail = unfinished_utf8(&data[from..]);
            if tail > 0 {
                self.held = data.split_off(data.len() - tail);
            }
        }
        // A held sequence or an unfinished string ends the stream so far.
        self.printed = printed && self.held.is_empty() && !self.in_string;
        // Held bytes are scanned again with the next feed.
        self.c1_lead &= self.held.is_empty();
        parser.advance(term, &data[from..]);
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

/// xterm's ED 1 / ED 2, where Alacritty differs: its ED 2 on the primary
/// screen scrolls the screen into history, and its ED 1 skips the top row
/// when the cursor is on the second. The renderer is xterm.
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
    let grid = term.grid_mut();
    if all {
        grid.reset_region(..);
    } else {
        let cursor = grid.cursor.point;
        grid.reset_region(..cursor.line);
        let bg = grid.cursor.template.bg;
        let end = (cursor.column.0 + 1).min(grid.columns());
        for cell in &mut grid[cursor.line][..Column(end)] {
            *cell = bg.into();
        }
    }
    if synchronized {
        parser.advance(term, b"\x1b[?2026h");
    }
}

/// The active screen's rows as xterm's text read gives them: the newest
/// `max_history` history rows, then the screen, trailing empty rows dropped.
/// The first row returned is never marked wrapped, as in xterm's read (i > 0).
/// Also returns how many rows follow the cursor's.
pub(crate) fn text_rows(
    term: &Term<VoidListener>,
    max_history: usize,
    undimmed: bool,
) -> (Vec<NativeTextRow>, u32) {
    let grid = term.grid();
    let history = grid.history_size().min(max_history) as i32;
    let mut rows = Vec::with_capacity(history as usize + grid.screen_lines());
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
    (rows, rows_below_cursor)
}

pub(crate) fn buffer_type(term: &Term<VoidListener>) -> &'static str {
    if term.mode().contains(TermMode::ALT_SCREEN) {
        "alternate"
    } else {
        "normal"
    }
}

/// Resize as xterm would see it; returns whether the resize scrolled rows
/// xterm keeps on screen (then the grid can't match xterm's).
pub(crate) fn resize_like_xterm(
    parser: &mut Processor,
    term: &mut Term<VoidListener>,
    size: Size,
) -> bool {
    // Rows a narrower reflow adds above the cursor go into Alacritty's
    // history even with room below; xterm moves the cursor down instead.
    let before = |term: &Term<VoidListener>| {
        [term.grid(), term.inactive_grid()].map(|grid| {
            let room = grid.cursor.point.line.0 + 1 < grid.screen_lines() as i32;
            (grid.history_size(), room)
        })
    };
    // vte holds bytes back inside a synchronized update; xterm parsed them
    // at the old size. Apply them first, then re-enter the update.
    let synchronized = parser.sync_timeout().pending_timeout();
    if synchronized {
        parser.stop_sync(term);
    }
    let start = before(term);
    term.resize(size);
    let end = before(term);
    if synchronized {
        parser.advance(term, b"\x1b[?2026h");
    }
    start
        .iter()
        .zip(end.iter())
        .any(|(&(history, room), &(after, _))| room && after > history)
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
            feed: XtermFeed::default(),
            refusal: None,
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
        self.parser.advance(term, &bytes);
        Ok(())
    }

    /// `feed` for an ANSI snapshot replayed by xterm: ED 1 and ED 2 erase as
    /// xterm does (see erase_like_xterm). Returns whether the snapshot is
    /// already refused, so the caller can stop parsing: a control Alacritty
    /// parses differently, or a history past this terminal's cap when the
    /// request asked for more.
    #[napi(catch_unwind)]
    pub fn feed_xterm(&mut self, bytes: Uint8Array, requested_scrollback: u32) -> Result<bool> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        if self.refusal.is_none() {
            self.feed.feed(&mut self.parser, term, &bytes);
            if self.feed.divergent {
                self.refusal = Some("unsupported-state: a control Alacritty parses differently");
            } else if requested_scrollback > self.scrollback
                && [term.grid(), term.inactive_grid()]
                    .iter()
                    .any(|grid| grid.history_size() >= self.scrollback as usize)
            {
                self.refusal =
                    Some("unsupported-history-limit: history reached the native grid cap");
            }
        }
        Ok(self.refusal.is_some())
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
        self.parser.advance(term, bytes);
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
        if resize_like_xterm(&mut self.parser, term, size) {
            self.refusal
                .get_or_insert("unsupported-reflow: a resize scrolled rows xterm keeps on screen");
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn text_snapshot(&mut self, undimmed: bool) -> Result<NativeTextSnapshot> {
        let term = self
            .term
            .as_mut()
            .ok_or_else(|| Error::from_reason("Terminal disposed"))?;
        // A text read must include bytes in an unfinished synchronized update.
        // This finalizes the batch; this API does not promise ANSI replay state.
        self.parser.stop_sync(term);
        let (rows, rows_below_cursor) = text_rows(term, usize::MAX, undimmed);
        Ok(NativeTextSnapshot {
            rows,
            rows_below_cursor,
            buffer_type: buffer_type(term).into(),
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
        if let Some(refusal) = self.refusal {
            return Err(Error::from_reason(refusal));
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
        if self.feed.margins {
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
    /// clear() keeps total_written, so a reader at the end can't see it.
    clears: u32,
    /// The 256-mark cap dropped marks: a range before the oldest kept mark
    /// can't know its size.
    marks_capped: bool,
}

/// A size mark at its lifetime offset.
#[napi(object)]
pub struct NativeRingMark {
    pub at: f64,
    pub cols: u32,
    pub rows: u32,
}

/// The ring's bytes from a lifetime offset, with the size marks over them.
#[napi(object)]
pub struct NativeRingRange {
    /// Why the bytes from `from` can't be read in order ("evicted",
    /// "cleared", "marks-dropped"): the reader rebuilds from the ring's start.
    pub evicted: Option<String>,
    pub data: Buffer,
    /// Lifetime offset after the last byte.
    pub end: f64,
    /// The size in effect at `from`, when the ring has marks.
    pub size: Option<NativeGeometrySize>,
    /// Marks at or after `from`, in order: the bytes from each are at its
    /// size. A mark at `from` itself may be one the reader already applied.
    pub marks: Vec<NativeRingMark>,
    pub clears: u32,
}

/// What a reader at lifetime offset `from` needs (see NativeRingRange).
pub(crate) struct RingRange {
    pub evicted: Option<&'static str>,
    pub end: u64,
    pub size: Option<(u32, u32)>,
    /// The offset of the mark `size` comes from.
    pub size_at: Option<u64>,
    pub marks: Vec<(u64, u32, u32)>,
    pub clears: u32,
}

#[napi]
impl NativeRing {
    #[napi(constructor, catch_unwind)]
    pub fn new(capacity: u32) -> Result<Self> {
        Self::create(capacity).map_err(Error::from_reason)
    }

    #[napi(catch_unwind)]
    pub fn write(&mut self, bytes: Uint8Array) -> Result<()> {
        self.write_bytes(&bytes).map_err(Error::from_reason)
    }

    #[napi(catch_unwind)]
    pub fn write_chunk(&mut self, chunk: &NativeOutputChunk) -> Result<()> {
        self.write_bytes(&chunk.bytes).map_err(Error::from_reason)
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
        self.clear_bytes().map_err(Error::from_reason)
    }

    /// The bytes from lifetime offset `from` to the end, and the size marks
    /// over them. `clears` is the count a reader saw before: a clear since
    /// then, like bytes the ring has dropped, means it can't continue.
    #[napi(catch_unwind)]
    pub fn read_range(&self, from: f64, clears: Option<u32>) -> Result<NativeRingRange> {
        if !from.is_finite() || from < 0.0 || from.fract() != 0.0 || from > 9_007_199_254_740_991.0
        {
            return Err(Error::from_reason("Invalid ring stream offset"));
        }
        let range = self
            .range(from as u64, clears)
            .map_err(Error::from_reason)?;
        let data = match range.evicted {
            Some(_) => Vec::new(),
            None => {
                let [a, b] = self.slices(from as u64, range.end);
                [a, b].concat()
            }
        };
        Ok(NativeRingRange {
            evicted: range.evicted.map(Into::into),
            data: data.into(),
            end: range.end as f64,
            size: range
                .size
                .map(|(cols, rows)| NativeGeometrySize { cols, rows }),
            marks: range
                .marks
                .iter()
                .map(|&(at, cols, rows)| NativeRingMark {
                    at: at as f64,
                    cols,
                    rows,
                })
                .collect(),
            clears: range.clears,
        })
    }

    #[napi(catch_unwind)]
    pub fn note_geometry(&mut self, cols: u32, rows: u32) -> Result<()> {
        self.mark_geometry(cols, rows).map_err(Error::from_reason)
    }

    #[napi(getter, catch_unwind)]
    pub fn has_geometry_changes(&mut self) -> bool {
        self.prune_geometry();
        self.geometry.len() > 1
    }

    #[napi(catch_unwind)]
    pub fn read_all_with_geometry(&mut self) -> NativeRingSnapshot {
        self.prune_geometry();
        let start = self.start();
        let marks = self.replay_marks();
        let geometry = marks.first().map(|first| NativeReplayGeometry {
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
    }
}

impl NativeRing {
    /// Lifetime offset of the ring's oldest byte.
    pub(crate) fn start(&self) -> u64 {
        self.total_written - self.length as u64
    }

    pub(crate) fn create(capacity: u32) -> std::result::Result<Self, &'static str> {
        if capacity == 0 || capacity > 256 * 1024 * 1024 {
            return Err("Ring capacity must be 1..256MiB");
        }
        Ok(Self {
            bytes: vec![0; (capacity as usize).min(64 * 1024)],
            capacity: capacity as usize,
            length: 0,
            write_pos: 0,
            total_written: 0,
            geometry: Vec::new(),
            clears: 0,
            marks_capped: false,
        })
    }

    pub(crate) fn clear_bytes(&mut self) -> std::result::Result<(), &'static str> {
        if self.capacity == 0 {
            return Err("Ring disposed");
        }
        self.bytes.fill(0);
        self.length = 0;
        self.write_pos = 0;
        self.clears = self.clears.wrapping_add(1);
        Ok(())
    }

    pub(crate) fn mark_geometry(
        &mut self,
        cols: u32,
        rows: u32,
    ) -> std::result::Result<(), &'static str> {
        if self.capacity == 0 {
            return Err("Ring disposed");
        }
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        if let Some(last) = self.geometry.last() {
            if last.cols == cols && last.rows == rows {
                return Ok(());
            }
            if last.at == self.total_written {
                self.geometry.pop();
            }
        }
        self.geometry.push(GeometryMark {
            at: self.total_written,
            cols,
            rows,
        });
        self.prune_geometry();
        Ok(())
    }

    /// See read_range. Reads no bytes: slices() hands them out in place.
    pub(crate) fn range(
        &self,
        from: u64,
        clears: Option<u32>,
    ) -> std::result::Result<RingRange, &'static str> {
        if self.capacity == 0 {
            return Err("Ring disposed");
        }
        let start = self.total_written - self.length as u64;
        let governing = self.geometry.iter().rposition(|m| m.at <= from);
        let evicted = if clears.is_some_and(|seen| seen != self.clears) {
            Some("cleared")
        } else if from < start || from > self.total_written {
            Some("evicted")
        } else if governing.is_none() && self.marks_capped {
            Some("marks-dropped")
        } else {
            None
        };
        Ok(RingRange {
            evicted,
            end: self.total_written,
            size: governing.map(|i| (self.geometry[i].cols, self.geometry[i].rows)),
            size_at: governing.map(|i| self.geometry[i].at),
            marks: self
                .geometry
                .iter()
                .filter(|m| m.at >= from)
                .map(|m| (m.at, m.cols, m.rows))
                .collect(),
            clears: self.clears,
        })
    }

    /// The size marks a replay of the whole ring uses, as readAllWithGeometry
    /// gives them: the first applies from the oldest byte (the mark in effect
    /// there, or the first one after it when none is kept), the rest at their
    /// offsets.
    pub(crate) fn replay_marks(&self) -> &[GeometryMark] {
        let start = self.start();
        let first = self
            .geometry
            .iter()
            .rposition(|m| m.at <= start)
            .unwrap_or(0);
        &self.geometry[first..]
    }

    /// What a reader starting at the oldest byte needs, by replay_marks: the
    /// first as the start size, the rest as marks. Never evicted.
    pub(crate) fn seed_range(&self) -> std::result::Result<RingRange, &'static str> {
        if self.capacity == 0 {
            return Err("Ring disposed");
        }
        let marks = self.replay_marks();
        Ok(RingRange {
            evicted: None,
            end: self.total_written,
            size: marks.first().map(|m| (m.cols, m.rows)),
            size_at: marks.first().map(|m| m.at),
            marks: marks
                .iter()
                .skip(1)
                .map(|m| (m.at, m.cols, m.rows))
                .collect(),
            clears: self.clears,
        })
    }

    /// The bytes between lifetime offsets `from` and `to`, in order, as at
    /// most two slices of the ring. Both must be inside the ring.
    pub(crate) fn slices(&self, from: u64, to: u64) -> [&[u8]; 2] {
        let start = self.total_written - self.length as u64;
        debug_assert!(start <= from && from <= to && to <= self.total_written);
        if from >= to {
            return [&[], &[]];
        }
        let first = if self.length < self.bytes.len() {
            0
        } else {
            self.write_pos
        };
        let size = self.bytes.len();
        let a = (first + (from - start) as usize) % size;
        let len = (to - from) as usize;
        let tail = len.min(size - a);
        [&self.bytes[a..a + tail], &self.bytes[..len - tail]]
    }

    pub(crate) fn write_bytes(&mut self, bytes: &[u8]) -> std::result::Result<(), String> {
        if self.capacity == 0 {
            return Err("Ring disposed".into());
        }
        if bytes.is_empty() {
            return Ok(());
        }
        let next_total = self
            .total_written
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("Ring byte offset exceeds JS safe integer range")?;
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
                .map_err(|e| e.to_string())?;
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
        if self.geometry.len() > 256 {
            self.geometry.drain(..self.geometry.len() - 256);
            self.marks_capped = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{resize_like_xterm, NativeRing, Size, Taint, XtermFeed};
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::{Config, Term, TermMode};
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
        let (_, _, feed) = feed_with(&["hello\x1b(", "0q"]);
        assert!(feed.divergent);
        let (_, _, feed) = feed_with(&["\x1b]0;\x1b(0 in a title\x07"]);
        assert!(feed.divergent, "ESC ends the string, then designates");
        let (_, _, feed) = feed_with(&["\x1b]0;(0 in a title\x07ok"]);
        assert!(!feed.divergent);
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
            (feed.margins, feed.cursor_hidden)
        };
        assert_eq!(state(&["\x1b[2;4r"]), (true, false));
        assert_eq!(state(&["\x1b[2;4r\x1b[r"]), (false, false));
        assert_eq!(state(&["\x1b[2;4r\x1bc"]), (false, false));
        assert_eq!(state(&["\x1b[?1;25l"]), (false, true));
        assert_eq!(state(&["\x1b[?25l\x1b[?25h"]), (false, false));
    }

    #[test]
    fn the_pixel_mouse_encoding_follows_the_stream_tracker() {
        let pixels = |chunks: &[&str]| feed_with(chunks).2.sgr_pixels;
        assert!(pixels(&["\x1b[?1003;1016h"]));
        assert!(!pixels(&["\x1b[?1016h\x1b[?1016l"]));
        assert!(!pixels(&["\x1b[?1016h\x1bc"]));
        assert!(pixels(&["\x1b[?10", "16h"]), "split across chunks");
    }

    fn live_with(chunks: &[&str]) -> (Term<VoidListener>, Processor, XtermFeed) {
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::live(0);
        for chunk in chunks {
            feed.feed(&mut parser, &mut term, chunk.as_bytes());
        }
        (term, parser, feed)
    }

    #[test]
    fn a_live_feed_strips_mode_2026_in_every_form() {
        // (chunks, mode 2026 as the stream left it, top row)
        let cases: &[(&[&str], bool, &str)] = &[
            (&["a\x1b[?2026hb"], true, "ab"),
            (&["a\x1b[?2026hb\x1b[?2026lc"], false, "abc"),
            (&["a\x1b[?02026hb"], true, "ab"),
            (&["a\x1b[?25;2026hb"], true, "ab"),
            (&["a\x1b[?2026;1hb"], true, "ab"),
            (&["a\x1b[?20", "26hb"], true, "ab"),
            (&["a\x1b[", "?2026", "h", "b"], true, "ab"),
            // The CR inside executes, as it does in both parsers.
            (&["abc\x1b[?20\r26hX"], true, "Xbc"),
        ];
        for &(chunks, sync, top) in cases {
            let (term, parser, feed) = live_with(chunks);
            assert!(!parser.sync_timeout().pending_timeout(), "{chunks:?}");
            assert_eq!(feed.sync_mode, sync, "{chunks:?}");
            assert_eq!(row(&term, 0), top, "{chunks:?}");
        }
    }

    #[test]
    fn stripping_2026_keeps_the_other_modes_of_the_list() {
        let (term, _, _) = live_with(&["\x1b[?25;2026l"]);
        assert!(!term.mode().contains(TermMode::SHOW_CURSOR));
        let (term, _, _) = live_with(&["\x1b[?25l", "\x1b[?2026;25h"]);
        assert!(term.mode().contains(TermMode::SHOW_CURSOR));
    }

    #[test]
    fn a_replay_feed_still_passes_2026_on() {
        let (_, parser, feed) = feed_with(&["a\x1b[?2026hb"]);
        assert!(parser.sync_timeout().pending_timeout());
        assert!(feed.sync_mode);
    }

    #[test]
    fn a_live_feed_leaves_the_grid_a_finished_update_would() {
        let stream = ["a\x1b[?2026hb\r\n", "c\x1b[2Jd\x1b[3@e", "\x1b[?2026lf"];
        let (live, _, _) = live_with(&stream);
        let (mut replay, mut parser, _) = feed_with(&stream);
        parser.stop_sync(&mut replay);
        for line in 0..3 {
            assert_eq!(row(&live, line), row(&replay, line), "line {line}");
        }
    }

    #[test]
    fn mode_2026_inside_a_string_is_not_touched() {
        let (term, _, feed) = live_with(&["\x1b]0;[?20", "26h\x07ok"]);
        assert!(!feed.sync_mode);
        assert_eq!(row(&term, 0), "ok");
    }

    #[test]
    fn a_live_feed_keeps_parsing_past_a_divergent_control() {
        // SGR 53: overline, which Alacritty doesn't have.
        let (term, _, feed) = live_with(&["ok\x1b[5", "3mq", "\r\nmore"]);
        assert_eq!(
            feed.taint,
            Some(Taint {
                reason: "divergent-control",
                at: 2
            })
        );
        assert_eq!(row(&term, 1), "more");
    }

    #[test]
    fn taint_is_at_the_same_offset_however_the_stream_is_chunked() {
        let at = |chunks: &[&str]| live_with(chunks).2.taint.map(|t| t.at);
        assert_eq!(at(&["0123456789ab\x1b(0"]), Some(12));
        assert_eq!(at(&["0123456789", "ab\x1b(", "0"]), Some(12));
        assert_eq!(at(&["0123456789", "ab\x1b", "(0"]), Some(12));
        assert_eq!(at(&["ab\u{9b}x"]), Some(2), "C1 control");
        assert_eq!(at(&["a", "b\u{9b}x"]), Some(2), "C1 control");
        // Only the first counts.
        assert_eq!(at(&["\x1b(0", "ab\u{9b}"]), Some(0));
    }

    #[test]
    fn a_live_feed_counts_from_its_seed_offset() {
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::live(1_000);
        feed.feed(&mut parser, &mut term, b"abc\x1b(0");
        assert_eq!(feed.taint.map(|t| t.at), Some(1_003));
    }

    #[test]
    fn a_reflow_is_reported_and_taints_a_live_feed() {
        let (mut term, mut parser, mut feed) = live_with(&["aaaaaaaaaa", "\r\nb"]);
        assert!(resize_like_xterm(
            &mut parser,
            &mut term,
            Size { cols: 5, rows: 3 }
        ));
        feed.note_reflow(11);
        assert_eq!(
            feed.taint,
            Some(Taint {
                reason: "reflow",
                at: 11
            })
        );
        let (mut term, mut parser, _) = live_with(&["ab\r\nc"]);
        assert!(!resize_like_xterm(
            &mut parser,
            &mut term,
            Size { cols: 12, rows: 3 }
        ));
    }

    fn ring(capacity: u32) -> NativeRing {
        NativeRing::create(capacity).unwrap()
    }

    fn bytes_of(ring: &NativeRing, from: u64) -> String {
        let end = ring.range(from, None).unwrap().end;
        String::from_utf8(ring.slices(from, end).concat()).unwrap()
    }

    #[test]
    fn a_range_reads_from_a_lifetime_offset_across_the_wrap() {
        let mut r = ring(8);
        r.write_bytes(b"abcdef").unwrap();
        r.write_bytes(b"ghij").unwrap();
        assert_eq!(r.range(2, None).unwrap().evicted, None);
        assert_eq!(bytes_of(&r, 2), "cdefghij");
        assert_eq!(bytes_of(&r, 5), "fghij");
        assert_eq!(bytes_of(&r, 10), "");
        assert_eq!(r.range(10, None).unwrap().end, 10);
    }

    #[test]
    fn a_range_past_the_ring_says_so() {
        let mut r = ring(8);
        r.write_bytes(b"abcdefghij").unwrap();
        assert_eq!(r.range(1, None).unwrap().evicted, Some("evicted"));
        assert_eq!(r.range(11, None).unwrap().evicted, Some("evicted"));
    }

    #[test]
    fn a_range_carries_the_marks_over_it() {
        let mut r = ring(64);
        r.mark_geometry(10, 3).unwrap();
        r.write_bytes(b"01234").unwrap();
        r.mark_geometry(20, 4).unwrap();
        r.write_bytes(b"56789").unwrap();
        let read = r.range(3, None).unwrap();
        assert_eq!(read.size, Some((10, 3)));
        assert_eq!(read.marks, vec![(5, 20, 4)]);
        // A mark at `from` is the size there, and is listed too.
        let read = r.range(5, None).unwrap();
        assert_eq!(read.size, Some((20, 4)));
        assert_eq!(read.marks, vec![(5, 20, 4)]);
        let read = r.range(7, None).unwrap();
        assert_eq!((read.size, read.marks), (Some((20, 4)), vec![]));
        assert_eq!(bytes_of(&r, 3), "3456789");
    }

    #[test]
    fn a_resize_that_replaces_the_last_mark_shows_at_the_same_offset() {
        let mut r = ring(64);
        r.mark_geometry(10, 3).unwrap();
        r.write_bytes(b"ab").unwrap();
        r.mark_geometry(20, 4).unwrap();
        assert_eq!(r.range(2, None).unwrap().marks, vec![(2, 20, 4)]);
        r.mark_geometry(30, 5).unwrap();
        assert_eq!(r.range(2, None).unwrap().marks, vec![(2, 30, 5)]);
    }

    #[test]
    fn a_clear_since_the_last_read_says_so() {
        let mut r = ring(64);
        r.write_bytes(b"abc").unwrap();
        let seen = r.range(3, None).unwrap().clears;
        assert_eq!(r.range(3, Some(seen)).unwrap().evicted, None);
        r.clear_bytes().unwrap();
        assert_eq!(r.range(3, Some(seen)).unwrap().evicted, Some("cleared"));
        let now = r.range(3, None).unwrap().clears;
        assert_eq!(r.range(3, Some(now)).unwrap().evicted, None);
    }

    #[test]
    fn a_range_before_the_marks_the_cap_kept_says_so() {
        let mut r = ring(1 << 20);
        for i in 0..300u32 {
            r.mark_geometry(10 + i % 2, 3).unwrap();
            r.write_bytes(b"x").unwrap();
        }
        assert_eq!(r.range(5, None).unwrap().evicted, Some("marks-dropped"));
        assert_eq!(r.range(299, None).unwrap().evicted, None);
        assert_eq!(r.range(299, None).unwrap().size, Some((11, 3)));
    }

    #[test]
    fn a_sync_the_strip_missed_still_ends_on_the_apps_reset() {
        // ESC, CR, [: the parser reads a CSI that the feed's scan doesn't.
        let (_, parser, _) = live_with(&["a\x1b\r[?2026hb"]);
        assert!(parser.sync_timeout().pending_timeout());
        for chunks in [
            &["a\x1b\r[?2026hb", "\x1b[?2026lc"][..],
            &["a\x1b\r[?2026hb\x1b[?2026lc"],
        ] {
            let (term, parser, _) = live_with(chunks);
            assert!(!parser.sync_timeout().pending_timeout(), "{chunks:?}");
            // The CR inside the sequence executes: b overwrites a.
            assert_eq!(row(&term, 0), "bc", "{chunks:?}");
        }
    }

    fn live_bytes(chunks: &[&[u8]]) -> XtermFeed {
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::live(0);
        for chunk in chunks {
            feed.feed(&mut parser, &mut term, chunk);
        }
        feed
    }

    #[test]
    fn a_c1_control_split_across_feeds_is_seen() {
        let feed = live_bytes(&[b"ab\xc2", b"\x9bx"]);
        assert_eq!(
            feed.taint,
            Some(Taint {
                reason: "divergent-control",
                at: 2
            })
        );
        assert_eq!(
            live_bytes(&[b"ab\xc2", b"\xa0x"]).taint,
            None,
            "a printable character"
        );
        assert_eq!(
            live_bytes(&[b"ab\xc2", b"", b"\x9bx"]).taint.map(|t| t.at),
            Some(2)
        );
        // A live feed holds the lead byte, so the parser reads the control whole.
        assert_eq!(live_bytes(&[b"ab\xc2"]).held_len(), 1);
        assert_eq!(live_bytes(&[b"a\xf0\x9f\x98"]).held_len(), 3);
        assert_eq!(live_bytes(&[b"a\xf0\x9f", b"\x98\x80"]).held_len(), 0);
        // A replay feed holds nothing, and still sees the split control.
        let mut term = Term::new(Config::default(), &Size { cols: 10, rows: 3 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        feed.feed(&mut parser, &mut term, b"ab\xc2");
        assert_eq!(feed.held_len(), 0);
        feed.feed(&mut parser, &mut term, b"\x9bx");
        assert!(feed.divergent);
        // The earlier control counts, though the C1 scan runs first.
        assert_eq!(
            live_bytes(&[b"a\x1b[Sb\xc2\x9bx"]).taint.map(|t| t.at),
            Some(1)
        );
    }
}
