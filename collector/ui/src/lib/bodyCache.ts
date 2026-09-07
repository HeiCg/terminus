// O07 — browser body cache. Fetched body text and its formatted representations
// live here, keyed by the BodyRef's sha256 so a new ref with the SAME hash never
// re-parses, and bounded by an 8 MiB LRU budget that counts the raw text AND
// every cached representation. Formatting is capped at 1 MiB of output and depth
// 32; over either, the raw text is shown with a warning (never an unbounded
// expanded string built first). Eviction and clear free all representations.

import { utf8Bytes } from './format.js';

export const BODY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const PRETTY_MAX_OUTPUT = 1 * 1024 * 1024;
export const PRETTY_MAX_DEPTH = 32;

export type FormatMode = 'raw' | 'json';
export type Formatted = { text: string; warning: 'invalid' | 'too-large' | null };

type Node = { raw: string; formatted: Map<FormatMode, Formatted>; bytes: number; lower?: string; lowerTooBig?: boolean };

// Pretty-print a parsed value with a running budget, stopping (returning null) the
// moment output would exceed `maxChars` or nesting exceeds `maxDepth`, so a
// pathological value never materializes a huge intermediate string.
function boundedPretty(value: unknown, maxChars: number, maxDepth: number): string | null {
  const out: string[] = [];
  let len = 0;
  let ok = true;
  const push = (s: string) => { if (!ok) return; len += s.length; if (len > maxChars) { ok = false; return; } out.push(s); };
  const pad = (d: number) => '  '.repeat(d);
  const ser = (v: unknown, depth: number): void => {
    if (!ok) return;
    if (depth > maxDepth) { ok = false; return; }
    if (v === null) { push('null'); return; }
    const t = typeof v;
    if (t === 'number' || t === 'boolean') { push(String(v)); return; }
    if (t === 'string') { push(JSON.stringify(v)); return; }
    if (Array.isArray(v)) {
      if (v.length === 0) { push('[]'); return; }
      push('[\n');
      for (let i = 0; i < v.length && ok; i++) { push(pad(depth + 1)); ser(v[i], depth + 1); if (i < v.length - 1) push(','); push('\n'); }
      push(pad(depth) + ']');
      return;
    }
    if (t === 'object') {
      const keys = Object.keys(v as object);
      if (keys.length === 0) { push('{}'); return; }
      push('{\n');
      for (let i = 0; i < keys.length && ok; i++) {
        push(pad(depth + 1) + JSON.stringify(keys[i]) + ': ');
        ser((v as Record<string, unknown>)[keys[i]], depth + 1);
        if (i < keys.length - 1) push(',');
        push('\n');
      }
      push(pad(depth) + '}');
      return;
    }
    push('null'); // undefined / function
  };
  ser(value, 0);
  return ok ? out.join('') : null;
}

export class BodyCache {
  private nodes = new Map<string, Node>(); // insertion order == LRU order
  private bytes = 0;
  private readonly max: number;

  constructor(maxBytes = BODY_CACHE_MAX_BYTES) { this.max = maxBytes; }

  get retainedBytes(): number { return this.bytes; }
  has(hash: string): boolean { return this.nodes.has(hash); }

  // Mark a node most-recently-used.
  private touch(hash: string, node: Node): void { this.nodes.delete(hash); this.nodes.set(hash, node); }

  private evict(): void {
    while (this.bytes > this.max && this.nodes.size > 0) {
      const oldest = this.nodes.keys().next().value as string;
      const node = this.nodes.get(oldest)!;
      this.bytes -= node.bytes;
      this.nodes.delete(oldest);
    }
  }

  // Store (or refresh) the raw body text for a hash. A single body over the whole
  // budget still stores (then immediately evicts everything else); it is the
  // caller's ref that decides what to fetch, not this cache.
  putRaw(hash: string, text: string): void {
    const existing = this.nodes.get(hash);
    if (existing) { this.touch(hash, existing); return; } // same hash: bytes unchanged, no re-store
    const node: Node = { raw: text, formatted: new Map(), bytes: utf8Bytes(text) };
    this.nodes.set(hash, node);
    this.bytes += node.bytes;
    this.evict();
  }

  getRaw(hash: string): string | undefined { const n = this.nodes.get(hash); if (n) this.touch(hash, n); return n?.raw; }

  // Read the raw text WITHOUT marking the node most-recently-used. For render-time
  // reads (e.g. a $derived that must stay pure): touching here would reorder the
  // LRU on every recompute and let eviction depend on how often a derived ran.
  peek(hash: string): string | undefined { return this.nodes.get(hash)?.raw; }

  // Lowercased raw text for a hash. Like peek() it is NON-touching — it never
  // reorders the LRU — so it is safe inside a $derived (the command palette's
  // case-insensitive body scan). It also never calls evict(): eviction from render
  // could drop the very node being read.
  //
  // Deterministic budget rule: a body's lowercased copy is memoized (and counted
  // toward the budget, freed with the node) only when it is at most 1/8 of the
  // cache budget. A larger copy would dominate the cache, so it is decided ONCE —
  // the node is flagged `lowerTooBig` and every later call returns undefined
  // without re-lowercasing — and the palette falls back to url/header matching for
  // that row. This bounds the extra resident bytes a scanned body can pin (no more
  // the old ~2× a single huge body could reach) and never re-lowercases per call.
  peekLower(hash: string): string | undefined {
    const n = this.nodes.get(hash);
    if (!n) return undefined;
    if (n.lower !== undefined) return n.lower;
    if (n.lowerTooBig) return undefined; // decided once — never re-lowercase it
    const lower = n.raw.toLowerCase();
    if (lower.length <= this.max / 8) {
      n.lower = lower;
      n.bytes += lower.length;
      this.bytes += lower.length;
      return lower;
    }
    n.lowerTooBig = true;
    return undefined;
  }

  // Format the cached body for a hash. `json` pretty-prints (cached by hash+mode
  // so a later ref with the same hash reuses it); invalid JSON or over-limit
  // output falls back to the raw text with a warning. Returns null when nothing
  // is cached for the hash yet (the caller should `putRaw` first).
  format(hash: string, mode: FormatMode): Formatted | null {
    const node = this.nodes.get(hash);
    if (!node) return null;
    this.touch(hash, node);
    if (mode === 'raw') return { text: node.raw, warning: null };
    const cached = node.formatted.get(mode);
    if (cached) return cached;
    let result: Formatted;
    try {
      const parsed = JSON.parse(node.raw);
      const pretty = boundedPretty(parsed, PRETTY_MAX_OUTPUT, PRETTY_MAX_DEPTH);
      result = pretty === null ? { text: node.raw, warning: 'too-large' } : { text: pretty, warning: null };
    } catch {
      result = { text: node.raw, warning: 'invalid' }; // not JSON: keep raw
    }
    node.formatted.set(mode, result);
    const add = result.text === node.raw ? 0 : utf8Bytes(result.text); // raw fallback shares the stored string
    this.bytes += add;
    node.bytes += add;
    this.evict();
    return result;
  }

  delete(hash: string): void {
    const n = this.nodes.get(hash);
    if (!n) return;
    this.bytes -= n.bytes;
    this.nodes.delete(hash);
  }

  clear(): void { this.nodes.clear(); this.bytes = 0; }
}
