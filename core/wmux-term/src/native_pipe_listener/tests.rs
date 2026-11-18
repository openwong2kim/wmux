use super::conn::{Conn, ReadResult, END_DRAIN_LIMIT};
use super::listener::{Instances, ListenError, Listener, AT_CAP_WAIT};
use super::peer::ppid_rule;
use super::security::{current_user, owner_only_sddl};
use super::sys::*;
use super::{worker_count, Notify};
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_EXISTING: u32 = 3;
const HANDLE_FLAG_INHERIT: u32 = 1;
const SE_KERNEL_OBJECT: u32 = 6;
const OWNER_SECURITY_INFORMATION: u32 = 1;
const DACL_SECURITY_INFORMATION: u32 = 4;
const SE_DACL_PROTECTED: u16 = 0x1000;
const ACL_SIZE_INFORMATION_CLASS: u32 = 2;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const MEDIUM_RID: u32 = 0x2000;

#[repr(C)]
#[derive(Default)]
struct AclSizeInformation {
    ace_count: u32,
    bytes_in_use: u32,
    bytes_free: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        attributes: *const c_void,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn GetHandleInformation(handle: Handle, flags: *mut u32) -> Bool;
}

#[link(name = "advapi32")]
extern "system" {
    fn GetSecurityInfo(
        handle: Handle,
        object_type: u32,
        info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    fn GetSecurityDescriptorControl(
        descriptor: *const c_void,
        control: *mut u16,
        revision: *mut u32,
    ) -> Bool;
    fn GetAclInformation(acl: *const c_void, info: *mut c_void, len: u32, class: u32) -> Bool;
    fn GetAce(acl: *const c_void, index: u32, ace: *mut *mut c_void) -> Bool;
    fn ConvertStringSidToSidW(sid: *const u16, out: *mut *mut c_void) -> Bool;
}

/// The I/O tests share the global worker count: run them one at a time.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn pipe_name() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!(
        r"\\.\pipe\wmux-pipe-listener-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn notifier() -> (Notify, Receiver<()>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    (
        Arc::new(move || {
            let _ = tx.lock().unwrap().send(());
        }),
        rx,
    )
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn accept(listener: &Listener) -> Arc<Conn> {
    let mut conn = None;
    wait_until("an accepted conn", || {
        conn = listener.take_accepted();
        conn.is_some()
    });
    conn.unwrap()
}

struct Client(OwnedHandle);

