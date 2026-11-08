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
struct XtermFeed {
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

impl XtermFeed {
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
    fn feed(&mut self, parser: &mut Processor, term: &mut Term<VoidListener>, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(bytes);
        self.divergent |= crate::native_serialize::has_c1(&data);
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
                    self.divergent = true;
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
                self.divergent |=
                    crate::native_serialize::divergent(sequence) || (is_rep(sequence) && !printed);
                self.track(sequence);
                next = Some(at + len);
            }
            printed = false;
        }
        // A held sequence or an unfinished string ends the stream so far.
        self.printed = printed && self.held.is_empty() && !self.in_string;
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
    // Whole lines over their physical width: an alternate-screen row keeps
    // cells past a narrower width, and xterm erases those too.
    if all {
        grid.reset_region_keep_width(..);
    } else {
        let cursor = grid.cursor.point;
        grid.reset_region_keep_width(..cursor.line);
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
        let synchronized = self.parser.sync_timeout().pending_timeout();
        if synchronized {
            self.parser.stop_sync(term);
        }
        // An alternate-screen row keeps its cells past a narrower width and
        // shows them again when it widens, as xterm's does: the vendored
        // grid keeps them (vendor/alacritty_terminal WMUX-PATCH.md).
        let start = before(term);
        term.resize(size);
        let end = before(term);
        if synchronized {
            self.parser.advance(term, b"\x1b[?2026h");
        }
        if start
            .iter()
            .zip(end.iter())
            .any(|(&(history, room), &(after, _))| room && after > history)
        {
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
    use alacritty_terminal::grid::Dimensions;
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
    fn run(steps: &[Step]) -> (Vec<String>, Vec<String>) {
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
                    term.resize(Size { cols: *cols, rows: *rows });
                },
            }
        }
        parser.advance(&mut term, &feed.held);
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

    fn all(rows: [&str; 4]) -> Vec<String> {
        rows.iter().map(|r| r.to_string()).collect()
    }

    #[test]
    fn a_widen_shows_the_cells_a_narrow_kept() {
        assert_eq!(rows(&[N, W]), all([R0, R1, R2, R3]));
        assert_eq!(rows(&[N, To(5, 4), W]), all([R0, R1, R2, R3]), "narrows never cut");
        let wide: Vec<String> = [R0, R1, R2, R3].iter().map(|r| format!("{r}..........")).collect();
        assert_eq!(rows(&[N, To(30, 4)]), wide);
    }

    #[test]
    fn a_partial_widen_drops_what_lies_past_it() {
        assert_eq!(
            rows(&[N, To(15, 4), W]),
            all(["0000000000ABCDE.....", "1111111111KLMNO.....", "2222222222abcde.....", "3333333333klmno....."])
        );
    }

