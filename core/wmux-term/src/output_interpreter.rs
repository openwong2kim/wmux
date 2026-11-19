//! Compatibility interpreter for the daemon's OutputModeTracker and OscParser.
//! Policy (titles, notifications, agent state, timestamps) remains in the host.
//! Preserve their chunk semantics, including the 256 UTF-16-unit mode carry and
//! the ESC a chunk ends on, held for the next one so an OSC introducer or
//! terminator split across chunks is still read; this is not a new VT parser.
//!
//! The modes never need an allocation: the carry is inline and the scan reads
//! carry and chunk in place. A chunk whose feed is refused can still be read
//! for its modes (`skip`), so they move on in step with the stream.

const MODES: [(u32, bool); 14] = [
    (1, false),
    (7, true),
    (25, true),
    (47, false),
    (1047, false),
    (1049, false),
    (1000, false),
    (1002, false),
    (1003, false),
    (1005, false),
    (1006, false),
    (1015, false),
    (1004, false),
    (2004, false),
];
use crate::fallible::{self, AllocFailed};

const ESC: u16 = 27;
const MAX_OSC: usize = 64 * 1024;
const RETAIN_OSC: usize = 2048;
/// UTF-16 units of the mode carry: CARRY_UNITS, two bytes each.
const CARRY_UNITS: usize = 256;
/// UTF-8 bytes of the carry read lossily: at most 3 per unit (a lone
/// surrogate becomes U+FFFD; a pair, two units, is 4 bytes).
const CARRY_UTF8: usize = 3 * CARRY_UNITS;
/// What the interpreter's allocations are for. The chunk's UTF-16 copy is
/// bounded by the chunk; an OSC by MAX_OSC units; the events by the
/// chunk's OSC count.
const INTERPRETER: &str = "the output interpreter";
/// An OSC event's text: at most MAX_OSC units.
const OSC_EVENT: &str = "an OSC event's text";
/// A chunk's events: at most its OSC count.
const OSC_EVENTS: &str = "a chunk's OSC events";

#[derive(Debug, PartialEq)]
pub struct OscEvent {
    pub code: f64,
    pub data: String,
}

pub struct OutputInterpreter {
    carry: Carry,
    modes: Modes,
    osc: Vec<u16>,
    in_osc: bool,
    /// The last chunk ended in an ESC whose pair (`]` or `\`) may start the next one.
    pending_esc: bool,
}

impl Default for OutputInterpreter {
    fn default() -> Self {
        Self {
            carry: Carry::EMPTY,
            modes: Modes::DEFAULT,
            osc: Vec::new(),
            in_osc: false,
            pending_esc: false,
        }
    }
}

/// The mode scan's carry: the stream's last CARRY_UNITS UTF-16 units, read
/// again in front of the next chunk so a sequence split across chunks is
/// still seen. Inline, so keeping it never allocates.
#[derive(Clone, Copy)]
struct Carry {
    units: [u16; CARRY_UNITS],
    len: usize,
}

impl Carry {
    const EMPTY: Self = Self {
        units: [0; CARRY_UNITS],
        len: 0,
    };

    fn as_slice(&self) -> &[u16] {
        &self.units[..self.len]
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The carry once `chunk` was read: its last CARRY_UNITS units, after
    /// as many of this carry's last units as still fit. A surrogate pair
    /// the limit cuts keeps its low unit only.
    fn after(&self, chunk: &str) -> Self {
        let mut tail = [0; CARRY_UNITS];
        let mut at = CARRY_UNITS;
        'chars: for ch in chunk.chars().rev() {
            let mut units = [0; 2];
            for unit in ch.encode_utf16(&mut units).iter().rev() {
                if at == 0 {
                    break 'chars;
                }
                at -= 1;
                tail[at] = *unit;
            }
        }
        let fresh = CARRY_UNITS - at;
        let keep = at.min(self.len);
        let mut next = Self::EMPTY;
        next.units[..keep].copy_from_slice(&self.units[self.len - keep..self.len]);
        next.units[keep..keep + fresh].copy_from_slice(&tail[at..]);
        next.len = keep + fresh;
        next
    }