impl Client {
    fn try_open(name: &str) -> Result<Self, u32> {
        let name = wide(name);
        // SAFETY: NUL-terminated name; synchronous (non-overlapped) handle.
        let raw = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        OwnedHandle::from_raw(raw).map(Self).ok_or_else(last_error)
    }
    fn open(name: &str) -> Self {
        Self::try_open(name).unwrap_or_else(|code| panic!("CreateFileW failed ({code})"))
    }
    fn write_all(&self, bytes: &[u8]) {
        let mut n = 0;
        // SAFETY: a synchronous write of a live slice.
        let ok = unsafe {
            WriteFile(
                self.0.raw(),
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut n,
                std::ptr::null_mut(),
            )
        };
        assert!(
            ok != 0 && n as usize == bytes.len(),
            "client write failed ({})",
            last_error()
        );
    }
    /// Ok(bytes) or Err(win32 error).
    fn read(&self, max: usize) -> Result<Vec<u8>, u32> {
        let mut buf = vec![0u8; max];
        let mut n = 0;
        // SAFETY: a synchronous read into a live buffer.
        let ok = unsafe {
            ReadFile(
                self.0.raw(),
                buf.as_mut_ptr(),
                max as u32,
                &mut n,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        buf.truncate(n as usize);
        Ok(buf)
    }
    /// Reads until the server end is closed; asserts it ends in a broken pipe.
    fn read_to_end(&self, chunk: usize, pause: Duration) -> Vec<u8> {
        let mut all = Vec::new();
        loop {
            match self.read(chunk) {
                Ok(bytes) => all.extend(bytes),
                Err(code) => {
                    assert_eq!(code, ERROR_BROKEN_PIPE, "client read ended with {code}");
                    return all;
                }
            }
            std::thread::sleep(pause);
        }
    }
}

/// Opens once the listening instance accepts clients again.
fn open_eventually(name: &str) -> Client {
    let mut client = None;
    wait_until("a listening instance", || {
        client = Client::try_open(name).ok();
        client.is_some()
    });
    client.unwrap()
}

/// Whether a client's read ends because the server end let it go.
fn client_end(client: &Client) -> bool {
    matches!(
        client.read(16).err(),
        Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)
    )
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

/// Reads from a conn until `len` bytes arrived.
fn read_exact(conn: &Conn, len: usize) -> Vec<u8> {
    let mut all = Vec::new();
    while all.len() < len {
        conn.request_read(64 * 1024);
        let mut result = None;
        wait_until("a read", || {
            result = conn.take_read();
            result.is_some()
        });
        match result.unwrap() {
            ReadResult::Data(bytes) => all.extend(bytes),
            ReadResult::Eof => panic!("eof after {} bytes", all.len()),
        }
    }
    all
}

#[test]
fn sddl_names_the_user_as_owner_and_grants_only_user_and_system() {
    assert_eq!(
        owner_only_sddl("S-1-5-21-1-2-3-1001"),
        "O:S-1-5-21-1-2-3-1001D:P(A;;GA;;;S-1-5-21-1-2-3-1001)(A;;GA;;;SY)"
    );
    let sid = current_user().unwrap().to_sddl_string().unwrap();
    assert!(sid.starts_with("S-1-"), "{sid}");
}

#[test]
fn created_pipe_has_a_protected_two_entry_dacl_owned_by_the_user() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let client = Client::open(&name);
    let user = current_user().unwrap();
    let mut owner = std::ptr::null_mut();
    let mut dacl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: out-pointers into the returned descriptor, freed below.
    unsafe {
        let status = GetSecurityInfo(
            client.0.raw(),
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        );
        assert_eq!(status, 0, "GetSecurityInfo");
        assert!(EqualSid(owner, user.as_ptr()) != 0, "owner is the user");
        let (mut control, mut revision) = (0u16, 0u32);
        assert!(GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) != 0);
        assert!(control & SE_DACL_PROTECTED != 0, "DACL is protected");
        let mut size = AclSizeInformation::default();
        assert!(
            GetAclInformation(
                dacl,
                (&mut size as *mut AclSizeInformation).cast(),
                std::mem::size_of::<AclSizeInformation>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            ) != 0
        );
        assert_eq!(size.ace_count, 2);
        let system_text = wide("S-1-5-18");
        let mut system = std::ptr::null_mut();
        assert!(ConvertStringSidToSidW(system_text.as_ptr(), &mut system) != 0);
        let mut sids = Vec::new();
        for index in 0..2 {
            let mut ace: *mut c_void = std::ptr::null_mut();
            assert!(GetAce(dacl, index, &mut ace) != 0);
            assert_eq!(*(ace as *const u8), ACCESS_ALLOWED_ACE_TYPE);
            // ACCESS_ALLOWED_ACE: header (4 bytes), mask (4 bytes), then the SID.
            sids.push((ace as *const u8).add(8) as *const c_void);
        }
        assert!(
            sids.iter().any(|&sid| EqualSid(sid, user.as_ptr()) != 0),
            "user ACE"
        );
        assert!(
            sids.iter().any(|&sid| EqualSid(sid, system) != 0),
            "SYSTEM ACE"
        );
        LocalFree(system);
        LocalFree(descriptor);
    }
    drop(client);
    listener.close_and_join();
}

#[test]
fn a_second_listener_on_the_same_name_fails_with_eaddrinuse() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let first = Listener::bind(&name, 4, notify.clone()).unwrap();
    match Listener::bind(&name, 4, notify) {
        Err(ListenError::AddressInUse(message)) => assert!(message.starts_with("EADDRINUSE")),
        Err(other) => panic!("unexpected error: {other}"),
        Ok(_) => panic!("second listener bound"),
    }
    first.close_and_join();
}

