import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ShortcutsSheet from '../ShortcutsSheet.svelte';
import { SHORTCUT_GROUPS } from '../../lib/shortcuts.js';

describe('ShortcutsSheet', () => {
  it('renders a modal dialog listing every shortcut from the keymap table', () => {
    render(ShortcutsSheet, { props: { onclose: vi.fn() } });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Every label in the single-source table is on screen.
    for (const group of SHORTCUT_GROUPS) {
      for (const item of group.items) {
        expect(screen.getByText(item.label)).toBeInTheDocument();
      }
    }
  });

  it('moves focus into the dialog on open', () => {
    render(ShortcutsSheet, { props: { onclose: vi.fn() } });
    expect(document.activeElement).toBe(screen.getByTestId('shortcuts-sheet'));
  });

  it('closes on Escape and stops propagation so the App handler does not also run', () => {
    const onclose = vi.fn();
    render(ShortcutsSheet, { props: { onclose } });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, 'stopPropagation');
    screen.getByTestId('shortcuts-sheet').dispatchEvent(ev);
    expect(onclose).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('closes on a click outside the panel', async () => {
    const onclose = vi.fn();
    render(ShortcutsSheet, { props: { onclose } });
    // The backdrop is the dialog's parent (role="presentation").
    const backdrop = screen.getByTestId('shortcuts-sheet').parentElement as HTMLElement;
    await fireEvent.pointerDown(backdrop);
    expect(onclose).toHaveBeenCalled();
  });

  it('closes via the Close button', async () => {
    const onclose = vi.fn();
    render(ShortcutsSheet, { props: { onclose } });
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onclose).toHaveBeenCalled();
  });
});
