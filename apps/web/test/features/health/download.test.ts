import { describe, expect, it } from 'vitest';
import { ecgCsv } from '@/features/health/lib/download';

// saving the file: test/lib/download.test.ts (saveFile)
describe('ECG CSV export', () => {
  it('writes seconds and microvolts per sample', () => {
    expect(ecgCsv({ samples: [12, -5.5, 30], sampleRateHz: 512 })).toBe('time_s,voltage_uV\n0.0000,12\n0.0020,-5.5\n0.0039,30');
  });
});
