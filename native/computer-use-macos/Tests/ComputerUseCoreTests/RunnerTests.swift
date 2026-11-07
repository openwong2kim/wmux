import Foundation
import XCTest
@testable import ComputerUseCore

final class RunnerPolicyTests: XCTestCase {
    func testParsesARunAndCapsItsTimeout() throws {
        let message = try RunnerPolicy.parse(["id": 3, "argv": ["snapshot", "--app", "X"], "timeoutMs": 999_999, "home": "/tmp/ad"])
        XCTAssertEqual(message, .run(RunRequest(id: 3, argv: ["snapshot", "--app", "X"], timeoutMs: RunnerPolicy.maxTimeoutMs, home: "/tmp/ad")))
    }

    func testParsesACancel() throws {
        XCTAssertEqual(try RunnerPolicy.parse(["cancel": 7]), .cancel(id: 7))
    }

    func testRefusesCommandsOutsideItsList() {
        for command in ["click", "type", "clipboard-get", "batch", "launch", "screenshot", "permissions", "mcp", "skills"] {
            XCTAssertThrowsError(try RunnerPolicy.parse(["id": 1, "argv": [command], "home": "/tmp/ad"]), command)
        }
    }

    func testRefusesOptionsThatDriveInputOrWriteFiles() {
        for arg in ["--headed", "--trace", "--trace=/tmp/t", "--trace-strict", "--debug", "--screenshot", "--screenshot=/tmp/x.png"] {
            XCTAssertThrowsError(try RunnerPolicy.parse(["id": 1, "argv": ["snapshot", arg], "home": "/tmp/ad"]), arg)
        }
    }

    func testRefusesARelativeOrClimbingHome() {
        for home in ["ad", "/tmp/../etc", ""] {
            XCTAssertThrowsError(try RunnerPolicy.parse(["id": 1, "argv": ["version"], "home": home]), home)
        }
    }

    func testTheChildEnvironmentCarriesNothingElseFromTheHelper() {
        let env = RunnerPolicy.environment(home: "/tmp/ad", inherited: [
            "HOME": "/Users/x",
            "TMPDIR": "/tmp/x/",
            "LANG": "en_US.UTF-8",
            "PATH": "/evil:/usr/bin",
            "AGENT_DESKTOP_MACOS_HELPER_PATH": "/tmp/other",
            "AGENT_DESKTOP_HOME": "/tmp/elsewhere",
            "AGENT_DESKTOP_INTERNAL_COMMAND_HOST": "1",
            "DYLD_INSERT_LIBRARIES": "/tmp/x.dylib",
            "WMUX_COMPUTER_USE_DISCLAIMED": "1",
        ])
        XCTAssertEqual(env, [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "AGENT_DESKTOP_HOME": "/tmp/ad",
            "HOME": "/Users/x",
            "TMPDIR": "/tmp/x/",
            "LANG": "en_US.UTF-8",
        ])
    }
}

