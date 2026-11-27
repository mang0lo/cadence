import { isNativeShell, postNative, shellInfo } from './native';

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
 * The page runs in a Mac app that saves only PNG images through saveFile: up to 1.0.0 it saved any other file as
 * "cadence.png". Such an app still shows this web UI when it is connected to a newer remote server. An app that does
 * not say its version is taken for one of them; a build without a release number ('dev') is current.
 */
export function macSavesOnlyPng(): boolean {
  if (!window.webkit?.messageHandlers?.cadence) return false;
  const info = shellInfo();
  if (info?.app !== 'macos') return true;
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(info.version);
  if (!v) return false;
  const [major, minor, patch] = [Number(v[1]), Number(v[2]), Number(v[3])];
  return major < 1 || (major === 1 && minor === 0 && patch === 0);
}

/**
 * Lets the user save a file the page made (share image, CSV export) under `filename`: a text (saved as UTF-8, `type`
 * for browsers) or a blob, which keeps its own type.
 *  - Mac, Linux and Windows app: the app saves it itself (saveFile; blob downloads are unreliable in embedded web
 *    views). The apps keep the name and take only the types in SAVE_FILE_TYPES (@cadence/shared). A Mac app that
 *    saves only PNG images (macSavesOnlyPng) gets every other file as a link to a data: URL, which its download
 *    handler saves to ~/Downloads under the link's name.
 *  - browsers: a link to a blob: URL, revoked half a minute later (WebKit starts the download of a clicked link only
 *    after the click handler returned). The link is clicked before the first await, so still inside the user's click.
 * Resolves to true when the app took the file through saveFile (otherwise a download shows it).
 */
export async function saveFile(filename: string, content: Blob | string, type = 'text/plain'): Promise<boolean> {
  const pngOnlyMac = isNativeShell() && !/\.png$/i.test(filename) && macSavesOnlyPng();
  if (isNativeShell() && !pngOnlyMac) {
    const base64 = typeof content === 'string' ? base64Utf8(content) : await blobBase64(content);
    return postNative('saveFile', { filename, base64 });
  }
  let href: string;
  if (pngOnlyMac)
    href =
      typeof content === 'string'
        ? `data:${type};charset=utf-8;base64,${base64Utf8(content)}`
        : `data:${content.type || 'application/octet-stream'};base64,${await blobBase64(content)}`;
  else href = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type }) : content);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!pngOnlyMac) window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
  return false;
}
