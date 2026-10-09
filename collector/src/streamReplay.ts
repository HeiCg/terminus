import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import type { Store } from './store.js';
import type { StreamInfo } from './types.js';
import type { FrameSummary } from './uiProtocol.js';
import { PER_BODY_MAX } from './atlantis/decode.js';
import { normalizeStreamChunk, streamUrl } from './proxy/rawStreams.js';
import { isMetadataAddress, isMetadataName, parseIpLiteral } from './netAddr.js';

// U7 stream replay (POST /api/replay/stream). The collector opens a FRESH TCP
// connection (or TLS, with SNI) from the operator's Mac to the captured stream's
// destination, sends the selected client→server frames in order, records what the
// server sends back until it closes, the timeout fires or the read cap is hit, and
// stores the whole exchange as a NEW stream session (`source: 'replay'`,
// `stream.replayOf` → the original). The original session is never touched.
//
//   - Upstream TLS is verified (`rejectUnauthorized: true`), the same policy as the
//     HTTP replay, whose fetch verifies the upstream certificate.
//   - A TLS pass-through tunnel has no captured plaintext: 422.
//   - STARTTLS is out of scope. A captured stream that switched to TLS mid-stream
//     (a client frame is a TLS handshake record) carries ciphertext from that point
//     on, which cannot be re-sent on a new connection with new keys: 422.
//   - SSRF guard: the destination is resolved first and refused when it is a
//     metadata name (metadata.google.internal) or any address is in the IPv4
//     link-local range 169.254.0.0/16 (the cloud metadata service lives there;
//     the proxy refuses it too) or is the IPv6 metadata address fd00:ec2::254, in
//     any spelling (numeric IPv4 forms, IPv4-mapped, NAT64; see netAddr.ts).
//     The connection then goes to the resolved address, so a second resolution
//     cannot swap it.
//   - What is stored goes through the same frame normalizer as the capture (text
//     redacted, binary verbatim, the per-message cap). What is SENT is the stored
//     bytes of the original frames (already redacted at capture) or the overrides.

export type StreamReplayRequest = {
  deviceId: string; wsId: string;
  tls?: boolean; sni?: string; host?: string; port?: number;
  frames?: 'client' | number[];
  overrides?: { framesBase64?: string[] };
  timeoutMs?: number; readBytes?: number;
};

export type StreamReplayClosedBy = 'server' | 'timeout' | 'cap' | 'error';
export type StreamReplayResult =
  | { ok: true; key: { deviceId: string; wsId: string }; bytesSent: number; bytesReceived: number; durationMs: number; closedBy: StreamReplayClosedBy; error: string | null; stored: boolean }
  | { ok: false; code: 400 | 404 | 413 | 422; message: string };

export const STREAM_REPLAY_TIMEOUT_DEFAULT = 10_000;
export const STREAM_REPLAY_TIMEOUT_MAX = 30_000;
export const STREAM_REPLAY_READ_DEFAULT = 1024 * 1024;
export const STREAM_REPLAY_READ_MAX = 16 * 1024 * 1024;
// One override frame may not exceed the per-body cap (1 MiB), like an HTTP
// replay's override body.
export const STREAM_REPLAY_FRAME_MAX = PER_BODY_MAX;

export type StreamReplayDeps = {
  // DNS resolution (all addresses). Injectable for tests.
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  // Extra TLS options (a test's private CA). Never `rejectUnauthorized: false`
  // from the route: only tests pass this.
  tlsOptions?: tls.ConnectionOptions;
};

type Bad = { ok: false; code: 400 | 404 | 413 | 422; message: string };
const bad = (code: Bad['code'], message: string): Bad => ({ ok: false, code, message });

