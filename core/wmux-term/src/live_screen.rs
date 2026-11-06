//! A live screen: one terminal that has consumed a pane's ring in order, so
//! a text read costs the bytes written since the last read, not a replay of
//! the whole ring. It is a replay that never stops: what it shows differs from
//! a fresh replay only by where it was seeded and how much history it keeps.
//!
//! Pull, not eager: nothing feeds it as output arrives. A read feeds the
//! ring's bytes after `fed_to`, resizing at each size mark the ring recorded,
//! through the same xterm feed a replay uses (feed_xterm's), and the seed is
//! the first such read. When the ring can't hand over the bytes in order (they
//! were dropped, the ring was cleared, a mark was rewritten), the read says so
//! and the caller builds a new screen.
//!
//! A live feed strips mode 2026, so its parser never holds bytes back and a
//! read never touches parser state. A control the replay would refuse is
//! recorded as taint and parsing goes on. Wired to nothing yet
//! (live-screen-v1); the native ring re-created on wake from hibernation
//! counts from 0 again, so a screen belongs to one ring object.
//!
//! The seed's lead (the caller's mode preamble and unknown-cell fill) must
//! be finished and plain: no unfinished sequence, string or character at its
//! end, and no control a replay refuses. A seed refuses any other lead before
//! feeding anything, so no parser state of the lead runs into the ring's
//! bytes and no taint points into the lead.

use crate::native_core::{
    buffer_type, resize_like_xterm, text_rows, NativeRing, NativeTextRow, RingRange, Size, Taint,
    XtermFeed,
};
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Row;
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::{Config, Osc52, Term};
use alacritty_terminal::vte::ansi::{Processor, Timeout};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// History rows a live screen keeps unless told otherwise.
pub(crate) const DEFAULT_HISTORY: u32 = 300;

const POISONED: &str = "Live screen poisoned: a call panicked, so its grid may be half-updated";
const DISPOSED: &str = "Live screen disposed";

/// What a seed or read found.
#[derive(Debug, PartialEq)]
pub(crate) enum ReadStatus {
    Ok,
    /// The screen can't continue in order: build a new one.
    Rebuild(&'static str),
    /// A synchronized update the strip missed is holding bytes back: answer
    /// from a replay instead (the screen can't stop it without touching the
    /// parser).
    SyncPending,
}

pub(crate) struct Screen {
    term: Term<VoidListener>,
    parser: Processor,
    feed: XtermFeed,
    size: (u32, u32),
    history: u32,
    /// Lifetime offset of the next ring byte to feed.
    fed_to: u64,
    clears: u32,
    seeded: bool,
    /// The last size mark applied, at its offset. A mark at `fed_to` that
    /// differs from one applied there was rewritten by the ring.
    applied: Option<(u64, (u32, u32))>,
    #[cfg(test)]
    panic_in_pull: bool,
}

fn check_size(cols: u32, rows: u32, history: u32) -> std::result::Result<Size, &'static str> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("Live screen requires 2..1000 columns and 1..1000 rows");
    }
    if history > 100_000 || (rows as u64 + history as u64) * cols as u64 > 4_000_000 {
        return Err("Live screen grid exceeds four million cells");
    }
    Ok(Size {
        cols: cols as usize,
        rows: rows as usize,
    })
}

/// See the module header: a lead that ends inside anything, or holds a
/// control a replay refuses, is refused. Read on a throwaway terminal.
fn check_lead(lead: &[u8]) -> std::result::Result<(), &'static str> {
    if lead.is_empty() {
        return Ok(());
    }
    let config = Config {
        scrolling_history: 0,
        ..Config::default()
    };
    let mut term = Term::new(config, &Size { cols: 2, rows: 1 }, VoidListener);
    let mut parser = Processor::new();
    let mut feed = XtermFeed::live(0);
    feed.feed(&mut parser, &mut term, lead);
    if feed.held_len() > 0 || feed.in_string() || feed.taint().is_some() {
        return Err("Live screen lead must be finished and hold no control a replay refuses");
    }
    Ok(())
}

