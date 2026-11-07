// The rules of the helper's runner mode (`--runner`): which requests it
// accepts, the environment a child gets, and which agent-desktop binary it
// may start. The process plumbing lives in wmux-computer-use/Runner.swift.

import Foundation
import Security

/// A request the runner refuses, reported as `{ok:false, error:{code, message}}`.
public struct RunnerProblem: Error, Equatable {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// One agent-desktop invocation, as main asked for it.
public struct RunRequest: Equatable {
    public let id: Int
    /// The arguments after the binary name; the first is the command.
    public let argv: [String]
    public let timeoutMs: Int
    /// AGENT_DESKTOP_HOME for the child: agent-desktop's state directory.
    public let home: String
}

public enum RunnerMessage: Equatable {
    case run(RunRequest)
    case cancel(id: Int)
}

public enum RunnerPolicy {
    /// The commands the runner starts. main decides what an agent may ask for;
    /// this list is the runner's own floor under it. main runs list-apps
    /// itself, to check which app a display name picks.
    public static let commands: Set<String> = readCommands.union(actionCommands)

    static let readCommands: Set<String> = ["snapshot", "find", "get", "is", "list-surfaces", "wait", "list-apps", "version"]

    /// The ref actions: each acts on one element of a snapshot, named by its
    /// ref, and takes nothing that could point it anywhere else (an app, a
    /// window, a root or a surface).
    static let actionCommands: Set<String> = ["click", "focus", "select", "toggle", "check", "uncheck", "expand", "collapse", "scroll"]

    static let refPattern = try! NSRegularExpression(pattern: "^@[a-z0-9]{1,64}:e[1-9][0-9]{0,8}$")

    /// Global options the runner never passes on, whatever main sends.
    static let refusedOptions: [String] = ["--headed", "--trace", "--debug", "--screenshot"]

    /// Longest run main may ask for. A longer one is cut to this.
    public static let maxTimeoutMs = 35_000

    /// stdout a child may write before it is stopped.
    public static let maxOutputBytes = 8 << 20

    /// stderr kept for the reply; the rest is dropped.
    public static let maxErrorBytes = 16 << 10

    public static func parse(_ object: [String: Any]) throws -> RunnerMessage {
        if let cancel = object["cancel"] as? NSNumber, CFGetTypeID(cancel) != CFBooleanGetTypeID() {
            return .cancel(id: cancel.intValue)
        }
        guard let idNumber = object["id"] as? NSNumber, CFGetTypeID(idNumber) != CFBooleanGetTypeID() else {
            throw RunnerProblem("invalid_argument", "id must be a number")
        }
        guard let argv = object["argv"] as? [String], let command = argv.first else {
            throw RunnerProblem("invalid_argument", "argv must be a non-empty array of strings")
        }
        guard commands.contains(command) else {
            throw RunnerProblem("invalid_argument", "the runner does not start \(command)")
        }
        for arg in argv where refusedOptions.contains(where: { arg == $0 || arg.hasPrefix($0 + "=") || arg.hasPrefix($0 + "-") }) {
            throw RunnerProblem("invalid_argument", "the runner does not pass \(arg)")
        }
        if actionCommands.contains(command) { try checkAction(command, argv) }
        guard let home = object["home"] as? String, isPlainAbsolutePath(home) else {
            throw RunnerProblem("invalid_argument", "home must be an absolute path")
        }
        let requested = (object["timeoutMs"] as? NSNumber)?.intValue ?? maxTimeoutMs
        let timeoutMs = min(max(requested, 1), maxTimeoutMs)
        return .run(RunRequest(id: idNumber.intValue, argv: argv, timeoutMs: timeoutMs, home: home))
    }

