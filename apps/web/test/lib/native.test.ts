/**
 * The bridge to the Mac and desktop apps (lib/native.ts): messages go to the shell the page runs in, and the import
 * page asks the shell for the path it kept (importReady) instead of reading one from the URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_IMPORT_EVENT, type NativeImportDetail } from '@cadence/shared';
import { isNativeShell, onNativeImport, postNative } from '@/lib/native';

/** A window of the Mac app, the desktop app or a browser: what the page posted to the shell. */
function fakeWindow(shell: 'macos' | 'desktop' | null) {
  const posted: unknown[] = [];
  const postMessage = (msg: unknown) => posted.push(msg);
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  if (shell === 'macos') win.webkit = { messageHandlers: { cadence: { postMessage } } };
  if (shell === 'desktop') win.cadenceNative = { platform: 'linux', postMessage };
  vi.stubGlobal('window', win);
  return { win, posted };
}

/** What the shells run in the page (apps/desktop/src/shell-contract.ts, ShellContract.swift): true when taken. */
const handOver = (win: EventTarget, detail: unknown) =>
  !win.dispatchEvent(new CustomEvent(NATIVE_IMPORT_EVENT, { detail, cancelable: true }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postNative', () => {
  it('posts the message to the shell the page runs in', () => {
    for (const shell of ['macos', 'desktop'] as const) {
      const { posted } = fakeWindow(shell);
      expect(isNativeShell()).toBe(true);
      expect(postNative('saveFile', { filename: 'run.png', base64: 'iVBO' })).toBe(true);
      expect(postNative('pickImportFile', { folder: true })).toBe(true);
      expect(postNative('openDataFolder')).toBe(true);
      expect(posted).toEqual([
        { type: 'saveFile', filename: 'run.png', base64: 'iVBO' },
        { type: 'pickImportFile', folder: true },
        { type: 'openDataFolder' },
      ]);
    }
  });

  it('does nothing in a browser', () => {
    fakeWindow(null);
    expect(isNativeShell()).toBe(false);
    expect(postNative('openDataFolder')).toBe(false);
  });
});

describe('onNativeImport', () => {
  it('asks the shell for the path it kept for the import page', () => {
    const { posted } = fakeWindow('desktop');
    const stop = onNativeImport(() => undefined);
    expect(posted).toEqual([{ type: 'importReady' }]);
    stop();
  });

  it('takes the paths the shell hands over and tells it so', () => {
    const { win } = fakeWindow('macos');
    const taken: NativeImportDetail[] = [];
    const stop = onNativeImport((d) => taken.push(d));
    // picked on the import page: imported at once; kept while another page was open: confirmed first
    expect(handOver(win, { path: '/Users/me/export.zip' })).toBe(true);
    expect(handOver(win, { path: '/Users/me/fit', confirm: true })).toBe(true);
    expect(taken).toEqual([
      { path: '/Users/me/export.zip', confirm: false },
      { path: '/Users/me/fit', confirm: true },
    ]);
    stop();
  });

  it('leaves events without a path alone, and stops listening when the page goes', () => {
    const { win } = fakeWindow('desktop');
    const take = vi.fn();
    const stop = onNativeImport(take);
    for (const detail of [null, {}, { path: '' }, { path: 42 }]) expect(handOver(win, detail)).toBe(false);
    stop();
    // no import page: the shell opens it and keeps the path
    expect(handOver(win, { path: '/Users/me/export.zip' })).toBe(false);
    expect(take).not.toHaveBeenCalled();
  });

  it('does nothing in a browser, where no shell hands over paths', () => {
    const { win } = fakeWindow(null);
    const take = vi.fn();
    const stop = onNativeImport(take);
    expect(handOver(win, { path: '/Users/me/export.zip' })).toBe(false);
    expect(take).not.toHaveBeenCalled();
    stop();
  });
});
