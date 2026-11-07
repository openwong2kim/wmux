//! MCP tools derived from the clap command tree, so the CLI stays the only definition of a command.

use clap::{Arg, ArgAction, Command, CommandFactory};
use serde_json::{Map, Value, json};
use std::any::TypeId;

use crate::cli::Cli;

const TOOL_PREFIX: &str = "desktop";
const CLAP_HELP_SUBCOMMAND: &str = "help";
const MAX_COUNT: u64 = 16;

/// One leaf CLI command exposed as an MCP tool.
pub(crate) struct Tool {
    pub name: String,
    pub path: Vec<String>,
    command: Command,
}

/// Every leaf command of the CLI, in declaration order.
pub(crate) fn tools() -> Vec<Tool> {
    let mut root = Cli::command();
    root.build();
    let mut found = Vec::new();
    for sub in commands(&root) {
        collect(sub, Vec::new(), &mut found);
    }
    found
}

fn commands(parent: &Command) -> impl Iterator<Item = &Command> {
    parent
        .get_subcommands()
        .filter(|sub| sub.get_name() != CLAP_HELP_SUBCOMMAND)
}

fn collect(command: &Command, mut path: Vec<String>, found: &mut Vec<Tool>) {
    path.push(command.get_name().to_string());
    if command.has_subcommands() {
        for sub in commands(command) {
            collect(sub, path.clone(), found);
        }
        return;
    }
    let name = std::iter::once(TOOL_PREFIX)
        .chain(path.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("_")
        .replace('-', "_");
    found.push(Tool {
        name,
        path,
        command: command.clone(),
    });
}

impl Tool {
    /// The MCP `Tool` object advertised by `tools/list`.
    pub(crate) fn definition(&self) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for arg in self.args() {
            properties.insert(property_name(arg), property(arg));
            if arg.is_required_set() {
                required.push(Value::from(property_name(arg)));
            }
        }
        let mut schema =
            json!({ "type": "object", "properties": properties, "additionalProperties": false });
        if !required.is_empty() {
            schema["required"] = Value::Array(required);
        }
        json!({ "name": self.name, "description": self.description(), "inputSchema": schema })
    }

    /// Builds the CLI arguments, after the binary name, that run this command with `arguments`; a null value counts as omitted.
    pub(crate) fn argv(&self, arguments: &Map<String, Value>) -> Result<Vec<String>, String> {
        let mut argv = self.path.clone();
        let mut positionals = Vec::new();
        for (key, value) in arguments.iter().filter(|(_, value)| !value.is_null()) {
            let arg = self
                .args()
                .find(|arg| property_name(arg) == *key)
                .ok_or_else(|| self.unknown_argument(key))?;
            if arg.is_positional() {
                positionals.push((arg.get_index().unwrap_or(usize::MAX), scalars(key, value)?));
            } else {
                push_option(&mut argv, arg, key, value)?;
            }
        }
        if !positionals.is_empty() {
            positionals.sort_by_key(|(index, _)| *index);
            argv.push("--".to_string());
            argv.extend(positionals.into_iter().flat_map(|(_, values)| values));
        }
        Ok(argv)
    }

    fn args(&self) -> impl Iterator<Item = &Arg> {
        self.command.get_arguments().filter(|arg| {
            !arg.is_global_set()
                && !arg.is_hide_set()
                && arg.get_id().as_str() != "stdin"
                && !matches!(
                    arg.get_action(),
                    ArgAction::Help
                        | ArgAction::HelpShort
                        | ArgAction::HelpLong
                        | ArgAction::Version
                )
        })
    }

    fn description(&self) -> String {
        let about = self
            .command
            .get_long_about()
            .or_else(|| self.command.get_about())
            .map(ToString::to_string)
            .unwrap_or_default();
        format!("agent-desktop {}: {about}", self.path.join(" "))
    }

    fn unknown_argument(&self, key: &str) -> String {
        let known = self.args().map(property_name).collect::<Vec<_>>();
        format!(
            "Unknown argument '{key}' for {}. Known arguments: {}",
            self.name,
            known.join(", ")
        )
    }
}

