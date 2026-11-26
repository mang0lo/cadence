import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MESSAGES,
  LISTENING_PREFIX,
  parseBridgeMessage,
  parseListening,
  RESTART_EXIT_CODE,
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
    for (const type of BRIDGE_MESSAGES) {
      expect(parseBridgeMessage({ type, filename: 'a.png', base64: 'AA==', url: '' })?.type).toBe(type);
    }
  });
});

// The contract is kept in four places: the server, the web UI, this shell and the Mac app's ShellContract.swift.
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
    expect(cases?.split(',').map((c) => c.trim()).sort()).toEqual([...BRIDGE_MESSAGES].sort());

    const infoBody = swiftBody('shellInfo');
    expect([...infoBody.matchAll(/"(\w+)":/g)].map((m) => m[1]).sort()).toEqual(
      Object.keys(shellInfo('desktop', '1.0.0', null)).sort(),
    );
  });

  it('matches what the server does', () => {
    const server = sources('apps/server/src', 'packages/shared/src');
    const codes = server.flatMap(({ text }) =>
      [...text.matchAll(/RESTART_EXIT_CODE\s*=\s*(\d+)/g)].map((m) => Number(m[1])),
    );
    expect(codes.length, 'RESTART_EXIT_CODE in apps/server/src or packages/shared/src').toBeGreaterThan(0);
    for (const code of codes) expect(code).toBe(RESTART_EXIT_CODE);
    const writes = server.some(({ text }) => text.includes(LISTENING_PREFIX));
    expect(writes, `the server writes "${LISTENING_PREFIX}"`).toBe(true);
    // NODE_ENV is for the libraries; everything else must be read by the server's configuration
    for (const key of Object.keys(env).filter((k) => k !== 'NODE_ENV')) {
      const reads = server.some(({ text }) => new RegExp(`\\benv\\.${key}\\b`).test(text));
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
    for (const type of posted) expect(BRIDGE_MESSAGES as readonly string[], `message ${type}`).toContain(type);

    const decl = [...web, ...sources('packages/shared/src')]
      .map(({ text }) => /interface ShellInfo \{([^}]*)\}/.exec(text)?.[1])
      .find((body) => body !== undefined);
    expect(decl, 'interface ShellInfo in apps/web/src or packages/shared/src').toBeDefined();
    const keys = [...decl!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(Object.keys(shellInfo('desktop', '1.0.0', null)).sort());
  });
});
