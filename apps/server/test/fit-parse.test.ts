import { describe, expect, it } from 'vitest';
import { fitHeaderComplete } from '../src/import/fit/parse';
import { buildFit } from './fit-fixture';

const START = 1_780_000_000; // 2026-05-28

describe('FIT header check', () => {
  const fit = buildFit({ start: START, duration: 60 });

  it('accepts a complete file and rejects a cut-off one', () => {
    expect(fitHeaderComplete(fit, fit.length)).toBe(true);
    expect(fitHeaderComplete(fit.subarray(0, 14), fit.length)).toBe(true); // the header is enough, with the size
    expect(fitHeaderComplete(fit, fit.length - 1)).toBe(false); // the CRC is missing
    expect(fitHeaderComplete(fit.subarray(0, 100), 100)).toBe(false);
    expect(fitHeaderComplete(fit.subarray(0, 8), 8)).toBe(false);
  });

  it('rejects what is not a FIT file (an error page, JSON)', () => {
    const html = new TextEncoder().encode('<html><body>Access denied</body></html>');
    expect(fitHeaderComplete(html, html.length)).toBe(false);
    const json = new TextEncoder().encode('{"result":"1019","message":"Access token invalid"}');
    expect(fitHeaderComplete(json, json.length)).toBe(false);
  });
});
