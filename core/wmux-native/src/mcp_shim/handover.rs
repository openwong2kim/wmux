//! What the shim reads of the MCP traffic it pumps, so a session survives the
//! broker going away after the ack (see the module doc of mcp_shim.rs).
//!
//! MCP over stdio is newline-delimited JSON-RPC. The shim splits both
//! directions into lines and reads only the top level of each message: its
//! id, its method, and whether it carries an error. Values are skipped
//! unparsed, so a large tool result costs one pass over its bytes. Ids and
//! method names are small tokens read with crate::js.
//!
//! `Calls` keeps what a handover needs: the ids of the host's requests the
//! broker has not answered yet (less those the host cancelled), and the host's
//! `initialize` request and `notifications/initialized` notification.

use crate::js::{self, Json};

/// The id the replayed `initialize` carries, so its reply can be told apart
/// from the host's own calls and dropped.
pub const REPLAY_ID: &str = "wmux-shim-replay";

/// The error message for a call the broker took and never answered. It is
/// what the model reads, so it says plainly not to assume the call did nothing.
pub const MAY_HAVE_RUN: &str = "The wmux MCP broker stopped while this call was in flight, so it may have run. \
It was not retried. Do not assume it did not run: check its effect before you repeat it. \
Later calls go to a new wmux MCP server.";

/// The JSON-RPC error code for MAY_HAVE_RUN (implementation-defined server error).
pub const MAY_HAVE_RUN_CODE: i32 = -32000;

/// Splits a byte stream into lines, each with its `\n`.
#[derive(Default)]
pub struct Lines {
    partial: Vec<u8>,
}

impl Lines {
    /// Calls `each` with every line `chunk` completes, in order. Bytes after
    /// the last `\n` wait for the next chunk.
    pub fn push(&mut self, chunk: &[u8], mut each: impl FnMut(&[u8])) {
        let mut rest = chunk;
        while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
            let (line, after) = rest.split_at(nl + 1);
            if self.partial.is_empty() {
                each(line);
            } else {
                self.partial.extend_from_slice(line);
                each(&std::mem::take(&mut self.partial));
            }
            rest = after;
        }
        self.partial.extend_from_slice(rest);
    }

    /// The bytes after the last `\n`, which no line holds.
    pub fn take_rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.partial)
    }
}

/// The top level of one JSON-RPC message.
#[derive(Debug, Default, PartialEq)]
pub struct Peek {
    /// The id as canonical JSON text (`7`, `"a"`); None for a missing, null
    /// or other id.
    pub id: Option<String>,
    /// Where the id's value sits in the line.
    pub id_span: Option<(usize, usize)>,
    /// The method name of a request or a notification.
    pub method: Option<String>,
    /// The message has an `error` member (a failed response).
    pub error: bool,
    /// Where the `params` value sits in the line.
    pub params_span: Option<(usize, usize)>,
}

