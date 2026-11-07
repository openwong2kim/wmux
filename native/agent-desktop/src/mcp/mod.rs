//! Stdio MCP server. Every leaf CLI command is one tool, and every call runs that command through the CLI.

mod call;
mod calls;
mod catalog;

use clap::{ArgAction, ArgMatches, Command, CommandFactory, parser::ValueSource};
use serde_json::{Map, Value, json};
use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use crate::cli::Cli;

const MODERN_VERSION: &str = "2026-07-28";
const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PROTOCOL_VERSION_META: &str = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META: &str = "io.modelcontextprotocol/serverInfo";
const TOOLS_TTL_MS: u64 = 86_400_000;
const MAX_CONCURRENT_CALLS: usize = 8;
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const INSTRUCTIONS: &str = "\
agent-desktop reads native accessibility trees and operates desktop apps. Each tool runs the \
agent-desktop CLI command of the same name and returns its JSON envelope: ok with data, or ok \
false with error; a call rejected before the command runs returns plain text. Read \
desktop_skills_get with name \"desktop\" first for the observe-act loop, and with name \
\"platform\" for what differs on this OS. The skills use CLI syntax: `agent-desktop snapshot \
--app Finder` is desktop_snapshot with {\"app\": \"Finder\"}, and the input schema replaces \
--help. Global flags (--session, --agent-id, --headed, --wait-for, --trace) are fixed \
by how this server was started and cannot be passed per call. Refs such as @s8f3k2p9:e1 come from \
desktop_snapshot and go stale when the UI changes: on STALE_REF or AMBIGUOUS_TARGET, snapshot \
again. Repeat an action only when its disposition.retry is \"safe\".";

/// The `mcp` subcommand; it lives outside `Commands` because it serves commands rather than being one.
pub(crate) fn command() -> Command {
    Command::new("mcp").about(
        "Serve every command as an MCP tool over stdio; global flags given here apply to every call",
    )
}

/// Serves MCP over stdin and stdout until stdin closes, then finishes the tool calls already running.
/// At most `MAX_CONCURRENT_CALLS` calls run at once, and a message longer than `MAX_MESSAGE_BYTES` is refused unread.
pub(crate) fn serve(matches: &ArgMatches) -> ExitCode {
    let server = Arc::new(Server {
        tools: catalog::tools(),
        globals: forwarded_globals(matches),
        calls: calls::Calls::default(),
    });
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let mut input = std::io::stdin().lock();
    let mut running = Vec::new();
    while let Some(line) = read_message(&mut input) {
        let message = match line.map(|line| serde_json::from_slice::<Value>(&line)) {
            Ok(Ok(message)) if message.is_object() => message,
            Ok(Ok(_)) => {
                let error = RpcError::new(-32600, "Invalid Request: expected one JSON-RPC object");
                write_line(&out, &error.response(Value::Null));
                continue;
            }
            Ok(Err(error)) => {
                let error = RpcError::new(-32700, format!("Parse error: {error}"));
                write_line(&out, &error.response(Value::Null));
                continue;
            }
            Err(error) => {
                write_line(&out, &error.response(Value::Null));
                continue;
            }
        };
        let server = Arc::clone(&server);
        let out = Arc::clone(&out);
        if message["method"] != "tools/call" {
            server.respond(&out, &message);
            continue;
        }
        running.retain(|call: &std::thread::JoinHandle<()>| !call.is_finished());
        if running.len() >= MAX_CONCURRENT_CALLS {
            server.respond_busy(&out, &message);
            continue;
        }
        if let Some(id) = message.get("id") {
            if !server.calls.admit(id) {
                let error =
                    RpcError::new(-32600, "Invalid Request: a call with this id is running");
                write_line(&out, &error.response(id.clone()));
                continue;
            }
        }
        running.push(std::thread::spawn(move || server.respond(&out, &message)));
    }
    for call in running {
        let _ = call.join();
    }
    ExitCode::SUCCESS
}

fn read_message(input: &mut impl BufRead) -> Option<Result<Vec<u8>, RpcError>> {
    let mut line = Vec::new();
    loop {
        line.clear();
        let limit = u64::try_from(MAX_MESSAGE_BYTES).unwrap_or(u64::MAX) + 1;
        let read = std::io::Read::take(&mut *input, limit)
            .read_until(b'\n', &mut line)
            .ok()?;
        if read == 0 {
            return None;
        }
        if line.len() > MAX_MESSAGE_BYTES && line.last() != Some(&b'\n') {
            input.skip_until(b'\n').ok()?;
            return Some(Err(RpcError::new(
                -32600,
                format!("Invalid Request: message exceeds {MAX_MESSAGE_BYTES} bytes"),
            )));
        }
        if !line.trim_ascii().is_empty() {
            return Some(Ok(line));
        }
    }
}