impl Screen {
    pub(crate) fn new(
        cols: u32,
        rows: u32,
        history: u32,
    ) -> std::result::Result<Self, &'static str> {
        let size = check_size(cols, rows, history)?;
        let config = Config {
            scrolling_history: history as usize,
            osc52: Osc52::Disabled,
            ..Config::default()
        };
        Ok(Self {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            feed: XtermFeed::live(0),
            size: (cols, rows),
            history,
            fed_to: 0,
            clears: 0,
            seeded: false,
            applied: None,
            #[cfg(test)]
            panic_in_pull: false,
        })
    }

    /// Consume the ring from its oldest byte: `lead` first (the caller's mode
    /// preamble and unknown-cell fill, as a replay starts), at the size a
    /// replay starts at, then the ring's bytes as a read feeds them.
    pub(crate) fn seed(
        &mut self,
        ring: &NativeRing,
        lead: &[u8],
    ) -> std::result::Result<ReadStatus, &'static str> {
        if self.seeded {
            return Err("Live screen already seeded");
        }
        check_lead(lead)?;
        let start = ring.start();
        // The geometry a replay of the whole ring uses (readAllWithGeometry):
        // its first mark from the oldest byte, wherever that mark is.
        let range = ring.seed_range()?;
        if let (Some((cols, rows)), Some(at)) = (range.size, range.size_at) {
            self.resize(cols, rows, at)?;
        }
        self.feed = XtermFeed::live(start);
        self.feed.feed(&mut self.parser, &mut self.term, lead);
        self.feed.rebase(start);
        self.fed_to = start;
        self.clears = range.clears;
        self.seeded = true;
        self.pull(ring, range)
    }

    /// Feed what the ring holds after `fed_to`.
    pub(crate) fn read(
        &mut self,
        ring: &NativeRing,
    ) -> std::result::Result<ReadStatus, &'static str> {
        if !self.seeded {
            return Err("Live screen not seeded");
        }
        let range = ring.range(self.fed_to, Some(self.clears))?;
        if let Some(reason) = range.evicted {
            return Ok(ReadStatus::Rebuild(reason));
        }
        self.pull(ring, range)
    }

    fn pull(
        &mut self,
        ring: &NativeRing,
        range: RingRange,
    ) -> std::result::Result<ReadStatus, &'static str> {
        // Marks are in order, so one at `fed_to` comes first: checked before
        // anything is fed, a rebuild leaves the screen as it was.
        if let Some(&(at, cols, rows)) = range.marks.first() {
            if let Some((applied_at, size)) = self.applied {
                if at == self.fed_to && applied_at == at && size != (cols, rows) {
                    return Ok(ReadStatus::Rebuild("geometry-rewritten"));
                }
            }
        }
        // A mark this screen can't take fails the read before anything is
        // fed, so the screen stays where it was.
        for &(_, cols, rows) in &range.marks {
            check_size(cols, rows, self.history)?;
        }
        let mut from = self.fed_to;
        for &(at, cols, rows) in &range.marks {
            if self.applied == Some((at, (cols, rows))) {
                continue;
            }
            self.feed_ring(ring, from, at);
            #[cfg(test)]
            if self.panic_in_pull {
                panic!("forced panic for the poison test");
            }
            from = at;
            // Checked above. A failure after bytes were fed must poison the
            // screen (a panic does, through Guarded), not leave fed_to behind
            // them to be fed again.
            self.resize(cols, rows, at)
                .expect("a mark checked before anything was fed");
        }
        self.feed_ring(ring, from, range.end);
        self.fed_to = range.end;
        if self.parser.sync_timeout().pending_timeout() {
            return Ok(ReadStatus::SyncPending);
        }
        Ok(ReadStatus::Ok)
    }

    fn feed_ring(&mut self, ring: &NativeRing, from: u64, to: u64) {
        for slice in ring.slices(from, to) {
            if !slice.is_empty() {
                self.feed.feed(&mut self.parser, &mut self.term, slice);
            }
        }
    }

    /// Resize at the mark at lifetime offset `at`, as a replay would.
    fn resize(&mut self, cols: u32, rows: u32, at: u64) -> std::result::Result<(), &'static str> {
        let size = check_size(cols, rows, self.history)?;
        if resize_like_xterm(&mut self.parser, &mut self.term, size) {
            self.feed.note_reflow(at);
        }
        self.size = (cols, rows);
        self.applied = Some((at, (cols, rows)));
        Ok(())
    }

    /// The text a replay's read would give (see text_rows). With `unknown`,
    /// a cell holding it was written by no byte the ring still has: `rows`
    /// show it blank, and `unknown` keeps the raw rows, as the awaiting
    /// verifier reads a replay.
    pub(crate) fn text(
        &self,
        max_history: usize,
        undimmed: bool,
        unknown: Option<char>,
    ) -> ScreenText {
        let (mut rows, rows_below_cursor) = text_rows(&self.term, max_history, undimmed);
        let raw = unknown
            .filter(|&c| rows.iter().any(|r| r.text.contains(c)))
            .map(|c| {
                let raw: Vec<String> = rows.iter().map(|r| r.text.clone()).collect();
                for row in &mut rows {
                    row.text = row.text.replace(c, " ").trim_end_matches(' ').to_owned();
                    if let Some(plain) = &mut row.undimmed {
                        *plain = plain.replace(c, " ").trim_end().to_owned();
                    }
                }
                raw
            });
        ScreenText {
            rows,
            rows_below_cursor,
            buffer_type: buffer_type(&self.term),
            unknown: raw,
        }
    }

    pub(crate) fn fed_to(&self) -> u64 {
        self.fed_to
    }

    pub(crate) fn taint(&self) -> Option<Taint> {
        self.feed.taint()
    }

    pub(crate) fn held_len(&self) -> usize {
        self.feed.held_len()
    }

    pub(crate) fn sync_pending(&self) -> bool {
        self.parser.sync_timeout().pending_timeout()
    }

    pub(crate) fn size(&self) -> (u32, u32) {
        self.size
    }

    /// Bytes the grids hold: cells and rows allocated, cached rows included.
    pub(crate) fn allocated_bytes(&self) -> usize {
        [self.term.grid(), self.term.inactive_grid()]
            .iter()
            .map(|grid| {
                let (cells, rows) = grid.allocated();
                cells * std::mem::size_of::<Cell>() + rows * std::mem::size_of::<Row<Cell>>()
            })
            .sum()
    }
}