    /// The carry as UTF-8, as `String::from_utf16_lossy` reads it, into `out`.
    fn lossy_utf8<'a>(&self, out: &'a mut [u8; CARRY_UTF8]) -> &'a [u8] {
        let mut len = 0;
        for ch in char::decode_utf16(self.as_slice().iter().copied()) {
            let ch = ch.unwrap_or(char::REPLACEMENT_CHARACTER);
            // At most 3 bytes per unit read: within CARRY_UTF8.
            len += ch.encode_utf8(&mut out[len..]).len();
        }
        &out[..len]
    }
}

impl PartialEq for Carry {
    fn eq(&self, other: &Self) -> bool {
        self.as_slice() == other.as_slice()
    }
}

impl std::fmt::Debug for Carry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_slice().fmt(f)
    }
}

/// The tracked modes: each one's state and the stream offset it last
/// changed at, and the alternate screen's.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Modes {
    state: [bool; 14],
    changed: [f64; 14],
    alt_offset: f64,
    alt_mode: u32,
}

impl Modes {
    const DEFAULT: Self = Self {
        state: {
            let mut state = [false; 14];
            let mut n = 0;
            while n < MODES.len() {
                state[n] = MODES[n].1;
                n += 1;
            }
            state
        },
        changed: [-1.0; 14],
        alt_offset: -1.0,
        alt_mode: 0,
    };
}

/// What a chunk's OSC scan leaves, applied once the whole feed succeeded
/// (`commit`).
struct OscScan {
    in_osc: bool,
    pending_esc: bool,
    /// The OSC open at the end continues the one `self.osc` held.
    on_kept: bool,
    /// The OSCs this chunk opened, the open one last.
    fresh: Vec<u16>,
}

impl OutputInterpreter {
    /// A refused allocation is an error for this call, and changes nothing:
    /// the modes, the OSC being read and the held ESC are as before, so the
    /// same chunk fed again reads as if the first feed had not happened.
    /// An OSC past MAX_OSC is dropped. (The binding calls `feed_with`.)
    #[cfg(test)]
    pub fn feed(
        &mut self,
        text: &str,
        end: f64,
        include_osc: bool,
    ) -> Result<Vec<OscEvent>, AllocFailed> {
        self.feed_with(text, end, include_osc, Ok)
    }

    /// `feed`, with `finish` run on the events before anything changes: a
    /// refusal there changes nothing either (the caller's own buffers).
    pub fn feed_with<T>(
        &mut self,
        text: &str,
        end: f64,
        include_osc: bool,
        finish: impl FnOnce(Vec<OscEvent>) -> Result<T, AllocFailed>,
    ) -> Result<T, AllocFailed> {
        if text.is_empty() {
            return finish(Vec::new());
        }
        let osc = include_osc
            && (self.in_osc
                || self.pending_esc
                || text.contains("\x1b]")
                || text.ends_with('\x1b'));
        let units = if osc {
            Some(self.osc_units(text)?)
        } else {
            None
        };
        // Kept only once the OSC scan and `finish` succeeded.
        let (carry, modes) = self.feed_modes(text, end);
        let kept = self.osc.len();
        let mut events = Vec::new();
        let scanned = units
            .map(|units| self.feed_osc(&units, &mut events))
            .transpose()
            .and_then(|scan| Ok((finish(events)?, scan)));
        match scanned {
            Ok((result, scan)) => {
                self.carry = carry;
                self.modes = modes;
                if let Some(scan) = scan {
                    self.commit(scan);
                }
                Ok(result)
            }
            Err(failed) => {
                // Only the OSC open before this chunk is added to in place.
                if self.in_osc {
                    self.osc.truncate(kept);
                }
                Err(failed)
            }
        }
    }

    fn commit(&mut self, scan: OscScan) {
        if !(scan.in_osc && scan.on_kept) {
            self.osc = scan.fresh;
        }
        if !scan.in_osc {
            self.clear_osc();
        }
        self.in_osc = scan.in_osc;
        self.pending_esc = scan.pending_esc;
    }

