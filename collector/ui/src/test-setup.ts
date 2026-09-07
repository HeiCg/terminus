// Registers @testing-library/jest-dom's matchers (toBeInTheDocument,
// toHaveTextContent, …) on Vitest's expect, and its type augmentation for the
// whole test program.
import '@testing-library/jest-dom/vitest';

// Unmount and wipe the DOM between tests so component test files with several
// renders don't accumulate duplicate nodes (which breaks getByRole/getByText).
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

afterEach(cleanup);

// jsdom ships no ResizeObserver; the virtualized table's windowing attachment
// observes its scroll container for size changes. A no-op stub is enough for the
// component tests (they drive the range via explicit scroll dispatch), and the
// real browser supplies the genuine observer.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