#[test]
fn instance_handles_are_not_inheritable() {
    let _serial = serial();
    let instances = Instances::new(&pipe_name(), 2).unwrap();
    let first = instances.create().unwrap();
    let second = instances.create().unwrap();
    for instance in [&first, &second] {
        let mut flags = u32::MAX;
        // SAFETY: writes one u32.
        assert!(unsafe { GetHandleInformation(instance.raw(), &mut flags) } != 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
    }
}

#[test]
fn self_connect_reports_this_process_as_the_peer() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let client = Client::open(&name);
    let conn = accept(&listener);
    let peer = conn.peer().clone();
    assert_eq!(peer.pid, std::process::id());
    assert!(peer.same_session);
    assert_eq!(peer.same_user, Some(true));
    assert!(peer.integrity_rid.unwrap() >= MEDIUM_RID, "{peer:?}");
    assert_eq!(peer.reason, None);
    assert!(peer.created > 0.0);
    let parent = crate::process_table::snapshot(false)
        .unwrap()
        .into_iter()
        .find(|row| row.pid == std::process::id())
        .map(|row| row.ppid);
    assert!(
        peer.ppid.is_none() || peer.ppid == parent,
        "{peer:?} vs {parent:?}"
    );

    // Bytes round-trip both ways.
    client.write_all(b"hello\n");
    assert_eq!(read_exact(&conn, 6), b"hello\n");
    let id = conn.write(b"world\n".to_vec());
    wait_until("the write", || conn.take_written().contains(&id));
    assert_eq!(client.read(64).unwrap(), b"world\n");
    assert_eq!(conn.error(), None);

    // The client closing reads as EOF.
    drop(client);
    conn.request_read(1024);
    let mut result = None;
    wait_until("eof", || {
        result = conn.take_read();
        result.is_some()
    });
    assert_eq!(result, Some(ReadResult::Eof));
    conn.destroy_and_join();
    assert!(conn.closed());
    listener.close_and_join();
}

#[test]
fn ppid_needs_a_live_parent_created_no_later_than_the_child() {
    assert!(ppid_rule(true, 100, 200));
    assert!(ppid_rule(true, 200, 200));
    assert!(
        !ppid_rule(true, 201, 200),
        "a parent created after the child is a reused pid"
    );
    assert!(
        !ppid_rule(false, 100, 200),
        "an exited parent is not reported"
    );
}

#[test]
fn clients_past_the_instance_cap_wait_for_a_slot() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 2, notify).unwrap();
    let first_client = Client::open(&name);
    let first = accept(&listener);
    let _second_client = Client::open(&name);
    let second = accept(&listener);
    // At the cap the listening instance still takes one client, which waits
    // unaccepted; past it the name is busy.
    let third_client = Client::open(&name);
    std::thread::sleep(Duration::from_millis(100));
    assert!(listener.take_accepted().is_none(), "accepted past the cap");
    assert_eq!(Client::try_open(&name).err(), Some(ERROR_PIPE_BUSY));
    // After AT_CAP_WAIT the waiting client is disconnected unserved.
    let started = Instant::now();
    let ended = client_end(&third_client);
    assert!(started.elapsed() >= AT_CAP_WAIT - Duration::from_millis(200));
    assert!(ended, "the waiting client was not disconnected");
    assert!(listener.take_accepted().is_none());
    // The same instance listens again: the next client waits, and is
    // accepted once a conn closes.
    let _fourth_client = open_eventually(&name);
    first.destroy_and_join();
    drop(first_client);
    let third = accept(&listener);
    assert_eq!(third.peer().pid, std::process::id());
    second.destroy_and_join();
    third.destroy_and_join();
    listener.close_and_join();
}

