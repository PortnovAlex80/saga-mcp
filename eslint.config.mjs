// ESLint v10+ flat config for saga-mcp
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      'no-throw-literal': 'error',
    },
  },
  // CI-01 LINT RATCHET — legacy debt quarantine.
  //
  // The block above fully error-enforces every `src/**/*.ts` file. The
  // Factory-completion active paths (src/process-modules, src/infrastructure,
  // src/modules/development, src/factory-e2e, src/app, src/shared,
  // src/checkpoints, src/lifecycle, src/orchestrate-cli.ts, src/index.ts,
  // src/schema.ts, src/db.ts) MUST stay lint-clean — that is the gate's
  // enforced surface, and any error there fails CI.
  //
  // The pre-existing legacy surfaces listed below carry lint debt
  // (eqeqeq, prefer-const, @typescript-eslint/no-empty-object-type) that
  // predates the Factory completion plan. They are NOT blanket-fixed because
  // some `==` are intentional null/undefined guards (blanket `===` conversion
  // is a correctness risk) and "reformat the repository" is a non-goal. The
  // three debt rules are turned OFF for these legacy paths so the gate is
  // GREEN, while every other rule in the recommended set still applies.
  //
  // The quarantined debt is recorded as a bounded cleanup backlog:
  //   docs/factory/CI-01-LEGACY-LINT-BACKLOG.md
  // Ratchet direction: only ever tighten. Clean a legacy file → remove its
  // glob from `files` below so the strict rules apply again.
  {
    files: [
      'src/tools/**/*.ts',
      'src/validators/**/*.ts',
      'src/helpers/**/*.ts',
      'src/planner/**/*.ts',
      'src/modules/discovery/**/*.ts',
      'src/modules/formalization/**/*.ts',
    ],
    rules: {
      eqeqeq: 'off',
      'prefer-const': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'tracker-view/', 'tests/', 'tools/', '**/*.mjs'],
  },
];
