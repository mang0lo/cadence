import type { EcgDetail } from '@cadence/shared';
import { postNative } from '@/lib/native';

/** ECG waveform as CSV: seconds since the start of the recording and the voltage in µV. */
export function ecgCsv(d: Pick<EcgDetail, 'samples' | 'sampleRateHz'>): string {
  const rate = d.sampleRateHz ?? 512;
  return ['time_s,voltage_uV', ...d.samples.map((v, i) => `${(i / rate).toFixed(4)},${v}`)].join('\n');
}

/** Base64 of the UTF-8 bytes of a text (btoa alone only takes Latin-1). */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Lets the user save a text file the page made (ECG as CSV). WebKit starts the download of a clicked link only after
 * the click handler returned, so a blob: URL revoked right away is gone by then:
 *  - Linux / Windows app: the app's own save dialog (blob downloads are unreliable in embedded views);
 *  - Mac app: a data: URL, which the app's download handler saves to ~/Downloads (its `saveFile` only takes PNG images);
 *  - browsers: a blob: URL that is revoked half a minute later.
 */
export function saveTextFile(filename: string, text: string, type = 'text/csv'): void {
  if (window.cadenceNative && postNative('saveFile', { filename, base64: base64Utf8(text) })) return;
  const mac = !!window.webkit?.messageHandlers?.cadence;
  const blobUrl = mac ? null : URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = blobUrl ?? `data:${type};charset=utf-8;base64,${base64Utf8(text)}`;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (blobUrl) window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}
