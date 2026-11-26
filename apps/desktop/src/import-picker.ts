/**
 * The native import dialog (File → Import…, File → Import folder…, the import page's button). The built-in
 * server's importer reads Apple Health exports (export.zip, export.xml or the unzipped folder) and FIT activities
 * (a .fit file, or a zip or folder of them). On Windows and Linux one dialog picks either files or folders, never
 * both (with openDirectory set it only shows folders), so folders have a dialog of their own.
 *
 * Only Electron types here: tested on its own (apps/desktop/test/import-picker.test.ts).
 */
import type { OpenDialogOptions } from 'electron';

/** The page asks for a folder with `{ type: 'pickImportFile', folder: true }` (shell-contract.ts). */
export type ImportPick = 'file' | 'folder';

export function importDialogOptions(pick: ImportPick): OpenDialogOptions {
  if (pick === 'folder') {
    return { title: 'Import a folder', buttonLabel: 'Import', properties: ['openDirectory'] };
  }
  return {
    title: 'Import',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [
      { name: 'Apple Health export or FIT files', extensions: ['zip', 'xml', 'fit'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
}
