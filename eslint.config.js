// Flat ESLint config shared across the monorepo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Internal design-system components (Card, Avatar, Sidebar, …) — the
      // single-word rule is aimed at library authors worried about HTML
      // element name collisions, not internal app primitives.
      'vue/multi-word-component-names': 'off',
      // Confirmations and messages go through the app's own dialogs and
      // toasts, never the browser's.
      'no-alert': 'error',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    // Its tests may still fake the API underneath the shared workflows.
    files: ['apps/web/src/oldschool/**'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // The SPA's own API client (src/api), by relative path or the @ alias.
              regex: '^(?:(?:\\.{1,2}/)+|@/)api(?:/|$)',
              message:
                'The Old School view is a skin: call the API through a shared workflow in apps/web/src/design/composables/. See docs/adr/0002-old-school-view-is-a-skin.md.',
            },
          ],
        },
      ],
    },
  },
];
