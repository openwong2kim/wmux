// TCC attribution trampoline.
//
// A process exec'd by wmux inherits wmux as its "responsible process", and TCC
// checks (and records grants against) the responsible process. Left alone, the
// Accessibility and Screen Recording grants this helper needs would land on
// wmux — and so on every shell and agent wmux hosts. So the helper re-execs
// itself once with responsibility disclaimed (the private
// `responsibility_spawnattrs_setdisclaim` SPI, as Chromium and LLDB use it).
//
// POSIX_SPAWN_SETEXEC makes the spawn replace this process image in place:
// same pid, same stdin/stdout/stderr, same parent. Main's kill() and the
// stdin-EOF exit keep working, and nothing has to forward signals or fds.
// `open`/LaunchServices would also disclaim, but they detach stdio.

import Darwin
import Foundation

enum Trampoline {
    private static let markerEnv = "WMUX_COMPUTER_USE_DISCLAIMED"

    private typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    private typealias ResponsibleFor = @convention(c) (pid_t) -> pid_t

    /// The pid TCC treats as responsible for this process, or nil if the SPI is missing.
    static func responsiblePid() -> pid_t? {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else {
            return nil
        }
        return unsafeBitCast(sym, to: ResponsibleFor.self)(getpid())
    }

    /// Returns only when this process is its own responsible process. Exits
    /// otherwise: running with wmux's TCC identity is the one thing the helper
    /// must not do.
    static func ensureSelfResponsible() {
        let me = getpid()
        if let responsible = responsiblePid(), responsible == me {
            unsetenv(markerEnv)
            return
        }
        if getenv(markerEnv) != nil {
            // Disclaimed already; without the query SPI there is nothing to check.
            if responsiblePid() == nil {
                unsetenv(markerEnv)
                return
            }
            fail("still not self-responsible after disclaiming (responsible pid \(responsiblePid().map(String.init) ?? "unknown"))")
        }
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
            fail("responsibility_spawnattrs_setdisclaim is unavailable")
        }
        let path = executablePath()
        setenv(markerEnv, "1", 1)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        var rc = unsafeBitCast(sym, to: SetDisclaim.self)(&attr, 1)
        if rc != 0 { fail("setdisclaim failed (\(rc))") }
        rc = posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
        if rc != 0 { fail("setflags failed (\(rc))") }

        // On success this never returns: the image is replaced.
        rc = posix_spawn(nil, path, nil, &attr, CommandLine.unsafeArgv, environ)
        fail("re-exec with disclaimed responsibility failed (\(String(cString: strerror(rc))))")
    }

    private static func executablePath() -> String {
        var size: UInt32 = 0
        _ = _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size) + 1)
        guard _NSGetExecutablePath(&buffer, &size) == 0 else { fail("cannot read the executable path") }
        var resolved = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(buffer, &resolved) != nil else { return String(cString: buffer) }
        return String(cString: resolved)
    }

    private static func fail(_ message: String) -> Never {
        Wire.log("TCC trampoline: \(message)")
        exit(70)
    }
}
