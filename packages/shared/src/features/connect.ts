/**
 * API contract for the "connect" feature: activities from other watches, pulled from the vendor's cloud.
 * Owned by apps/server/src/features/connect and apps/web/src/features/connect.
 *
 * Mounted under /api/connect. The COROS connector talks to the private API behind COROS Training Hub
 * (unofficial: it can change without notice). Downloaded activities are FIT files that go through the regular
 * import job, so they show up in the import history.
 */

/** COROS account region: 'en' = Americas / rest of world, 'eu' = Europe, 'cn' = China. */
export type CorosRegion = 'en' | 'eu' | 'cn';
export const COROS_REGIONS: CorosRegion[] = ['eu', 'en', 'cn'];

export type ConnectSyncState = 'listing' | 'downloading' | 'health' | 'done' | 'failed';

export interface ConnectSyncProgress {
  state: ConnectSyncState;
  /** Unix seconds. */
  startedAt: number;
  finishedAt: number | null;
  /** Full sync (every activity) instead of only new ones. */
  full: boolean;
  /** Activities found in the vendor's list so far. */
  listed: number;
  /** New activities to fetch. */
  toDownload: number;
  downloaded: number;
  failed: number;
  /** Import job started for the downloaded files (GET /api/import/jobs/:id). */
  jobId: string | null;
  /** Days of health values (resting HR, HRV, training load …) fetched by this sync. */
  healthDays: number;
  /** Nights of sleep fetched from the COROS app API by this sync. */
  sleepNights: number;
  error: string | null;
}

/** GET /api/connect/coros */
export interface CorosStatus {
  connected: boolean;
  email: string | null;
  region: CorosRegion;
  /** COROS profile name. */
  nickname: string | null;
  connectedAt: number | null;
  /** Sync on server start and every few hours. */
  autoSync: boolean;
  /**
   * Also sync sleep, steps, calories and all-day heart rate through the COROS app API. Its login works like the phone
   * app's and can sign the phone app out (Cadence logs in again only when its token stops working).
   */
  mobileData: boolean;
  lastSyncAt: number | null;
  /** Last error of a sync or of the login (e.g. the password changed). */
  lastError: string | null;
  /**
   * COROS refused the stored login (e.g. the password changed): the auto sync pauses until the account is connected
   * again (a manual sync still tries).
   */
  needsReconnect: boolean;
  /** Activities known from COROS: fetched (imported) and failed downloads. */
  activities: { fetched: number; failed: number; lastStartTs: number | null };
  /** Daily health values from COROS: days stored and the range. */
  health: { days: number; firstDay: string | null; lastDay: string | null };
  /** Running or last sync of this server session. */
  sync: ConnectSyncProgress | null;
}

/** POST /api/connect/coros/login — the password is sent to COROS (hashed) and never stored in plain text. */
export interface CorosLoginRequest {
  email: string;
  password: string;
  region: CorosRegion;
}

/** POST /api/connect/coros/sync */
export interface CorosSyncRequest {
  /** Also fetch activities that failed before or are older than the newest known one. */
  full?: boolean;
}

/** PATCH /api/connect/coros */
export interface CorosPrefsPatch {
  autoSync?: boolean;
  mobileData?: boolean;
}
