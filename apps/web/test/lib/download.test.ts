/**
 * One way to save a file the page made (apps/web/src/lib/download.ts): the share image and the ECG CSV. The Mac and
 * the Linux / Windows app save it themselves (saveFile keeps the name; blob downloads are unreliable in embedded web
 * views), browsers download a blob: URL that stays alive after the click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Utf8, blobBase64, macSavesOnlyPng, saveFile } from '@/lib/download';

/** Minimal DOM for the download link (the web tests run in node). */
function fakeDom() {
  const clicks: { href: string; download: string; attached: boolean }[] = [];
  const body = { children: new Set<object>(), appendChild: (el: object) => body.children.add(el) };
  const createElement = () => {
    const el = {
      href: '',
      download: '',
      style: {} as Record<string, string>,
      click: () => clicks.push({ href: el.href, download: el.download, attached: body.children.has(el) }),
      remove: () => body.children.delete(el),
    };
    return el;
  };
  vi.stubGlobal('document', { createElement, body });
  return clicks;
}

/**
 * The window of the Mac app or the Linux / Windows app: what the page posted to it. `macVersion` is what the Mac app
 * tells the page about itself (window.cadenceShell; null: nothing).
 */
function appWindow(app: 'macos' | 'desktop', macVersion: string | null = '1.1.0') {
  const posted: unknown[] = [];
  const postMessage = (msg: unknown) => posted.push(msg);
  vi.stubGlobal(
    'window',
    app === 'macos'
      ? {
          webkit: { messageHandlers: { cadence: { postMessage } } },
          ...(macVersion !== null && {
            cadenceShell: { app: 'macos', version: macVersion, remote: 'http://nas.local:28787' },
          }),
          setTimeout: globalThis.setTimeout,
        }
      : { cadenceNative: { postMessage, platform: 'linux' }, setTimeout: globalThis.setTimeout },
  );
  return posted;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saveFile', () => {
  it('downloads a text in a browser, inside the click, and keeps the blob URL alive after it', async () => {
    vi.useFakeTimers();
    const clicks = fakeDom();
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cadence/1');
    const saved = saveFile('ecg.csv', 'a,b', 'text/csv');
    // clicked before the first await: still inside the user's click
    expect(clicks).toEqual([{ href: 'blob:cadence/1', download: 'ecg.csv', attached: true }]);
    expect(await saved).toBe(false);
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('text/csv');
    expect(await blob.text()).toBe('a,b');
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith('blob:cadence/1');
  });

  it('downloads a blob with its own type in a browser', async () => {
    const clicks = fakeDom();
    vi.stubGlobal('window', { setTimeout: () => 0 });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cadence/2');
    const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    expect(await saveFile('run.png', image)).toBe(false);
    expect(create).toHaveBeenCalledWith(image);
    expect(clicks).toEqual([{ href: 'blob:cadence/2', download: 'run.png', attached: true }]);
  });

  it('hands the Mac and the Linux / Windows app the file with its name', async () => {
    for (const app of ['macos', 'desktop'] as const) {
      const clicks = fakeDom();
      const posted = appWindow(app);
      const create = vi.spyOn(URL, 'createObjectURL');
      expect(await saveFile('ecg.csv', 'Größe µV', 'text/csv')).toBe(true);
      const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
      expect(await saveFile('run.png', new Blob([png], { type: 'image/png' }))).toBe(true);
      expect(posted).toEqual([
        { type: 'saveFile', filename: 'ecg.csv', base64: Buffer.from('Größe µV').toString('base64') },
        { type: 'saveFile', filename: 'run.png', base64: Buffer.from(png).toString('base64') },
      ]);
      expect(clicks).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('gives a Mac app that saves only PNG images (up to 1.0.0) other files through its download handler', async () => {
    // such an app (connected to a newer remote server) saved the ECG CSV as "cadence.png" through saveFile
    for (const version of ['1.0.0', '0.3.1', null]) {
      const clicks = fakeDom();
      const posted = appWindow('macos', version);
      const create = vi.spyOn(URL, 'createObjectURL');
      const saved = saveFile('ecg.csv', 'Größe µV', 'text/csv');
      // a text is clicked at once, still inside the user's click
      expect(clicks, String(version)).toEqual([
        {
          href: `data:text/csv;charset=utf-8;base64,${Buffer.from('Größe µV').toString('base64')}`,
          download: 'ecg.csv',
          attached: true,
        },
      ]);
      expect(await saved).toBe(false);
      const json = new Blob(['{"a":1}'], { type: 'application/json' });
      expect(await saveFile('export.json', json)).toBe(false);
      expect(clicks[1]).toEqual({
        href: `data:application/json;base64,${Buffer.from('{"a":1}').toString('base64')}`,
        download: 'export.json',
        attached: true,
      });
      // the share image still goes through saveFile, which those apps take for PNG images
      const png = new Uint8Array([137, 80, 78, 71]);
      expect(await saveFile('run.png', new Blob([png], { type: 'image/png' }))).toBe(true);
      expect(posted).toEqual([
        { type: 'saveFile', filename: 'run.png', base64: Buffer.from(png).toString('base64') },
      ]);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('hands newer Mac apps every file, also builds without a release number', async () => {
    for (const version of ['1.0.1', '1.1.0', '2.0.0', 'dev']) {
      const clicks = fakeDom();
      const posted = appWindow('macos', version);
      expect(await saveFile('ecg.csv', 'a,b', 'text/csv'), version).toBe(true);
      expect(posted).toEqual([
        { type: 'saveFile', filename: 'ecg.csv', base64: Buffer.from('a,b').toString('base64') },
      ]);
      expect(clicks).toEqual([]);
    }
  });
});

describe('macSavesOnlyPng', () => {
  it('is true only in Mac apps up to 1.0.0 (and those that do not say their version)', () => {
    vi.stubGlobal('window', {});
    expect(macSavesOnlyPng()).toBe(false);
    appWindow('desktop');
    expect(macSavesOnlyPng()).toBe(false);
    for (const [version, only] of [
      ['0.3.0', true],
      ['1.0.0', true],
      [null, true],
      ['1.0.1', false],
      ['1.1.0', false],
      ['10.0.0', false],
      ['dev', false],
    ] as const) {
      appWindow('macos', version);
      expect(macSavesOnlyPng(), String(version)).toBe(only);
    }
  });
});

describe('base64', () => {
  it('encodes the UTF-8 bytes of a text', () => {
    expect(base64Utf8('time_s,voltage_uV\n0.0000,12')).toBe(Buffer.from('time_s,voltage_uV\n0.0000,12').toString('base64'));
    expect(Buffer.from(base64Utf8('Größe µV'), 'base64').toString('utf8')).toBe('Größe µV');
  });

  it('encodes the bytes of a blob, also beyond one chunk', async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    expect(await blobBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString('base64'));
  });
});
