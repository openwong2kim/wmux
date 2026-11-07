use super::*;

#[test]
fn unproven_pointer_receiver_refuses_once_before_any_move() {
    for timeout_ms in [None, Some(5_000)] {
        let _guard = HomeGuard::new();
        let snapshot_id = ref_snapshot(42);
        let adapter = HoverCaptureAdapter::new().refusing_receiver();

        let error = execute(
            HoverArgs {
                ref_id: Some(format!("@{}:e1", snapshot_id)),
                xy: None,
                duration_ms: None,
                timeout_ms,
            },
            &adapter,
            &CommandContext::default().with_headed(true),
        )
        .unwrap_err();

        let AppError::Adapter(error) = error else {
            panic!("expected an adapter error");
        };
        assert_eq!(error.code, crate::ErrorCode::ActionFailed);
        assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
        assert_eq!(adapter.receiver_checks.load(Ordering::SeqCst), 1);
        assert!(adapter.moved_to.lock().unwrap().is_none());
    }
}

#[test]
fn the_pointer_receiver_is_confirmed_on_the_element_core_resolved() {
    let _guard = HomeGuard::new();
    let snapshot_id = ref_snapshot(42);
    let adapter = HoverCaptureAdapter::new();

    execute(
        HoverArgs {
            ref_id: Some(format!("@{}:e1", snapshot_id)),
            xy: None,
            duration_ms: None,
            timeout_ms: None,
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .expect("the receiver check runs on the resolved handle");

    assert_eq!(adapter.receiver_checks.load(Ordering::SeqCst), 1);
    assert!(adapter.moved_to.lock().unwrap().is_some());
}
