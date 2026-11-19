//! Compatibility interpreter for the daemon's OutputModeTracker and OscParser.
//! Policy (titles, notifications, agent state, timestamps) remains in the host.
//! Preserve their chunk semantics, including the 256 UTF-16-unit mode carry and
//! the ESC a chunk ends on, held for the next one so an OSC introducer or
//! terminator split across chunks is still read; this is not a new VT parser.

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
/// What the interpreter's allocations are for. The chunk's UTF-16 copy
/// and the mode scan's carry-plus-chunk text are bounded by the chunk
/// (at most 3x for the lossy carry); an OSC by MAX_OSC units; the events
/// by the chunk's OSC count.
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
    carry: Vec<u16>,
    modes: Modes,
    osc: Vec<u16>,
    in_osc: bool,
    /// The last chunk ended in an ESC whose pair (`]` or `\`) may start the next one.
    pending_esc: bool,
}

impl Default for OutputInterpreter {
    fn default() -> Self {
        Self {
            carry: Vec::new(),
            modes: Modes::DEFAULT,
            osc: Vec::new(),
            in_osc: false,
            pending_esc: false,
        }
    }
}

/// The tracked modes: each one's state and the stream offset it last
/// changed at, and the alternate screen's.
#[derive(Clone, Copy)]
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
        let (carry, modes) = self.feed_modes(text, end)?;
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

    /// The carry and the modes after `chunk`, for `feed_with` to keep.
    fn feed_modes(&self, chunk: &str, end: f64) -> Result<(Vec<u16>, Modes), AllocFailed> {
        // Only the suffix needs UTF-16 coordinates. Scan the actual stream as
        // UTF-8: mode sequences are ASCII and ring offsets are already bytes.
        let mut carry = utf16_tail(chunk, CARRY_UNITS)?;
        if carry.len() < CARRY_UNITS {
            let previous = &self.carry;
            let keep = (CARRY_UNITS - carry.len()).min(previous.len());
            // Within the CARRY_UNITS capacity utf16_tail reserved.
            carry.splice(0..0, previous[previous.len() - keep..].iter().copied());
        }
        let scan = chunk.contains('\x1b') || self.carry.contains(&ESC);
        let combined = if scan && !self.carry.is_empty() {
            let mut combined = from_utf16_lossy(&self.carry, chunk.len(), INTERPRETER)?;
            combined.push_str(chunk);
            Some(combined)
        } else {
            None
        };
        // Every buffer is in hand: nothing below fails.
        let mut m = self.modes;
        if !scan {
            return Ok((carry, m));
        }
        let text = combined.as_deref().unwrap_or(chunk).as_bytes();
        let mut changed_at = [None; 14];
        let mut alt_at = None;
        let mut i = 0;
        while i < text.len() {
            if text[i] != ESC as u8 {
                i += 1;
                continue;
            }
            if text.get(i + 1) == Some(&b'c') {
                m = Modes::DEFAULT;
                i += 2;
                continue;
            }
            if text.get(i + 1) != Some(&b'[') {
                i += 1;
                continue;
            }
            if text.get(i + 2..i + 4) == Some(b"!p") {
                for (n, (mode, default)) in MODES.iter().enumerate() {
                    if !is_alt(*mode) {
                        m.state[n] = *default;
                    }
                }
                i += 4;
                continue;
            }
            if text.get(i + 2) != Some(&b'?') {
                i += 1;
                continue;
            }
            let start = i + 3;
            let mut stop = start;
            while text
                .get(stop)
                .is_some_and(|c| c.is_ascii_digit() || *c == b';')
            {
                stop += 1;
            }
            let final_char = text.get(stop).copied();
            if !matches!(final_char, Some(104 | 108)) {
                i += 1;
                continue;
            }
            let on = final_char == Some(b'h');
            for raw in text[start..stop].split(|c| *c == b';') {
                if raw.is_empty() {
                    continue;
                }
                // Values outside the tracked set have no effect (including JS Infinity).
                let mode = raw.iter().try_fold(0u32, |n, c| {
                    n.checked_mul(10)?.checked_add((*c - 48) as u32)
                });
                if let Some((n, (mode, _))) = MODES
                    .iter()
                    .enumerate()
                    .find(|(_, (m, _))| Some(*m) == mode)
                {
                    m.state[n] = on;
                    changed_at[n] = Some(i);
                    if on && is_alt(*mode) {
                        alt_at = Some(i);
                        m.alt_mode = *mode;
                    }
                }
            }
            i = stop + 1;
        }
        // A match always starts at ASCII ESC, so no offset splits UTF-8.
        for (n, index) in changed_at.iter().enumerate() {
            if let Some(index) = index {
                m.changed[n] = end - (text.len() - index) as f64;
            }
        }
        if let Some(index) = alt_at {
            m.alt_offset = end - (text.len() - index) as f64;
        }
        Ok((carry, m))
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
                            let data = from_utf16_lossy(&osc[split + 1..], 0, OSC_EVENT)?;
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

    /// The binding's `clearOsc` (native-core), after a chunk is skipped:
    /// the next chunk does not continue it. The OSC being read and the ESC
    /// held for the next chunk are forgotten, and so is the mode scan's
    /// carry (the last chunk's tail, which would join across the gap). The
    /// modes stay. Frees a large OSC, allocates nothing.
    #[cfg_attr(not(feature = "native-core"), allow(dead_code))]
    pub fn clear_osc_state(&mut self) {
        self.clear_osc();
        self.in_osc = false;
        self.pending_esc = false;
        self.carry.clear();
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
fn is_digit(c: u16) -> bool {
    (48..=57).contains(&c)
}
/// `String::from_utf16_lossy(units)` with room for `extra` more bytes, in
/// one fallible allocation of its exact size.
fn from_utf16_lossy(
    units: &[u16],
    extra: usize,
    what: &'static str,
) -> Result<String, AllocFailed> {
    let chars = || char::decode_utf16(units.iter().copied());
    let len = chars()
        .map(|c| c.map_or(char::REPLACEMENT_CHARACTER, |c| c).len_utf8())
        .fold(extra, usize::saturating_add);
    let mut text = String::new();
    fallible::try_reserve_str(&mut text, len, what)?;
    text.extend(chars().map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)));
    Ok(text)
}

