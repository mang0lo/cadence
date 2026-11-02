import { parseAppleDate } from './dates';

/**
 * electrocardiograms/ecg_YYYY-MM-DD.csv: a key,value header (English or German, depending on the phone's
 * language), a blank line, then one sample (µV) per line. The Name / Date of Birth lines are never stored.
 *
 *   Name,Jane Doe                       | Name,Max Mustermann
 *   Date of Birth,"Jan 1, 1990"         | Geburtsdatum,01.01.1990
 *   Recorded Date,2024-05-01 07:30:12 +0200 | Aufnahmedatum,…
 *   Classification,Sinus Rhythm         | Klassifizierung,Sinusrhythmus
 *   Symptoms,                           | Symptome,
 *   Software Version,2                  | Softwareversion,2
 *   Device,"Watch6,2"                   | Gerät,"Watch6,2"
 *   Sample Rate,512 hertz               | Abtastrate,512 Hertz
 *   Lead,Lead I                         | Ableitung,Ableitung I
 *   Unit,µV                             | Einheit,µV
 */
export interface EcgReading {
  recordedTs: number;
  tzMin: number;
  classification: string | null;
  symptoms: string | null;
  softwareVersion: string | null;
  device: string | null;
  sampleRateHz: number | null;
  lead: string | null;
  unit: string | null;
  samples: Float32Array;
}

type Field =
  'recorded' | 'classification' | 'symptoms' | 'software' | 'device' | 'rate' | 'lead' | 'unit' | 'skip';

const KEYS: Record<string, Field> = {
  name: 'skip',
  'date of birth': 'skip',
  birthdate: 'skip',
  geburtsdatum: 'skip',
  'recorded date': 'recorded',
  'date recorded': 'recorded',
  aufnahmedatum: 'recorded',
  'aufgezeichnet am': 'recorded',
  aufzeichnungsdatum: 'recorded',
  classification: 'classification',
  klassifizierung: 'classification',
  klassifikation: 'classification',
  symptoms: 'symptoms',
  symptome: 'symptoms',
  'software version': 'software',
  softwareversion: 'software',
  device: 'device',
  gerät: 'device',
  geraet: 'device',
  'sample rate': 'rate',
  abtastrate: 'rate',
  abtastfrequenz: 'rate',
  lead: 'lead',
  ableitung: 'lead',
  unit: 'unit',
  einheit: 'unit',
};

/** Split one CSV line into fields (RFC 4180 quoting). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseSample(line: string): number {
  let s = line.trim();
  if (!s) return NaN;
  if (s.startsWith('"')) s = s.replace(/^"|"$/g, '').replace(',', '.');
  else if (s.includes(',')) {
    // "-80,234" unquoted German decimal comma, or a "value,…" row: take the first field
    const f = s.split(',');
    s =
      f.length === 2 && /^\d+$/.test(f[1]!.trim()) && /^-?\d+$/.test(f[0]!.trim())
        ? `${f[0]}.${f[1]}`
        : f[0]!;
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}

export function parseEcgCsv(text: string): EcgReading | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const r: Omit<EcgReading, 'samples' | 'recordedTs' | 'tzMin'> & { recorded: string | null } = {
    recorded: null,
    classification: null,
    symptoms: null,
    softwareVersion: null,
    device: null,
    sampleRateHz: null,
    lead: null,
    unit: null,
  };
  const samples: number[] = [];
  let inData = false;
  for (const line of lines) {
    if (!inData) {
      if (!line.trim()) {
        if (r.recorded) inData = true;
        continue;
      }
      const v = parseSample(line);
      if (!Number.isNaN(v) && r.recorded) {
        inData = true;
        samples.push(v);
        continue;
      }
      const [k, ...rest] = csvFields(line);
      const key = (k ?? '').trim().toLowerCase();
      const value = rest.join(',').trim();
      const field = KEYS[key];
      switch (field) {
        case 'recorded':
          r.recorded = value;
          break;
        case 'classification':
          r.classification = value || null;
          break;
        case 'symptoms':
          r.symptoms = value || null;
          break;
        case 'software':
          r.softwareVersion = value || null;
          break;
        case 'device':
          r.device = value || null;
          break;
        case 'rate': {
          const m = /(\d+(?:[.,]\d+)?)/.exec(value);
          r.sampleRateHz = m ? Number(m[1]!.replace(',', '.')) : null;
          break;
        }
        case 'lead':
          r.lead = value || null;
          break;
        case 'unit':
          r.unit = value || null;
          break;
        default:
          break; // 'skip' (personal data) and unknown keys
      }
      continue;
    }
    const v = parseSample(line);
    if (!Number.isNaN(v)) samples.push(v);
  }
  const date = parseAppleDate(r.recorded);
  if (!date) return null;
  return {
    recordedTs: date.ts,
    tzMin: date.tzMin,
    classification: r.classification,
    symptoms: r.symptoms,
    softwareVersion: r.softwareVersion,
    device: r.device,
    sampleRateHz: r.sampleRateHz,
    lead: r.lead,
    unit: r.unit,
    samples: Float32Array.from(samples),
  };
}