// Strict base64 (standard alphabet, padded, whitespace tolerated).
function decodeBase64(s: string): Buffer | null {
  const t = s.replace(/\s+/g, '');
  if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  return Buffer.from(t, 'base64');
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function parseRequest(body: unknown): StreamReplayRequest | Bad {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad(400, 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== 'string' || b.deviceId === '') return bad(400, 'deviceId is required');
  if (typeof b.wsId !== 'string' || b.wsId === '') return bad(400, 'wsId is required');
  if (b.tls !== undefined && typeof b.tls !== 'boolean') return bad(400, 'tls must be a boolean');
  if (b.sni !== undefined && (typeof b.sni !== 'string' || b.sni === '')) return bad(400, 'sni must be a non-empty string');
  if (b.host !== undefined && (typeof b.host !== 'string' || b.host === '')) return bad(400, 'host must be a non-empty string');
  if (b.port !== undefined && (!isInt(b.port) || b.port < 1 || b.port > 65535)) return bad(400, 'port must be an integer 1..65535');
  if (b.frames !== undefined && b.frames !== 'client') {
    if (!Array.isArray(b.frames) || !b.frames.every((n) => isInt(n) && n >= 0)) return bad(400, "frames must be 'client' or an array of frame sequences");
  }
  if (b.timeoutMs !== undefined && (!isInt(b.timeoutMs) || b.timeoutMs < 1 || b.timeoutMs > STREAM_REPLAY_TIMEOUT_MAX)) {
    return bad(400, `timeoutMs must be an integer 1..${STREAM_REPLAY_TIMEOUT_MAX}`);
  }
  if (b.readBytes !== undefined && (!isInt(b.readBytes) || b.readBytes < 1 || b.readBytes > STREAM_REPLAY_READ_MAX)) {
    return bad(400, `readBytes must be an integer 1..${STREAM_REPLAY_READ_MAX}`);
  }
  let overrides: StreamReplayRequest['overrides'];
  if (b.overrides !== undefined) {
    if (typeof b.overrides !== 'object' || b.overrides === null) return bad(400, 'overrides must be an object');
    const o = b.overrides as Record<string, unknown>;
    if (o.framesBase64 !== undefined && (!Array.isArray(o.framesBase64) || !o.framesBase64.every((s) => typeof s === 'string'))) {
      return bad(400, 'overrides.framesBase64 must be an array of strings');
    }
    overrides = { framesBase64: o.framesBase64 as string[] | undefined };
  }
  return {
    deviceId: b.deviceId, wsId: b.wsId, tls: b.tls as boolean | undefined, sni: b.sni as string | undefined,
    host: b.host as string | undefined, port: b.port as number | undefined,
    frames: b.frames as StreamReplayRequest['frames'], overrides,
    timeoutMs: b.timeoutMs as number | undefined, readBytes: b.readBytes as number | undefined,
  };
}

// A TLS handshake record header: content type 22, protocol major 3, minor 0..4.
export function looksLikeTlsHandshake(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0x16 && b[1] === 0x03 && b[2] <= 0x04;
}

// The SSRF guard's range: the cloud metadata range of netAddr.ts (IPv4 link-local
// 169.254.0.0/16 and fd00:ec2::254, in any spelling: IPv4-mapped, NAT64, numeric
// IPv4 forms), shared with the proxy's destination guard.
export const isMetadataRange = isMetadataAddress;

async function defaultLookup(host: string): Promise<{ address: string; family: number }[]> {
  return dns.lookup(host, { all: true, verbatim: true });
}

// Dial the addresses in order (a name can resolve to an address nothing listens
// on, e.g. ::1 before 127.0.0.1) until one TCP connection opens or the deadline
// passes. Returns the connected socket, or the last error ('timeout' at the deadline).
async function dialFirst(addresses: string[], port: number, deadline: number): Promise<{ sock: net.Socket } | { error: string }> {
  let last = 'ECONNREFUSED';
  for (const address of addresses) {
    const left = deadline - Date.now();
    if (left <= 0) return { error: 'timeout' };
    const r = await new Promise<{ sock: net.Socket } | { error: string }>((resolve) => {
      const sock = net.connect({ host: address, port });
      const timer = setTimeout(() => { sock.destroy(); resolve({ error: 'timeout' }); }, left);
      sock.once('connect', () => { clearTimeout(timer); sock.removeAllListeners('error'); resolve({ sock }); });
      sock.once('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); sock.destroy(); resolve({ error: e.code ?? e.message }); });
    });
    if ('sock' in r || r.error === 'timeout') return r;
    last = r.error;
  }
  return { error: last };
}

export async function performStreamReplay(store: Store, requestBody: unknown, deps: StreamReplayDeps = {}): Promise<StreamReplayResult> {
  const parsed = parseRequest(requestBody);
  if ('ok' in parsed) return parsed;
  const req = parsed;

  const orig = store.wsSessionFrames(req.deviceId, req.wsId);
  if (!orig) return bad(404, 'session not found');
  const { session } = orig;
  const stream: StreamInfo | undefined = session.stream;
  if ((session.kind !== 'tcp' && session.kind !== 'tls') || !stream) return bad(422, 'not a raw TCP/TLS stream session (WebSocket/SSE sessions cannot be stream-replayed)');
  if (!stream.plaintext) return bad(422, 'this is a TLS pass-through tunnel: its bytes are ciphertext and were never captured, so there is nothing to replay');

  const clientFrames = orig.frames.filter((f) => f.direction === 'out');
  // STARTTLS: once a client frame is a TLS handshake, everything after it is
  // ciphertext bound to that connection's keys.
  for (const f of clientFrames) {
    const b = store.frameBody(req.deviceId, req.wsId, f.sequence);
    if (b?.bytes && looksLikeTlsHandshake(b.bytes)) {
      return bad(422, `the captured stream switched to TLS mid-stream (STARTTLS-like, at frame ${f.sequence}): its later frames are ciphertext, which cannot be replayed on a new connection`);
    }
  }

  // Selection: every retained client frame in order (default), or the sequences
  // given, each of which must be a retained client→server frame.
  let selected: FrameSummary[];
  if (req.frames === undefined || req.frames === 'client') {
    if (orig.droppedFrames > 0) return bad(422, `${orig.droppedFrames} frame(s) of this session were evicted by retention, so its client frames are incomplete; pass frames explicitly`);
    selected = clientFrames;
  } else {
    const bySeq = new Map(clientFrames.map((f) => [f.sequence, f]));
    selected = [];
    for (const n of req.frames) {
      const f = bySeq.get(n);
      if (!f) return bad(400, `frame ${n} is not a retained client-to-server frame of this session`);
      selected.push(f);
    }
  }

  const overrides = req.overrides?.framesBase64;
  if (overrides !== undefined && overrides.length !== selected.length) {
    return bad(400, `overrides.framesBase64 has ${overrides.length} item(s) but ${selected.length} frame(s) are selected; pass one per selected frame`);
  }
  const payloads: Buffer[] = [];
  for (let i = 0; i < selected.length; i++) {
    const f = selected[i];
    if (overrides !== undefined) {
      const d = decodeBase64(overrides[i]);
      if (d == null) return bad(400, `overrides.framesBase64[${i}] must be standard base64`);
      if (d.length > STREAM_REPLAY_FRAME_MAX) return bad(413, `overrides.framesBase64[${i}] is ${d.length} bytes, over the ${STREAM_REPLAY_FRAME_MAX}-byte per-frame cap`);
      payloads.push(d);
      continue;
    }
    const b = store.frameBody(req.deviceId, req.wsId, f.sequence);
    if (!b || b.state !== 'captured' || !b.bytes) {
      return bad(422, `frame ${f.sequence} payload was not retained (${b?.omitted ?? 'not-captured'}); provide overrides.framesBase64`);
    }
    payloads.push(Buffer.from(b.bytes));
  }

  const host = req.host ?? stream.host;
  const port = req.port ?? stream.port;
  const useTls = req.tls ?? session.kind === 'tls';
  const sni = req.sni ?? stream.sni ?? (parseIpLiteral(host) ? undefined : host);
  const timeoutMs = req.timeoutMs ?? STREAM_REPLAY_TIMEOUT_DEFAULT;
  const readCap = req.readBytes ?? STREAM_REPLAY_READ_DEFAULT;

  // Resolve, then refuse the metadata range before anything is dialled. Every
  // resolved address is checked; they are then dialled in order.
  let addresses: string[] = [];
  let dnsError: string | null = null;
  const literal = parseIpLiteral(host);
  const refused = bad(422, `destination ${host} is in (or resolves to) the link-local / cloud metadata range; refused`);
  if (isMetadataName(host)) return refused;
  if (literal) addresses = [literal.address];
  else {
    try {
      addresses = (await (deps.lookup ?? defaultLookup)(host)).map((a) => a.address);
      if (addresses.length === 0) dnsError = 'ENOTFOUND';
    } catch (e) {
      dnsError = (e as NodeJS.ErrnoException).code ?? 'ENOTFOUND';
    }
  }
  if (addresses.some(isMetadataRange)) return refused;

  // The new session: same device, a fresh id, `replayOf` → the original.
  const kind = useTls ? 'tls' : 'tcp';
  const newId = `replay-${randomBytes(8).toString('hex')}`;
  const generation = `replay:${newId}`;
  const startedAt = Date.now();
  const outcome = store.addWsSession({
    wsId: newId, deviceId: req.deviceId, source: 'replay', url: streamUrl(kind, host, port), openedAt: startedAt,
    kind, httpEntryKey: null, generation, via: 'open',
    stream: { host, port, sni: useTls ? sni ?? null : null, plaintext: true, replayOf: { wsId: req.wsId } },
  });
  const stored = outcome !== 'dropped' && outcome !== 'overload';
  const record = (chunk: Uint8Array, direction: 'sent' | 'received'): void => {
    if (!stored) return;
    const { frame, bytes } = normalizeStreamChunk(chunk, direction, Date.now());
    store.appendWsFrame(newId, frame, bytes, req.deviceId, 'replay');
  };

  let bytesSent = 0;
  let bytesReceived = 0;
  let closedBy: StreamReplayClosedBy = 'error';
  let error: string | null = dnsError ? `dns ${dnsError}` : null;

  const deadline = startedAt + timeoutMs;
  const tcp = addresses.length ? await dialFirst(addresses, port, deadline) : null;
  if (tcp && 'error' in tcp) { closedBy = tcp.error === 'timeout' ? 'timeout' : 'error'; error = tcp.error === 'timeout' ? null : tcp.error; }
  else if (tcp) {
    await new Promise<void>((resolve) => {
      let done = false;
      const sock: net.Socket = useTls
        ? tls.connect({ socket: tcp.sock, servername: sni, rejectUnauthorized: true, ...deps.tlsOptions })
        : tcp.sock;
      const finish = (by: StreamReplayClosedBy, err: string | null = null): void => {
        if (done) return;
        done = true; closedBy = by; if (err) error = err;
        clearTimeout(timer);
        sock.destroy(); tcp.sock.destroy();
        resolve();
      };
      const timer = setTimeout(() => finish('timeout'), Math.max(0, deadline - Date.now()));
      sock.on('error', (e: NodeJS.ErrnoException) => finish('error', e.code ?? e.message));
      sock.on('close', () => finish('server'));
      sock.on('data', (d: Buffer) => {
        if (done) return;
        const room = readCap - bytesReceived;
        const chunk = d.length > room ? d.subarray(0, room) : d;
        bytesReceived += chunk.length;
        if (chunk.length) record(chunk, 'sent');
        if (bytesReceived >= readCap) finish('cap');
      });
      const send = async (): Promise<void> => {
        for (const p of payloads) {
          if (done) return;
          record(p, 'received');
          const okWrite = await new Promise<boolean>((r) => sock.write(p, (err) => r(!err)));
          if (!okWrite) return;
          bytesSent += p.length;
        }
      };
      if (useTls) sock.once('secureConnect', () => { void send(); });
      else void send();
    });
  }

  const durationMs = Date.now() - startedAt;
  // Re-read through a cast: TS narrows the `let` to its pre-callback assignments.
  const by = closedBy as StreamReplayClosedBy;
  if (stored) store.closeWs(newId, Date.now(), null, by === 'error' ? `error ${error ?? 'unknown'}` : by === 'server' ? 'closed' : by, req.deviceId);
  store.closeWsGeneration(generation);
  return { ok: true, key: { deviceId: req.deviceId, wsId: newId }, bytesSent, bytesReceived, durationMs, closedBy: by, error, stored };
}
