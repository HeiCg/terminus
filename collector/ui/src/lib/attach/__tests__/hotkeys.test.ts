import { describe, it, expect, vi, afterEach } from 'vitest';
import { hotkeys } from '../hotkeys.js';

// The attachment is a plain `(element) => cleanup` function that binds its
// listener on `window` (so a key fires even when focus sits on document.body).
// `mod` is ctrl on the jsdom platform (empty navigator.platform → non-mac), but a
// metaKey+ctrlKey event resolves to `mod+k` on either platform.
const cleanups: Array<() => void> = [];

function mount(map: Record<string, (e: KeyboardEvent) => void>): { el: HTMLElement; input: HTMLInputElement } {
  const el = document.createElement('div');
  const input = document.createElement('input');
  const select = document.createElement('select');
  const button = document.createElement('button');
  el.append(input, select, button);
  document.body.appendChild(el);
  const cleanup = hotkeys(map)(el) as () => void;
  cleanups.push(cleanup);
  return { el, input };
}

function key(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = '';
});

describe('hotkeys attachment', () => {
  it('fires mod+k and escape', () => {
    const modk = vi.fn();
    const esc = vi.fn();
    const { el } = mount({ 'mod+k': modk, escape: esc });
    key(el, { key: 'k', ctrlKey: true, metaKey: true });
    key(el, { key: 'Escape' });
    expect(modk).toHaveBeenCalledTimes(1);
    expect(esc).toHaveBeenCalledTimes(1);
  });

  it('fires mod+k even when the event originates on document.body (window-bound)', () => {
    const modk = vi.fn();
    mount({ 'mod+k': modk });
    key(document.body, { key: 'k', ctrlKey: true, metaKey: true });
    expect(modk).toHaveBeenCalledTimes(1);
  });

  it('does not fire a plain letter while a modifier is held (⌘K is not j/k)', () => {
    const j = vi.fn();
    const { el } = mount({ j });
    key(el, { key: 'j', ctrlKey: true });
    expect(j).not.toHaveBeenCalled();
  });

  it('routes plain j and k on a non-interactive target', () => {
    const j = vi.fn();
    const k = vi.fn();
    const { el } = mount({ j, k });
    key(el, { key: 'j' });
    key(el, { key: 'k' });
    expect(j).toHaveBeenCalledTimes(1);
    expect(k).toHaveBeenCalledTimes(1);
  });

  it('ignores j / k / `/` on text-entry targets (input, select) but NOT on buttons', () => {
    const j = vi.fn();
    const slash = vi.fn();
    mount({ j, '/': slash });
    const input = document.querySelector('input')!;
    const select = document.querySelector('select')!;
    const button = document.querySelector('button')!;

    key(input, { key: 'j' });
    key(select, { key: 'j' });
    expect(j).not.toHaveBeenCalled();

    // A <button> is not a text-entry target: Space/Enter aren't in the map, so
    // plain shortcuts must still fire (the request rows are buttons).
    key(button, { key: '/' });
    expect(slash).toHaveBeenCalledTimes(1);
  });

  it('routes j from a focused button inside a request row (rows ARE buttons)', () => {
    const j = vi.fn();
    mount({ j });
    const row = document.createElement('button');
    row.setAttribute('data-testid', 'entry-row-r1');
    document.body.appendChild(row);
    key(row, { key: 'j' });
    expect(j).toHaveBeenCalledTimes(1);
  });

  it('lets escape and mod+k through even from a text field', () => {
    const esc = vi.fn();
    const modk = vi.fn();
    mount({ escape: esc, 'mod+k': modk });
    const input = document.querySelector('input')!;
    key(input, { key: 'Escape' });
    key(input, { key: 'k', ctrlKey: true, metaKey: true });
    expect(esc).toHaveBeenCalledTimes(1);
    expect(modk).toHaveBeenCalledTimes(1);
  });

  it('ignores keys emitted mid IME composition', () => {
    const esc = vi.fn();
    const { el } = mount({ escape: esc });
    key(el, { key: 'Escape', isComposing: true });
    expect(esc).not.toHaveBeenCalled();
  });

  it('detaches its window listener on cleanup', () => {
    const modk = vi.fn();
    const { el } = mount({ 'mod+k': modk });
    cleanups.pop()!(); // run this mount's cleanup now
    key(el, { key: 'k', ctrlKey: true });
    expect(modk).not.toHaveBeenCalled();
  });
});
