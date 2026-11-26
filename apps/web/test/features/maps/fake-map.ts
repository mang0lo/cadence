/**
 * A stand-in for a MapLibre map with a loaded style, for testing the maps layer helpers in node: ordered layers,
 * GeoJSON sources, paint/layout/filter setters and feature state. Calls are recorded so tests can check what the map
 * had to do.
 */
import type { Map } from 'maplibre-gl';

export interface FakeLayer {
  id: string;
  type: string;
  source?: string;
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
  filter?: unknown;
}

export interface FakeSource {
  type: string;
  data: unknown;
  promoteId?: string;
}

export class FakeLayerMap {
  order: string[] = [];
  layers: Record<string, FakeLayer> = {};
  sources: Record<string, FakeSource> = {};
  /** feature state per source and feature id */
  state: Record<string, Record<string, Record<string, unknown>>> = {};
  calls: string[] = [];

  /** Basemap layers as [id, type]. */
  constructor(base: [string, string][] = []) {
    for (const [id, type] of base) {
      this.order.push(id);
      this.layers[id] = { id, type, paint: {}, layout: {} };
    }
  }

  get map(): Map {
    return this as unknown as Map;
  }

  getStyle(): never {
    this.calls.push('getStyle');
    throw new Error('getStyle() serializes the whole style: not needed here');
  }
  getLayersOrder(): string[] {
    this.calls.push('getLayersOrder');
    return [...this.order];
  }
  getLayer(id: string): FakeLayer | undefined {
    return this.layers[id];
  }
  getSource(id: string) {
    const s = this.sources[id];
    return s && { type: s.type, setData: (data: unknown) => this.setData(id, data) };
  }
  private setData(id: string, data: unknown): void {
    this.calls.push(`setData ${id}`);
    this.sources[id]!.data = data;
  }
  addSource(id: string, spec: FakeSource): void {
    if (this.sources[id]) throw new Error(`source ${id} exists`);
    this.calls.push(`addSource ${id}`);
    this.sources[id] = { ...spec };
  }
  addLayer(spec: Omit<FakeLayer, 'paint' | 'layout'> & Partial<FakeLayer>, before?: string): void {
    if (this.layers[spec.id]) throw new Error(`layer ${spec.id} exists`);
    this.calls.push(`addLayer ${spec.id}`);
    this.layers[spec.id] = { paint: {}, layout: {}, ...spec };
    const at = before === undefined ? -1 : this.order.indexOf(before);
    if (at < 0) this.order.push(spec.id);
    else this.order.splice(at, 0, spec.id);
  }
  removeLayer(id: string): void {
    delete this.layers[id];
    this.order = this.order.filter((x) => x !== id);
  }
  removeSource(id: string): void {
    delete this.sources[id];
  }
  setPaintProperty(id: string, name: string, value: unknown): void {
    this.calls.push(`paint ${id} ${name}`);
    this.layers[id]!.paint[name] = value;
  }
  setLayoutProperty(id: string, name: string, value: unknown): void {
    this.calls.push(`layout ${id} ${name}`);
    this.layers[id]!.layout[name] = value;
  }
  setFilter(id: string, filter: unknown): void {
    this.calls.push(`filter ${id}`);
    this.layers[id]!.filter = filter;
  }
  setFeatureState(target: { source: string; id: number | string }, state: Record<string, unknown>): void {
    this.calls.push(`state ${target.source}`);
    const s = (this.state[target.source] ??= {});
    s[String(target.id)] = { ...s[String(target.id)], ...state };
  }
  removeFeatureState(target: { source: string; id?: number | string }): void {
    this.calls.push(`removeState ${target.source}`);
    if (target.id === undefined) this.state[target.source] = {};
    else delete this.state[target.source]?.[String(target.id)];
  }

  /** Ids of the layers this test added, in drawing order. */
  added(prefix: string): string[] {
    return this.order.filter((id) => id.startsWith(prefix));
  }
  resetCalls(): void {
    this.calls = [];
  }
}
