import { describe, it, expect } from 'vitest';
import { FrameAccumulator, MAX_FRAME } from '../src/atlantis/frames.js';
const frame = (p: Buffer) => { const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(p.length)); return Buffer.concat([h, p]); };
describe('FrameAccumulator', () => {
  it('returns payload when complete in one chunk', () => {
    const a = new FrameAccumulator(); expect(a.push(frame(Buffer.from('abc')))).toEqual([Buffer.from('abc')]);
  });
  it('reassembles across split chunks, including split header', () => {
    const a = new FrameAccumulator(); const f = frame(Buffer.from('hello'));
    expect(a.push(f.subarray(0, 3))).toEqual([]); expect(a.push(f.subarray(3, 10))).toEqual([]);
    expect(a.push(f.subarray(10))).toEqual([Buffer.from('hello')]);
  });
  it('returns multiple frames from one chunk', () => {
    const a = new FrameAccumulator();
    expect(a.push(Buffer.concat([frame(Buffer.from('a')), frame(Buffer.from('bb'))]))).toEqual([Buffer.from('a'), Buffer.from('bb')]);
  });
  it('reassembles a large frame fed one byte at a time (I8)', () => {
    const a = new FrameAccumulator();
    const payload = Buffer.from('x'.repeat(5000));
    const f = frame(payload);
    let out: Buffer[] = [];
    for (let i = 0; i < f.length; i++) out = out.concat(a.push(f.subarray(i, i + 1)));
    expect(out).toHaveLength(1);
    expect(out[0].equals(payload)).toBe(true);
  });
  it('throws on oversized length', () => {
    const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(MAX_FRAME + 1));
    expect(() => new FrameAccumulator().push(h)).toThrow(/too large/);
  });
});
