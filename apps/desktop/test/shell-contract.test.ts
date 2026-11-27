import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  cancelledEventScript,
  importEventScript,
  LISTENING_PREFIX,
  NATIVE_CANCELLED_EVENT,
  NATIVE_IMPORT_EVENT,
  NATIVE_MESSAGES,
  parseBridgeMessage,
  parseListening,
  RESTART_EXIT_CODE,
  SAVE_FILE_TYPES,
  savedFileName,
  shellInfo,
  shellServerEnv,
} from '../src/shell-contract';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

/** The TypeScript sources below these folders of the repo (no tests, no build output). */
function sources(...dirs: string[]): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!['node_modules', 'dist', 'test'].includes(ent.name)) walk(abs);
      } else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
        out.push({ file: path.relative(repo, abs), text: fs.readFileSync(abs, 'utf8') });
      }
    }
  };
  for (const d of dirs) walk(path.join(repo, d));
  return out;
}

const env = shellServerEnv({ port: 28787, dataDir: '/data', webDir: '/web', parentPid: 42 });

describe('parseListening', () => {
  const line = `${LISTENING_PREFIX}${JSON.stringify({ url: 'http://127.0.0.1:28787', port: 28787 })}\n`;

  it('reads the address once the whole line is there', () => {
    expect(parseListening(`(node) a warning\n${line}`)).toEqual({ url: 'http://127.0.0.1:28787', port: 28787 });
    expect(parseListening(line.replace('\n', '\r\n'))).toEqual({ url: 'http://127.0.0.1:28787', port: 28787 });
    expect(parseListening(line.slice(0, 40))).toBeNull();
    expect(parseListening(line.slice(0, -1))).toBeNull();
  });

  it('ignores anything else', () => {
    expect(parseListening('Error: listen EADDRINUSE: address already in use 127.0.0.1:28787\n')).toBeNull();
    expect(parseListening(`${LISTENING_PREFIX}{"url":"http://127.0.0.1:1"}\n`)).toBeNull();
    expect(parseListening(`${LISTENING_PREFIX}not json\n`)).toBeNull();
  });
});

describe('parseBridgeMessage', () => {
  it('reads the messages the web UI posts', () => {
    expect(parseBridgeMessage({ type: 'pickImportFile' })).toEqual({ type: 'pickImportFile', folder: false });
    expect(parseBridgeMessage({ type: 'pickImportFile', folder: true })).toEqual({
      type: 'pickImportFile',
      folder: true,
    });
    expect(parseBridgeMessage({ type: 'importReady' })).toEqual({ type: 'importReady' });
    expect(parseBridgeMessage({ type: 'openDataFolder' })).toEqual({ type: 'openDataFolder' });
    expect(parseBridgeMessage({ type: 'saveFile', filename: 'run.png', base64: 'iVBO' })).toEqual({
      type: 'saveFile',
      filename: 'run.png',
      base64: 'iVBO',
    });
    expect(parseBridgeMessage({ type: 'connectServer', url: 'http://nas:8787' })).toEqual({
      type: 'connectServer',
      url: 'http://nas:8787',
    });
    // no url: back to the built-in server
    expect(parseBridgeMessage({ type: 'connectServer' })).toEqual({ type: 'connectServer', url: '' });
  });

  it('drops what no shell knows or what lacks its fields', () => {
    for (const raw of [
      null,
      'pickImportFile',
      { type: 'openFile', path: '/etc/passwd' },
      { type: 'saveFile', filename: 'run.png' },
      { type: 'saveFile', filename: 7, base64: 'iVBO' },
      { type: 'connectServer', url: 42 },
    ]) {
      expect(parseBridgeMessage(raw), JSON.stringify(raw)).toBeNull();
    }
    // only folder: true asks for a folder
    expect(parseBridgeMessage({ type: 'pickImportFile', folder: 'yes' })).toEqual({
      type: 'pickImportFile',
      folder: false,
    });
  });

  it('knows every message of the contract', () => {
    for (const type of NATIVE_MESSAGES) {
      expect(parseBridgeMessage({ type, filename: 'a.png', base64: 'AA==', url: '' })?.type).toBe(type);
    }
  });
});

