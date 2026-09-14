// The location hash is a single querystring shared by two disjoint owners: `Nav`
// keeps the current view under `view=`, and `Filters` keeps the Capture query
// state (`device`, `q`, chips, sort…). Both go through here so a write from one
// never clobbers the other's keys — every mutation is a read-modify-write of the
// full param set. No reactive effect is involved: callers write from the exact
// setter/method where their state changes (see Filters/Nav).
//
// Everything guards `typeof location`/`history` so the module is inert under SSR
// or a jsdom without history, and never throws into a state setter.

export function readHashParams(): URLSearchParams {
  if (typeof location === 'undefined') return new URLSearchParams();
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

// Write the params back into the hash. An empty param set drops the `#` entirely
// (so a cleared query leaves a clean url). `push` uses pushState (Nav wants a
// history entry per view); the default replaceState keeps filter churn out of the
// back stack.
export function writeHashParams(params: URLSearchParams, opts: { push?: boolean } = {}): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const qs = params.toString();
  const base = `${location.pathname}${location.search}`;
  const url = qs ? `${base}#${qs}` : base;
  if (opts.push) history.pushState(history.state, '', url);
  else history.replaceState(history.state, '', url);
}

// Read the current params, let `mutate` change this owner's keys, and write back —
// preserving every key the caller did not touch.
export function updateHashParams(mutate: (p: URLSearchParams) => void, opts: { push?: boolean } = {}): void {
  const p = readHashParams();
  mutate(p);
  writeHashParams(p, opts);
}
