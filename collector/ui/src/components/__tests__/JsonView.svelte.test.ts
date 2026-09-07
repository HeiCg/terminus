import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import JsonView from '../JsonView.svelte';
import { BodyCache } from '../../lib/bodyCache.js';

describe('JsonView', () => {
  it('renders token-tinted spans for a JSON value', () => {
    const cache = new BodyCache();
    cache.putRaw('h1', '{"a":1,"b":"x","c":true,"d":null}');
    const { container } = render(JsonView, { props: { hash: 'h1', mode: 'json', cache } });

    const key = container.querySelector('.tok-key');
    expect(key?.textContent).toBe('"a"');
    expect(container.querySelector('.tok-num')?.textContent).toBe('1');
    expect(container.querySelector('.tok-str')?.textContent).toBe('"x"');
    const bools = [...container.querySelectorAll('.tok-bool')].map((n) => n.textContent);
    expect(bools).toContain('true');
    expect(bools).toContain('null');
    // The full pretty text is intact (spans concatenate to it).
    expect(container.textContent).toContain('"a": 1');
  });

  it('shows the too-large note and falls back to raw when pretty-print is skipped', () => {
    const cache = new BodyCache();
    // A parse-able but very large array: pretty output exceeds the 1 MiB cap.
    cache.putRaw('big', JSON.stringify(Array.from({ length: 200000 }, (_, i) => i)));
    const { getByText } = render(JsonView, { props: { hash: 'big', mode: 'json', cache } });
    expect(getByText('Pretty-print skipped: too large')).toBeInTheDocument();
  });

  it('skips tinting (and says so) for a body over the size cap', () => {
    const cache = new BodyCache();
    // ~210 KB of valid JSON: pretty text exceeds the 200 KB tint threshold.
    cache.putRaw('huge', JSON.stringify({ s: 'x'.repeat(210 * 1024) }));
    const { container, getByText } = render(JsonView, { props: { hash: 'huge', mode: 'json', cache } });
    expect(getByText('Syntax highlighting skipped (large body)')).toBeInTheDocument();
    expect(container.querySelector('.tok-key')).toBeNull();
  });

  it('shows the invalid note when the body is not JSON', () => {
    const cache = new BodyCache();
    cache.putRaw('nope', 'this is not json');
    const { getByText } = render(JsonView, { props: { hash: 'nope', mode: 'json', cache } });
    expect(getByText('Not valid JSON — showing raw')).toBeInTheDocument();
  });
});
