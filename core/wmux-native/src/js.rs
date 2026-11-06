//! The slice of JavaScript value semantics the hook bridge depends on.
//!
//! The Node bridge reads stdin with `Buffer#toString('utf8')`, `String#trim`
//! and `JSON.parse`, and writes with `JSON.stringify`. Matching its envelope
//! byte for byte (and its logs in substance) means matching those, including
//! where they differ from serde-style JSON: strings are UTF-16 (a lone
//! surrogate parses and is re-escaped as `\udXXX`), `trim` has its own
//! whitespace set, duplicate keys keep the first position with the last value,
//! an object lists its array-index keys first, in ascending order, and nesting
//! depth is unbounded. So strings here are UTF-16 code units and the parser is
//! iterative.
//!
//! Where this differs from V8, on purpose:
//! - `stringify` and `Clone` recurse. A caller logging a value nested deeper
//!   than 1000 levels refuses it first and reports V8's RangeError message
//!   (hook.rs), where V8's own limit depends on its stack size, so a value
//!   between 1000 levels and that limit is logged by Node and not here.
//! - `number` formats only what `JSON.stringify` writes: finite numbers, and
//!   `null` for the rest.

/// A JavaScript string: UTF-16 code units, lone surrogates allowed.
pub type JsStr = Vec<u16>;

pub fn js(s: &str) -> JsStr {
    s.encode_utf16().collect()
}

/// Lossy UTF-8 view, for paths and log text only (never for payload fields).
pub fn lossy(s: &[u16]) -> String {
    String::from_utf16_lossy(s)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(JsStr),
    Arr(Vec<Json>),
    /// Insertion order, as a JS object keeps it for non-index keys.
    Obj(Vec<(JsStr, Json)>),
}

/// Iterative drop: a payload nests as deep as its author likes, and the
/// derived recursive drop would overflow the stack where JSON.parse does not.
impl Drop for Json {
    fn drop(&mut self) {
        let mut pending: Vec<Json> = Vec::new();
        let take = |v: &mut Json, pending: &mut Vec<Json>| match v {
            Json::Arr(items) => pending.append(items),
            Json::Obj(entries) => pending.extend(entries.drain(..).map(|(_, v)| v)),
            _ => {}
        };
        take(self, &mut pending);
        while let Some(mut v) = pending.pop() {
            take(&mut v, &mut pending);
        }
    }
}

impl Json {
    /// An own property of an object; None for a missing key or a non-object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => {
                let key = js(key);
                entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
            }
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&JsStr> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// True when the value nests deeper than `limit` (checked iteratively).
    pub fn deeper_than(&self, limit: usize) -> bool {
        let mut pending: Vec<(&Json, usize)> = vec![(self, 0)];
        while let Some((v, depth)) = pending.pop() {
            if depth > limit {
                return true;
            }
            match v {
                Json::Arr(items) => pending.extend(items.iter().map(|i| (i, depth + 1))),
                Json::Obj(entries) => pending.extend(entries.iter().map(|(_, i)| (i, depth + 1))),
                _ => {}
            }
        }
        false
    }
}

