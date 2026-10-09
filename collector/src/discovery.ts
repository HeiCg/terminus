import { Bonjour } from 'bonjour-service';
import type { EventEmitter } from 'node:events';
import os from 'node:os';
import { log } from './log.js';

// The slice of bonjour-service the collector uses, so tests can inject a fake.
type BonjourLike = {
  publish(svc: { name: string; type: string; port: number; txt: Record<string, string> }): unknown;
  unpublishAll(cb?: () => void): void;
  destroy(cb?: () => void): void;
};

export type DiscoveryDeps = {
  // Build the responder; `onError` must receive every asynchronous mDNS failure.
  createBonjour?: (onError: (e: unknown) => void) => BonjourLike;
};

// bonjour-service's own error callback only covers failed responses; a socket that
// cannot bind (EADDRINUSE/EACCES on 5353) is emitted as 'error' on the underlying
// multicast-dns emitter, which nothing listens to, so it would surface as an
// uncaughtException. The emitter is not public API, hence the guarded lookup.
function defaultCreateBonjour(onError: (e: unknown) => void): BonjourLike {
  const b = new Bonjour({}, onError);
  const mdns = (b as unknown as { server?: { mdns?: EventEmitter } }).server?.mdns;
  mdns?.on?.('error', onError);
  return b;
}

// DNS-SD instance names may be any UTF-8 up to 63 bytes, but bonjour-service joins
// `<name>.<type>.local` without escaping, so a dot (an FQDN hostname) or a control
// character breaks the record. Keep [A-Za-z0-9-], fold the rest into single dashes,
// and cap the label so `terminus@<host>` stays within 63 bytes.
const INSTANCE_PREFIX = 'terminus@';
export function instanceHost(raw: string): string {
  const h = raw
    .replace(/\.local\.?$/i, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 63 - INSTANCE_PREFIX.length)
    .replace(/^-+|-+$/g, '');
  return h || 'collector';
}

// Advertise the TLS ingest over mDNS as `_terminus._tcp` on the WSS port. The
// TXT record carries only non-secret coordinates (v2, tls transport, collectorId,
// atlantisPort) — never the certificate or device token, which are paired out of
// band. The legacy `_Proxyman._tcp` plaintext name is never published.
//
// Discovery is best effort: a failure to bind or advertise (no multicast on a CI
// runner, an Avahi conflict) logs one warning and the collector carries on;
// pairing never depends on it.
export function startDiscovery(
  opts: { ingestPort: number; atlantisPort: number; collectorId: string; host?: string },
  deps: DiscoveryDeps = {},
): { stop(cb?: () => void): void } {
  let failed = false;
  const fail = (e: unknown): void => {
    if (failed) return;
    failed = true;
    const why = e instanceof Error ? e.message : String(e);
    log.warn(`mDNS discovery unavailable (${why}); continuing without it — pair with the QR or the pairing blob`);
  };

  let b: BonjourLike | null = null;
  try {
    b = (deps.createBonjour ?? defaultCreateBonjour)(fail);
    b.publish({
      name: `${INSTANCE_PREFIX}${instanceHost(opts.host ?? os.hostname())}`,
      type: 'terminus',
      port: opts.ingestPort,
      txt: { v: '2', transport: 'tls', collectorId: opts.collectorId, atlantisPort: String(opts.atlantisPort) },
    });
  } catch (e) {
    fail(e);
    try { b?.destroy(); } catch { /* already broken */ }
    return { stop: (cb?: () => void) => cb?.() };
  }
  log.info(`advertising _terminus._tcp on ${opts.ingestPort} (tls, collectorId ${opts.collectorId})`);

  const responder = b;
  return {
    stop: (cb?: () => void) => {
      // After a socket failure the goodbye packets may never be sent (and their
      // callback never run), so skip them rather than hang shutdown.
      if (failed) {
        try { responder.destroy(); } catch { /* already broken */ }
        cb?.();
        return;
      }
      try {
        responder.unpublishAll(() => { try { responder.destroy(); } catch { /* ignore */ } cb?.(); });
      } catch (e) {
        fail(e);
        cb?.();
      }
    },
  };
}
