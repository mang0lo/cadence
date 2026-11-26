import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64Utf8, ecgCsv, saveTextFile } from '@/features/health/lib/download';

/** Minimal DOM for the download helper (the web tests run in node). */
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ECG CSV export', () => {
  it('writes seconds and microvolts per sample', () => {
    expect(ecgCsv({ samples: [12, -5.5, 30], sampleRateHz: 512 })).toBe('time_s,voltage_uV\n0.0000,12\n0.0020,-5.5\n0.0039,30');
  });

  it('encodes UTF-8 text as base64', () => {
    expect(base64Utf8('time_s,voltage_uV\n0.0000,12')).toBe(Buffer.from('time_s,voltage_uV\n0.0000,12').toString('base64'));
    expect(Buffer.from(base64Utf8('Größe µV'), 'base64').toString('utf8')).toBe('Größe µV');
  });

  it('keeps the blob URL alive after the click in browsers', () => {
    vi.useFakeTimers();
    const clicks = fakeDom();
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cadence/1');
    saveTextFile('ecg.csv', 'a,b');
    expect(clicks).toEqual([{ href: 'blob:cadence/1', download: 'ecg.csv', attached: true }]);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith('blob:cadence/1');
  });

  it('hands the Mac app a data: URL and the Linux / Windows app the file itself', () => {
    const clicks = fakeDom();
    const mac = vi.fn();
    vi.stubGlobal('window', { webkit: { messageHandlers: { cadence: { postMessage: mac } } }, setTimeout: globalThis.setTimeout });
    const create = vi.spyOn(URL, 'createObjectURL');
    saveTextFile('ecg.csv', 'a,b');
    expect(clicks).toEqual([{ href: `data:text/csv;charset=utf-8;base64,${btoa('a,b')}`, download: 'ecg.csv', attached: true }]);
    expect(create).not.toHaveBeenCalled();
    expect(mac).not.toHaveBeenCalled();

    const desktop = vi.fn();
    vi.stubGlobal('window', { cadenceNative: { postMessage: desktop, platform: 'linux' }, setTimeout: globalThis.setTimeout });
    saveTextFile('ecg.csv', 'a,b');
    expect(desktop).toHaveBeenCalledWith({ type: 'saveFile', filename: 'ecg.csv', base64: btoa('a,b') });
    expect(clicks).toHaveLength(1);
  });
});
