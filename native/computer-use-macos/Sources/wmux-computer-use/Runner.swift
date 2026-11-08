// Runner mode (`--runner`): starts the agent-desktop binary nested in this
// bundle, one child per request, several at once, and reports each child's
// output over NDJSON. Runs after Parent.enforce() and the TCC trampoline, so a
// child's responsible process is this helper. Protocol 2 (Server.swift) is
// untouched; main runs this mode as a separate process (RunnerProcess.ts).
//
//   main → {"id":1,"argv":["snapshot",…],"timeoutMs":5000,"home":"/…"}
//   main → {"cancel":1}
//   ← {"runner":1,"ready":true}                          once, at start
//   ← {"id":1,"event":"started","pid":123}               the child's pid
//   ← {"id":1,"ok":true,"exitCode":0,"stdout":"…","stderr":"…"}
//   ← {"id":1,"ok":false,"error":{"code":"…","message":"…"}}
//
// Children stay in the runner's process group, which main starts the runner
// as the leader of (RunnerProcess.ts). A cancel, a timeout or too much output
// kills that child, which only this process may name: it has not reaped it,
// so its pid cannot have been reused. stdin EOF or SIGTERM kills the whole
// group, children and anything they started included, and with it the
// runner. If the runner stops answering, main kills the same group, which it
// may name for the same reason: it has not reaped the runner.

import ComputerUseCore
import Darwin
import Foundation

enum Runner {
    private static let lock = NSLock()
    /// Taken for the child check alone, which hashes the binary: a cancel
    /// must not wait behind it.
    private static let gateLock = NSLock()
    /// Requests accepted and not yet answered; only these can be canceled.
    private static var active: Set<Int> = []
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
        // main closed the pipe: nothing reads the replies, so nothing may run.
        Wire.onOutputClosed = { killAllAndExit() }
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
                lock.lock()
                active.insert(request.id)
                lock.unlock()
                DispatchQueue.global(qos: .userInitiated).async { execute(request) }
            }
        }
        // stdin EOF: wmux closed the pipe or is gone.
        killAllAndExit()
    }

    private static func cancel(_ id: Int) {
        lock.lock()
        // A cancel for a run that already answered (or never came) is dropped.
        if active.contains(id) { canceled.insert(id) }
        let pid = children[id]
        lock.unlock()
        if let pid { kill(pid, SIGKILL) }
    }

    private static func killAllAndExit() -> Never {
        lock.lock()
        let pids = Array(children.values)
        lock.unlock()
        // Leader of its own group (main's spawn): the group goes at once, this
        // process last. Otherwise (started by hand) only its own children.
        if getpgrp() == getpid() {
            kill(0, SIGKILL)
        }
        for pid in pids { kill(pid, SIGKILL) }
        exit(0)
    }

    private static func fail(_ id: Int, _ problem: RunnerProblem) {
        Wire.send(["id": id, "ok": false, "error": ["code": problem.code, "message": problem.message]], id: id)
    }

    private static func execute(_ request: RunRequest) {
        defer {
            lock.lock()
            active.remove(request.id)
            canceled.remove(request.id)
            lock.unlock()
        }
        guard let gate = self.gate, gateProblem == nil else {
            return fail(request.id, gateProblem ?? RunnerProblem("helper_unavailable", "the desktop component is unavailable"))
        }

        var out: [Int32] = [0, 0]
        var err: [Int32] = [0, 0]
        guard pipe(&out) == 0, pipe(&err) == 0 else { return fail(request.id, RunnerProblem("internal", "pipe failed")) }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, out[1], 1)
        posix_spawn_file_actions_adddup2(&actions, err[1], 2)

        // Checked and started under the gate's own lock (the check may hash
        // the binary; a cancel must not wait behind it). The child stays in
        // this process's group.
        let env = RunnerPolicy.environment(home: request.home, inherited: ProcessInfo.processInfo.environment)
        var spawned: Result<pid_t, RunnerProblem>
        gateLock.lock()
        do {
            try gate.checkBeforeSpawn()
            spawned = .success(try gate.spawnChecked(argv: request.argv, environment: env, fileActions: &actions))
        } catch let p as RunnerProblem {
            spawned = .failure(p)
        } catch {
            spawned = .failure(RunnerProblem("internal", "\(error)"))
        }
        gateLock.unlock()
        close(out[1])
        close(err[1])
        let pid: pid_t
        switch spawned {
        case .success(let started):
            pid = started
        case .failure(let problem):
            close(out[0])
            close(err[0])
            return fail(request.id, problem)
        }

        lock.lock()
        children[request.id] = pid
        let canceledEarly = canceled.contains(request.id)
        lock.unlock()
        if canceledEarly { kill(pid, SIGKILL) }
        Wire.send(["id": request.id, "event": "started", "pid": Int(pid)], id: request.id)

        let outcome = collect(id: request.id, out: out[0], err: err[0], pid: pid, deadline: DispatchTime.now() + .milliseconds(request.timeoutMs))
        close(out[0])
        close(err[0])

        // Wait for the exit without reaping (WNOWAIT): until the child is
        // taken out of `children`, a cancel may still kill(pid), and an
        // unreaped pid cannot belong to anyone else.
        var info = siginfo_t()
        while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) < 0 && errno == EINTR {}
        lock.lock()
        children[request.id] = nil
        let wasCanceled = canceled.contains(request.id)
        lock.unlock()
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}

        if wasCanceled { return fail(request.id, RunnerProblem("aborted", "the run was stopped")) }
        switch outcome.end {
        case .timedOut:
            return fail(request.id, RunnerProblem("timeout", "agent-desktop did not finish within \(request.timeoutMs) ms"))
        case .tooMuchOutput:
            return fail(request.id, RunnerProblem("internal", "agent-desktop wrote more than \(RunnerPolicy.maxOutputBytes) bytes"))
        case .canceled:
            return fail(request.id, RunnerProblem("aborted", "the run was stopped"))
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

    private enum End { case finished, timedOut, tooMuchOutput, canceled }

    /// Reads both pipes until EOF, the deadline, the output cap or a cancel;
    /// kills the child on the last three. A cancel ends the read at once:
    /// anything the child started may still hold the pipes open.
    private static func collect(id: Int, out: Int32, err: Int32, pid: pid_t, deadline: DispatchTime) -> (stdout: Data, stderr: Data, end: End) {
        var stdout = Data()
        var stderr = Data()
        var fds = [pollfd(fd: out, events: Int16(POLLIN), revents: 0), pollfd(fd: err, events: Int16(POLLIN), revents: 0)]
        var open = 2
        var buffer = [UInt8](repeating: 0, count: 64 << 10)
        while open > 0 {
            lock.lock()
            let isCanceled = canceled.contains(id)
            lock.unlock()
            if isCanceled {
                kill(pid, SIGKILL)
                return (stdout, stderr, .canceled)
            }
            let now = DispatchTime.now()
            guard now < deadline else {
                kill(pid, SIGKILL)
                return (stdout, stderr, .timedOut)
            }
            let waitMs = Int32(min((deadline.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000 + 1, 100))
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
                        kill(pid, SIGKILL)
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
