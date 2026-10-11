import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Relative base so the production build loads over file:// inside Electron.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        controlCenter: fileURLToPath(new URL('./control-center.html', import.meta.url)),
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        presence: fileURLToPath(new URL('./presence.html', import.meta.url)),
        adult: fileURLToPath(new URL('./adult.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5272,
    strictPort: false,
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/core/**/*.test.ts',
      'tests/host/**/*.test.ts',
      'tests/architecture/**/*.test.mjs',
      'tests/red-team/**/*.test.ts',
      'tests/qualification/**/*.test.ts',
      // Network-dependent. Included so `npm run test:chat-live` can find it, but
      // every suite here self-skips unless its provider is configured, so it costs
      // the default `npm test` run nothing and cannot make CI flaky.
      'tests/live/**/*.test.ts',
    ],
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
    /**
     * A suite-wide default, raised from Vitest's 5s.
     *
     * Several tests here are genuinely I/O-bound rather than merely slow: one
     * issues 200 concurrent fsynced appends and asserts their sequences are
     * strictly monotonic, one runs ten whole Core lifecycles, and several walk
     * the entire `src/` or `core/` tree reading every file to assert on imports.
     * Each finishes in well under a second on its own, but the runner executes
     * hundreds of files in parallel, so their wall-clock cost is a function of
     * machine load rather than of the code under test.
     *
     * That is what made them marginal: adding test files tipped them over the 5s
     * line while their logic never changed. A timeout that measures the scheduler
     * is not a signal about correctness, and a suite that fails its release gate
     * for that reason trains people to re-run it until it goes green.
     *
     * This widens the budget; it does not relax an assertion. A test that is truly
     * hanging still fails — just later.
     */
    testTimeout: 30_000,
  },
})
