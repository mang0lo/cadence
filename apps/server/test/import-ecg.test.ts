import { describe, expect, it } from 'vitest';
import { parseEcgCsv } from '../src/import/ecg';

const samples = Array.from({ length: 100 }, (_, i) => (Math.sin(i / 5) * 500).toFixed(3)).join('\n');
const MAY_1 = Date.UTC(2024, 4, 1, 5, 30, 12) / 1000; // 2024-05-01 07:30:12 +0200

describe('ECG CSV from a phone in another language', () => {
  it('reads a French export by the date format and the order of the lines', () => {
    const r = parseEcgCsv(
      `Nom,Jean Dupont\nDate de naissance,"1 janv. 1990"\nDate d'enregistrement,2024-05-01 07:30:12 +0200\nClassification,Rythme sinusal\nSymptômes,\nVersion du logiciel,2\nAppareil,"Watch6,2"\nFréquence d'échantillonnage,512 hertz\nDérivation,Dérivation I\nUnité,µV\n\n${samples}\n`,
    )!;
    expect(r).toMatchObject({
      recordedTs: MAY_1,
      tzMin: 120,
      classification: 'Rythme sinusal',
      symptoms: null,
      softwareVersion: '2',
      device: 'Watch6,2',
      sampleRateHz: 512,
      lead: 'Dérivation I',
      unit: 'µV',
    });
    expect(r.samples.length).toBe(100);
    expect(JSON.stringify({ ...r, samples: null })).not.toMatch(/Jean|1990/);
  });

  it('reads a Japanese export', () => {
    const r = parseEcgCsv(
      `名前,山田太郎\n生年月日,1990/01/01\n記録日,2024-05-01 07:30:12 +0200\n分類,洞調律\n症状,\nソフトウェアバージョン,2\nデバイス,"Watch6,2"\nサンプリングレート,512ヘルツ\n誘導,誘導I\n単位,µV\n\n${samples}\n`,
    )!;
    expect(r).toMatchObject({ recordedTs: MAY_1, classification: '洞調律', sampleRateHz: 512, lead: '誘導I', unit: 'µV' });
    expect(r.samples.length).toBe(100);
    expect(JSON.stringify({ ...r, samples: null })).not.toMatch(/山田|1990/);
  });

  it('never takes the birth date for the recording date', () => {
    // an ISO birth date (as Lithuanian writes it) comes first
    const r = parseEcgCsv(
      `Vardas,Jonas\nGimimo data,1990-01-01\nĮrašymo data,2024-05-01 07:30:12 +0200\nKlasifikacija,Sinusinis ritmas\nSimptomai,\nPrograminės įrangos versija,2\nĮrenginys,"Watch6,2"\nĖminių dažnis,512 hercų\nLaidas,I laidas\nVienetas,µV\n\n${samples}\n`,
    )!;
    expect(r.recordedTs).toBe(MAY_1);
    expect(r.sampleRateHz).toBe(512);
    // without a recording date in Apple's format there is no reading
    expect(parseEcgCsv(`Vardas,Jonas\nGimimo data,1990-01-01\n\n${samples}\n`)).toBeNull();
    expect(parseEcgCsv('Name,x\n\n1\n2\n')).toBeNull();
  });

  it('uses 512 Hz when the order of the lines did not hold', () => {
    // no symptoms line: the lead lands where the rate is expected
    const r = parseEcgCsv(
      `Nombre,Ana\nFecha de nacimiento,1 ene 1990\nFecha de registro,2024-05-01 07:30:12 +0200\nClasificación,Ritmo sinusal\nVersión de software,2\nDispositivo,"Watch6,2"\nFrecuencia de muestreo,512 hercios\nDerivación,Derivación I\nUnidad,µV\n\n${samples}\n`,
    )!;
    expect(r.recordedTs).toBe(MAY_1);
    expect(r.sampleRateHz).toBe(512);
    expect(r.samples.length).toBe(100);
  });

  it('reads English and German exports as before', () => {
    const en = parseEcgCsv(
      `Name,Jane Doe\nDate of Birth,"Jan 1, 1990"\nRecorded Date,2024-05-01 07:30:12 +0200\nClassification,Sinus Rhythm\nSymptoms,\nSoftware Version,2\nDevice,"Watch6,2"\nLead,Lead I\nUnit,µV\n\n${samples}\n`,
    )!;
    // no rate line: stays unknown, as before
    expect(en).toMatchObject({ recordedTs: MAY_1, classification: 'Sinus Rhythm', sampleRateHz: null, lead: 'Lead I' });
  });
});
