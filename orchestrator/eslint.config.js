// @ts-check
// ESLint flat config for the Turing OS orchestrator (TypeScript).
//
// This is a CONSERVATIVE quality gate meant to catch real regressions
// without forcing a large refactor of the existing src/ tree. It starts
// from `typescript-eslint`'s (non-type-checked) `recommended` set and then
// relaxes a handful of rules that produce many pre-existing violations to
// `warn` (still surfaced in CI logs) or `off`, so `npm run lint` exits 0 on
// the current code while still failing on genuinely new errors.
//
// To tighten later: flip the `warn` entries back to `error` (and remove the
// `off` ones) after the corresponding code is cleaned up, and consider
// adding `...tseslint.configs.recommendedTypeChecked` for deeper analysis.

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  // Don't lint build output, deps, configs, or compiled artefacts.
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    rules: {
      // `any` is used pervasively across the gateway/proxy layer. Keep it
      // visible as a warning rather than failing the build; tighten later.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow intentionally-unused args/vars when prefixed with `_`, and
      // demote the rest to warnings (several catch/destructure sites).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // The codebase uses `require()` in a few CommonJS interop spots.
      '@typescript-eslint/no-require-imports': 'warn',

      // Non-null assertions (`!`) appear after explicit guards in places.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Tests run under Jest and use looser typing/globals.
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
);
