import tseslint from 'typescript-eslint';
import svelteParser from 'svelte-eslint-parser';
import svelte from 'eslint-plugin-svelte';

// Spec §0: the reactive-effect runes and legacy $: are banned across ui/src.
// The three selectors cover `$effect(...)`, `$effect.pre/root(...)` (member call
// whose object is $effect), and any `$:` labeled statement. no-effect.test.ts is
// the redundant CI guard should this lint step ever be skipped.
const banEffects = [
  'error',
  { selector: "CallExpression[callee.name='$effect']", message: '$effect is banned (spec §0)' },
  { selector: "CallExpression[callee.object.name='$effect']", message: '$effect.* is banned (spec §0)' },
  { selector: "LabeledStatement[label.name='$']", message: 'legacy $: is banned' },
];

export default [
  // eslint-plugin-svelte's flat/recommended: Svelte-aware correctness rules on
  // top of the local $effect/$: ban. It ships its own parser/plugin wiring for
  // *.svelte, so our own svelte block below only layers the ban on that config.
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.svelte.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: { 'no-restricted-syntax': banEffects },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: { parser: svelteParser, parserOptions: { parser: tseslint.parser } },
    rules: { 'no-restricted-syntax': banEffects },
  },
  {
    // svelte/prefer-svelte-reactivity assumes every Map/Set is reactive state and
    // wants SvelteMap/SvelteSet. This codebase draws the line deliberately: the
    // reactive collections DO use SvelteSet/SvelteMap (Filters.statuses,
    // Sockets.expanded, …); the plain Map/Set instances the rule flags are
    // non-reactive computation scratch inside `$derived.by`, dedupe helpers, and
    // intentionally-unwatched caches (Selection.detailsCache). Reactivity through
    // them is neither wanted nor relied on, so the rule is off rather than papered
    // over with a dozen scattered inline disables.
    files: ['**/*.ts', '**/*.svelte.ts', '**/*.svelte'],
    rules: { 'svelte/prefer-svelte-reactivity': 'off' },
  },
];
