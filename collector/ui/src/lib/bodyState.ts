import type { BodyOmission } from './protocol.js';

// The load state of ONE body side (request or response), independent of Svelte so
// Task 7 (Sockets) can reuse it for frame payloads. `idle` is the untouched
// default; `loading` is an in-flight fetch; `ok` names the cache key (sha256) the
// rendered body reads through; `omitted`/`absent`/`gone` are terminal empties the
// tab renders as a card. `error` is a RECOVERABLE failure (transport/5xx) the tab
// renders with a Retry — distinct from `gone` (a 404: the record is truly gone).
// `size` is the original body length when known.
export type BodyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; hash: string; size: number; encoding: 'utf8' | 'binary' }
  | { kind: 'omitted'; reason: BodyOmission; size: number }
  | { kind: 'gone' }
  | { kind: 'error' }
  | { kind: 'absent' };
