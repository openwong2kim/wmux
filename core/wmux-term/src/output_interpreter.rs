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
const ESC: u16 = 27;
const MAX_OSC: usize = 64 * 1024;
const RETAIN_OSC: usize = 2048;

#[derive(Debug, PartialEq)]
pub struct OscEvent {
    pub code: f64,
    pub data: String,
}

pub struct OutputInterpreter {
    carry: Vec<u16>,
    state: [bool; 14],
    changed: [f64; 14],
    alt_offset: f64,
    alt_mode: u32,
    osc: Vec<u16>,
    in_osc: bool,
    /// The last chunk ended in an ESC whose pair (`]` or `\`) may start the next one.
    pending_esc: bool,
}

impl Default for OutputInterpreter {
    fn default() -> Self {
        Self {
            carry: Vec::new(),
            state: MODES.map(|(_, default)| default),
            changed: [-1.0; 14],
            alt_offset: -1.0,
            alt_mode: 0,
            osc: Vec::new(),
            in_osc: false,
            pending_esc: false,
        }
    }
}

impl OutputInterpreter {
    pub fn feed(&mut self, text: &str, end: f64, include_osc: bool) -> Vec<OscEvent> {
        if text.is_empty() {
            return Vec::new();
        }
        self.feed_modes(text, end);
        if include_osc
            && (self.in_osc || self.pending_esc || text.contains("\x1b]") || text.ends_with('\x1b'))
        {
            self.feed_osc(&text.encode_utf16().collect::<Vec<_>>())
        } else {
            Vec::new()
        }
    }

