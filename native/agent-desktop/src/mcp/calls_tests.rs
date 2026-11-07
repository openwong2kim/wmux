use super::*;
use serde_json::json;

fn unspawnable() -> Command {
    Command::new("agent-desktop-calls-test-binary-that-does-not-exist")
}

#[test]
fn an_id_is_admitted_once_until_its_call_finishes() {
    let calls = Calls::default();
    assert!(calls.admit(&json!(1)));
    assert!(!calls.admit(&json!(1)));
    assert!(calls.admit(&json!("1")));
    assert!(calls.finish(&json!(1)));
    assert!(calls.admit(&json!(1)));
}

#[test]
fn a_call_cancelled_before_it_starts_never_spawns_and_gets_no_response() {
    let calls = Calls::default();
    assert!(calls.admit(&json!(7)));
    calls.cancel(&json!(7));
    assert!(calls.start(&json!(7), &mut unspawnable()).is_none());
    assert!(!calls.finish(&json!(7)));
}

#[cfg(unix)]
#[test]
fn a_cancelled_child_gets_sigterm_before_any_kill() {
    use std::io::Read;
    use std::process::Stdio;

    let calls = Calls::default();
    let id = json!(3);
    assert!(calls.admit(&id));
    let mut command = Command::new("sh");
    command
        .args([
            "-c",
            "trap 'echo released; exit 0' TERM; echo started; while :; do sleep 0.05; done",
        ])
        .stdout(Stdio::piped());
    let (stdout, _) = calls
        .start(&id, &mut command)
        .expect("admitted")
        .expect("sh starts");
    let mut stdout = stdout.expect("stdout is piped");
    let mut started = [0_u8; 8];
    stdout.read_exact(&mut started).expect("child started");
    calls.cancel(&id);
    let mut rest = String::new();
    stdout.read_to_string(&mut rest).expect("child exits");
    assert_eq!(rest, "released\n");
}
