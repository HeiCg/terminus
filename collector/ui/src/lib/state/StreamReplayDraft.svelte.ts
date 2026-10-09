import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { HexBuffer } from './HexBuffer.svelte.js';
import type { FrameSummary, WsSummary } from '../protocol.js';
import type { BodyFetch } from '../api.js';
import { base64ToBytes, bytesToBase64, utf8Encode } from '../bytes.js';

// The stream replay editor's state (U7): a draft of POST /api/replay/stream for
// one captured raw TCP/TLS session. It lists the session's client→server frames
// (all selected by default), lets the operator untick frames, edit a frame's bytes
// in the hex grid (an override), and change the connection (TLS on/off, SNI,
// host, port, read timeout). `request()` sends only what differs from the
// capture, so an untouched draft replays every client frame as captured.

type Api = {
  fetchFrames(dev: string, wsId: string, after: number | null, limit: number): Promise<{ items: FrameSummary[]; nextCursor: string | null }>;
  fetchFrameBody(dev: string, wsId: string, seq: number): Promise<BodyFetch>;
};

export type StreamReplayPayload = {
  deviceId: string; wsId: string;
  tls?: boolean; sni?: string; host?: string; port?: number;
  frames?: number[]; overrides?: { framesBase64: string[] }; timeoutMs?: number;
};
export type StreamReplayKey = { deviceId: string; wsId: string };
type StreamReplayResponse = {
  key: StreamReplayKey; bytesSent: number; bytesReceived: number; durationMs: number;
  closedBy: 'server' | 'timeout' | 'cap' | 'error'; error: string | null; stored: boolean;
};

// Frame pages walked to list the client frames (the server retains ~2000 per
// session, 200 per page).
const PAGE = 200;
const MAX_PAGES = 20;
export const STREAM_TIMEOUT_DEFAULT = 10_000;
export const STREAM_TIMEOUT_MAX = 30_000;

export class StreamReplayDraft {
  readonly deviceId: string;
  readonly wsId: string;
  readonly session: WsSummary;
  #api: Api;
  // Original payloads fetched for editing (or for completing the override list).
  #originals = new SvelteMap<number, Uint8Array>();

  tls = $state(false);
  sni = $state('');
  host = $state('');
  port = $state('');
  timeoutMs = $state(String(STREAM_TIMEOUT_DEFAULT));

  frames = $state.raw<FrameSummary[]>([]);
  loadStatus = $state<'loading' | 'done' | 'error'>('loading');
  selected = new SvelteSet<number>();
  edits = new SvelteMap<number, HexBuffer>();
  editing = $state<number | null>(null);
  editError = $state<string | null>(null);

  phase = $state<'idle' | 'sending' | 'done' | 'error'>('idle');
  message = $state('');

  constructor(session: WsSummary, api: Api) {
    this.session = session;
    this.deviceId = session.deviceId;
    this.wsId = session.wsId;
    this.#api = api;
    this.tls = session.kind === 'tls';
    this.sni = session.stream?.sni ?? '';
    this.host = session.stream?.host ?? '';
    this.port = session.stream ? String(session.stream.port) : '';
  }

  // Whether the capture can be replayed at all: a TLS pass-through tunnel has no
  // plaintext (the collector answers 422; the UI does not offer it).
  get replayable(): boolean {
    return (this.session.kind === 'tcp' || this.session.kind === 'tls') && this.session.stream?.plaintext === true;
  }

  selectedFrames = $derived.by((): FrameSummary[] => this.frames.filter((f) => this.selected.has(f.sequence)));

