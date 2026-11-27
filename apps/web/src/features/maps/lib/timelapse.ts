// The time-lapse position is a Store (lib/store.ts): the map follows it imperatively (useOverlayStore), the caption
// and scrubber re-render throttled (useThrottledStore).

/** Label of a time-lapse speed: '0.5×' / '0,5×', '2×'. */
export const speedLabel = (fmt: { num: (v: number, digits?: number) => string }, speed: number): string =>
  `${fmt.num(speed, speed % 1 ? 1 : 0)}×`;
