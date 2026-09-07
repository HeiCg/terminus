import { render, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import Button from '../Button.svelte';

const label = (text: string) =>
  createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

describe('Button', () => {
  it('renders its label with the default primary/md classes', () => {
    const { getByRole } = render(Button, { props: { children: label('Save') } });
    const btn = getByRole('button', { name: 'Save' });
    expect(btn).toHaveTextContent('Save');
    expect(btn.className).toContain('v-primary');
    expect(btn.className).toContain('s-md');
  });

  it('applies variant, size and active classes', () => {
    const { getByRole } = render(Button, {
      props: { children: label('X'), variant: 'danger', size: 'sm', active: true },
    });
    const btn = getByRole('button');
    expect(btn.className).toContain('v-danger');
    expect(btn.className).toContain('s-sm');
    expect(btn.className).toContain('active');
  });

  it('fires onclick', async () => {
    const onclick = vi.fn();
    const { getByRole } = render(Button, { props: { children: label('Go'), onclick } });
    await fireEvent.click(getByRole('button'));
    expect(onclick).toHaveBeenCalledOnce();
  });

  it('does not fire onclick when disabled', async () => {
    const onclick = vi.fn();
    const { getByRole } = render(Button, {
      props: { children: label('Go'), onclick, disabled: true },
    });
    const btn = getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // user-event honours the disabled attribute (unlike fireEvent, which
    // dispatches straight to the node), matching real click semantics.
    await userEvent.click(btn);
    expect(onclick).not.toHaveBeenCalled();
  });

  it('renders the icon snippet when given', () => {
    const { container } = render(Button, {
      props: { children: label('Go'), icon: label('*') },
    });
    expect(container.querySelector('.icon')).not.toBeNull();
  });
});
