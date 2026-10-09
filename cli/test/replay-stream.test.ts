import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { createCollectorHarness, type CollectorHarness } from '../../collector/test/fixtures/harness.js';
import { runCli } from './helpers.js';

// U7: `terminus replay-stream <dev> <wsId>` drives POST /api/replay/stream.
let echo: net.Server;
let echoPort = 0;
const received: Buffer[] = [];

beforeAll(async () => {
  echo = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', (d: Buffer) => { received.push(d); s.write(Buffer.concat([Buffer.from('E:'), d])); });
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoPort = (echo.address() as net.AddressInfo).port;
});
afterAll(() => { echo.close(); });

const D = 'proxy:s:127.0.0.1';

describe('terminus replay-stream (U7)', () => {
  let h: CollectorHarness;
  beforeAll(async () => {
    h = await createCollectorHarness();
    h.store.addWsSession({
      wsId: 'w1', deviceId: D, source: 'proxy', url: `tcp://127.0.0.1:${echoPort}`, openedAt: 1, kind: 'tcp', httpEntryKey: null,
      stream: { host: '127.0.0.1', port: echoPort, sni: null, plaintext: true },
    });
    for (const [i, t] of ['one', 'two', 'three'].entries()) {
      h.store.appendWsFrame('w1', { ts: 2 + i, direction: 'out', data: t, size: t.length, binary: false }, Buffer.from(t), D);
    }
    h.store.addWsSession({ wsId: 'tunnel', deviceId: D, source: 'proxy', url: 'tls://pinned.test:443', openedAt: 1, kind: 'tls', httpEntryKey: null,
      stream: { host: 'pinned.test', port: 443, sni: 'pinned.test', plaintext: false } });
  });
  afterAll(async () => { await h.close(); });

  it('replays the selected frames and prints the outcome and the new key', async () => {
    received.length = 0;
    const r = await runCli(['replay-stream', D, 'w1', '--frames', '2,0', '--timeout', '300', '--no-tls'], { harness: h });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/replayed proxy:s:127\.0\.0\.1 w1 -> closed by timeout, sent 8 B, received \d+ B/);
    expect(r.stdout).toMatch(/stored as proxy:s:127\.0\.0\.1 replay-[0-9a-f]+/);
    expect(Buffer.concat(received).toString()).toBe('threeone');
    const rep = h.store.wsSessions(D).find((s) => s.source === 'replay');
    expect(rep).toMatchObject({ kind: 'tcp', stream: { replayOf: { wsId: 'w1' } } });
  });

  it('--json emits the endpoint response', async () => {
    const r = await runCli(['replay-stream', D, 'w1', '--timeout', '200', '--json'], { harness: h });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { key: { wsId: string }; bytesSent: number; closedBy: string };
    expect(j.bytesSent).toBe(11);
    expect(j.closedBy).toBe('timeout');
    expect(j.key.wsId).toMatch(/^replay-/);
  });

  it('reports the 422 for a pass-through tunnel and rejects bad flags', async () => {
    const r = await runCli(['replay-stream', D, 'tunnel'], { harness: h });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/422.*pass-through/);
    expect((await runCli(['replay-stream', D, 'w1', '--tls', '--no-tls'], { harness: h })).stderr).toMatch(/only one of --tls/);
    expect((await runCli(['replay-stream', D, 'w1', '--frames', 'a'], { harness: h })).stderr).toMatch(/invalid --frames/);
    expect((await runCli(['replay-stream', D, 'w1', '--timeout', '40000'], { harness: h })).stderr).toMatch(/--timeout/);
    expect((await runCli(['replay-stream', D], { harness: h })).stderr).toMatch(/usage: terminus replay-stream/);
  });
});