pub(crate) struct ScreenText {
    pub rows: Vec<NativeTextRow>,
    pub rows_below_cursor: u32,
    pub buffer_type: &'static str,
    pub unknown: Option<Vec<String>>,
}

/// A value that refuses every call once one has panicked while changing it,
/// rather than serve a half-updated state. napi's catch_unwind turns the
/// panic into a JS exception and leaves the object alive.
pub(crate) struct Guarded<T> {
    inner: Option<T>,
    poisoned: bool,
}

impl<T> Guarded<T> {
    pub(crate) fn new(inner: T) -> Self {
        Self {
            inner: Some(inner),
            poisoned: false,
        }
    }

    pub(crate) fn get(&self) -> std::result::Result<&T, &'static str> {
        if self.poisoned {
            return Err(POISONED);
        }
        self.inner.as_ref().ok_or(DISPOSED)
    }

    /// Change the value. If `change` panics, `poisoned` stays set.
    pub(crate) fn with<R>(
        &mut self,
        change: impl FnOnce(&mut T) -> std::result::Result<R, &'static str>,
    ) -> std::result::Result<R, &'static str> {
        if self.poisoned {
            return Err(POISONED);
        }
        let inner = self.inner.as_mut().ok_or(DISPOSED)?;
        self.poisoned = true;
        let result = change(inner);
        self.poisoned = false;
        result
    }

    pub(crate) fn dispose(&mut self) {
        self.inner = None;
    }
}

#[napi(object)]
pub struct NativeLiveRead {
    /// "ok", "rebuild" or "sync-pending".
    pub status: String,
    /// Why to rebuild: "evicted", "cleared", "marks-dropped" or
    /// "geometry-rewritten".
    pub reason: Option<String>,
}

impl From<ReadStatus> for NativeLiveRead {
    fn from(status: ReadStatus) -> Self {
        let (status, reason) = match status {
            ReadStatus::Ok => ("ok", None),
            ReadStatus::Rebuild(reason) => ("rebuild", Some(reason.to_owned())),
            ReadStatus::SyncPending => ("sync-pending", None),
        };
        Self {
            status: status.into(),
            reason,
        }
    }
}

#[napi(object)]
pub struct NativeLiveText {
    pub rows: Vec<NativeTextRow>,
    pub buffer_type: String,
    pub rows_below_cursor: u32,
    /// The raw rows, when a cell holds the unknown character.
    pub unknown: Option<Vec<String>>,
}

#[napi(object)]
pub struct NativeTaint {
    pub reason: String,
    /// Lifetime offset where it started.
    pub at: f64,
}

#[napi(object)]
pub struct NativeLiveSize {
    pub cols: u32,
    pub rows: u32,
}

#[napi]
pub struct NativeLiveScreen {
    screen: Guarded<Screen>,
}

#[napi]
impl NativeLiveScreen {
    #[napi(constructor, catch_unwind)]
    pub fn new(cols: u32, rows: u32, history: Option<u32>) -> Result<Self> {
        let screen = Screen::new(cols, rows, history.unwrap_or(DEFAULT_HISTORY))
            .map_err(Error::from_reason)?;
        Ok(Self {
            screen: Guarded::new(screen),
        })
    }

    /// Consume `ring` from its oldest byte, `lead` first. Once per screen.
    #[napi(catch_unwind)]
    pub fn seed(&mut self, ring: &NativeRing, lead: Option<Uint8Array>) -> Result<NativeLiveRead> {
        let lead = lead.as_deref().unwrap_or(&[]);
        self.screen
            .with(|screen| screen.seed(ring, lead))
            .map(Into::into)
            .map_err(Error::from_reason)
    }

