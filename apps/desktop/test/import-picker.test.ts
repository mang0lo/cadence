import { describe, expect, it } from 'vitest';
import { importDialogOptions } from '../src/import-picker';

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
