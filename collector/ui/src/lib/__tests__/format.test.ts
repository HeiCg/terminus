import { describe, it, expect } from 'vitest';
import {
  fmtBytes,
  fmtMs,
  fmtTime,
  fmtRelative,
  splitUrl,
  statusBucket,
  durationBucket,
} from '../format.js';

describe('fmtBytes', () => {
  it.each<[number | null | undefined, string]>([
    [null, '—'],
    [undefined, '—'],
    [Number.NaN, '—'],
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [2150, '2.1 KB'],
    [1536, '1.5 KB'],
    [1048576, '1.0 MB'],
    [5 * 1048576, '5.0 MB'],
    [1073741824, '1.0 GB'],
  ])('fmtBytes(%s) = %s', (n, out) => {
    expect(fmtBytes(n)).toBe(out);
  });
});

describe('fmtMs', () => {
  it.each<[number | null | undefined, string]>([
    [null, '—'],
    [undefined, '—'],
    [0, '0 ms'],
    [142, '142 ms'],
    [999, '999 ms'],
    [1000, '1.0 s'],
    [1200, '1.2 s'],
    [12500, '12.5 s'],
  ])('fmtMs(%s) = %s', (n, out) => {
    expect(fmtMs(n)).toBe(out);
  });
});

describe('fmtTime', () => {
  it('formats HH:mm:ss.SSS in local time, zero-padded', () => {
    const d = new Date(2021, 5, 15, 9, 5, 3, 7);
    expect(fmtTime(d.getTime())).toBe('09:05:03.007');
  });
  it('handles midday values', () => {
    const d = new Date(2021, 5, 15, 23, 59, 59, 999);
    expect(fmtTime(d.getTime())).toBe('23:59:59.999');
  });
});

describe('fmtRelative', () => {
  const now = 1_000_000_000;
  it.each<[number, string]>([
    [now, '0 s ago'],
    [now - 12_000, '12 s ago'],
    [now - 59_000, '59 s ago'],
    [now - 60_000, '1 min ago'],
    [now - 14 * 60_000, '14 min ago'],
    [now - 2 * 3_600_000, '2 h ago'],
    [now + 5_000, '0 s ago'],
  ])('fmtRelative(%s) = %s', (epoch, out) => {
    expect(fmtRelative(epoch, now)).toBe(out);
  });
});

describe('splitUrl', () => {
  it('splits host and path (path keeps the query)', () => {
    expect(splitUrl('https://api.example.com/v1/users?q=1')).toEqual({
      host: 'api.example.com',
      path: '/v1/users?q=1',
    });
  });
  it('keeps the port in host', () => {
    expect(splitUrl('http://localhost:8080/foo')).toEqual({
      host: 'localhost:8080',
      path: '/foo',
    });
  });
  it('root path is "/"', () => {
    expect(splitUrl('https://x.com')).toEqual({ host: 'x.com', path: '/' });
  });
  it('falls back to raw path for unparsable input', () => {
    expect(splitUrl('/relative/only')).toEqual({ host: '', path: '/relative/only' });
  });
});

describe('statusBucket', () => {
  it.each<[number | null, string | null, ReturnType<typeof statusBucket>]>([
    [100, null, '1xx'],
    [101, null, '1xx'],
    [200, null, '2xx'],
    [204, null, '2xx'],
    [301, null, '3xx'],
    [404, null, '4xx'],
    [500, null, '5xx'],
    [599, null, '5xx'],
    [null, null, 'pending'],
    [200, 'ECONNRESET', 'error'],
    [null, 'boom', 'error'],
  ])('statusBucket(%s, %s) = %s', (status, error, out) => {
    expect(statusBucket(status, error)).toBe(out);
  });
});

describe('durationBucket', () => {
  it.each<[number | null, ReturnType<typeof durationBucket>]>([
    [50, 'fast'],
    [199, 'fast'],
    [200, 'mid'],
    [500, 'mid'],
    [999, 'mid'],
    [1000, 'slow'],
    [5000, 'slow'],
    [null, null],
  ])('durationBucket(%s) = %s', (ms, out) => {
    expect(durationBucket(ms)).toBe(out);
  });
});