    /// The chunk in UTF-16 units, after the ESC the last chunk ended in.
    fn osc_units(&self, text: &str) -> Result<Vec<u16>, AllocFailed> {
        let held = usize::from(self.pending_esc);
        let len = text.encode_utf16().count().saturating_add(held);
        let mut units = fallible::try_with_capacity(len, INTERPRETER)?;
        if held == 1 {
            // A chunk can end between ESC and `]` or `\`: the ESC held back
            // from the last one goes in front of this one, so the pair is
            // read whole.
            units.push(ESC);
        }
        units.extend(text.encode_utf16());
        Ok(units)
    }

    /// The carry and the modes after `chunk`, for `feed_with` or `skip` to
    /// keep. Allocates nothing.
    fn feed_modes(&self, chunk: &str, end: f64) -> (Carry, Modes) {
        // Only the suffix needs UTF-16 coordinates. Scan the actual stream as
        // UTF-8: mode sequences are ASCII and ring offsets are already bytes.
        let carry = self.carry.after(chunk);
        if !(chunk.contains('\x1b') || self.carry.as_slice().contains(&ESC)) {
            return (carry, self.modes);
        }
        let mut lossy = [0; CARRY_UTF8];
        let head = if self.carry.is_empty() {
            &[][..]
        } else {
            self.carry.lossy_utf8(&mut lossy)
        };
        let text = Joined {
            head,
            tail: chunk.as_bytes(),
        };
        (carry, scan_modes(self.modes, &text, end))
    }

    /// `chunk` starts with the ESC the last chunk ended in, if any
    /// (`osc_units`). Its events go to `events`; the state it leaves is
    /// returned for `commit`. Only an OSC open before the chunk is added to
    /// in place (`self.osc`, which `feed_with` truncates back on a refusal);
    /// the ones the chunk opens are read into a buffer of their own.
    fn feed_osc(
        &mut self,
        chunk: &[u16],
        events: &mut Vec<OscEvent>,
    ) -> Result<OscScan, AllocFailed> {
        let mut in_osc = self.in_osc;
        let mut pending_esc = false;
        let mut on_kept = self.in_osc;
        // No OSC open: the kept buffer is empty, and lends its capacity.
        let mut fresh = if self.in_osc {
            Vec::new()
        } else {
            std::mem::take(&mut self.osc)
        };
        let mut i = 0;
        while i < chunk.len() {
            let c = chunk[i];
            if in_osc {
                let st = c == ESC && chunk.get(i + 1) == Some(&(b'\\' as u16));
                if c == 7 || st {
                    let osc = if on_kept { &self.osc } else { &fresh };
                    if let Some(split) = osc.iter().position(|c| *c == b';' as u16) {
                        if let Some(code) = parse_decimal_prefix(&osc[..split]) {
                            let data = from_utf16_lossy(&osc[split + 1..], OSC_EVENT)?;
                            fallible::try_reserve(events, 1, OSC_EVENTS)?;
                            events.push(OscEvent { code, data });
                        }
                    }
                    on_kept = false;
                    fresh.clear();
                    in_osc = false;
                    i += if st { 2 } else { 1 };
                } else if c == ESC && i + 1 == chunk.len() {
                    pending_esc = true;
                    break;
                } else {
                    let osc = if on_kept { &mut self.osc } else { &mut fresh };
                    // Match the reference's UTF-16-unit cap and resumption point.
                    if osc.len() == MAX_OSC {
                        on_kept = false;
                        fresh.clear();
                        in_osc = false;
                    } else {
                        // At most MAX_OSC units.
                        fallible::try_reserve(osc, 1, INTERPRETER)?;
                        osc.push(c);
                    }
                    i += 1;
                }
            } else if c == ESC && chunk.get(i + 1) == Some(&(b']' as u16)) {
                on_kept = false;
                fresh.clear();
                in_osc = true;
                i += 2;
            } else if c == ESC && i + 1 == chunk.len() {
                pending_esc = true;
                break;
            } else {
                i += 1;
            }
        }
        Ok(OscScan {
            in_osc,
            pending_esc,
            on_kept,
            fresh,
        })
    }

    fn clear_osc(&mut self) {
        if self.osc.capacity() > RETAIN_OSC {
            // Do not pin a large clipboard/title payload for the session's
            // remaining lifetime. Keep small allocations for frequent OSCs.
            self.osc = Vec::new();
        } else {
            self.osc.clear();
        }
    }

