import { describe, it, expect } from 'vitest';
import { isDeviceMessage } from '../src/types.js';
const fullReq = { type: 'request', id: 'x', ts: 1, method: 'GET', url: 'https://x', headers: {}, body: null, bodySize: 0, source: 'xhr' };
describe('isDeviceMessage', () => {
  it('accepts a well-formed request', () => { expect(isDeviceMessage(fullReq)).toBe(true); });
  it('accepts a well-formed hello', () => {
    expect(isDeviceMessage({ type: 'hello', deviceId: 'd', platform: 'android', appVersion: '1', buildProfile: 'preview', dropped: 0, ts: 1 })).toBe(true);
  });
  it('rejects unknown', () => { expect(isDeviceMessage({ type: 'nope' })).toBe(false); expect(isDeviceMessage(null)).toBe(false); });
  it('rejects a request missing required fields (B4)', () => {
    expect(isDeviceMessage({ type: 'request' })).toBe(false);
    expect(isDeviceMessage({ ...fullReq, ts: undefined })).toBe(false);
    expect(isDeviceMessage({ ...fullReq, url: 123 })).toBe(false);
  });
  it('rejects a response missing status/ts (B4)', () => {
    expect(isDeviceMessage({ type: 'response', id: 'x' })).toBe(false);
  });
  it('rejects a ws_frame missing wsId/direction (B4)', () => {
    expect(isDeviceMessage({ type: 'ws_frame', wsId: 'w1' })).toBe(false);
  });
});