/// While a listener runs, its name always exists: a create of the name as a
/// first instance fails throughout, at the cap and as conns come and go.
#[test]
fn the_name_never_disappears_while_listening() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 1, notify).unwrap();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let probe_stop = stop.clone();
    let probe_name = wide(&name);
    let probe = std::thread::spawn(move || {
        let (mut attempts, mut created) = (0u32, 0u32);
        while !probe_stop.load(Ordering::Acquire) {
            // SAFETY: NUL-terminated name; default security.
            let raw = unsafe {
                CreateNamedPipeW(
                    probe_name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE,
                    1,
                    0,
                    0,
                    0,
                    std::ptr::null(),
                )
            };
            attempts += 1;
            if OwnedHandle::from_raw(raw).is_some() {
                created += 1;
            }
        }
        (attempts, created)
    });
    for _ in 0..20 {
        let client = Client::open(&name);
        let conn = accept(&listener);
        // At the cap (1): a second client waits on the listening instance.
        let waiting = Client::open(&name);
        conn.destroy_and_join();
        drop(client);
        let next = accept(&listener);
        drop(waiting);
        next.destroy_and_join();
    }
    // A client over the cap is disconnected after AT_CAP_WAIT, and the
    // instance listens again.
    let client = Client::open(&name);
    let conn = accept(&listener);
    let waiting = Client::open(&name);
    assert!(
        client_end(&waiting),
        "the waiting client was not disconnected"
    );
    let again = open_eventually(&name);
    conn.destroy_and_join();
    drop(client);
    accept(&listener).destroy_and_join();
    drop(again);
    stop.store(true, Ordering::Release);
    let (attempts, created) = probe.join().unwrap();
    assert!(attempts > 0);
    assert_eq!(
        created, 0,
        "the name was absent {created} of {attempts} times"
    );
    listener.close_and_join();
}

/// An ended conn whose client never reads gives up after END_DRAIN_LIMIT:
/// it cancels the write, closes and reports why.
#[test]
fn end_gives_up_on_a_client_that_never_reads() {
    let _serial = serial();
    wait_until("idle workers", || worker_count() == 0);
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let client = Client::open(&name);
    let conn = accept(&listener);
    let id = conn.write(pattern(200 * 1000));
    conn.end();
    let started = Instant::now();
    wait_until("the bounded close", || conn.closed());
    assert!(started.elapsed() >= END_DRAIN_LIMIT - Duration::from_millis(100));
    assert!(conn.take_written().contains(&id));
    let error = conn.error().unwrap();
    assert!(error.contains("read none"), "{error}");
    drop(client);
    listener.close_and_join();
    wait_until("every worker to end", || worker_count() == 0);
}

/// END_DRAIN_LIMIT is an idle limit: a client that reads slowly but
/// steadily for longer than the limit still receives every byte.
#[test]
fn end_keeps_a_steady_slow_client_past_the_drain_limit() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let client = Client::open(&name);
    let conn = accept(&listener);
    let data = pattern(400 * 1000);
    conn.write(data.clone());
    conn.end();
    let started = Instant::now();
    let received = client.read_to_end(4096, Duration::from_millis(20));
    assert!(
        started.elapsed() > END_DRAIN_LIMIT,
        "the read was not slow enough"
    );
    assert_eq!(received.len(), data.len());
    assert!(received == data, "bytes differ");
    wait_until("the close", || conn.closed());
    assert_eq!(conn.error(), None);
    listener.close_and_join();
}

/// end() closes after its writes complete; a slow client still reads every
/// byte, then ERROR_BROKEN_PIPE.
fn end_keeps_every_byte(len: usize) {
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let client = Client::open(&name);
    let conn = accept(&listener);
    let data = pattern(len);
    conn.write(data.clone());
    conn.end();
    if len < PIPE_BUFFER_BYTES as usize {
        // Fits the pipe buffer: the server end closes before any read.
        wait_until("the close", || conn.closed());
    }
    let received = client.read_to_end(4096, Duration::from_millis(1));
    assert_eq!(received.len(), data.len());
    assert!(received == data, "bytes differ");
    wait_until("the close", || conn.closed());
    assert_eq!(conn.error(), None);
    listener.close_and_join();
}

#[test]
fn end_with_a_few_kilobytes_keeps_every_byte_for_a_slow_client() {
    let _serial = serial();
    end_keeps_every_byte(6 * 1024);
    end_keeps_every_byte(60 * 1024);
}

#[test]
fn end_with_a_write_larger_than_the_pipe_buffer_keeps_every_byte() {
    let _serial = serial();
    end_keeps_every_byte(200 * 1000);
}

