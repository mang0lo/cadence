import type { IntradayResponse } from '@cadence/shared';
import { browserTzAt, DAY_S } from '@/lib/time';

/**
 * Local offsets inside one stretch of time (a day of samples, a night). The data give the UTC offset at both ends;
 * across a daylight-saving switch (or a flight) the two differ and the switch instant is not exactly in the data. It
 * is taken from the browser's time zone when that zone has the same two offsets at both ends (the usual case: data
 * recorded at home), else from the data where they mark it (newer servers give the intraday buckets after a switch
 * their own `tzMin`), else it is assumed at 02:00 standard time, the rule of the EU, Australia, New Zealand and, in
 * spring, North America.
 */

/** First instant after `startTs` with the browser offset of `endTs` (bisection to the second). */
function browserSwitch(startTs: number, endTs: number): number {
  const before = browserTzAt(startTs);
  let lo = startTs;
  let hi = endTs;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (browserTzAt(mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** First 02:00 of the standard (smaller) offset at or after `startTs`. */
function twoAmStandard(startTs: number, std: number): number {
  const local = startTs + std * 60;
  let at = local - (((local % DAY_S) + DAY_S) % DAY_S) + 2 * 3600;
  if (at < local) at += DAY_S;
  return at - std * 60;
}

/**
 * The UTC offset in minutes at any instant from `startTs` (offset `startTz`) to `endTs` (offset `endTz`); `marked` is
 * the first moment the data know to have the end offset.
 */
export function tzSpan(
  startTs: number,
  startTz: number,
  endTs: number,
  endTz: number,
  marked?: number,
): (ts: number) => number {
  if (startTz === endTz || endTs <= startTs) return () => startTz;
  const switchTs =
    browserTzAt(startTs) === startTz && browserTzAt(endTs) === endTz
      ? browserSwitch(startTs, endTs)
      : (marked ?? Math.min(endTs, twoAmStandard(startTs, Math.min(startTz, endTz))));
  return (ts) => (ts < switchTs ? startTz : endTz);
}

/**
 * Offsets of an intraday day: `tzMin` is the offset of its first sample, and the server ends the day at the local
 * midnight after the last sample (`dayEndTs`), which gives that sample's offset. 23 or 25 hours on a switch day.
 */
export function intradayTz(
  d: Pick<IntradayResponse, 'tzMin' | 'dayStartTs' | 'dayEndTs'> & { buckets: readonly { ts: number; tzMin?: number }[] },
): (ts: number) => number {
  const endTz = (d.dayStartTs + d.tzMin * 60 + DAY_S - d.dayEndTs) / 60;
  return tzSpan(d.dayStartTs, d.tzMin, d.dayEndTs, endTz, d.buckets.find((b) => b.tzMin === endTz)?.ts);
}
