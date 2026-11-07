use super::*;
use std::os::unix::ffi::OsStrExt;

/// The executable path as the kernel lays it out: NUL-terminated, then NUL-padded to 8 bytes.
fn padded_path(executable: &str) -> Vec<u8> {
    let mut path = executable.as_bytes().to_vec();
    path.push(0);
    path.resize(path.len().next_multiple_of(8), 0);
    path
}

fn procargs(executable: &str, arguments: &[&str]) -> Vec<u8> {
    let mut buffer = (arguments.len() as i32).to_ne_bytes().to_vec();
    buffer.extend_from_slice(&padded_path(executable));
    for argument in arguments {
        buffer.extend_from_slice(argument.as_bytes());
        buffer.push(0);
    }
    buffer.extend_from_slice(b"HOME=/Users/a\0");
    buffer
}

#[test]
fn first_argument_is_the_launch_command_not_the_executable_path() {
    let buffer = procargs(
        "/Applications/Foo.app/Contents/MacOS/Foo",
        &["com.example.renamed", "--flag"],
    );

    assert_eq!(first_argument(&buffer), Some(&b"com.example.renamed"[..]));
}

#[test]
fn first_argument_keeps_spaces_in_the_command() {
    let buffer = procargs(
        "/Applications/Foo Bar.app/Contents/MacOS/Foo Bar",
        &["/Applications/Foo Bar.app/Contents/MacOS/Foo Bar"],
    );

    assert_eq!(
        first_argument(&buffer),
        Some(&b"/Applications/Foo Bar.app/Contents/MacOS/Foo Bar"[..])
    );
}

#[test]
fn malformed_argument_blocks_have_no_command() {
    assert_eq!(first_argument(&[1, 0]), None);
    for count in [0_i32, -1] {
        let mut buffer = procargs("/bin/zsh", &["-zsh"]);
        buffer[..4].copy_from_slice(&count.to_ne_bytes());
        assert_eq!(first_argument(&buffer), None);
    }
    let mut unterminated = 1_i32.to_ne_bytes().to_vec();
    unterminated.extend_from_slice(&padded_path("/bin/zsh"));
    unterminated.extend_from_slice(b"-zsh");
    assert_eq!(first_argument(&unterminated), None);
    let mut padding_only = 1_i32.to_ne_bytes().to_vec();
    padding_only.extend_from_slice(b"/bin/zsh\0\0\0");
    assert_eq!(first_argument(&padding_only), None);
    let mut dirty_padding = procargs("/bin/zsh", &["-zsh"]);
    dirty_padding[4 + "/bin/zsh".len() + 1] = b'x';
    assert_eq!(first_argument(&dirty_padding), None);
}

#[test]
fn an_empty_first_argument_is_not_read_as_the_next_one() {
    let buffer = procargs(
        "/bin/sleep",
        &["", "/Applications/Fake.app/Contents/MacOS/Fake"],
    );
    assert_eq!(first_argument(&buffer), None);
}

#[test]
fn a_path_that_ends_on_the_boundary_has_no_padding() {
    let buffer = procargs("/bin/ab", &["-ab"]);
    assert_eq!(&buffer[4..12], b"/bin/ab\0");
    assert_eq!(first_argument(&buffer), Some(&b"-ab"[..]));
}

#[test]
fn a_live_process_with_an_empty_first_argument_has_no_command() {
    use std::os::unix::process::CommandExt;
    let mut child = std::process::Command::new("/bin/sleep")
        .arg0("")
        .arg("30")
        .spawn()
        .unwrap();
    let pid = libc::pid_t::try_from(child.id()).unwrap();
    let mut buffer = argument_buffer().unwrap();
    let mut read = None;
    for _ in 0..100 {
        read = read_arguments(pid, &mut buffer).map(<[u8]>::to_vec);
        if read
            .as_deref()
            .and_then(arguments)
            .is_some_and(|(count, _)| count == 2)
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    let read = read.unwrap();
    assert_eq!(arguments(&read).map(|(count, _)| count), Some(2));
    assert_eq!(first_argument(&read), None);
}

#[test]
fn failed_process_listing_is_not_an_empty_inventory() {
    let error = require_pids(None).unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.is_explicitly_retryable());
    assert_eq!(error.details.unwrap()["source"], "libproc");
}

#[test]
fn current_process_command_matches_its_first_argument() {
    let own_pid = std::process::id() as libc::pid_t;
    let expected = std::env::args_os().next().unwrap();
    let mut seen = None;

    visit_commands_until(
        Instant::now() + std::time::Duration::from_secs(5),
        |pid, command| {
            if pid == own_pid {
                seen = Some(command.to_vec());
            }
            Ok(())
        },
    )
    .unwrap();

    assert_eq!(seen.as_deref(), Some(expected.as_bytes()));
}

#[test]
fn expired_deadline_stops_the_process_walk() {
    let mut visited = 0;
    let error = visit_commands_until(Instant::now(), |_, _| {
        visited += 1;
        Ok(())
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(visited, 0);
}

#[test]
fn other_users_processes_have_no_readable_arguments() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let mut buffer = argument_buffer().unwrap();

    assert!(read_arguments(1, &mut buffer).is_none());
}
