import { afterAll, describe, expect, it } from 'vitest';
import { itemDate } from '@/features/health/lib/explorer';
import { createFormatter } from '@/lib/format';

describe('health explorer items', () => {
  const saved = process.env.TZ;
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it('shows the days of activity rings as they are, also west of UTC', () => {
    process.env.TZ = 'America/New_York';
    const fmt = createFormatter('metric', 'en-US', 'en');
    const firstRing = Date.UTC(2024, 10, 25) / 1000; // the server sends UTC midnight of the day
    expect(itemDate(fmt, 'activitySummaries', firstRing)).toBe('Nov 25, 2024');
    // real instants (an ECG at 00:30 UTC) are evening of the day before in New York
    expect(itemDate(fmt, 'ecg', firstRing + 1800)).toBe('Nov 24, 2024');
  });
});