fn property_name(arg: &Arg) -> String {
    arg.get_id().as_str().replace('-', "_")
}

fn push_option(argv: &mut Vec<String>, arg: &Arg, key: &str, value: &Value) -> Result<(), String> {
    let flag = arg
        .get_long()
        .map(|long| format!("--{long}"))
        .or_else(|| arg.get_short().map(|short| format!("-{short}")))
        .ok_or_else(|| format!("Argument '{key}' has no flag"))?;
    match arg.get_action() {
        ArgAction::SetTrue | ArgAction::SetFalse => match value {
            Value::Bool(true) => argv.push(flag),
            Value::Bool(false) => {}
            _ => return Err(format!("Argument '{key}' must be a boolean")),
        },
        ArgAction::Count => {
            let count = value
                .as_u64()
                .filter(|count| *count <= MAX_COUNT)
                .ok_or_else(|| {
                    format!("Argument '{key}' must be an integer from 0 to {MAX_COUNT}")
                })?;
            argv.extend((0..count).map(|_| flag.clone()));
        }
        _ => {
            for scalar in scalars(key, value)? {
                argv.push(format!("{flag}={scalar}"));
            }
        }
    }
    Ok(())
}

fn scalars(key: &str, value: &Value) -> Result<Vec<String>, String> {
    let items = match value {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::String(text) => Ok(text.clone()),
            Value::Number(number) => Ok(number.to_string()),
            Value::Bool(flag) => Ok(flag.to_string()),
            _ => Err(format!(
                "Argument '{key}' must be a string, number, boolean or an array of them"
            )),
        })
        .collect()
}

fn property(arg: &Arg) -> Value {
    let mut schema = match arg.get_action() {
        ArgAction::SetTrue | ArgAction::SetFalse => json!({ "type": "boolean" }),
        ArgAction::Count => json!({ "type": "integer", "minimum": 0, "maximum": MAX_COUNT }),
        _ => value_schema(arg),
    };
    if let Some(help) = arg.get_long_help().or_else(|| arg.get_help()) {
        schema["description"] = Value::from(help.to_string());
    }
    schema
}

fn value_schema(arg: &Arg) -> Value {
    let mut item = json!({ "type": json_type(arg) });
    let choices = arg
        .get_possible_values()
        .iter()
        .filter(|value| !value.is_hide_set())
        .map(|value| Value::from(value.get_name()))
        .collect::<Vec<_>>();
    if !choices.is_empty() {
        item["enum"] = Value::Array(choices);
    }
    if let [default] = arg.get_default_values() {
        let default = default.to_string_lossy();
        let typed = match item["type"].as_str() {
            Some("integer") => default.parse::<i64>().ok().map(Value::from),
            Some("number") => default.parse::<f64>().ok().map(Value::from),
            _ => Some(Value::from(default.as_ref())),
        };
        if let Some(typed) = typed {
            item["default"] = typed;
        }
    }
    let multiple = matches!(arg.get_action(), ArgAction::Append)
        || arg
            .get_num_args()
            .is_some_and(|range| range.max_values() > 1);
    if multiple {
        json!({ "type": "array", "items": item })
    } else {
        item
    }
}

fn json_type(arg: &Arg) -> &'static str {
    let id = arg.get_value_parser().type_id();
    let is = |types: &[TypeId]| types.iter().any(|type_id| id == *type_id);
    if is(&[TypeId::of::<bool>()]) {
        "boolean"
    } else if is(&[
        TypeId::of::<u8>(),
        TypeId::of::<u16>(),
        TypeId::of::<u32>(),
        TypeId::of::<u64>(),
        TypeId::of::<usize>(),
        TypeId::of::<i8>(),
        TypeId::of::<i16>(),
        TypeId::of::<i32>(),
        TypeId::of::<i64>(),
        TypeId::of::<isize>(),
    ]) {
        "integer"
    } else if is(&[TypeId::of::<f32>(), TypeId::of::<f64>()]) {
        "number"
    } else {
        "string"
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
