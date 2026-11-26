import { describe, expect, it } from 'vitest';
import { importDialogOptions, importPickOf } from '../src/import-picker';

describe('importDialogOptions', () => {
  it('picks what the importer reads: Apple Health exports and FIT files', () => {
    const o = importDialogOptions('file');
    expect(o.properties).toEqual(['openFile']);
    expect(o.filters?.[0]?.extensions).toEqual(expect.arrayContaining(['zip', 'xml', 'fit']));
  });

  it('picks folders (an unzipped export, a folder of FIT files) in a dialog of their own', () => {
    // Windows and Linux show a folder picker as soon as openDirectory is set: one dialog cannot pick both
    const o = importDialogOptions('folder');
    expect(o.properties).toEqual(['openDirectory']);
    expect(o.filters).toBeUndefined();
  });
});

describe('importPickOf', () => {
  it('asks for a folder only when the page says so', () => {
    const messages: [Record<string, unknown>, string][] = [
      [{ type: 'pickImportFile', folder: true }, 'folder'],
      [{ type: 'pickImportFile' }, 'file'],
      [{ type: 'pickImportFile', folder: 'yes' }, 'file'],
    ];
    for (const [msg, pick] of messages) expect(importPickOf(msg)).toBe(pick);
    expect(importPickOf(null)).toBe('file');
  });
});
