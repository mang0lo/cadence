/**
 * The built-in Cadence server as a child process of the desktop app: server/index.js on Electron's own Node
 * (ELECTRON_RUN_AS_NODE). It announces itself on stdout as `CADENCE_LISTENING {"url","port"}` and exits when the
 * app is gone (CADENCE_PARENT_PID).
 *
 * It starts on the port of the last launch: the port is part of the web UI's origin, so a new port every launch
 * would start the page with empty browser storage each time. When that port is taken, it starts again on any free
 * port (PORT=0), which `onPort` then keeps.
 *
 * Every start is a run of its own (child process, log stream, start timeout). Only the current run reports, so the
 * exit of a server that was stopped or replaced on purpose is never taken for a crash or a restart.
 *
 * No Electron imports here: the class is tested with a fake spawn (apps/desktop/test/server-process.test.ts).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parseListening, RESTART_EXIT_CODE, shellServerEnv } from './shell-contract';

/**
 * The first port the built-in server tries: outside the ranges the system hands out to other programs (Linux
 * 32768-60999, Windows and macOS 49152-65535) and not 8787 (npm run dev, Docker).
 */
export const DEFAULT_PORT = 28787;

/** The server could not listen on the port it was given (taken by another program, or reserved by Windows). */
export function portUnavailable(output: string): boolean {
  return /EADDRINUSE|listen EACCES|EADDRNOTAVAIL/.test(output);
}

/** A start that was stopped or replaced before the server listened (its caller was superseded: nothing to show). */
export class ServerStopped extends Error {
  constructor() {
    super('The Cadence server was stopped.');
  }
}

class PortUnavailable extends Error {}

export interface LocalServerOptions {
  /** The Node binary (Electron's own) and the server bundle. */
  execPath: string;
  entry: string;
  webDir: string;
  dataDir: string;
  /** server.log is written here (a new one for every start). */
  logDir: string;
  /** The port to try first: the one of the last launch. */
  preferredPort: () => number;
  /** The port the server listens on (to be kept for the next launch). */
  onPort?: (port: number) => void;
  /** Extra environment for the server (ELECTRON_RUN_AS_NODE). */
  env?: NodeJS.ProcessEnv;
  /** pid of the app: the server exits when it is gone. */
  parentPid?: number;
  startTimeoutMs?: number;
  /** How long stop() waits for the server to close its database before it kills it. */
  stopGraceMs?: number;
  /** Tests pass a fake. */
  spawn?: typeof nodeSpawn;
}

interface LocalServerEvents {
  /** The server exited with RESTART_EXIT_CODE after it had started: start it again (a restored backup). */
  restart: [];
  /** The server exited after it had started, with any other code. */
  crash: [code: number | null];
}

interface Run {
  child: ChildProcess;
  started: boolean;
  /** Resolves once the process is gone and its output was read. */
  closed: Promise<void>;
  /** Settles the start of this run with ServerStopped (stop() before it listened). */
  abort: () => void;
}

export class LocalServer extends EventEmitter<LocalServerEvents> {
  private run: Run | null = null;
  private currentUrl: string | null = null;
  private starting: Promise<string> | null = null;
  /** Resolves once the server stopped last is gone: a start waits for it, so the port is free again. */
  private stopping: Promise<void> = Promise.resolve();
  /** Counts start() and stop() calls: a start goes on only while no later call came. */
  private generation = 0;

  constructor(private readonly opts: LocalServerOptions) {
    super();
  }

  /** The URL while the server runs. */
  get url(): string | null {
    return this.currentUrl;
  }

  get logFile(): string {
    return path.join(this.opts.logDir, 'server.log');
  }

  /** The URL of the running server, starting it when it does not run (callers share a start in progress). */
  ensure(): Promise<string> {
    if (this.currentUrl) return Promise.resolve(this.currentUrl);
    return (this.starting ??= this.start());
  }

