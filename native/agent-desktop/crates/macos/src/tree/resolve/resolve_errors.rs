use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, RefEntry};

/// Core owns the payload (`agent_desktop_core::refs::resolve_errors::identity_unknown_error`)
/// so both adapters share one definition: an unreadable candidate
/// means the same thing whichever adapter's search produced it.
pub(in crate::tree) use agent_desktop_core::refs::resolve_errors::identity_unknown_error as identity_unknown;

/// macOS re-identifies a saved ref only through the element token captured with
/// it, so a ref that carries none is refused instead of searched for.
pub(in crate::tree) fn element_token_required(entry: &RefEntry) -> AdapterError {
    AdapterError::new(
        ErrorCode::ElementNotFound,
        "A saved ref on macOS is re-identified only through the element token captured with it, \
         and this ref carries none",
    )
    .with_suggestion(
        "Run 'snapshot' to take a ref that carries an element token, then retry with the new ref",
    )
    .with_disposition(DeliverySemantics::not_delivered())
    .with_details(serde_json::json!({
        "kind": "element_token_required",
        "retryable": false,
        "role": entry.identity.role,
    }))
}

pub(in crate::tree) fn incomplete_traversal(phase: &str, depth: u8) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!(
            "Strict element resolution observed an incomplete accessibility tree during {phase}"
        ),
    )
    .with_suggestion("Retry after the target application finishes updating its accessibility tree")
    .with_details(serde_json::json!({
        "kind": "resolution_traversal_incomplete",
        "phase": phase,
        "depth": depth,
        "complete": false,
        "retryable": true,
    }))
}
