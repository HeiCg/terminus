import { mount } from 'svelte';
import App from './App.svelte';
import { Store } from './lib/state/Store.svelte.js';
import { Session } from './lib/state/Session.svelte.js';
import { Nav } from './lib/state/Nav.svelte.js';
import { Clock } from './lib/state/Clock.svelte.js';
import { Client } from './lib/ws/Client.svelte.js';
import { BodyCache } from './lib/bodyCache.js';
import { Filters } from './lib/state/Filters.svelte.js';
import { Selection } from './lib/state/Selection.svelte.js';
import { Sockets } from './lib/state/Sockets.svelte.js';
import * as api from './lib/api.js';
import { teardownOnLogout } from './lib/session/logout.js';
import { rootContext } from './lib/context.js';
import { readHashParams } from './lib/hash.js';
import './lib/global.css';

// Single mount point. index.html ships an empty #app; the built app.js (this
// module, bundled) hydrates it. A missing target is a packaging bug, not a
// runtime condition to recover from, so fail loudly.
const target = document.getElementById('app');
if (!target) throw new Error('Terminus UI: #app mount target missing');

// The runtime singletons, created once and shared through context by the shell.
const store = new Store();
const session = new Session();
const nav = new Nav();
const clock = new Clock();
const cache = new BodyCache();
const client = new Client({ store, session });

// View state lives for the page, not per mount: creating Filters/Selection/Sockets
// here (and seeding them through context) means a tab switch preserves chips,
// search, sort, selection, detail cache, selected socket and loaded frames. The
// per-view `dispose()` methods survive for tests; nothing disposes them at runtime.
const filters = new Filters(store, cache);
const selection = new Selection({ store, cache, api });
const sockets = new Sockets({ store, cache, api, filters });

// Open the socket the moment the session is authenticated — from boot below or a
// later manual login — without a reactive effect watching `status`. connect() is
// idempotent, so firing on both paths never double-opens.
session.onReady = () => client.connect();
// Logout tears the socket down (Session holds no Client reference) AND wipes every
// piece of resident session data — store fold, body cache, and the Selection and
// Sockets view state — so a fresh login never inherits the previous operator's
// traffic. The teardown lives in one testable module (see session/logout.ts).
session.onLogout = () => teardownOnLogout({ client, store, cache, selection, sockets });

clock.start();
nav.view = Nav.fromLocation(location);
// Restore the Capture filters from the hash querystring once, at boot, before the
// first render (T6.3) — read here, not via a reactive effect. Read BEFORE
// session.boot() strips the one-time admin token so a bookmarked filter URL that
// also carried a token still restores. A pristine hash leaves every filter at its
// default.
filters.applyHash(readHashParams());
// Browser Back/Forward walks the pushState hash Nav wrote; mirror it back.
window.addEventListener('popstate', () => { nav.view = Nav.fromLocation(location); });
void session.boot();

export default mount(App, { target, context: rootContext({ store, session, nav, clock, cache, filters, selection, sockets }) });
