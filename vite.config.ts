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
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        presence: fileURLToPath(new URL('./presence.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5275,
    strictPort: false,
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/core/**/*.test.ts',
      'tests/host/**/*.test.ts',
      'tests/red-team/**/*.test.ts',
    ],
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
  },
})
