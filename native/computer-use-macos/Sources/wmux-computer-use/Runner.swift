// Runner mode (`--runner`): starts the agent-desktop binary nested in this
// bundle, one child per request, several at once, and reports each child's
// output over NDJSON. Runs after Parent.enforce() and the TCC trampoline, so a
// child's responsible process is this helper. Protocol 2 (Server.swift) is
// untouched; main runs this mode as a separate process (RunnerProcess.ts).
//
//   main → {"id":1,"argv":["snapshot",…],"timeoutMs":5000,"home":"/…"}
//   main → {"cancel":1}
//   ← {"runner":1,"ready":true}                          once, at start
//   ← {"id":1,"event":"started","pid":123}               the child's pid = its process group
//   ← {"id":1,"ok":true,"exitCode":0,"stdout":"…","stderr":"…"}
//   ← {"id":1,"ok":false,"error":{"code":"…","message":"…"}}
//
// Every child runs in its own process group. A cancel, a timeout or too much
// output kills that group; stdin EOF or SIGTERM kills every group, then exits.

import ComputerUseCore
import Darwin
import Foundation

enum Runner {
    private static let lock = NSLock()
    private static var children: [Int: pid_t] = [:]
    private static var canceled: Set<Int> = []
    private static var gate: ChildGate?
    private static var gateProblem: RunnerProblem?

