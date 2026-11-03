/**
 * Helpers for GPS tracks in several parts (see WorkoutStreams.breaks): a workout paused in one town and continued
 * in another (train, car) has a jump in its track that is neither distance nor climbing.
 */

/** [start, end) index ranges of the parts of a track of n points split at `breaks`. */
export function trackParts(n: number, breaks: ArrayLike<number> | undefined | null): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  for (let i = 0; i < (breaks?.length ?? 0); i++) {
    const b = breaks![i]!;
    if (b > a && b < n) {
      out.push([a, b]);
      a = b;
    }
  }
  if (n > a) out.push([a, n]);
  return out;
}

/**
 * Elevation without the jumps between track parts: every later part is shifted so the profile continues where the
 * previous part ended. Grades and climbs then only see height differences within a part. NaN/null stay missing.
 */
export function stitchElevation(
  ele: ArrayLike<number | null>,
  breaks: ArrayLike<number> | undefined | null,
): Float64Array {
  const n = ele.length;
  const out = Float64Array.from({ length: n }, (_, i) => {
    const v = ele[i];
    return v === null || v === undefined ? NaN : v;
  });
  if (!breaks?.length) return out;
  let offset = 0;
  let lastValid = NaN;
  const isBreak = new Set(Array.from(breaks));
  for (let i = 0; i < n; i++) {
    const v = out[i]!;
    if (isBreak.has(i) && v === v && lastValid === lastValid) offset = lastValid - v;
    else if (isBreak.has(i) && v !== v) {
      // the part starts without elevation: align at its first valid value
      let j = i + 1;
      while (j < n && out[j] !== out[j]) j++;
      if (j < n && lastValid === lastValid) offset = lastValid - out[j]!;
    }
    if (v === v) {
      out[i] = v + offset;
      lastValid = out[i]!;
    }
  }
  return out;
}
