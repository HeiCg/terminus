import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import StatePill from '../StatePill.svelte';

describe('StatePill', () => {
  it('reads open (tinted) while the socket is live', () => {
    const { container } = render(StatePill, { props: { closedAt: null } });
    const el = container.querySelector('.pill')!;
    expect(el).toHaveTextContent('open');
    expect(el.classList.contains('open')).toBe(true);
    expect(el.classList.contains('closed')).toBe(false);
  });

  it('reads closed with the close code once the socket has closed', () => {
    const { container } = render(StatePill, { props: { closedAt: 1000, closeCode: 1006 } });
    const el = container.querySelector('.pill')!;
    expect(el).toHaveTextContent('closed 1006');
    expect(el.classList.contains('closed')).toBe(true);
    expect(el.classList.contains('open')).toBe(false);
  });

  it('reads bare closed when no close code is present', () => {
    const { container } = render(StatePill, { props: { closedAt: 1000 } });
    const el = container.querySelector('.pill')!;
    expect(el).toHaveTextContent('closed');
    expect(el.textContent?.trim()).toBe('closed');
  });

  it('treats a null close code the same as an absent one (no trailing code)', () => {
    const { container } = render(StatePill, { props: { closedAt: 1000, closeCode: null } });
    expect(container.querySelector('.pill')!.textContent?.trim()).toBe('closed');
  });
});
