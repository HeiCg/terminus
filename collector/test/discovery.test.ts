import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock bonjour-service so the test never touches the real network / mDNS responder.
const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  unpublishAll: vi.fn((cb?: () => void) => cb?.()),
  destroy: vi.fn(),
}));
vi.mock('bonjour-service', () => ({
  Bonjour: vi.fn(() => ({ publish: mocks.publish, unpublishAll: mocks.unpublishAll, destroy: mocks.destroy })),
}));

import { startDiscovery, instanceHost } from '../src/discovery.js';
import { log } from '../src/log.js';

describe('startDiscovery mDNS advertisement (T5.7)', () => {
  beforeEach(() => {
    mocks.publish.mockClear();
    mocks.unpublishAll.mockClear();
    mocks.destroy.mockClear();
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  it('publishes _terminus._tcp on the ingest port with the ports and id in TXT', () => {
    const h = startDiscovery({ ingestPort: 8788, atlantisPort: 10909, collectorId: 'cid-1', host: 'mymac' });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const svc = mocks.publish.mock.calls[0][0];
    expect(svc.type).toBe('terminus');
    expect(svc.port).toBe(8788);
    expect(svc.name).toContain('mymac');
    expect(svc.txt).toMatchObject({ v: '2', transport: 'tls', collectorId: 'cid-1', atlantisPort: '10909' });
    h.stop();
  });

  it('strips a trailing .local from the advertised host', () => {
    startDiscovery({ ingestPort: 1, atlantisPort: 2, collectorId: 'c', host: 'mymac.local' });
    expect(mocks.publish.mock.calls[0][0].name).toBe('terminus@mymac');
  });

  it('unpublishes and destroys on stop, invoking the callback', () => {
    const h = startDiscovery({ ingestPort: 1, atlantisPort: 2, collectorId: 'c', host: 'x' });
    const cb = vi.fn();
    h.stop(cb);
    expect(mocks.unpublishAll).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// mDNS is best effort: no multicast on a CI runner, an Avahi/mDNSResponder conflict
// on 5353, or a broken interface must log ONE warning and never crash the collector.
describe('startDiscovery failure is non-fatal', () => {
  beforeEach(() => { vi.spyOn(log, 'info').mockImplementation(() => {}); });

  it('a bonjour constructor that throws: one warning, a no-op stop that still calls back', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const createBonjour = () => { throw Object.assign(new Error('bind EADDRINUSE 0.0.0.0:5353'), { code: 'EADDRINUSE' }); };
    const h = startDiscovery({ ingestPort: 1, atlantisPort: 2, collectorId: 'c', host: 'x' }, { createBonjour });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EADDRINUSE');
    const cb = vi.fn();
    h.stop(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('publish that throws: one warning, the instance is destroyed', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const destroy = vi.fn();
    const createBonjour = () => ({ publish: () => { throw new Error('no multicast'); }, unpublishAll: vi.fn(), destroy });
    const h = startDiscovery({ ingestPort: 1, atlantisPort: 2, collectorId: 'c', host: 'x' }, { createBonjour });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    const cb = vi.fn();
    h.stop(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a later async socket error warns once (however many fire) and stop skips the goodbye', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let onError: ((e: unknown) => void) | undefined;
    const unpublishAll = vi.fn();
    const destroy = vi.fn();
    const createBonjour = (cb: (e: unknown) => void) => { onError = cb; return { publish: vi.fn(), unpublishAll, destroy }; };
    const h = startDiscovery({ ingestPort: 1, atlantisPort: 2, collectorId: 'c', host: 'x' }, { createBonjour });
    expect(warn).not.toHaveBeenCalled();
    onError!(new Error('send EHOSTUNREACH'));
    onError!(new Error('send EHOSTUNREACH'));
    expect(warn).toHaveBeenCalledTimes(1);
    const cb = vi.fn();
    h.stop(cb);
    expect(unpublishAll).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('DNS-SD instance name', () => {
  beforeEach(() => { mocks.publish.mockClear(); vi.spyOn(log, 'info').mockImplementation(() => {}); });

  it('keeps a plain hostname as is', () => {
    expect(instanceHost('mymac')).toBe('mymac');
    expect(instanceHost('build-box-01')).toBe('build-box-01');
  });

  it('sanitizes dots, spaces, underscores and other invalid characters', () => {
    expect(instanceHost('box.corp.example.com')).toBe('box-corp-example-com');
    expect(instanceHost("Jane's MacBook Pro.local")).toBe('Jane-s-MacBook-Pro');
    expect(instanceHost('host_name\u0007')).toBe('host-name');
    expect(instanceHost('...')).toBe('collector');
  });

  it('caps the instance name at 63 bytes', () => {
    const name = `terminus@${instanceHost('a'.repeat(200))}`;
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  });

  it('publishes the sanitized name', () => {
    startDiscovery({ ingestPort: 1, atlantisPort: 2, collectorId: 'c', host: 'ci runner.internal' });
    expect(mocks.publish.mock.calls[0][0].name).toBe('terminus@ci-runner-internal');
  });
});
