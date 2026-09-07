import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import StatusPill from '../StatusPill.svelte';

describe('StatusPill', () => {
  it('shows the numeric code and 2xx bucket', () => {
    const { container } = render(StatusPill, { props: { status: 200 } });
    const el = container.querySelector('.status')!;
    expect(el).toHaveTextContent('200');
    expect(el.getAttribute('data-bucket')).toBe('2xx');
  });

  it('buckets 4xx and 5xx', () => {
    const four = render(StatusPill, { props: { status: 404 } });
    expect(four.container.querySelector('.status')!.getAttribute('data-bucket')).toBe('4xx');
    const five = render(StatusPill, { props: { status: 503 } });
    expect(five.container.querySelector('.status')!.getAttribute('data-bucket')).toBe('5xx');
  });

  it('shows ERR and error bucket when error is set', () => {
    const { container } = render(StatusPill, { props: { status: null, error: 'ECONNRESET' } });
    const el = container.querySelector('.status')!;
    expect(el).toHaveTextContent('ERR');
    expect(el.getAttribute('data-bucket')).toBe('error');
  });

  it('shows the pending ellipsis when status is null', () => {
    const { container } = render(StatusPill, { props: { status: null } });
    const el = container.querySelector('.status')!;
    expect(el).toHaveTextContent('…');
    expect(el.getAttribute('data-bucket')).toBe('pending');
  });
});
