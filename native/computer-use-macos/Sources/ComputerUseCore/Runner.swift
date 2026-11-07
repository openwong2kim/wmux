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
    /// this list is the runner's own floor under it.
    public static let commands: Set<String> = ["snapshot", "find", "get", "is", "list-surfaces", "wait", "version"]

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
        guard let home = object["home"] as? String, isPlainAbsolutePath(home) else {
            throw RunnerProblem("invalid_argument", "home must be an absolute path")
        }
        let requested = (object["timeoutMs"] as? NSNumber)?.intValue ?? maxTimeoutMs
        let timeoutMs = min(max(requested, 1), maxTimeoutMs)
        return .run(RunRequest(id: idNumber.intValue, argv: argv, timeoutMs: timeoutMs, home: home))
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
/// team with agent-desktop's identifier, checked when the runner starts and
/// again before every spawn, with the file's identity pinned in between. A
/// helper that is not team-signed is a dev build, which starts what the
/// developer built. The helper's own signature decides, never an argument,
/// a path or the environment.
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

    /// Throws `helper_unavailable` when the binary is missing or, under a
    /// requirement, does not meet it.
    public init(path: String, requirement: String?) throws {
        self.path = path
        self.requirement = requirement
        pinned = try check()
    }

    /// Run before every spawn: the file must still be the one checked, and
    /// still meet the requirement.
    public func checkBeforeSpawn() throws {
        guard requirement != nil else {
            guard FileIdentity(path: path) != nil else { throw ChildGate.missing }
            return
        }
        guard let now = FileIdentity(path: path) else { throw ChildGate.missing }
        guard now == pinned else {
            throw RunnerProblem("helper_unavailable", "the desktop component changed after it was checked")
        }
        pinned = try check()
    }

    private static let missing = RunnerProblem("helper_unavailable", "the desktop component is missing from this wmux build")

    private func check() throws -> FileIdentity? {
        guard let before = FileIdentity(path: path) else { throw ChildGate.missing }
        guard let requirement else { return before }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code else {
            throw RunnerProblem("helper_unavailable", "the desktop component could not be examined")
        }
        var req: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else {
            throw RunnerProblem("helper_unavailable", "the desktop component requirement did not parse")
        }
        let status = SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), req)
        guard status == errSecSuccess else {
            throw RunnerProblem("helper_unavailable", "the desktop component failed its code-signature check (OSStatus \(status))")
        }
        // The file judged must be the file pinned.
        guard FileIdentity(path: path) == before else {
            throw RunnerProblem("helper_unavailable", "the desktop component changed while it was being checked")
        }
        return before
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
