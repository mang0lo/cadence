import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from '../../web/src/lib/native';

describe('server address (Settings → Server in the apps)', () => {
  it('accepts host[:port] with or without scheme and normalizes it', () => {
    expect(normalizeServerUrl('homeserver.local:8787')).toBe('http://homeserver.local:8787');
    expect(normalizeServerUrl('  http://192.168.1.20:8787/  ')).toBe('http://192.168.1.20:8787');
    expect(normalizeServerUrl('https://cadence.example.org')).toBe('https://cadence.example.org');
    // a server behind a reverse proxy path keeps it
    expect(normalizeServerUrl('https://nas.local/cadence/')).toBe('https://nas.local/cadence');
  });

  it('rejects everything that is not an http(s) server', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('ftp://nas.local')).toBeNull();
    expect(normalizeServerUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeServerUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
  });
});