  // List every retained client→server frame, oldest first, and select them all.
  async load(): Promise<void> {
    this.loadStatus = 'loading';
    const out: FrameSummary[] = [];
    let after: number | null = null;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await this.#api.fetchFrames(this.deviceId, this.wsId, after, PAGE);
        out.push(...page.items.filter((f) => f.direction === 'out'));
        if (!page.nextCursor) break;
        after = Number(page.nextCursor);
        if (!Number.isFinite(after)) break;
      }
    } catch {
      this.loadStatus = 'error';
      return;
    }
    this.frames = out;
    this.selected.clear();
    for (const f of out) this.selected.add(f.sequence);
    this.loadStatus = 'done';
  }

  toggle(seq: number): void {
    if (this.selected.has(seq)) this.selected.delete(seq);
    else this.selected.add(seq);
  }

  // The captured bytes of one frame (fetched once), or an error message.
  async #original(f: FrameSummary): Promise<Uint8Array | string> {
    const have = this.#originals.get(f.sequence);
    if (have) return have;
    if (f.body.state === 'absent') return new Uint8Array(0);
    if (f.body.state !== 'captured') return `frame #${f.sequence} was not retained (${f.body.omitted ?? 'not captured'})`;
    let res: BodyFetch;
    try { res = await this.#api.fetchFrameBody(this.deviceId, this.wsId, f.sequence); } catch { res = { kind: 'error' }; }
    if (res.kind !== 'ok') return `frame #${f.sequence} could not be loaded (${res.kind === 'omitted' ? res.reason : res.kind})`;
    const bytes = f.body.encoding === 'binary' ? base64ToBytes(res.text) : utf8Encode(res.text);
    if (!bytes) return `frame #${f.sequence} could not be decoded`;
    this.#originals.set(f.sequence, bytes);
    return bytes;
  }

  // Open the hex editor on a frame. The first edit starts from its captured bytes
  // (an unretained frame starts empty, so it can still be supplied by hand).
  async edit(seq: number): Promise<void> {
    this.editError = null;
    if (!this.edits.has(seq)) {
      const f = this.frames.find((x) => x.sequence === seq);
      if (!f) return;
      const orig = await this.#original(f);
      this.edits.set(seq, new HexBuffer(typeof orig === 'string' ? new Uint8Array(0) : orig));
      if (typeof orig === 'string') this.editError = `${orig}; enter its bytes to send it`;
    }
    this.editing = seq;
  }

  // Drop a frame's override: it is sent as captured again.
  revert(seq: number): void {
    this.edits.delete(seq);
    if (this.editing === seq) this.editing = null;
  }

  // The POST body, or an error message when the draft cannot be sent as is.
  async request(): Promise<StreamReplayPayload | string> {
    const payload: StreamReplayPayload = { deviceId: this.deviceId, wsId: this.wsId };
    const stream = this.session.stream;
    if (this.tls !== (this.session.kind === 'tls')) payload.tls = this.tls;
    const sni = this.sni.trim();
    if (this.tls && sni && sni !== (stream?.sni ?? '')) payload.sni = sni;
    const host = this.host.trim();
    if (host && host !== stream?.host) payload.host = host;
    const portText = this.port.trim();
    if (portText && portText !== String(stream?.port ?? '')) {
      const port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1..65535';
      payload.port = port;
    }
    const timeout = Number(this.timeoutMs.trim());
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > STREAM_TIMEOUT_MAX) return `timeout must be 1..${STREAM_TIMEOUT_MAX} ms`;
    payload.timeoutMs = timeout;

    const chosen = this.selectedFrames;
    if (chosen.length !== this.frames.length) payload.frames = chosen.map((f) => f.sequence);
    if (chosen.some((f) => this.edits.has(f.sequence))) {
      // Overrides travel one per selected frame: the edited bytes, or the captured ones.
      const framesBase64: string[] = [];
      for (const f of chosen) {
        const edited = this.edits.get(f.sequence);
        if (edited) { framesBase64.push(bytesToBase64(edited.bytes)); continue; }
        const orig = await this.#original(f);
        if (typeof orig === 'string') return orig;
        framesBase64.push(bytesToBase64(orig));
      }
      payload.overrides = { framesBase64 };
    }
    return payload;
  }

  // Send the draft. Resolves to the new session's key on success, else null.
  async send(doFetch: typeof fetch = fetch): Promise<StreamReplayKey | null> {
    if (this.phase === 'sending') return null;
    this.phase = 'sending';
    this.message = '';
    const payload = await this.request();
    if (typeof payload === 'string') { this.phase = 'error'; this.message = payload; return null; }
    try {
      const r = await doFetch('/api/replay/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const body = (await r.json()) as StreamReplayResponse;
        this.phase = 'done';
        const how = body.closedBy === 'error' ? `error ${body.error ?? ''}`.trim() : `closed by ${body.closedBy}`;
        this.message = `${how} · sent ${body.bytesSent} B · received ${body.bytesReceived} B${body.stored ? '' : ' · not stored (out of scope)'}`;
        return body.stored ? body.key : null;
      }
      this.phase = 'error';
      const text = (await r.text().catch(() => '')).trim();
      let msg = text;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
      this.message = (msg || String(r.status)).slice(0, 300);
    } catch {
      this.phase = 'error';
      this.message = 'request failed';
    }
    return null;
  }
}
