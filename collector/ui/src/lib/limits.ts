// Browser-side caps, re-exported from the (moved) pure state module so every UI
// consumer imports them from one place.
export { MAX_ENTRIES, MAX_WS, MAX_FRAMES } from './state.js';

// Display-only denominator for the retention bytes bar. NOT an enforced budget —
// the server's real body budget is configurable via TERMINUS_BODY_BUDGET; this
// is just a stable full-scale reference so the bar reads sensibly. 256 MiB.
export const BODY_BYTES_CAP = 256 * 1024 * 1024;
