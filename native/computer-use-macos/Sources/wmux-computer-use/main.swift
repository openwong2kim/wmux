// wmux Computer Use: the macOS computer-use helper. Speaks the NDJSON protocol
// of src/shared/computer/protocol.ts over stdio; see docs/computer-use-macos.md.

import AppKit
import ApplicationServices
import Foundation

// Only signed wmux may drive this helper (Parent.swift); checked before the
// trampoline, while the parent is still the process that spawned us.
Parent.enforce()

// Own TCC identity first: nothing below may touch AX or capture as wmux.
Trampoline.ensureSelfResponsible()

if CommandLine.arguments.contains("--request-permissions") {
    // Onboarding, run on an explicit user action: shows the system prompts so
    // the helper appears in both Settings lists. Never part of a request.
    Permissions.requestInteractively()
    exit(0)
}

// ScreenCaptureKit asserts that the window-server connection was initialized
// (CGS_REQUIRE_INIT), which NSApplication does. Prohibited policy: no Dock
// icon, no menu bar, never activated.
NSApplication.shared.setActivationPolicy(.prohibited)

// One messaging timeout for every AX element (the system-wide element sets
// the global value), not just application elements: a hung app must not
// stall a tree walk for AX's default 6 s per call.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), axMessagingTimeout)

// Main writes into a pipe it may close; a write then fails instead of killing us mid-batch.
signal(SIGPIPE, SIG_IGN)

// Termination (main's kill(), a timeout, the stop key): release held input
// before going. Handled on a background queue, because the main thread may be
// stuck in an AX call; CGEventPost is not async-signal-safe, so not in a raw
// signal handler.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .global(qos: .userInteractive))
    source.setEventHandler { shutdown() }
    source.resume()
    signalSources.append(source)
}

let lines = AsyncStream<String> { continuation in
    let reader = Thread {
        while let line = readLine(strippingNewline: true) {
            if !line.isEmpty { continuation.yield(line) }
        }
        // stdin EOF: wmux closed the pipe or is gone.
        continuation.finish()
    }
    reader.stackSize = 1 << 20
    reader.start()
}

Task { @MainActor in
    await Server().run(lines: lines)
}

// The main run loop (not dispatchMain) so NSWorkspace keeps its app list current.
RunLoop.main.run()
