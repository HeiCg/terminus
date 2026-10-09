import { describe, it, expect, vi } from 'vitest';

// 0.3.0 review: the pre-dial gate for TLS tunnels and raw streams lives in a
// wrapper around mockttp's passthroughSocket. A mockttp without that method must
// make the proxy refuse to start, never relay ungated.
vi.mock('mockttp', async (importOriginal) => {
  const m = await importOriginal<typeof import('mockttp')>();
  return {
    ...m,
    getLocal: (o: Parameters<typeof m.getLocal>[0]) => {
      const s = m.getLocal(o);
      (s as unknown as { passthroughSocket?: unknown }).passthroughSocket = undefined;
      return s;
    },
  };
});

const { generateCACertificate } = await import('mockttp');
const { Store } = await import('../src/store.js');
const { createProxySource } = await import('../src/proxy/server.js');

describe('proxy pre-dial gate', () => {
  it('refuses to start when the gate cannot be installed (raw streams on or off)', async () => {
    const ca = await generateCACertificate();
    for (const rawStreams of [false, true]) {
      const proxy = createProxySource({ port: 0, ca, store: new Store(), deviceAllowlist: ['127.0.0.1'], excludedCollectorEndpoints: [], rawStreams });
      await expect(proxy.start()).rejects.toThrow(/refusing to start/);
    }
  }, 30_000);
});