#[test]
fn destroy_during_a_pending_read_joins_the_worker() {
    let _serial = serial();
    wait_until("idle workers", || worker_count() == 0);
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let client = Client::open(&name);
    let conn = accept(&listener);
    conn.request_read(1024);
    // A write that cannot complete: the client never reads.
    conn.write(pattern(512 * 1024));
    std::thread::sleep(Duration::from_millis(20));
    conn.destroy_and_join();
    assert!(conn.closed());
    assert!(conn.error().is_some(), "the canceled write is reported");
    drop(client);
    listener.close_and_join();
    assert_eq!(worker_count(), 0);
}

#[test]
fn a_new_listener_binds_the_name_while_an_old_client_handle_is_open() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let old = Listener::bind(&name, 4, notify.clone()).unwrap();
    let client = Client::open(&name);
    let conn = accept(&old);
    conn.destroy_and_join();
    old.close_and_join();
    let new = Listener::bind(&name, 4, notify).unwrap();
    // The old client sees its instance gone, not the new pipe.
    assert_eq!(client.read(16).err(), Some(ERROR_BROKEN_PIPE));
    let next_client = Client::open(&name);
    let next = accept(&new);
    next_client.write_all(b"x");
    assert_eq!(read_exact(&next, 1), b"x");
    next.destroy_and_join();
    new.close_and_join();
}

#[test]
fn connect_and_disconnect_cycles_return_to_baseline() {
    let _serial = serial();
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 8, notify).unwrap();
    // Warm up lazily created process state before taking the baseline.
    for _ in 0..3 {
        let client = Client::open(&name);
        accept(&listener).destroy_and_join();
        drop(client);
    }
    let workers = worker_count();
    let handles = process_handle_count();
    for _ in 0..200 {
        let client = Client::open(&name);
        let conn = accept(&listener);
        drop(client);
        conn.destroy_and_join();
    }
    assert_eq!(worker_count(), workers);
    let after = process_handle_count();
    // Process-wide: other tests' handles come and go; a leak over 200
    // cycles would exceed this.
    assert!(after <= handles + 50, "handles {handles} -> {after}");
    listener.close_and_join();
}

#[test]
fn close_without_join_destroys_untaken_conns_and_ends_every_worker() {
    let _serial = serial();
    wait_until("idle workers", || worker_count() == 0);
    let name = pipe_name();
    let (notify, rx) = notifier();
    let listener = Listener::bind(&name, 4, notify).unwrap();
    let taken_client = Client::open(&name);
    let taken = accept(&listener);
    let _untaken_client = Client::open(&name);
    // The second conn is queued (a wake for it arrives) but never taken.
    wait_until("the second accept", || {
        rx.try_iter().count() > 0 && worker_count() >= 3
    });
    listener.close();
    taken.destroy();
    drop(taken_client);
    wait_until("every worker to end", || worker_count() == 0);
    assert!(taken.closed());
    assert!(listener.take_accepted().is_none());
}

/// Finished conns hold no OS handle while their owners (the JS objects)
/// are still alive: destroy() and end() + EOF both release everything.
#[test]
fn finished_conns_release_their_handles_while_still_referenced() {
    let _serial = serial();
    wait_until("idle workers", || worker_count() == 0);
    let name = pipe_name();
    let (notify, _rx) = notifier();
    let listener = Listener::bind(&name, 8, notify).unwrap();
    // Warm up lazily created process state before taking the baseline.
    for _ in 0..3 {
        let client = Client::open(&name);
        accept(&listener).destroy_and_join();
        drop(client);
    }
    wait_until("idle accept", || worker_count() == 1);
    let handles = process_handle_count();
    let mut owners = Vec::new();
    for round in 0..100 {
        let client = Client::open(&name);
        let conn = accept(&listener);
        if round % 2 == 0 {
            conn.destroy();
        } else {
            conn.end();
            assert_eq!(client.read(16).err(), Some(ERROR_BROKEN_PIPE));
            wait_until("the close", || conn.closed());
        }
        drop(client);
        owners.push(conn);
    }
    wait_until("every conn worker to end", || worker_count() == 1);
    for conn in &owners {
        assert!(conn.closed());
    }
    let after = process_handle_count();
    // 100 conns that each kept one handle would exceed this.
    assert!(
        after <= handles + 20,
        "handles {handles} -> {after} with 100 owners alive"
    );
    drop(owners);
    listener.close_and_join();
}
