import { render, fireEvent } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import Banner from '../Banner.svelte';

const label = (text: string) =>
  createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe('Banner', () => {
  it('renders its message and kind', () => {
    const { container } = render(Banner, {
      props: { kind: 'warning', children: label('Heads up') },
    });
    const el = container.querySelector('.banner')!;
    expect(el).toHaveTextContent('Heads up');
    expect(el.getAttribute('data-kind')).toBe('warning');
  });

  it('tints error banners with status-5xx', () => {
    const { container } = render(Banner, {
      props: { kind: 'error', children: label('Boom') },
    });
    expect(container.querySelector('.banner')!.getAttribute('style')).toContain('var(--status-5xx)');
  });

  it('shows the dismiss button and fires ondismiss', async () => {
    const ondismiss = vi.fn();
    const { getByRole } = render(Banner, {
      props: { kind: 'info', ondismiss, children: label('x') },
    });
    await fireEvent.click(getByRole('button', { name: /dismiss/i }));
    expect(ondismiss).toHaveBeenCalledOnce();
  });

  it('omits the dismiss button without ondismiss', () => {
    const { queryByRole } = render(Banner, {
      props: { kind: 'info', children: label('x') },
    });
    expect(queryByRole('button')).toBeNull();
  });
});
