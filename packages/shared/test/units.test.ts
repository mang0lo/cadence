import { describe, expect, it } from 'vitest';
import { canonicalUnit, normalizeUnit } from '../src';

describe('units of an export', () => {
  it('keep a unit named like a key of every object as exported instead of failing the import', () => {
    for (const unit of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(normalizeUnit(7, unit), unit).toEqual({ value: 7, unit });
      expect(canonicalUnit(unit), unit).toBe(unit);
    }
    expect(normalizeUnit(5, 'km')).toEqual({ value: 5000, unit: 'm' });
    expect(canonicalUnit('lb')).toBe('kg');
    expect(normalizeUnit(72, 'count/min')).toEqual({ value: 72, unit: 'count/min' });
  });
});
