import { describe, expect, it } from 'vitest';
import { loadConfig, timeZoneWarning } from '../src/config';

describe('time zone warning at startup', () => {
  const config = (env: Record<string, string>) => loadConfig({ CADENCE_DATA_DIR: '/tmp/cadence-test', ...env });

  it('warns a server without TZ that local days follow the process zone', () => {
    const env = { CADENCE_MODE: 'server' };
    const warning = timeZoneWarning(config(env), env);
    expect(warning).toMatch(/\bTZ\b/);
    expect(warning).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(timeZoneWarning(config(env), { ...env, TZ: '' })).not.toBeNull();
  });

  it('stays quiet with TZ set, and in the desktop app or a dev run (they run in the user’s own zone)', () => {
    expect(timeZoneWarning(config({ CADENCE_MODE: 'server' }), { CADENCE_MODE: 'server', TZ: 'Europe/Berlin' })).toBeNull();
    expect(timeZoneWarning(config({ CADENCE_MODE: 'desktop' }), { CADENCE_MODE: 'desktop' })).toBeNull();
    expect(timeZoneWarning(config({ CADENCE_MODE: 'dev' }), { CADENCE_MODE: 'dev' })).toBeNull();
  });
});
