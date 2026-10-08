import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // `.scratch` is gitignored working space, not part of the build.
    ignores: ['dist/**', 'dist-electron/**', 'extension/dist/**', 'node_modules/**', 'References/**', '.scratch/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    // The renderer holds no capability: no network, no eval, no globals.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // The e2e runner, the live model probe and the launch scripts are CLIs:
    // reporting their own progress is their output, not a stray log. The glob
    // reaches into `scripts/` as well as the root — `*.mjs` alone does not.
    files: ['electron/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.{ts,mjs}', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // A Playwright driver is two programs in one file: a Node CLI that launches
    // Electron, and browser-context callbacks handed to `page.evaluate`, where
    // `document` and `window` are the real globals. Declaring both is what the
    // code actually is; without this the driver cannot be linted at all, and the
    // alternative — silencing `no-undef` file-wide — would hide genuine typos in
    // the Node half.
    files: ['scripts/chat-acceptance-visible.mjs', 'scripts/chat-onscreen-acceptance.mjs', 'scripts/chat-random.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
)