    /// The binding's `skipChunk` and `skipBytes` (native-core), for a chunk
    /// whose feed was refused: `text` is read for its modes only, exactly as
    /// `feed` reads them (after the carry, which it then extends), so the
    /// modes and the offsets they changed at stay in step with the stream.
    /// The OSC state is dropped (the OSC being read, the ESC held for the
    /// next chunk), and no event is read. Frees a large OSC, allocates
    /// nothing, cannot fail.
    pub fn skip(&mut self, text: &str, end: f64) {
        // As `feed`: an empty chunk leaves the modes and the carry.
        if !text.is_empty() {
            (self.carry, self.modes) = self.feed_modes(text, end);
        }
        self.clear_osc();
        self.in_osc = false;
        self.pending_esc = false;
    }

    /// The binding's `reset` (native-core).
    #[cfg_attr(not(feature = "native-core"), allow(dead_code))]
    pub fn reset_modes(&mut self) {
        self.modes = Modes::DEFAULT;
    }
    pub fn is_set(&self, mode: u32) -> bool {
        MODES
            .iter()
            .position(|(m, _)| *m == mode)
            .is_some_and(|n| self.modes.state[n])
    }
    pub fn alt_screen(&self) -> bool {
        [47, 1047, 1049].iter().any(|m| self.is_set(*m))
    }
    pub fn preamble(&self, start: f64) -> String {
        let mut out = String::new();
        let alt = if self.is_set(self.modes.alt_mode) {
            Some(self.modes.alt_mode)
        } else {
            [47, 1047, 1049].into_iter().find(|m| self.is_set(*m))
        };
        if let Some(mode) = alt {
            if self.modes.alt_offset < start {
                out.push_str(&format!("\x1b[?{mode}h\x1b[2J\x1b[H"));
            }
        }
        for (n, (mode, default)) in MODES.iter().enumerate() {
            if is_alt(*mode) || self.modes.state[n] == *default || self.modes.changed[n] >= start {
                continue;
            }
            out.push_str(&format!(
                "\x1b[?{mode}{}",
                if self.modes.state[n] { 'h' } else { 'l' }
            ));
        }
        out
    }
}
fn is_alt(mode: u32) -> bool {
    matches!(mode, 47 | 1047 | 1049)
}

/// The text the mode scan reads, `head` then `tail`, without joining them.
struct Joined<'a> {
    head: &'a [u8],
    tail: &'a [u8],
}

impl Joined<'_> {
    fn len(&self) -> usize {
        self.head.len() + self.tail.len()
    }

    fn at(&self, i: usize) -> Option<u8> {
        match i.checked_sub(self.head.len()) {
            None => Some(self.head[i]),
            Some(i) => self.tail.get(i).copied(),
        }
    }

    /// The first ESC at or after `from`.
    fn esc_from(&self, from: usize) -> Option<usize> {
        let esc = |part: &[u8]| part.iter().position(|c| *c == ESC as u8);
        let head = self.head.len();
        if from < head {
            if let Some(at) = esc(&self.head[from..]) {
                return Some(from + at);
            }
        }
        let from = from.max(head);
        esc(self.tail.get(from - head..)?).map(|at| from + at)
    }
}

