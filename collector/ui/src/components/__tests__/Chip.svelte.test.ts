import { render, fireEvent } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import Chip from '../Chip.svelte';

const label = (text: string) =>
  createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe('Chip', () => {
  it('renders label and fires onclick', async () => {
    const onclick = vi.fn();
    const { getByRole } = render(Chip, { props: { onclick, children: label('GET') } });
    const chip = getByRole('button', { name: /GET/ });
    await fireEvent.click(chip);
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('adds the active class when active', () => {
    const { getByRole } = render(Chip, {
      props: { onclick: () => {}, active: true, children: label('a') },
    });
    expect(getByRole('button').className).toContain('active');
  });

  it('shows the count when provided', () => {
    const { container } = render(Chip, {
      props: { onclick: () => {}, count: 7, children: label('a') },
    });
    expect(container.querySelector('.count')).toHaveTextContent('7');
  });

  it('sets the tint custom property from the token name', () => {
    const { getByRole } = render(Chip, {
      props: { onclick: () => {}, tint: 'status-4xx', children: label('a') },
    });
    const chip = getByRole('button');
    expect(chip.className).toContain('tinted');
    expect(chip.getAttribute('style')).toContain('var(--status-4xx)');
  });
});
