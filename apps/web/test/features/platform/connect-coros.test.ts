import { describe, expect, it } from 'vitest';
import type { ConnectSyncProgress, CorosStatus } from '@cadence/shared';
import { corosErrorText, syncChanges } from '@/features/connect/api';
import type { TFunction } from '@/lib/i18n';

// The Connect page belongs to this package; its tests live next to the platform ones.

const t: TFunction = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

function status(sync: Partial<ConnectSyncProgress> | null): CorosStatus {
  return {
    connected: true,
    email: 'a@b.c',
    region: 'eu',
    nickname: null,
    connectedAt: 1,
    autoSync: true,
    mobileData: true,
    lastSyncAt: null,
    lastError: null,
    needsReconnect: false,
    activities: { fetched: 0, failed: 0, lastStartTs: null },
    health: { days: 0, firstDay: null, lastDay: null },
    sync: sync && {
      state: 'listing',
      startedAt: 1,
      finishedAt: null,
      full: false,
      listed: 0,
      toDownload: 0,
      downloaded: 0,
      failed: 0,
      jobId: null,
      healthDays: 0,
      sleepNights: 0,
      error: null,
      ...sync,
    },
  };
}

describe('what a COROS sync changed', () => {
  it('sees the import job the sync queued after downloading', () => {
    expect(syncChanges(status({ state: 'downloading' }), status({ state: 'health', jobId: 'j1' }))).toEqual({
      job: true,
      ended: 'no',
    });
    expect(syncChanges(status({ state: 'health', jobId: 'j1' }), status({ state: 'health', jobId: 'j1' })).job).toBe(false);
  });

  it('sees the end of a sync, with or without new health values', () => {
    expect(syncChanges(status({ state: 'health' }), status({ state: 'done' })).ended).toBe('sources');
    expect(syncChanges(status({ state: 'health' }), status({ state: 'failed', error: 'x' })).ended).toBe('sources');
    expect(syncChanges(status({ state: 'health' }), status({ state: 'done', healthDays: 3 })).ended).toBe('all');
    expect(syncChanges(status({ state: 'health' }), status({ state: 'done', sleepNights: 1 })).ended).toBe('all');
  });

  it('sees nothing while nothing runs', () => {
    expect(syncChanges(status(null), status(null))).toEqual({ job: false, ended: 'no' });
    expect(syncChanges(status({ state: 'done', jobId: 'j1' }), status({ state: 'done', jobId: 'j1' }))).toEqual({
      job: false,
      ended: 'no',
    });
  });
});

describe('COROS sync errors', () => {
  it('translates what the server composes and keeps what COROS said', () => {
    expect(corosErrorText(t, 'COROS is rate limiting requests – try again in a few minutes')).toBe(
      'connect.coros.errors.rateLimited',
    );
    expect(corosErrorText(t, '3 activities could not be downloaded · Health data: token expired')).toBe(
      'connect.coros.errors.downloads({"count":3}) · connect.coros.errors.health({"error":"token expired"})',
    );
    expect(corosErrorText(t, 'Sleep & daily data: COROS app login failed (wrong password)')).toBe(
      'connect.coros.errors.mobile({"error":"COROS app login failed (wrong password)"})',
    );
    expect(corosErrorText(t, 'Something else')).toBe('Something else');
  });
});
