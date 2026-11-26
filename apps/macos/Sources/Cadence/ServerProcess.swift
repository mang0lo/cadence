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
///
/// Every start is a `ServerRun` of its own (process, pipe, log handle, start timeout). Only the current run may
/// report anything: the exit or the timeout of a run that was stopped or replaced is ignored, so it can neither
/// stop a newer server nor answer a newer start.
@MainActor
final class ServerProcess {
    struct Paths {
        let node: URL
        let entry: URL
        let web: URL
    }

    private var run: ServerRun?
    /// The current run has announced its port (its exit is then an unexpected exit, not a failed start).
    private var started = false

    /// Called when the server exits after it had started successfully.
    var onUnexpectedExit: ((Int32) -> Void)?

    nonisolated static var dataDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Cadence", isDirectory: true)
    }

    nonisolated static var logFile: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Cadence/server.log")
    }

    nonisolated static func locate() -> Paths? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let node = res.appendingPathComponent("node/bin/node")
        let entry = res.appendingPathComponent("server/index.js")
        let web = res.appendingPathComponent("web")
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: entry.path) else { return nil }
        return Paths(node: node, entry: entry, web: web)
    }

    var isRunning: Bool { run?.isRunning ?? false }

    /// Starts the server (stopping one that runs); `completion` gets its URL, or why it did not start.
    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        stop()
        guard let paths = Self.locate() else {
            DispatchQueue.main.async { completion(.failure(ServerError.missingRuntime)) }
            return
        }
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.dataDirectory, withIntermediateDirectories: true)
        try? fm.createDirectory(at: Self.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: Self.logFile.path, contents: nil) // a new log for every start
        launch(paths, port: 0, completion: completion)
    }

    private func launch(_ paths: Paths, port: Int, completion: @escaping (Result<URL, Error>) -> Void) {
        var env = ProcessInfo.processInfo.environment
        env["CADENCE_MODE"] = "desktop"
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        env["CADENCE_DATA_DIR"] = Self.dataDirectory.path
        env["CADENCE_WEB_DIR"] = paths.web.path
        env["CADENCE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env["NODE_ENV"] = "production"

        let run = ServerRun(paths: paths, environment: env, directory: Self.dataDirectory, log: Self.logFile)
        self.run = run
        started = false
        run.onListening = { [weak self, weak run] port in
            guard let self, let run, self.run === run, !self.started else { return }
            self.started = true
            completion(.success(URL(string: "http://127.0.0.1:\(port)/")!))
        }
        run.onExit = { [weak self, weak run] code, _ in
            guard let self, let run, self.run === run else { return }
            self.run = nil
            if self.started {
                self.onUnexpectedExit?(code)
            } else {
                completion(.failure(ServerError.exited(code)))
            }
        }
        run.onTimeout = { [weak self, weak run] in
            guard let self, let run, self.run === run, !self.started else { return }
            self.stop()
            completion(.failure(ServerError.timeout))
        }
        do {
            try run.start(timeout: 60)
        } catch {
            self.run = nil
            DispatchQueue.main.async { completion(.failure(error)) }
        }
    }

    /// Stops the current server (if any); its exit is not reported.
    func stop() {
        guard let run else { return }
        self.run = nil
        started = false
        run.stop()
    }
}

/// One start of the server process. The pipe and process handlers run on background queues; the callbacks are
/// delivered on the main queue.
private final class ServerRun: @unchecked Sendable {
    private let process = Process()
    private let pipe = Pipe()
    private let logURL: URL
    private let lock = NSLock()
    /// stdout + stderr until the CADENCE_LISTENING line (afterwards the output only goes to the log)
    private var buffer = Data()
    private var announced = false
    private var exitCode: Int32?
    private var drained = false
    private var exitReported = false
    private var timeout: DispatchWorkItem?

    /// The port from the CADENCE_LISTENING line.
    var onListening: (@MainActor (Int) -> Void)?
    /// The process ended (after its output was read to the end): exit code and what it wrote before it listened.
    var onExit: (@MainActor (Int32, String) -> Void)?
    /// No CADENCE_LISTENING line within the time given to start().
    var onTimeout: (@MainActor () -> Void)?

    init(paths: ServerProcess.Paths, environment: [String: String], directory: URL, log: URL) {
        process.executableURL = paths.node
        process.arguments = ["--disable-warning=ExperimentalWarning", paths.entry.path]
        process.environment = environment
        process.currentDirectoryURL = directory
        process.standardOutput = pipe
        process.standardError = pipe
        logURL = log
    }

    var isRunning: Bool { process.isRunning }

    func start(timeout seconds: TimeInterval) throws {
        let log = try? FileHandle(forWritingTo: logURL)
        _ = try? log?.seekToEnd()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                // EOF: the server is gone. Without this the handler fires forever with empty reads (100% CPU).
                handle.readabilityHandler = nil
                try? log?.close()
                self?.finish(drained: true)
                return
            }
            log?.write(chunk)
            if let port = self?.consume(chunk) {
                DispatchQueue.main.async { [weak self] in
                    self?.timeout?.cancel()
                    MainActor.assumeIsolated { self?.onListening?(port) }
                }
            }
        }
        process.terminationHandler = { [weak self] proc in
            self?.finish(exitCode: proc.terminationStatus)
        }
        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            try? log?.close()
            throw error
        }

        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.onTimeout?() }
        }
        timeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    /// Accumulates the output until the CADENCE_LISTENING line appears; returns its port exactly once.
    private func consume(_ chunk: Data) -> Int? {
        lock.withLock { () -> Int? in
            guard !announced else { return nil }
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8),
                  let range = text.range(of: "CADENCE_LISTENING ") else { return nil }
            let rest = text[range.upperBound...]
            guard let nl = rest.firstIndex(of: "\n"),
                  let json = String(rest[..<nl]).data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
                  let port = obj["port"] as? Int else { return nil }
            announced = true
            buffer = Data()
            return port
        }
    }

    /// The exit is reported once the process ended and its output was read to the end (so the log is complete and
    /// the output holds the error), or shortly after the end when the pipe stays open.
    private func finish(exitCode code: Int32? = nil, drained eof: Bool = false) {
        let report = lock.withLock { () -> (Int32, String)? in
            if let code { exitCode = code }
            if eof { drained = true }
            guard let status = exitCode, drained, !exitReported else { return nil }
            exitReported = true
            return (status, String(decoding: buffer, as: UTF8.self))
        }
        if let (status, output) = report {
            DispatchQueue.main.async { [weak self] in
                self?.timeout?.cancel()
                MainActor.assumeIsolated { self?.onExit?(status, output) }
            }
        } else if code != nil {
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in self?.finish(drained: true) }
        }
    }

    /// Terminates the process and waits (briefly) until it is gone, so its port is free again.
    func stop() {
        timeout?.cancel()
        guard process.isRunning else { return }
        process.terminate()
        // Give the server a moment to close the database cleanly.
        var deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline { usleep(50_000) }
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGKILL)
        deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline { usleep(20_000) }
    }
}
