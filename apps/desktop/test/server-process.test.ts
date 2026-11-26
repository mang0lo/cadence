import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalServer, portUnavailable, ServerStopped, type LocalServerOptions } from '../src/server-process';
import { RESTART_EXIT_CODE } from '../src/shell-contract';

/** Stands in for the server process: the test decides what it prints and when it ends. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  /** like a server busy closing its database: SIGTERM does nothing */
  ignoreTerm = false;

  constructor(readonly env: NodeJS.ProcessEnv) {
    super();
  }

  listen(port: number) {
    this.stdout.write(`CADENCE_LISTENING ${JSON.stringify({ url: `http://127.0.0.1:${port}`, port })}\n`);
  }

  /** The process ends: 'exit', then 'close' once its output was read. */
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.ignoreTerm) return true;
    setImmediate(() => this.exit(null, signal));
    return true;
  }
}

let dir: string;
let children: FakeChild[];
let ports: number[];
let servers: LocalServer[];

function server(over: Partial<LocalServerOptions> = {}): LocalServer {
  const entry = path.join(dir, 'index.js');
  fs.writeFileSync(entry, '');
  const s = new LocalServer({
    execPath: '/fake/node',
    entry,
    webDir: path.join(dir, 'web'),
    dataDir: dir,
    logDir: path.join(dir, 'logs'),
    preferredPort: () => 28787,
    onPort: (p) => ports.push(p),
    startTimeoutMs: 2000,
    stopGraceMs: 50,
    spawn: ((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(options.env);
      children.push(child);
      return child;
    }) as unknown as LocalServerOptions['spawn'],
    ...over,
  });
  servers.push(s);
  return s;
}