struct Server {
    tools: Vec<catalog::Tool>,
    globals: Vec<String>,
    calls: calls::Calls,
}

impl Server {
    fn respond(&self, out: &Mutex<std::io::Stdout>, message: &Value) {
        if message["method"] == "notifications/cancelled" {
            if let Some(id) = message["params"].get("requestId") {
                self.calls.cancel(id);
            }
            return;
        }
        let Some(id) = message.get("id").cloned() else {
            return;
        };
        let method = message["method"].as_str().unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = self.handle(&id, method, &params);
        if method == "tools/call" && !self.calls.finish(&id) {
            return;
        }
        let response = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => error.response(id),
        };
        write_line(out, &response);
    }

    fn respond_busy(&self, out: &Mutex<std::io::Stdout>, message: &Value) {
        let Some(id) = message.get("id").cloned() else {
            return;
        };
        let text = format!(
            "{MAX_CONCURRENT_CALLS} tool calls are already running; retry when one finishes"
        );
        let result = json!({
            "content": [{ "type": "text", "text": text }],
            "isError": true,
            "resultType": "complete",
        });
        write_line(
            out,
            &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        );
    }

    fn handle(&self, id: &Value, method: &str, params: &Value) -> Result<Value, RpcError> {
        if let Some(requested) = params["_meta"][PROTOCOL_VERSION_META].as_str() {
            if requested != MODERN_VERSION {
                return Err(
                    RpcError::new(-32022, "Unsupported protocol version").with_data(
                        json!({ "supported": supported_versions(), "requested": requested }),
                    ),
                );
            }
        }
        let mut result = match method {
            "initialize" => initialize(params),
            "server/discover" => json!({
                "supportedVersions": supported_versions(),
                "capabilities": { "tools": {} },
                "instructions": INSTRUCTIONS,
                "ttlMs": TOOLS_TTL_MS,
                "cacheScope": "public",
            }),
            "ping" => json!({}),
            "tools/list" => json!({
                "tools": self.tools.iter().map(catalog::Tool::definition).collect::<Vec<_>>(),
                "ttlMs": TOOLS_TTL_MS,
                "cacheScope": "public",
            }),
            "tools/call" => self.call(id, params)?,
            other => return Err(RpcError::new(-32601, format!("Method not found: {other}"))),
        };
        result["resultType"] = Value::from("complete");
        result["_meta"] = json!({ SERVER_INFO_META: server_info() });
        Ok(result)
    }

    fn call(&self, id: &Value, params: &Value) -> Result<Value, RpcError> {
        let name = params["name"]
            .as_str()
            .ok_or_else(|| RpcError::new(-32602, "tools/call requires a tool name"))?;
        let tool = self
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| RpcError::new(-32602, format!("Unknown tool: {name}")))?;
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(arguments)) => arguments.clone(),
            Some(_) => return Err(RpcError::new(-32602, "Tool arguments must be an object")),
        };
        Ok(call::call(tool, &arguments, &self.globals, &self.calls, id))
    }
}

fn initialize(params: &Value) -> Value {
    let version = params["protocolVersion"]
        .as_str()
        .and_then(|requested| LEGACY_VERSIONS.iter().find(|known| **known == requested))
        .unwrap_or(&LEGACY_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": server_info(),
        "instructions": INSTRUCTIONS,
    })
}

fn supported_versions() -> Vec<&'static str> {
    std::iter::once(MODERN_VERSION)
        .chain(LEGACY_VERSIONS.iter().copied())
        .collect()
}

fn server_info() -> Value {
    json!({ "name": "agent-desktop", "version": env!("CARGO_PKG_VERSION") })
}

fn forwarded_globals(matches: &ArgMatches) -> Vec<String> {
    let root = Cli::command();
    let mut globals = Vec::new();
    for arg in root.get_arguments().filter(|arg| arg.is_global_set()) {
        let id = arg.get_id().as_str();
        let Some(long) = arg.get_long() else { continue };
        if matches.value_source(id) != Some(ValueSource::CommandLine) {
            continue;
        }
        if matches!(arg.get_action(), ArgAction::SetTrue) {
            globals.push(format!("--{long}"));
        } else if let Some(values) = matches.get_raw(id) {
            globals.extend(values.map(|value| format!("--{long}={}", value.to_string_lossy())));
        }
    }
    globals
}

fn write_line(out: &Mutex<std::io::Stdout>, message: &Value) {
    let Ok(mut out) = out.lock() else { return };
    let mut line = message.to_string();
    line.push('\n');
    if out
        .write_all(line.as_bytes())
        .and_then(|()| out.flush())
        .is_err()
    {
        eprintln!("agent-desktop mcp: failed to write to stdout");
    }
}

struct RpcError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    fn response(&self, id: Value) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        json!({ "jsonrpc": "2.0", "id": id, "error": error })
    }
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