  /**
   * Starts the server (stopping one that runs) and resolves with its URL. Rejects with ServerStopped when stop() or
   * another start() comes first.
   */
  start(): Promise<string> {
    const p = this.startNow(++this.generation).finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  private async startNow(generation: number): Promise<string> {
    await this.stopRun();
    if (generation !== this.generation) throw new ServerStopped();
    const { entry } = this.opts;
    if (!fs.existsSync(entry)) {
      throw new Error(`The bundled server is missing (${entry}). Run \`npm run build\` first, or set CADENCE_DEV_URL.`);
    }
    fs.mkdirSync(this.opts.logDir, { recursive: true });
    const port = this.opts.preferredPort();
    // Empty the log once, then only ever append (O_APPEND): a stream opened with 'w' writes at its own offset, so a
    // line appended while its output was still buffered would be overwritten (seen on Linux).
    fs.writeFileSync(this.logFile, '');
    try {
      return await this.launch(port);
    } catch (e) {
      if (!(e instanceof PortUnavailable) || generation !== this.generation) throw e;
      // the port of the last launch is taken: any free port will do (and is kept from now on)
      fs.appendFileSync(this.logFile, `Cadence: port ${port} is not available, starting on a free port instead\n`);
      return this.launch(0);
    }
  }

  private launch(port: number): Promise<string> {
    const { opts } = this;
    const timeoutMs = opts.startTimeoutMs ?? 60_000;
    return new Promise<string>((resolve, reject) => {
      const log = fs.createWriteStream(this.logFile, { flags: 'a' });
      log.on('error', () => undefined); // the log is a help, not a reason to stop the app
      const child = (opts.spawn ?? nodeSpawn)(opts.execPath, ['--disable-warning=ExperimentalWarning', opts.entry], {
        cwd: opts.dataDir,
        env: {
          ...process.env,
          ...opts.env,
          ...shellServerEnv({
            port,
            dataDir: opts.dataDir,
            webDir: opts.webDir,
            parentPid: opts.parentPid ?? process.pid,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      let markClosed!: () => void;
      const run: Run = {
        child,
        started: false,
        closed: new Promise<void>((r) => (markClosed = r)),
        abort: () => settle(() => reject(new ServerStopped())),
      };
      this.run = run;
      const current = () => this.run === run;

      const timer = setTimeout(() => {
        if (!current()) return;
        settle(() => reject(new Error(`The Cadence server did not start within ${Math.round(timeoutMs / 1000)} seconds.`)));
        void this.stop();
      }, timeoutMs);

      // what the server wrote before it listened: the reason when it does not start
      let output = '';
      const onOutput = (chunk: Buffer) => {
        log.write(chunk);
        if (run.started) return;
        output += chunk.toString('utf8');
        const address = parseListening(output);
        if (!address || !current()) return;
        const { url, port: listening } = address;
        run.started = true;
        output = '';
        this.currentUrl = url;
        opts.onPort?.(listening);
        settle(() => resolve(url));
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);

      const ended = (code: number | null) => {
        clearTimeout(timer);
        log.end();
        markClosed();
        if (!current()) return;
        this.run = null;
        this.currentUrl = null;
        if (!run.started) {
          const busy = port !== 0 && portUnavailable(output);
          settle(() =>
            reject(
              busy
                ? new PortUnavailable(`Port ${port} is not available.`)
                : new Error(`The Cadence server stopped while starting (exit code ${code}). See ${opts.logDir}.`),
            ),
          );
        } else if (code === RESTART_EXIT_CODE) {
          this.emit('restart');
        } else {
          this.emit('crash', code);
        }
      };
      // 'close' comes after the output was read to the end: the log is complete and `output` holds the error
      child.on('close', (code) => ended(code));
      // the process could not be started at all (then no 'close' may follow)
      child.on('error', (e) => {
        if (child.pid !== undefined) return;
        if (current()) settle(() => reject(e));
        ended(null);
      });
    });
  }

  /**
   * Stops the server (if it runs, or a start in progress) and resolves once it is gone, so its port is free again.
   * Reports nothing.
   */
  async stop(): Promise<void> {
    this.generation++;
    await this.stopRun();
  }

  /** Stops the current run, if any; resolves once the server stopped last is gone (also when another call stops it). */
  private stopRun(): Promise<void> {
    const run = this.run;
    if (run) {
      this.run = null;
      this.currentUrl = null;
      run.abort();
      // never rejects: every later start waits for it
      this.stopping = this.terminate(run).catch(() => undefined);
    }
    return this.stopping;
  }

  private async terminate({ child, closed }: Run): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    const wait = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(false), ms));
    if (await Promise.race([closed.then(() => true), wait(this.opts.stopGraceMs ?? 3000)])) return;
    child.kill('SIGKILL');
    await Promise.race([closed, wait(2000)]);
  }
}
