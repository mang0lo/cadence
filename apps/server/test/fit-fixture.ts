import { Encoder, Profile } from '@garmin/fitsdk';

export interface FitFixtureOptions {
  /** Unix seconds. */
  start: number;
  /** Seconds. */
  duration?: number;
  sport?: string;
  subSport?: string;
  gps?: boolean;
  /** Pause [from, to] in seconds after the start. */
  pause?: [number, number];
  serial?: number;
  /** UTC offset written into the activity message (minutes). */
  tzMin?: number;
  /** Running cadence written as strides per minute (FIT convention). */
  cadence?: number;
}

const FIT_EPOCH_S = 631065600;
const SEMI = 2 ** 31 / 180;

/** A synthetic COROS-like FIT activity: a 1 Hz run at 3 m/s heading north from Vienna. */
export function buildFit(o: FitFixtureOptions): Uint8Array {
  const duration = o.duration ?? 1800;
  const sport = o.sport ?? 'running';
  const subSport = o.subSport ?? 'generic';
  const gps = o.gps ?? true;
  const date = (ts: number) => new Date(ts * 1000);
  const enc = new Encoder();
  // the SDK's message types are strict per message; the fixture writes plain objects
  const put = (num: number, mesg: Record<string, unknown>) => enc.onMesg(num, mesg as never);
  put(Profile.MesgNum.FILE_ID, {
    type: 'activity',
    manufacturer: 'coros',
    product: 42,
    serialNumber: o.serial ?? 123456,
    timeCreated: date(o.start),
  });
  put(Profile.MesgNum.DEVICE_INFO, {
    timestamp: date(o.start),
    deviceIndex: 'creator',
    manufacturer: 'coros',
    productName: 'PACE 3',
    softwareVersion: 3.05,
  });
  put(Profile.MesgNum.EVENT, { timestamp: date(o.start), event: 'timer', eventType: 'start' });
  let distance = 0;
  const lat0 = 48.2;
  const lon0 = 16.37;
  for (let s = 0; s <= duration; s++) {
    const paused = o.pause && s > o.pause[0] && s < o.pause[1];
    if (o.pause && s === o.pause[0])
      put(Profile.MesgNum.EVENT, { timestamp: date(o.start + s), event: 'timer', eventType: 'stopAll' });
    if (o.pause && s === o.pause[1])
      put(Profile.MesgNum.EVENT, { timestamp: date(o.start + s), event: 'timer', eventType: 'start' });
    if (paused) continue;
    if (s > 0) distance += 3;
    const lat = lat0 + distance / 111_320;
    put(Profile.MesgNum.RECORD, {
      timestamp: date(o.start + s),
      ...(gps ? { positionLat: Math.round(lat * SEMI), positionLong: Math.round(lon0 * SEMI) } : {}),
      enhancedAltitude: 170 + Math.sin(s / 120) * 5,
      enhancedSpeed: 3,
      distance,
      heartRate: 140 + Math.round(10 * Math.sin(s / 300)),
      cadence: o.cadence ?? 85,
      power: 250,
    });
  }
  const end = o.start + duration;
  const timer = duration - (o.pause ? o.pause[1] - o.pause[0] : 0);
  put(Profile.MesgNum.EVENT, { timestamp: date(end), event: 'timer', eventType: 'stopAll' });
  put(Profile.MesgNum.LAP, {
    timestamp: date(end),
    startTime: date(o.start),
    totalElapsedTime: duration,
    totalTimerTime: timer,
    totalDistance: distance,
  });
  put(Profile.MesgNum.SESSION, {
    timestamp: date(end),
    startTime: date(o.start),
    sport,
    subSport,
    totalElapsedTime: duration,
    totalTimerTime: timer,
    totalDistance: distance,
    totalCalories: 420,
    avgHeartRate: 140,
    maxHeartRate: 150,
    minHeartRate: 130,
    avgPower: 250,
    maxPower: 260,
    totalAscent: 12,
    totalDescent: 11,
  });
  put(Profile.MesgNum.ACTIVITY, {
    timestamp: date(end),
    localTimestamp: end - FIT_EPOCH_S + (o.tzMin ?? 60) * 60,
    totalTimerTime: timer,
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });
  return enc.close();
}
