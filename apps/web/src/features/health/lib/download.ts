import type { EcgDetail } from '@cadence/shared';

/** ECG waveform as CSV: seconds since the start of the recording and the voltage in µV. */
export function ecgCsv(d: Pick<EcgDetail, 'samples' | 'sampleRateHz'>): string {
  const rate = d.sampleRateHz ?? 512;
  return ['time_s,voltage_uV', ...d.samples.map((v, i) => `${(i / rate).toFixed(4)},${v}`)].join('\n');
}
