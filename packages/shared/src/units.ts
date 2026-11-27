/** Unit constants and conversions shared by server (normalisation) and web (display). */

export const M_PER_KM = 1000;
export const M_PER_MI = 1609.344;
export const M_PER_FT = 0.3048;
export const KG_PER_LB = 0.45359237;
export const KJ_PER_KCAL = 4.184;

/** Canonical unit per physical dimension. Records are stored in these units. */
export const CANONICAL_UNITS = {
  length: 'm',
  mass: 'kg',
  energy: 'kcal',
  temperature: 'degC',
  speed: 'm/s',
  volume: 'L',
} as const;

interface Conversion {
  to: string;
  f: (v: number) => number;
}

const mul =
  (k: number) =>
  (v: number): number =>
    v * k;

/**
 * Apple Health unit string → conversion into the canonical unit. Units that are not listed
 * (count, count/min, ms, %, mmHg, dBASPL, W, …) are stored exactly as exported.
 */
const CONVERSIONS: Record<string, Conversion> = {
  km: { to: 'm', f: mul(1000) },
  mi: { to: 'm', f: mul(M_PER_MI) },
  ft: { to: 'm', f: mul(M_PER_FT) },
  yd: { to: 'm', f: mul(0.9144) },
  in: { to: 'm', f: mul(0.0254) },
  cm: { to: 'm', f: mul(0.01) },
  mm: { to: 'm', f: mul(0.001) },
  lb: { to: 'kg', f: mul(KG_PER_LB) },
  g: { to: 'kg', f: mul(0.001) },
  oz: { to: 'kg', f: mul(0.028349523125) },
  st: { to: 'kg', f: mul(6.35029318) },
  kJ: { to: 'kcal', f: (v) => v / KJ_PER_KCAL },
  Cal: { to: 'kcal', f: mul(1) },
  cal: { to: 'kcal', f: mul(0.001) },
  degF: { to: 'degC', f: (v) => ((v - 32) * 5) / 9 },
  'km/hr': { to: 'm/s', f: (v) => v / 3.6 },
  'mi/hr': { to: 'm/s', f: mul(M_PER_MI / 3600) },
  'ft/s': { to: 'm/s', f: mul(M_PER_FT) },
  mL: { to: 'L', f: mul(0.001) },
  dL: { to: 'L', f: mul(0.1) },
  'fl_oz_us': { to: 'L', f: mul(0.0295735295625) },
  'cup_us': { to: 'L', f: mul(0.2365882365) },
  'pt_us': { to: 'L', f: mul(0.473176473) },
  // imperial (UK) volumes, e.g. water in "fl oz" with a British region
  'fl_oz_imp': { to: 'L', f: mul(0.0284130625) },
  'cup_imp': { to: 'L', f: mul(0.284130625) },
  'pt_imp': { to: 'L', f: mul(0.56826125) },
};

/** Own keys only: a unit like 'toString' in a crafted export must not reach Object's methods. */
const conversion = (unit: string): Conversion | undefined =>
  Object.hasOwn(CONVERSIONS, unit) ? CONVERSIONS[unit] : undefined;

/** Normalise a value exported by Apple Health into the canonical unit. */
export function normalizeUnit(value: number, unit: string | null | undefined): { value: number; unit: string | null } {
  if (!unit) return { value, unit: null };
  const c = conversion(unit);
  return c ? { value: c.f(value), unit: c.to } : { value, unit };
}

/** The canonical unit a raw Apple Health unit normalises to. */
export function canonicalUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  return conversion(unit)?.to ?? unit;
}