/// The messages of one line: one for an object, one per object of a batch,
/// none for anything else (not JSON, or not an object).
pub fn peek(line: &[u8]) -> Vec<Peek> {
    let mut s = Scan { b: line, i: 0 };
    s.ws();
    match line.get(s.i) {
        Some(b'{') => s.object().into_iter().collect(),
        Some(b'[') => s.batch().unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// A small JSON token (a key, an id, a method) through crate::js.
fn token(bytes: &[u8]) -> Option<Json> {
    js::parse(&js::js(std::str::from_utf8(bytes).ok()?)).ok()
}

struct Scan<'a> {
    b: &'a [u8],
    i: usize,
}

impl Scan<'_> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Option<()> {
        (self.b.get(self.i) == Some(&c)).then(|| self.i += 1)
    }

    /// A string at `i`: its span, quotes included, and whether it has escapes.
    fn string(&mut self) -> Option<(usize, usize, bool)> {
        let start = self.i;
        self.eat(b'"')?;
        let mut escaped = false;
        loop {
            match *self.b.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    return Some((start, self.i, escaped));
                }
                b'\\' => {
                    escaped = true;
                    self.i += 2;
                }
                _ => self.i += 1,
            }
        }
    }

    /// Any value at `i`, skipped: its span.
    fn value(&mut self) -> Option<(usize, usize)> {
        let start = self.i;
        match *self.b.get(self.i)? {
            b'"' => self.string().map(|(s, e, _)| (s, e)),
            b'{' | b'[' => {
                let mut depth = 0usize;
                loop {
                    match *self.b.get(self.i)? {
                        b'"' => {
                            self.string()?;
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                self.i += 1;
                                return Some((start, self.i));
                            }
                        }
                        _ => {}
                    }
                    self.i += 1;
                }
            }
            _ => {
                while !matches!(
                    self.b.get(self.i),
                    None | Some(b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
                ) {
                    self.i += 1;
                }
                (self.i > start).then_some((start, self.i))
            }
        }
    }

    /// An object at `i`. A key seen twice keeps its last value, as JSON.parse does.
    fn object(&mut self) -> Option<Peek> {
        self.eat(b'{')?;
        let mut peek = Peek::default();
        self.ws();
        if self.eat(b'}').is_some() {
            return Some(peek);
        }
        loop {
            self.ws();
            let (ks, ke, escaped) = self.string()?;
            let raw = &self.b[ks + 1..ke - 1];
            let decoded;
            let key: &[u8] = if escaped {
                decoded = match &token(&self.b[ks..ke])? {
                    Json::Str(s) => js::lossy(s).into_bytes(),
                    _ => return None,
                };
                &decoded
            } else {
                raw
            };
            self.ws();
            self.eat(b':')?;
            self.ws();
            let (vs, ve) = self.value()?;
            match key {
                b"id" => {
                    peek.id = match token(&self.b[vs..ve]) {
                        Some(v @ (Json::Num(_) | Json::Str(_))) => {
                            let mut out = String::new();
                            js::stringify(&v, &mut out);
                            Some(out)
                        }
                        _ => None,
                    };
                    peek.id_span = Some((vs, ve));
                }
                b"method" => {
                    peek.method = match &token(&self.b[vs..ve]) {
                        Some(Json::Str(s)) => Some(js::lossy(s)),
                        _ => None,
                    };
                }
                b"error" => peek.error = true,
                b"params" => peek.params_span = Some((vs, ve)),
                _ => {}
            }
            self.ws();
            match *self.b.get(self.i)? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(peek);
                }
                _ => return None,
            }
        }
    }

    /// A batch at `i`: the objects in it.
    fn batch(&mut self) -> Option<Vec<Peek>> {
        self.eat(b'[')?;
        let mut out = Vec::new();
        self.ws();
        if self.eat(b']').is_some() {
            return Some(out);
        }
        loop {
            self.ws();
            if self.b.get(self.i) == Some(&b'{') {
                out.push(self.object()?);
            } else {
                self.value()?;
            }
            self.ws();
            match *self.b.get(self.i)? {
                b',' => self.i += 1,
                b']' => return Some(out),
                _ => return None,
            }
        }
    }
}

/// The error the host gets for each call in flight at a handover. `id` is the
/// id as the host spelled it, so the host matches it whatever its number form.
pub fn may_have_run(id: &[u8]) -> Vec<u8> {
    let mut message = String::new();
    js::quote_str(MAY_HAVE_RUN, &mut message);
    let mut out = b"{\"jsonrpc\":\"2.0\",\"id\":".to_vec();
    out.extend_from_slice(id);
    out.extend_from_slice(format!(",\"error\":{{\"code\":{MAY_HAVE_RUN_CODE},\"message\":{message}}}}}\n").as_bytes());
    out
}

/// The reply to the replayed `initialize`: Some(true) when it is an error.
pub fn replay_answer(line: &[u8]) -> Option<bool> {
    let mut replay = String::new();
    js::quote_str(REPLAY_ID, &mut replay);
    match peek(line).as_slice() {
        [p] if p.method.is_none() && p.id.as_deref() == Some(replay.as_str()) => Some(p.error),
        _ => None,
    }
}

/// The request a `notifications/cancelled` names (its params.requestId), as
/// canonical JSON text.
fn cancelled_id(line: &[u8], params: Option<(usize, usize)>) -> Option<String> {
    let (s, e) = params?;
    let parsed = token(&line[s..e])?;
    let Json::Obj(entries) = &parsed else { return None };
    let (_, v) = entries.iter().rev().find(|(k, _)| *k == js::js("requestId"))?;
    match v {
        Json::Num(_) | Json::Str(_) => {
            let mut out = String::new();
            js::stringify(v, &mut out);
            Some(out)
        }
        _ => None,
    }
}

/// What the host has asked that the broker still owes it, and what a new
/// server needs to take the session over.
#[derive(Default)]
pub struct Calls {
    /// Each request owed an answer: its canonical id, and the id as the host
    /// spelled it.
    in_flight: Vec<(String, Vec<u8>)>,
    /// The host's `initialize` request (the whole line), with its id.
    init: Option<(Vec<u8>, String)>,
    init_answered: bool,
    initialized: Option<Vec<u8>>,
    handed_over: bool,
}