/// The last `limit` UTF-16 units of `text`, in a buffer of exactly `limit`.
fn utf16_tail(text: &str, limit: usize) -> Result<Vec<u16>, AllocFailed> {
    let mut reversed = fallible::try_with_capacity(limit, INTERPRETER)?;
    for ch in text.chars().rev() {
        let mut units = [0; 2];
        for unit in ch.encode_utf16(&mut units).iter().rev() {
            if reversed.len() == limit {
                break;
            }
            reversed.push(*unit);
        }
        if reversed.len() == limit {
            break;
        }
    }
    reversed.reverse();
    Ok(reversed)
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
    #[test]
    fn clearing_the_osc_state_keeps_the_modes_and_allocates_nothing() {
        let event = |data: &str| {
            vec![OscEvent {
                code: 133.0,
                data: data.into(),
            }]
        };
        // What each chunk pair reads as without the clear, and with it.
        let pairs = [
            // An open OSC.
            ("\x1b]133;A", "\x07"),
            // An ESC held for the next chunk's `]`.
            ("x\x1b", "]133;A\x07"),
        ];
        for (first, second) in pairs {
            let mut p = OutputInterpreter::default();
            p.feed(first, 0.0, true).unwrap();
            assert_eq!(p.feed(second, 0.0, true).unwrap(), event("A"));
            let mut p = OutputInterpreter::default();
            p.feed("\x1b[?1049h\x1b[?2004h", 10.0, true).unwrap();
            p.feed(first, 20.0, true).unwrap();
            crate::test_allocator::refusing(1, || p.clear_osc_state());
            assert_eq!(crate::test_allocator::refused(), 0);
            assert!(p.feed(second, 30.0, true).unwrap().is_empty(), "{first:?}");
            assert!(p.alt_screen() && p.is_set(2004), "the modes stay");
        }
        // The mode scan's carry: a sequence split around the skipped chunk
        // is not joined across it.
        let mut p = OutputInterpreter::default();
        p.feed("\x1b[?1049h", 10.0, true).unwrap();
        p.feed("x\x1b[?10", 20.0, true).unwrap();
        p.feed("49l", 30.0, true).unwrap();
        assert!(!p.alt_screen(), "joined without the clear");
        let mut p = OutputInterpreter::default();
        p.feed("\x1b[?1049h", 10.0, true).unwrap();
        p.feed("x\x1b[?10", 20.0, true).unwrap();
        p.clear_osc_state();
        p.feed("49l", 30.0, true).unwrap();
        assert!(p.alt_screen());
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
                from_utf16_lossy(units, 0, INTERPRETER).unwrap(),
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
