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
        for command in ["click", "type", "clipboard-get", "batch", "launch", "screenshot", "permissions", "mcp"] {
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

    func testAChildReplacedAfterTheCheckIsRefused() throws {
        let path = try adHocChild()
        // A requirement this ad-hoc copy meets, so the pin is what decides.
        let gate = try ChildGate(path: path, requirement: #"identifier "com.electron.wmux.agent-desktop""#)
        XCTAssertNoThrow(try gate.checkBeforeSpawn())
        let swapped = dir.appendingPathComponent("swapped").path
        try FileManager.default.copyItem(atPath: path, toPath: swapped)
        XCTAssertEqual(rename(swapped, path), 0)
        XCTAssertThrowsError(try gate.checkBeforeSpawn()) { error in
            XCTAssertTrue((error as? RunnerProblem)?.message.contains("changed") ?? false)
        }
    }
}
