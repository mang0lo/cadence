import Foundation

enum ServerError: LocalizedError {
    case missingRuntime
    case exited(Int32)
    case timeout

    var errorDescription: String? {
        switch self {
        case .missingRuntime:
            return "The bundled server is missing. Build the app with `npm run mac`, or set CADENCE_DEV_URL to use a dev server."
        case .exited(let code):
            return "The Cadence server stopped unexpectedly (exit code \(code))."
        case .timeout:
            return "The Cadence server did not start within 60 seconds."
        }
    }
}

/// Runs the bundled Node.js server (Resources/node/bin/node Resources/server/index.js) as a child process.
/// The server picks a free port (PORT=0) and announces it on stdout as `CADENCE_LISTENING {"url","port"}`.
final class ServerProcess: @unchecked Sendable {
    struct Paths {
        let node: URL
        let entry: URL
        let web: URL
    }

    private var process: Process?
    private let lock = NSLock()
    private var resolved = false
    private var buffer = Data()

    /// Called on the main thread when the server exits after it had started successfully.
    var onUnexpectedExit: (@MainActor (Int32) -> Void)?

    static var dataDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Cadence", isDirectory: true)
    }

    static var logFile: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Cadence/server.log")
    }

    static func locate() -> Paths? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let node = res.appendingPathComponent("node/bin/node")
        let entry = res.appendingPathComponent("server/index.js")
        let web = res.appendingPathComponent("web")
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: entry.path) else { return nil }
        return Paths(node: node, entry: entry, web: web)
    }

    var isRunning: Bool { process?.isRunning ?? false }

    func start(completion: @escaping @MainActor (Result<URL, Error>) -> Void) {
        guard let paths = Self.locate() else {
            Task { @MainActor in completion(.failure(ServerError.missingRuntime)) }
            return
        }
        lock.withLock {
            resolved = false
            buffer = Data()
        }

        let fm = FileManager.default
        try? fm.createDirectory(at: Self.dataDirectory, withIntermediateDirectories: true)
        try? fm.createDirectory(at: Self.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: Self.logFile.path, contents: nil)
        let log = try? FileHandle(forWritingTo: Self.logFile)

        let p = Process()
        p.executableURL = paths.node
        p.arguments = ["--disable-warning=ExperimentalWarning", paths.entry.path]
        var env = ProcessInfo.processInfo.environment
        env["CADENCE_MODE"] = "desktop"
        env["PORT"] = "0"
        env["HOST"] = "127.0.0.1"
        env["CADENCE_DATA_DIR"] = Self.dataDirectory.path
        env["CADENCE_WEB_DIR"] = paths.web.path
        env["CADENCE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env["NODE_ENV"] = "production"
        p.environment = env
        p.currentDirectoryURL = Self.dataDirectory

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            log?.write(chunk)
            if let url = self?.consume(chunk) {
                Task { @MainActor in completion(.success(url)) }
            }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            try? log?.close()
            guard let self else { return }
            let code = proc.terminationStatus
            let wasResolved = self.lock.withLock { () -> Bool in
                let r = self.resolved
                self.resolved = true
                return r
            }
            Task { @MainActor in
                if wasResolved {
                    self.onUnexpectedExit?(code)
                } else {
                    completion(.failure(ServerError.exited(code)))
                }
            }
        }

        do {
            try p.run()
            process = p
        } catch {
            Task { @MainActor in completion(.failure(error)) }
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            guard let self else { return }
            let timedOut = self.lock.withLock { () -> Bool in
                if self.resolved { return false }
                self.resolved = true
                return true
            }
            if timedOut {
                self.stop()
                MainActor.assumeIsolated { completion(.failure(ServerError.timeout)) }
            }
        }
    }

    /// Accumulates stdout until the CADENCE_LISTENING line appears; returns the URL exactly once.
    private func consume(_ chunk: Data) -> URL? {
        lock.withLock { () -> URL? in
            guard !resolved else { return nil }
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8),
                  let range = text.range(of: "CADENCE_LISTENING ") else { return nil }
            let rest = text[range.upperBound...]
            guard let nl = rest.firstIndex(of: "\n"),
                  let json = String(rest[..<nl]).data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
                  let port = obj["port"] as? Int,
                  let url = URL(string: "http://127.0.0.1:\(port)/") else { return nil }
            resolved = true
            buffer = Data()
            return url
        }
    }

    func stop() {
        guard let p = process else { return }
        process = nil
        if p.isRunning {
            p.terminationHandler = nil
            p.terminate()
            // Give the server a moment to close the database cleanly.
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
    }
}