    /// An action's argv: the command, a ref, then only that command's own
    /// arguments (select's value after "--", scroll's direction and amount).
    static func checkAction(_ command: String, _ argv: [String]) throws {
        guard argv.count >= 2, refPattern.firstMatch(in: argv[1], range: NSRange(argv[1].startIndex..., in: argv[1])) != nil else {
            throw RunnerProblem("invalid_argument", "\(command) takes a ref (@<snapshot>:eN) as its first argument")
        }
        let rest = Array(argv.dropFirst(2))
        let allowed: Bool
        switch command {
        case "select":
            allowed = rest.count == 2 && rest[0] == "--"
        case "scroll":
            allowed = rest.allSatisfy { $0.hasPrefix("--direction=") || $0.hasPrefix("--amount=") }
        default:
            allowed = rest.isEmpty
        }
        guard allowed else {
            throw RunnerProblem("invalid_argument", "the runner does not pass \(rest.joined(separator: " ")) to \(command)")
        }
    }

    /// The child's whole environment: a fixed PATH, the person's HOME, TMPDIR
    /// and locale, and the state directory main chose. Nothing else from the
    /// helper's own environment reaches it.
    public static func environment(home: String, inherited: [String: String]) -> [String: String] {
        var env: [String: String] = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "AGENT_DESKTOP_HOME": home,
        ]
        for key in ["HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] {
            if let value = inherited[key] { env[key] = value }
        }
        return env
    }

    static func isPlainAbsolutePath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.contains("\0") else { return false }
        return !path.split(separator: "/").contains("..")
    }
}

/// Which agent-desktop binary the runner may start.
///
/// A helper signed by the wmux team starts only a binary signed by the same
/// team with agent-desktop's identifier. The file is checked when the runner
/// starts and again whenever its identity changes; every process is started
/// suspended and runs only if it is running the code that was checked (and,
/// under a team-signed helper, meets the requirement). A helper that is not
/// team-signed is a dev build, which starts what the developer built. The
/// helper's own signature decides, never an argument, a path or the
/// environment.
public final class ChildGate {
    public static let teamID = "8RGHH2F237"
    public static let helperIdentifier = "com.electron.wmux.computer-use"
    public static let childIdentifier = "com.electron.wmux.agent-desktop"

    public static func requirement(identifier: String) -> String {
        #"anchor apple generic and certificate leaf[subject.OU] = "\#(teamID)" and identifier "\#(identifier)""#
    }

    /// The requirement a child must meet, given how this helper is signed.
    public static func childRequirement(helperIsTeamSigned: Bool) -> String? {
        helperIsTeamSigned ? requirement(identifier: childIdentifier) : nil
    }