/** Names a page may give a file it saves → the name the shells save it under (null: refused). Same table in Swift. */
const SAVED_NAMES: [string, string | null][] = [
  ['cadence-2026-06-20-morning-ride.png', 'cadence-2026-06-20-morning-ride.png'],
  ['ecg-202606200815.csv', 'ecg-202606200815.csv'],
  ['Morning Run.GPX', 'Morning Run.GPX'],
  ['metrics.json', 'metrics.json'],
  ['../../Library/LaunchAgents/evil.txt', 'evil.txt'],
  ['C:\\Users\\me\\route.gpx', 'route.gpx'],
  ['exports/run.csv/', null],
  ['.png', 'cadence.png'],
  ['.hidden.csv', 'cadence.csv'],
  ['a<b>:c|d?e*f"g.csv', 'a_b__c_d_e_f_g.csv'],
  ['tab\there.txt', 'tab_here.txt'],
  ['run.exe', null],
  ['install.command', null],
  ['page.html', null],
  ['image.svg', null],
  ['run.png.app', null],
  ['run.png.', null],
  ['noext', null],
  ['', null],
];

describe('savedFileName', () => {
  it('keeps the name and type of images and data exports, without folders', () => {
    for (const [name, saved] of SAVED_NAMES) expect(savedFileName(name), name).toBe(saved);
  });

  it('accepts every type the contract allows', () => {
    for (const type of SAVE_FILE_TYPES) expect(savedFileName(`export.${type}`)).toBe(`export.${type}`);
  });
});

describe('importEventScript', () => {
  /** Runs the script in a page whose import page listens (it takes the path) or not; what it received and returned. */
  function run(script: string, listening: boolean) {
    const window = new EventTarget();
    const received: unknown[] = [];
    window.addEventListener(NATIVE_IMPORT_EVENT, (e) => {
      received.push((e as CustomEvent).detail);
      if (listening) e.preventDefault();
    });
    return { handled: vm.runInNewContext(script, { window, CustomEvent }) as unknown, received };
  }

  it('tells whether the open import page took the path', () => {
    expect(run(importEventScript({ path: '/Users/me/export.zip' }), true)).toEqual({
      handled: true,
      received: [{ path: '/Users/me/export.zip' }],
    });
    // no import page: the shell opens it, and the page asks for the path (importReady)
    expect(run(importEventScript({ path: '/Users/me/export.zip' }), false).handled).toBe(false);
    expect(run(importEventScript({ path: 'C:\\Users\\me\\export.zip', confirm: true }), true).received).toEqual([
      { path: 'C:\\Users\\me\\export.zip', confirm: true },
    ]);
  });

  it('hands over any path as it is, never as code', () => {
    for (const path of [`/tmp/it's "quoted"`, '/tmp/a\u2028b\nc', '/tmp/</script><script>alert(1)</script>', '/tmp/${x}`']) {
      expect(run(importEventScript({ path }), true).received).toEqual([{ path }]);
    }
  });
});

describe('cancelledEventScript', () => {
  /** Runs the script in a page that waits for the answer (it takes the event) or not: what it got, did it reload. */
  function run(script: string, waiting: boolean) {
    const window = new EventTarget();
    const received: unknown[] = [];
    let reloaded = false;
    window.addEventListener(NATIVE_CANCELLED_EVENT, (e) => {
      received.push((e as CustomEvent).detail);
      if (waiting) e.preventDefault();
    });
    vm.runInNewContext(script, { window, CustomEvent, location: { reload: () => (reloaded = true) } });
    return { received, reloaded };
  }

  it('ends the wait of the page that asked', () => {
    expect(run(cancelledEventScript('connectServer'), true)).toEqual({
      received: [{ type: 'connectServer' }],
      reloaded: false,
    });
  });

  it('reloads a page that does not listen (an older web UI), as the shells did before', () => {
    expect(run(cancelledEventScript('connectServer'), false).reloaded).toBe(true);
  });
});