impl Calls {
    /// A line from the host, before it goes to the broker.
    pub fn sent(&mut self, line: &[u8]) {
        if self.handed_over {
            return;
        }
        let batch = line.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'[');
        for p in peek(line) {
            match (&p.id, p.method.as_deref()) {
                (Some(id), Some(method)) => {
                    // A batched initialize is not cached: MCP never batches it.
                    if let (false, "initialize", Some((s, e))) = (batch, method, p.id_span) {
                        let mut quoted = String::new();
                        js::quote_str(REPLAY_ID, &mut quoted);
                        let mut replay = Vec::with_capacity(line.len());
                        replay.extend_from_slice(&line[..s]);
                        replay.extend_from_slice(quoted.as_bytes());
                        replay.extend_from_slice(&line[e..]);
                        self.init = Some((replay, id.clone()));
                        self.init_answered = false;
                    }
                    let raw = p.id_span.map(|(s, e)| line[s..e].to_vec()).unwrap_or_default();
                    self.in_flight.push((id.clone(), raw));
                }
                (None, Some("notifications/initialized")) => self.initialized = Some(line.to_vec()),
                // A cancelled request gets no answer (MCP), so it is owed none.
                (None, Some("notifications/cancelled")) => {
                    if let Some(id) = cancelled_id(line, p.params_span) {
                        if let Some(at) = self.in_flight.iter().position(|(x, _)| *x == id) {
                            self.in_flight.remove(at);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// A line from the broker. False once the session has been handed over:
    /// the line is dropped (its call was already answered with an error).
    pub fn answered(&mut self, line: &[u8]) -> bool {
        if self.handed_over {
            return false;
        }
        for p in peek(line) {
            let (Some(id), None) = (p.id, p.method) else { continue };
            if let Some(at) = self.in_flight.iter().position(|(x, _)| *x == id) {
                self.in_flight.remove(at);
            }
            if self.init.as_ref().is_some_and(|(_, init)| *init == id) {
                self.init_answered = !p.error;
            }
        }
        true
    }

    /// The handover, once: the ids to answer with MAY_HAVE_RUN (as the host
    /// spelled them), and the lines
    /// a new server gets first (the `initialize` under REPLAY_ID and the
    /// `initialized` notification, only when the broker answered that
    /// `initialize` with a result).
    pub fn hand_over(&mut self) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
        self.handed_over = true;
        let ids = std::mem::take(&mut self.in_flight)
            .into_iter()
            .map(|(_, raw)| raw)
            .collect();
        let mut replay = Vec::new();
        if self.init_answered {
            if let Some((line, _)) = self.init.take() {
                replay.push(line);
                replay.extend(self.initialized.take());
            }
        }
        (ids, replay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_lines(chunks: &[&[u8]]) -> (Vec<Vec<u8>>, Vec<u8>) {
        let mut lines = Lines::default();
        let mut out = Vec::new();
        for c in chunks {
            lines.push(c, |l| out.push(l.to_vec()));
        }
        (out, lines.take_rest())
    }

    #[test]
    fn lines_split_across_chunks_keep_their_newlines() {
        let (out, rest) = all_lines(&[b"{\"a\":1}\n{\"b\"", b":2}\n\n{\"c\":", b"3}"]);
        assert_eq!(
            out,
            vec![b"{\"a\":1}\n".to_vec(), b"{\"b\":2}\n".to_vec(), b"\n".to_vec()]
        );
        assert_eq!(rest, b"{\"c\":3}");
    }

    #[test]
    fn peek_reads_only_the_top_level() {
        let line = br#"{"jsonrpc":"2.0","result":{"id":9,"method":"x","content":[{"text":"a \"}\" b"}]},"id":4}"#;
        assert_eq!(
            peek(line),
            vec![Peek {
                id: Some("4".into()),
                id_span: Some((line.len() - 2, line.len() - 1)),
                method: None,
                error: false,
                params_span: None,
            }]
        );
        let req = peek(br#" {"id":"a\u0062","method":"tools\/call","params":{}} "#);
        assert_eq!(req[0].id.as_deref(), Some("\"ab\""));
        assert_eq!(req[0].method.as_deref(), Some("tools/call"));
        assert!(peek(br#"{"id":1,"error":{"code":1}}"#)[0].error);
    }

    #[test]
    fn ids_compare_as_values_not_as_spellings() {
        assert_eq!(peek(br#"{"id":1.0}"#)[0].id, peek(br#"{"id":1}"#)[0].id);
        assert_eq!(
            peek(br#"{"id":"\u00e9"}"#)[0].id,
            peek("{\"id\":\"\u{e9}\"}".as_bytes())[0].id
        );
        assert_eq!(peek(br#"{"id":null}"#)[0].id, None);
        assert_eq!(peek(br#"{"\u0069d":3}"#)[0].id.as_deref(), Some("3"));
        // The last of a repeated key wins, as in JSON.parse.
        assert_eq!(peek(br#"{"id":1,"id":2}"#)[0].id.as_deref(), Some("2"));
    }

    #[test]
    fn a_batch_is_one_message_per_object_and_junk_is_none() {
        let p = peek(br#"[{"id":1,"method":"a"},7,{"id":2,"method":"b"}]"#);
        assert_eq!(p.iter().map(|m| m.id.clone().unwrap()).collect::<Vec<_>>(), ["1", "2"]);
        for junk in [
            &b"not json"[..],
            b"{\"id\":1",
            b"{\"id\" 1}",
            b"\"str\"",
            b"",
            b"{\"a\":\"\\",
        ] {
            assert!(peek(junk).is_empty(), "{}", String::from_utf8_lossy(junk));
        }
    }

    const INIT: &[u8] =
        b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n";
    const INITIALIZED: &[u8] = b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";

    #[test]
    fn a_handover_answers_what_is_in_flight_and_replays_the_initialize() {
        let mut c = Calls::default();
        c.sent(INIT);
        assert!(c.answered(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{}}\n"));
        c.sent(INITIALIZED);
        c.sent(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n");
        c.sent(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\"}\n");
        c.sent(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\"}\n");
        c.sent(b"{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}\n"); // the host answering the server
        assert!(c.answered(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"));
        assert!(c.answered(b"{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"roots/list\"}\n"));
        let (ids, replay) = c.hand_over();
        assert_eq!(ids, [b"2".to_vec()]);
        assert_eq!(
            replay,
            vec![
                b"{\"jsonrpc\":\"2.0\",\"id\":\"wmux-shim-replay\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n".to_vec(),
                INITIALIZED.to_vec()
            ]
        );
        // After the handover the broker's lines are dropped, the host's untracked.
        assert!(!c.answered(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n"));
        c.sent(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n");
        assert_eq!(c.hand_over(), (vec![], vec![]));
    }

    #[test]
    fn an_unanswered_or_failed_initialize_is_not_replayed() {
        let mut c = Calls::default();
        c.sent(INIT);
        assert_eq!(c.hand_over(), (vec![b"0".to_vec()], vec![]));
        let mut c = Calls::default();
        c.sent(INIT);
        c.answered(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"error\":{\"code\":-1,\"message\":\"no\"}}\n");
        c.sent(INITIALIZED);
        assert_eq!(c.hand_over(), (vec![], vec![]));
    }

    #[test]
    fn a_repeated_id_is_owed_once_per_request() {
        let mut c = Calls::default();
        c.sent(b"{\"id\":1,\"method\":\"a\"}\n");
        c.sent(b"{\"id\":1,\"method\":\"b\"}\n");
        c.answered(b"{\"id\":1,\"result\":0}\n");
        assert_eq!(c.hand_over().0, [b"1".to_vec()]);
    }

    #[test]
    fn a_cancelled_request_is_owed_nothing_and_ids_keep_the_hosts_spelling() {
        let mut c = Calls::default();
        c.sent(b"{\"id\":7,\"method\":\"tools/call\"}\n");
        c.sent(b"{\"id\":1e2,\"method\":\"tools/call\"}\n");
        c.sent(b"{\"id\":\"x\",\"method\":\"tools/call\"}\n");
        c.sent(b"{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":7.0,\"reason\":\"r\"}}\n");
        // A cancel for nothing owed, or with no usable id, changes nothing.
        c.sent(b"{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":99}}\n");
        c.sent(b"{\"method\":\"notifications/cancelled\",\"params\":{}}\n");
        assert_eq!(c.hand_over().0, [b"1e2".to_vec(), b"\"x\"".to_vec()]);
    }

    #[test]
    fn the_error_frame_and_the_replay_answer() {
        let frame = String::from_utf8(may_have_run(b"\"a\"")).unwrap();
        let p = peek(frame.as_bytes());
        assert_eq!((p[0].id.as_deref(), p[0].error), (Some("\"a\""), true));
        assert!(
            frame.ends_with("}}\n")
                && frame.contains("\"code\":-32000")
                && frame.contains("Do not assume it did not run")
        );
        assert_eq!(
            replay_answer(b"{\"jsonrpc\":\"2.0\",\"id\":\"wmux-shim-replay\",\"result\":{}}\n"),
            Some(false)
        );
        assert_eq!(
            replay_answer(b"{\"jsonrpc\":\"2.0\",\"id\":\"wmux-shim-replay\",\"error\":{\"code\":-1}}\n"),
            Some(true)
        );
        assert_eq!(
            replay_answer(b"{\"jsonrpc\":\"2.0\",\"id\":\"wmux-shim-replay\",\"method\":\"x\"}\n"),
            None
        );
        assert_eq!(replay_answer(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{}}\n"), None);
    }
}
