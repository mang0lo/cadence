import { describe, expect, it } from 'vitest';
import { decodeEntities, XmlScanner, scanXmlString, type XmlAttrs } from '../src/import/xml';

type Ev = ['open', string, XmlAttrs, boolean] | ['close', string] | ['text', string];

function collect(chunks: string[], withText = false): Ev[] {
  const ev: Ev[] = [];
  const s = new XmlScanner({
    open: (n, a, sc) => ev.push(['open', n, { ...a }, sc]),
    close: (n) => ev.push(['close', n]),
    ...(withText ? { text: (t: string) => ev.push(['text', t]) } : {}),
  });
  for (const c of chunks) s.write(c);
  s.end();
  return ev;
}

const DOC = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData
  locale CDATA #REQUIRED
>
<!ATTLIST Record
  type          CDATA #REQUIRED
  unit          CDATA #IMPLIED
  value         CDATA #IMPLIED
  comment       CDATA "a ] b > c"
>
<!ELEMENT Correlation ((MetadataEntry|Record)*)>
<!ELEMENT Correlation ((MetadataEntry|Record)*)>
<!ATTLIST Broken weird "unbalanced >
]>
<HealthData locale="de_AT">
 <!-- a comment with <Record> inside -->
 <ExportDate value="2026-11-02 08:00:00 +0100"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple&#x20;Watch von Jörg" device="&lt;&lt;HKDevice: 0x283a0d2c0&gt;, name:Apple Watch&gt;" unit="count/min" startDate="2024-05-01 07:30:12 +0200" value="72">
  <MetadataEntry key='HKMetadataKeyHeartRateMotionContext' value='0'/>
 </Record>
 <Record type="X" note="a > b &amp; c &quot;q&quot; &apos;s&apos; &#65;&#x42; &unknown;" empty=""/>
 <![CDATA[ <not a="tag"/> ]]>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" >text &amp; more</Workout >
</HealthData>
`;

describe('XmlScanner', () => {
  it('parses elements, skips DOCTYPE subset / comments / PI, decodes entities', () => {
    const ev = collect([DOC]);
    const opens = ev.filter((e) => e[0] === 'open') as ['open', string, XmlAttrs, boolean][];
    expect(opens.map((e) => e[1])).toEqual([
      'HealthData',
      'ExportDate',
      'Record',
      'MetadataEntry',
      'Record',
      'Workout',
    ]);
    expect(opens[0]![2]).toEqual({ locale: 'de_AT' });
    expect(opens[1]![3]).toBe(true);
    expect(opens[2]![2].sourceName).toBe('Apple Watch von Jörg');
    expect(opens[2]![2].device).toBe('<<HKDevice: 0x283a0d2c0>, name:Apple Watch>');
    expect(opens[3]![2]).toEqual({ key: 'HKMetadataKeyHeartRateMotionContext', value: '0' });
    expect(opens[4]![2].note).toBe(`a > b & c "q" 's' AB &unknown;`);
    expect(opens[4]![2].empty).toBe('');
    expect(opens[5]![2]).toEqual({ workoutActivityType: 'HKWorkoutActivityTypeRunning' });
    // balanced open/close
    expect(ev.filter((e) => e[0] === 'close').length).toBe(opens.length);
  });

  it('produces identical events for every chunk split position', () => {
    const ref = JSON.stringify(collect([DOC], true));
    for (let i = 1; i < DOC.length; i++) {
      const got = JSON.stringify(collect([DOC.slice(0, i), DOC.slice(i)], true));
      if (got !== ref)
        throw new Error(
          `mismatch when splitting at ${i}: ${JSON.stringify(DOC.slice(Math.max(0, i - 10), i + 10))}`,
        );
    }
  });

  it('handles tiny random chunks', () => {
    const ref = JSON.stringify(collect([DOC], true));
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 50; round++) {
      const chunks: string[] = [];
      for (let i = 0; i < DOC.length;) {
        const n = 1 + Math.floor(rnd() * 7);
        chunks.push(DOC.slice(i, i + n));
        i += n;
      }
      expect(JSON.stringify(collect(chunks, true))).toBe(ref);
    }
  });

  it('reports text and CDATA when asked', () => {
    const texts = collect([DOC], true)
      .filter((e) => e[0] === 'text')
      .map((e) => (e as ['text', string])[1].trim());
    expect(texts).toContain('<not a="tag"/>');
    expect(texts).toContain('text & more');
  });

  it('is lenient with malformed input', () => {
    const ev: string[] = [];
    scanXmlString(`<a x=1 y="2" z><b q='>'/><c   /></a><d attr="unterminated`, {
      open: (n, a) => ev.push(`${n}:${JSON.stringify(a)}`),
      close: (n) => ev.push(`/${n}`),
    });
    expect(ev).toEqual(['a:{"x":"1","y":"2","z":""}', 'b:{"q":">"}', '/b', 'c:{}', '/c', '/a']);
  });

  it('decodes entities only when needed', () => {
    expect(decodeEntities('plain')).toBe('plain');
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;&#169;&#xA9;')).toBe(`<>&"'©©`);
    expect(decodeEntities('&#0; &#xD800; &bogus;')).toBe('&#0; &#xD800; &bogus;');
  });
});