    /// Whether this process is the wmux team's helper, from its own code (SecCodeCopySelf).
    public static func helperIsTeamSigned() -> Bool {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return false }
        return satisfies(me, requirement(identifier: helperIdentifier))
    }

    public let path: String
    private let requirement: String?
    private var pinned: FileIdentity?
    /// The code directory hash of the binary as last checked: the process a
    /// spawn starts must be running exactly this code.
    private var pinnedHash: Data?

    /// Throws `helper_unavailable` when the binary is missing or, under a
    /// requirement, does not meet it.
    public init(path: String, requirement: String?) throws {
        self.path = path
        self.requirement = requirement
        try check()
    }

    /// Run before every spawn. The file is checked again only when its
    /// identity changed since the last check; the started process is what
    /// spawnChecked verifies either way.
    public func checkBeforeSpawn() throws {
        guard let now = FileIdentity(path: path) else { throw ChildGate.missing }
        if now != pinned { try check() }
    }

    /// Starts the binary suspended, checks the code the new process is
    /// running (the pinned code directory hash, and the requirement under a
    /// team-signed helper), and only then lets it run. A process that fails
    /// is killed and reaped before it executes an instruction of its own.
    public func spawnChecked(
        argv: [String],
        environment: [String: String],
        fileActions: UnsafePointer<posix_spawn_file_actions_t?>
    ) throws -> pid_t {
        guard let expected = pinnedHash else { throw ChildGate.missing }
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Default signal dispositions (the runner ignores SIGPIPE and the
        // termination signals); no inherited descriptors beyond the file
        // actions; stopped before its first instruction.
        var defaults = sigset_t()
        sigfillset(&defaults)
        posix_spawnattr_setsigdefault(&attr, &defaults)
        var empty = sigset_t()
        sigemptyset(&empty)
        posix_spawnattr_setsigmask(&attr, &empty)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_START_SUSPENDED))

        let cArgv = ([path] + argv).map { strdup($0) } + [nil]
        let cEnv = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            cArgv.forEach { free($0) }
            cEnv.forEach { free($0) }
        }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, fileActions, &attr, cArgv, cEnv)
        guard rc == 0 else {
            throw RunnerProblem("helper_unavailable", "the desktop component could not start (\(String(cString: strerror(rc))))")
        }
        if let refusal = ChildGate.refusal(pid: pid, expectedHash: expected, requirement: requirement) {
            kill(pid, SIGKILL)
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            throw RunnerProblem("helper_unavailable", refusal)
        }
        kill(pid, SIGCONT)
        return pid
    }

    private static let missing = RunnerProblem("helper_unavailable", "the desktop component is missing from this wmux build")

    /// Why the suspended process `pid` may not run, or nil.
    static func refusal(pid: pid_t, expectedHash: Data, requirement: String?) -> String? {
        var code: SecCode?
        let attrs = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else {
            return "the started desktop component could not be examined"
        }
        if let requirement {
            var req: SecRequirement?
            guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req,
                  SecCodeCheckValidity(code, [], req) == errSecSuccess else {
                return "the started desktop component does not meet its code requirement"
            }
        }
        // The kernel's record of the code it loaded, not the file on disk.
        guard codeHash(unsafeBitCast(code, to: SecStaticCode.self), flags: SecCSFlags(rawValue: kSecCSDynamicInformation)) == expectedHash else {
            return "the started desktop component is not the binary that was checked"
        }
        return nil
    }

    static func codeHash(_ code: SecStaticCode, flags: SecCSFlags) -> Data? {
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, flags, &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return nil }
        return dict[kSecCodeInfoUnique as String] as? Data
    }

    /// Checks the file and pins its identity and code directory hash.
    private func check() throws {
        guard let before = FileIdentity(path: path) else { throw ChildGate.missing }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code else {
            throw RunnerProblem("helper_unavailable", "the desktop component could not be examined")
        }
        if let requirement {
            var req: SecRequirement?
            guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else {
                throw RunnerProblem("helper_unavailable", "the desktop component requirement did not parse")
            }
            let status = SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), req)
            guard status == errSecSuccess else {
                throw RunnerProblem("helper_unavailable", "the desktop component failed its code-signature check (OSStatus \(status))")
            }
        }
        // Linker-signed at the least, so every build has one.
        guard let hash = ChildGate.codeHash(code, flags: []) else {
            throw RunnerProblem("helper_unavailable", "the desktop component carries no code signature")
        }
        // The file judged must be the file pinned.
        guard FileIdentity(path: path) == before else {
            throw RunnerProblem("helper_unavailable", "the desktop component changed while it was being checked")
        }
        pinned = before
        pinnedHash = hash
    }

    private static func satisfies(_ code: SecCode, _ requirement: String) -> Bool {
        var req: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else { return false }
        return SecCodeCheckValidity(code, [], req) == errSecSuccess
    }
}

/// Device, inode, size, mtime and ctime: changes whenever the file is
/// replaced or written. ctime cannot be set back the way mtime can.
public struct FileIdentity: Equatable {
    let dev: Int64
    let ino: UInt64
    let size: Int64
    let mtime: timespec
    let ctime: timespec

    public init?(path: String) {
        var st = stat()
        guard stat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return nil }
        dev = Int64(st.st_dev)
        ino = UInt64(st.st_ino)
        size = Int64(st.st_size)
        mtime = st.st_mtimespec
        ctime = st.st_ctimespec
    }

    public static func == (a: FileIdentity, b: FileIdentity) -> Bool {
        a.dev == b.dev && a.ino == b.ino && a.size == b.size
            && a.mtime.tv_sec == b.mtime.tv_sec && a.mtime.tv_nsec == b.mtime.tv_nsec
            && a.ctime.tv_sec == b.ctime.tv_sec && a.ctime.tv_nsec == b.ctime.tv_nsec
    }
}
