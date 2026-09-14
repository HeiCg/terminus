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

import { startDiscovery } from '../src/discovery.js';
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
