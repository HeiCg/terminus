import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Consumed by svelte-check (and the editor tooling): tells it how .svelte files
// are preprocessed. The build itself reads the svelte() plugin in ui/vite.config.ts;
// this keeps type-checking in sync with it.
export default { preprocess: vitePreprocess() };
