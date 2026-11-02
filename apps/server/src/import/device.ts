/**
 * Apple writes the producing device of a sample as the description of an HKDevice object:
 *
 *   <<HKDevice: 0x283a0d2c0>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:9.0>
 *
 * The pointer differs between samples of the same device, so it is stripped from the dedupe key.
 */
export interface ParsedDevice {
  /** Normalised description without the object pointer (unique key of the devices table). */
  key: string;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  hardware: string | null;
  software: string | null;
}

const FIELD_RE = /(?:^|,\s*)([A-Za-z][A-Za-z0-9 ]*?):(.*?)(?=,\s*[A-Za-z][A-Za-z0-9 ]*?:|$)/g;

/** Key of a raw device string: everything after the `<<HKDevice: 0x…>` prefix (cheap, used for caching). */
export function deviceKey(raw: string): string {
  if (raw.startsWith('<<HKDevice')) {
    const gt = raw.indexOf('>');
    if (gt > 0) return '<<HKDevice>' + raw.slice(gt + 1);
  }
  return raw;
}

export function parseDevice(raw: string): ParsedDevice {
  const key = deviceKey(raw);
  let body = key.startsWith('<<HKDevice>') ? key.slice('<<HKDevice>'.length) : key;
  if (body.endsWith('>')) body = body.slice(0, -1);
  body = body.replace(/^\s*,\s*/, '');
  const fields: Record<string, string> = {};
  for (const m of body.matchAll(FIELD_RE)) {
    const k = m[1]!.trim();
    const v = m[2]!.trim();
    if (k && v) fields[k] = v;
  }
  const hasFields = Object.keys(fields).length > 0;
  return {
    key,
    name: fields.name ?? (hasFields ? null : raw.trim() || null),
    manufacturer: fields.manufacturer ?? null,
    model: fields.model ?? null,
    hardware: fields.hardware ?? null,
    software: fields.software ?? null,
  };
}

/** Human readable device label for workouts ("Apple Watch (Watch6,2)"). */
export function deviceLabel(d: ParsedDevice): string | null {
  if (!d.name) return null;
  return d.hardware && !d.name.includes(d.hardware) ? `${d.name} (${d.hardware})` : d.name;
}