/// `modes` after the mode sequences in `text`, whose last byte is at stream
/// offset `end - 1`. Allocates nothing.
fn scan_modes(mut m: Modes, text: &Joined<'_>, end: f64) -> Modes {
    let mut changed_at = [None; 14];
    let mut alt_at = None;
    let mut i = 0;
    while let Some(esc) = text.esc_from(i) {
        i = esc;
        if text.at(i + 1) == Some(b'c') {
            m = Modes::DEFAULT;
            i += 2;
            continue;
        }
        if text.at(i + 1) != Some(b'[') {
            i += 1;
            continue;
        }
        if text.at(i + 2) == Some(b'!') && text.at(i + 3) == Some(b'p') {
            for (n, (mode, default)) in MODES.iter().enumerate() {
                if !is_alt(*mode) {
                    m.state[n] = *default;
                }
            }
            i += 4;
            continue;
        }
        if text.at(i + 2) != Some(b'?') {
            i += 1;
            continue;
        }
        let start = i + 3;
        let mut stop = start;
        while text
            .at(stop)
            .is_some_and(|c| c.is_ascii_digit() || c == b';')
        {
            stop += 1;
        }
        let final_char = text.at(stop);
        if !matches!(final_char, Some(b'h' | b'l')) {
            i += 1;
            continue;
        }
        let on = final_char == Some(b'h');
        // Each `;`-separated parameter; an empty one is skipped.
        let mut digits = 0;
        // None once past u32: outside the tracked set (including JS Infinity).
        let mut value = Some(0u32);
        for j in start..=stop {
            let c = text.at(j).unwrap_or(b';');
            if j < stop && c != b';' {
                digits += 1;
                value = value.and_then(|n| n.checked_mul(10)?.checked_add(u32::from(c - b'0')));
                continue;
            }
            if digits > 0 {
                if let Some((n, (mode, _))) = MODES
                    .iter()
                    .enumerate()
                    .find(|(_, (m, _))| Some(*m) == value)
                {
                    m.state[n] = on;
                    changed_at[n] = Some(i);
                    if on && is_alt(*mode) {
                        alt_at = Some(i);
                        m.alt_mode = *mode;
                    }
                }
            }
            digits = 0;
            value = Some(0);
        }
        i = stop + 1;
    }
    // A match always starts at ASCII ESC, so no offset splits UTF-8.
    let len = text.len();
    for (n, index) in changed_at.iter().enumerate() {
        if let Some(index) = index {
            m.changed[n] = end - (len - index) as f64;
        }
    }
    if let Some(index) = alt_at {
        m.alt_offset = end - (len - index) as f64;
    }
    m
}
fn is_digit(c: u16) -> bool {
    (48..=57).contains(&c)
}
/// `String::from_utf16_lossy(units)`, in one fallible allocation of its
/// exact size.
fn from_utf16_lossy(units: &[u16], what: &'static str) -> Result<String, AllocFailed> {
    let chars = || char::decode_utf16(units.iter().copied());
    let len = chars()
        .map(|c| c.map_or(char::REPLACEMENT_CHARACTER, |c| c).len_utf8())
        .fold(0, usize::saturating_add);
    let mut text = String::new();
    fallible::try_reserve_str(&mut text, len, what)?;
    text.extend(chars().map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)));
    Ok(text)
}

