import { ImportInputError } from './source';
import type { XmlAttrs, XmlHandler } from './xml';

/** Generic captured element (Workout, Correlation and every element the importer keeps verbatim). */
export interface XmlNode {
  name: string;
  attrs: XmlAttrs;
  children: XmlNode[] | null;
}

/** Record metadata: MetadataEntry key/values, plus `beats` for HRV records and `_children` for anything unknown. */
export type RecordMeta = Record<string, unknown>;

/** What the export.xml handler hands to the importer. */
export interface HealthSink {
  exportInfo(info: { locale?: string; exportDate?: string }): void;
  me(attrs: XmlAttrs, node: XmlNode): void;
  record(attrs: XmlAttrs, meta: RecordMeta | null): void;
  correlation(node: XmlNode): void;
  workout(node: XmlNode): void;
  activitySummary(attrs: XmlAttrs): void;
  /** Audiogram, ClinicalRecord, VisionPrescription and any unknown top-level element. */
  other(node: XmlNode): void;
}

/**
 * Maps the element structure of export.xml onto HealthSink calls:
 *
 *   <HealthData locale="de_AT">
 *     <ExportDate value="…"/>  <Me …/>
 *     <Record …> [<MetadataEntry key value/>] [<HeartRateVariabilityMetadataList><InstantaneousBeatsPerMinute bpm time/>…] </Record>
 *     <Correlation …> <MetadataEntry/> <Record/>… </Correlation>
 *     <Workout …> <MetadataEntry/> <WorkoutEvent/> <WorkoutStatistics/> <WorkoutRoute><FileReference path/></WorkoutRoute> <WorkoutActivity/> </Workout>
 *     <ActivitySummary …/>  <Audiogram …/>  <ClinicalRecord …/>  <VisionPrescription …/>
 *   </HealthData>
 *
 * Top-level <Record> (by far the most frequent element) takes a fast path without building a tree.
 */
export class AppleHealthHandler implements XmlHandler {
  private depth = 0;
  // fast path state for top-level <Record>
  private rec: XmlAttrs | null = null;
  private recDepth = 0;
  private recMeta: RecordMeta | null = null;
  private beats: { bpm: number; time: string }[] | null = null;
  // generic capture
  private tree: XmlNode | null = null;
  private treeDepth = 0;
  private stack: XmlNode[] = [];
  /** Element count, for stats/diagnostics. */
  elements = 0;

  constructor(private readonly sink: HealthSink) {}

  open(name: string, attrs: XmlAttrs, _selfClosing: boolean): void {
    const d = ++this.depth;
    this.elements++;
    if (this.tree) {
      const node: XmlNode = { name, attrs, children: null };
      const parent = this.stack[this.stack.length - 1]!;
      (parent.children ??= []).push(node);
      this.stack.push(node);
      return;
    }
    if (this.rec) {
      if (name === 'MetadataEntry') {
        const k = attrs.key;
        if (k !== undefined) (this.recMeta ??= {})[k] = attrs.value ?? '';
      } else if (name === 'InstantaneousBeatsPerMinute') {
        (this.beats ??= []).push({ bpm: Number(attrs.bpm), time: attrs.time ?? '' });
      } else if (name !== 'HeartRateVariabilityMetadataList') {
        const meta = (this.recMeta ??= {});
        ((meta._children as XmlNode[] | undefined) ?? (meta._children = [] as XmlNode[])).push({
          name,
          attrs,
          children: null,
        });
      }
      return;
    }
    if (d === 1) {
      // Anything else (e.g. export_cda.xml, the clinical document next to export.xml) would be captured as one
      // giant tree and "imported" as nothing.
      if (name !== 'HealthData')
        throw new ImportInputError(
          `Not an Apple Health export.xml (root element <${name}>): choose export.xml or the export.zip`,
        );
      this.sink.exportInfo({ locale: attrs.locale });
      return;
    }
    if (d === 2 && name === 'Record') {
      this.rec = attrs;
      this.recDepth = d;
      this.recMeta = null;
      this.beats = null;
      return;
    }
    this.startTree(name, attrs, d);
  }

  close(_name: string): void {
    const d = this.depth--;
    if (this.tree) {
      this.stack.pop();
      if (d === this.treeDepth) {
        const t = this.tree;
        this.tree = null;
        this.stack = [];
        this.dispatch(t);
      }
      return;
    }
    if (this.rec && d === this.recDepth) {
      let meta = this.recMeta;
      if (this.beats) (meta ??= {}).beats = this.beats;
      const r = this.rec;
      this.rec = null;
      this.recMeta = null;
      this.beats = null;
      this.sink.record(r, meta);
    }
  }

  private startTree(name: string, attrs: XmlAttrs, d: number): void {
    this.tree = { name, attrs, children: null };
    this.treeDepth = d;
    this.stack = [this.tree];
  }

  private dispatch(node: XmlNode): void {
    switch (node.name) {
      case 'ExportDate':
        this.sink.exportInfo({ exportDate: node.attrs.value });
        break;
      case 'Me':
        this.sink.me(node.attrs, node);
        break;
      case 'Record':
        // a Record that was captured generically (e.g. nested in an unexpected place)
        this.sink.record(node.attrs, recordMetaOf(node));
        break;
      case 'Correlation':
        this.sink.correlation(node);
        break;
      case 'Workout':
        this.sink.workout(node);
        break;
      case 'ActivitySummary':
        this.sink.activitySummary(node.attrs);
        break;
      default:
        this.sink.other(node);
    }
  }
}

/** Metadata of a Record captured as a tree (Correlation children). */
export function recordMetaOf(node: XmlNode): RecordMeta | null {
  if (!node.children) return null;
  let meta: RecordMeta | null = null;
  for (const c of node.children) {
    if (c.name === 'MetadataEntry' && c.attrs.key !== undefined)
      (meta ??= {})[c.attrs.key] = c.attrs.value ?? '';
    else if (c.name === 'HeartRateVariabilityMetadataList') {
      (meta ??= {}).beats = (c.children ?? [])
        .filter((b) => b.name === 'InstantaneousBeatsPerMinute')
        .map((b) => ({ bpm: Number(b.attrs.bpm), time: b.attrs.time ?? '' }));
    } else {
      const m = (meta ??= {});
      const list = (m._children as XmlNode[] | undefined) ?? [];
      list.push(c);
      m._children = list;
    }
  }
  return meta;
}

/** MetadataEntry children → { key: value }. */
export function metadataOf(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of node.children ?? [])
    if (c.name === 'MetadataEntry' && c.attrs.key !== undefined) out[c.attrs.key] = c.attrs.value ?? '';
  return out;
}

/** Strip empty `children` for compact JSON. */
export function nodeToJson(node: XmlNode): { name: string; attrs: XmlAttrs; children?: unknown[] } {
  return node.children?.length
    ? { name: node.name, attrs: node.attrs, children: node.children.map(nodeToJson) }
    : { name: node.name, attrs: node.attrs };
}
