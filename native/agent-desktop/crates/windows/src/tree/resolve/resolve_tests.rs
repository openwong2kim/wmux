use super::*;
use crate::tree::walk::walker::WalkBudget;
use crate::tree::walk::walker_source::UiaTreeSource;
use agent_desktop_core::LocatorEvidence;
use std::ops::ControlFlow;

/// The cross-process takeover shape, end to end. The stored evidence here
/// genuinely describes a live element - captured from that very tree moments
/// earlier - while the stored process is a *different* process that is alive
/// and of exactly the stored generation. Only the handle's live owner can tell
/// the two apart, so every resolver reaching a window root through
/// `resolve_window_root` must settle `STALE_REF` rather than find the element
/// in an application the ref never named.
#[test]
fn a_ref_whose_window_belongs_to_another_process_never_resolves_into_it() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let deadline = crate::tree::walk::walker_fake::deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("the fixture window resolves");
    let source = UiaTreeSource::for_root(&root).expect("a tree source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = WalkBudget::new(10, deadline);

    let (path, _, evidence, _) = find_password(&source, &prepared, &budget)
        .expect("the fixture exposes a password edit")
        .expect("a password element");
    let rect = evidence.ref_evidence.bounds.known().expect("a bounds");
    let hash = rect.bounds_hash().expect("a positive-area hash");

    let pid = agent_desktop_core::ProcessId::from(std::process::id());
    let token = crate::system::process_identity::token_for_pid(pid)
        .expect("the token read answers")
        .expect("a live process has a token");
    assert_ne!(
        pid,
        agent_desktop_core::ProcessId::from(fixture.process_id()),
        "the window under test belongs to a different process than the stored ref"
    );
    assert!(
        crate::system::process_identity::matches_instance(pid, &token)
            .expect("the generation check answers"),
        "the stored process is alive and of the stored generation, so only ownership refutes"
    );

    let mut entry = crate::tree::walk::walker_fake::ref_entry(
        &evidence.role.known().cloned().unwrap_or_default(),
    );
    entry.process = agent_desktop_core::RefProcess {
        pid,
        process_instance: Some(token),
    };
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: Some(*rect),
        bounds_hash: Some(hash),
    };
    entry.source.source_window_id = Some(format!("w-{}", fixture.handle()));
    entry.scope.path_is_absolute = true;
    entry.scope.path = path;

    let verdicts = [
        (
            "the window gate itself",
            resolve_window_root(&entry, deadline).err().map(code_of),
        ),
        (
            "the locator anchor",
            crate::tree::resolve::resolve_anchor::resolve_locator_anchor(&entry, deadline)
                .err()
                .map(code_of),
        ),
    ];
    assert_eq!(
        verdicts.to_vec(),
        vec![
            ("the window gate itself", Some(ErrorCode::StaleRef)),
            ("the locator anchor", Some(ErrorCode::StaleRef)),
        ],
        "no resolver may reach into a window another process owns"
    );
}

fn find_password(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
) -> Result<
    Option<(
        agent_desktop_core::refs::RefPath,
        crate::tree::properties::ElementProperties,
        LocatorEvidence,
        u64,
    )>,
    AdapterError,
> {
    crate::tree::walk::walker_fake::scan_subtree(
        source,
        element,
        budget,
        10,
        &mut |prefix, properties, evidence, failed| {
            if properties.is_secure() {
                let mut path = agent_desktop_core::refs::RefPath::default();
                path.extend_from_slice(prefix);
                ControlFlow::Break((path, properties, evidence, failed))
            } else {
                ControlFlow::Continue(())
            }
        },
    )
}

fn code_of(error: AdapterError) -> ErrorCode {
    error.code
}

#[path = "resolve_retry_tests.rs"]
mod retry;

#[path = "resolve_retry_classification_tests.rs"]
mod retry_classification;
