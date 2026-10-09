import { HexBuffer } from './HexBuffer.svelte.js';
import type { BodyState } from '../bodyState.js';
import { base64ToBytes, bytesEqual, bytesToBase64, utf8DecodeStrict, utf8Encode } from '../bytes.js';

// The replay editor's state (U4): a draft of the captured request the operator
// edits before re-sending it through POST /api/replay. Prefilled from the
// captured method, URL, headers and request body; `request()` sends ONLY what
// changed as `overrides`, so an untouched draft is exactly today's one-click
// replay. The body is UTF-8 text (`body`) or, once edited as bytes in the hex
// grid, raw bytes (`bodyBase64`). Credentials are stripped unless opted into, and
// that opt-in needs a confirming second Send (the same contract as ReplayButton).

// The captured request body as the editor sees it.
export type CapturedBody =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string };

// Map one loaded body side (BodyState + the cached raw string) to a CapturedBody.
// Binary bodies are cached as base64 (the BodyCache contract).
export function capturedBodyOf(state: BodyState, raw: string | undefined): CapturedBody {
  switch (state.kind) {
    case 'absent': return { kind: 'none' };
    case 'omitted': return { kind: 'unavailable', reason: state.reason };
    case 'ok': {
      if (raw == null) return { kind: 'unavailable', reason: 'not loaded' };
      if (state.encoding !== 'binary') return { kind: 'text', text: raw };
      const bytes = base64ToBytes(raw);
      return bytes ? { kind: 'bytes', bytes } : { kind: 'unavailable', reason: 'undecodable' };
    }
    case 'gone': return { kind: 'unavailable', reason: 'gone' };
    case 'error': return { kind: 'unavailable', reason: 'load failed' };
    default: return { kind: 'unavailable', reason: 'not loaded' };
  }
}

export type ReplayOverrides = { method?: string; url?: string; headers?: Record<string, string>; body?: string; bodyBase64?: string };
export type ReplayPayload = { deviceId: string; id: string; credentials: 'strip' | 'keep'; overrides?: ReplayOverrides };
export type HeaderRow = { key: number; name: string; value: string };
export type ReplayKey = { deviceId: string; id: string };

type Original = { method: string; url: string; headers: Record<string, string>; body: CapturedBody };

const originalBytes = (b: CapturedBody): Uint8Array =>
  b.kind === 'text' ? utf8Encode(b.text) : b.kind === 'bytes' ? b.bytes : new Uint8Array(0);

export class ReplayDraft {
  readonly deviceId: string;
  readonly id: string;
  readonly original: Original;

  method = $state('');
  url = $state('');
  headers = $state<HeaderRow[]>([]);
  bodyMode = $state<'text' | 'hex'>('text');
  text = $state('');
  readonly hex: HexBuffer;
  modeError = $state<string | null>(null);

  withCreds = $state(false);
  armed = $state(false);
  phase = $state<'idle' | 'sending' | 'done' | 'error'>('idle');
  message = $state('');
  stripped = $state<string[]>([]);

  #nextKey = 0;

  constructor(deviceId: string, id: string, original: Original) {
    this.deviceId = deviceId;
    this.id = id;
    this.original = original;
    this.method = original.method;
    this.url = original.url;
    this.headers = Object.entries(original.headers).map(([name, value]) => ({ key: this.#nextKey++, name, value }));
    const b = original.body;
    this.text = b.kind === 'text' ? b.text : '';
    this.hex = new HexBuffer(b.kind === 'bytes' ? b.bytes : originalBytes(b));
    this.bodyMode = b.kind === 'bytes' ? 'hex' : 'text';
  }

  // The body's current byte length (the counter under the editor).
  byteCount = $derived.by((): number => (this.bodyMode === 'hex' ? this.hex.bytes.length : utf8Encode(this.text).length));

  addHeader(): void {
    this.headers.push({ key: this.#nextKey++, name: '', value: '' });
  }

  removeHeader(key: number): void {
    this.headers = this.headers.filter((h) => h.key !== key);
  }

  // Switch the body editor. Text→hex always works (the text's UTF-8 bytes);
  // hex→text only when the bytes are valid UTF-8, else `modeError` says why.
  setBodyMode(mode: 'text' | 'hex'): boolean {
    this.modeError = null;
    if (mode === this.bodyMode) return true;
    if (mode === 'hex') {
      this.hex.replaceAll(utf8Encode(this.text));
    } else {
      const text = utf8DecodeStrict(this.hex.bytes);
      if (text == null) { this.modeError = 'These bytes are not valid UTF-8 text; keep editing them as hex.'; return false; }
      this.text = text;
    }
    this.bodyMode = mode;
    return true;
  }

  setWithCreds(on: boolean): void {
    this.withCreds = on;
    this.armed = false; // the intent changed: a pending confirmation no longer applies
  }

  // The current header rows as a map (blank names dropped, a later duplicate wins).
  #headerMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of this.headers) {
      const name = h.name.trim();
      if (name) out[name] = h.value;
    }
    return out;
  }

  #headersChanged(map: Record<string, string>): boolean {
    const a = Object.entries(map);
    const b = Object.entries(this.original.headers);
    return a.length !== b.length || a.some(([k, v], i) => b[i][0] !== k || b[i][1] !== v);
  }

  #bodyChanged(): boolean {
    const now = this.bodyMode === 'hex' ? this.hex.bytes : utf8Encode(this.text);
    const b = this.original.body;
    // Nothing was retained: any content is a change; an empty body is not.
    if (b.kind === 'unavailable') return now.length > 0;
    return !bytesEqual(now, originalBytes(b));
  }

  // The POST /api/replay body: only the fields that differ from the capture.
  request(): ReplayPayload {
    const overrides: ReplayOverrides = {};
    const method = this.method.trim();
    if (method && method.toUpperCase() !== this.original.method.toUpperCase()) overrides.method = method;
    const url = this.url.trim();
    if (url && url !== this.original.url) overrides.url = url;
    const headers = this.#headerMap();
    if (this.#headersChanged(headers)) overrides.headers = headers;
    if (this.#bodyChanged()) {
      if (this.bodyMode === 'hex') overrides.bodyBase64 = bytesToBase64(this.hex.bytes);
      else overrides.body = this.text;
    }
    const payload: ReplayPayload = { deviceId: this.deviceId, id: this.id, credentials: this.withCreds ? 'keep' : 'strip' };
    if (Object.keys(overrides).length) payload.overrides = overrides;
    return payload;
  }

  // Send the draft. A credentialed send needs a confirming second call (the first
  // only arms it). Resolves to the new entry's key on success, else null.
  async send(doFetch: typeof fetch = fetch): Promise<ReplayKey | null> {
    if (this.phase === 'sending') return null;
    if (this.withCreds && !this.armed) { this.armed = true; return null; }
    this.armed = false;
    this.phase = 'sending';
    this.message = '';
    this.stripped = [];
    try {
      const r = await doFetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(this.request()),
      });
      if (r.ok) {
        const body = (await r.json()) as { key: ReplayKey; status: number | null; error: string | null; stripped?: string[] };
        this.phase = 'done';
        this.message = body.error ? body.error : `sent · ${body.status ?? '—'}`;
        this.stripped = body.stripped ?? [];
        return body.key ?? null;
      }
      this.phase = 'error';
      const text = (await r.text().catch(() => '')).trim();
      let msg = text;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
      this.message = (msg || String(r.status)).slice(0, 200);
    } catch {
      this.phase = 'error';
      this.message = 'request failed';
    }
    return null;
  }
}
