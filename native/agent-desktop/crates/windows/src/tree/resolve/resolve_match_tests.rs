use super::*;
use agent_desktop_core::{DeliverySemantics, ElementIdentifier, ErrorCode, IdentifierKind};

fn entry() -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry("button");
    entry.identity.name = Some("Label".into());
    entry.identity.native_id = Some(ElementIdentifier {
        kind: IdentifierKind::AutomationId,
        value: "btn-1".into(),
    });
    entry
}

#[test]
fn a_zero_candidate_resolution_is_stale_windows() {
    assert_eq!(stale_ref_error(&entry()).code, ErrorCode::StaleRef);
}

/// The settled stale ref sits on two different retry axes at once, and a
/// regression on either is invisible from the error code alone. It must stay
/// query-level retryable, because that is what lets the caller's hydration
/// take its one fresh re-observation after the tree moved; and it must stay
/// out of the adapter's own loop, because replaying the same walk against the
/// same stored evidence cannot produce a different answer.
#[cfg(target_os = "windows")]
#[test]
fn a_settled_stale_ref_is_query_retryable_complete_and_not_adapter_loop_retryable() {
    let error = stale_ref_error(&entry());

    assert!(
        error.is_explicitly_retryable(),
        "hydration's fresh re-observation is gated on this stamp"
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("complete"))
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "a completed search that found nothing is a complete answer"
    );
    assert!(
        !crate::tree::resolve::is_retryable_resolution_error(&error),
        "the adapter loop must not replay a settled non-match"
    );
}

/// The settled stale ref is what an agent reads, so its message is pinned
/// verbatim. Routing a whole sentence through core's `stale_ref` constructor,
/// whose parameter is a ref id it interpolates into `"{ref_id} not found in
/// current RefMap"`, produced a message that was both ungrammatical and wrong
/// about the cause - it reported a ref missing from the RefMap when the ref
/// had in fact resolved and lost against the live evidence. The suggestion and
/// the not-delivered disposition are pinned alongside it, because dropping
/// either is invisible from the message alone.
#[test]
fn the_settled_stale_ref_message_names_the_evidence_mismatch_not_a_missing_refmap_entry() {
    let error = stale_ref_error(&entry());

    assert_eq!(error.message, "Stored ref does not match any live element");
    assert!(
        !error.message.contains("RefMap"),
        "a resolved-but-refuted ref is not a missing RefMap entry: {}",
        error.message
    );
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Run 'snapshot' to refresh, then retry with the updated ref.")
    );
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(
        error.is_explicitly_retryable() && error.permits_retry_by_default(),
        "the derived retryability must survive the construction change"
    );
}
