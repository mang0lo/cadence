import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

/**
 * Fast, tolerant, streaming XML scanner for Apple Health exports (several GB, tens of millions of elements).
 *
 * Feed it string chunks with `write()`; it emits `open(name, attrs, selfClosing)` / `close(name)` events.
 * Not a validating parser: it never throws on malformed input and keeps going.
 *
 *  - tags, comments, CDATA, PIs and the DOCTYPE may be split across chunk boundaries
 *  - attribute values in "double" or 'single' quotes; `>` and `<` inside quoted values are fine
 *  - `<?xml …?>`, comments and the `<!DOCTYPE HealthData [ … ]>` internal subset are skipped entirely
 *    (some iOS versions ship a malformed DTD that breaks strict parsers)
 *  - entities (`&lt; &gt; &amp; &quot; &apos; &#NN; &#xHH;`) are decoded only when a value contains `&`;
 *    unknown entities are kept verbatim
 *  - invalid characters are passed through untouched
 */

export type XmlAttrs = Record<string, string>;

export interface XmlHandler {
  open(name: string, attrs: XmlAttrs, selfClosing: boolean): void;
  close(name: string): void;
  /** Optional character data (entity-decoded, whitespace-only runs are skipped). CDATA content is reported here too. */
  text?(text: string): void;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;

function replaceEntity(
  m: string,
  dec: string | undefined,
  hex: string | undefined,
  named: string | undefined,
): string {
  if (named) return NAMED[named]!;
  const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
  if (cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) return String.fromCodePoint(cp);
  return m;
}

let lastRaw = '';
let lastDecoded = '';

/** Decode the predefined and numeric XML entities. */
export function decodeEntities(raw: string): string {
  if (raw.indexOf('&') < 0) return raw;
  // Device strings etc. repeat for long runs of records: a one-entry memo saves the regex work.
  if (raw === lastRaw) return lastDecoded;
  const out = raw.replace(ENTITY_RE, replaceEntity);
  lastRaw = raw;
  lastDecoded = out;
  return out;
}

// Scanner modes for constructs that may span chunks.
const Mode = { Normal: 0, Comment: 1, CData: 2, PI: 3, Decl: 4, DoctypeSubset: 5 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

const GT = 62; // >
const SLASH = 47; // /
const EQ = 61; // =
const DQ = 34; // "
const SQ = 39; // '
const BANG = 33; // !
const QM = 63; // ?
const LBRACKET = 91; // [

export class XmlScanner {
  private buf = '';
  private mode: Mode = Mode.Normal;
  private started = false;
  private cdata: string[] = [];
  /** Element names seen so far (interned); avoids allocating a new string per tag for the common names. */
  private names: string[] = [];
  /** Attribute names by position of the previous element with the same name. */
  private attrNames = new Map<string, string[]>();

  constructor(private readonly handler: XmlHandler) {}

  write(chunk: string): void {
    let data = this.buf.length ? this.buf + chunk : chunk;
    if (!this.started && data.length) {
      this.started = true;
      if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
    }
    const consumed = this.scan(data, false);
    this.buf = consumed >= data.length ? '' : data.slice(consumed);
  }

  /** Flush the remainder (an unterminated tag at EOF is dropped). */
  end(): void {
    if (this.buf.length) this.scan(this.buf, true);
    this.buf = '';
  }

  private emitText(raw: string): void {
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) > 32) {
        this.handler.text!(decodeEntities(raw));
        return;
      }
    }
  }

  private internName(data: string, start: number, end: number): string {
    const len = end - start;
    const names = this.names;
    for (let k = 0; k < names.length; k++) {
      const n = names[k]!;
      if (n.length === len && data.startsWith(n, start)) {
        if (k > 0) {
          // move to front: the most frequent names are found first
          names[k] = names[k - 1]!;
          names[k - 1] = n;
        }
        return n;
      }
    }
    // Flatten (and detach from the big chunk string) before keeping it around.
    const n = (' ' + data.slice(start, end)).slice(1);
    if (names.length < 64) names.push(n);
    return n;
  }

  /** Returns the number of characters fully consumed. */
  private scan(data: string, final: boolean): number {
    const h = this.handler;
    const wantText = typeof h.text === 'function';
    const n = data.length;
    let pos = 0;

    while (pos < n) {
      // ---- continuation of multi-chunk constructs ----
      if (this.mode !== Mode.Normal) {
        const r = this.skipConstruct(data, pos, final);
        if (r < 0) {
          // not finished: keep a small tail so split terminators are found next time
          const keep =
            this.mode === Mode.DoctypeSubset ? Math.max(pos, keepDoctypeTail(data)) : Math.max(pos, n - 2);
          if (this.mode === Mode.CData && wantText) this.cdata.push(data.slice(pos, keep));
          return keep;
        }
        pos = r;
        continue;
      }

      const lt = data.indexOf('<', pos);
      if (lt < 0) {
        if (wantText) {
          if (!final) return pos; // keep text until the next tag (entities may be split)
          this.emitText(data.slice(pos));
        }
        return n;
      }
      if (wantText && lt > pos) this.emitText(data.slice(pos, lt));
      if (lt + 1 >= n) return final ? n : lt;

      const c1 = data.charCodeAt(lt + 1);

      // ---- close tag ----
      if (c1 === SLASH) {
        const gt = data.indexOf('>', lt + 2);
        if (gt < 0) return final ? n : lt;
        let e = gt;
        while (e > lt + 2 && data.charCodeAt(e - 1) <= 32) e--;
        h.close(this.internName(data, lt + 2, e));
        pos = gt + 1;
        continue;
      }

      // ---- <!-- -->, <![CDATA[ ]]>, <!DOCTYPE …>, other declarations ----
      if (c1 === BANG) {
        if (data.startsWith('<!--', lt)) {
          this.mode = Mode.Comment;
          pos = lt + 4;
        } else if (data.startsWith('<![CDATA[', lt)) {
          this.mode = Mode.CData;
          this.cdata = [];
          pos = lt + 9;
        } else if (n - lt < 9 && !final) {
          return lt; // can't tell yet what this is
        } else if (data.startsWith('<!DOCTYPE', lt) || data.startsWith('<!doctype', lt)) {
          // External ID part up to '[' (internal subset) or '>' (no subset).
          let i = lt + 9;
          let quote = 0;
          for (; i < n; i++) {
            const c = data.charCodeAt(i);
            if (quote) {
              if (c === quote) quote = 0;
            } else if (c === DQ || c === SQ) quote = c;
            else if (c === LBRACKET || c === GT) break;
          }
          if (i >= n) {
            if (!final) return lt;
            return n;
          }
          if (data.charCodeAt(i) === GT) {
            pos = i + 1;
          } else {
            this.mode = Mode.DoctypeSubset;
            pos = i + 1;
          }
        } else {
          this.mode = Mode.Decl;
          pos = lt + 2;
        }
        continue;
      }

      // ---- processing instruction ----
      if (c1 === QM) {
        this.mode = Mode.PI;
        pos = lt + 2;
        continue;
      }

      // ---- open tag ----
      let i = lt + 1;
      while (i < n) {
        const c = data.charCodeAt(i);
        if (c <= 32 || c === SLASH || c === GT) break;
        i++;
      }
      if (i >= n) return final ? n : lt;
      if (i === lt + 1) {
        // '<' followed by whitespace or '>': not a tag, treat as text
        pos = lt + 1;
        continue;
      }
      const name = this.internName(data, lt + 1, i);
      let known = this.attrNames.get(name);
      if (!known) {
        known = [];
        this.attrNames.set(name, known);
      }
      const attrs: XmlAttrs = {};
      let selfClosing = false;
      let k = 0;
      let complete = false;
      for (;;) {
        let c = 0;
        while (i < n && (c = data.charCodeAt(i)) <= 32) i++;
        if (i >= n) break;
        if (c === GT) {
          i++;
          complete = true;
          break;
        }
        if (c === SLASH) {
          if (i + 1 >= n) break;
          if (data.charCodeAt(i + 1) === GT) {
            selfClosing = true;
            i += 2;
            complete = true;
            break;
          }
          i++;
          continue;
        }
        // attribute name
        const ns = i;
        while (i < n) {
          c = data.charCodeAt(i);
          if (c <= 32 || c === EQ || c === GT || c === SLASH) break;
          i++;
        }
        if (i >= n) break;
        // Attribute names repeat in the same order for every element of a kind: reuse the interned strings.
        const alen = i - ns;
        let an: string | undefined = known[k];
        if (an === undefined || an.length !== alen || !data.startsWith(an, ns)) {
          an = undefined;
          for (let j = 0; j < known.length; j++) {
            const cand = known[j]!;
            if (cand.length === alen && data.startsWith(cand, ns)) {
              an = cand;
              k = j;
              break;
            }
          }
          if (an === undefined) {
            an = (' ' + data.slice(ns, i)).slice(1);
            if (known.length < 48) {
              known.push(an);
              k = known.length - 1;
            }
          }
        }
        k++;
        while (i < n && (c = data.charCodeAt(i)) <= 32) i++;
        if (i >= n) break;
        if (c !== EQ) {
          attrs[an] = '';
          continue;
        }
        i++;
        while (i < n && (c = data.charCodeAt(i)) <= 32) i++;
        if (i >= n) break;
        if (c === DQ || c === SQ) {
          const ve = data.indexOf(c === DQ ? '"' : "'", i + 1);
          if (ve < 0) {
            i = n;
            break;
          }
          const raw = data.slice(i + 1, ve);
          attrs[an] = raw.indexOf('&') < 0 ? raw : decodeEntities(raw);
          i = ve + 1;
        } else {
          // unquoted value (invalid XML, accepted leniently)
          const vs = i;
          while (i < n) {
            c = data.charCodeAt(i);
            if (c <= 32 || c === GT || (c === SLASH && data.charCodeAt(i + 1) === GT)) break;
            i++;
          }
          if (i >= n) break;
          const raw = data.slice(vs, i);
          attrs[an] = raw.indexOf('&') < 0 ? raw : decodeEntities(raw);
        }
      }
      if (!complete) {
        if (!final) return lt;
        return n; // truncated tag at EOF: drop it
      }
      h.open(name, attrs, selfClosing);
      if (selfClosing) h.close(name);
      pos = i;
    }
    return n;
  }

  /** Continue skipping a comment / CDATA / PI / declaration / DOCTYPE subset. Returns new pos, or -1 if unfinished. */
  private skipConstruct(data: string, pos: number, final: boolean): number {
    const n = data.length;
    switch (this.mode) {
      case Mode.Comment: {
        const e = data.indexOf('-->', pos);
        if (e < 0) return final ? this.done(n) : -1;
        return this.done(e + 3);
      }
      case Mode.PI: {
        const e = data.indexOf('?>', pos);
        if (e < 0) return final ? this.done(n) : -1;
        return this.done(e + 2);
      }
      case Mode.Decl: {
        const e = data.indexOf('>', pos);
        if (e < 0) return final ? this.done(n) : -1;
        return this.done(e + 1);
      }
      case Mode.CData: {
        const e = data.indexOf(']]>', pos);
        if (e < 0) {
          if (final) {
            this.cdata.push(data.slice(pos));
            this.flushCData();
            return this.done(n);
          }
          return -1;
        }
        this.cdata.push(data.slice(pos, e));
        this.flushCData();
        return this.done(e + 3);
      }
      case Mode.DoctypeSubset: {
        // The subset ends at the first ']' followed by optional whitespace and '>'. Quotes are deliberately
        // ignored: a malformed DTD must never make us swallow the document.
        let i = pos;
        for (;;) {
          const rb = data.indexOf(']', i);
          if (rb < 0) return final ? this.done(n) : -1;
          let j = rb + 1;
          while (j < n && data.charCodeAt(j) <= 32) j++;
          if (j >= n) return final ? this.done(n) : -1;
          if (data.charCodeAt(j) === GT) return this.done(j + 1);
          i = rb + 1;
        }
      }
      default:
        return this.done(pos);
    }
  }

  private flushCData(): void {
    if (this.handler.text) {
      const s = this.cdata.join('');
      if (s.length) this.handler.text(s);
    }
    this.cdata = [];
  }

  private done(pos: number): number {
    this.mode = Mode.Normal;
    return pos;
  }
}

/** Keep from the last ']' if only whitespace follows it (the '>' may be in the next chunk). */
function keepDoctypeTail(data: string): number {
  const rb = data.lastIndexOf(']');
  if (rb < 0) return data.length;
  for (let j = rb + 1; j < data.length; j++) if (data.charCodeAt(j) > 32) return data.length;
  return rb;
}

/**
 * Scan a UTF-8 byte stream. `onChunk(bytes)` runs after each chunk has been fully processed – the place for
 * progress reporting, batch flushing and cancellation checks (it may return a promise to apply backpressure).
 */
export async function scanXmlStream(
  stream: Readable | AsyncIterable<Buffer>,
  handler: XmlHandler,
  onChunk?: (bytes: number) => void | Promise<void>,
): Promise<void> {
  const scanner = new XmlScanner(handler);
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    scanner.write(decoder.write(chunk));
    if (onChunk) await onChunk(chunk.length);
  }
  const rest = decoder.end();
  if (rest) scanner.write(rest);
  scanner.end();
}

/** Convenience: scan a complete string (tests, small files). */
export function scanXmlString(xml: string, handler: XmlHandler): void {
  const s = new XmlScanner(handler);
  s.write(xml);
  s.end();
}
