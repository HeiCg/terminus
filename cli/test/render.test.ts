import { describe, it, expect } from 'vitest';
import { frameLine } from '../src/render.js';
import { makeColors } from '../src/format.js';
import type { WsSummary, FrameSummary } from '../../collector/src/uiProtocol.js';

const colors = makeColors(false); // plain text, easy to assert on

function ws(over: Partial<WsSummary> = {}): WsSummary {
  return {
    wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/ws', openedAt: 1,
    kind: 'websocket', httpEntryKey: null, closedAt: null, closeCode: null, closeReason: '',
    retainedFrames: 0, totalFrames: 0, droppedFrames: 0, partial: false, resumed: false, ...over,
  };
}
const frame: FrameSummary = { sequence: 0, ts: 0, direction: 'in', binary: false,
  body: { state: 'captured', sha256: 'h', size: 5, storedSize: 5, encoding: 'utf8', omitted: null } };

describe('frameLine', () => {
  it('renders the host/path from the session url', () => {
    const line = frameLine({ deviceId: 'd1', frame }, ws({ url: 'wss://example.test/live?x=1' }), colors, 120);
    expect(line).toContain('example.test/live');
  });

  it('renders ws:? (resumed) for a session with a null url', () => {
    const line = frameLine({ deviceId: 'd1', frame }, ws({ url: null, resumed: true }), colors, 120);
    expect(line).toContain('ws:? (resumed)');
  });
});