    static func run() -> Never {
        let path = (bundleExecutableDirectory() as NSString).appendingPathComponent("agent-desktop")
        do {
            gate = try ChildGate(path: path, requirement: ChildGate.childRequirement(helperIsTeamSigned: ChildGate.helperIsTeamSigned()))
        } catch let problem as RunnerProblem {
            gateProblem = problem
        } catch {
            gateProblem = RunnerProblem("helper_unavailable", "\(error)")
        }

        signal(SIGPIPE, SIG_IGN)
        var sources: [DispatchSourceSignal] = []
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global(qos: .userInteractive))
            source.setEventHandler { killAllAndExit() }
            source.resume()
            sources.append(source)
        }

        Wire.send(["runner": 1, "ready": gateProblem == nil])
        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? JSON else { continue }
            let message: RunnerMessage
            do {
                message = try RunnerPolicy.parse(object)
            } catch let problem as RunnerProblem {
                let id = (object["id"] as? NSNumber)?.intValue
                Wire.send(["id": id ?? -1, "ok": false, "error": ["code": problem.code, "message": problem.message]], id: id)
                continue
            } catch {
                continue
            }
            switch message {
            case .cancel(let id):
                cancel(id)
            case .run(let request):
                DispatchQueue.global(qos: .userInitiated).async { execute(request) }
            }
        }
        // stdin EOF: wmux closed the pipe or is gone.
        killAllAndExit()
    }

    private static func cancel(_ id: Int) {
        lock.lock()
        canceled.insert(id)
        let pid = children[id]
        lock.unlock()
        if let pid { kill(-pid, SIGKILL) }
    }

    private static func killAllAndExit() -> Never {
        lock.lock()
        let pids = Array(children.values)
        lock.unlock()
        for pid in pids { kill(-pid, SIGKILL) }
        exit(0)
    }

    private static func fail(_ id: Int, _ problem: RunnerProblem) {
        Wire.send(["id": id, "ok": false, "error": ["code": problem.code, "message": problem.message]], id: id)
    }

    private static func execute(_ request: RunRequest) {
        lock.lock()
        let gate = self.gate
        let problem = gateProblem
        var checked: RunnerProblem?
        if let gate {
            do { try gate.checkBeforeSpawn() } catch let p as RunnerProblem { checked = p } catch { checked = RunnerProblem("internal", "\(error)") }
        }
        lock.unlock()
        guard let gate, problem == nil else { return fail(request.id, problem ?? RunnerProblem("helper_unavailable", "the desktop component is unavailable")) }
        if let checked { return fail(request.id, checked) }

        var out: [Int32] = [0, 0]
        var err: [Int32] = [0, 0]
        guard pipe(&out) == 0, pipe(&err) == 0 else { return fail(request.id, RunnerProblem("internal", "pipe failed")) }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, out[1], 1)
        posix_spawn_file_actions_adddup2(&actions, err[1], 2)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Own process group (pgid = pid); default signal dispositions (this
        // process ignores SIGPIPE and the termination signals); no inherited
        // descriptors beyond the three above.
        posix_spawnattr_setpgroup(&attr, 0)
        var defaults = sigset_t()
        sigfillset(&defaults)
        posix_spawnattr_setsigdefault(&attr, &defaults)
        var empty = sigset_t()
        sigemptyset(&empty)
        posix_spawnattr_setsigmask(&attr, &empty)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT))

        let env = RunnerPolicy.environment(home: request.home, inherited: ProcessInfo.processInfo.environment)
        let argv = [gate.path] + request.argv
        let cArgv = argv.map { strdup($0) } + [nil]
        let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            cArgv.forEach { free($0) }
            cEnv.forEach { free($0) }
        }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, gate.path, &actions, &attr, cArgv, cEnv)
        close(out[1])
        close(err[1])
        guard rc == 0 else {
            close(out[0])
            close(err[0])
            return fail(request.id, RunnerProblem("helper_unavailable", "the desktop component could not start (\(String(cString: strerror(rc))))"))
        }

        lock.lock()
        children[request.id] = pid
        let canceledEarly = canceled.contains(request.id)
        lock.unlock()
        if canceledEarly { kill(-pid, SIGKILL) }
        Wire.send(["id": request.id, "event": "started", "pid": Int(pid)], id: request.id)

        let outcome = collect(out: out[0], err: err[0], pid: pid, deadline: DispatchTime.now() + .milliseconds(request.timeoutMs))
        close(out[0])
        close(err[0])

        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
        // Anything the child left in its group goes with it.
        kill(-pid, SIGKILL)

        lock.lock()
        children[request.id] = nil
        let wasCanceled = canceled.remove(request.id) != nil
        lock.unlock()

        if wasCanceled { return fail(request.id, RunnerProblem("aborted", "the run was stopped")) }
        switch outcome.end {
        case .timedOut:
            return fail(request.id, RunnerProblem("timeout", "agent-desktop did not finish within \(request.timeoutMs) ms"))
        case .tooMuchOutput:
            return fail(request.id, RunnerProblem("internal", "agent-desktop wrote more than \(RunnerPolicy.maxOutputBytes) bytes"))
        case .finished:
            break
        }
        var reply: JSON = [
            "id": request.id,
            "ok": true,
            "stdout": String(decoding: outcome.stdout, as: UTF8.self),
            "stderr": String(decoding: outcome.stderr, as: UTF8.self),
        ]
        if status & 0x7f == 0 {
            reply["exitCode"] = Int((status >> 8) & 0xff)
        } else {
            reply["signal"] = Int(status & 0x7f)
        }
        Wire.send(reply, id: request.id)
    }

    private enum End { case finished, timedOut, tooMuchOutput }

    /// Reads both pipes until EOF, the deadline or the output cap; kills the
    /// child's group on the last two.
    private static func collect(out: Int32, err: Int32, pid: pid_t, deadline: DispatchTime) -> (stdout: Data, stderr: Data, end: End) {
        var stdout = Data()
        var stderr = Data()
        var fds = [pollfd(fd: out, events: Int16(POLLIN), revents: 0), pollfd(fd: err, events: Int16(POLLIN), revents: 0)]
        var open = 2
        var buffer = [UInt8](repeating: 0, count: 64 << 10)
        while open > 0 {
            let now = DispatchTime.now()
            guard now < deadline else {
                kill(-pid, SIGKILL)
                return (stdout, stderr, .timedOut)
            }
            let waitMs = Int32(min((deadline.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000 + 1, 1_000))
            let n = poll(&fds, nfds_t(fds.count), waitMs)
            if n < 0 {
                if errno == EINTR { continue }
                break
            }
            for i in fds.indices where fds[i].fd >= 0 && fds[i].revents != 0 {
                let count = read(fds[i].fd, &buffer, buffer.count)
                if count <= 0 {
                    fds[i].fd = -1
                    open -= 1
                    continue
                }
                if i == 0 {
                    stdout.append(contentsOf: buffer[0..<count])
                    if stdout.count > RunnerPolicy.maxOutputBytes {
                        kill(-pid, SIGKILL)
                        return (stdout, stderr, .tooMuchOutput)
                    }
                } else if stderr.count < RunnerPolicy.maxErrorBytes {
                    stderr.append(contentsOf: buffer[0..<min(count, RunnerPolicy.maxErrorBytes - stderr.count)])
                }
            }
        }
        return (stdout, stderr, .finished)
    }

    private static func bundleExecutableDirectory() -> String {
        var size: UInt32 = 0
        _ = _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size) + 1)
        guard _NSGetExecutablePath(&buffer, &size) == 0 else { return "/nonexistent" }
        var resolved = [CChar](repeating: 0, count: Int(PATH_MAX))
        let path = realpath(buffer, &resolved) != nil ? String(cString: resolved) : String(cString: buffer)
        return (path as NSString).deletingLastPathComponent
    }
}