    #[test]
    fn printing_and_line_erase_touch_the_visible_cells_only() {
        assert_eq!(rows(&[N, Out("\x1b[1;6Hxyz"), W])[0], "00000xyz00ABCDEFGHIJ");
        let wrapped = rows(&[N, Out("\x1b[1;9Hxyzw"), W]);
        assert_eq!(wrapped[..2], ["00000000xyABCDEFGHIJ".to_string(), "zw11111111KLMNOPQRST".to_string()]);
        assert_eq!(rows(&[N, Out("\x1b[1;6H\x1b[K"), W])[0], "00000.....ABCDEFGHIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;6H\x1b[1K"), W])[0], "......0000ABCDEFGHIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;6H\x1b[2K"), W])[0], "..........ABCDEFGHIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;20Hz"), W])[0], "000000000zABCDEFGHIJ");
        assert_eq!(rows(&[Out("\x1b[1;16H"), N, Out("Z"), W])[0], "000000000ZABCDEFGHIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;1H\t\t\tq"), W])[0], "000000000qABCDEFGHIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;3Ha\x1b[15b"), W])[..2], ["00aaaaaaaaABCDEFGHIJ".to_string(), "aaaaaaaa11KLMNOPQRST".to_string()]);
        assert_eq!(rows(&[N, Out("\x1b[1;10HQ\x1b[K"), W])[0], "000000000QABCDEFGHIJ", "a pending wrap");
    }

    #[test]
    fn display_erase_fills_whole_lines_and_the_current_one_visibly() {
        assert_eq!(rows(&[N, Out("\x1b[2;6H\x1b[J"), W]), all([R0, "11111.....KLMNOPQRST", BLANK, BLANK]));
        assert_eq!(rows(&[N, Out("\x1b[2;6H\x1b[1J"), W]), all([BLANK, "......1111KLMNOPQRST", R2, R3]));
        assert_eq!(rows(&[N, Out("\x1b[2J"), W]), all([BLANK, BLANK, BLANK, BLANK]));
        assert_eq!(rows(&[N, Out("\x1b[3J"), W]), all([R0, R1, R2, R3]));
    }

    #[test]
    fn character_insert_delete_and_erase_run_over_the_physical_line() {
        assert_eq!(rows(&[N, Out("\x1b[1;3H\x1b[3@"), W])[0], "00...00000000ABCDEFG");
        assert_eq!(rows(&[N, Out("\x1b[1;3H\x1b[3P"), W])[0], "0000000ABCDEFGHIJ...");
        assert_eq!(rows(&[N, Out("\x1b[1;3H\x1b[15X"), W])[0], "00...............HIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;9H\x1b[3X"), W])[0], "00000000...BCDEFGHIJ");
        assert_eq!(rows(&[N, Out("\x1b[1;3H\x1b[30X"), W])[0], "00..................");
        assert_eq!(rows(&[N, Out("\x1b[4h\x1b[1;3Hxy\x1b[4l"), W])[0], "00xy00000000ABCDEFGH", "insert mode");
        assert_eq!(rows(&[N, Out("\x1b[1;3H\x1b[3P"), To(15, 4), W])[0], "0000000ABCDEFGH.....");
        assert_eq!(rows(&[N, Out("\x1b[1;3H\x1b[3@"), To(5, 4), Out("\x1b[1;1H\x1b[2@"), W])[0], "..00...00000000ABCDE");
    }

    #[test]
    fn lines_move_with_their_kept_cells_and_new_lines_take_the_current_width() {
        assert_eq!(rows(&[N, Out("\x1b[4;1H\n"), W]), all([R1, R2, R3, BLANK]));
        assert_eq!(rows(&[N, Out("\x1b[1;1H\x1bM"), W]), all([BLANK, R0, R1, R2]));
        assert_eq!(rows(&[N, Out("\x1b[2;1H\x1b[L"), W]), all([R0, BLANK, R1, R2]));
        assert_eq!(rows(&[N, Out("\x1b[2;1H\x1b[M"), W]), all([R0, R2, R3, BLANK]));
        assert_eq!(rows(&[N, Out("\x1b[S"), W]), all([R1, R2, R3, BLANK]));
        assert_eq!(rows(&[N, Out("\x1b[T"), W]), all([BLANK, R0, R1, R2]));
        assert_eq!(rows(&[N, Out("\x1b[2;3r\x1b[S\x1b[r"), W]), all([R0, R2, BLANK, R3]));
        assert_eq!(rows(&[N, Out("\x1b[2;3r\x1b[3;1H\n\x1b[r"), W]), all([R0, R2, BLANK, R3]));
        assert_eq!(rows(&[To(10, 3), To(20, 4)]), all([R1, R2, R3, BLANK]));
        assert_eq!(rows(&[To(10, 6), To(20, 4)]), all([R0, R1, R2, R3]));
        let grown = rows(&[To(10, 6), Out("\x1b[6;1Hsixth"), To(20, 6)]);
        assert_eq!(grown[..4], all([R0, R1, R2, R3])[..]);
        assert_eq!(grown[4..], ["....................".to_string(), "sixth...............".to_string()]);
    }

    #[test]
    fn decaln_fills_the_physical_line() {
        assert_eq!(rows(&[N, Out("\x1b#8"), W]), all(["EEEEEEEEEEEEEEEEEEEE"; 4]));
    }

    #[test]
    fn leaving_the_alternate_screen_or_a_reset_drops_the_kept_cells() {
        assert_eq!(rows(&[N, Out("\x1b[?1049l"), W, Out("\x1b[?1049h")]), all([BLANK; 4]));
        // ?47 and ?1047 are divergent controls (native_serialize): a stream
        // with them never gets a native snapshot.
        assert_eq!(rows(&[N, Out("\x1bc"), W]), all([BLANK; 4]));
    }

    #[test]
    fn a_wide_char_cut_at_the_narrow_edge_comes_back_whole() {
        assert_eq!(rows(&[Out("\x1b[1;10H\u{4e2d}"), N, W])[0], "000000000\u{4e2d}BCDEFGHIJ");
    }

    #[test]
    fn the_erase_background_reaches_kept_cells_as_xterm_s_does() {
        let red = |steps: &[Step]| run(steps).1;
        let full = "0123456789abcdefghij".to_string();
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[2J\x1b[0m"), W]), vec![full.clone(); 4]);
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[2;6H\x1b[J\x1b[0m"), W]), vec!["".into(), "56789".into(), full.clone(), full.clone()]);
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[1;6H\x1b[K\x1b[0m"), W])[0], "56789");
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[1;3H\x1b[3P\x1b[0m"), W])[0], "hij");
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[1;3H\x1b[3@\x1b[0m"), W])[0], "234");
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[1;3H\x1b[15X\x1b[0m"), W])[0], "23456789abcdefg");
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[4;1H\n\x1b[0m"), W])[3], "0123456789");
        assert_eq!(red(&[N, Out("\x1b[41m\x1b[2;1H\x1b[L\x1b[0m"), W])[1], "0123456789");
    }
}
