import { render, fireEvent, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import HexView from '../HexView.svelte';
import HexEditor from '../HexEditor.svelte';
import { HexBuffer } from '../../lib/state/HexBuffer.svelte.js';
import { HEX_PAGE_BYTES } from '../../lib/bytes.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('HexView', () => {
  it('renders offset, hex and ASCII columns, 16 bytes per row', () => {
    const bytes = new Uint8Array(18).map((_, i) => 0x41 + i);
    render(HexView, { props: { bytes } });
    const rows = screen.getAllByTestId('hex-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('00000000');
    expect(rows[0]).toHaveTextContent('41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50');
    expect(rows[0]).toHaveTextContent('ABCDEFGHIJKLMNOP');
    expect(rows[1]).toHaveTextContent('00000010');
    expect(screen.getByTestId('hex-count')).toHaveTextContent('18 bytes');
  });

  it('renders a 1 MiB body one 4 KiB page at a time', async () => {
    const bytes = new Uint8Array(1024 * 1024);
    render(HexView, { props: { bytes } });
    expect(screen.getAllByTestId('hex-row')).toHaveLength(HEX_PAGE_BYTES / 16);
    await fireEvent.click(screen.getByRole('button', { name: /Show next/ }));
    const rows = screen.getAllByTestId('hex-row');
    expect(rows).toHaveLength((2 * HEX_PAGE_BYTES) / 16);
    expect(rows[rows.length - 1]).toHaveTextContent('00001ff0');
  });

  it('copies as hex and as base64', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(HexView, { props: { bytes: new Uint8Array([0, 1, 255]) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy hex' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Copy base64' }));
    expect(writeText).toHaveBeenNthCalledWith(1, '00 01 ff');
    expect(writeText).toHaveBeenNthCalledWith(2, 'AAH/');
  });
});

describe('HexEditor', () => {
  it('typing hex digits on the focused grid edits the byte under the cursor', async () => {
    const buffer = new HexBuffer(new Uint8Array([1, 2, 3]));
    render(HexEditor, { props: { buffer } });
    const grid = screen.getByRole('grid');
    await fireEvent.keyDown(grid, { key: 'ArrowRight' });
    await fireEvent.keyDown(grid, { key: 'a' });
    await fireEvent.keyDown(grid, { key: 'b' });
    expect(Array.from(buffer.bytes)).toEqual([1, 0xab, 3]);
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-b2$/);
    await fireEvent.keyDown(grid, { key: 'Insert' });
    await fireEvent.keyDown(grid, { key: 'Delete' });
    await fireEvent.keyDown(grid, { key: 'Backspace' });
    expect(Array.from(buffer.bytes)).toEqual([1, 3]);
    expect(screen.getByTestId('hex-editor-count')).toHaveTextContent('2 bytes');
  });

  it('a click moves the cursor to that byte', async () => {
    const buffer = new HexBuffer(new Uint8Array([1, 2, 3]));
    const { container } = render(HexEditor, { props: { buffer } });
    await fireEvent.click(container.querySelector('[data-index="2"]')!);
    expect(buffer.cursor).toBe(2);
  });

  it('pastes base64 from the box and shows an error for invalid input', async () => {
    const buffer = new HexBuffer(new Uint8Array([9]));
    render(HexEditor, { props: { buffer } });
    const input = screen.getByLabelText('Hex or base64 to paste');
    await fireEvent.input(input, { target: { value: 'AAH/' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    expect(Array.from(buffer.bytes)).toEqual([0, 1, 255]);
    await fireEvent.input(input, { target: { value: 'zz top' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Insert at cursor' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Not valid hex or base64');
    expect(Array.from(buffer.bytes)).toEqual([0, 1, 255]);
  });

  it('a clipboard paste into the grid inserts hex at the cursor', async () => {
    const buffer = new HexBuffer(new Uint8Array([1, 2]));
    render(HexEditor, { props: { buffer } });
    const grid = screen.getByRole('grid');
    await fireEvent.paste(grid, { clipboardData: { getData: () => 'de ad' } });
    expect(Array.from(buffer.bytes)).toEqual([0xde, 0xad, 1, 2]);
  });
});
