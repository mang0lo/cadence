import { isNativeShell, postNative } from './native';

function base64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 of the UTF-8 bytes of a text (btoa alone only takes Latin-1). */
export function base64Utf8(text: string): string {
  return base64Bytes(new TextEncoder().encode(text));
}

/** Base64 (without a data: prefix) of the bytes of a blob. */
export async function blobBase64(blob: Blob): Promise<string> {
  return base64Bytes(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * Lets the user save a file the page made (share image, CSV export) under `filename`: a text (saved as UTF-8, `type`
 * for browsers) or a blob, which keeps its own type.
 *  - Mac, Linux and Windows app: the app saves it itself (saveFile; blob downloads are unreliable in embedded web
 *    views). The apps keep the name and take only the types in SAVE_FILE_TYPES (@cadence/shared).
 *  - browsers: a link to a blob: URL, revoked half a minute later (WebKit starts the download of a clicked link only
 *    after the click handler returned). The link is clicked before the first await, so still inside the user's click.
 * Resolves to true when the app took the file (browsers show their own download instead).
 */
export async function saveFile(filename: string, content: Blob | string, type = 'text/plain'): Promise<boolean> {
  if (isNativeShell()) {
    const base64 = typeof content === 'string' ? base64Utf8(content) : await blobBase64(content);
    return postNative('saveFile', { filename, base64 });
  }
  const url = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type }) : content);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return false;
}