fn js_space(c: u16) -> bool {
    matches!(c, 9..=13 | 32 | 160 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn parse_decimal_prefix(text: &[u16]) -> Option<f64> {
    let mut i = 0;
    while text.get(i).is_some_and(|c| js_space(*c)) {
        i += 1;
    }
    let negative = text.get(i) == Some(&(b'-' as u16));
    if negative || text.get(i) == Some(&(b'+' as u16)) {
        i += 1;
    }
    let start = i;
    while text.get(i).is_some_and(|c| is_digit(*c)) {
        i += 1;
    }
    if i == start {
        return None;
    }
    let digits: String = text[start..i].iter().map(|c| *c as u8 as char).collect();
    let value = digits.parse::<f64>().ok()?;
    Some(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_use_ring_byte_offsets_and_soft_reset_keeps_alt() {
        let mut p = OutputInterpreter::default();
        p.feed("한글😀\x1b[?1049h\x1b[?2004h", 900.0, true).unwrap();
        assert_eq!(p.preamble(884.0), "");
        assert_eq!(p.preamble(901.0), "\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h");
        p.feed("\x1b[!p", 904.0, true).unwrap();
        assert!(p.alt_screen());
        assert!(!p.is_set(2004));
    }
    #[test]
    fn osc_is_bounded_and_keeps_reference_chunk_contract() {
        let mut p = OutputInterpreter::default();
        assert!(p.feed("\x1b]7;file:///한", 0.0, true).unwrap().is_empty());
        assert_eq!(
            p.feed("글\x07", 0.0, true).unwrap(),
            vec![OscEvent {
                code: 7.0,
                data: "file:///한글".into()
            }]
        );
        p.feed(&format!("\x1b]7;{}", "x".repeat(MAX_OSC)), 0.0, true)
            .unwrap();
        assert!(p.feed("\x07", 0.0, true).unwrap().is_empty());
        assert_eq!(p.feed("\x1b]133;C\x1b\\", 0.0, true).unwrap()[0].data, "C");
    }
    /// `skip`, where nothing may allocate.
    fn skip_refusing(p: &mut OutputInterpreter, text: &str, end: f64) {
        crate::test_allocator::refusing(1, || p.skip(text, end));
        assert_eq!(crate::test_allocator::refused(), 0, "{text:?}");
    }

    #[test]
    fn a_skipped_chunk_moves_the_modes_without_allocating() {
        let mut fed = OutputInterpreter::default();
        fed.feed("\x1b[?1049h", 100.0, true).unwrap();
        let mut p = OutputInterpreter::default();
        skip_refusing(&mut p, "\x1b[?1049h", 100.0);
        assert!(p.alt_screen());
        assert_eq!(p.preamble(101.0), "\x1b[?1049h\x1b[2J\x1b[H");
        assert_eq!(p.modes, fed.modes);
        assert_eq!(p.carry, fed.carry);
        // A sequence split around the skipped chunk is joined, both ways.
        let mut p = OutputInterpreter::default();
        p.feed("x\x1b[?10", 20.0, true).unwrap();
        skip_refusing(&mut p, "49h", 23.0);
        assert!(p.alt_screen());
        assert_eq!(p.modes.alt_offset, 15.0);
        let mut p = OutputInterpreter::default();
        skip_refusing(&mut p, "x\x1b[?10", 20.0);
        p.feed("49h\x1b[?2004h", 31.0, true).unwrap();
        assert!(p.alt_screen() && p.is_set(2004));
        assert_eq!(p.modes.alt_offset, 15.0);
        // An empty chunk leaves the modes and the carry, as `feed` does.
        let before = (p.modes, p.carry);
        skip_refusing(&mut p, "", 31.0);
        assert_eq!((p.modes, p.carry), before);
    }

    #[test]
    fn a_skipped_chunk_drops_the_osc_state_and_reads_no_event() {
        let event = |data: &str| {
            vec![OscEvent {
                code: 133.0,
                data: data.into(),
            }]
        };
        // An open OSC: what follows the skipped chunk is not its body.
        let mut p = OutputInterpreter::default();
        p.feed(&format!("\x1b]2;{}", "t".repeat(4000)), 10.0, true)
            .unwrap();
        skip_refusing(&mut p, "itle\x07\x1b]133;B", 20.0);
        assert!(!p.in_osc && p.osc.capacity() <= RETAIN_OSC);
        assert!(p.feed("text\x07", 30.0, true).unwrap().is_empty());
        assert_eq!(p.feed("\x1b]133;A\x07", 40.0, true).unwrap(), event("A"));
        // An ESC held for the next chunk's `]`.
        let mut p = OutputInterpreter::default();
        p.feed("x\x1b", 10.0, true).unwrap();
        skip_refusing(&mut p, "y", 11.0);
        assert!(!p.pending_esc);
        assert!(p.feed("]133;A\x07", 20.0, true).unwrap().is_empty());
        // An OSC the skipped chunk opens is not read either.
        let mut p = OutputInterpreter::default();
        skip_refusing(&mut p, "\x1b]133;A", 10.0);
        assert!(p.feed("x\x07\x1b]133;B\x07", 20.0, true).unwrap() == event("B"));
    }

    /// Fed chunks and skipped chunks leave the same modes and carry, over
    /// every split of a stream into three chunks.
    #[test]
    fn skipped_chunks_read_the_modes_as_fed_chunks_do() {
        let stream = "한\x1b[?1049h\x1b]2;t\x07x\x1b[?2004h😀\x1b[?25l\x1b[!p\x1b[?1;1000h\x1bc\x1b[?47;9999999999h";
        let cuts: Vec<usize> = (0..=stream.len())
            .filter(|at| stream.is_char_boundary(*at))
            .collect();
        for (n, &a) in cuts.iter().enumerate() {
            for &b in &cuts[n..] {
                let chunks = [&stream[..a], &stream[a..b], &stream[b..]];
                let mut fed = OutputInterpreter::default();
                let mut skipped = OutputInterpreter::default();
                let mut end = 1000.0;
                for chunk in chunks {
                    end += chunk.len() as f64;
                    fed.feed(chunk, end, true).unwrap();
                    skipped.skip(chunk, end);
                }
                assert_eq!(fed.modes, skipped.modes, "split at {a}, {b}");
                assert_eq!(fed.carry, skipped.carry, "split at {a}, {b}");
            }
        }
    }

    /// The scan reads carry and chunk in place exactly as it reads them
    /// joined: one String of the lossy carry and the chunk.
    #[test]
    fn the_scan_in_place_reads_as_the_joined_text() {
        let mut long = "a".repeat(CARRY_UNITS - 1);
        long.insert(0, '😀');
        let carries = [
            // A lone low surrogate opens the carry (a pair cut by the limit).
            format!("x{long}"),
            // A pair inside the carry, and ESC as its last unit.
            format!("{}😀\x1b", "b".repeat(CARRY_UNITS - 2)),
            "\x1b[?10".to_string(),
            "x\x1b[!".to_string(),
            "\x1b".to_string(),
            "\x1b[?1;20".to_string(),
        ];
        let chunks = ["49h", "p\x1b[?2004h", "c\x1b[?1049h", "04h", "[?1049h"];
        for carried in &carries {
            let mut p = OutputInterpreter::default();
            p.feed("\x1b[?2004h\x1b[?1h", 10.0, true).unwrap();
            p.feed(carried, 500.0, true).unwrap();
            let mut lossy = [0; CARRY_UTF8];
            let head = p.carry.lossy_utf8(&mut lossy);
            assert_eq!(
                head,
                String::from_utf16_lossy(p.carry.as_slice()).as_bytes()
            );
            for chunk in chunks {
                let joined = format!("{}{chunk}", String::from_utf16_lossy(p.carry.as_slice()));
                let whole = Joined {
                    head: &[],
                    tail: joined.as_bytes(),
                };
                let in_place = Joined {
                    head,
                    tail: chunk.as_bytes(),
                };
                assert_eq!(
                    scan_modes(p.modes, &in_place, 900.0),
                    scan_modes(p.modes, &whole, 900.0),
                    "{carried:?} then {chunk:?}"
                );
                assert_eq!(
                    p.feed_modes(chunk, 900.0).1,
                    scan_modes(p.modes, &whole, 900.0)
                );
            }
        }
        // The longest lossy carry: every unit a lone surrogate.
        let carry = Carry {
            units: [0xd800; CARRY_UNITS],
            len: CARRY_UNITS,
        };
        let mut lossy = [0; CARRY_UTF8];
        assert_eq!(carry.lossy_utf8(&mut lossy).len(), CARRY_UTF8);
    }

    #[test]
    fn osc_introducer_and_terminator_split_across_chunks() {
        for (osc, data) in [("\x1b]133;D;0\x07", "D;0"), ("\x1b]133;A\x1b\\", "A")] {
            let stream = format!("out{osc}put");
            for at in 0..=stream.len() {
                let mut p = OutputInterpreter::default();
                let mut events = p.feed(&stream[..at], 0.0, true).unwrap();
                events.extend(p.feed(&stream[at..], 0.0, true).unwrap());
                let want = vec![OscEvent {
                    code: 133.0,
                    data: data.into(),
                }];
                assert_eq!(events, want, "split at {at}");
            }
        }
        // An ESC inside an OSC that the next chunk does not pair stays payload.
        let mut p = OutputInterpreter::default();
        assert!(p.feed("\x1b]2;ti\x1b", 0.0, true).unwrap().is_empty());
        assert_eq!(p.feed("tle\x07", 0.0, true).unwrap()[0].data, "ti\x1btle");
    }
    #[test]
    fn mode_seeding_does_not_reemit_historical_osc() {
        let mut p = OutputInterpreter::default();
        assert!(p
            .feed("\x1b[?1049h\x1b]133;C\x07", 30.0, false)
            .unwrap()
            .is_empty());
        assert!(p.alt_screen());
        assert!(p.feed("\x07", 31.0, true).unwrap().is_empty());
    }
    #[test]
    fn large_osc_storage_is_released_on_termination_and_overflow() {
        for terminator in ["\x07", "\x1b\\", "x"] {
            let mut p = OutputInterpreter::default();
            p.feed(&format!("\x1b]52;{}", "a".repeat(MAX_OSC - 3)), 0.0, true)
                .unwrap();
            assert!(p.in_osc);
            assert!(p.osc.capacity() >= MAX_OSC);
            let events = p.feed(terminator, 0.0, true).unwrap();
            assert_eq!(events.len(), usize::from(terminator != "x"));
            assert!(!p.in_osc);
            assert!(p.osc.capacity() <= RETAIN_OSC);
            assert_eq!(
                p.feed("\x1b]2;next\x07", 0.0, true).unwrap()[0].data,
                "next"
            );
        }
    }
    #[test]
    fn a_refused_chunk_buffer_changes_nothing() {
        use crate::fallible::{fail_from, ALLOC_FAILED};
        let mut p = OutputInterpreter::default();
        let chunk = "\x1b[?1049h\x1b]2;title\x07";
        {
            let _fail = fail_from(1);
            let failed = p.feed(chunk, 100.0, true).unwrap_err();
            assert!(failed.message().starts_with(ALLOC_FAILED));
        }
        assert!(!p.alt_screen(), "no mode applied");
        assert!(p.carry.is_empty());
        let events = p.feed(chunk, 100.0, true).unwrap();
        assert_eq!(events[0].data, "title");
        assert!(p.alt_screen());
    }
    #[test]
    fn a_refused_osc_growth_changes_nothing_and_the_retry_reads_it() {
        use crate::fallible::fail_from;
        let mut p = OutputInterpreter::default();
        p.feed(&format!("\x1b]2;{}", "x".repeat(600)), 0.0, true)
            .unwrap();
        assert_eq!(p.osc.capacity(), 1024);
        {
            // The OSC's next growth asks for 2048 units; this chunk's own
            // copies are smaller.
            let _fail = fail_from(4096);
            let failed = p.feed(&"x".repeat(600), 0.0, true).unwrap_err();
            assert_eq!(failed.bytes, 4096);
        }
        assert!(p.in_osc);
        assert_eq!(p.osc.len(), 602, "the OSC as it was");
        p.feed(&"x".repeat(600), 0.0, true).unwrap();
        assert_eq!(p.feed("\x07", 0.0, true).unwrap()[0].data, "x".repeat(1200));
    }
    #[test]
    fn lossy_utf16_matches_the_standard_library() {
        for units in [&[0x61, 0xd83d, 0xde00][..], &[0xd800, 0x62], &[0xdc00], &[]] {
            assert_eq!(
                from_utf16_lossy(units, INTERPRETER).unwrap(),
                String::from_utf16_lossy(units)
            );
        }
    }

    /// A chunk with a mode change and an OSC refused partway, then fed
    /// again, leaves what the chunk fed once leaves.
    #[test]
    fn a_refused_feed_changes_nothing_and_the_retry_reads_as_once() {
        use crate::fallible::fail_what;
        let chunk = "le\x07\x1b[?1049h\x1b[?2004h\x1b]0;x\x07\x1b]7;open";
        for what in [super::OSC_EVENT, super::OSC_EVENTS, super::INTERPRETER] {
            let mut once = OutputInterpreter::default();
            once.feed("\x1b]2;tit", 10.0, true).unwrap();
            let expected = once.feed(chunk, 50.0, true).unwrap();
            let mut p = OutputInterpreter::default();
            p.feed("\x1b]2;tit", 10.0, true).unwrap();
            {
                let _fail = fail_what(what);
                assert_eq!(p.feed(chunk, 50.0, true).unwrap_err().what, what);
            }
            assert!(!p.alt_screen() && !p.is_set(2004), "no mode applied");
            assert!(p.in_osc, "the earlier OSC is still read");
            assert_eq!(p.osc, "2;tit".encode_utf16().collect::<Vec<_>>());
            assert_eq!(p.feed(chunk, 50.0, true).unwrap(), expected);
            assert_eq!(p.preamble(0.0), once.preamble(0.0));
            assert_eq!(p.osc, once.osc);
            assert_eq!(p.carry, once.carry);
            assert_eq!(
                p.feed("ed\x07", 60.0, true).unwrap(),
                once.feed("ed\x07", 60.0, true).unwrap()
            );
        }
    }
}
