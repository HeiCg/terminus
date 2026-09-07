import { Bonjour } from 'bonjour-service';
import os from 'node:os';
import { log } from './log.js';

// Advertise the TLS ingest over mDNS as `_terminus._tcp` on the WSS port. The
// TXT record carries only non-secret coordinates (v2, tls transport, collectorId,
// atlantisPort) — never the certificate or device token, which are paired out of
// band. The legacy `_Proxyman._tcp` plaintext name is never published.
export function startDiscovery(opts: { ingestPort: number; atlantisPort: number; collectorId: string; host?: string }): { stop(cb?: () => void): void } {
  const b = new Bonjour();
  const host = (opts.host ?? os.hostname()).replace(/\.local$/, '');
  b.publish({
    name: `terminus@${host}`,
    type: 'terminus',
    port: opts.ingestPort,
    txt: { v: '2', transport: 'tls', collectorId: opts.collectorId, atlantisPort: String(opts.atlantisPort) },
  });
  log.info(`advertising _terminus._tcp on ${opts.ingestPort} (tls, collectorId ${opts.collectorId})`);
  return { stop: (cb?: () => void) => b.unpublishAll(() => { b.destroy(); cb?.(); }) };
}
