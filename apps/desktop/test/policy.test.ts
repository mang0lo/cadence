import { describe, expect, it } from 'vitest';
import {
  allowsPermission,
  isAppFrame,
  isAppUrl,
  isExternalUrl,
  navigationTarget,
  originOf,
} from '../src/policy';

const local = ['http://127.0.0.1:28787'];

describe('originOf', () => {
  it('gives the origin of http(s) URLs only', () => {
    expect(originOf('http://127.0.0.1:28787/import?x=1')).toBe('http://127.0.0.1:28787');
    expect(originOf('https://cadence.example.com:443/')).toBe('https://cadence.example.com');
    expect(originOf('file:///etc/passwd')).toBeNull();
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf(null)).toBeNull();
  });
});

describe('isAppUrl', () => {
  it('compares the whole origin, not a prefix of the URL', () => {
    expect(isAppUrl('http://127.0.0.1:28787/activities/1', local)).toBe(true);
    // these all start with the server URL, but belong to other sites
    expect(isAppUrl('http://127.0.0.1:28787@evil.example/', local)).toBe(false);
    expect(isAppUrl('http://127.0.0.1:287870/', local)).toBe(false);
    expect(isAppUrl('https://cadence.example.com.evil.net/', ['https://cadence.example.com'])).toBe(false);
    // same host, other port or scheme
    expect(isAppUrl('http://127.0.0.1:8787/', local)).toBe(false);
    expect(isAppUrl('https://127.0.0.1:28787/', local)).toBe(false);
  });

  it('knows the origin a server redirected the app to', () => {
    const origins = ['http://cadence.example.com', 'https://cadence.example.com'];
    expect(isAppUrl('https://cadence.example.com/settings', origins)).toBe(true);
    expect(isAppUrl('https://auth.example.com/login', origins)).toBe(false);
  });

  it('is false without an app origin', () => {
    expect(isAppUrl('http://127.0.0.1:28787/', [])).toBe(false);
  });
});

describe('isExternalUrl', () => {
  it('hands only web and mail links to the operating system', () => {
    expect(isExternalUrl('https://www.openstreetmap.org/copyright')).toBe(true);
    expect(isExternalUrl('http://example.com')).toBe(true);
    expect(isExternalUrl('mailto:someone@example.com')).toBe(true);
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'search-ms:query=x&crumb=location:\\\\evil\\share',
      'smb://evil/share',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:alert(1)',
      'vscode://file/x',
      'data:text/html,<p>x',
      '',
    ]) {
      expect(isExternalUrl(url), url).toBe(false);
    }
  });
});

describe('navigationTarget', () => {
  it('keeps app pages in the window and sends web links to the browser', () => {
    expect(navigationTarget('http://127.0.0.1:28787/import', local)).toBe('app');
    expect(navigationTarget('https://www.coros.com/', local)).toBe('external');
    expect(navigationTarget('http://127.0.0.1:28787@evil.example/', local)).toBe('external');
    expect(navigationTarget('file:///etc/passwd', local)).toBe('blocked');
    expect(navigationTarget('search-ms:query=x', local)).toBe('blocked');
  });
});

describe('isAppFrame', () => {
  it('accepts bridge messages only from the main frame of an app page', () => {
    expect(isAppFrame({ url: 'http://127.0.0.1:28787/settings', parent: null }, local)).toBe(true);
    expect(isAppFrame({ url: 'http://127.0.0.1:28787/settings', parent: {} }, local)).toBe(false);
    expect(isAppFrame({ url: 'https://evil.example/', parent: null }, local)).toBe(false);
    expect(isAppFrame(null, local)).toBe(false);
  });
});

describe('allowsPermission', () => {
  it('lets app pages copy and go fullscreen, and nothing else', () => {
    expect(allowsPermission('clipboard-sanitized-write', 'http://127.0.0.1:28787/activities/3', local)).toBe(true);
    expect(allowsPermission('fullscreen', 'http://127.0.0.1:28787', local)).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'midiSysex', 'hid']) {
      expect(allowsPermission(p, 'http://127.0.0.1:28787/', local), p).toBe(false);
    }
  });

  it('denies other sites everything', () => {
    expect(allowsPermission('clipboard-sanitized-write', 'https://evil.example/', local)).toBe(false);
    expect(allowsPermission('fullscreen', '', local)).toBe(false);
  });
});
