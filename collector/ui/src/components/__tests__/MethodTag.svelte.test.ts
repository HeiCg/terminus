import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import MethodTag from '../MethodTag.svelte';

describe('MethodTag', () => {
  it('uppercases the method', () => {
    const { container } = render(MethodTag, { props: { method: 'get' } });
    expect(container.querySelector('.method')).toHaveTextContent('GET');
  });

  it.each<[string, string]>([
    ['GET', 'status-3xx'],
    ['POST', 'status-2xx'],
    ['PUT', 'status-4xx'],
    ['PATCH', 'status-4xx'],
    ['DELETE', 'status-5xx'],
    ['HEAD', 'fg-secondary'],
  ])('tints %s with %s', (method, token) => {
    const { container } = render(MethodTag, { props: { method } });
    expect(container.querySelector('.method')!.getAttribute('style')).toContain(`var(--${token})`);
  });
});