// The contract is packages/shared/src/shell.ts: the server, the web UI and this shell import it, the Mac app keeps a
// copy (ShellContract.swift).
describe('the shell contract', () => {
  const swift = read('apps/macos/Sources/Cadence/ShellContract.swift');
  const swiftBody = (name: string) => {
    const at = swift.indexOf(`func ${name}(`);
    expect(at, `ShellContract.swift: func ${name}`).toBeGreaterThan(-1);
    return swift.slice(at, swift.indexOf('\n    }\n', at));
  };

  it('is the same in the Mac app', () => {
    expect(Number(/restartExitCode: Int32 = (\d+)/.exec(swift)?.[1])).toBe(RESTART_EXIT_CODE);
    expect(/listeningPrefix = "([^"]*)"/.exec(swift)?.[1]).toBe(LISTENING_PREFIX);

    const envBody = swiftBody('serverEnvironment');
    expect([...envBody.matchAll(/"([A-Z][A-Z_]*)":/g)].map((m) => m[1]).sort()).toEqual(Object.keys(env).sort());
    for (const key of ['CADENCE_MODE', 'HOST', 'NODE_ENV']) expect(envBody).toContain(`"${key}": "${env[key]}"`);

    const cases = /enum Message: String, CaseIterable \{\s*case ([\w, ]+)\n/.exec(swift)?.[1];
    expect(cases?.split(',').map((c) => c.trim()).sort()).toEqual([...NATIVE_MESSAGES].sort());
    expect(/importEvent = "([^"]*)"/.exec(swift)?.[1]).toBe(NATIVE_IMPORT_EVENT);
    expect(/cancelledEvent = "([^"]*)"/.exec(swift)?.[1]).toBe(NATIVE_CANCELLED_EVENT);
    const types = /savedFileTypes: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1];
    expect([...(types ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]).sort()).toEqual([...SAVE_FILE_TYPES].sort());
    // the same names as savedFileName here (ShellContractTests.swift runs this table)
    const tests = read('apps/macos/Tests/CadenceTests/ShellContractTests.swift');
    for (const [name, saved] of SAVED_NAMES) {
      const swiftName = JSON.stringify(name).replace(/\\u([0-9a-f]{4})/g, '\\u{$1}');
      expect(tests, `ShellContractTests.swift: ${name}`).toContain(`(${swiftName}, ${saved === null ? 'nil' : JSON.stringify(saved)})`);
    }

    const infoBody = swiftBody('shellInfo');
    expect([...infoBody.matchAll(/"(\w+)":/g)].map((m) => m[1]).sort()).toEqual(
      Object.keys(shellInfo('desktop', '1.0.0', null)).sort(),
    );
  });

  it('is what the server uses', () => {
    const server = sources('apps/server/src');
    // the server keeps no copy of the values: it imports them
    for (const { file, text } of server) {
      expect(text, file).not.toMatch(/\bRESTART_EXIT_CODE\s*=/);
      expect(text, file).not.toMatch(new RegExp(`['"\`]${LISTENING_PREFIX.trim()}`));
    }
    for (const name of ['RESTART_EXIT_CODE', 'LISTENING_PREFIX']) {
      const imports = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '@cadence/shared'`);
      const user = server.find(({ text }) => imports.test(text));
      expect(user, `apps/server/src imports ${name} from @cadence/shared`).toBeDefined();
      expect(user!.text.replace(imports, ''), `${user!.file} uses ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // NODE_ENV is for the libraries; everything else must be read by the server's configuration
    const config = sources('apps/server/src', 'packages/shared/src');
    for (const key of Object.keys(env).filter((k) => k !== 'NODE_ENV')) {
      const reads = config.some(({ text }) => new RegExp(`\\benv\\.${key}\\b`).test(text));
      expect(reads, `the server reads ${key}`).toBe(true);
    }
  });

  it('covers every message the web UI posts and everything it expects to know about the shell', () => {
    const web = sources('apps/web/src');
    const posted = new Set(
      web.flatMap(({ text }) =>
        [...text.matchAll(/postNative\(\s*(?:\{\s*type:\s*)?['"](\w+)['"]/g)].map((m) => m[1]!),
      ),
    );
    expect(posted.size, 'postNative(…) calls in apps/web/src').toBeGreaterThan(0);
    for (const type of posted) expect(NATIVE_MESSAGES as readonly string[], `message ${type}`).toContain(type);

    const decl = [...web, ...sources('packages/shared/src')]
      .map(({ text }) => /interface ShellInfo \{([^}]*)\}/.exec(text)?.[1])
      .find((body) => body !== undefined);
    expect(decl, 'interface ShellInfo in apps/web/src or packages/shared/src').toBeDefined();
    const keys = [...decl!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(Object.keys(shellInfo('desktop', '1.0.0', null)).sort());
  });
});