/** Waits until the n-th server process was spawned. */
async function spawned(n: number): Promise<FakeChild> {
  for (let i = 0; i < 200 && children.length < n; i++) await new Promise((r) => setTimeout(r, 2));
  expect(children.length).toBeGreaterThanOrEqual(n);
  return children[n - 1]!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-desktop-'));
  children = [];
  ports = [];
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  await new Promise((r) => setTimeout(r, 10)); // log streams closed
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LocalServer', () => {
  it('starts on the port of the last launch and reports the port it listens on', async () => {
    const s = server();
    const started = s.start();
    const child = await spawned(1);
    expect(child.env).toMatchObject({ PORT: '28787', HOST: '127.0.0.1', CADENCE_MODE: 'desktop', CADENCE_DATA_DIR: dir });
    child.listen(28787);
    await expect(started).resolves.toBe('http://127.0.0.1:28787');
    expect(s.url).toBe('http://127.0.0.1:28787');
    expect(ports).toEqual([28787]);
  });

  it('starts again on a free port when the last one is taken, and keeps that one', async () => {
    const s = server();
    const started = s.start();
    const first = await spawned(1);
    first.stderr.write('Error: listen EADDRINUSE: address already in use 127.0.0.1:28787\n');
    first.exit(1);
    const second = await spawned(2);
    expect(second.env.PORT).toBe('0');
    second.listen(54321);
    await expect(started).resolves.toBe('http://127.0.0.1:54321');
    expect(ports).toEqual([54321]);
    await new Promise((r) => setTimeout(r, 20)); // log streams flushed
    const log = fs.readFileSync(s.logFile, 'utf8');
    expect(log).toContain('EADDRINUSE');
    expect(log).toContain('port 28787 is not available');
    expect(log).toContain('CADENCE_LISTENING');
  });

  it('does not try again when a free port was asked for already', async () => {
    const s = server({ preferredPort: () => 0 });
    const started = s.start();
    const child = await spawned(1);
    child.stderr.write('Error: listen EADDRINUSE: address already in use 127.0.0.1:0\n');
    child.exit(1);
    await expect(started).rejects.toThrow('stopped while starting (exit code 1)');
    expect(children).toHaveLength(1);
  });

  it('reports a server that stops while starting, with its exit code', async () => {
    const s = server();
    const started = s.start();
    (await spawned(1)).exit(3);
    await expect(started).rejects.toThrow(/exit code 3\)\. See .*logs/);
    expect(s.url).toBeNull();
  });

  it('gives up when the server does not announce itself in time, and stops it', async () => {
    const s = server({ startTimeoutMs: 30 });
    const started = s.start();
    const child = await spawned(1);
    await expect(started).rejects.toThrow('did not start within');
    await new Promise((r) => setTimeout(r, 10));
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('tells a restart on purpose (restored backup) from a crash', async () => {
    const s = server();
    const events: string[] = [];
    s.on('restart', () => events.push('restart'));
    s.on('crash', (code) => events.push(`crash ${code}`));

    let started = s.start();
    (await spawned(1)).listen(28787);
    await started;
    children[0]!.exit(RESTART_EXIT_CODE);
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['restart']);
    expect(s.url).toBeNull();

    started = s.start();
    const again = await spawned(2);
    expect(again.env.PORT).toBe('28787');
    again.listen(28787);
    await started;
    again.exit(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['restart', 'crash 1']);
  });

  it('stops on purpose without reporting it, and waits until the server is gone', async () => {
    const s = server();
    const events: string[] = [];
    s.on('restart', () => events.push('restart'));
    s.on('crash', () => events.push('crash'));
    const started = s.start();
    const child = await spawned(1);
    child.listen(28787);
    await started;
    await s.stop();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(s.url).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual([]);
  });

  it('kills a server that does not stop in time', async () => {
    const s = server();
    const started = s.start();
    const child = await spawned(1);
    child.ignoreTerm = true;
    child.listen(28787);
    await started;
    await s.stop();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('settles a start that is stopped before the server listens, and leaves no server behind', async () => {
    const s = server();
    const started = s.start();
    const stopped = expect(started).rejects.toBeInstanceOf(ServerStopped);
    const child = await spawned(1);
    await s.stop();
    await stopped;
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('replaces a running server on a new start without taking its exit for a crash', async () => {
    const s = server();
    const crashes: unknown[] = [];
    s.on('crash', (c) => crashes.push(c));
    let started = s.start();
    const first = await spawned(1);
    first.listen(28787);
    await started;
    started = s.start();
    const second = await spawned(2);
    expect(first.signals).toEqual(['SIGTERM']);
    second.listen(28787);
    await expect(started).resolves.toBe('http://127.0.0.1:28787');
    expect(crashes).toEqual([]);
  });

  it('starts the next server only once the one still stopping is gone, so it keeps the port', async () => {
    const s = server();
    let started = s.start();
    const first = await spawned(1);
    first.ignoreTerm = true; // busy closing its database: only SIGKILL ends it (after stopGraceMs)
    first.listen(28787);
    await started;
    const stopping = s.stop(); // Settings → Server → another server …
    started = s.start(); // … and straight back to the built-in one
    const second = await spawned(2);
    // the first one no longer holds 28787: the next one does not fall back to another port (another origin)
    expect(first.signalCode).toBe('SIGKILL');
    expect(second.env.PORT).toBe('28787');
    second.listen(28787);
    await expect(started).resolves.toBe('http://127.0.0.1:28787');
    await stopping;
  });

  it('runs one server when two starts come at once', async () => {
    const s = server();
    const a = s.start();
    const b = s.start();
    await expect(a).rejects.toBeInstanceOf(ServerStopped);
    const child = await spawned(1);
    child.listen(28787);
    await expect(b).resolves.toBe('http://127.0.0.1:28787');
    expect(children).toHaveLength(1);
  });

  it('shares a start in progress between callers of ensure()', async () => {
    const s = server();
    const a = s.ensure();
    const b = s.ensure();
    (await spawned(1)).listen(28787);
    await expect(Promise.all([a, b])).resolves.toEqual(['http://127.0.0.1:28787', 'http://127.0.0.1:28787']);
    await expect(s.ensure()).resolves.toBe('http://127.0.0.1:28787');
    expect(children).toHaveLength(1);
  });

  it('says so when the server bundle is missing', async () => {
    const s = server();
    fs.rmSync(path.join(dir, 'index.js'));
    await expect(s.start()).rejects.toThrow('bundled server is missing');
    expect(children).toHaveLength(0);
  });
});

describe('portUnavailable', () => {
  it('knows the errors of a port that cannot be had', () => {
    expect(portUnavailable('Error: listen EADDRINUSE: address already in use 127.0.0.1:28787')).toBe(true);
    expect(portUnavailable('Error: listen EACCES: permission denied 127.0.0.1:28787')).toBe(true);
    expect(portUnavailable('SqliteError: database disk image is malformed')).toBe(false);
  });
});
