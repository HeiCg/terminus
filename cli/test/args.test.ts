import { describe, it, expect } from 'vitest';
import { parseArgs, flagString, flagBool } from '../src/args.js';

describe('parseArgs', () => {
  it('reads the subcommand as the first positional', () => {
    const a = parseArgs(['status']);
    expect(a.command).toBe('status');
    expect(a.positionals).toEqual([]);
  });

  it('parses --flag=value', () => {
    const a = parseArgs(['ls', '--limit=25']);
    expect(a.command).toBe('ls');
    expect(a.flags.limit).toBe('25');
  });

  it('parses --flag value only for declared value flags', () => {
    const a = parseArgs(['tail', '--last', '50', '--json'], { valueFlags: ['last'] });
    expect(a.flags.last).toBe('50');
    expect(a.flags.json).toBe(true);
    expect(a.positionals).toEqual([]);
  });

  it('treats an undeclared flag as boolean and leaves its neighbour a positional', () => {
    const a = parseArgs(['show', '--errors', 'd1/r1']);
    expect(a.flags.errors).toBe(true);
    expect(a.positionals).toEqual(['d1/r1']);
  });

  it('does not consume a following flag as a value', () => {
    const a = parseArgs(['ls', '--device', '--json'], { valueFlags: ['device'] });
    expect(a.flags.device).toBe(true); // no value available, stays boolean
    expect(a.flags.json).toBe(true);
  });

  it('reads a negative number as a value, not a flag', () => {
    const a = parseArgs(['tail', '--last', '-1'], { valueFlags: ['last'] });
    expect(a.flags.last).toBe('-1');
    expect(a.positionals).toEqual([]);
  });

  it('handles a short value flag (-o file) and -h', () => {
    const a = parseArgs(['export', '-o', 'out.har', '-h'], { valueFlags: ['o'] });
    expect(a.flags.o).toBe('out.har');
    expect(a.help).toBe(true);
  });

  it('keeps flags found before the command and stops flag parsing after --', () => {
    const a = parseArgs(['--json', 'ls', '--', '--not-a-flag'], { valueFlags: [] });
    expect(a.command).toBe('ls');
    expect(a.flags.json).toBe(true);
    expect(a.positionals).toEqual(['--not-a-flag']);
  });

  it('collects the connection host/port as string flags', () => {
    const a = parseArgs(['status', '--host', '127.0.0.1', '--port', '9999'], { valueFlags: ['host', 'port'] });
    expect(flagString(a.flags, 'host')).toBe('127.0.0.1');
    expect(flagString(a.flags, 'port')).toBe('9999');
  });
});

describe('flag readers', () => {
  it('flagString returns the first present alias', () => {
    expect(flagString({ o: 'x.har' }, 'output', 'o')).toBe('x.har');
    expect(flagString({ verbose: true }, 'verbose')).toBeUndefined();
  });
  it('flagBool recognises presence and truthy strings', () => {
    expect(flagBool({ qr: true }, 'qr')).toBe(true);
    expect(flagBool({ all: 'true' }, 'all')).toBe(true);
    expect(flagBool({}, 'all')).toBe(false);
  });
});