final class ChildGateTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("childgate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    /// A copy of /usr/bin/true signed ad-hoc with agent-desktop's identifier.
    private func adHocChild() throws -> String {
        let path = dir.appendingPathComponent("agent-desktop").path
        try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: path)
        let sign = Process()
        sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        sign.arguments = ["--force", "--sign", "-", "--identifier", ChildGate.childIdentifier, path]
        sign.standardError = FileHandle.nullDevice
        try sign.run()
        sign.waitUntilExit()
        XCTAssertEqual(sign.terminationStatus, 0)
        return path
    }

    func testATeamSignedHelperRequiresTheTeamAndTheIdentifier() throws {
        let requirement = try XCTUnwrap(ChildGate.childRequirement(helperIsTeamSigned: true))
        XCTAssertTrue(requirement.contains(#"certificate leaf[subject.OU] = "8RGHH2F237""#))
        XCTAssertTrue(requirement.contains(#"identifier "com.electron.wmux.agent-desktop""#))
        XCTAssertNil(ChildGate.childRequirement(helperIsTeamSigned: false))
    }

    func testATeamSignedHelperRefusesAnAdHocChildWhateverTheEnvironmentSays() throws {
        let path = try adHocChild()
        setenv("WMUX_ALLOW_ANY_PARENT", "1", 1)
        setenv("AGENT_DESKTOP_MACOS_HELPER_PATH", path, 1)
        defer {
            unsetenv("WMUX_ALLOW_ANY_PARENT")
            unsetenv("AGENT_DESKTOP_MACOS_HELPER_PATH")
        }
        XCTAssertThrowsError(try ChildGate(path: path, requirement: ChildGate.childRequirement(helperIsTeamSigned: true))) { error in
            XCTAssertEqual((error as? RunnerProblem)?.code, "helper_unavailable")
        }
    }

    func testADevHelperStartsWhatTheDeveloperBuilt() throws {
        let gate = try ChildGate(path: try adHocChild(), requirement: nil)
        XCTAssertNoThrow(try gate.checkBeforeSpawn())
    }

    func testAMissingChildIsUnavailable() {
        XCTAssertThrowsError(try ChildGate(path: dir.appendingPathComponent("absent").path, requirement: nil)) { error in
            XCTAssertEqual((error as? RunnerProblem)?.code, "helper_unavailable")
        }
    }

    /// A program that writes `tag` to the file named by its first argument.
    private func program(_ tag: String, identifier: String = ChildGate.childIdentifier) throws -> String {
        let src = dir.appendingPathComponent("\(tag).c").path
        let bin = dir.appendingPathComponent(tag).path
        try #"#include <stdio.h>\#nint main(int c, char **v) { FILE *f = fopen(v[1], "w"); if (!f) return 1; fputs("\#(tag)", f); fclose(f); return 0; }\#n"#.write(toFile: src, atomically: true, encoding: .utf8)
        for (tool, args) in [("/usr/bin/cc", ["-arch", "arm64", "-o", bin, src]), ("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, bin])] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = args
            p.standardError = FileHandle.nullDevice
            try p.run()
            p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0, tool)
        }
        return bin
    }

    /// Spawns through the gate with no file actions and waits for the child.
    private func spawnAndWait(_ gate: ChildGate, marker: String) throws -> Int32 {
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        let pid = try gate.spawnChecked(argv: [marker], environment: [:], fileActions: &actions)
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
        return status
    }

    func testTheCheckedBinaryRuns() throws {
        let path = dir.appendingPathComponent("agent-desktop").path
        try FileManager.default.copyItem(atPath: try program("checked"), toPath: path)
        let gate = try ChildGate(path: path, requirement: nil)
        let marker = dir.appendingPathComponent("ran").path
        XCTAssertEqual(try spawnAndWait(gate, marker: marker), 0)
        XCTAssertEqual(try String(contentsOfFile: marker, encoding: .utf8), "checked")
    }

    func testABinarySwappedAfterTheCheckNeverRuns() throws {
        let path = dir.appendingPathComponent("agent-desktop").path
        try FileManager.default.copyItem(atPath: try program("checked"), toPath: path)
        let swapped = try program("swapped")
        let gate = try ChildGate(path: path, requirement: nil)
        XCTAssertNoThrow(try gate.checkBeforeSpawn())
        // Between the check and the spawn: the file at the path is replaced.
        XCTAssertEqual(rename(swapped, path), 0)
        let marker = dir.appendingPathComponent("ran").path
        XCTAssertThrowsError(try spawnAndWait(gate, marker: marker)) { error in
            XCTAssertTrue((error as? RunnerProblem)?.message.contains("not the binary that was checked") ?? false, "\(error)")
        }
        // Killed while suspended: it never reached main().
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker))
    }

    func testAReplacedBinaryIsCheckedAgainBeforeTheNextSpawn() throws {
        let path = dir.appendingPathComponent("agent-desktop").path
        try FileManager.default.copyItem(atPath: try program("checked"), toPath: path)
        let other = try program("other", identifier: "com.example.other")
        let gate = try ChildGate(path: path, requirement: #"identifier "com.electron.wmux.agent-desktop""#)
        XCTAssertEqual(rename(other, path), 0)
        XCTAssertThrowsError(try gate.checkBeforeSpawn())
    }
}
