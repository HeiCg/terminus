import type { Client } from '../ws/Client.svelte.js';
import type { Store } from '../state/Store.svelte.js';
import type { BodyCache } from '../bodyCache.js';
import type { Selection } from '../state/Selection.svelte.js';
import type { Sockets } from '../state/Sockets.svelte.js';

// The runtime pieces logout must tear down. Kept as a narrow struct so the
// teardown is unit-testable with the real Store/BodyCache/Selection/Sockets and a
// stub Client, without standing up the whole app shell.
export type LogoutTargets = {
  client: Client;
  store: Store;
  cache: BodyCache;
  selection: Selection;
  sockets: Sockets;
};

/**
 * Wipe every piece of resident session state on logout, so a fresh login never
 * inherits the previous operator's traffic.
 *
 * Order matters: drop the socket FIRST (Client.disconnect detaches its handlers
 * and sets `stopped`, so no late frame can apply to a store we are about to
 * reset), THEN reset the store fold, clear the body cache, and reset the two view
 * state machines. Store.reset() does not fire the onApplied listeners, so
 * Selection and Sockets would otherwise keep their selection, detail cache and
 * loaded frames — hence the explicit resets here.
 */
export function teardownOnLogout(t: LogoutTargets): void {
  t.client.disconnect();
  t.store.reset();
  t.cache.clear();
  t.selection.reset();
  t.sockets.reset();
}