/// ECMAScript WhiteSpace plus LineTerminator: what `trim` removes and what
/// a regex `\s` matches.
pub fn is_space(c: u16) -> bool {
    matches!(
        c,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// `String.prototype.trim`: ECMAScript WhiteSpace plus LineTerminator.
pub fn trim(s: &[u16]) -> &[u16] {
    let ws = is_space;
    let start = s.iter().position(|&c| !ws(c)).unwrap_or(s.len());
    let end = s.iter().rposition(|&c| !ws(c)).map_or(start, |i| i + 1);
    &s[start..end]
}

/// `Buffer#toString('utf8')` then trim, as UTF-16.
pub fn decode_utf8_trimmed(bytes: &[u8]) -> JsStr {
    let units = js(&String::from_utf8_lossy(bytes));
    trim(&units).to_vec()
}

// ----- JSON.parse ----------------------------------------------------------

/// An open object keeps a key index, so a duplicate key overwrites in place
/// (first position, last value, as a JS property assignment) in O(1).
enum Frame {
    Arr(Vec<Json>),
    Obj(Vec<(JsStr, Json)>, std::collections::HashMap<JsStr, usize>, JsStr),
}

struct Parser<'a> {
    s: &'a [u16],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], 0x20 | 0x09 | 0x0A | 0x0D) {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u16> {
        self.s.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> Result<(), ()> {
        if self.peek() == Some(c as u16) {
            self.i += 1;
            Ok(())
        } else {
            Err(())
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Result<Json, ()> {
        for b in word.bytes() {
            self.eat(b)?;
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<JsStr, ()> {
        self.eat(b'"')?;
        let mut out = Vec::new();
        loop {
            let c = self.peek().ok_or(())?;
            self.i += 1;
            match c {
                0x22 => return Ok(out),
                0x5C => {
                    let e = self.peek().ok_or(())?;
                    self.i += 1;
                    out.push(match e {
                        0x22 => 0x22,
                        0x5C => 0x5C,
                        0x2F => 0x2F,
                        0x62 => 0x08,
                        0x66 => 0x0C,
                        0x6E => 0x0A,
                        0x72 => 0x0D,
                        0x74 => 0x09,
                        0x75 => {
                            let hex = self.s.get(self.i..self.i + 4).ok_or(())?;
                            let mut v: u16 = 0;
                            for &h in hex {
                                let d = (h as u8 as char).to_digit(16).filter(|_| h < 0x80).ok_or(())?;
                                v = v * 16 + d as u16;
                            }
                            self.i += 4;
                            v
                        }
                        _ => return Err(()),
                    });
                }
                c if c < 0x20 => return Err(()),
                c => out.push(c),
            }
        }
    }

    fn number(&mut self) -> Result<Json, ()> {
        let start = self.i;
        let digits = |p: &mut Self| {
            let from = p.i;
            while matches!(p.peek(), Some(0x30..=0x39)) {
                p.i += 1;
            }
            p.i - from
        };
        if self.peek() == Some(0x2D) {
            self.i += 1;
        }
        match self.peek() {
            Some(0x30) => self.i += 1,
            Some(0x31..=0x39) => {
                digits(self);
            }
            _ => return Err(()),
        }
        if self.peek() == Some(0x2E) {
            self.i += 1;
            if digits(self) == 0 {
                return Err(());
            }
        }
        if matches!(self.peek(), Some(0x65 | 0x45)) {
            self.i += 1;
            if matches!(self.peek(), Some(0x2B | 0x2D)) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(());
            }
        }
        let text: String = self.s[start..self.i].iter().map(|&c| c as u8 as char).collect();
        text.parse::<f64>().map(Json::Num).map_err(|_| ())
    }

    /// A scalar, or None after pushing a frame for an opened container.
    fn value(&mut self, stack: &mut Vec<Frame>) -> Result<Option<Json>, ()> {
        self.ws();
        match self.peek().ok_or(())? {
            0x7B => {
                self.i += 1;
                self.ws();
                if self.eat(b'}').is_ok() {
                    return Ok(Some(Json::Obj(Vec::new())));
                }
                let key = self.key()?;
                stack.push(Frame::Obj(Vec::new(), Default::default(), key));
                Ok(None)
            }
            0x5B => {
                self.i += 1;
                self.ws();
                if self.eat(b']').is_ok() {
                    return Ok(Some(Json::Arr(Vec::new())));
                }
                stack.push(Frame::Arr(Vec::new()));
                Ok(None)
            }
            0x22 => self.string().map(|s| Some(Json::Str(s))),
            0x74 => self.literal("true", Json::Bool(true)).map(Some),
            0x66 => self.literal("false", Json::Bool(false)).map(Some),
            0x6E => self.literal("null", Json::Null).map(Some),
            _ => self.number().map(Some),
        }
    }

    fn key(&mut self) -> Result<JsStr, ()> {
        self.ws();
        let key = self.string()?;
        self.ws();
        self.eat(b':')?;
        Ok(key)
    }
}

/// `JSON.parse` over UTF-16 text. Err is a SyntaxError.
pub fn parse(s: &[u16]) -> Result<Json, ()> {
    let mut p = Parser { s, i: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    let mut done = p.value(&mut stack)?;
    loop {
        // `done` is a completed value; fold it into the innermost frame.
        let Some(value) = done.take() else {
            done = p.value(&mut stack)?;
            continue;
        };
        let Some(frame) = stack.last_mut() else {
            p.ws();
            return if p.i == s.len() { Ok(value) } else { Err(()) };
        };
        match frame {
            Frame::Arr(items) => items.push(value),
            Frame::Obj(entries, index, key) => match index.get(&*key) {
                Some(&at) => entries[at].1 = value,
                None => {
                    index.insert(key.clone(), entries.len());
                    entries.push((std::mem::take(key), value));
                }
            },
        }
        p.ws();
        if p.eat(b',').is_ok() {
            if let Some(Frame::Obj(_, _, key)) = stack.last_mut() {
                *key = p.key()?;
            }
            continue;
        }
        let closed = match stack.pop() {
            Some(Frame::Arr(items)) => p.eat(b']').map(|_| Json::Arr(items)),
            Some(Frame::Obj(entries, _, _)) => p.eat(b'}').map(|_| Json::Obj(entries)),
            None => Err(()),
        }?;
        done = Some(closed);
    }
}

// ----- JSON.stringify ------------------------------------------------------

/// `JSON.stringify` of a string (well-formed: lone surrogates escaped).
pub fn quote(s: &[u16], out: &mut String) {
    out.push('"');
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        match c {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0C => out.push_str("\\f"),
            0x0A => out.push_str("\\n"),
            0x0D => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            c if c < 0x20 => out.push_str(&format!("\\u{c:04x}")),
            0xD800..=0xDBFF if matches!(s.get(i + 1), Some(0xDC00..=0xDFFF)) => {
                out.push_str(&String::from_utf16_lossy(&s[i..i + 2]));
                i += 1;
            }
            0xD800..=0xDFFF => out.push_str(&format!("\\u{c:04x}")),
            c => out.push(char::from_u32(c as u32).unwrap_or('\u{FFFD}')),
        }
        i += 1;
    }
    out.push('"');
}

pub fn quote_str(s: &str, out: &mut String) {
    quote(&js(s), out);
}

/// `Number.prototype.toString()` for a finite f64; JSON.stringify writes
/// `null` for a non-finite one.
pub fn number(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    // Shortest round-trip digits and exponent, then ECMAScript's layout rules.
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| c.is_ascii_digit()).collect();
    let k = digits.len() as i32;
    let point = exp.parse::<i32>().unwrap_or(0) + 1; // ECMAScript's n
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let e = point - 1;
        let sign = if e >= 0 { "+" } else { "-" };
        let m = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{m}e{sign}{}", e.abs())
    };
    if n < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// A canonical array index ("0", or digits without a leading zero, at most
/// 2^32 - 2), which V8 keeps apart from the other keys of an object.
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == 0x30) {
        return None;
    }
    let mut value: u64 = 0;
    for &c in key {
        if !(0x30..=0x39).contains(&c) {
            return None;
        }
        value = value * 10 + u64::from(c - 0x30);
    }
    (value <= 4_294_967_294).then_some(value as u32)
}

/// The order V8 lists an object's own keys in: array indices ascending, then
/// every other key in insertion order.
fn v8_key_order(entries: &[(JsStr, Json)]) -> Vec<&(JsStr, Json)> {
    let mut indexed: Vec<(u32, &(JsStr, Json))> = entries
        .iter()
        .filter_map(|e| array_index(&e.0).map(|i| (i, e)))
        .collect();
    indexed.sort_by_key(|(i, _)| *i);
    let mut order: Vec<&(JsStr, Json)> = indexed.into_iter().map(|(_, e)| e).collect();
    order.extend(entries.iter().filter(|e| array_index(&e.0).is_none()));
    order
}

/// `Object.keys(o)`, in V8's order.
pub fn object_keys(entries: &[(JsStr, Json)]) -> Vec<JsStr> {
    v8_key_order(entries).into_iter().map(|(k, _)| k.clone()).collect()
}

/// `o[key] = value` on an object's entries: an existing key keeps its place.
pub fn assign(entries: &mut Vec<(JsStr, Json)>, key: JsStr, value: Json) {
    match entries.iter_mut().find(|(k, _)| *k == key) {
        Some(slot) => slot.1 = value,
        None => entries.push((key, value)),
    }
}

/// `{...v}`: an object's own entries; an array's elements under their
/// indices; a string's UTF-16 units under theirs; nothing for anything else.
pub fn spread(v: &Json) -> Vec<(JsStr, Json)> {
    match v {
        Json::Obj(entries) => entries.clone(),
        Json::Arr(items) => items.iter().enumerate().map(|(i, x)| (js(&i.to_string()), x.clone())).collect(),
        Json::Str(s) => s.iter().enumerate().map(|(i, u)| (js(&i.to_string()), Json::Str(vec![*u]))).collect(),
        _ => Vec::new(),
    }
}

/// JavaScript truthiness of an optional value (absent is `undefined`).
pub fn truthy(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) | Some(Json::Bool(false)) => false,
        Some(Json::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Json::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub fn stringify(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => out.push_str(&number(*n)),
        Json::Str(s) => quote(s, out),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                stringify(item, out);
            }
            out.push(']');
        }
        Json::Obj(entries) => {
            out.push('{');
            for (i, (k, item)) in v8_key_order(entries).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(k, out);
                out.push(':');
                stringify(item, out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Result<Json, ()> {
        parse(&js(s))
    }

    fn roundtrip(s: &str) -> String {
        let mut out = String::new();
        stringify(&p(s).expect(s), &mut out);
        out
    }

    #[test]
    fn parses_and_reserialises_like_v8() {
        assert_eq!(
            roundtrip(r#" {"a":[1,2.5,-0.0,1e21,1e-7,123456789012345680000],"b":{"c":null},"d":"x\u0001\ud800y"} "#),
            r#"{"a":[1,2.5,0,1e+21,1e-7,123456789012345680000],"b":{"c":null},"d":"x\u0001\ud800y"}"#
        );
        // Duplicate key: first position, last value.
        assert_eq!(roundtrip(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);
        assert_eq!(roundtrip(r#"[[],{},"\/\b\f\n\r\t"]"#), r#"[[],{},"/\b\f\n\r\t"]"#);
        assert_eq!(number(0.1), "0.1");
        assert_eq!(number(-1.5e-10), "-1.5e-10");
        assert_eq!(number(1e300), "1e+300");
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        for bad in [
            "",
            "{",
            "[1,]",
            "{\"a\":1,}",
            "01",
            "1.",
            ".5",
            "+1",
            "'a'",
            "\"\t\"",
            "{a:1}",
            "[1] x",
            "\"\\x\"",
            "nul",
            "\"\\u12\"",
        ] {
            assert!(p(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn stringify_lists_array_index_keys_first_as_v8_does() {
        // node -e 'JSON.stringify(JSON.parse(input))'
        assert_eq!(
            roundtrip(r#"{"b":1,"2":2,"a":3,"1":4,"01":5,"4294967294":6,"4294967295":7,"0":8,"-1":9,"1.5":10}"#),
            r#"{"0":8,"1":4,"2":2,"4294967294":6,"b":1,"a":3,"01":5,"4294967295":7,"-1":9,"1.5":10}"#
        );
        // Nested objects too; arrays keep their order.
        assert_eq!(
            roundtrip(r#"[{"z":{"9":0,"y":1,"10":2}}]"#),
            r#"[{"z":{"9":0,"10":2,"y":1}}]"#
        );
    }

    #[test]
    fn many_keys_parse_in_linear_time() {
        let body: Vec<String> = (0..200_000).map(|i| format!("\"k{i}\":{i}")).collect();
        let started = std::time::Instant::now();
        let parsed = p(&format!("{{{}}}", body.join(","))).unwrap();
        let Json::Obj(entries) = &parsed else { panic!() };
        assert_eq!(entries.len(), 200_000);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn measures_depth_without_recursion() {
        let deep = p(&format!("{}{}", "[".repeat(100_000), "]".repeat(100_000))).unwrap();
        assert!(deep.deeper_than(1000));
        assert!(!p("[[1],{\"a\":[2]}]").unwrap().deeper_than(3));
        assert!(p("[[1],{\"a\":[2]}]").unwrap().deeper_than(2));
    }

    #[test]
    fn deep_nesting_does_not_overflow_the_stack() {
        let deep = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
        assert!(p(&deep).is_ok());
    }

    #[test]
    fn trims_the_ecmascript_whitespace_set() {
        assert_eq!(trim(&js("\u{FEFF}\u{A0} x \u{2029}\n")), js("x").as_slice());
        // U+0085 is Unicode White_Space but not ECMAScript whitespace.
        assert_eq!(trim(&js("\u{85}x")), js("\u{85}x").as_slice());
    }
}
