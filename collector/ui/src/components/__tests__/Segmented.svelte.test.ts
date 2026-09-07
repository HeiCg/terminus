import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Segmented from '../Segmented.svelte';

const options = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

describe('Segmented', () => {
  it('marks the value segment active and checked (radio semantics)', () => {
    const { getByRole } = render(Segmented, {
      props: { options, value: 'a', onchange: () => {} },
    });
    const alpha = getByRole('radio', { name: 'Alpha' });
    const beta = getByRole('radio', { name: 'Beta' });
    expect(alpha.className).toContain('active');
    expect(alpha.getAttribute('aria-checked')).toBe('true');
    expect(beta.className).not.toContain('active');
    expect(beta.getAttribute('aria-checked')).toBe('false');
  });

  it('carries the segmented (28px) track class', () => {
    const { container } = render(Segmented, {
      props: { options, value: 'a', onchange: () => {} },
    });
    expect(container.querySelector('.segmented')).not.toBeNull();
  });

  it('calls onchange with the clicked id', async () => {
    const onchange = vi.fn();
    const { getByRole } = render(Segmented, { props: { options, value: 'a', onchange } });
    await fireEvent.click(getByRole('radio', { name: 'Beta' }));
    expect(onchange).toHaveBeenCalledWith('b');
  });
});
