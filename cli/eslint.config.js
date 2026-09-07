import tseslint from 'typescript-eslint';

// Type-unaware lint for the CLI: typescript-eslint's non-type-checked recommended
// set plus a couple of local relaxations. The compiler (tsconfig, strict) is the
// real correctness gate; this catches the obvious lint-level mistakes without the
// cost of a type-checked lint program.
export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // The CLI prints untyped JSON from the collector; `any` at those boundaries
      // is deliberate and guarded by runtime shape checks.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { ignores: ['dist/**'] },
];