    /// Feed what `ring` holds after `fedTo`.
    #[napi(catch_unwind)]
    pub fn read(&mut self, ring: &NativeRing) -> Result<NativeLiveRead> {
        self.screen
            .with(|screen| screen.read(ring))
            .map(Into::into)
            .map_err(Error::from_reason)
    }

    /// The screen's text, with at most `max_history` history rows. Touches
    /// no parser state.
    #[napi(catch_unwind)]
    pub fn text(
        &self,
        max_history: u32,
        undimmed: bool,
        unknown_char: Option<String>,
    ) -> Result<NativeLiveText> {
        let unknown = match unknown_char.as_deref().map(|s| {
            let mut chars = s.chars();
            (chars.next(), chars.next())
        }) {
            None => None,
            Some((Some(c), None)) => Some(c),
            Some(_) => return Err(Error::from_reason("unknownChar must be one character")),
        };
        let screen = self.screen.get().map_err(Error::from_reason)?;
        let text = screen.text(max_history as usize, undimmed, unknown);
        Ok(NativeLiveText {
            rows: text.rows,
            buffer_type: text.buffer_type.into(),
            rows_below_cursor: text.rows_below_cursor,
            unknown: text.unknown,
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn fed_to(&self) -> Result<f64> {
        Ok(self.get()?.fed_to() as f64)
    }

    #[napi(getter, catch_unwind)]
    pub fn taint(&self) -> Result<Option<NativeTaint>> {
        Ok(self.get()?.taint().map(|taint| NativeTaint {
            reason: taint.reason.into(),
            at: taint.at as f64,
        }))
    }

    #[napi(getter, catch_unwind)]
    pub fn held_len(&self) -> Result<u32> {
        Ok(self.get()?.held_len() as u32)
    }

    #[napi(getter, catch_unwind)]
    pub fn sync_pending(&self) -> Result<bool> {
        Ok(self.get()?.sync_pending())
    }

    #[napi(getter, catch_unwind)]
    pub fn allocated_bytes(&self) -> Result<f64> {
        Ok(self.get()?.allocated_bytes() as f64)
    }

    #[napi(getter, catch_unwind)]
    pub fn size(&self) -> Result<NativeLiveSize> {
        let (cols, rows) = self.get()?.size();
        Ok(NativeLiveSize { cols, rows })
    }

    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.screen.dispose();
    }
}

impl NativeLiveScreen {
    fn get(&self) -> Result<&Screen> {
        self.screen.get().map_err(Error::from_reason)
    }
}

#[cfg(test)]
mod tests {
    use super::{Guarded, ReadStatus, Screen, POISONED};
    use crate::native_core::{resize_like_xterm, text_rows, NativeRing, Size, Taint, XtermFeed};
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Processor, Timeout};

    fn ring() -> NativeRing {
        NativeRing::create(1 << 20).unwrap()
    }

    fn seeded(ring: &NativeRing, cols: u32, rows: u32, history: u32) -> Screen {
        let mut screen = Screen::new(cols, rows, history).unwrap();
        assert_eq!(screen.seed(ring, b"").unwrap(), ReadStatus::Ok);
        screen
    }

    fn texts(screen: &Screen) -> Vec<String> {
        screen
            .text(usize::MAX, false, None)
            .rows
            .into_iter()
            .map(|r| r.text)
            .collect()
    }

    #[test]
    fn a_read_feeds_only_what_came_since() {
        let mut r = ring();
        r.write_bytes(b"hello").unwrap();
        let mut screen = seeded(&r, 20, 3, 10);
        assert_eq!(screen.fed_to(), 5);
        assert_eq!(texts(&screen), ["hello"]);
        r.write_bytes(b" world").unwrap();
        assert_eq!(screen.read(&r).unwrap(), ReadStatus::Ok);
        assert_eq!(screen.fed_to(), 11);
        assert_eq!(texts(&screen), ["hello world"]);
        assert_eq!(screen.read(&r).unwrap(), ReadStatus::Ok);
        assert_eq!(texts(&screen), ["hello world"]);
    }

    #[test]
    fn the_seed_starts_at_the_size_in_effect_and_follows_each_mark() {
        let mut r = ring();
        r.mark_geometry(10, 3).unwrap();
        r.write_bytes(b"abc").unwrap();
        r.mark_geometry(5, 3).unwrap();
        r.write_bytes(b"\r\ndefghij").unwrap();
        let screen = seeded(&r, 80, 24, 10);
        assert_eq!(screen.size(), (5, 3));
        assert_eq!(texts(&screen), ["abc", "defgh", "ij"]);
    }

    #[test]
    fn a_ring_that_dropped_the_next_bytes_asks_for_a_rebuild() {
        let mut r = NativeRing::create(8).unwrap();
        r.write_bytes(b"ab").unwrap();
        let mut screen = seeded(&r, 10, 3, 10);
        r.write_bytes(b"cdefghijkl").unwrap();
        assert_eq!(screen.read(&r).unwrap(), ReadStatus::Rebuild("evicted"));
    }

    #[test]
    fn a_cleared_ring_asks_for_a_rebuild() {
        let mut r = ring();
        r.write_bytes(b"ab").unwrap();
        let mut screen = seeded(&r, 10, 3, 10);
        r.clear_bytes().unwrap();
        assert_eq!(screen.read(&r).unwrap(), ReadStatus::Rebuild("cleared"));
    }

    #[test]
    fn a_new_mark_at_the_read_offset_applies_and_a_rewritten_one_asks_for_a_rebuild() {
        let mut r = ring();
        r.mark_geometry(10, 3).unwrap();
        r.write_bytes(b"ab").unwrap();
        let mut screen = seeded(&r, 10, 3, 10);
        // A resize after the last read, with no output since: a new mark.
        r.mark_geometry(20, 4).unwrap();
        assert_eq!(screen.read(&r).unwrap(), ReadStatus::Ok);
        assert_eq!(screen.size(), (20, 4));
        assert_eq!(screen.read(&r).unwrap(), ReadStatus::Ok);
        // Another resize, still with no output: the ring replaces that mark,
        // and a replay would never see 20x4.
        r.mark_geometry(30, 5).unwrap();
        assert_eq!(
            screen.read(&r).unwrap(),
            ReadStatus::Rebuild("geometry-rewritten")
        );
        assert_eq!(
            screen.size(),
            (20, 4),
            "a rebuild leaves the screen as it was"
        );
    }

    #[test]
    fn a_synchronized_update_the_strip_missed_is_reported() {
        // ESC, CR, then [: the CR executes inside the escape and the parser
        // still reads a CSI, but the feed's sequence scan doesn't.
        let mut r = ring();
        r.write_bytes(b"a\x1b\r[?2026hb").unwrap();
        let mut screen = Screen::new(10, 3, 10).unwrap();
        let status = screen.seed(&r, b"").unwrap();
        assert_eq!(status == ReadStatus::SyncPending, screen.sync_pending());
        if status == ReadStatus::SyncPending {
            assert_eq!(texts(&screen), ["a"], "held back, not read through");
        }
    }

    #[test]
    fn taint_never_stops_the_screen() {
        let mut r = ring();
        r.write_bytes(b"ok\x1b[53m").unwrap();
        let mut screen = seeded(&r, 10, 3, 10);
        r.write_bytes(b"\r\nmore").unwrap();
        screen.read(&r).unwrap();
        assert_eq!(
            screen.taint(),
            Some(Taint {
                reason: "divergent-control",
                at: 2
            })
        );
        assert_eq!(texts(&screen), ["ok", "more"]);
    }

    #[test]
    fn a_reflow_taints_at_its_mark() {
        let mut r = ring();
        r.mark_geometry(10, 5).unwrap();
        r.write_bytes(b"aaaaaaaaaa\r\nb").unwrap();
        r.mark_geometry(5, 5).unwrap();
        let screen = seeded(&r, 10, 5, 10);
        assert_eq!(
            screen.taint(),
            Some(Taint {
                reason: "reflow",
                at: 13
            })
        );
    }

    #[test]
    fn text_keeps_the_newest_history_rows_and_never_wraps_the_first() {
        let mut r = ring();
        r.mark_geometry(5, 2).unwrap();
        r.write_bytes(b"aaaaabbbbbccccc\r\nd").unwrap();
        let screen = seeded(&r, 5, 2, 10);
        let rows = |history| {
            screen
                .text(history, false, None)
                .rows
                .into_iter()
                .map(|r| (r.text, r.wrapped))
                .collect::<Vec<_>>()
        };
        let row = |t: &str, w| (t.to_owned(), w);
        assert_eq!(
            rows(10),
            [
                row("aaaaa", false),
                row("bbbbb", true),
                row("ccccc", true),
                row("d", false)
            ]
        );
        assert_eq!(
            rows(1),
            [row("bbbbb", false), row("ccccc", true), row("d", false)]
        );
        assert_eq!(rows(0), [row("ccccc", false), row("d", false)]);
    }

    #[test]
    fn unknown_cells_read_blank_with_the_raw_rows_beside() {
        let mut r = ring();
        r.mark_geometry(5, 2).unwrap();
        r.write_bytes(b"ab").unwrap();
        let unknown = '\u{e000}';
        let fill: String = (1..=2)
            .map(|row| format!("\x1b[{row};1H{}", unknown.to_string().repeat(5)))
            .collect();
        let mut screen = Screen::new(5, 2, 10).unwrap();
        screen.seed(&r, format!("{fill}\x1b[H").as_bytes()).unwrap();
        let text = screen.text(10, false, Some(unknown));
        let rows: Vec<_> = text.rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(rows, ["ab", ""]);
        let raw = format!("ab{}", unknown.to_string().repeat(3));
        assert_eq!(text.unknown, Some(vec![raw, unknown.to_string().repeat(5)]));
        assert_eq!(screen.text(10, false, Some('x')).unknown, None);
    }

    #[test]
    fn reads_leave_an_unfinished_sequence_where_it_is() {
        let mut r = ring();
        r.write_bytes(b"abc\x1b[3").unwrap();
        let mut screen = seeded(&r, 10, 3, 10);
        assert_eq!(screen.held_len(), 3);
        assert_eq!(texts(&screen), ["abc"]);
        assert_eq!(texts(&screen), ["abc"]);
        r.write_bytes(b"1mdef").unwrap();
        screen.read(&r).unwrap();
        assert_eq!(screen.held_len(), 0);
        assert_eq!(texts(&screen), ["abcdef"]);
    }

    #[test]
    fn a_panic_poisons_the_screen_and_every_call_refuses() {
        let mut r = ring();
        r.mark_geometry(10, 3).unwrap();
        r.write_bytes(b"ab").unwrap();
        r.mark_geometry(12, 3).unwrap();
        r.write_bytes(b"cd").unwrap();
        let mut screen = Screen::new(10, 3, 10).unwrap();
        screen.panic_in_pull = true;
        let mut guarded = Guarded::new(screen);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = guarded.with(|screen| screen.seed(&r, b""));
        }));
        assert!(caught.is_err());
        assert_eq!(
            guarded.with(|screen| screen.read(&r)).unwrap_err(),
            POISONED
        );
        assert_eq!(guarded.get().err(), Some(POISONED));
        // An ordinary error does not poison.
        let mut fine = Guarded::new(Screen::new(10, 3, 10).unwrap());
        assert!(fine.with(|screen| screen.read(&r)).is_err(), "not seeded");
        assert!(fine.get().is_ok());
    }

    #[test]
    fn a_screen_with_300_rows_of_history_allocates_for_300() {
        let mut r = ring();
        r.mark_geometry(120, 40).unwrap();
        for i in 0..1_000 {
            r.write_bytes(format!("line {i}\r\n").as_bytes()).unwrap();
        }
        let screen = seeded(&r, 120, 40, 300);
        let bytes = screen.allocated_bytes();
        println!("allocated at 120x40, depth 300: {bytes} bytes");
        assert!(bytes < 1_200_000, "{bytes}");
    }

    #[test]
    fn a_mark_the_screen_refuses_feeds_nothing() {
        let mut r = ring();
        r.mark_geometry(10, 3).unwrap();
        let mut screen = seeded(&r, 10, 3, 10);
        r.write_bytes(b"abc").unwrap();
        r.mark_geometry(1, 24).unwrap();
        r.write_bytes(b"def").unwrap();
        assert!(screen.read(&r).is_err());
        assert_eq!(screen.fed_to(), 0);
        assert!(texts(&screen).is_empty());
        assert!(screen.read(&r).is_err());
        assert!(texts(&screen).is_empty(), "nothing fed twice");
    }

    #[test]
    fn a_seed_after_the_mark_cap_starts_at_the_first_kept_mark() {
        let mut r = ring();
        for i in 0..300u32 {
            r.mark_geometry(10 + i % 2, 3).unwrap();
            r.write_bytes(b"x").unwrap();
        }
        let mut screen = Screen::new(80, 24, 10).unwrap();
        // As readAllWithGeometry replays it: the first kept mark (offset 44,
        // 10x3) from the oldest byte, then the rest.
        assert_eq!(screen.seed(&r, b"").unwrap(), ReadStatus::Ok);
        assert_eq!(screen.size(), (11, 3));
        assert_eq!(Some(texts(&screen)), replay(&r, 10).map(|(texts, _)| texts));
        // An existing screen whose offset lost its mark still can't go on.
        let mut early = Screen::new(80, 24, 10).unwrap();
        let mut small = ring();
        small.mark_geometry(10, 3).unwrap();
        early.seed(&small, b"").unwrap();
        assert_eq!(
            early.read(&r).unwrap(),
            ReadStatus::Rebuild("marks-dropped")
        );
    }

    #[test]
    fn a_seed_before_the_first_mark_uses_that_mark_from_the_start() {
        let mut r = ring();
        r.write_bytes(b"\x1b[1;7HZ").unwrap();
        r.mark_geometry(5, 3).unwrap();
        let screen = seeded(&r, 80, 24, 10);
        assert_eq!(screen.size(), (5, 3));
        assert_eq!(texts(&screen), ["    Z"]);
        assert_eq!(screen.taint(), None);
    }

    #[test]
    fn a_lead_that_would_run_into_the_ring_is_refused() {
        for lead in [&b"\x1b]0;title"[..], b"\x1b[", b"\x1b(0", b"ok\x1b"] {
            let mut r = ring();
            r.write_bytes(b"abc").unwrap();
            let mut screen = Screen::new(10, 3, 10).unwrap();
            assert!(screen.seed(&r, lead).is_err(), "{lead:?}");
            assert!(texts(&screen).is_empty(), "{lead:?}: nothing fed");
            assert!(screen.read(&r).is_err(), "{lead:?}: not seeded");
        }
    }

    #[test]
    fn unknown_cells_read_blank_in_the_undimmed_text_too() {
        let mut r = ring();
        r.mark_geometry(5, 2).unwrap();
        r.write_bytes(b"ab").unwrap();
        let unknown = '\u{e000}';
        let mut screen = Screen::new(5, 2, 10).unwrap();
        let lead = format!("\x1b[1;1H{}\x1b[H", unknown.to_string().repeat(5));
        screen.seed(&r, lead.as_bytes()).unwrap();
        let text = screen.text(10, true, Some(unknown));
        assert_eq!(text.rows[0].undimmed.as_deref(), Some("ab"));
    }

    // ---- live == a fresh replay with the same seed, depth and geometry ----

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    enum Event {
        Bytes(Vec<u8>),
        Resize(u32, u32),
        Read,
    }

    fn piece(rng: &mut Rng, divergent: bool, sync: bool) -> String {
        let word = |rng: &mut Rng| {
            (0..1 + rng.below(8))
                .map(|_| (b'a' + rng.below(26) as u8) as char)
                .collect::<String>()
        };
        match rng.below(if divergent { 25 } else { 24 }) {
            0..=5 => word(rng),
            6 => " ".into(),
            7 => "\r\n".into(),
            8 => "\r".into(),
            9 => "\n".into(),
            10 => "한글".into(),
            11 => format!("\x1b[{};{}H", 1 + rng.below(9), 1 + rng.below(22)),
            12 => ["\x1b[1m", "\x1b[31m", "\x1b[0m", "\x1b[2m", "\x1b[7m"][rng.below(5) as usize]
                .into(),
            13 => {
                ["\x1b[J", "\x1b[1J", "\x1b[2J", "\x1b[K", "\x1b[1K"][rng.below(5) as usize].into()
            }
            14 if sync => [
                "\x1b[?2026h",
                "\x1b[?2026l",
                "\x1b[?25;2026h",
                "\x1b[?02026l",
                "\x1b[?2026;25l",
            ][rng.below(5) as usize]
                .into(),
            14 => word(rng),
            15 => "\x1b]0;a title\x07".into(),
            16 => ["\x1b[2@", "\x1b[P", "\x1b[3X"][rng.below(3) as usize].into(),
            17 => ["\x1b[?1049h", "\x1b[?1049l"][rng.below(2) as usize].into(),
            18 => format!("\x1b[{}A", 1 + rng.below(4)),
            19 => "\t".into(),
            20 => "\x1b[S".into(),
            21 => format!("\x1b[{};{}r", 1 + rng.below(3), 3 + rng.below(6)),
            22 => "\x1b[r".into(),
            23 => "\x08".into(),
            // A C1 control: the cut can fall between its two bytes.
            _ if rng.below(2) == 0 => "\u{9b}31m".into(),
            _ => "\x1b[53m".into(),
        }
    }

    fn events(rng: &mut Rng) -> Vec<Event> {
        let divergent = rng.below(4) == 0;
        let sync = rng.below(2) == 0;
        let stream: Vec<u8> = (0..20 + rng.below(200))
            .map(|_| piece(rng, divergent, sync))
            .collect::<String>()
            .into_bytes();
        let mut events = Vec::new();
        let mut at = 0;
        while at < stream.len() {
            // Cut anywhere, inside a sequence or a character too.
            let len = (1 + rng.below(24) as usize).min(stream.len() - at);
            events.push(Event::Bytes(stream[at..at + len].to_vec()));
            at += len;
            // Resizes and reads with no output between them too: the ring
            // folds such resizes into one mark.
            loop {
                match rng.below(8) {
                    0 => events.push(Event::Resize(
                        4 + rng.below(18) as u32,
                        2 + rng.below(7) as u32,
                    )),
                    1 | 2 => events.push(Event::Read),
                    _ => break,
                }
            }
        }
        events
    }

    /// Today's replay of the ring: the xterm feed without the strip, at the
    /// sizes the ring recorded, resized as NativeTerminal resizes, the update
    /// stopped at the read. None where that replay is known to go wrong: it
    /// resizes inside an update by stopping it and re-entering ?2026h, and
    /// that ESC ends a string or a character left open across the resize
    /// (a live feed has no update to stop).
    fn replay(ring: &NativeRing, history: u32) -> Option<(Vec<String>, Vec<bool>)> {
        let config = Config {
            scrolling_history: history as usize,
            ..Config::default()
        };
        let start = ring.start();
        // The geometry readAllWithGeometry hands today's replay.
        let range = ring.seed_range().unwrap();
        let (cols, rows) = range.size.unwrap();
        let size = |cols: u32, rows: u32| Size {
            cols: cols as usize,
            rows: rows as usize,
        };
        let mut term = Term::new(config, &size(cols, rows), VoidListener);
        let mut parser: Processor = Processor::new();
        let mut feed = XtermFeed::default();
        let mut from = start;
        for &(at, cols, rows) in &range.marks {
            feed.feed(&mut parser, &mut term, &ring.slices(from, at).concat());
            from = at;
            if parser.sync_timeout().pending_timeout() {
                return None;
            }
            resize_like_xterm(&mut parser, &mut term, size(cols, rows));
        }
        feed.feed(
            &mut parser,
            &mut term,
            &ring.slices(from, range.end).concat(),
        );
        parser.stop_sync(&mut term);
        let (rows, _) = text_rows(&term, usize::MAX, false);
        Some((
            rows.iter().map(|r| r.text.clone()).collect(),
            rows.iter().map(|r| r.wrapped).collect(),
        ))
    }

    /// Rows (text, wrapped, undimmed), rows below the cursor, buffer, size,
    /// taint.
    type Snapshot = (
        Vec<(String, bool, Option<String>)>,
        u32,
        &'static str,
        (u32, u32),
        Option<Taint>,
    );

    fn snapshot(screen: &Screen) -> Snapshot {
        let text = screen.text(usize::MAX, true, None);
        (
            text.rows
                .into_iter()
                .map(|r| (r.text, r.wrapped, r.undimmed))
                .collect(),
            text.rows_below_cursor,
            text.buffer_type,
            screen.size(),
            screen.taint(),
        )
    }

    #[test]
    fn live_matches_a_fresh_replay_with_reads_anywhere() {
        let history = 12;
        let (mut rebuilds, mut reads, mut compared, mut skipped) = (0, 0, 0, 0);
        for seed in 1..=400u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
            let events = events(&mut rng);
            let mut r = ring();
            r.mark_geometry(10, 4).unwrap();
            let mut live = seeded(&r, 10, 4, history);
            let mut check = |live: &mut Screen, r: &NativeRing| {
                match live.read(r).unwrap() {
                    ReadStatus::Ok => {}
                    ReadStatus::Rebuild(reason) => {
                        assert_eq!(reason, "geometry-rewritten", "seed {seed}");
                        rebuilds += 1;
                        *live = seeded(r, 10, 4, history);
                    }
                    ReadStatus::SyncPending => panic!("seed {seed}: the strip missed a sync"),
                }
                reads += 1;
                assert_eq!(
                    snapshot(live),
                    snapshot(&seeded(r, 10, 4, history)),
                    "seed {seed}"
                );
            };
            for event in &events {
                match event {
                    Event::Bytes(bytes) => r.write_bytes(bytes).unwrap(),
                    Event::Resize(cols, rows) => r.mark_geometry(*cols, *rows).unwrap(),
                    Event::Read => check(&mut live, &r),
                }
            }
            check(&mut live, &r);
            // The same ring as today's replay reads it.
            let Some((texts, wrapped)) = replay(&r, history) else {
                skipped += 1;
                continue;
            };
            let text = live.text(usize::MAX, false, None);
            assert_eq!(
                text.rows.iter().map(|r| r.text.clone()).collect::<Vec<_>>(),
                texts,
                "seed {seed} vs replay"
            );
            assert_eq!(
                text.rows.iter().map(|r| r.wrapped).collect::<Vec<_>>(),
                wrapped,
                "seed {seed} vs replay"
            );
            compared += 1;
        }
        println!("{reads} reads, {rebuilds} rebuilds; {compared} streams matched today's replay, {skipped} skipped");
        assert!(reads > 1_000);
        assert!(compared > 200);
        assert!(rebuilds > 0);
    }
}