    fn feed_modes(&mut self, chunk: &str, end: f64) {
        let previous = std::mem::take(&mut self.carry);
        // Only the suffix needs UTF-16 coordinates. Scan the actual stream as
        // UTF-8: mode sequences are ASCII and ring offsets are already bytes.
        self.carry = utf16_tail(chunk, 256);
        if self.carry.len() < 256 {
            let keep = (256 - self.carry.len()).min(previous.len());
            self.carry
                .splice(0..0, previous[previous.len() - keep..].iter().copied());
        }
        if !chunk.contains('\x1b') && !previous.contains(&ESC) {
            return;
        }
        let mut combined;
        let text = if previous.is_empty() {
            chunk.as_bytes()
        } else {
            combined = String::from_utf16_lossy(&previous);
            combined.push_str(chunk);
            combined.as_bytes()
        };
        let mut changed_at = [None; 14];
        let mut alt_at = None;
        let mut i = 0;
        while i < text.len() {
            if text[i] != ESC as u8 {
                i += 1;
                continue;
            }
            if text.get(i + 1) == Some(&b'c') {
                self.reset_modes();
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
                        self.state[n] = *default;
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
                    self.state[n] = on;
                    changed_at[n] = Some(i);
                    if on && is_alt(*mode) {
                        alt_at = Some(i);
                        self.alt_mode = *mode;
                    }
                }
            }
            i = stop + 1;
        }
        // A match always starts at ASCII ESC, so no offset splits UTF-8.
        for (n, index) in changed_at.iter().enumerate() {
            if let Some(index) = index {
                self.changed[n] = end - (text.len() - index) as f64;
            }
        }
        if let Some(index) = alt_at {
            self.alt_offset = end - (text.len() - index) as f64;
        }
    }

    fn feed_osc(&mut self, chunk: &[u16]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        // A chunk can end between ESC and `]` or `\`: the ESC held back from
        // the last one goes in front of this one, so the pair is read whole.
        let held;
        let chunk = if std::mem::take(&mut self.pending_esc) {
            held = [&[ESC][..], chunk].concat();
            &held[..]
        } else {
            chunk
        };
        let mut i = 0;
        while i < chunk.len() {
            let c = chunk[i];
            if self.in_osc {
                let st = c == ESC && chunk.get(i + 1) == Some(&(b'\\' as u16));
                if c == 7 || st {
                    if let Some(split) = self.osc.iter().position(|c| *c == b';' as u16) {
                        if let Some(code) = parse_decimal_prefix(&self.osc[..split]) {
                            events.push(OscEvent {
                                code,
                                data: String::from_utf16_lossy(&self.osc[split + 1..]),
                            });
                        }
                    }
                    self.clear_osc();
                    self.in_osc = false;
                    i += if st { 2 } else { 1 };
                } else if c == ESC && i + 1 == chunk.len() {
                    self.pending_esc = true;
                    break;
                } else {
                    // Match the reference's UTF-16-unit cap and resumption point.
                    if self.osc.len() == MAX_OSC {
                        self.clear_osc();
                        self.in_osc = false;
                    } else {
                        self.osc.push(c);
                    }
                    i += 1;
                }
            } else if c == ESC && chunk.get(i + 1) == Some(&(b']' as u16)) {
                self.clear_osc();
                self.in_osc = true;
                i += 2;
            } else if c == ESC && i + 1 == chunk.len() {
                self.pending_esc = true;
                break;
            } else {
                i += 1;
            }
        }
        events
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

    pub fn reset_modes(&mut self) {
        self.state = MODES.map(|(_, default)| default);
        self.changed = [-1.0; 14];
        self.alt_offset = -1.0;
        self.alt_mode = 0;
    }
    pub fn is_set(&self, mode: u32) -> bool {
        MODES
            .iter()
            .position(|(m, _)| *m == mode)
            .is_some_and(|n| self.state[n])
    }
    pub fn alt_screen(&self) -> bool {
        [47, 1047, 1049].iter().any(|m| self.is_set(*m))
    }
    pub fn preamble(&self, start: f64) -> String {
        let mut out = String::new();
        let alt = if self.is_set(self.alt_mode) {
            Some(self.alt_mode)
        } else {
            [47, 1047, 1049].into_iter().find(|m| self.is_set(*m))
        };
        if let Some(mode) = alt {
            if self.alt_offset < start {
                out.push_str(&format!("\x1b[?{mode}h\x1b[2J\x1b[H"));
            }
        }
        for (n, (mode, default)) in MODES.iter().enumerate() {
            if is_alt(*mode) || self.state[n] == *default || self.changed[n] >= start {
                continue;
            }
            out.push_str(&format!(
                "\x1b[?{mode}{}",
                if self.state[n] { 'h' } else { 'l' }
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
fn utf16_tail(text: &str, limit: usize) -> Vec<u16> {
    let mut reversed = Vec::with_capacity(limit);
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
    reversed
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
        p.feed("한글😀\x1b[?1049h\x1b[?2004h", 900.0, true);
        assert_eq!(p.preamble(884.0), "");
        assert_eq!(p.preamble(901.0), "\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h");
        p.feed("\x1b[!p", 904.0, true);
        assert!(p.alt_screen());
        assert!(!p.is_set(2004));
    }
    #[test]
    fn osc_is_bounded_and_keeps_reference_chunk_contract() {
        let mut p = OutputInterpreter::default();
        assert!(p.feed("\x1b]7;file:///한", 0.0, true).is_empty());
        assert_eq!(
            p.feed("글\x07", 0.0, true),
            vec![OscEvent {
                code: 7.0,
                data: "file:///한글".into()
            }]
        );
        p.feed(&format!("\x1b]7;{}", "x".repeat(MAX_OSC)), 0.0, true);
        assert!(p.feed("\x07", 0.0, true).is_empty());
        assert_eq!(p.feed("\x1b]133;C\x1b\\", 0.0, true)[0].data, "C");
    }
    #[test]
    fn osc_introducer_and_terminator_split_across_chunks() {
        for (osc, data) in [("\x1b]133;D;0\x07", "D;0"), ("\x1b]133;A\x1b\\", "A")] {
            let stream = format!("out{osc}put");
            for at in 0..=stream.len() {
                let mut p = OutputInterpreter::default();
                let mut events = p.feed(&stream[..at], 0.0, true);
                events.extend(p.feed(&stream[at..], 0.0, true));
                let want = vec![OscEvent {
                    code: 133.0,
                    data: data.into(),
                }];
                assert_eq!(events, want, "split at {at}");
            }
        }
        // An ESC inside an OSC that the next chunk does not pair stays payload.
        let mut p = OutputInterpreter::default();
        assert!(p.feed("\x1b]2;ti\x1b", 0.0, true).is_empty());
        assert_eq!(p.feed("tle\x07", 0.0, true)[0].data, "ti\x1btle");
    }
    #[test]
    fn mode_seeding_does_not_reemit_historical_osc() {
        let mut p = OutputInterpreter::default();
        assert!(p.feed("\x1b[?1049h\x1b]133;C\x07", 30.0, false).is_empty());
        assert!(p.alt_screen());
        assert!(p.feed("\x07", 31.0, true).is_empty());
    }
    #[test]
    fn large_osc_storage_is_released_on_termination_and_overflow() {
        for terminator in ["\x07", "\x1b\\", "x"] {
            let mut p = OutputInterpreter::default();
            p.feed(&format!("\x1b]52;{}", "a".repeat(MAX_OSC - 3)), 0.0, true);
            assert!(p.in_osc);
            assert!(p.osc.capacity() >= MAX_OSC);
            let events = p.feed(terminator, 0.0, true);
            assert_eq!(events.len(), usize::from(terminator != "x"));
            assert!(!p.in_osc);
            assert!(p.osc.capacity() <= RETAIN_OSC);
            assert_eq!(p.feed("\x1b]2;next\x07", 0.0, true)[0].data, "next");
        }
    }
}
