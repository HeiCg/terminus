import tseslint from 'typescript-eslint';

// Type-unaware lint for the collector's Node sources (`src/`) and their tests
// (`test/`). Same base as cli/eslint.config.js: typescript-eslint's
// non-type-checked recommended set. The compiler (tsconfig, strict) is the real
// correctness gate; this catches the obvious lint-level mistakes (unused vars,
// stray imports) without the cost of a type-checked lint program. The Svelte UI
// keeps its own config at ui/eslint.config.js.
export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Node/collector code deliberately reaches untyped boundaries (mockttp
      // internals, HAR extension bags, raw ws frames); `any` there is guarded by
      // runtime shape checks, matching the CLI's stance.
      '@typescript-eslint/no-explicit-any': 'off',
      // `ignoreRestSiblings` on top of the CLI's `argsIgnorePattern`: the store and
      // HAR/DTO layers extract-to-omit fields via `const { a, b, ...rest } = x`,
      // where `a`/`b` exist only to be dropped from `rest`. Flagging those rest
      // siblings as unused is a false positive, so allow the pattern rather than
      // rename every discarded field.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  { ignores: ['dist/**', 'dist-ui/**'] },
];
