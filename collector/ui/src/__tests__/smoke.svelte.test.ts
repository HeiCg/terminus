import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';
import App from '../App.svelte';
import { Store } from '../lib/state/Store.svelte.js';
import { Session } from '../lib/state/Session.svelte.js';
import { Nav } from '../lib/state/Nav.svelte.js';
import { Clock } from '../lib/state/Clock.svelte.js';
import { BodyCache } from '../lib/bodyCache.js';
import { Filters } from '../lib/state/Filters.svelte.js';
import { Selection } from '../lib/state/Selection.svelte.js';
import { Sockets } from '../lib/state/Sockets.svelte.js';
import * as api from '../lib/api.js';
import { rootContext } from '../lib/context.js';

// The shell mounts against the runtime singletons (seeded into context) and,
// before boot resolves, shows the connection indicator in its authenticating
// state — the stable render target downstream tasks and the browser spec key off.
test('App mounts the shell and shows the connection indicator', () => {
  const store = new Store();
  const cache = new BodyCache();
  const filters = new Filters(store);
  const context = rootContext({
    store, session: new Session(), nav: new Nav(), clock: new Clock(), cache,
    filters, selection: new Selection({ store, cache, api }), sockets: new Sockets({ store, cache, api, filters }),
  });
  render(App, { context });
  expect(screen.getByTestId('capture-connection')).toHaveTextContent('Autenticando');
});
