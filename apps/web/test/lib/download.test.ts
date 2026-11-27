/**
 * One way to save a file the page made (apps/web/src/lib/download.ts): the share image and the ECG CSV. The Mac and
 * the Linux / Windows app save it themselves (saveFile keeps the name; blob downloads are unreliable in embedded web
 * views), browsers download a blob: URL that stays alive after the click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Utf8, blobBase64, saveFile } from '@/lib/download';

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

/** The window of the Mac app or the Linux / Windows app: what the page posted to it. */
function appWindow(app: 'macos' | 'desktop') {
  const posted: unknown[] = [];
  const postMessage = (msg: unknown) => posted.push(msg);
  vi.stubGlobal(
    'window',
    app === 'macos'
      ? { webkit: { messageHandlers: { cadence: { postMessage } } }, setTimeout: globalThis.setTimeout }
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
