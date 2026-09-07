import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import KindBadge from '../KindBadge.svelte';

describe('KindBadge', () => {
  it.each<['ws' | 'sse' | 'xhr', string, string]>([
    ['ws', 'WS', 'kind-ws'],
    ['sse', 'SSE', 'kind-sse'],
    ['xhr', 'XHR', 'source-xhr'],
  ])('renders %s as %s tinted with %s', (kind, text, token) => {
    const { container } = render(KindBadge, { props: { kind } });
    const el = container.querySelector('.kind')!;
    expect(el).toHaveTextContent(text);
    expect(el.getAttribute('style')).toContain(`var(--${token})`);
  });
});
